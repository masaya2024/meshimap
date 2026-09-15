import { ROLES } from '@meshimap/core';

import { APP_SCHEME, AUTH_BASE_PATH, AUTH_STORAGE_PREFIX, ROLE_HOME_ROUTES } from './auth';

/** app.json は JSON のため import ではなく require で読み込む（fonts.test.ts と同じ方針） */
const appConfig: { expo: { scheme: string } } = require('../../app.json');

describe('認証まわりの定数', () => {
  it('3 つのロールすべてに着地ルートが定義されている', () => {
    expect(Object.keys(ROLE_HOME_ROUTES).sort()).toEqual([...ROLES].sort());
  });

  it('着地ルートはロールごとに重複しない', () => {
    const routes = Object.values(ROLE_HOME_ROUTES);

    expect(new Set(routes).size).toBe(routes.length);
  });

  it('着地ルートにグループ名を含めない（グループ名は URL に出ないため）', () => {
    for (const route of Object.values(ROLE_HOME_ROUTES)) {
      expect(route).not.toMatch(/\(|\)/);
    }
  });

  it('scheme は app.json の scheme と一致する', () => {
    // app.json とズレると Better Auth の expoClient が起点 URL を作れず OAuth が戻らない
    expect(APP_SCHEME).toBe(appConfig.expo.scheme);
  });

  it('SecureStore のキー接頭辞にコロンを含めない', () => {
    // @better-auth/expo は SecureStore がコロンを扱えないため名前を正規化する
    // （node_modules/@better-auth/expo/dist/client.js の normalizeCookieName）。
    // 正規化前後でキーが変わらないよう、最初からコロンを使わない
    expect(AUTH_STORAGE_PREFIX).not.toContain(':');
  });

  it('Better Auth のマウントパスは先頭スラッシュ付きで末尾スラッシュなし', () => {
    expect(AUTH_BASE_PATH.startsWith('/')).toBe(true);
    expect(AUTH_BASE_PATH.endsWith('/')).toBe(false);
  });
});
