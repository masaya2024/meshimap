import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

let local: LocalD1;

const REPORTER_ID = 'usr_reporter';
const OTHER_REPORTER_ID = 'usr_reporter_other';
const ADMIN_ID = 'usr_admin';
const SHOP_ID = 'shp_reported';

/**
 * CHECK 制約を試すためだけの店舗。
 * `shop_applications` には `uq_shop_applications_shop_pending`（pending だけを対象にした
 * 部分ユニーク索引）があるため、審査待ちの申請が残っている SHOP_ID を使うと
 * CHECK 違反ではなく UNIQUE 違反で落ちてしまい、どちらで弾かれたのか区別できない。
 * CHECK で弾かれた INSERT は行を残さないので、この店舗は複数のテストで使い回せる。
 */
const CHECK_SHOP_ID = 'shp_reported_check';

/** 渋谷駅の座標と、その precision 7 の geohash（packages/geo の encodeGeohash で算出した値） */
const SHIBUYA = { lat: 35.658034, lng: 139.701636, geohash: 'xn76fgr' } as const;

/** 対応日時の基準値（2026-09-16 相当のエポックミリ秒） */
const HANDLED_AT_MS = 1_789_500_000_000;

beforeAll(async () => {
  local = await createMigratedD1();
  for (const [userId, email] of [
    [REPORTER_ID, 'reporter@example.com'],
    [OTHER_REPORTER_ID, 'reporter2@example.com'],
    [ADMIN_ID, 'admin@example.com'],
  ] as const) {
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind(userId, '通報テスト', email)
      .run();
  }
  await local.d1
    .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
    .bind('gnr_admin', 'ラーメン', 'ramen-admin')
    .run();
  await local.d1
    .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
    .bind('area_admin', '渋谷', '東京都')
    .run();
  for (const shopId of [SHOP_ID, CHECK_SHOP_ID]) {
    await local.d1
      .prepare(
        'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        shopId,
        '通報テスト店',
        'gnr_admin',
        'area_admin',
        '東京都渋谷区',
        SHIBUYA.lat,
        SHIBUYA.lng,
        SHIBUYA.geohash,
      )
      .run();
  }
});

afterAll(async () => {
  await local.dispose();
});

describe('reports', () => {
  it('通報は open から始まり、対応者は空である', async () => {
    await local.d1
      .prepare(
        'INSERT INTO reports (id, reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('rpt_first', REPORTER_ID, 'shop', SHOP_ID, '閉店しているのに掲載されている')
      .run();

    const row = await local.d1
      .prepare('SELECT status, handled_by, handled_at FROM reports WHERE id = ?')
      .bind('rpt_first')
      .first<{ status: string; handled_by: string | null; handled_at: number | null }>();

    expect(row?.status).toBe('open');
    expect(row?.handled_by).toBeNull();
    expect(row?.handled_at).toBeNull();
  });

  it('同じ人が同じ対象を二重通報できない（嫌がらせの連投を防ぐ）', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO reports (id, reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?, ?)',
        )
        .bind('rpt_dup', REPORTER_ID, 'shop', SHOP_ID, '再送')
        .run(),
    ).rejects.toThrow(
      /UNIQUE constraint failed: reports\.reporter_id, reports\.target_type, reports\.target_id/,
    );
  });

  it('別の人なら同じ対象を通報できる', async () => {
    await local.d1
      .prepare(
        'INSERT INTO reports (id, reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('rpt_other', OTHER_REPORTER_ID, 'shop', SHOP_ID, '写真が実物と違う')
      .run();
  });

  it('匿名通報（reporter_id が NULL）は同じ対象に何件でも入る', async () => {
    // SQLite のユニーク索引は NULL を重複とみなさない。
    // 匿名通報を潰さないための意図的な挙動
    for (const reportId of ['rpt_anon1', 'rpt_anon2']) {
      await local.d1
        .prepare('INSERT INTO reports (id, target_type, target_id, reason) VALUES (?, ?, ?, ?)')
        .bind(reportId, 'review', 'rev_unknown', '誹謗中傷')
        .run();
    }
  });

  it('定義にない target_type は拒否する', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO reports (id, reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?, ?)',
        )
        .bind('rpt_ng_target', OTHER_REPORTER_ID, 'menu', 'mnu_1', 'x')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_reports_target_type/);
  });

  it('対応者だけ書いて対応日時を書かないのは拒否する', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO reports (id, reporter_id, target_type, target_id, reason, handled_by) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind('rpt_ng_time', OTHER_REPORTER_ID, 'user', REPORTER_ID, 'x', ADMIN_ID)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_reports_handler_requires_time/);
  });

  it('open のまま resolved へ更新するのは拒否する（対応日時が要る）', async () => {
    await expect(
      local.d1
        .prepare("UPDATE reports SET status = 'resolved' WHERE id = ?")
        .bind('rpt_first')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_reports_closed_requires_time/);
  });

  it('対応者と対応日時を揃えれば resolved にできる', async () => {
    await local.d1
      .prepare(
        "UPDATE reports SET status = 'resolved', handled_by = ?, handled_at = ? WHERE id = ?",
      )
      .bind(ADMIN_ID, HANDLED_AT_MS, 'rpt_first')
      .run();

    const row = await local.d1
      .prepare('SELECT status FROM reports WHERE id = ?')
      .bind('rpt_first')
      .first<{ status: string }>();

    expect(row?.status).toBe('resolved');
  });

  it('対応した管理者を削除しても通報は残り、対応日時も残る', async () => {
    // ON DELETE set null が handled_by だけを NULL にする。
    // 「(handled_by IS NULL) = (handled_at IS NULL)」という双方向の CHECK を置くと
    // ここで DELETE が失敗する。含意 2 本に分けてあるので通る
    await local.d1.prepare('DELETE FROM user WHERE id = ?').bind(ADMIN_ID).run();

    const row = await local.d1
      .prepare('SELECT status, handled_by, handled_at FROM reports WHERE id = ?')
      .bind('rpt_first')
      .first<{ status: string; handled_by: string | null; handled_at: number | null }>();

    expect(row?.status).toBe('resolved');
    expect(row?.handled_by).toBeNull();
    expect(row?.handled_at).toBe(HANDLED_AT_MS);
  });

  it('未対応キューは索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM reports WHERE status = 'open' ORDER BY created_at DESC",
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_reports_status_created');
    expect(detail).not.toContain('SCAN reports');
  });
});

