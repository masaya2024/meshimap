import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

/** 固定のエポックミリ秒。テスト間で値がぶれると原因の切り分けが難しくなるため固定値を使う */
const FIXED_EPOCH_MS = 1_757_900_000_000;

/** 既定値の時刻比較に使う許容誤差。miniflare 起動と SQLite の時計のずれを吸収する */
const CLOCK_SKEW_TOLERANCE_MS = 1_000;

let local: LocalD1;

beforeAll(async () => {
  local = await createMigratedD1();
});

afterAll(async () => {
  await local.dispose();
});

describe('user テーブル', () => {
  it('必須カラムだけで INSERT できる', async () => {
    await local.d1
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind('usr_ok_1', '山田太郎', 'ok1@example.com', 0, FIXED_EPOCH_MS, FIXED_EPOCH_MS)
      .run();

    const row = await local.d1
      .prepare('SELECT name, email_verified FROM user WHERE id = ?')
      .bind('usr_ok_1')
      .first<{ name: string; email_verified: number }>();

    expect(row?.name).toBe('山田太郎');
    // boolean モードでも SQLite 上の実体は 0 / 1 の integer
    expect(row?.email_verified).toBe(0);
  });

  it('email が NULL の行は拒否する', async () => {
    await expect(
      local.d1
        .prepare(
          `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
             VALUES (?, ?, NULL, 0, 0, 0)`,
        )
        .bind('usr_ng_1', '名無し')
        .run(),
    ).rejects.toThrow(/NOT NULL constraint failed: user\.email/);
  });

  it('同じ email を 2 回登録できない', async () => {
    await local.d1
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
           VALUES (?, ?, ?, 0, 0, 0)`,
      )
      .bind('usr_dup_a', 'A', 'dup@example.com')
      .run();

    await expect(
      local.d1
        .prepare(
          `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
             VALUES (?, ?, ?, 0, 0, 0)`,
        )
        .bind('usr_dup_b', 'B', 'dup@example.com')
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: user\.email/);
  });

  it('created_at / updated_at は省略すると現在時刻がミリ秒で入る', async () => {
    const beforeMs = Date.now();
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind('usr_default_1', 'デフォルト', 'default1@example.com')
      .run();
    const afterMs = Date.now();

    const row = await local.d1
      .prepare('SELECT created_at, updated_at FROM user WHERE id = ?')
      .bind('usr_default_1')
      .first<{ created_at: number; updated_at: number }>();

    // unixepoch('subsecond') * 1000 がミリ秒として入る。秒精度の 1000 倍ではないことを桁で確認する
    expect(row?.created_at).toBeGreaterThanOrEqual(beforeMs - CLOCK_SKEW_TOLERANCE_MS);
    expect(row?.created_at).toBeLessThanOrEqual(afterMs + CLOCK_SKEW_TOLERANCE_MS);
    expect(row?.updated_at).toBeGreaterThanOrEqual(beforeMs - CLOCK_SKEW_TOLERANCE_MS);
  });
});

describe('session テーブル', () => {
  beforeAll(async () => {
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind('usr_sess_owner', 'セッション主', 'sess@example.com')
      .run();
  });

  it('存在しない user_id のセッションは作れない', async () => {
    await expect(
      local.d1
        .prepare(`INSERT INTO session (id, expires_at, token, user_id) VALUES (?, ?, ?, ?)`)
        .bind('ses_ng_1', FIXED_EPOCH_MS, 'token_ng_1', 'usr_does_not_exist')
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('token は一意である', async () => {
    await local.d1
      .prepare('INSERT INTO session (id, expires_at, token, user_id) VALUES (?, ?, ?, ?)')
      .bind('ses_dup_a', FIXED_EPOCH_MS, 'token_dup', 'usr_sess_owner')
      .run();

    await expect(
      local.d1
        .prepare('INSERT INTO session (id, expires_at, token, user_id) VALUES (?, ?, ?, ?)')
        .bind('ses_dup_b', FIXED_EPOCH_MS, 'token_dup', 'usr_sess_owner')
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: session\.token/);
  });

  it('ユーザーを削除するとセッションも消える（ON DELETE cascade）', async () => {
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind('usr_cascade', 'カスケード', 'cascade@example.com')
      .run();
    await local.d1
      .prepare('INSERT INTO session (id, expires_at, token, user_id) VALUES (?, ?, ?, ?)')
      .bind('ses_cascade', FIXED_EPOCH_MS, 'token_cascade', 'usr_cascade')
      .run();

    await local.d1.prepare('DELETE FROM user WHERE id = ?').bind('usr_cascade').run();

    const remaining = await local.d1
      .prepare('SELECT count(*) AS count FROM session WHERE user_id = ?')
      .bind('usr_cascade')
      .first<{ count: number }>();

    expect(remaining?.count).toBe(0);
  });
});

describe('account テーブル', () => {
  it('パスワード認証の行を作れる（password 以外の OAuth 用カラムは NULL でよい）', async () => {
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind('usr_acc', 'アカウント', 'acc@example.com')
      .run();

    await local.d1
      .prepare(
        `INSERT INTO account (id, account_id, provider_id, user_id, password)
           VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('acc_1', 'acc@example.com', 'credential', 'usr_acc', 'hashed')
      .run();

    const row = await local.d1
      .prepare('SELECT provider_id, access_token FROM account WHERE id = ?')
      .bind('acc_1')
      .first<{ provider_id: string; access_token: string | null }>();

    expect(row?.provider_id).toBe('credential');
    expect(row?.access_token).toBeNull();
  });
});

describe('verification テーブル', () => {
  it('identifier / value / expires_at が揃っていれば INSERT できる', async () => {
    await local.d1
      .prepare('INSERT INTO verification (id, identifier, value, expires_at) VALUES (?, ?, ?, ?)')
      .bind('vrf_1', 'verify@example.com', 'code_123', FIXED_EPOCH_MS)
      .run();

    const row = await local.d1
      .prepare('SELECT value FROM verification WHERE id = ?')
      .bind('vrf_1')
      .first<{ value: string }>();

    expect(row?.value).toBe('code_123');
  });

  it('identifier が NULL の行は拒否する', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO verification (id, identifier, value, expires_at) VALUES (?, NULL, ?, ?)',
        )
        .bind('vrf_ng', 'code_ng', FIXED_EPOCH_MS)
        .run(),
    ).rejects.toThrow(/NOT NULL constraint failed: verification\.identifier/);
  });
});

describe('索引', () => {
  it('Better Auth が引く列に索引が張られている', async () => {
    const rows = await local.d1
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all<{ name: string }>();
    const indexNames = rows.results.map((row) => row.name);

    expect(indexNames).toContain('idx_session_user_id');
    expect(indexNames).toContain('idx_account_user_id');
    expect(indexNames).toContain('idx_verification_identifier');
  });
});
