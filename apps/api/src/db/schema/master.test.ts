import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

let local: LocalD1;

/** テストで使い回す既存ユーザー。profiles は user への FK を持つため先に要る */
const EXISTING_USER_ID = 'usr_master_owner';

beforeAll(async () => {
  local = await createMigratedD1();
  await local.d1
    .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
    .bind(EXISTING_USER_ID, 'マスタ試験', 'master@example.com')
    .run();
});

afterAll(async () => {
  await local.dispose();
});

describe('profiles テーブル', () => {
  it('role / status を省略すると user / active になる', async () => {
    await local.d1
      .prepare('INSERT INTO profiles (user_id, display_name) VALUES (?, ?)')
      .bind(EXISTING_USER_ID, '表示名')
      .run();

    const row = await local.d1
      .prepare('SELECT role, status FROM profiles WHERE user_id = ?')
      .bind(EXISTING_USER_ID)
      .first<{ role: string; status: string }>();

    expect(row?.role).toBe('user');
    expect(row?.status).toBe('active');
  });

  it('存在しない user_id のプロフィールは作れない', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO profiles (user_id, display_name) VALUES (?, ?)')
        .bind('usr_not_exist', 'ダミー')
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('定義にない role は CHECK で拒否する', async () => {
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind('usr_bad_role', 'X', 'badrole@example.com')
      .run();

    await expect(
      local.d1
        .prepare('INSERT INTO profiles (user_id, display_name, role) VALUES (?, ?, ?)')
        .bind('usr_bad_role', 'X', 'superadmin')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_profiles_role/);
  });

  it('3 つのロールはすべて受け付ける', async () => {
    for (const [index, role] of ['user', 'owner', 'admin'].entries()) {
      const userId = `usr_role_${String(index)}`;
      await local.d1
        .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
        .bind(userId, role, `${role}@example.com`)
        .run();
      await local.d1
        .prepare('INSERT INTO profiles (user_id, display_name, role) VALUES (?, ?, ?)')
        .bind(userId, role, role)
        .run();
    }

    const row = await local.d1
      .prepare("SELECT count(*) AS count FROM profiles WHERE user_id LIKE 'usr_role_%'")
      .first<{ count: number }>();

    expect(row?.count).toBe(3);
  });

  it('定義にない status は CHECK で拒否する', async () => {
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind('usr_bad_status', 'Y', 'badstatus@example.com')
      .run();

    await expect(
      local.d1
        .prepare('INSERT INTO profiles (user_id, display_name, status) VALUES (?, ?, ?)')
        .bind('usr_bad_status', 'Y', 'banned')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_profiles_status/);
  });

  it('ユーザーを削除するとプロフィールも消える', async () => {
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind('usr_pcascade', 'Z', 'pcascade@example.com')
      .run();
    await local.d1
      .prepare('INSERT INTO profiles (user_id, display_name) VALUES (?, ?)')
      .bind('usr_pcascade', 'Z')
      .run();

    await local.d1.prepare('DELETE FROM user WHERE id = ?').bind('usr_pcascade').run();

    const row = await local.d1
      .prepare('SELECT count(*) AS count FROM profiles WHERE user_id = ?')
      .bind('usr_pcascade')
      .first<{ count: number }>();

    expect(row?.count).toBe(0);
  });
});

describe('genres テーブル', () => {
  it('slug は一意である', async () => {
    await local.d1
      .prepare('INSERT INTO genres (id, name, slug, sort_order) VALUES (?, ?, ?, ?)')
      .bind('gnr_a', 'ラーメン', 'ramen', 1)
      .run();

    await expect(
      local.d1
        .prepare('INSERT INTO genres (id, name, slug, sort_order) VALUES (?, ?, ?, ?)')
        .bind('gnr_b', 'らーめん', 'ramen', 2)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: genres\.slug/);
  });

  it('sort_order を省略すると 0 になる', async () => {
    await local.d1
      .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
      .bind('gnr_default', '未分類', 'other')
      .run();

    const row = await local.d1
      .prepare('SELECT sort_order FROM genres WHERE id = ?')
      .bind('gnr_default')
      .first<{ sort_order: number }>();

    expect(row?.sort_order).toBe(0);
  });

  it('負の sort_order は CHECK で拒否する', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO genres (id, name, slug, sort_order) VALUES (?, ?, ?, ?)')
        .bind('gnr_neg', '負', 'negative', -1)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_genres_sort_order/);
  });

  it('slug に大文字は入れられない（URL に出るため小文字とハイフンのみ）', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
        .bind('gnr_upper', '大文字', 'Ramen')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_genres_slug_format/);
  });

  it('slug の途中に空白が混じっても拒否する（GLOB の先頭 1 文字判定では見逃す境界）', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
        .bind('gnr_space', '空白', 'ra men')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_genres_slug_format/);
  });

  it('空文字の slug も拒否する', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
        .bind('gnr_empty', '空', '')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_genres_slug_format/);
  });
});

describe('areas テーブル', () => {
  it('parent_id なしの親エリアを作れる', async () => {
    await local.d1
      .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
      .bind('area_shibuya_ku', '渋谷区', '東京都')
      .run();

    const row = await local.d1
      .prepare('SELECT parent_id FROM areas WHERE id = ?')
      .bind('area_shibuya_ku')
      .first<{ parent_id: string | null }>();

    expect(row?.parent_id).toBeNull();
  });

  it('親エリアを指す子エリアを作れる（自己参照 FK）', async () => {
    await local.d1
      .prepare('INSERT INTO areas (id, name, parent_id, prefecture) VALUES (?, ?, ?, ?)')
      .bind('area_shibuya', '渋谷', 'area_shibuya_ku', '東京都')
      .run();

    const row = await local.d1
      .prepare('SELECT parent_id FROM areas WHERE id = ?')
      .bind('area_shibuya')
      .first<{ parent_id: string | null }>();

    expect(row?.parent_id).toBe('area_shibuya_ku');
  });

  it('存在しない parent_id は拒否する', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO areas (id, name, parent_id, prefecture) VALUES (?, ?, ?, ?)')
        .bind('area_orphan', '孤児', 'area_not_exist', '東京都')
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('親エリアを削除すると子の parent_id は NULL になる（子ごと消さない）', async () => {
    await local.d1
      .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
      .bind('area_temp_parent', '仮親', '東京都')
      .run();
    await local.d1
      .prepare('INSERT INTO areas (id, name, parent_id, prefecture) VALUES (?, ?, ?, ?)')
      .bind('area_temp_child', '仮子', 'area_temp_parent', '東京都')
      .run();

    await local.d1.prepare('DELETE FROM areas WHERE id = ?').bind('area_temp_parent').run();

    const row = await local.d1
      .prepare('SELECT parent_id FROM areas WHERE id = ?')
      .bind('area_temp_child')
      .first<{ parent_id: string | null }>();

    // エリア階層の付け替えは管理画面の日常操作。子ごと消えると店舗が宙に浮くため set null にしている
    expect(row?.parent_id).toBeNull();
  });
});

describe('索引', () => {
  it('マスタの検索に使う索引が張られている', async () => {
    const rows = await local.d1
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all<{ name: string }>();
    const indexNames = rows.results.map((row) => row.name);

    expect(indexNames).toContain('idx_profiles_role');
    expect(indexNames).toContain('idx_genres_sort_order');
    expect(indexNames).toContain('idx_areas_parent_id');
  });
});