describe('shop_applications', () => {
  it('申請は pending から始まり、documents は空配列が既定', async () => {
    await local.d1
      .prepare('INSERT INTO shop_applications (id, applicant_id, shop_id) VALUES (?, ?, ?)')
      .bind('app_first', REPORTER_ID, SHOP_ID)
      .run();

    const row = await local.d1
      .prepare('SELECT status, documents FROM shop_applications WHERE id = ?')
      .bind('app_first')
      .first<{ status: string; documents: string }>();

    expect(row?.status).toBe('pending');
    // mode: 'json' の default([]) は DDL に文字列 '[]' として焼き込まれる
    expect(row?.documents).toBe('[]');
  });

  it('同じ店に pending の申請が 2 件同時に存在できない', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO shop_applications (id, applicant_id, shop_id) VALUES (?, ?, ?)')
        .bind('app_dup', OTHER_REPORTER_ID, SHOP_ID)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: shop_applications\.shop_id/);
  });

  it('前の申請が決着していれば再申請できる（部分ユニーク索引）', async () => {
    await local.d1
      .prepare("UPDATE shop_applications SET status = 'returned' WHERE id = ?")
      .bind('app_first')
      .run();

    await local.d1
      .prepare('INSERT INTO shop_applications (id, applicant_id, shop_id) VALUES (?, ?, ?)')
      .bind('app_second', REPORTER_ID, SHOP_ID)
      .run();
  });

  it('壊れた JSON を documents に入れられない', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO shop_applications (id, applicant_id, shop_id, documents) VALUES (?, ?, ?, ?)',
        )
        .bind('app_broken', REPORTER_ID, CHECK_SHOP_ID, '{oops')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_shop_applications_documents_json/);
  });

  it('documents が配列でなければ拒否する', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO shop_applications (id, applicant_id, shop_id, documents) VALUES (?, ?, ?, ?)',
        )
        .bind('app_object', REPORTER_ID, CHECK_SHOP_ID, '{"kind":"license"}')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_shop_applications_documents_json/);
  });

  it('正しい配列なら保存でき、SQL から中身を取り出せる', async () => {
    const documents = JSON.stringify([
      { kind: 'license', r2Key: 'applications/app_ok/license.pdf' },
    ]);
    await local.d1
      .prepare(
        "INSERT INTO shop_applications (id, applicant_id, shop_id, documents, status) VALUES (?, ?, ?, ?, 'approved')",
      )
      .bind('app_ok', REPORTER_ID, SHOP_ID, documents)
      .run();

    const row = await local.d1
      .prepare(
        "SELECT json_extract(documents, '$[0].kind') AS kind FROM shop_applications WHERE id = ?",
      )
      .bind('app_ok')
      .first<{ kind: string }>();

    expect(row?.kind).toBe('license');
  });
});

