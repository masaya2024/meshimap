import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

let local: LocalD1;

const SHOP_ID = 'shp_review';
const OTHER_SHOP_ID = 'shp_review_other';
const USER_ID = 'usr_reviewer';
const OTHER_USER_ID = 'usr_reviewer_other';

/**
 * CHECK 制約を試すためだけの店舗とユーザー。
 * 存在しない shop_id / user_id を使うと FK 違反と CHECK 違反のどちらで落ちたのか区別できず、
 * SQLite がどちらを先に評価するかにテストが依存してしまうため、実在する行を用意する。
 * CHECK で弾かれた INSERT は行を残さないので、この組み合わせを複数のテストで使い回せる
 * （`uq_reviews_shop_user` に引っかかることもない）。
 */
const CHECK_SHOP_ID = 'shp_review_check';
const CHECK_USER_ID = 'usr_reviewer_check';

/** 渋谷駅の座標と、その precision 7 の geohash（packages/geo の encodeGeohash で算出した値） */
const SHIBUYA = { lat: 35.658034, lng: 139.701636, geohash: 'xn76fgr' } as const;

/** 代表的な予算（円） */
const BUDGET_LUNCH_YEN = 1200;

type InsertParams = readonly (string | number | null)[];

async function insertReview(values: InsertParams): Promise<void> {
  await local.d1
    .prepare(
      'INSERT INTO reviews (id, shop_id, user_id, rating, body, visited_on, budget, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(...values)
    .run();
}

beforeAll(async () => {
  local = await createMigratedD1();
  for (const [userId, email] of [
    [USER_ID, 'reviewer@example.com'],
    [OTHER_USER_ID, 'reviewer2@example.com'],
    [CHECK_USER_ID, 'reviewer3@example.com'],
  ] as const) {
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind(userId, 'レビュアー', email)
      .run();
  }
  await local.d1
    .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
    .bind('gnr_review', 'ラーメン', 'ramen-review')
    .run();
  await local.d1
    .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
    .bind('area_review', '渋谷', '東京都')
    .run();
  for (const shopId of [SHOP_ID, OTHER_SHOP_ID, CHECK_SHOP_ID]) {
    await local.d1
      .prepare(
        'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        shopId,
        'レビューテスト店',
        'gnr_review',
        'area_review',
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

describe('reviews', () => {
  it('レビューを保存でき、status は published、created_at は自動で入る', async () => {
    await local.d1
      .prepare(
        'INSERT INTO reviews (id, shop_id, user_id, rating, body, visited_on, budget) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'rev_first',
        SHOP_ID,
        USER_ID,
        5,
        'スープが澄んでいて美味しい',
        '2026-09-01',
        BUDGET_LUNCH_YEN,
      )
      .run();

    const row = await local.d1
      .prepare('SELECT status, created_at FROM reviews WHERE id = ?')
      .bind('rev_first')
      .first<{ status: string; created_at: number }>();

    // 事前審査はしない。通報されたら hidden に落とす運用（設計書 §6 の status）
    expect(row?.status).toBe('published');
    expect(row?.created_at).toBeGreaterThan(0);
  });

  it('同じユーザーが同じ店に 2 件目を投稿できない', async () => {
    await expect(
      insertReview(['rev_dup', SHOP_ID, USER_ID, 3, '再訪', null, null, 'published']),
    ).rejects.toThrow(/UNIQUE constraint failed: reviews\.shop_id, reviews\.user_id/);
  });

  it('別のユーザーなら同じ店に投稿できる', async () => {
    await insertReview([
      'rev_other_user',
      SHOP_ID,
      OTHER_USER_ID,
      4,
      'よかった',
      null,
      null,
      'published',
    ]);
  });

  it('同じユーザーでも別の店なら投稿できる', async () => {
    await insertReview([
      'rev_other_shop',
      OTHER_SHOP_ID,
      USER_ID,
      2,
      'ふつう',
      null,
      null,
      'published',
    ]);
  });

  it('評価 1 と 5 は受け付ける（境界値）', async () => {
    await insertReview([
      'rev_min',
      OTHER_SHOP_ID,
      OTHER_USER_ID,
      1,
      '低評価',
      null,
      null,
      'published',
    ]);
  });

  it('評価 0 は拒否する', async () => {
    await expect(
      insertReview(['rev_ng_zero', CHECK_SHOP_ID, CHECK_USER_ID, 0, 'x', null, null, 'published']),
    ).rejects.toThrow(/CHECK constraint failed: ck_reviews_rating/);
  });

  it('評価 6 は拒否する', async () => {
    await expect(
      insertReview(['rev_ng_six', CHECK_SHOP_ID, CHECK_USER_ID, 6, 'x', null, null, 'published']),
    ).rejects.toThrow(/CHECK constraint failed: ck_reviews_rating/);
  });

  it('定義にない status は拒否する', async () => {
    await expect(
      insertReview(['rev_ng_status', CHECK_SHOP_ID, CHECK_USER_ID, 3, 'x', null, null, 'banned']),
    ).rejects.toThrow(/CHECK constraint failed: ck_reviews_status/);
  });

  it('訪問日が YYYY-MM-DD 形式でなければ拒否する', async () => {
    await expect(
      insertReview([
        'rev_ng_date',
        CHECK_SHOP_ID,
        CHECK_USER_ID,
        3,
        'x',
        '2026/09/01',
        null,
        'published',
      ]),
    ).rejects.toThrow(/CHECK constraint failed: ck_reviews_visited_on_format/);
  });

  it('訪問日と予算は NULL を許す（覚えていない投稿があるため）', async () => {
    const row = await local.d1
      .prepare('SELECT visited_on, budget FROM reviews WHERE id = ?')
      .bind('rev_other_user')
      .first<{ visited_on: string | null; budget: number | null }>();

    expect(row?.visited_on).toBeNull();
    expect(row?.budget).toBeNull();
  });

  it('店舗の新着順は索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM reviews WHERE shop_id = 'shp_review' ORDER BY created_at DESC",
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    // 索引に desc を付けているので、並べ替えのための一時 B-Tree が出ない
    expect(detail).toContain('idx_reviews_shop_created');
    expect(detail).not.toContain('USE TEMP B-TREE');
  });

  it('公開中レビューの新着順も索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM reviews WHERE shop_id = 'shp_review' AND status = 'published' ORDER BY created_at DESC",
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_reviews_shop_status_created');
    expect(detail).not.toContain('USE TEMP B-TREE');
  });

  it('ユーザーの投稿履歴も索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM reviews WHERE user_id = 'usr_reviewer' ORDER BY created_at DESC",
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_reviews_user_created');
  });
});

describe('review_replies', () => {
  it('レビューが付いた店のオーナーは返信できる', async () => {
    await local.d1
      .prepare('INSERT INTO review_replies (review_id, shop_id, body) VALUES (?, ?, ?)')
      .bind('rev_first', SHOP_ID, 'ご来店ありがとうございました')
      .run();
  });

  it('1 レビューに返信は 1 件だけ（review_id が主キー）', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO review_replies (review_id, shop_id, body) VALUES (?, ?, ?)')
        .bind('rev_first', SHOP_ID, '2 件目')
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: review_replies\.review_id/);
  });

  it('他店の shop_id で返信を偽装できない', async () => {
    // rev_other_user は SHOP_ID へのレビュー。OTHER_SHOP_ID から返信しようとしても
    // (review_id, shop_id) の複合外部キーが成立しないため弾かれる
    await expect(
      local.d1
        .prepare('INSERT INTO review_replies (review_id, shop_id, body) VALUES (?, ?, ?)')
        .bind('rev_other_user', OTHER_SHOP_ID, 'なりすまし')
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('review_photos', () => {
  it('1 レビューに複数枚の写真を紐づけられる', async () => {
    await local.d1
      .prepare('INSERT INTO review_photos (id, review_id, r2_key, sort_order) VALUES (?, ?, ?, ?)')
      .bind('rph_1', 'rev_first', 'review-photos/rev_first/a1b2.webp', 0)
      .run();
    await local.d1
      .prepare('INSERT INTO review_photos (id, review_id, r2_key, sort_order) VALUES (?, ?, ?, ?)')
      .bind('rph_2', 'rev_first', 'review-photos/rev_first/c3d4.webp', 1)
      .run();
  });

  it('同じ R2 キーを 2 行で使えない', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO review_photos (id, review_id, r2_key, sort_order) VALUES (?, ?, ?, ?)',
        )
        .bind('rph_dup', 'rev_other_user', 'review-photos/rev_first/a1b2.webp', 0)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: review_photos\.r2_key/);
  });

  it('sort_order が負なら拒否する', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO review_photos (id, review_id, r2_key, sort_order) VALUES (?, ?, ?, ?)',
        )
        .bind('rph_ng', 'rev_other_user', 'review-photos/rev_other/e5f6.webp', -1)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_review_photos_sort_order/);
  });
});

describe('削除の連鎖', () => {
  it('レビューを消すと写真と返信も消える', async () => {
    await local.d1.prepare('DELETE FROM reviews WHERE id = ?').bind('rev_first').run();

    for (const tableName of ['review_photos', 'review_replies'] as const) {
      const row = await local.d1
        .prepare(`SELECT count(*) AS remaining FROM ${tableName} WHERE review_id = ?`)
        .bind('rev_first')
        .first<{ remaining: number }>();

      expect(row?.remaining).toBe(0);
    }
  });

  it('ユーザーを消すとそのユーザーのレビューも消える', async () => {
    await local.d1.prepare('DELETE FROM user WHERE id = ?').bind(OTHER_USER_ID).run();

    const row = await local.d1
      .prepare('SELECT count(*) AS remaining FROM reviews WHERE user_id = ?')
      .bind(OTHER_USER_ID)
      .first<{ remaining: number }>();

    // 退会したユーザーのレビューを残すと「誰が書いたか分からない投稿」になる。
    // 表示だけ消したい場合は status = 'deleted' を使い、user 行は消さない運用にする
    expect(row?.remaining).toBe(0);
  });
});