describe('notifications', () => {
  it('通知を保存できる', async () => {
    await local.d1
      .prepare(
        'INSERT INTO notifications (id, user_id, type, title, body, data) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'ntf_first',
        REPORTER_ID,
        'reservation_confirmed',
        '予約が確定しました',
        '9/20 19:00 に 2 名でお待ちしています',
        '{"reservationId":"rsv_first"}',
      )
      .run();
  });

  it('定義にない type は拒否する', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO notifications (id, user_id, type, title, body) VALUES (?, ?, ?, ?, ?)',
        )
        .bind('ntf_ng', REPORTER_ID, 'coupon_issued', 'x', 'y')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_notifications_type/);
  });

  it('data は省略できる', async () => {
    await local.d1
      .prepare('INSERT INTO notifications (id, user_id, type, title, body) VALUES (?, ?, ?, ?, ?)')
      .bind('ntf_plain', REPORTER_ID, 'announcement', 'メンテナンスのお知らせ', '9/20 2:00-4:00')
      .run();
  });

  it('data が壊れた JSON なら拒否する', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO notifications (id, user_id, type, title, body, data) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind('ntf_broken', REPORTER_ID, 'announcement', 'x', 'y', 'nope')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_notifications_data_json/);
  });

  it('未読一覧は部分索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM notifications WHERE user_id = '${REPORTER_ID}' AND read_at IS NULL ORDER BY created_at DESC`,
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    // バッジの未読件数はアプリ起動のたびに走る。全件索引より小さい部分索引を当てる
    expect(detail).toContain('idx_notifications_user_unread');
    expect(detail).not.toContain('USE TEMP B-TREE');
  });

  it('全件一覧は通常の索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM notifications WHERE user_id = '${REPORTER_ID}' ORDER BY created_at DESC`,
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_notifications_user_created');
    expect(detail).not.toContain('USE TEMP B-TREE');
  });
});

describe('audit_logs', () => {
  it('監査ログを保存できる', async () => {
    await local.d1
      .prepare(
        'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, diff) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'aud_first',
        OTHER_REPORTER_ID,
        'shop.suspend',
        'shop',
        SHOP_ID,
        '{"status":["published","suspended"]}',
      )
      .run();
  });

  it('action に大文字が混ざったら拒否する（表記ゆれで集計できなくなる）', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id) VALUES (?, ?, ?, ?, ?)',
        )
        .bind('aud_upper', OTHER_REPORTER_ID, 'Shop.Suspend', 'shop', SHOP_ID)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_audit_logs_action/);
  });

  it('action が空文字なら拒否する', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id) VALUES (?, ?, ?, ?, ?)',
        )
        .bind('aud_empty', OTHER_REPORTER_ID, '', 'shop', SHOP_ID)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_audit_logs_action/);
  });

  it('実行者を削除しても監査ログは残る（actor_id だけ NULL になる）', async () => {
    await local.d1.prepare('DELETE FROM user WHERE id = ?').bind(OTHER_REPORTER_ID).run();

    const row = await local.d1
      .prepare('SELECT actor_id, action FROM audit_logs WHERE id = ?')
      .bind('aud_first')
      .first<{ actor_id: string | null; action: string }>();

    expect(row?.actor_id).toBeNull();
    expect(row?.action).toBe('shop.suspend');
  });

  it('全体の新着順は索引スキャンで並べ替えなしになる', async () => {
    const plan = await local.d1
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50')
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_audit_logs_created');
    expect(detail).not.toContain('USE TEMP B-TREE');
  });
});

describe('ユーザー削除の連鎖', () => {
  it('通知は消えるが、通報は reporter_id が NULL になって残る', async () => {
    await local.d1.prepare('DELETE FROM user WHERE id = ?').bind(REPORTER_ID).run();

    const notificationRow = await local.d1
      .prepare('SELECT count(*) AS remaining FROM notifications WHERE user_id = ?')
      .bind(REPORTER_ID)
      .first<{ remaining: number }>();
    const reportRow = await local.d1
      .prepare('SELECT count(*) AS anonymous FROM reports WHERE reporter_id IS NULL')
      .first<{ anonymous: number }>();

    expect(notificationRow?.remaining).toBe(0);
    // 匿名 2 件（rpt_anon1 / rpt_anon2）+ 退会した通報者 2 名分（rpt_other / rpt_first）。
    // rpt_other の通報者は audit_logs のテストで先に削除済みで、そこでも reporter_id が NULL になっている
    expect(reportRow?.anonymous).toBe(4);
  });
});
