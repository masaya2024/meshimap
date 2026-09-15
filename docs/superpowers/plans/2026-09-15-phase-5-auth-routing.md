# Phase 5: 認証 + ロールルーティング（モバイル） 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** メール／パスワードでサインインし、`profiles.role`（`user` / `owner` / `admin`）に応じて `(user)` / `(owner)` / `(admin)` のいずれかのルートグループへ着地する。未認証は `(auth)` 以外に到達できず、セッション復元中はログイン画面が一瞬たりとも表示されない。

**Architecture:** ルート `app/_layout.tsx` に `QueryClientProvider` → `AuthProvider` → `Stack` を積む。アクセス制御は expo-router 57 の `<Stack.Protected guard={...}>` で宣言的に行い、ロールごとの着地先の決定（どこへ飛ばすか）はアンカールートである `app/index.tsx` の `<Redirect>` が担う。認証状態は「復元中 / 未認証 / プロフィール取得失敗 / 認証済み」の 4 状態の判別共用体として `features/auth/auth-context.tsx` が一元的に供給し、スプラッシュはフォント読込と復元完了の **両方** が揃うまで閉じない。

**Tech Stack:** Expo SDK 57.0.22 / React Native 0.86.3 / React 19.2.3 / expo-router 57.0.21（`typedRoutes` + `reactCompiler`）/ better-auth 1.7.5 + @better-auth/expo 1.7.5 / expo-secure-store 57.0.4 / @tanstack/react-query 5.102.8 / react-hook-form 7.88.0 + @hookform/resolvers 5.9.1 + zod 4.6.5 / hono 4.13.7 / NativeWind 4.2.7 + Tailwind 3.4.19 / Jest 30 + jest-expo 57 + @testing-library/react-native 14

## Global Constraints

- ファイル名・ディレクトリ名は **kebab-case**（例外なし）。expo-router の動的セグメントは `[shopId]` のように具体名にする
- コンポーネント名は **PascalCase**、関数・変数は **camelCase**、定数は **UPPER_SNAKE_CASE**
- `any` 禁止・`as` によるキャスト禁止・`!` 禁止・`console.log` 禁止（`lib/logger.ts` 経由）・マジックナンバー／マジックストリング禁止
- デフォルトエクスポート禁止（expo-router の画面・レイアウトファイルのみ例外。仕様上 default が必須）
- 任意 prop は `exactOptionalPropertyTypes` のため必ず `?: T | undefined` と書く
- 型だけの import は `verbatimModuleSyntax` のため必ず `import type` にする
- スタイルは NativeWind の `className` で書く。数値の直書きが必要な場合のみ `style` を使い、理由をコメントに残す
- 真偽値は `is` / `has` / `can` / `should` で始める。数値には単位を名前に入れる（`DEFAULT_TIMEOUT_MS`）
- コメントは日本語で「なぜ」を書く。テスト名は日本語で振る舞いを書く
- RNTL 14 は `defaultIncludeHiddenElements: false`。`Icon` のように a11y から隠した要素は `getByTestId(id, { includeHiddenElements: true })` でしか取得できない
- **RNTL 14 の `render` / `fireEvent` / `renderRouter` は Promise を返す**（`node_modules/@testing-library/react-native/dist/render.d.ts` の `Promise<{...}>`）。`await` を忘れると `screen` が空のまま assert が走る。`renderRouter` は `Promise<RenderResult> & { getPathname(): string; ... }` なので、**`await app;` してから `app.getPathname()`** を呼ぶ
- `jest.mock()` のファクトリから参照する変数は **`mock` で始まる名前**にする。`babel-plugin-jest-hoist` が `/^mock/i` に一致しない外部変数を弾く（`node_modules/babel-plugin-jest-hoist/build/index.js:77`）。本計画のテストはすべて `mockXxx` 形式で統一する
- 作業ディレクトリはリポジトリルート `/Users/hattori/Downloads/alee`。モバイル向けコマンドは `-w @meshimap/mobile` を付ける
- Node は 22.23.2。**すべてのコマンドの前に** `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"` を実行する
- `npm install` / `npm ci` は実行しない（他フェーズのエージェントと並行作業中で lockfile が壊れるため）。必要な依存はすべて `apps/mobile/package.json` に導入済み

## 採用したルーティング方式と根拠

**方式: `<Stack.Protected>`（アクセス制御）+ アンカールート `index.tsx` の `<Redirect>`（配り先の決定）のハイブリッド。**

| 判断                                      | 根拠                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| アクセス制御に `<Stack.Protected>` を使う | 公式ドキュメント https://docs.expo.dev/router/advanced/authentication/ が SDK 54 以降の推奨として `<Stack.Protected guard={!!session}>` の例を示している。旧来のリダイレクト方式は https://docs.expo.dev/router/advanced/authentication-rewrites.md に「SDK 52 以前向け」として退避されている                                                                                |
| API の実在確認                            | `node_modules/expo-router/build/views/Protected.d.ts` に `export type ProtectedProps = { guard: boolean; children?: ReactNode }`、`node_modules/expo-router/build/layouts/StackClient.d.ts` の `Stack` 型に `Protected: FunctionComponent<ProtectedProps>` がある                                                                                                            |
| ガードが落ちたときの挙動                  | https://docs.expo.dev/router/advanced/protected/ に「they will be redirected to the anchor route (usually the index screen) or the first available screen in the stack」「When a screen's guard is changed from true to false, all of its history entries will be removed from the navigation history」と明記。つまり**ロール変更・セッション失効で自動的に `index` へ戻る** |
| アンカーを `index` に固定する             | `node_modules/expo-router/build/getRoutesCore.js:655` が `loaded.unstable_settings.anchor ?? loaded.unstable_settings.initialRouteName ?? anchor` を読む。`anchor` が新名称で `initialRouteName` は後方互換                                                                                                                                                                  |
| 配り先の決定を `index.tsx` に置く         | 設計書 §5.1 が `index.tsx` の役割を「ロール判定 → 各グループへリダイレクト」と定めている。上記のフォールバック先がまさに `index` なので、**ガードで弾く → index に戻る → index が正しいグループへ配り直す** が一本の流れで閉じる                                                                                                                                             |
| `<Redirect>` の API 確認                  | `node_modules/expo-router/build/link/Redirect.d.ts` に `RedirectProps = { href: Href; relativeToDirectory?: boolean; withAnchor?: boolean }`、戻り値は `null`                                                                                                                                                                                                                |

**`<Redirect>` だけで組まない理由:** `<Redirect>` は「描画されてから」飛ばすため、保護対象の画面が 1 フレーム描画される余地が残る。`<Stack.Protected>` はガードが false のスクリーンをそもそもナビゲータに登録しないので、ロール外ルートは**存在しない**扱いになる（設計書 §5.1 の「ロール外のルートには到達できない」を型ではなく構造で満たせる）。

**`<Stack.Protected>` だけで組まない理由:** `Protected` は「入れない」ことしか表現できず、「どこへ入れるか」を決められない。3 ロール分岐は `index.tsx` 側の責務として残す必要がある。

### 設計書 §5.1 からの意図的な逸脱（1 箇所）

設計書は利用者ホームを `(user)/(tabs)/index.tsx` としているが、本計画では **`(user)/(tabs)/home.tsx`** にする。

理由: https://docs.expo.dev/router/advanced/shared-routes/ に「Group segments are not part of the URL, so every shared route matches the same URL.」「A cold link has no current group, so Expo Router renders the first alphabetical match.」とある。グループ名は URL に出ないため `app/index.tsx` と `app/(user)/(tabs)/index.tsx` はどちらも URL `/` になり、コールドリンク時の解決がアルファベット順の暗黙ルールに委ねられる。ロールディスパッチャを `/` に置く以上、`/` を一意にしないと分岐そのものが不安定になる。`/home` にすれば衝突が消え、`(owner)` の `/dashboard`、`(admin)` の `/overview` とも粒度が揃う。**この逸脱は設計書 §5.1 にも反映すること**（Phase 5 完了条件に含める）。

## ルートツリー（実パス）

`★` = Phase 5 で作る / `☆` = Phase 5 で中身まで作る（画面本体）/ `▽` = Phase 5 では最小プレースホルダのみ、Phase 6 以降で中身を作る / `（既存）` = Phase 0 の成果物

```
apps/mobile/src/app/
├── _layout.tsx                              ★変更（Providers + Stack.Protected + スプラッシュ制御）
├── _layout.test.tsx                         ★新規（ガードの通し確認）
├── index.tsx                                ★変更（ロールディスパッチャ）
├── index.test.tsx                           ★新規
├── +not-found.tsx                           ★新規
├── route-files.test.ts                      ★新規（定数のパスと実ファイルの対応を守る回帰テスト）
├── routing.test.tsx                         ★新規（ルーティング統合テスト）
├── _dev/
│   ├── catalog.tsx                          （既存・変更なし）
│   └── catalog.test.tsx                     （既存・変更なし）
│
├── (auth)/                                  ── 未認証 ──────────────────────
│   ├── _layout.tsx                          ★新規
│   ├── welcome.tsx                          ☆新規（オンボーディング。ゲスト導線は Phase 6）
│   ├── welcome.test.tsx                     ★新規
│   ├── sign-in.tsx                          ☆新規
│   ├── sign-in.test.tsx                     ★新規
│   ├── sign-up.tsx                          ☆新規
│   ├── sign-up.test.tsx                     ★新規
│   ├── verify-email.tsx                     ☆新規
│   ├── verify-email.test.tsx                ★新規
│   ├── forgot-password.tsx                  ☆新規
│   └── forgot-password.test.tsx             ★新規
│
├── (user)/                                  ── 利用者 ──────────────────────
│   ├── _layout.tsx                          ★新規
│   ├── (tabs)/
│   │   ├── _layout.tsx                      ★新規（Phase 5 は 2 タブ。Phase 6 で 5 タブへ）
│   │   ├── home.tsx                         ▽新規（設計書の (tabs)/index.tsx を改名。上記「逸脱」参照）
│   │   └── profile.tsx                      ▽新規（設定への入口のみ）
│   └── settings/
│       ├── index.tsx                        ☆新規（account / shop-application への入口）
│       ├── index.test.tsx                   ★新規
│       ├── account.tsx                      ☆新規（ログアウト）
│       ├── account.test.tsx                 ★新規
│       ├── shop-application.tsx             ☆新規（owner 昇格の申請入口）
│       └── shop-application.test.tsx        ★新規
│   （shop/ review/ reservations/ lists/ notifications.tsx / report/ は Phase 6 以降）
│   （settings/profile-edit.tsx / settings/notifications.tsx は Phase 6 以降）
│
├── (owner)/                                 ── 店舗管理者 ──────────────────
│   ├── _layout.tsx                          ★新規
│   ├── (tabs)/
│   │   ├── _layout.tsx                      ★新規（Phase 5 は 2 タブ。Phase 8 で 5 タブへ）
│   │   ├── dashboard.tsx                    ▽新規
│   │   ├── account.tsx                      ☆新規（ログアウト）
│   │   └── account.test.tsx                 ★新規
│   └── onboarding/
│       ├── status.tsx                       ☆新規（審査ステータス）
│       └── status.test.tsx                  ★新規
│   （shop/ reservations/ reviews/ campaigns/ onboarding/apply.tsx は Phase 8）
│
└── (admin)/                                 ── システム管理者 ──────────────
    ├── _layout.tsx                          ★新規
    └── (tabs)/
        ├── _layout.tsx                      ★新規（Phase 5 は 2 タブ。Phase 9 で 5 タブへ）
        ├── overview.tsx                     ▽新規
        ├── more.tsx                         ☆新規（ログアウト）
        └── more.test.tsx                    ★新規
    （approvals/ reports/ users/ shops/ masters/ announcements.tsx / audit-log.tsx は Phase 9）
```

```
apps/mobile/src/（app 以外）
├── components/
│   ├── auth/
│   │   ├── auth-loading-screen.tsx          ★新規
│   │   ├── auth-loading-screen.test.tsx     ★新規
│   │   ├── auth-form-screen.tsx             ★新規（認証フォームの外枠）
│   │   ├── auth-form-screen.test.tsx        ★新規
│   │   ├── form-error-banner.tsx            ★新規（送信失敗の文言表示）
│   │   ├── form-error-banner.test.tsx       ★新規
│   │   ├── sign-out-button.tsx              ★新規
│   │   └── sign-out-button.test.tsx         ★新規
│   ├── placeholder-screen.tsx               ★新規（Phase 6 以降で中身を作る画面の枠）
│   ├── placeholder-screen.test.tsx          ★新規
│   └── ui/
│       ├── input.tsx                        ★変更（textBehavior / onBlur / isDisabled 追加）
│       ├── input.test.tsx                   ★変更（回帰テスト追加）
│       ├── password-input.tsx               ★新規
│       ├── password-input.test.tsx          ★新規
│       └── （button / card / badge / skeleton / icon / empty-state / error-state は既存・変更なし）
├── constants/
│   ├── auth.ts                              ★新規
│   ├── auth.test.ts                         ★新規
│   ├── api.ts                               ★新規
│   ├── http.ts                              ★新規
│   ├── shop-application.ts                  ★新規
│   └── （theme.ts / fonts.ts は既存・変更なし）
├── features/auth/
│   ├── types.ts                             ★新規（AuthState 判別共用体）
│   ├── auth-error.ts                        ★新規
│   ├── auth-error.test.ts                   ★新規
│   ├── api.ts                               ★新規（authClient / apiClient への薄いラッパー）
│   ├── api.test.ts                          ★新規
│   ├── auth-context.tsx                     ★新規（AuthProvider / useAuth）
│   ├── auth-context.test.tsx                ★新規
│   ├── use-auth-mutation.ts                 ★新規（送信・失敗文言・多重送信防止の共通フック）
│   ├── use-auth-mutation.test.tsx           ★新規
│   ├── use-sign-out.ts                      ★新規（サインアウト + Query キャッシュ全消去）
│   ├── use-sign-out.test.tsx                ★新規
│   └── sign-out-storage.test.ts             ★新規（Better Auth を素通しして SecureStore の実挙動を検証）
├── features/shop-application/
│   ├── api.ts                               ★新規（申請の送信 / 自分の申請状況の取得）
│   └── api.test.ts                          ★新規
├── hooks/
│   ├── use-app-fonts.ts                     ★変更（読込失敗でも決着したことを表す hasFontLoadingSettled を追加）
│   └── use-app-fonts.test.ts                ★変更（hasFontLoadingSettled の 3 件を追記）
└── lib/
    ├── auth-client.ts                       ★新規
    ├── auth-client.test.ts                  ★新規
    ├── api-client.ts                        ★新規
    ├── api-client.test.ts                   ★新規
    ├── api-types.ts                         ★新規（Phase 4 完了時に削除する暫定型）
    ├── query-client.ts                      ★新規
    └── （logger.ts は既存・変更なし）
```

その他の変更ファイル:

```
apps/mobile/jest.config.js                   ★変更（better-auth 系の変換追加 + global.css のスタブ差し替え）
apps/mobile/jest-css-stub.js                 ★新規（Jest で global.css を無害化する空モジュール）
docs/superpowers/specs/2026-09-15-meshimap-design.md  ★変更（§5.1 の (user)/(tabs)/index.tsx → home.tsx）
```

---

### Task 5-1: ロール・ルート・HTTP の定数と認証状態の型を定義する

**状態: 実装済み（2026-09-15）。**以下は実際にコミットされた内容に合わせて更新してある。

**Files:**

- Create: `apps/mobile/src/constants/auth.ts`
- Create: `apps/mobile/src/constants/auth.test.ts`
- Create: `apps/mobile/src/constants/api.ts`
- Create: `apps/mobile/src/constants/api.test.ts`
- Create: `apps/mobile/src/constants/http.ts`
- Create: `apps/mobile/src/constants/http.test.ts`
- Create: `apps/mobile/src/features/auth/types.ts`

> `http.ts` / `api.ts` にも必ずテストを添える。`apps/mobile/jest.config.js` の
> `collectCoverageFrom` は `src/**/*.{ts,tsx}`（`src/app/**` とテストのみ除外。この除外は
> Phase 5 の最後の Task 5-21 Step 4-a で `!src/app/_dev/**` に差し替わる）で、
> `coverageThreshold.global` は statements / branches / functions / lines すべて 100%。
> どのテストからも import されないファイルは 0% として集計されるため、実装ファイルを
> 足したら同じタスク内でテストも足さないと閾値で落ちる。
> （`features/auth/types.ts` は型だけで実行文が無く statements 0 → 100% 扱いになるため、
> 専用テストは不要。`apps/mobile/coverage/coverage-summary.json` の当該エントリで確認済み）

**Interfaces:**

- Consumes（`@meshimap/core`。**このリポジトリでは絶対に再定義しない**。
  `packages/core/src/index.ts` の実 export 名に合わせること）:
  - `type Role = 'user' | 'owner' | 'admin'`（型名は `Role`。`UserRole` は存在しない）
  - `const ROLES: readonly ['user', 'owner', 'admin']`（`as const` の**タプル**。オブジェクトではないので `Object.values()` は使わず `[...ROLES]`。権限の弱い順に並んでいる）
  - `const ROLE_USER: 'user'` / `const ROLE_OWNER: 'owner'` / `const ROLE_ADMIN: 'admin'`
  - `type UserId`（`packages/core/src/identifier.ts` のブランド型）
- Produces:
  - `const AUTH_STORAGE_PREFIX: 'meshimap-auth'`
  - `const APP_SCHEME: 'alee'`
  - `const AUTH_BASE_PATH: '/api/auth'`
  - `const PROFILE_QUERY_KEY: readonly ['auth', 'profile']`
  - `const PROFILE_QUERY_RETRY_COUNT: 0`、`const PROFILE_QUERY_STALE_TIME_MS: number`
  - `const ROLE_HOME_ROUTES: Record<Role, Href>`
  - `const SIGN_IN_ROUTE: Href`、`const WELCOME_ROUTE: Href`、`const VERIFY_EMAIL_ROUTE: Href`、`const FORGOT_PASSWORD_ROUTE: Href`、`const SIGN_UP_ROUTE: Href`、`const ROOT_ROUTE: Href`、`const SHOP_APPLICATION_ROUTE: Href`、`const OWNER_ONBOARDING_STATUS_ROUTE: Href`
  - `const API_BASE_URL: string`、`const API_TIMEOUT_MS: number`
  - `const HTTP_STATUS: { readonly unauthorized: 401; readonly forbidden: 403; readonly conflict: 409; readonly tooManyRequests: 429 }`
  - `type AuthState = { status: 'restoring' } | { status: 'unauthenticated' } | { status: 'profile-unavailable'; retry: () => void } | { status: 'authenticated'; userId: UserId; role: Role; displayName: string }`

- [x] **Step 1: `@meshimap/core` が必要な export を持っているか確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && grep -rn "export .*\bROLES\b\|export type { Role\|UserId" /Users/hattori/Downloads/alee/packages/core/src/index.ts`
Expected: `ROLES` / `ROLE_USER` / `ROLE_OWNER` / `ROLE_ADMIN` / `type Role` / `type UserId` が export されている。
ここで自前の型を定義して二重管理にしない（設計書 §4 のロール定義は `packages/core` が唯一の出所）。
**`packages/core/src/index.test.ts` が export 名の一覧を完全一致で固定している**ため、core 側に
新しい export を足すには core 本体とそのテストの両方を変更する必要がある。モバイル側の都合で
気軽に足さないこと。

- [x] **Step 2: 失敗するテストを書く**

```ts
// apps/mobile/src/constants/auth.test.ts
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
```

`require('../../app.json')` に `// eslint-disable-next-line @typescript-eslint/no-require-imports` は
**付けない**。`eslint-config-expo/flat/utils/typescript.js:85-96` が `no-require-imports` の `allow` に
`'\\.(aac|aiff|...|json|...)$'` という 1 本の正規表現を渡していて **json が含まれる**ため、
`.json` の require はそもそも警告されない。そこに disable を置くと `Unused eslint-disable directive` の
warning になる（`.js` / `.ts` を require する箇所では逆に必要）。

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- constants/auth`
Expected: FAIL（`Cannot find module './auth'`）

- [x] **Step 3: `constants/http.ts` と `constants/http.test.ts` を作る**

```ts
// apps/mobile/src/constants/http.ts

/** 認証・認可まわりで分岐に使う HTTP ステータス。数値の直書きを避けるために名前を付ける */
export const HTTP_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  tooManyRequests: 429,
} as const;
```

```ts
// apps/mobile/src/constants/http.test.ts
import { HTTP_STATUS } from './http';

/** 4xx の下限と上限。ここに収まらない値が混ざったら「クライアントエラーの集合」ではなくなる */
const CLIENT_ERROR_STATUS_MIN = 400;
const CLIENT_ERROR_STATUS_MAX = 499;

describe('HTTP_STATUS', () => {
  it('認証・認可の分岐で使う 4 つのステータスを持つ', () => {
    expect(HTTP_STATUS).toEqual({
      unauthorized: 401,
      forbidden: 403,
      conflict: 409,
      tooManyRequests: 429,
    });
  });

  it('すべてクライアントエラー（4xx）の範囲に収まる', () => {
    for (const status of Object.values(HTTP_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(CLIENT_ERROR_STATUS_MIN);
      expect(status).toBeLessThanOrEqual(CLIENT_ERROR_STATUS_MAX);
    }
  });
});
```

- [x] **Step 4: `constants/api.ts` と `constants/api.test.ts` を作る**

```ts
// apps/mobile/src/constants/api.ts

/**
 * 開発時の既定 API ベース URL。
 * iOS シミュレータ / Android エミュレータの差異は EXPO_PUBLIC_API_URL で吸収する前提で、
 * ここは wrangler dev の既定ポートに合わせる（apps/api/wrangler.toml と対応）。
 */
const DEFAULT_API_BASE_URL = 'http://localhost:8787';

/**
 * EXPO_PUBLIC_ 接頭辞の環境変数だけがクライアントバンドルに埋め込まれる。
 * 未設定でも開発が止まらないよう既定値にフォールバックする。
 */
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API_BASE_URL;

/** ネットワーク待ちの上限。これを超えたらローディングを畳んでエラー表示に切り替える */
export const API_TIMEOUT_MS = 15_000;
```

```ts
// apps/mobile/src/constants/api.test.ts

/** テスト内で EXPO_PUBLIC_API_URL に差し込む値。既定値と必ず異なるものにする */
const OVERRIDE_API_URL = 'https://api.example.test';

/** constants/api.ts の DEFAULT_API_BASE_URL と対になる期待値（wrangler dev の既定ポート） */
const EXPECTED_DEFAULT_API_BASE_URL = 'http://localhost:8787';

/**
 * API_BASE_URL は import 時に確定するので、毎回モジュールを読み直して環境変数を反映させる。
 * 動的 import() は Jest の CJS 環境（--experimental-vm-modules なし）で使えないため require で読む。
 */
function loadApiConstants(): typeof import('./api') {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./api');
}

describe('API 接続の定数', () => {
  const originalApiUrl = process.env.EXPO_PUBLIC_API_URL;

  afterEach(() => {
    // 他のテストへ環境変数を漏らさないため、必ず元の状態へ戻す
    if (originalApiUrl === undefined) {
      delete process.env.EXPO_PUBLIC_API_URL;
    } else {
      process.env.EXPO_PUBLIC_API_URL = originalApiUrl;
    }
    jest.resetModules();
  });

  it('EXPO_PUBLIC_API_URL が設定されていればその値を使う', () => {
    process.env.EXPO_PUBLIC_API_URL = OVERRIDE_API_URL;

    const { API_BASE_URL } = loadApiConstants();

    expect(API_BASE_URL).toBe(OVERRIDE_API_URL);
  });

  it('EXPO_PUBLIC_API_URL が未設定なら開発用の既定 URL にフォールバックする', () => {
    delete process.env.EXPO_PUBLIC_API_URL;

    const { API_BASE_URL } = loadApiConstants();

    expect(API_BASE_URL).toBe(EXPECTED_DEFAULT_API_BASE_URL);
  });

  it('ネットワーク待ちの上限は正の値で、単位がミリ秒だと名前から分かる', () => {
    const { API_TIMEOUT_MS } = loadApiConstants();

    expect(API_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
```

`typeof import('./api')` は型位置の import なので実行時の動的 import にはならず、Jest の CJS 環境でも
問題なく動く。値としての `await import('...')` だけが
`TypeError: A dynamic import callback was invoked without --experimental-vm-modules` で落ちる。
**このプラン全体で「モジュールを読み直す」テストはすべてこの形で書くこと。**

- [x] **Step 5: `constants/auth.ts` を作る**

```ts
// apps/mobile/src/constants/auth.ts
import type { Role } from '@meshimap/core';
import type { Href } from 'expo-router';

/**
 * SecureStore に保存されるキーの接頭辞。
 * @better-auth/expo は `<prefix>_cookie` と `<prefix>_session_data` の 2 キーを作る
 * （node_modules/@better-auth/expo/dist/client.js の cookieName / localCacheName）。
 * 既定の 'better-auth' のままだと他アプリと衝突しうるのでアプリ名を含める。
 */
export const AUTH_STORAGE_PREFIX = 'meshimap-auth';

/** app.json の expo.scheme と一致させる。ズレると expoClient が起点 URL を作れない */
export const APP_SCHEME = 'alee';

/** Better Auth のサーバ側マウントパス（Better Auth の既定値）。apps/api 側と一致させる */
export const AUTH_BASE_PATH = '/api/auth';

/** プロフィール（= ロール）を TanStack Query で保持するときのキー接頭辞 */
export const PROFILE_QUERY_KEY = ['auth', 'profile'] as const;

/**
 * プロフィール取得の自動リトライ回数。
 * 自動リトライを入れるとスプラッシュが閉じるまでの時間が伸びて体感が悪化するため 0 にし、
 * 失敗時は index.tsx の ErrorState から手動で再試行させる。
 */
export const PROFILE_QUERY_RETRY_COUNT = 0;

/** プロフィールの再取得間隔。ロールは頻繁に変わらないので長めに取る（5 分） */
export const PROFILE_QUERY_STALE_TIME_MS = 5 * 60 * 1000;

export const ROOT_ROUTE: Href = '/';
export const WELCOME_ROUTE: Href = '/welcome';
export const SIGN_IN_ROUTE: Href = '/sign-in';
export const SIGN_UP_ROUTE: Href = '/sign-up';
export const VERIFY_EMAIL_ROUTE: Href = '/verify-email';
export const FORGOT_PASSWORD_ROUTE: Href = '/forgot-password';
export const SHOP_APPLICATION_ROUTE: Href = '/settings/shop-application';
export const OWNER_ONBOARDING_STATUS_ROUTE: Href = '/onboarding/status';

/**
 * ロールごとの着地ルート。
 * グループ名（(user) など）は URL に出ないためパスには含めない
 * （https://docs.expo.dev/router/advanced/shared-routes/）。
 */
export const ROLE_HOME_ROUTES: Record<Role, Href> = {
  user: '/home',
  owner: '/dashboard',
  admin: '/overview',
};
```

- [x] **Step 6: `features/auth/types.ts` を作る**

```ts
// apps/mobile/src/features/auth/types.ts
import type { Role, UserId } from '@meshimap/core';

/**
 * アプリ全体が参照する唯一の認証状態。
 * 「復元中」を独立した状態として持たせるのが要点で、
 * これが無いと復元中の未認証（= セッションがまだ読めていない）と
 * 本当の未認証を区別できず、起動直後にログイン画面がちらつく。
 */
export type AuthState =
  /** SecureStore からのセッション復元、またはプロフィール取得が進行中 */
  | { status: 'restoring' }
  /** セッションが無い。(auth) グループのみ到達できる */
  | { status: 'unauthenticated' }
  /** セッションはあるがロールが取れない。ロールが決まらない以上どのグループにも入れない */
  | { status: 'profile-unavailable'; retry: () => void }
  /** セッションとロールが揃った */
  | { status: 'authenticated'; userId: UserId; role: Role; displayName: string };
```

- [x] **Step 7: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- src/constants`
Expected: PASS（11 件 = auth 6 + http 2 + api 3）

- [x] **Step 8: わざと壊してテストが落ちることを確認する**

`ROLE_HOME_ROUTES.owner` を `'/home'` に書き換え、「着地ルートはロールごとに重複しない」が**失敗すること**を確認してから元に戻す。
続けて `ROLE_HOME_ROUTES.admin` を `'/(admin)/overview'` に書き換え、「着地ルートにグループ名を含めない」が**失敗すること**を確認してから元に戻す。

- [x] **Step 9: 型チェックと Lint が通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm run typecheck -w @meshimap/mobile && npm run lint -w @meshimap/mobile`
Expected: エラーなし、warning もなし（`ROLE_HOME_ROUTES` の各パスはこの時点ではまだファイルが無いが、`.expo/types` が未生成のうちは `Href` が `string | HrefObject` に解決されるため通る。Task 5-7 でファイルを作ったあと再度確認する）

- [x] **Step 10: カバレッジが 100% のままであることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm run test:coverage -w @meshimap/mobile`
Expected: statements / branches / functions / lines すべて 100%。
**このタスク以降、実装ファイルを追加したステップの直後には必ずこのコマンドを通すこと。**

- [x] **Step 11: コミットする**

```bash
git add apps/mobile/src/constants/auth.ts apps/mobile/src/constants/auth.test.ts apps/mobile/src/constants/api.ts apps/mobile/src/constants/api.test.ts apps/mobile/src/constants/http.ts apps/mobile/src/constants/http.test.ts apps/mobile/src/features/auth/types.ts
git commit -m "feat(mobile): 認証まわりの定数と認証状態の型を追加する"
```

---

### Task 5-2: Better Auth クライアントを SecureStore 永続化つきで作る

**Files:**

- Create: `apps/mobile/src/lib/auth-client.ts`
- Create: `apps/mobile/src/lib/auth-client.test.ts`
- Modify: `apps/mobile/jest.config.js`

**Interfaces:**

- Consumes:
  - `createAuthClient` from `better-auth/react` — `declare function createAuthClient<Option extends BetterAuthClientOptions>(options?: Option | undefined): ReactAuthClient<Option>`（`node_modules/better-auth/dist/client/react/index.d.mts`）
  - `expoClient` from `@better-auth/expo` — `(opts: ExpoClientOptions) => { id: 'expo'; ... }`、`ExpoClientOptions = { scheme?: string | undefined; storage: Pick<typeof SecureStore, 'setItem' | 'setItemAsync' | 'getItem' | 'getItemAsync'>; storagePrefix?: string | undefined; ... }`（`node_modules/@better-auth/expo/dist/client.d.ts`）
  - `BetterAuthClientOptions` の `baseURL?: string | undefined` / `basePath?: string | undefined`（`node_modules/@better-auth/core/dist/types/plugin-client.d.mts:68-76`）
- Produces:
  - `const authClient` — `authClient.useSession()` が `{ data; isPending; isRefetching; error; refetch }` を返す。`authClient.signIn.email(...)` / `authClient.signUp.email(...)` / `authClient.signOut()` / `authClient.requestPasswordReset(...)` / `authClient.getCookie(): Promise<string>`

- [ ] **Step 1: jest.config.js の変換対象に better-auth 系を追加する**

`better-auth` / `@better-auth/core` / `better-call` / `nanostores` はいずれも `package.json` に `"type": "module"` を持ち、エントリが `.mjs`（`better-auth` は `./dist/index.mjs`、`@better-auth/expo` は `"type": "module"` かつ `./dist/index.js`）。現行の `transformIgnorePatterns` はこれらを除外していないため、実体を import したテストが `require(esm)` で落ちる。

`apps/mobile/jest.config.js` の `TRANSPILED_NODE_MODULES` の `'@meshimap',` の**直前**に以下を挿入する。

```js
  // better-auth 系はいずれも package.json に "type": "module" を持ち、
  // エントリが .mjs（better-auth / @better-auth/core / better-call）または
  // ESM の .js（@better-auth/expo）に解決される。変換しないと require(esm) で落ちる。
  // @better-fetch/fetch は exports の require 条件が .cjs を指すので対象外でよい。
  'better-auth',
  '@better-auth',
  'better-call',
  'nanostores',
```

- [ ] **Step 2: 失敗するテストを書く**

`expoClient` の内部実装（チャンク分割・Cookie マージ）は Better Auth 側のテスト対象なので、ここでは**自分たちの配線**だけを検証する。

```ts
// apps/mobile/src/lib/auth-client.test.ts
import { API_BASE_URL } from '@/constants/api';
import { APP_SCHEME, AUTH_BASE_PATH, AUTH_STORAGE_PREFIX } from '@/constants/auth';

const mockCreateAuthClient = jest.fn(() => ({ id: 'auth-client' }));
const mockExpoClient = jest.fn((options: unknown) => ({ id: 'expo', options }));

jest.mock('better-auth/react', () => ({ createAuthClient: mockCreateAuthClient }));
jest.mock('@better-auth/expo', () => ({ expoClient: mockExpoClient }));

/**
 * authClient はモジュールの読み込み時に 1 回だけ生成されるので、
 * 呼び出し引数を検証するにはモジュールを読み直す必要がある。
 * 動的 import() は Jest の CJS 環境（--experimental-vm-modules なし）では
 * `A dynamic import callback was invoked without --experimental-vm-modules` で落ちるため require を使う。
 */
function loadAuthClient(): typeof import('./auth-client') {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./auth-client');
}

describe('authClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('API のベース URL と Better Auth のマウントパスを渡して生成される', () => {
    loadAuthClient();

    expect(mockCreateAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: API_BASE_URL, basePath: AUTH_BASE_PATH }),
    );
  });

  it('expo プラグインに SecureStore の 4 メソッドを渡す', () => {
    loadAuthClient();

    const [options] = mockExpoClient.mock.calls[0] ?? [];
    const storage = (options as { storage: Record<string, unknown> }).storage;

    // Pick<typeof SecureStore, 'setItem' | 'setItemAsync' | 'getItem' | 'getItemAsync'> を満たすこと
    expect(typeof storage.setItem).toBe('function');
    expect(typeof storage.setItemAsync).toBe('function');
    expect(typeof storage.getItem).toBe('function');
    expect(typeof storage.getItemAsync).toBe('function');
  });

  it('expo プラグインに app.json と同じ scheme と専用の保存接頭辞を渡す', () => {
    loadAuthClient();

    expect(mockExpoClient).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: APP_SCHEME, storagePrefix: AUTH_STORAGE_PREFIX }),
    );
  });

  it('expo プラグインが plugins 配列に載っている', () => {
    loadAuthClient();

    const [options] = mockCreateAuthClient.mock.calls[0] ?? [];
    const plugins = (options as { plugins: { id: string }[] }).plugins;

    expect(plugins.map((plugin) => plugin.id)).toContain('expo');
  });
});
```

`mockCreateAuthClient` / `mockExpoClient` が `mock` 始まりなのは必須。`babel-plugin-jest-hoist` は
`jest.mock` の factory から参照できる外部変数を `/^mock/i` にマッチする名前だけに限定している
（`node_modules/babel-plugin-jest-hoist/build/index.js:77`）。

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- auth-client`
Expected: FAIL（`Cannot find module './auth-client'`）

- [ ] **Step 3: `lib/auth-client.ts` を作る**

```ts
// apps/mobile/src/lib/auth-client.ts
import { expoClient } from '@better-auth/expo';
import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';

import { API_BASE_URL } from '@/constants/api';
import { APP_SCHEME, AUTH_BASE_PATH, AUTH_STORAGE_PREFIX } from '@/constants/auth';

/**
 * Better Auth のクライアント。
 *
 * expoClient は Set-Cookie を JSON にまとめて SecureStore に保存し、
 * 以降のリクエストへ cookie ヘッダとして復元する（AsyncStorage ではなく SecureStore なので
 * セッショントークンが端末の Keychain / Keystore に入る）。
 * サインアウト時は `<prefix>_cookie` と `<prefix>_session_data` に "{}" を書き戻して失効させる
 * （node_modules/@better-auth/expo/dist/client.js の clearSessionCache）。
 *
 * 動的パスプロキシで実装されているため、`const { signIn } = authClient` のような
 * 分割代入はしない（プロキシのレシーバが外れる）。必ず `authClient.signIn.email(...)` と書く。
 */
export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  basePath: AUTH_BASE_PATH,
  plugins: [
    expoClient({
      scheme: APP_SCHEME,
      storage: SecureStore,
      storagePrefix: AUTH_STORAGE_PREFIX,
    }),
  ],
});
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- auth-client`
Expected: PASS（4 件）

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`storagePrefix: AUTH_STORAGE_PREFIX` の行を削除し、「app.json と同じ scheme と専用の保存接頭辞を渡す」が**失敗すること**を確認する。
続けて `storage: SecureStore` を `storage: { getItem: () => null, getItemAsync: async () => null, setItem: () => {}, setItemAsync: async () => {} }` のような揮発ストレージに差し替え、テストが**通ってしまう**ことを確認する（= このテストは「SecureStore であること」までは保証していない）。そこで以下の 1 件を追加してから元に戻す。

```ts
it('保存先が expo-secure-store のモジュールそのものである', () => {
  loadAuthClient();
  // loadAuthClient() の中で jest.resetModules() が走るため、先に読むと別インスタンスになる。
  // auth-client が掴んだのと同じ実体を得るには、読み込んだ「あと」に require する
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const secureStore = require('expo-secure-store');

  const [options] = mockExpoClient.mock.calls[0] ?? [];
  expect((options as { storage: unknown }).storage).toBe(secureStore);
});
```

Run: 同上
Expected: PASS（5 件）

- [ ] **Step 6: コミットする**

```bash
git add apps/mobile/src/lib/auth-client.ts apps/mobile/src/lib/auth-client.test.ts apps/mobile/jest.config.js
git commit -m "feat(mobile): SecureStore 永続化つきの Better Auth クライアントを追加する"
```

---

### Task 5-3: Hono RPC の API クライアントを作る（Phase 4 と切り離して進める）

Phase 4（API 基盤）は並行作業中で `@meshimap/api` はまだ `AppType` を export していない（`apps/api/src/routes` は空）。待たずに進めるため、**モバイル側が必要とする最小のスキーマを Hono の `Schema` 形として手書きし、それを `AppType` の暫定実体にする**。Phase 4 が `AppType` を出したら `lib/api-types.ts` を削除して import を差し替えるだけで済む（型の形は Hono が生成するものと同じ `Hono<Env, Schema, BasePath>`）。

**Files:**

- Create: `apps/mobile/src/lib/api-types.ts`
- Create: `apps/mobile/src/lib/api-client.ts`
- Create: `apps/mobile/src/lib/api-client.test.ts`

> `api-types.ts` は型宣言だけで実行文を持たないため、カバレッジ集計上の statements が 0 になり
> 100% 扱いになる（`apps/mobile/coverage/coverage-summary.json` の `features/auth/types.ts` が
> `{"s":100,"b":100,"f":100,"l":100,"st":0}` になっているのと同じ理屈）。専用テストは不要。

**Interfaces:**

- Consumes:
  - `hc` from `hono/client` — `declare const hc: <T extends Hono<any, any, any>, Prefix extends string = string>(baseUrl: Prefix, options?: ClientRequestOptions) => UnionToIntersection<Client<T, Prefix>>`（`node_modules/hono/dist/types/client/client.d.ts`）
  - `ClientRequestOptions` の `headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)`（`node_modules/hono/dist/types/client/types.d.ts`）
  - `type Schema = { [Path: string]: { [Method: \`$${Lowercase<string>}\`]: Endpoint } }`/`type Endpoint = { input: any; output: any; outputFormat: ResponseFormat; status: StatusCode }`/`type BlankEnv = {}`（`node_modules/hono/dist/types/types.d.ts:477-488, :12`）
  - `authClient.getCookie(): Promise<string>`（Task 5-2）
  - `type Role`, `type UserId` from `@meshimap/core`
- Produces:
  - `type MeResponseBody = { user: { id: string; email: string; name: string; isEmailVerified: boolean }; profile: { userId: string; role: Role; displayName: string; avatarKey: string | null; status: 'active' | 'suspended' } }`
  - `type AppType = Hono<BlankEnv, MobileApiSchema, '/'>`（暫定。Phase 4 完了後は `@meshimap/api` から import）
  - `const apiClient` — `apiClient.api.me.$get()` が `Response` を返す

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/mobile/src/lib/api-client.test.ts
import { buildAuthHeaders } from './api-client';

const mockGetCookie = jest.fn<Promise<string>, []>();

jest.mock('./auth-client', () => ({ authClient: { getCookie: mockGetCookie } }));

describe('apiClient のヘッダ供給', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('保存済み Cookie があれば cookie ヘッダとして載せる', async () => {
    mockGetCookie.mockResolvedValue('meshimap-auth.session_token=abc');

    await expect(buildAuthHeaders()).resolves.toEqual({
      cookie: 'meshimap-auth.session_token=abc',
    });
  });

  it('Cookie が空文字なら cookie ヘッダを載せない', async () => {
    // 未ログイン時 getCookie は '' を返す（@better-auth/expo の getCookie 実装）。
    // 空の cookie ヘッダを送ると一部のプロキシが 400 を返すため落とす
    mockGetCookie.mockResolvedValue('');

    await expect(buildAuthHeaders()).resolves.toEqual({});
  });

  it('Cookie の取得に失敗してもヘッダ生成は落ちない', async () => {
    // ここで例外を投げると全リクエストが死ぬ。未認証扱いで続行する
    mockGetCookie.mockRejectedValue(new Error('secure store unavailable'));

    await expect(buildAuthHeaders()).resolves.toEqual({});
  });
});
```

`buildAuthHeaders` は呼び出しのたびに `authClient.getCookie()` を読むので、モジュールを読み直す
必要はない。`jest.mock` は `babel-plugin-jest-hoist` によって import より前に巻き上げられるため、
静的 import のままモックが効く。**ここで `await import('./api-client')` を使ってはいけない**
（Jest の CJS 環境では `A dynamic import callback was invoked without --experimental-vm-modules` になる）。

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- api-client`
Expected: FAIL（`Cannot find module './api-client'`）

- [ ] **Step 2: `lib/api-types.ts` を作る**

```ts
// apps/mobile/src/lib/api-types.ts
import type { Role } from '@meshimap/core';
import type { Hono } from 'hono';
import type { BlankEnv } from 'hono/types';

/**
 * Phase 4（API 基盤）が `@meshimap/api` から `AppType` を export するまでの暫定宣言。
 *
 * Hono の RPC は `Hono<Env, Schema, BasePath>` の Schema 部分だけを見るので、
 * モバイルが実際に叩くエンドポイントを手書きしておけば、実サーバの型が出たときに
 * 「このファイルを消して import を差し替える」だけで移行できる。
 * 形がズレていれば差し替えた瞬間に型エラーで気づける（黙って壊れない）。
 *
 * TODO(Phase 4): apps/api が AppType を export したらこのファイルを削除し、
 * api-client.ts の import を `import type { AppType } from '@meshimap/api'` に差し替える。
 */

/** `GET /api/me` のレスポンス。設計書 §6 の profiles テーブルと Better Auth の user テーブルの合成 */
export interface MeResponseBody {
  user: {
    id: string;
    email: string;
    name: string;
    isEmailVerified: boolean;
  };
  profile: {
    userId: string;
    role: Role;
    displayName: string;
    avatarKey: string | null;
    status: 'active' | 'suspended';
  };
}

/**
 * Hono の Schema 形。interface ではなく type alias にすること。
 * interface は暗黙のインデックスシグネチャを持たないため `S extends Schema` を満たせない。
 */
type MobileApiSchema = {
  '/api/me': {
    $get: {
      input: Record<string, never>;
      output: MeResponseBody;
      outputFormat: 'json';
      status: 200;
    };
  };
};

export type AppType = Hono<BlankEnv, MobileApiSchema, '/'>;
```

- [ ] **Step 3: `lib/api-client.ts` を作る**

```ts
// apps/mobile/src/lib/api-client.ts
import { hc } from 'hono/client';

import { API_BASE_URL } from '@/constants/api';
import type { AppType } from '@/lib/api-types';
import { authClient } from '@/lib/auth-client';
import { logger } from '@/lib/logger';

/**
 * Better Auth が SecureStore に保存した Cookie を、業務 API のリクエストにも載せる。
 * @better-auth/expo は `/api/auth/*` のリクエストにしか Cookie を復元しないため、
 * 業務 API 側はこちらで明示的に付ける必要がある
 * （node_modules/@better-auth/expo/dist/client.js の getActions().getCookie の用例どおり）。
 */
export async function buildAuthHeaders(): Promise<Record<string, string>> {
  try {
    const cookie = await authClient.getCookie();
    if (cookie === '') {
      return {};
    }
    return { cookie };
  } catch (error) {
    // ここで投げると全リクエストが道連れになる。未認証として続行し、401 はサーバに判定させる
    logger.warn('保存済み Cookie の読み出しに失敗したため未認証としてリクエストする', { error });
    return {};
  }
}

export const apiClient = hc<AppType>(API_BASE_URL, { headers: buildAuthHeaders });
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- api-client`
Expected: PASS（3 件）

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`buildAuthHeaders` の `try` / `catch` を外し、「Cookie の取得に失敗してもヘッダ生成は落ちない」が**失敗すること**を確認する。
続けて `if (cookie === '')` の分岐を削除し、「Cookie が空文字なら cookie ヘッダを載せない」が**失敗すること**を確認してから元に戻す。

- [ ] **Step 6: 型チェックが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm run typecheck -w @meshimap/mobile`
Expected: エラーなし（`apiClient.api.me.$get` が補完できる状態）

- [ ] **Step 7: コミットする**

```bash
git add apps/mobile/src/lib/api-types.ts apps/mobile/src/lib/api-client.ts apps/mobile/src/lib/api-client.test.ts
git commit -m "feat(mobile): Hono RPC の API クライアントを追加する"
```

---

### Task 5-4: 認証エラーの日本語化と features/auth の API ラッパーを作る

**Files:**

- Create: `apps/mobile/src/features/auth/auth-error.ts`
- Create: `apps/mobile/src/features/auth/auth-error.test.ts`
- Create: `apps/mobile/src/features/auth/schema.ts`
- Create: `apps/mobile/src/features/auth/schema.test.ts`
- Create: `apps/mobile/src/features/auth/api.ts`
- Create: `apps/mobile/src/features/auth/api.test.ts`

**Interfaces:**

- Consumes:
  - `authClient.signIn.email(body)` — body: `{ email: string; password: string; callbackURL?: string; rememberMe?: boolean }`（`node_modules/better-auth/dist/api/index.d.mts:514`）
  - `authClient.signUp.email(body)` — body: `{ name: string; email: string; password: string; image?: string; callbackURL?: string; rememberMe?: boolean }`（同 :339）
  - `authClient.requestPasswordReset(body)` — body: `{ email: string; redirectTo?: string }`（同 :1269）
  - `authClient.signOut()`（同 :294）
  - レスポンスは `{ data: T; error: null } | { data: null; error: { message?: string } & { status: number; statusText: string } }`
  - `apiClient.api.me.$get()`（Task 5-3）
- Produces:
  - `const signInSchema` / `const signUpSchema` / `const passwordResetRequestSchema`（**モバイル側で定義する**。`@meshimap/core` に認証系スキーマは存在しない）
  - `type SignInInput = { email: string; password: string }`、`type SignUpInput = { displayName: string; email: string; password: string }`、`type PasswordResetRequestInput = { email: string }`
  - `const PASSWORD_MIN_LENGTH: 8`、`const PASSWORD_MAX_LENGTH: 128`、`const DISPLAY_NAME_MAX_LENGTH: 50`
  - `class AuthError extends Error { readonly kind: AuthErrorKind }`
  - `type AuthErrorKind = 'invalid-credentials' | 'email-already-used' | 'rate-limited' | 'network' | 'unknown'`
  - `function toAuthError(error: { status: number; message?: string | undefined } | null): AuthError`
  - `async function signInWithEmail(input: SignInInput): Promise<void>`
  - `async function signUpWithEmail(input: SignUpInput): Promise<void>`
  - `async function requestPasswordReset(input: PasswordResetRequestInput): Promise<void>`
  - `async function signOutFromApp(): Promise<void>`
  - `async function fetchMyProfile(): Promise<MeResponseBody>`

- [ ] **Step 1: 失敗するテストを書く（auth-error）**

```ts
// apps/mobile/src/features/auth/auth-error.test.ts
import { HTTP_STATUS } from '@/constants/http';

import { AUTH_ERROR_MESSAGES, AuthError, toAuthError } from './auth-error';

describe('toAuthError', () => {
  it('401 は資格情報の誤りとして扱う', () => {
    const error = toAuthError({ status: HTTP_STATUS.unauthorized });

    expect(error.kind).toBe('invalid-credentials');
    expect(error.message).toBe(AUTH_ERROR_MESSAGES['invalid-credentials']);
  });

  it('409 はメールアドレスの重複として扱う', () => {
    expect(toAuthError({ status: HTTP_STATUS.conflict }).kind).toBe('email-already-used');
  });

  it('429 はレート制限として扱う', () => {
    expect(toAuthError({ status: HTTP_STATUS.tooManyRequests }).kind).toBe('rate-limited');
  });

  it('status 0 は通信到達不能として扱う（境界値）', () => {
    // better-fetch はネットワーク到達不能時に status 0 を返す
    expect(toAuthError({ status: 0 }).kind).toBe('network');
  });

  it('error が null なら unknown になる', () => {
    expect(toAuthError(null).kind).toBe('unknown');
  });

  it('未知の status は unknown になり、サーバ文言をそのまま画面に出さない', () => {
    const error = toAuthError({ status: 500, message: 'D1_ERROR: no such table: profiles' });

    expect(error.kind).toBe('unknown');
    // 内部情報の露出を防ぐため、サーバのメッセージは message に混ぜない
    expect(error.message).toBe(AUTH_ERROR_MESSAGES.unknown);
  });

  it('AuthError は Error のサブクラスである', () => {
    expect(toAuthError(null)).toBeInstanceOf(Error);
    expect(toAuthError(null)).toBeInstanceOf(AuthError);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- auth-error`
Expected: FAIL（`Cannot find module './auth-error'`）

- [ ] **Step 2: `features/auth/auth-error.ts` を作る**

```ts
// apps/mobile/src/features/auth/auth-error.ts
import { HTTP_STATUS } from '@/constants/http';

export type AuthErrorKind =
  'invalid-credentials' | 'email-already-used' | 'rate-limited' | 'network' | 'unknown';

/** ネットワーク到達不能時に better-fetch が返すステータス */
const NETWORK_UNREACHABLE_STATUS = 0;

export const AUTH_ERROR_MESSAGES: Record<AuthErrorKind, string> = {
  'invalid-credentials': 'メールアドレスまたはパスワードが正しくありません。',
  'email-already-used': 'このメールアドレスは既に登録されています。',
  'rate-limited': '試行回数が上限に達しました。しばらく待ってからお試しください。',
  network: '通信に失敗しました。電波状況を確認してもう一度お試しください。',
  unknown: '予期しないエラーが発生しました。時間をおいてお試しください。',
};

export class AuthError extends Error {
  readonly kind: AuthErrorKind;

  constructor(kind: AuthErrorKind) {
    super(AUTH_ERROR_MESSAGES[kind]);
    this.kind = kind;
    this.name = 'AuthError';
  }
}

/**
 * Better Auth のエラーを画面に出せる日本語へ変換する。
 * サーバ由来の message は D1 のテーブル名などが混じりうるので画面には出さず、
 * status からアプリ側で文言を決める（ログには logger 経由で残す）。
 */
export function toAuthError(
  error: { status: number; message?: string | undefined } | null,
): AuthError {
  if (error === null) {
    return new AuthError('unknown');
  }

  switch (error.status) {
    case HTTP_STATUS.unauthorized:
    case HTTP_STATUS.forbidden:
      return new AuthError('invalid-credentials');
    case HTTP_STATUS.conflict:
      return new AuthError('email-already-used');
    case HTTP_STATUS.tooManyRequests:
      return new AuthError('rate-limited');
    case NETWORK_UNREACHABLE_STATUS:
      return new AuthError('network');
    default:
      return new AuthError('unknown');
  }
}
```

- [ ] **Step 3: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- auth-error`
Expected: PASS（7 件）

- [ ] **Step 4: わざと壊してテストが落ちることを確認する**

`default:` の `new AuthError('unknown')` を `new AuthError(error.message === undefined ? 'unknown' : 'invalid-credentials')` に書き換え、「未知の status は unknown になり、サーバ文言をそのまま画面に出さない」が**失敗すること**を確認してから元に戻す。

- [ ] **Step 5: 入力スキーマ `features/auth/schema.ts` と `schema.test.ts` を作る**

`@meshimap/core` に認証系のスキーマは**無い**。`packages/core/src/index.ts` が export するスキーマは
`roleSchema` / `identifierSchema` / `shopCreateSchema` / `shopUpdateSchema` / `reviewCreateSchema` /
`reservationCreateSchema` などで、`grep -rn "signIn\|signUp\|passwordReset" packages/core/src` は 0 件。
しかも `packages/core/src/index.test.ts` が公開 export 名の一覧を完全一致で固定しているため、
core に足すと core 本体とそのテストの両方を書き換えることになる。
認証フォームの入力形はモバイル固有なので**モバイル側に置く**。

```ts
// apps/mobile/src/features/auth/schema.ts
import { z } from 'zod';

/**
 * Better Auth のサーバ側既定値に合わせる
 * （node_modules/better-auth/dist/context/create-context.mjs:186-187 の
 * `minPasswordLength: options.emailAndPassword?.minPasswordLength || 8` /
 * `maxPasswordLength: ... || 128`）。
 * クライアントがサーバより緩いと、通ると思った入力が 400 で戻ってきて原因を追いにくい。
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Better Auth の user.name にそのまま入る。長すぎる表示名は一覧のレイアウトを壊す */
export const DISPLAY_NAME_MAX_LENGTH = 50;

const EMAIL_INVALID_MESSAGE = 'メールアドレスの形式が正しくありません。';
const PASSWORD_REQUIRED_MESSAGE = 'パスワードを入力してください。';
const PASSWORD_MIN_MESSAGE = `パスワードは ${PASSWORD_MIN_LENGTH} 文字以上で入力してください。`;
const PASSWORD_MAX_MESSAGE = `パスワードは ${PASSWORD_MAX_LENGTH} 文字以内で入力してください。`;
const DISPLAY_NAME_REQUIRED_MESSAGE = '表示名を入力してください。';
const DISPLAY_NAME_MAX_MESSAGE = `表示名は ${DISPLAY_NAME_MAX_LENGTH} 文字以内で入力してください。`;

/**
 * サインインはサーバに保存済みのパスワードを送るだけなので、長さの下限は課さない。
 * ここで 8 文字を要求すると、規則を変える前に登録した利用者がログインできなくなる。
 */
export const signInSchema = z.object({
  email: z.email({ error: EMAIL_INVALID_MESSAGE }),
  password: z.string().min(1, { error: PASSWORD_REQUIRED_MESSAGE }),
});

/** 新規登録はこれから保存する値なので、サーバと同じ長さ制約をここで課す */
export const signUpSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, { error: DISPLAY_NAME_REQUIRED_MESSAGE })
    .max(DISPLAY_NAME_MAX_LENGTH, { error: DISPLAY_NAME_MAX_MESSAGE }),
  email: z.email({ error: EMAIL_INVALID_MESSAGE }),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, { error: PASSWORD_MIN_MESSAGE })
    .max(PASSWORD_MAX_LENGTH, { error: PASSWORD_MAX_MESSAGE }),
});

export const passwordResetRequestSchema = z.object({
  email: z.email({ error: EMAIL_INVALID_MESSAGE }),
});

/**
 * 3 つとも `transform` / `default` を持たないので `z.input` と `z.output` が一致する。
 * `zodResolver` は `Resolver<z4.input<T>, Context, z4.output<T>>` を返すため
 * （`node_modules/@hookform/resolvers/zod/dist/zod.d.ts`）、ここがズレると
 * `useForm<SignInInput>` に代入できなくなる。スキーマを触るときはこの条件を壊さないこと。
 * （`.trim()` は値を変えるが TypeScript の型は string のままなので条件を壊さない）
 */
export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
export type PasswordResetRequestInput = z.infer<typeof passwordResetRequestSchema>;
```

```ts
// apps/mobile/src/features/auth/schema.test.ts
import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordResetRequestSchema,
  signInSchema,
  signUpSchema,
} from './schema';

const VALID_EMAIL = 'taro@example.com';
const VALID_PASSWORD = 'Passw0rd!';

describe('signInSchema', () => {
  it('メールアドレスとパスワードが揃っていれば通る', () => {
    expect(signInSchema.safeParse({ email: VALID_EMAIL, password: VALID_PASSWORD }).success).toBe(
      true,
    );
  });

  it('空文字は弾く（送信ボタンから API を呼ばせないため）', () => {
    expect(signInSchema.safeParse({ email: '', password: '' }).success).toBe(false);
  });

  it('メールアドレスの形式が不正なら弾く', () => {
    expect(signInSchema.safeParse({ email: 'taro', password: VALID_PASSWORD }).success).toBe(false);
  });

  it('既存利用者を締め出さないよう、パスワードの長さは検証しない', () => {
    expect(signInSchema.safeParse({ email: VALID_EMAIL, password: 'a' }).success).toBe(true);
  });
});

describe('signUpSchema', () => {
  const validInput = { displayName: '山田太郎', email: VALID_EMAIL, password: VALID_PASSWORD };

  it('表示名・メール・パスワードが揃っていれば通る', () => {
    expect(signUpSchema.safeParse(validInput).success).toBe(true);
  });

  it('表示名の前後の空白は落とす', () => {
    const result = signUpSchema.safeParse({ ...validInput, displayName: '  山田太郎  ' });

    expect(result.success && result.data.displayName).toBe('山田太郎');
  });

  it('空白だけの表示名は弾く', () => {
    expect(signUpSchema.safeParse({ ...validInput, displayName: '   ' }).success).toBe(false);
  });

  it('表示名は上限ちょうどなら通り、1 文字超過は弾く（境界値）', () => {
    const atMax = 'あ'.repeat(DISPLAY_NAME_MAX_LENGTH);

    expect(signUpSchema.safeParse({ ...validInput, displayName: atMax }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...validInput, displayName: `${atMax}あ` }).success).toBe(
      false,
    );
  });

  it('パスワードは下限ちょうどなら通り、1 文字不足は弾く（境界値）', () => {
    const atMin = 'a'.repeat(PASSWORD_MIN_LENGTH);

    expect(signUpSchema.safeParse({ ...validInput, password: atMin }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...validInput, password: atMin.slice(1) }).success).toBe(false);
  });

  it('パスワードは上限ちょうどなら通り、1 文字超過は弾く（境界値）', () => {
    // サーバ既定の maxPasswordLength: 128 と一致させる。緩めるとサーバで 400 になる
    const atMax = 'a'.repeat(PASSWORD_MAX_LENGTH);

    expect(signUpSchema.safeParse({ ...validInput, password: atMax }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...validInput, password: `${atMax}a` }).success).toBe(false);
  });
});

describe('passwordResetRequestSchema', () => {
  it('メールアドレスだけで通る', () => {
    expect(passwordResetRequestSchema.safeParse({ email: VALID_EMAIL }).success).toBe(true);
  });

  it('形式が不正なら弾く', () => {
    expect(passwordResetRequestSchema.safeParse({ email: 'taro' }).success).toBe(false);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- features/auth/schema`
Expected: PASS（12 件）

- [ ] **Step 6: 失敗するテストを書く（api）**

```ts
// apps/mobile/src/features/auth/api.test.ts
import { HTTP_STATUS } from '@/constants/http';

const mockSignInEmail = jest.fn();
const mockSignUpEmail = jest.fn();
const mockRequestPasswordReset = jest.fn();
const mockSignOut = jest.fn();
const mockMeGet = jest.fn();

jest.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: { email: mockSignInEmail },
    signUp: { email: mockSignUpEmail },
    requestPasswordReset: mockRequestPasswordReset,
    signOut: mockSignOut,
  },
}));
jest.mock('@/lib/api-client', () => ({ apiClient: { api: { me: { $get: mockMeGet } } } }));

import { AUTH_ERROR_MESSAGES } from './auth-error';
import { fetchMyProfile, signInWithEmail, signOutFromApp, signUpWithEmail } from './api';

const VALID_SIGN_IN = { email: 'taro@example.com', password: 'Passw0rd!' };

describe('signInWithEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('成功したら例外を投げない', async () => {
    mockSignInEmail.mockResolvedValue({ data: { user: { id: 'usr_1' } }, error: null });

    await expect(signInWithEmail(VALID_SIGN_IN)).resolves.toBeUndefined();
    expect(mockSignInEmail).toHaveBeenCalledWith({
      email: VALID_SIGN_IN.email,
      password: VALID_SIGN_IN.password,
    });
  });

  it('401 のときは資格情報エラーの日本語メッセージで投げる', async () => {
    mockSignInEmail.mockResolvedValue({
      data: null,
      error: { status: HTTP_STATUS.unauthorized, statusText: 'Unauthorized' },
    });

    await expect(signInWithEmail(VALID_SIGN_IN)).rejects.toThrow(
      AUTH_ERROR_MESSAGES['invalid-credentials'],
    );
  });

  it('パスワードをログに残さない', async () => {
    mockSignInEmail.mockResolvedValue({
      data: null,
      error: { status: HTTP_STATUS.unauthorized, statusText: 'Unauthorized' },
    });

    await expect(signInWithEmail(VALID_SIGN_IN)).rejects.toThrow();

    const loggedText = JSON.stringify(mockSignInEmail.mock.calls);
    // 引数に渡すのは当然なので、ここで見るのは「投げた例外にパスワードが載っていないこと」
    await signInWithEmail(VALID_SIGN_IN).catch((error: unknown) => {
      expect(JSON.stringify(error instanceof Error ? error.message : '')).not.toContain(
        VALID_SIGN_IN.password,
      );
    });
    expect(loggedText).toContain(VALID_SIGN_IN.email);
  });
});

describe('signUpWithEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('displayName を Better Auth の name として送る', async () => {
    mockSignUpEmail.mockResolvedValue({ data: { user: { id: 'usr_1' } }, error: null });

    await signUpWithEmail({
      displayName: '山田太郎',
      email: 'taro@example.com',
      password: 'Passw0rd!',
    });

    expect(mockSignUpEmail).toHaveBeenCalledWith({
      name: '山田太郎',
      email: 'taro@example.com',
      password: 'Passw0rd!',
    });
  });

  it('409 のときは重複エラーになる', async () => {
    mockSignUpEmail.mockResolvedValue({
      data: null,
      error: { status: HTTP_STATUS.conflict, statusText: 'Conflict' },
    });

    await expect(
      signUpWithEmail({
        displayName: '山田太郎',
        email: 'taro@example.com',
        password: 'Passw0rd!',
      }),
    ).rejects.toThrow(AUTH_ERROR_MESSAGES['email-already-used']);
  });
});

describe('signOutFromApp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('Better Auth の signOut を呼ぶ', async () => {
    mockSignOut.mockResolvedValue({ data: { success: true }, error: null });

    await expect(signOutFromApp()).resolves.toBeUndefined();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('サーバがエラーを返しても例外にしない', async () => {
    // サインアウトの本質は端末側の資格情報破棄。サーバ応答で失敗扱いにすると
    // 「ログアウトできないまま画面に留まる」という最悪の状態になる
    mockSignOut.mockResolvedValue({
      data: null,
      error: { status: 500, statusText: 'Internal Server Error' },
    });

    await expect(signOutFromApp()).resolves.toBeUndefined();
  });
});

describe('fetchMyProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('200 ならレスポンス本文を返す', async () => {
    const body = {
      user: { id: 'usr_1', email: 'taro@example.com', name: '山田太郎', isEmailVerified: true },
      profile: {
        userId: 'usr_1',
        role: 'owner',
        displayName: '山田太郎',
        avatarKey: null,
        status: 'active',
      },
    };
    mockMeGet.mockResolvedValue({ ok: true, status: 200, json: async () => body });

    await expect(fetchMyProfile()).resolves.toEqual(body);
  });

  it('401 なら例外を投げる（呼び出し側が未認証に落とせるように）', async () => {
    mockMeGet.mockResolvedValue({
      ok: false,
      status: HTTP_STATUS.unauthorized,
      json: async () => ({}),
    });

    await expect(fetchMyProfile()).rejects.toThrow(AUTH_ERROR_MESSAGES['invalid-credentials']);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- features/auth/api`
Expected: FAIL（`Cannot find module './api'`）

- [ ] **Step 7: `features/auth/api.ts` を作る**

```ts
// apps/mobile/src/features/auth/api.ts
import { toAuthError } from '@/features/auth/auth-error';
import type { PasswordResetRequestInput, SignInInput, SignUpInput } from '@/features/auth/schema';
import { apiClient } from '@/lib/api-client';
import type { MeResponseBody } from '@/lib/api-types';
import { authClient } from '@/lib/auth-client';
import { logger } from '@/lib/logger';

/** Better Auth のレスポンス形。data か error のどちらかが必ず入る */
interface BetterAuthResult<TData> {
  data: TData | null;
  error: ({ message?: string | undefined } & { status: number; statusText: string }) | null;
}

/** エラーなら日本語メッセージの AuthError にして投げ直す。成功なら何も返さない */
function throwIfFailed(result: BetterAuthResult<unknown>, operation: string): void {
  if (result.error === null) {
    return;
  }

  // 原因調査のためにサーバ文言はログにだけ残す（画面には出さない）
  logger.warn('認証操作に失敗した', {
    operation,
    status: result.error.status,
    statusText: result.error.statusText,
  });
  throw toAuthError(result.error);
}

export async function signInWithEmail(input: SignInInput): Promise<void> {
  const result = await authClient.signIn.email({ email: input.email, password: input.password });
  throwIfFailed(result, 'signIn.email');
}

export async function signUpWithEmail(input: SignUpInput): Promise<void> {
  // Better Auth の user テーブルは name 列を持つ。表示名はそこへ入れる
  const result = await authClient.signUp.email({
    name: input.displayName,
    email: input.email,
    password: input.password,
  });
  throwIfFailed(result, 'signUp.email');
}

export async function requestPasswordReset(input: PasswordResetRequestInput): Promise<void> {
  // 1.7.5 の core に forgetPassword は無く、エンドポイントは /request-password-reset
  const result = await authClient.requestPasswordReset({ email: input.email });
  throwIfFailed(result, 'requestPasswordReset');
}

export async function signOutFromApp(): Promise<void> {
  const result = await authClient.signOut();

  // サインアウトの本体は端末側の資格情報破棄で、それは @better-auth/expo の
  // fetchPlugins.init が /sign-out のリクエスト時点で clearSessionCache() を呼んで済ませている。
  // サーバ応答の失敗で例外にすると「ログアウトできない」体験になるのでログだけ残す
  if (result.error !== null) {
    logger.warn('サインアウトのサーバ応答が失敗した（端末側の資格情報は破棄済み）', {
      status: result.error.status,
    });
  }
}

export async function fetchMyProfile(): Promise<MeResponseBody> {
  const response = await apiClient.api.me.$get();

  if (!response.ok) {
    logger.warn('プロフィールの取得に失敗した', { status: response.status });
    throw toAuthError({ status: response.status });
  }

  return response.json();
}
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- features/auth/api`
Expected: PASS（9 件）

- [ ] **Step 9: わざと壊してテストが落ちることを確認する**

`signOutFromApp` の `if (result.error !== null) { logger.warn(...) }` を `throwIfFailed(result, 'signOut')` に書き換え、「サーバがエラーを返しても例外にしない」が**失敗すること**を確認してから元に戻す。
続けて `signUpWithEmail` の `name: input.displayName` を `name: input.email` に書き換え、「displayName を Better Auth の name として送る」が**失敗すること**を確認してから元に戻す。

- [ ] **Step 10: コミットする**

```bash
git add apps/mobile/src/features/auth/auth-error.ts apps/mobile/src/features/auth/auth-error.test.ts apps/mobile/src/features/auth/schema.ts apps/mobile/src/features/auth/schema.test.ts apps/mobile/src/features/auth/api.ts apps/mobile/src/features/auth/api.test.ts
git commit -m "feat(mobile): 認証 API ラッパーとエラーの日本語化を追加する"
```

---

### Task 5-5: 認証状態コンテキストを作る（復元中を表現できる 4 状態）

**なぜ Context か（Zustand / TanStack Query との比較）**

| 候補                | 判断                                                                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zustand             | **採用しない。** セッションの実体は Better Auth 内部の nanostores 由来アトムが持っており（`node_modules/better-auth/dist/client/react/index.mjs` が `useStore` でアトムを購読する）、Zustand に写すと真実の出所が 2 つになる。ロール変更・トークン失効の同期を自前で書く羽目になり、ズレたときに気づけない |
| TanStack Query 単体 | **部分採用。** `profiles.role` はサーバ状態なので Query で取るのが正しい。ただしセッション自体は Query が管理していないため、Query だけでは「復元中」を表現できない                                                                                                                                        |
| React Context       | **採用。** Better Auth の `useSession()`（セッション）と TanStack Query（ロール）という**出所の違う 2 つ**を 1 つの判別共用体に畳んで配る役に徹する。自前の状態は持たないので同期ズレが起きない                                                                                                            |

**Files:**

- Create: `apps/mobile/src/lib/query-client.ts`
- Create: `apps/mobile/src/lib/query-client.test.ts`
- Create: `apps/mobile/src/features/auth/auth-context.tsx`
- Create: `apps/mobile/src/features/auth/auth-context.test.tsx`

> `query-client.ts` は `auth-context.test.tsx` から `createQueryClient()` を呼ぶので
> カバレッジ上は 100% になるが、他テスト頼みの 100% は auth-context のテストを書き換えた
> 瞬間に崩れる。既定値そのものを固定する専用テストを同じステップで置く。

**Interfaces:**

- Consumes:
  - `authClient.useSession(): { data: { user: { id: string; name: string; email: string } } | null; isPending: boolean; isRefetching: boolean; error: BetterFetchError | null; refetch: (...) => Promise<void> }`（`node_modules/better-auth/dist/client/react/index.d.mts`）
  - `fetchMyProfile(): Promise<MeResponseBody>`（Task 5-4）
  - `PROFILE_QUERY_KEY` / `PROFILE_QUERY_RETRY_COUNT` / `PROFILE_QUERY_STALE_TIME_MS`（Task 5-1）
  - `type AuthState`（Task 5-1）
  - `type UserId` from `@meshimap/core`
- Produces:
  - `function AuthProvider({ children }: { children: ReactNode }): ReactElement`
  - `function useAuth(): AuthState`
  - `const queryClient: QueryClient`
  - `function createQueryClient(): QueryClient`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/features/auth/auth-context.test.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { createQueryClient } from '@/lib/query-client';

const mockUseSession = jest.fn();
const mockFetchMyProfile = jest.fn();

jest.mock('@/lib/auth-client', () => ({ authClient: { useSession: mockUseSession } }));
jest.mock('./api', () => ({ fetchMyProfile: mockFetchMyProfile }));

import { AuthProvider, useAuth } from './auth-context';

const PROFILE_OF_OWNER = {
  user: { id: 'usr_1', email: 'taro@example.com', name: '山田太郎', isEmailVerified: true },
  profile: {
    userId: 'usr_1',
    role: 'owner',
    displayName: '山田太郎',
    avatarKey: null,
    status: 'active',
  },
};

function AuthStateProbe() {
  const authState = useAuth();

  return (
    <>
      <Text testID="status">{authState.status}</Text>
      <Text testID="role">{authState.status === 'authenticated' ? authState.role : '-'}</Text>
    </>
  );
}

/** RNTL 14 の render は Promise を返す。await を忘れると screen が空のままになる */
function renderProbe() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AuthProvider>
        <AuthStateProbe />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('useAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('セッション復元中は restoring になる', async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: true, error: null });
    await renderProbe();

    expect(screen.getByTestId('status')).toHaveTextContent('restoring');
  });

  it('セッションが無ければ unauthenticated になる', async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: false, error: null });
    await renderProbe();

    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
  });

  it('セッションはあるがロール取得中はまだ restoring のまま（ログイン画面を出さないため）', async () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: 'usr_1' } },
      isPending: false,
      error: null,
    });
    mockFetchMyProfile.mockReturnValue(new Promise(() => undefined));
    await renderProbe();

    expect(screen.getByTestId('status')).toHaveTextContent('restoring');
  });

  it('セッションとロールが揃ったら authenticated になりロールを公開する', async () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: 'usr_1' } },
      isPending: false,
      error: null,
    });
    mockFetchMyProfile.mockResolvedValue(PROFILE_OF_OWNER);
    await renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });
    expect(screen.getByTestId('role')).toHaveTextContent('owner');
  });

  it('ロール取得に失敗したら profile-unavailable になる（unauthenticated に落とさない）', async () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: 'usr_1' } },
      isPending: false,
      error: null,
    });
    mockFetchMyProfile.mockRejectedValue(new Error('offline'));
    await renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('profile-unavailable');
    });
  });

  it('Provider の外で useAuth を呼ぶと例外を投げる', async () => {
    // render が Promise を返すので、throw は reject として観測する
    await expect(render(<AuthStateProbe />)).rejects.toThrow(
      'useAuth は <AuthProvider> の内側で呼ぶこと',
    );
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- auth-context`
Expected: FAIL（`Cannot find module '@/lib/query-client'`）

- [ ] **Step 2: `lib/query-client.ts` を作る**

```ts
// apps/mobile/src/lib/query-client.ts
import { QueryClient } from '@tanstack/react-query';

import { PROFILE_QUERY_RETRY_COUNT, PROFILE_QUERY_STALE_TIME_MS } from '@/constants/auth';

/**
 * QueryClient を毎回新しく作る。テストごとにキャッシュを分離するために関数で公開する
 * （モジュール単位の共有インスタンスだけだとテスト間でキャッシュが漏れる）。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: PROFILE_QUERY_RETRY_COUNT,
        staleTime: PROFILE_QUERY_STALE_TIME_MS,
      },
    },
  });
}

/** アプリ実行時に使う単一インスタンス */
export const queryClient = createQueryClient();
```

```ts
// apps/mobile/src/lib/query-client.test.ts
import { PROFILE_QUERY_RETRY_COUNT, PROFILE_QUERY_STALE_TIME_MS } from '@/constants/auth';

import { createQueryClient, queryClient } from './query-client';

describe('createQueryClient', () => {
  it('クエリの既定値に constants/auth.ts の設定を反映する', () => {
    const { queries } = createQueryClient().getDefaultOptions();

    expect(queries?.retry).toBe(PROFILE_QUERY_RETRY_COUNT);
    expect(queries?.staleTime).toBe(PROFILE_QUERY_STALE_TIME_MS);
  });

  it('呼ぶたびに別インスタンスを返す（テスト間でキャッシュを共有しないため）', () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });

  it('アプリ実行時の単一インスタンスも同じ既定値を持つ', () => {
    expect(queryClient.getDefaultOptions().queries?.staleTime).toBe(PROFILE_QUERY_STALE_TIME_MS);
  });
});
```

`getDefaultOptions(): DefaultOptions` は `QueryClient` の公開メソッド
（`node_modules/@tanstack/query-core/build/modern/hydration-Bjs0MSgg.d.ts:502`）。

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- query-client`
Expected: PASS（3 件）

- [ ] **Step 3: `features/auth/auth-context.tsx` を作る**

```tsx
// apps/mobile/src/features/auth/auth-context.tsx
import type { UserId } from '@meshimap/core';
import { useQuery } from '@tanstack/react-query';
import { createContext, use, useCallback, useMemo, type ReactElement, type ReactNode } from 'react';

import { PROFILE_QUERY_KEY } from '@/constants/auth';
import { fetchMyProfile } from '@/features/auth/api';
import type { AuthState } from '@/features/auth/types';
import { authClient } from '@/lib/auth-client';

const AuthContext = createContext<AuthState | null>(null);

/**
 * セッション（Better Auth）とロール（サーバのプロフィール）という出所の違う 2 つを
 * 1 つの判別共用体に畳んで配る。
 * どちらかが「まだ分からない」間は restoring のままにするのが要点で、
 * ここで unauthenticated に落とすと起動直後にログイン画面がちらつく。
 */
export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const session = authClient.useSession();
  const userId: string | undefined = session.data?.user.id;

  const profileQuery = useQuery({
    // ユーザが切り替わったらキャッシュも切り替わるよう id をキーに含める
    queryKey: [...PROFILE_QUERY_KEY, userId ?? null],
    queryFn: fetchMyProfile,
    enabled: userId !== undefined,
  });

  const { refetch } = profileQuery;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const authState = useMemo<AuthState>(() => {
    if (session.isPending) {
      return { status: 'restoring' };
    }
    if (userId === undefined) {
      return { status: 'unauthenticated' };
    }
    if (profileQuery.isPending) {
      return { status: 'restoring' };
    }
    if (profileQuery.data === undefined) {
      // セッションは生きているのでログイン画面には戻さない。再試行だけを提示する
      return { status: 'profile-unavailable', retry };
    }

    return {
      status: 'authenticated',
      // ブランド型の生成はこの 1 箇所に閉じる（設計書 §3.2 / 規約 4.1）
      userId: profileQuery.data.profile.userId as UserId,
      role: profileQuery.data.profile.role,
      displayName: profileQuery.data.profile.displayName,
    };
  }, [session.isPending, userId, profileQuery.isPending, profileQuery.data, retry]);

  return <AuthContext value={authState}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const authState = use(AuthContext);

  if (authState === null) {
    throw new Error('useAuth は <AuthProvider> の内側で呼ぶこと');
  }

  return authState;
}
```

**注記:** `as UserId` は規約 2 で禁じている型アサーションだが、同じ規約の 4.1 が「ブランド型生成時のみ例外的に許可」としている。ブランド化はこの 1 行だけに閉じ、他の場所では `UserId` を受け渡すだけにすること。

- [ ] **Step 4: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- auth-context`
Expected: PASS（6 件）

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`if (profileQuery.isPending) { return { status: 'restoring' }; }` を削除し、「セッションはあるがロール取得中はまだ restoring のまま」が**失敗すること**を確認する。
続けて `profile-unavailable` の分岐を `{ status: 'unauthenticated' }` に書き換え、「ロール取得に失敗したら profile-unavailable になる」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 6: コミットする**

```bash
git add apps/mobile/src/lib/query-client.ts apps/mobile/src/lib/query-client.test.ts apps/mobile/src/features/auth/auth-context.tsx apps/mobile/src/features/auth/auth-context.test.tsx
git commit -m "feat(mobile): 復元中を表現できる認証状態コンテキストを追加する"
```

---

### Task 5-6: 画面の枠（PlaceholderScreen / AuthLoadingScreen）を作る

**Files:**

- Create: `apps/mobile/src/components/placeholder-screen.tsx`
- Create: `apps/mobile/src/components/placeholder-screen.test.tsx`
- Create: `apps/mobile/src/components/auth/auth-loading-screen.tsx`
- Create: `apps/mobile/src/components/auth/auth-loading-screen.test.tsx`

**Interfaces:**

- Consumes: `COLORS`（`@/constants/theme`）
- Produces:
  - `interface PlaceholderScreenProps { title: string; description: string; testID?: string | undefined }`
  - `function PlaceholderScreen(props: PlaceholderScreenProps): ReactElement`
  - `interface AuthLoadingScreenProps { testID?: string | undefined }`
  - `function AuthLoadingScreen(props: AuthLoadingScreenProps): ReactElement`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/components/placeholder-screen.test.tsx
import { render, screen } from '@testing-library/react-native';

import { PlaceholderScreen } from './placeholder-screen';

describe('PlaceholderScreen', () => {
  it('タイトルと説明を表示する', async () => {
    await render(<PlaceholderScreen title="さがす" description="Phase 6 で地図を実装する" />);

    expect(screen.getByText('さがす')).toBeOnTheScreen();
    expect(screen.getByText('Phase 6 で地図を実装する')).toBeOnTheScreen();
  });

  it('testID を渡すとルート要素から取得できる', async () => {
    await render(
      <PlaceholderScreen title="さがす" description="準備中" testID="user-home-screen" />,
    );

    expect(screen.getByTestId('user-home-screen')).toBeOnTheScreen();
  });
});
```

```tsx
// apps/mobile/src/components/auth/auth-loading-screen.test.tsx
import { render, screen } from '@testing-library/react-native';

import { AuthLoadingScreen, LOADING_MESSAGE } from './auth-loading-screen';

describe('AuthLoadingScreen', () => {
  it('読み込み中であることを文字で伝える', async () => {
    await render(<AuthLoadingScreen />);

    expect(screen.getByText(LOADING_MESSAGE)).toBeOnTheScreen();
  });

  it('スクリーンリーダー向けにも読み込み中であることを伝える', async () => {
    await render(<AuthLoadingScreen />);

    expect(screen.getByLabelText(LOADING_MESSAGE)).toBeOnTheScreen();
  });

  it('testID を省略しても既定値で取得できる（ルーティングテストから掴むため）', async () => {
    await render(<AuthLoadingScreen />);

    expect(screen.getByTestId('auth-loading-screen')).toBeOnTheScreen();
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- placeholder-screen auth-loading-screen`
Expected: FAIL（どちらも `Cannot find module`）

- [ ] **Step 2: `components/placeholder-screen.tsx` を作る**

```tsx
// apps/mobile/src/components/placeholder-screen.tsx
import { Text, View } from 'react-native';

export interface PlaceholderScreenProps {
  title: string;
  description: string;
  testID?: string | undefined;
}

/**
 * 後続フェーズで中身を作る画面の枠。
 * ルーティングを先に完成させるには「到達できる画面」が要るので、
 * 画面本体ができるまでの間だけこれを置く。実装時は呼び出し側ごと差し替える。
 */
export function PlaceholderScreen({ title, description, testID }: PlaceholderScreenProps) {
  return (
    <View className="flex-1 items-center justify-center gap-sm bg-neutral-50 px-lg" testID={testID}>
      <Text className="font-body-bold text-xl text-neutral-900">{title}</Text>
      <Text className="text-center font-body text-base text-neutral-600">{description}</Text>
    </View>
  );
}
```

- [ ] **Step 3: `components/auth/auth-loading-screen.tsx` を作る**

```tsx
// apps/mobile/src/components/auth/auth-loading-screen.tsx
import { ActivityIndicator, Text, View } from 'react-native';

import { COLORS } from '@/constants/theme';

/** テストからも参照するので export する。文言のコピーがズレるのを防ぐ */
export const LOADING_MESSAGE = 'ログイン状態を確認しています';

/** ルーティングテストから掴むための既定 testID */
const DEFAULT_TEST_ID = 'auth-loading-screen';

export interface AuthLoadingScreenProps {
  testID?: string | undefined;
}

/**
 * セッション復元中に出す画面。
 * 通常はスプラッシュの裏に隠れているが、スプラッシュが閉じたあとに
 * ロールの再取得が走った場合はこれが前面に出る。
 * ログイン画面を出さないこと自体が仕様なので、ここに入力欄を足してはいけない。
 */
export function AuthLoadingScreen({ testID = DEFAULT_TEST_ID }: AuthLoadingScreenProps) {
  return (
    <View className="flex-1 items-center justify-center gap-md bg-neutral-50" testID={testID}>
      <ActivityIndicator
        // ActivityIndicator は色を className で指定できないため JS 側から渡す
        color={COLORS.primary[500]}
        size="large"
        accessibilityLabel={LOADING_MESSAGE}
      />
      <Text className="font-body text-base text-neutral-600">{LOADING_MESSAGE}</Text>
    </View>
  );
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- placeholder-screen auth-loading-screen`
Expected: PASS（5 件）

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`ActivityIndicator` の `accessibilityLabel={LOADING_MESSAGE}` を削除し、「スクリーンリーダー向けにも読み込み中であることを伝える」が**失敗すること**を確認してから元に戻す。

- [ ] **Step 6: コミットする**

```bash
git add apps/mobile/src/components/placeholder-screen.tsx apps/mobile/src/components/placeholder-screen.test.tsx apps/mobile/src/components/auth/auth-loading-screen.tsx apps/mobile/src/components/auth/auth-loading-screen.test.tsx
git commit -m "feat(mobile): 画面の枠と認証ローディング画面を追加する"
```

---

### Task 5-7: ルートグループの骨組みを作る（全 _layout + 到達可能なプレースホルダ）

**方針:** ここでは**すべてのルートファイルを一度に作る**。中身は `PlaceholderScreen` だけで、画面本体は Task 5-13 以降で差し替える。先にルートツリーを完成させないと、Task 5-8 の `Stack.Protected` も Task 5-9 のディスパッチャも検証できないため。

**Files:**

- Create: `apps/mobile/src/app/(auth)/_layout.tsx`
- Create: `apps/mobile/src/app/(auth)/welcome.tsx`
- Create: `apps/mobile/src/app/(auth)/sign-in.tsx`
- Create: `apps/mobile/src/app/(auth)/sign-up.tsx`
- Create: `apps/mobile/src/app/(auth)/verify-email.tsx`
- Create: `apps/mobile/src/app/(auth)/forgot-password.tsx`
- Create: `apps/mobile/src/app/(user)/_layout.tsx`
- Create: `apps/mobile/src/app/(user)/(tabs)/_layout.tsx`
- Create: `apps/mobile/src/app/(user)/(tabs)/home.tsx`
- Create: `apps/mobile/src/app/(user)/(tabs)/profile.tsx`
- Create: `apps/mobile/src/app/(user)/settings/index.tsx`
- Create: `apps/mobile/src/app/(user)/settings/account.tsx`
- Create: `apps/mobile/src/app/(user)/settings/shop-application.tsx`
- Create: `apps/mobile/src/app/(owner)/_layout.tsx`
- Create: `apps/mobile/src/app/(owner)/(tabs)/_layout.tsx`
- Create: `apps/mobile/src/app/(owner)/(tabs)/dashboard.tsx`
- Create: `apps/mobile/src/app/(owner)/(tabs)/account.tsx`
- Create: `apps/mobile/src/app/(owner)/onboarding/status.tsx`
- Create: `apps/mobile/src/app/(admin)/_layout.tsx`
- Create: `apps/mobile/src/app/(admin)/(tabs)/_layout.tsx`
- Create: `apps/mobile/src/app/(admin)/(tabs)/overview.tsx`
- Create: `apps/mobile/src/app/(admin)/(tabs)/more.tsx`
- Create: `apps/mobile/src/app/route-files.test.ts`

**Interfaces:**

- Consumes: `PlaceholderScreen`（Task 5-6）、`Icon`（既存）、`COLORS`（既存）、`ROLE_HOME_ROUTES` ほかルート定数（Task 5-1）
- Produces: `/welcome` `/sign-in` `/sign-up` `/verify-email` `/forgot-password` `/home` `/profile` `/settings` `/settings/account` `/settings/shop-application` `/dashboard` `/account` `/onboarding/status` `/overview` `/more` の 15 ルート

- [ ] **Step 1: 失敗するテストを書く（定数のパスと実ファイルの対応）**

```ts
// apps/mobile/src/app/route-files.test.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  FORGOT_PASSWORD_ROUTE,
  OWNER_ONBOARDING_STATUS_ROUTE,
  ROLE_HOME_ROUTES,
  SHOP_APPLICATION_ROUTE,
  SIGN_IN_ROUTE,
  SIGN_UP_ROUTE,
  VERIFY_EMAIL_ROUTE,
  WELCOME_ROUTE,
} from '@/constants/auth';

/**
 * ルート定数 → 実ファイル（src/app からの相対パス）の対応表。
 * グループ名は URL に出ないため、パス文字列からファイルは機械的に導けない。
 * ここを唯一の対応表にして、片方だけ直したときに必ず落ちるようにする。
 */
const ROUTE_TO_FILE: ReadonlyArray<readonly [string, string]> = [
  [String(WELCOME_ROUTE), '(auth)/welcome.tsx'],
  [String(SIGN_IN_ROUTE), '(auth)/sign-in.tsx'],
  [String(SIGN_UP_ROUTE), '(auth)/sign-up.tsx'],
  [String(VERIFY_EMAIL_ROUTE), '(auth)/verify-email.tsx'],
  [String(FORGOT_PASSWORD_ROUTE), '(auth)/forgot-password.tsx'],
  [String(ROLE_HOME_ROUTES.user), '(user)/(tabs)/home.tsx'],
  [String(ROLE_HOME_ROUTES.owner), '(owner)/(tabs)/dashboard.tsx'],
  [String(ROLE_HOME_ROUTES.admin), '(admin)/(tabs)/overview.tsx'],
  [String(SHOP_APPLICATION_ROUTE), '(user)/settings/shop-application.tsx'],
  [String(OWNER_ONBOARDING_STATUS_ROUTE), '(owner)/onboarding/status.tsx'],
];

/** _layout が無いディレクトリはナビゲータにならず、親スタックへ平坦化されてしまう */
const REQUIRED_LAYOUT_FILES: readonly string[] = [
  '_layout.tsx',
  '(auth)/_layout.tsx',
  '(user)/_layout.tsx',
  '(user)/(tabs)/_layout.tsx',
  '(owner)/_layout.tsx',
  '(owner)/(tabs)/_layout.tsx',
  '(admin)/_layout.tsx',
  '(admin)/(tabs)/_layout.tsx',
];

describe('ルート定数と実ファイルの対応', () => {
  it.each(ROUTE_TO_FILE)('%s は %s に実装されている', (_route, relativePath) => {
    expect(existsSync(join(__dirname, relativePath))).toBe(true);
  });

  it.each(REQUIRED_LAYOUT_FILES)('%s が存在する', (relativePath) => {
    expect(existsSync(join(__dirname, relativePath))).toBe(true);
  });

  it('ロールごとの着地ルートがすべて対応表に載っている', () => {
    const mappedRoutes = new Set(ROUTE_TO_FILE.map(([route]) => route));

    for (const route of Object.values(ROLE_HOME_ROUTES)) {
      expect(mappedRoutes.has(String(route))).toBe(true);
    }
  });

  it('対応表のファイルパスに重複がない', () => {
    const filePaths = ROUTE_TO_FILE.map(([, filePath]) => filePath);

    expect(new Set(filePaths).size).toBe(filePaths.length);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- route-files`
Expected: FAIL（`(auth)/welcome.tsx` などが存在せず `existsSync` が false）

- [ ] **Step 2: `(auth)` グループを作る**

```tsx
// apps/mobile/src/app/(auth)/_layout.tsx
import { Stack } from 'expo-router';

/**
 * 未認証時の入り口。ガードで弾かれたときもここへ戻る。
 * サインイン直行ではなく welcome にするのは、初回起動時に
 * 「新規登録」と「ゲストで見る」の選択肢を先に見せるため（設計書 §5.1）。
 */
export const unstable_settings = { anchor: 'welcome' };

export default function AuthLayout() {
  // 各画面が自前で戻る導線を持つのでネイティブヘッダーは出さない
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

```tsx
// apps/mobile/src/app/(auth)/welcome.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function WelcomeScreen() {
  return (
    <PlaceholderScreen
      title="メシマップ"
      description="Task 5-17 でオンボーディングとゲスト導線を実装する"
      testID="welcome-screen"
    />
  );
}
```

```tsx
// apps/mobile/src/app/(auth)/sign-in.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function SignInScreen() {
  return (
    <PlaceholderScreen
      title="ログイン"
      description="Task 5-13 でフォームを実装する"
      testID="sign-in-screen"
    />
  );
}
```

```tsx
// apps/mobile/src/app/(auth)/sign-up.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function SignUpScreen() {
  return (
    <PlaceholderScreen
      title="新規登録"
      description="Task 5-14 でフォームを実装する"
      testID="sign-up-screen"
    />
  );
}
```

```tsx
// apps/mobile/src/app/(auth)/verify-email.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function VerifyEmailScreen() {
  return (
    <PlaceholderScreen
      title="メールを確認してください"
      description="Task 5-15 で案内文と再送導線を実装する"
      testID="verify-email-screen"
    />
  );
}
```

```tsx
// apps/mobile/src/app/(auth)/forgot-password.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function ForgotPasswordScreen() {
  return (
    <PlaceholderScreen
      title="パスワードの再設定"
      description="Task 5-16 で再設定メールの送信を実装する"
      testID="forgot-password-screen"
    />
  );
}
```

- [ ] **Step 3: `(user)` グループを作る**

```tsx
// apps/mobile/src/app/(user)/_layout.tsx
import { Stack } from 'expo-router';

/** 利用者の起点はタブ。設定系はその上にスタックで積む */
export const unstable_settings = { anchor: '(tabs)' };

export default function UserLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="settings/index" options={{ headerShown: true, title: '設定' }} />
      <Stack.Screen name="settings/account" options={{ headerShown: true, title: 'アカウント' }} />
      <Stack.Screen
        name="settings/shop-application"
        options={{ headerShown: true, title: '店舗の登録申請' }}
      />
    </Stack>
  );
}
```

```tsx
// apps/mobile/src/app/(user)/(tabs)/_layout.tsx
import { Tabs } from 'expo-router/js-tabs';
import { Map, UserRound } from 'lucide-react-native';

import { Icon } from '@/components/ui/icon';
import { COLORS } from '@/constants/theme';

/** 'expo-router' からの Tabs は 57 で deprecated（build/exports.d.ts のコメント）。js-tabs を使う */

/** タブアイコンの色。選択中はブランド色、非選択は本文より薄い色にする */
const ACTIVE_TAB_COLOR = COLORS.primary[500];
const INACTIVE_TAB_COLOR = COLORS.neutral[500];

export default function UserTabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ACTIVE_TAB_COLOR,
        tabBarInactiveTintColor: INACTIVE_TAB_COLOR,
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: 'さがす',
          // tabBarIcon が渡す color は ColorValue 型で Icon の color: string と合わない。
          // キャストを避けるため focused から自前で色を決める
          tabBarIcon: ({ focused }) => (
            <Icon icon={Map} size="lg" color={focused ? ACTIVE_TAB_COLOR : INACTIVE_TAB_COLOR} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'マイページ',
          tabBarIcon: ({ focused }) => (
            <Icon
              icon={UserRound}
              size="lg"
              color={focused ? ACTIVE_TAB_COLOR : INACTIVE_TAB_COLOR}
            />
          ),
        }}
      />
    </Tabs>
  );
}
```

```tsx
// apps/mobile/src/app/(user)/(tabs)/home.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function UserHomeScreen() {
  return (
    <PlaceholderScreen
      title="さがす"
      description="Phase 6 で地図とリストを実装する"
      testID="user-home-screen"
    />
  );
}
```

```tsx
// apps/mobile/src/app/(user)/(tabs)/profile.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function UserProfileScreen() {
  return (
    <PlaceholderScreen
      title="マイページ"
      description="Phase 6 でお気に入りと口コミ履歴を実装する"
      testID="user-profile-screen"
    />
  );
}
```

```tsx
// apps/mobile/src/app/(user)/settings/index.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function UserSettingsScreen() {
  return (
    <PlaceholderScreen
      title="設定"
      description="Task 5-18 でアカウントと店舗申請への導線を実装する"
      testID="user-settings-screen"
    />
  );
}
```

```tsx
// apps/mobile/src/app/(user)/settings/account.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function UserAccountScreen() {
  return (
    <PlaceholderScreen
      title="アカウント"
      description="Task 5-18 でログアウトを実装する"
      testID="user-account-screen"
    />
  );
}
```

```tsx
// apps/mobile/src/app/(user)/settings/shop-application.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function ShopApplicationScreen() {
  return (
    <PlaceholderScreen
      title="店舗の登録申請"
      description="Task 5-19 で申請フォームを実装する"
      testID="shop-application-screen"
    />
  );
}
```

- [ ] **Step 4: `(owner)` グループを作る**

```tsx
// apps/mobile/src/app/(owner)/_layout.tsx
import { Stack } from 'expo-router';

/** 店舗管理者の起点はタブ。審査ステータスはその上にスタックで積む */
export const unstable_settings = { anchor: '(tabs)' };

export default function OwnerLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding/status" options={{ headerShown: true, title: '審査状況' }} />
    </Stack>
  );
}
```

```tsx
// apps/mobile/src/app/(owner)/(tabs)/_layout.tsx
import { Tabs } from 'expo-router/js-tabs';
import { CircleUser, LayoutDashboard } from 'lucide-react-native';

import { Icon } from '@/components/ui/icon';
import { COLORS } from '@/constants/theme';

const ACTIVE_TAB_COLOR = COLORS.primary[500];
const INACTIVE_TAB_COLOR = COLORS.neutral[500];

export default function OwnerTabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ACTIVE_TAB_COLOR,
        tabBarInactiveTintColor: INACTIVE_TAB_COLOR,
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: 'ホーム',
          tabBarIcon: ({ focused }) => (
            <Icon
              icon={LayoutDashboard}
              size="lg"
              color={focused ? ACTIVE_TAB_COLOR : INACTIVE_TAB_COLOR}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: 'アカウント',
          tabBarIcon: ({ focused }) => (
            <Icon
              icon={CircleUser}
              size="lg"
              color={focused ? ACTIVE_TAB_COLOR : INACTIVE_TAB_COLOR}
            />
          ),
        }}
      />
    </Tabs>
  );
}
```

```tsx
// apps/mobile/src/app/(owner)/(tabs)/dashboard.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function OwnerDashboardScreen() {
  return (
    <PlaceholderScreen
      title="店舗ダッシュボード"
      description="Phase 8 で本日の予約と未返信口コミを実装する"
      testID="owner-dashboard-screen"
    />
  );
}
```

```tsx
// apps/mobile/src/app/(owner)/(tabs)/account.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function OwnerAccountScreen() {
  return (
    <PlaceholderScreen
      title="アカウント"
      description="Task 5-18 でログアウトを実装する"
      testID="owner-account-screen"
    />
  );
}
```

```tsx
// apps/mobile/src/app/(owner)/onboarding/status.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function OwnerOnboardingStatusScreen() {
  return (
    <PlaceholderScreen
      title="審査状況"
      description="Task 5-19 で申請ステータスの表示を実装する"
      testID="owner-onboarding-status-screen"
    />
  );
}
```

- [ ] **Step 5: `(admin)` グループを作る**

```tsx
// apps/mobile/src/app/(admin)/_layout.tsx
import { Stack } from 'expo-router';

/** システム管理者の画面は Phase 9 まで全てタブ配下。スタックに積む画面はまだ無い */
export const unstable_settings = { anchor: '(tabs)' };

export default function AdminLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

```tsx
// apps/mobile/src/app/(admin)/(tabs)/_layout.tsx
import { Tabs } from 'expo-router/js-tabs';
import { Ellipsis, ShieldCheck } from 'lucide-react-native';

import { Icon } from '@/components/ui/icon';
import { COLORS } from '@/constants/theme';

const ACTIVE_TAB_COLOR = COLORS.primary[500];
const INACTIVE_TAB_COLOR = COLORS.neutral[500];

export default function AdminTabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ACTIVE_TAB_COLOR,
        tabBarInactiveTintColor: INACTIVE_TAB_COLOR,
      }}
    >
      <Tabs.Screen
        name="overview"
        options={{
          title: '概況',
          tabBarIcon: ({ focused }) => (
            <Icon
              icon={ShieldCheck}
              size="lg"
              color={focused ? ACTIVE_TAB_COLOR : INACTIVE_TAB_COLOR}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'その他',
          tabBarIcon: ({ focused }) => (
            <Icon
              icon={Ellipsis}
              size="lg"
              color={focused ? ACTIVE_TAB_COLOR : INACTIVE_TAB_COLOR}
            />
          ),
        }}
      />
    </Tabs>
  );
}
```

```tsx
// apps/mobile/src/app/(admin)/(tabs)/overview.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function AdminOverviewScreen() {
  return (
    <PlaceholderScreen
      title="概況"
      description="Phase 9 で承認待ち件数と通報件数を実装する"
      testID="admin-overview-screen"
    />
  );
}
```

```tsx
// apps/mobile/src/app/(admin)/(tabs)/more.tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function AdminMoreScreen() {
  return (
    <PlaceholderScreen
      title="その他"
      description="Task 5-18 でログアウトを実装する"
      testID="admin-more-screen"
    />
  );
}
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- route-files`
Expected: PASS（`it.each` の 10 件 + 8 件 + 2 件 = 20 件）

- [ ] **Step 7: 型チェックと Expo の型生成を確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm run typecheck -w @meshimap/mobile`
Expected: エラーなし。`Tabs` を `expo-router/js-tabs` から import しているので deprecated 警告も出ない。

- [ ] **Step 8: わざと壊してテストが落ちることを確認する**

`apps/mobile/src/app/(user)/(tabs)/home.tsx` を `index.tsx` にリネームし、「`/home` は `(user)/(tabs)/home.tsx` に実装されている」が**失敗すること**を確認してから元に戻す。
（この失敗こそが、設計書 §5.1 からの逸脱を戻したときに気づける仕掛け）

- [ ] **Step 9: コミットする**

```bash
git add apps/mobile/src/app/
git commit -m "feat(mobile): ロール別ルートグループの骨組みを追加する"
```

---

### Task 5-8: ルート _layout.tsx に Providers とアクセス制御を組み込む

**Files:**

- Modify: `apps/mobile/src/app/_layout.tsx`
- Modify: `apps/mobile/src/hooks/use-app-fonts.ts`
- Modify: `apps/mobile/src/hooks/use-app-fonts.test.ts`（既存。拡張子は `.tsx` ではなく `.ts`）
- Modify: `apps/mobile/jest.config.js`
- Create: `apps/mobile/jest-css-stub.js`
- Create: `apps/mobile/src/app/_layout.test.tsx`

> このタスクが増やす実装ファイルのうち、`jest-css-stub.js` は `src/` の外の `.js` で
> `collectCoverageFrom: ['src/**/*.{ts,tsx}', ...]` に当たらず、`src/app/_layout.tsx` は
> **この時点ではまだ** `!src/app/**` で除外されているため、カバレッジ 100% 閾値には影響しない。
> 一方 `src/hooks/use-app-fonts.ts` は集計対象なので、追加した分岐のテストを
> 既存の `use-app-fonts.test.ts` に必ず追記する（Step 1）。
>
> `jest.config.js` はこのタスクでも触る（Step 4 の `moduleNameMapper`）が、
> **`collectCoverageFrom` には手を付けない**。`!src/app/**` を外すのは全画面が揃う
> Task 5-21 Step 4-a で、理由もそこに書いてある（未確認事項 #13 の決着）。
> ここで外すと、まだ存在しない 24 ファイル分の 0% で Task 5-9 以降が赤いゲートを跨ぐ。

**Interfaces:**

- Consumes:
  - `useAuth(): AuthState` / `AuthProvider`（Task 5-5）
  - `queryClient`（Task 5-5）
  - `useFonts(map): [boolean, Error | null]`（`node_modules/expo-font/build/FontHooks.js` で確認。**失敗時は第 1 要素が false のまま**）
  - `SplashScreen.preventAutoHideAsync(): Promise<boolean>` / `SplashScreen.hideAsync(): Promise<boolean>`
  - `Stack.Protected: FunctionComponent<{ guard: boolean; children?: ReactNode }>`
  - `ROLE_USER` / `ROLE_OWNER` / `ROLE_ADMIN` from `@meshimap/core`
- Produces:
  - `export const unstable_settings = { anchor: 'index' }`
  - `export default function RootLayout(): ReactElement`
  - `interface AppFontsState { areFontsLoaded: boolean; hasFontLoadingSettled: boolean }`

- [ ] **Step 1: 失敗するテストを書く（フォント読込の決着）**

`apps/mobile/src/hooks/use-app-fonts.test.ts` は **すでに存在し 5 件のテストが通っている**（JSX を含まないので拡張子は `.ts`。`.tsx` で新規作成すると同じフックのテストが 2 本並立してしまう）。新規作成ではなく既存ファイルへ追記する。

まずヘルパ `renderAppFonts` を「読み込みエラーも指定できる」形に広げる。第 2 引数を省略可能にして、既存 5 件の呼び出し（`renderAppFonts(true)` など）をそのまま動かす。

```ts
// apps/mobile/src/hooks/use-app-fonts.test.ts（既存ヘルパを置き換える）
/**
 * 指定した読み込み状態でフックを描画する。RNTL 14 の renderHook は async
 * （`node_modules/@testing-library/react-native/dist/render-hook.d.ts` の戻り値が `Promise<...>`）。
 * fontLoadingError は「読み込みに失敗したが決着はした」ケースを作るために使う
 */
async function renderAppFonts(isLoaded: boolean, fontLoadingError: Error | null = null) {
  useFontsMock.mockReturnValue([isLoaded, fontLoadingError]);
  const { result } = await renderHook(() => useAppFonts());
  return result;
}
```

続けて `describe('useAppFonts', ...)` の末尾へ 3 件を追記する。既存 2 件が `areFontsLoaded` を見ているので、新規分は `hasFontLoadingSettled` に絞る。

```ts
// apps/mobile/src/hooks/use-app-fonts.test.ts（describe の末尾に追記）
it('読み込み中は hasFontLoadingSettled が false', async () => {
  const result = await renderAppFonts(false);

  expect(result.current.hasFontLoadingSettled).toBe(false);
});

it('読み込みが終わると hasFontLoadingSettled が true', async () => {
  const result = await renderAppFonts(true);

  expect(result.current.hasFontLoadingSettled).toBe(true);
});

it('読み込みに失敗しても hasFontLoadingSettled は true になる', async () => {
  // expo-font の useFonts は失敗すると loaded を false に固定する
  // （node_modules/expo-font/build/FontHooks.js の useRuntimeFonts は catch で setError するだけ）。
  // これを決着扱いにしないとスプラッシュが永久に閉じず、アプリが起動不能になる
  const result = await renderAppFonts(false, new Error('font download failed'));

  expect(result.current.areFontsLoaded).toBe(false);
  expect(result.current.hasFontLoadingSettled).toBe(true);
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- use-app-fonts`
Expected: FAIL（`hasFontLoadingSettled` が `undefined`。既存 5 件は PASS のまま）

- [ ] **Step 2: `hooks/use-app-fonts.ts` を変更する**

```ts
// apps/mobile/src/hooks/use-app-fonts.ts
import {
  NotoSansJP_400Regular,
  NotoSansJP_500Medium,
  NotoSansJP_700Bold,
} from '@expo-google-fonts/noto-sans-jp';
import { Outfit_600SemiBold, Outfit_700Bold } from '@expo-google-fonts/outfit';
import { useFonts } from 'expo-font';

export interface AppFontsState {
  /** 指定したフォントがすべて使える状態か */
  areFontsLoaded: boolean;
  /** 成功・失敗のどちらかで決着したか。スプラッシュを閉じてよいかの判断はこちらを使う */
  hasFontLoadingSettled: boolean;
}

/** アプリ全体で使うフォントを読み込む。読み込みが決着するまでスプラッシュを維持する */
export function useAppFonts(): AppFontsState {
  const [areFontsLoaded, fontLoadingError] = useFonts({
    Outfit_600SemiBold,
    Outfit_700Bold,
    NotoSansJP_400Regular,
    NotoSansJP_500Medium,
    NotoSansJP_700Bold,
  });

  return {
    areFontsLoaded,
    // useFonts は失敗すると loaded を false に固定する
    // （node_modules/expo-font/build/FontHooks.js の useRuntimeFonts）。
    // areFontsLoaded だけを条件にすると、フォント取得に失敗した端末で
    // スプラッシュが永久に閉じず、アプリが起動不能になる
    hasFontLoadingSettled: areFontsLoaded || fontLoadingError !== null,
  };
}
```

- [ ] **Step 3: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- use-app-fonts`
Expected: PASS（既存 5 件 + 追加 3 件 = 8 件）

- [ ] **Step 4: Jest で `global.css` を読めるようにする**

`apps/mobile/src/app/_layout.tsx` は `import '../global.css'` を含むため、テストから読み込むと Jest が `@tailwind base;` を JavaScript として解釈して落ちる（Jest は Metro のトランスフォーマを通らない）。空モジュールへ差し替える。

```js
// apps/mobile/jest-css-stub.js
// Jest から global.css を require したときに読み込まれる空モジュール。
// NativeWind のスタイルは Metro のトランスフォーマ経由でしか生成されず、
// テストでは className の見た目そのものを検証しないため中身は不要。
module.exports = {};
```

`apps/mobile/jest.config.js` の `moduleNameMapper` を次の内容に置き換える。

```js
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Jest は Metro を通らないため global.css を解釈できない。空モジュールへ差し替える
    '\\.css$': '<rootDir>/jest-css-stub.js',
  },
```

- [ ] **Step 5: 失敗するテストを書く（ルートレイアウトのガード）**

```tsx
// apps/mobile/src/app/_layout.test.tsx
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { Slot } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { Text } from 'react-native';

import type { AuthState } from '@/features/auth/types';

const mockHideAsync = jest.fn(() => Promise.resolve(true));
const mockUseAppFonts = jest.fn();
const mockUseAuth = jest.fn();

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve(true)),
  hideAsync: mockHideAsync,
  setOptions: jest.fn(),
}));
jest.mock('@/hooks/use-app-fonts', () => ({ useAppFonts: mockUseAppFonts }));
jest.mock('@/features/auth/auth-context', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: mockUseAuth,
}));

import RootLayout, { unstable_settings } from './_layout';

const AUTHENTICATED_USER: AuthState = {
  status: 'authenticated',
  userId: 'usr_1' as never,
  role: ROLE_USER,
  displayName: '山田太郎',
};
const AUTHENTICATED_OWNER: AuthState = { ...AUTHENTICATED_USER, role: ROLE_OWNER };
const AUTHENTICATED_ADMIN: AuthState = { ...AUTHENTICATED_USER, role: ROLE_ADMIN };

/** グループごとに _layout を置かないとナビゲータが作られず、親スタックへ平坦化されてしまう */
const ROUTE_STUBS = {
  index: () => <Text testID="index-screen">index</Text>,
  '(auth)/_layout': () => <Slot />,
  '(auth)/sign-in': () => <Text testID="sign-in-screen">sign-in</Text>,
  '(user)/_layout': () => <Slot />,
  '(user)/(tabs)/_layout': () => <Slot />,
  '(user)/(tabs)/home': () => <Text testID="user-home-screen">home</Text>,
  '(owner)/_layout': () => <Slot />,
  '(owner)/(tabs)/_layout': () => <Slot />,
  '(owner)/(tabs)/dashboard': () => <Text testID="owner-dashboard-screen">dashboard</Text>,
  '(admin)/_layout': () => <Slot />,
  '(admin)/(tabs)/_layout': () => <Slot />,
  '(admin)/(tabs)/overview': () => <Text testID="admin-overview-screen">overview</Text>,
};

/**
 * RNTL 14 の render は Promise を返し、renderRouter はその Promise に
 * getPathname 等を生やして返す（`Promise<RenderResult> & { getPathname(): string }`）。
 * await して描画を確定させてから getPathname() を読む。
 */
async function renderApp(initialUrl: string) {
  const app = renderRouter(
    { _layout: { default: RootLayout, unstable_settings }, ...ROUTE_STUBS },
    { initialUrl },
  );
  await app;
  return app;
}

describe('ルートレイアウトのアクセス制御', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAppFonts.mockReturnValue({ areFontsLoaded: true, hasFontLoadingSettled: true });
  });

  it('アンカーは index（ガードで弾かれたときの戻り先）', () => {
    expect(unstable_settings.anchor).toBe('index');
  });

  it('未認証は (auth) に到達できる', async () => {
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });

    const app = await renderApp('/sign-in');

    expect(app.getPathname()).toBe('/sign-in');
    expect(screen.getByTestId('sign-in-screen')).toBeOnTheScreen();
  });

  it('未認証が利用者ルートへ直接来るとアンカーへ戻される', async () => {
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });

    const app = await renderApp('/home');

    expect(app.getPathname()).toBe('/');
  });

  it('role=user は /home に到達できる', async () => {
    mockUseAuth.mockReturnValue(AUTHENTICATED_USER);

    const app = await renderApp('/home');

    expect(app.getPathname()).toBe('/home');
    expect(screen.getByTestId('user-home-screen')).toBeOnTheScreen();
  });

  it('role=user は店舗管理者ルートへ入れない', async () => {
    mockUseAuth.mockReturnValue(AUTHENTICATED_USER);

    const app = await renderApp('/dashboard');

    expect(app.getPathname()).toBe('/');
  });

  it('role=owner は /dashboard に到達できる', async () => {
    mockUseAuth.mockReturnValue(AUTHENTICATED_OWNER);

    const app = await renderApp('/dashboard');

    expect(app.getPathname()).toBe('/dashboard');
  });

  it('role=admin は /overview に到達できる', async () => {
    mockUseAuth.mockReturnValue(AUTHENTICATED_ADMIN);

    const app = await renderApp('/overview');

    expect(app.getPathname()).toBe('/overview');
  });

  it('認証済みはログイン画面へ戻れない', async () => {
    mockUseAuth.mockReturnValue(AUTHENTICATED_USER);

    const app = await renderApp('/sign-in');

    expect(app.getPathname()).toBe('/');
  });

  it('復元中はどのグループも登録されない（境界値: ロール未確定）', async () => {
    mockUseAuth.mockReturnValue({ status: 'restoring' });

    const app = await renderApp('/home');

    expect(app.getPathname()).toBe('/');
  });
});

describe('スプラッシュを閉じる条件', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('フォントが決着し復元も終わったら閉じる', async () => {
    mockUseAppFonts.mockReturnValue({ areFontsLoaded: true, hasFontLoadingSettled: true });
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });

    await renderApp('/');

    expect(mockHideAsync).toHaveBeenCalled();
  });

  it('復元中は閉じない（ログイン画面のちらつきを防ぐ）', async () => {
    mockUseAppFonts.mockReturnValue({ areFontsLoaded: true, hasFontLoadingSettled: true });
    mockUseAuth.mockReturnValue({ status: 'restoring' });

    await renderApp('/');

    expect(mockHideAsync).not.toHaveBeenCalled();
  });

  it('フォントが未決着なら閉じない（文字のちらつきを防ぐ）', async () => {
    mockUseAppFonts.mockReturnValue({ areFontsLoaded: false, hasFontLoadingSettled: false });
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });

    await renderApp('/');

    expect(mockHideAsync).not.toHaveBeenCalled();
  });

  it('フォント取得に失敗しても閉じる（起動不能を防ぐ）', async () => {
    mockUseAppFonts.mockReturnValue({ areFontsLoaded: false, hasFontLoadingSettled: true });
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });

    await renderApp('/');

    expect(mockHideAsync).toHaveBeenCalled();
  });
});
```

**注記:** `'usr_1' as never` は `UserId` のブランド型を満たすためのテスト専用の書き方。`as never` は「値を偽装していること」がひと目で分かるので、テストの中でだけ許す（本番コードのブランド化は `auth-context.tsx` の 1 箇所に閉じる）。

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- src/app/_layout`
Expected: FAIL（`unstable_settings` が未 export）

- [ ] **Step 6: `app/_layout.tsx` を書き換える**

```tsx
// apps/mobile/src/app/_layout.tsx
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { AuthProvider, useAuth } from '@/features/auth/auth-context';
import { useAppFonts } from '@/hooks/use-app-fonts';
import { queryClient } from '@/lib/query-client';
// これを忘れると NativeWind のスタイルが一切適用されない
import '../global.css';

/**
 * ガードで弾かれたスクリーンの戻り先。
 * expo-router は guard=false のとき「アンカールート（通常は index）」へ落とすため
 * （https://docs.expo.dev/router/advanced/protected/）、ロールディスパッチャの index を指定する。
 */
export const unstable_settings = { anchor: 'index' };

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * 認証状態に応じて「登録するスクリーン自体」を切り替えるナビゲータ。
 *
 * 重要: フォント未読込でも null を返さずナビゲータをマウントする。
 * ここで null を返すとフォント読込完了の瞬間にナビゲータが初めて構築され、
 * その 1 フレームだけアンカー（index）以外が描かれる余地が生まれる。
 * 描画はスプラッシュの裏で進め、閉じるタイミングだけを制御する方が確実。
 */
function RootNavigator() {
  const colorScheme = useColorScheme();
  const authState = useAuth();
  const { hasFontLoadingSettled } = useAppFonts();

  const isRestoring = authState.status === 'restoring';

  useEffect(() => {
    // フォントの決着と認証復元の完了が両方揃うまでスプラッシュを維持する。
    // 片方だけで閉じると、文字のちらつきかログイン画面の一瞬の表示のどちらかが必ず起きる
    if (hasFontLoadingSettled && !isRestoring) {
      void SplashScreen.hideAsync();
    }
  }, [hasFontLoadingSettled, isRestoring]);

  const isAuthenticated = authState.status === 'authenticated';

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        {/* index は常に登録する。ガードで弾かれたときの受け皿を兼ねるため */}
        <Stack.Screen name="index" />
        <Stack.Screen name="+not-found" />

        <Stack.Protected guard={authState.status === 'unauthenticated'}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>

        <Stack.Protected guard={isAuthenticated && authState.role === ROLE_USER}>
          <Stack.Screen name="(user)" />
        </Stack.Protected>

        <Stack.Protected guard={isAuthenticated && authState.role === ROLE_OWNER}>
          <Stack.Screen name="(owner)" />
        </Stack.Protected>

        <Stack.Protected guard={isAuthenticated && authState.role === ROLE_ADMIN}>
          <Stack.Screen name="(admin)" />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  );
}
```

- [ ] **Step 7: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- src/app/_layout`
Expected: PASS（13 件）

- [ ] **Step 8: わざと壊してテストが落ちることを確認する**

`<Stack.Protected guard={isAuthenticated && authState.role === ROLE_USER}>` の guard を `isAuthenticated` に書き換え、「role=user は店舗管理者ルートへ入れない」が**失敗すること**を確認する。
続けて `useEffect` の条件を `if (hasFontLoadingSettled)` に書き換え、「復元中は閉じない（ログイン画面のちらつきを防ぐ）」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 9: 既存テストの回帰を確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile`
Expected: 全件 PASS。特に `src/app/_dev/catalog.test.tsx` と `src/lib/jest-setup.test.tsx` が `moduleNameMapper` の追加で壊れていないこと。

- [ ] **Step 10: コミットする**

```bash
git add apps/mobile/src/app/_layout.tsx apps/mobile/src/app/_layout.test.tsx apps/mobile/src/hooks/use-app-fonts.ts apps/mobile/src/hooks/use-app-fonts.test.ts apps/mobile/jest.config.js apps/mobile/jest-css-stub.js
git commit -m "feat(mobile): ルートレイアウトにロール別アクセス制御とスプラッシュ制御を組み込む"
```

---

### Task 5-9: index.tsx をロールディスパッチャにし、+not-found.tsx を作る

**Files:**

- Modify: `apps/mobile/src/app/index.tsx`
- Create: `apps/mobile/src/app/+not-found.tsx`
- Create: `apps/mobile/src/app/index.test.tsx`

**Interfaces:**

- Consumes:
  - `useAuth(): AuthState`（Task 5-5）
  - `ROLE_HOME_ROUTES` / `WELCOME_ROUTE` / `ROOT_ROUTE`（Task 5-1）
  - `AuthLoadingScreen`（Task 5-6）、`ErrorState`（既存）、`Button`（既存）
  - `<Redirect href={Href} />`（`node_modules/expo-router/build/link/Redirect.d.ts`）
- Produces: `export default function RootIndexScreen(): ReactElement`、`export default function NotFoundScreen(): ReactElement`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/app/index.test.tsx
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { Slot } from 'expo-router';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Text } from 'react-native';

import type { AuthState } from '@/features/auth/types';

const mockUseAuth = jest.fn();
const mockRetry = jest.fn();

jest.mock('@/features/auth/auth-context', () => ({ useAuth: mockUseAuth }));

import RootIndexScreen from './index';

const AUTHENTICATED_USER: AuthState = {
  status: 'authenticated',
  userId: 'usr_1' as never,
  role: ROLE_USER,
  displayName: '山田太郎',
};

/**
 * ここでは index.tsx 単体の振る舞いを見たいので、ルート _layout は素の Slot にする。
 * Stack.Protected と組み合わせた通し確認は Task 5-20 で行う。
 */
const ROUTE_STUBS = {
  _layout: () => <Slot />,
  index: RootIndexScreen,
  '(auth)/welcome': () => <Text testID="welcome-screen">welcome</Text>,
  '(user)/(tabs)/home': () => <Text testID="user-home-screen">home</Text>,
  '(owner)/(tabs)/dashboard': () => <Text testID="owner-dashboard-screen">dashboard</Text>,
  '(admin)/(tabs)/overview': () => <Text testID="admin-overview-screen">overview</Text>,
};

/** RNTL 14 の render は Promise を返すので、await してから getPathname() を読む */
async function renderApp() {
  const app = renderRouter(ROUTE_STUBS, { initialUrl: '/' });
  await app;
  return app;
}

describe('ロールディスパッチャ', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('復元中はローディングを出し、ログイン画面へは飛ばさない', async () => {
    mockUseAuth.mockReturnValue({ status: 'restoring' });

    const app = await renderApp();

    expect(screen.getByTestId('auth-loading-screen')).toBeOnTheScreen();
    expect(app.getPathname()).toBe('/');
    expect(screen.queryByTestId('welcome-screen')).not.toBeOnTheScreen();
  });

  it('未認証は /welcome へ飛ばす', async () => {
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });

    const app = await renderApp();

    expect(app.getPathname()).toBe('/welcome');
  });

  it('role=user は /home へ飛ばす', async () => {
    mockUseAuth.mockReturnValue(AUTHENTICATED_USER);

    const app = await renderApp();

    expect(app.getPathname()).toBe('/home');
  });

  it('role=owner は /dashboard へ飛ばす', async () => {
    mockUseAuth.mockReturnValue({ ...AUTHENTICATED_USER, role: ROLE_OWNER });

    const app = await renderApp();

    expect(app.getPathname()).toBe('/dashboard');
  });

  it('role=admin は /overview へ飛ばす', async () => {
    mockUseAuth.mockReturnValue({ ...AUTHENTICATED_USER, role: ROLE_ADMIN });

    const app = await renderApp();

    expect(app.getPathname()).toBe('/overview');
  });

  it('プロフィール取得に失敗したらエラーと再試行を出し、ログイン画面へは飛ばさない', async () => {
    mockUseAuth.mockReturnValue({ status: 'profile-unavailable', retry: mockRetry });

    const app = await renderApp();

    expect(screen.getByTestId('profile-unavailable-error')).toBeOnTheScreen();
    expect(app.getPathname()).toBe('/');
    expect(screen.queryByTestId('welcome-screen')).not.toBeOnTheScreen();
  });

  it('再試行ボタンで retry が呼ばれる', async () => {
    mockUseAuth.mockReturnValue({ status: 'profile-unavailable', retry: mockRetry });

    await renderApp();
    await fireEvent.press(screen.getByTestId('profile-unavailable-error-retry-button'));

    expect(mockRetry).toHaveBeenCalledTimes(1);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- src/app/index`
Expected: FAIL（現状の `index.tsx` はプレースホルダーでリダイレクトしない）

- [ ] **Step 2: `app/index.tsx` を書き換える**

```tsx
// apps/mobile/src/app/index.tsx
import { Redirect } from 'expo-router';
import { View } from 'react-native';

import { AuthLoadingScreen } from '@/components/auth/auth-loading-screen';
import { ErrorState } from '@/components/ui/error-state';
import { ROLE_HOME_ROUTES, WELCOME_ROUTE } from '@/constants/auth';
import { useAuth } from '@/features/auth/auth-context';

const PROFILE_UNAVAILABLE_TITLE = 'アカウント情報を取得できませんでした';
const PROFILE_UNAVAILABLE_DESCRIPTION = '通信状況を確認して、もう一度お試しください。';
const PROFILE_UNAVAILABLE_TEST_ID = 'profile-unavailable-error';

/**
 * ロールディスパッチャ。
 * ルート _layout の Stack.Protected はアンカー（= このファイル）を戻り先にするため、
 * 「ガードで弾く → ここへ戻る → 正しいグループへ配り直す」が 1 本の流れで閉じる。
 */
export default function RootIndexScreen() {
  const authState = useAuth();

  if (authState.status === 'restoring') {
    // ここでログイン画面を出すとちらつきになる。復元が終わるまで判断を保留する
    return <AuthLoadingScreen />;
  }

  if (authState.status === 'unauthenticated') {
    return <Redirect href={WELCOME_ROUTE} />;
  }

  if (authState.status === 'profile-unavailable') {
    // セッションは生きているのでログイン画面には戻さない。再試行だけを提示する
    return (
      <View className="flex-1 justify-center bg-neutral-50">
        <ErrorState
          title={PROFILE_UNAVAILABLE_TITLE}
          description={PROFILE_UNAVAILABLE_DESCRIPTION}
          onRetry={authState.retry}
          testID={PROFILE_UNAVAILABLE_TEST_ID}
        />
      </View>
    );
  }

  return <Redirect href={ROLE_HOME_ROUTES[authState.role]} />;
}
```

- [ ] **Step 3: `app/+not-found.tsx` を作る**

```tsx
// apps/mobile/src/app/+not-found.tsx
import { router } from 'expo-router';
import { Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ROOT_ROUTE } from '@/constants/auth';

const NOT_FOUND_TITLE = 'ページが見つかりません';
const NOT_FOUND_DESCRIPTION = 'リンクが古いか、移動した可能性があります。';
const BACK_TO_ROOT_LABEL = 'ホームに戻る';

/**
 * 未定義パスの受け皿。ロールごとのホームは index が決めるので、ここは常に `/` へ戻す。
 * push ではなく replace にして、戻るボタンで 404 に戻れないようにする。
 */
export default function NotFoundScreen() {
  return (
    <View className="flex-1 items-center justify-center gap-md bg-neutral-50 px-lg">
      <Text className="font-body-bold text-xl text-neutral-900">{NOT_FOUND_TITLE}</Text>
      <Text className="text-center font-body text-base text-neutral-600">
        {NOT_FOUND_DESCRIPTION}
      </Text>
      <Button
        label={BACK_TO_ROOT_LABEL}
        onPress={() => router.replace(ROOT_ROUTE)}
        testID="not-found-root-button"
      />
    </View>
  );
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- src/app/index`
Expected: PASS（7 件）

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`if (authState.status === 'restoring')` の分岐を `return <Redirect href={WELCOME_ROUTE} />;` に書き換え、「復元中はローディングを出し、ログイン画面へは飛ばさない」が**失敗すること**を確認する。
続けて `profile-unavailable` の分岐を `<Redirect href={WELCOME_ROUTE} />` に書き換え、「プロフィール取得に失敗したらエラーと再試行を出し、ログイン画面へは飛ばさない」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 6: コミットする**

```bash
git add apps/mobile/src/app/index.tsx apps/mobile/src/app/index.test.tsx apps/mobile/src/app/+not-found.tsx
git commit -m "feat(mobile): index をロールディスパッチャにし 404 画面を追加する"
```

---

### Task 5-10: Input にキーボード挙動・onBlur・無効化を追加する

**追加する理由:** 認証フォームは「メールアドレス用キーボード」「自動大文字化オフ」「パスワードマネージャ連携」「送信中は入力を止める」「RHF に blur を伝える」がすべて必要で、現在の `Input` はそのどれも表現できない。個別 prop を 5 つ足すと呼び出し側で組み合わせを間違えるため、**キーボード挙動は `textBehavior` 1 つにまとめ、用途ごとのプリセットを定数で持つ**（規約 3.4 の「呼び出し側に分岐を書かせない」に合わせる）。

**Files:**

- Modify: `apps/mobile/src/components/ui/input.tsx`
- Modify: `apps/mobile/src/components/ui/input.test.tsx`（既存 17 件はそのまま残し、回帰テストとして追記する）

**Interfaces:**

- Consumes: `KeyboardTypeOptions` / `TextInputProps`（`react-native`。値は `node_modules/react-native/Libraries/Components/TextInput/TextInput.d.ts` で確認済み）
- Produces:
  - `interface InputTextBehavior { keyboardType?: KeyboardTypeOptions | undefined; autoCapitalize?: TextInputProps['autoCapitalize']; autoComplete?: TextInputProps['autoComplete']; textContentType?: TextInputProps['textContentType']; isSecureTextEntry?: boolean | undefined }`
  - `const INPUT_TEXT_BEHAVIORS: { email; currentPassword; newPassword; personName; telephone }`
  - `InputProps` に `onBlur?: (() => void) | undefined` / `isDisabled?: boolean | undefined` / `textBehavior?: InputTextBehavior | undefined` を追加

- [ ] **Step 1: 失敗するテストを書く（既存ファイルの末尾に追記）**

```tsx
// apps/mobile/src/components/ui/input.test.tsx の describe('Input') の中に追記する
// ファイル先頭の import に INPUT_TEXT_BEHAVIORS を足す:
//   import { INPUT_TEXT_BEHAVIORS, Input } from './input';

it('textBehavior を渡すとキーボードと自動補完の設定が反映される', async () => {
  await render(
    <Input
      label="メールアドレス"
      value=""
      onChangeText={jest.fn()}
      textBehavior={INPUT_TEXT_BEHAVIORS.email}
      testID={INPUT_TEST_ID}
    />,
  );

  const input = screen.getByTestId(INPUT_TEST_ID);
  expect(input).toHaveProp('keyboardType', 'email-address');
  expect(input).toHaveProp('autoCapitalize', 'none');
  expect(input).toHaveProp('autoComplete', 'email');
  expect(input).toHaveProp('textContentType', 'emailAddress');
});

it('textBehavior にパスワードを指定すると入力が伏せ字になる', async () => {
  await render(
    <Input
      label="パスワード"
      value=""
      onChangeText={jest.fn()}
      textBehavior={INPUT_TEXT_BEHAVIORS.currentPassword}
      testID={INPUT_TEST_ID}
    />,
  );

  expect(screen.getByTestId(INPUT_TEST_ID)).toHaveProp('secureTextEntry', true);
});

it('textBehavior を渡さないときは伏せ字にしない（既存の呼び出しの回帰）', async () => {
  await render(<Input label="店名" value="" onChangeText={jest.fn()} testID={INPUT_TEST_ID} />);

  expect(screen.getByTestId(INPUT_TEST_ID)).toHaveProp('secureTextEntry', false);
});

it('フォーカスが外れると onBlur が呼ばれる', async () => {
  const onBlur = jest.fn();
  await render(
    <Input label="店名" value="" onChangeText={jest.fn()} onBlur={onBlur} testID={INPUT_TEST_ID} />,
  );

  await fireEvent(screen.getByTestId(INPUT_TEST_ID), 'blur');

  expect(onBlur).toHaveBeenCalledTimes(1);
});

it('isDisabled のとき入力を受け付けない', async () => {
  await render(
    <Input label="店名" value="" onChangeText={jest.fn()} isDisabled testID={INPUT_TEST_ID} />,
  );

  const input = screen.getByTestId(INPUT_TEST_ID);
  expect(input).toHaveProp('editable', false);
  expect(input).toHaveProp('accessibilityState', { disabled: true });
});

it('isDisabled でないときは入力を受け付ける（既存の呼び出しの回帰）', async () => {
  await render(<Input label="店名" value="" onChangeText={jest.fn()} testID={INPUT_TEST_ID} />);

  expect(screen.getByTestId(INPUT_TEST_ID)).toHaveProp('editable', true);
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- components/ui/input`
Expected: FAIL（6 件。`INPUT_TEXT_BEHAVIORS` が未 export、`secureTextEntry` などが `undefined`）

- [ ] **Step 2: `components/ui/input.tsx` の型とプリセットを追加する**

ファイル先頭の import と `InputProps` を次のように書き換える。

```tsx
import type { KeyboardTypeOptions, TextInputProps } from 'react-native';
import { Text, TextInput, View } from 'react-native';

import { COLORS } from '@/constants/theme';

/**
 * キーボードと自動補完まわりの設定をひとまとめにした型。
 * keyboardType / autoCapitalize / autoComplete / textContentType は
 * 「メールアドレス欄」「新しいパスワード欄」のように**組み合わせで**意味が決まる。
 * 個別 prop にすると呼び出し側で組み合わせを間違えるため 1 つにまとめる。
 */
export interface InputTextBehavior {
  keyboardType?: KeyboardTypeOptions | undefined;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoComplete?: TextInputProps['autoComplete'];
  textContentType?: TextInputProps['textContentType'];
  isSecureTextEntry?: boolean | undefined;
}

/**
 * 用途ごとのプリセット。画面が個別に keyboardType を書き分けるとズレるので、
 * 「この欄は何を入れる欄か」だけを選ばせる。
 * 値は node_modules/react-native/Libraries/Components/TextInput/TextInput.d.ts の
 * autoComplete / textContentType の union にあるものだけを使っている。
 */
export const INPUT_TEXT_BEHAVIORS = {
  email: {
    keyboardType: 'email-address',
    autoCapitalize: 'none',
    autoComplete: 'email',
    textContentType: 'emailAddress',
  },
  currentPassword: {
    autoCapitalize: 'none',
    autoComplete: 'current-password',
    textContentType: 'password',
    isSecureTextEntry: true,
  },
  newPassword: {
    autoCapitalize: 'none',
    autoComplete: 'new-password',
    textContentType: 'newPassword',
    isSecureTextEntry: true,
  },
  personName: {
    autoCapitalize: 'words',
    autoComplete: 'name',
    textContentType: 'name',
  },
  telephone: {
    keyboardType: 'phone-pad',
    autoCapitalize: 'none',
    autoComplete: 'tel',
    textContentType: 'telephoneNumber',
  },
} as const satisfies Record<string, InputTextBehavior>;

export interface InputProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  /** フォーカスが外れたときの通知。react-hook-form の onBlur をそのまま渡す */
  onBlur?: (() => void) | undefined;
  placeholder?: string | undefined;
  errorMessage?: string | undefined;
  isRequired?: boolean | undefined;
  isMultiline?: boolean | undefined;
  /** 送信中など、一時的に入力を止めたいとき */
  isDisabled?: boolean | undefined;
  maxLength?: number | undefined;
  textBehavior?: InputTextBehavior | undefined;
  testID?: string | undefined;
}
```

- [ ] **Step 3: `Input` 本体に反映する**

`BORDER_STYLES` の直後に無効化時のスタイルを足す。

```tsx
/** 入力可否で面の色を変える。押せない欄が白いままだと「入力できるのに反応しない」と誤解される */
const SURFACE_STYLES = {
  enabled: 'bg-white text-neutral-900',
  disabled: 'bg-neutral-100 text-neutral-500',
} as const;
```

関数シグネチャと `TextInput` を次のように書き換える。

```tsx
export function Input({
  label,
  value,
  onChangeText,
  onBlur,
  placeholder,
  errorMessage,
  isRequired = false,
  isMultiline = false,
  isDisabled = false,
  maxLength,
  textBehavior,
  testID,
}: InputProps) {
  const hasError = errorMessage !== undefined && errorMessage !== '';
  const hasCounter = maxLength !== undefined;

  return (
    <View className="gap-xs">
      <View className="flex-row items-center gap-xs">
        <Text className="font-body-medium text-sm text-neutral-700">{label}</Text>
        {isRequired ? (
          <Text className="rounded-full bg-red-50 px-xs py-px font-body-medium text-xs text-red-700">
            {REQUIRED_MARK_LABEL}
          </Text>
        ) : null}
      </View>

      <TextInput
        accessibilityLabel={buildAccessibilityLabel(label, isRequired, errorMessage)}
        // AccessibilityState が持つ 5 つのうち disabled だけがこの部品に関係する
        accessibilityState={{ disabled: isDisabled }}
        autoCapitalize={textBehavior?.autoCapitalize}
        autoComplete={textBehavior?.autoComplete}
        className={[
          'rounded-card border px-md py-sm font-body text-base',
          isDisabled ? SURFACE_STYLES.disabled : SURFACE_STYLES.enabled,
          hasError ? BORDER_STYLES.error : BORDER_STYLES.default,
        ].join(' ')}
        editable={!isDisabled}
        keyboardType={textBehavior?.keyboardType}
        maxLength={maxLength}
        multiline={isMultiline}
        onBlur={onBlur}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={COLORS.neutral[400]}
        // 既定を false で固定する。undefined のままだと端末によって挙動が割れる
        secureTextEntry={textBehavior?.isSecureTextEntry ?? false}
        // 高さは MULTILINE_MIN_HEIGHT_PX と二重管理にしないよう className ではなく style で与える。
        // textAlignVertical は Android で入力が上端から始まるようにするため必要
        style={
          isMultiline ? { minHeight: MULTILINE_MIN_HEIGHT_PX, textAlignVertical: 'top' } : null
        }
        testID={testID}
        textContentType={textBehavior?.textContentType}
        value={value}
      />

      {hasError || hasCounter ? (
        <View className="flex-row items-start gap-sm">
          {hasError ? (
            <Text accessibilityRole="alert" className="flex-1 font-body text-xs text-red-700">
              {errorMessage}
            </Text>
          ) : null}
          {hasCounter ? (
            <Text className="ml-auto font-body text-xs text-neutral-500">
              {`${value.length}/${maxLength}`}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
```

**注記:** `bg-white` / `text-neutral-900` を `SURFACE_STYLES` に移したため、既存テスト「errorMessage があるとき枠線が danger 色になる」が使う `BORDER_COLOR_CLASS_PATTERN` の対象は変わらない（`border-red-500` / `border-neutral-300` はそのまま残る）。

- [ ] **Step 4: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- components/ui/input`
Expected: PASS（既存 17 件 + 追加 6 件 = 23 件）。**既存 17 件が 1 件も落ちないことが回帰テストの合格条件。**

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`secureTextEntry={textBehavior?.isSecureTextEntry ?? false}` を `secureTextEntry={textBehavior?.isSecureTextEntry}` に書き換え、「textBehavior を渡さないときは伏せ字にしない」が**失敗すること**を確認する。
続けて `editable={!isDisabled}` を削除し、「isDisabled のとき入力を受け付けない」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 6: カタログ画面が壊れていないことを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- catalog`
Expected: PASS（`_dev/catalog.tsx` は `Input` を既存の prop だけで呼んでいるので影響しないはず。落ちたら prop の既定値の付け方を見直す）

- [ ] **Step 7: コミットする**

```bash
git add apps/mobile/src/components/ui/input.tsx apps/mobile/src/components/ui/input.test.tsx
git commit -m "feat(mobile): Input にキーボード挙動・onBlur・無効化を追加する"
```

---

### Task 5-11: PasswordInput を作る

**追加する理由:** パスワード欄は「伏せ字の切り替え」が要る。`Input` 本体に入れると店名やメールの欄にも無意味な prop が生えるため、**`Input` を包む別部品**にする。sign-in / sign-up / （Phase 6 の）パスワード変更の 3 箇所で使うので、規約 3.4 の「3 箇所以上で使うなら `components/ui/`」を満たす。

**Files:**

- Create: `apps/mobile/src/components/ui/password-input.tsx`
- Create: `apps/mobile/src/components/ui/password-input.test.tsx`

**Interfaces:**

- Consumes: `Input` / `InputTextBehavior` / `INPUT_TEXT_BEHAVIORS`（Task 5-10）、`Icon`（既存）、`Eye` / `EyeOff`（`lucide-react-native`。`node_modules/lucide-react-native/dist/types/icons/eye.d.ts` / `eye-off.d.ts` で実在確認済み）
- Produces:
  - `interface PasswordInputProps { label: string; value: string; onChangeText: (text: string) => void; onBlur?: (() => void) | undefined; errorMessage?: string | undefined; isRequired?: boolean | undefined; isDisabled?: boolean | undefined; isNewPassword?: boolean | undefined; testID?: string | undefined }`
  - `function PasswordInput(props: PasswordInputProps): ReactElement`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/components/ui/password-input.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { PasswordInput } from './password-input';

const PASSWORD_TEST_ID = 'password-input';
const TOGGLE_TEST_ID = 'password-input-visibility-toggle';

describe('PasswordInput', () => {
  it('初期状態では入力を伏せ字にする', async () => {
    await render(
      <PasswordInput
        label="パスワード"
        value="Passw0rd!"
        onChangeText={jest.fn()}
        testID={PASSWORD_TEST_ID}
      />,
    );

    expect(screen.getByTestId(PASSWORD_TEST_ID)).toHaveProp('secureTextEntry', true);
  });

  it('切り替えボタンで伏せ字を解除できる', async () => {
    await render(
      <PasswordInput
        label="パスワード"
        value="Passw0rd!"
        onChangeText={jest.fn()}
        testID={PASSWORD_TEST_ID}
      />,
    );

    await fireEvent.press(screen.getByTestId(TOGGLE_TEST_ID));

    expect(screen.getByTestId(PASSWORD_TEST_ID)).toHaveProp('secureTextEntry', false);
  });

  it('もう一度押すと伏せ字に戻る', async () => {
    await render(
      <PasswordInput
        label="パスワード"
        value="Passw0rd!"
        onChangeText={jest.fn()}
        testID={PASSWORD_TEST_ID}
      />,
    );

    await fireEvent.press(screen.getByTestId(TOGGLE_TEST_ID));
    await fireEvent.press(screen.getByTestId(TOGGLE_TEST_ID));

    expect(screen.getByTestId(PASSWORD_TEST_ID)).toHaveProp('secureTextEntry', true);
  });

  it('切り替えボタンの読み上げ文言が状態に追従する', async () => {
    await render(
      <PasswordInput
        label="パスワード"
        value="Passw0rd!"
        onChangeText={jest.fn()}
        testID={PASSWORD_TEST_ID}
      />,
    );

    expect(screen.getByLabelText('パスワードを表示する')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId(TOGGLE_TEST_ID));

    expect(screen.getByLabelText('パスワードを隠す')).toBeOnTheScreen();
  });

  it('isNewPassword のときは新しいパスワード用の自動補完になる', async () => {
    await render(
      <PasswordInput
        label="パスワード"
        value=""
        onChangeText={jest.fn()}
        isNewPassword
        testID={PASSWORD_TEST_ID}
      />,
    );

    expect(screen.getByTestId(PASSWORD_TEST_ID)).toHaveProp('autoComplete', 'new-password');
  });

  it('isNewPassword でないときは既存パスワード用の自動補完になる', async () => {
    await render(
      <PasswordInput
        label="パスワード"
        value=""
        onChangeText={jest.fn()}
        testID={PASSWORD_TEST_ID}
      />,
    );

    expect(screen.getByTestId(PASSWORD_TEST_ID)).toHaveProp('autoComplete', 'current-password');
  });

  it('errorMessage を Input にそのまま渡す', async () => {
    await render(
      <PasswordInput
        label="パスワード"
        value=""
        onChangeText={jest.fn()}
        errorMessage="8 文字以上で入力してください"
        testID={PASSWORD_TEST_ID}
      />,
    );

    expect(screen.getByText('8 文字以上で入力してください')).toBeOnTheScreen();
  });

  it('isDisabled のときは切り替えボタンも押せない', async () => {
    await render(
      <PasswordInput
        label="パスワード"
        value="Passw0rd!"
        onChangeText={jest.fn()}
        isDisabled
        testID={PASSWORD_TEST_ID}
      />,
    );

    await fireEvent.press(screen.getByTestId(TOGGLE_TEST_ID));

    // 送信中に伏せ字が外れると、肩越しにパスワードを見られる事故につながる
    expect(screen.getByTestId(PASSWORD_TEST_ID)).toHaveProp('secureTextEntry', true);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- password-input`
Expected: FAIL（`Cannot find module './password-input'`）

- [ ] **Step 2: `components/ui/password-input.tsx` を作る**

```tsx
// apps/mobile/src/components/ui/password-input.tsx
import { Eye, EyeOff } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Icon } from './icon';
import { INPUT_TEXT_BEHAVIORS, Input } from './input';

/** 切り替えボタンの文言。読み上げラベルと表示文字を同じにしてズレを防ぐ */
const SHOW_PASSWORD_LABEL = 'パスワードを表示する';
const HIDE_PASSWORD_LABEL = 'パスワードを隠す';

/** 切り替えボタンの testID サフィックス。テスト側と綴りがずれないよう定数にする */
const TOGGLE_TEST_ID_SUFFIX = 'visibility-toggle';

export interface PasswordInputProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  onBlur?: (() => void) | undefined;
  errorMessage?: string | undefined;
  isRequired?: boolean | undefined;
  isDisabled?: boolean | undefined;
  /** 新規登録・再設定など「これから決めるパスワード」なら true */
  isNewPassword?: boolean | undefined;
  testID?: string | undefined;
}

/** 親が testID を持たないときは子にも付けない */
function buildToggleTestId(testID: string | undefined): string | undefined {
  return testID === undefined ? undefined : `${testID}-${TOGGLE_TEST_ID_SUFFIX}`;
}

/**
 * 伏せ字の切り替えが付いたパスワード入力。
 * 切り替えボタンは入力欄の下に置く。RN の TextInput は装飾要素を内側に差し込めず、
 * 絶対配置で重ねると Android で入力領域を奪ってしまうため。
 */
export function PasswordInput({
  label,
  value,
  onChangeText,
  onBlur,
  errorMessage,
  isRequired = false,
  isDisabled = false,
  isNewPassword = false,
  testID,
}: PasswordInputProps) {
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);

  const togglePasswordVisibility = useCallback(() => {
    // 送信中に伏せ字が外れると肩越しに見られる事故につながるので、無効時は切り替えない
    if (isDisabled) {
      return;
    }
    setIsPasswordVisible((isVisible) => !isVisible);
  }, [isDisabled]);

  const baseBehavior = isNewPassword
    ? INPUT_TEXT_BEHAVIORS.newPassword
    : INPUT_TEXT_BEHAVIORS.currentPassword;
  const toggleLabel = isPasswordVisible ? HIDE_PASSWORD_LABEL : SHOW_PASSWORD_LABEL;

  return (
    <View className="gap-xs">
      <Input
        errorMessage={errorMessage}
        isDisabled={isDisabled}
        isRequired={isRequired}
        label={label}
        onBlur={onBlur}
        onChangeText={onChangeText}
        testID={testID}
        textBehavior={{ ...baseBehavior, isSecureTextEntry: !isPasswordVisible }}
        value={value}
      />

      <Pressable
        accessibilityLabel={toggleLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled }}
        className="flex-row items-center gap-xs self-end px-xs py-xs"
        onPress={togglePasswordVisibility}
        testID={buildToggleTestId(testID)}
      >
        <Icon icon={isPasswordVisible ? EyeOff : Eye} size="sm" />
        <Text className="font-body text-xs text-neutral-600">{toggleLabel}</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 3: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- password-input`
Expected: PASS（8 件）

- [ ] **Step 4: わざと壊してテストが落ちることを確認する**

`togglePasswordVisibility` の `if (isDisabled) { return; }` を削除し、「isDisabled のときは切り替えボタンも押せない」が**失敗すること**を確認する。
続けて `textBehavior={{ ...baseBehavior, isSecureTextEntry: !isPasswordVisible }}` を `textBehavior={baseBehavior}` に書き換え、「切り替えボタンで伏せ字を解除できる」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 5: コミットする**

```bash
git add apps/mobile/src/components/ui/password-input.tsx apps/mobile/src/components/ui/password-input.test.tsx
git commit -m "feat(mobile): 伏せ字を切り替えられる PasswordInput を追加する"
```

---

### Task 5-12: 認証フォームの共通部品を作る（文言変換 / エラーバナー / 画面の外枠）

**追加する理由:** sign-in / sign-up / forgot-password の 3 画面が「キーボードを避ける外枠」「送信失敗の理由を出すバナー」「例外 → 表示文言の変換」を同じように必要とする。先に共通部品を出しておかないと 3 画面でコピーが増える（規約 3.4）。

**Files:**

- Modify: `apps/mobile/src/features/auth/auth-error.ts`
- Modify: `apps/mobile/src/features/auth/auth-error.test.ts`
- Create: `apps/mobile/src/components/auth/form-error-banner.tsx`
- Create: `apps/mobile/src/components/auth/form-error-banner.test.tsx`
- Create: `apps/mobile/src/components/auth/auth-form-screen.tsx`
- Create: `apps/mobile/src/components/auth/auth-form-screen.test.tsx`

**Interfaces:**

- Consumes: `AuthError` / `AUTH_ERROR_MESSAGES`（Task 5-4）、`KeyboardAvoidingView` / `ScrollView`（`react-native`）、`contentContainerClassName`（`node_modules/react-native-css-interop/types.d.ts:23` が `ScrollViewProps` に生やしている。`nativewind-env.d.ts` の `/// <reference types="nativewind/types" />` 経由で型が入る）
- Produces:
  - `function toDisplayMessage(error: unknown): string | undefined`
  - `interface FormErrorBannerProps { message?: string | undefined; testID?: string | undefined }`
  - `function FormErrorBanner(props: FormErrorBannerProps): ReactElement | null`
  - `interface AuthFormScreenProps { title: string; description?: string | undefined; children: ReactNode; testID?: string | undefined }`
  - `function AuthFormScreen(props: AuthFormScreenProps): ReactElement`
  - `const AUTH_FORM_DESCRIPTION_TEST_ID: string`

- [ ] **Step 1: `toDisplayMessage` の失敗するテストを書く（既存ファイルに追記）**

```ts
// apps/mobile/src/features/auth/auth-error.test.ts の末尾に追記する
// ファイル先頭の import に toDisplayMessage を足す:
//   import { AUTH_ERROR_MESSAGES, AuthError, toAuthError, toDisplayMessage } from './auth-error';

describe('toDisplayMessage', () => {
  it('エラーが無ければ undefined を返す', () => {
    expect(toDisplayMessage(null)).toBeUndefined();
    expect(toDisplayMessage(undefined)).toBeUndefined();
  });

  it('AuthError はそのままの文言を返す', () => {
    expect(toDisplayMessage(new AuthError('invalid-credentials'))).toBe(
      AUTH_ERROR_MESSAGES['invalid-credentials'],
    );
  });

  it('AuthError 以外の例外は中身を画面に出さない', () => {
    // スタックやサーバ内部のメッセージがそのまま表示されるのを防ぐ
    const message = toDisplayMessage(new Error('D1_ERROR: no such table: profiles'));

    expect(message).toBe(AUTH_ERROR_MESSAGES.unknown);
    expect(message).not.toContain('D1_ERROR');
  });

  it('Error ですらない値が投げられても既定文言に落とす', () => {
    expect(toDisplayMessage('boom')).toBe(AUTH_ERROR_MESSAGES.unknown);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- auth-error`
Expected: FAIL（`toDisplayMessage` が export されていない）

- [ ] **Step 2: `features/auth/auth-error.ts` の末尾に `toDisplayMessage` を足す**

```ts
/**
 * 例外を画面に出せる文言へ変換する。
 * AuthError は toAuthError が付けた日本語をそのまま使う。
 * それ以外はサーバ内部の文言やスタックが混じりうるので、中身を捨てて既定文言にする。
 * 例外の内容自体は呼び出し側で logger に残す前提（画面には出さない）。
 */
export function toDisplayMessage(error: unknown): string | undefined {
  if (error === null || error === undefined) {
    return undefined;
  }

  return error instanceof AuthError ? error.message : AUTH_ERROR_MESSAGES.unknown;
}
```

- [ ] **Step 3: `FormErrorBanner` の失敗するテストを書く**

```tsx
// apps/mobile/src/components/auth/form-error-banner.test.tsx
import { render, screen } from '@testing-library/react-native';

import { FormErrorBanner } from './form-error-banner';

const BANNER_TEST_ID = 'form-error-banner';

describe('FormErrorBanner', () => {
  it('メッセージがあれば表示する', async () => {
    await render(<FormErrorBanner message="メールアドレスまたはパスワードが正しくありません。" />);

    expect(
      screen.getByText('メールアドレスまたはパスワードが正しくありません。'),
    ).toBeOnTheScreen();
  });

  it('メッセージが無ければ何も描画しない', async () => {
    await render(<FormErrorBanner />);

    expect(screen.queryByTestId(BANNER_TEST_ID)).toBeNull();
  });

  it('空文字も「エラー無し」として扱う（空の赤枠を出さない）', async () => {
    await render(<FormErrorBanner message="" />);

    expect(screen.queryByTestId(BANNER_TEST_ID)).toBeNull();
  });

  it('スクリーンリーダーに警告として伝える', async () => {
    await render(<FormErrorBanner message="通信に失敗しました。" />);

    expect(screen.getByTestId(BANNER_TEST_ID)).toHaveProp('accessibilityRole', 'alert');
  });

  it('testID を渡すと差し替えられる', async () => {
    await render(<FormErrorBanner message="通信に失敗しました。" testID="sign-in-error" />);

    expect(screen.getByTestId('sign-in-error')).toBeOnTheScreen();
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- form-error-banner`
Expected: FAIL（`Cannot find module './form-error-banner'`）

- [ ] **Step 4: `components/auth/form-error-banner.tsx` を作る**

```tsx
// apps/mobile/src/components/auth/form-error-banner.tsx
import { Text, View } from 'react-native';

/** 既定の testID。画面側が testID を省略してもテストから掴めるようにする */
const DEFAULT_TEST_ID = 'form-error-banner';

export interface FormErrorBannerProps {
  /** 表示する文言。undefined または空文字なら何も描画しない */
  message?: string | undefined;
  testID?: string | undefined;
}

/**
 * 「サーバに断られた理由」をフォーム上部にまとめて出す。
 * 入力欄ごとの検証エラー（Input の errorMessage）とは役割が別で、
 * こちらは送信後にしか出ない。両方を同じ場所に出すと原因が分かりにくくなるため分ける。
 */
export function FormErrorBanner({ message, testID = DEFAULT_TEST_ID }: FormErrorBannerProps) {
  if (message === undefined || message === '') {
    return null;
  }

  return (
    <View
      // Android では live region 指定が無いと、後から現れた文言が読み上げられない
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      className="rounded-card border border-red-500 bg-red-50 px-md py-sm"
      testID={testID}
    >
      <Text className="font-body text-sm text-red-700">{message}</Text>
    </View>
  );
}
```

- [ ] **Step 5: `AuthFormScreen` の失敗するテストを書く**

```tsx
// apps/mobile/src/components/auth/auth-form-screen.test.tsx
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AUTH_FORM_DESCRIPTION_TEST_ID, AuthFormScreen } from './auth-form-screen';

describe('AuthFormScreen', () => {
  it('タイトルを見出しとして表示する', async () => {
    await render(
      <AuthFormScreen title="ログイン">
        <Text>中身</Text>
      </AuthFormScreen>,
    );

    expect(screen.getByRole('header', { name: 'ログイン' })).toBeOnTheScreen();
  });

  it('子要素をそのまま描画する', async () => {
    await render(
      <AuthFormScreen title="ログイン">
        <Text>中身</Text>
      </AuthFormScreen>,
    );

    expect(screen.getByText('中身')).toBeOnTheScreen();
  });

  it('description を渡すと説明文を表示する', async () => {
    await render(
      <AuthFormScreen title="ログイン" description="メールアドレスでログインします">
        <Text>中身</Text>
      </AuthFormScreen>,
    );

    expect(screen.getByTestId(AUTH_FORM_DESCRIPTION_TEST_ID)).toHaveTextContent(
      'メールアドレスでログインします',
    );
  });

  it('description を省略すると説明文の枠自体を描画しない', async () => {
    await render(
      <AuthFormScreen title="ログイン">
        <Text>中身</Text>
      </AuthFormScreen>,
    );

    expect(screen.queryByTestId(AUTH_FORM_DESCRIPTION_TEST_ID)).toBeNull();
  });

  it('キーボードが出ている状態でも 1 回のタップでボタンが押せる設定にする', async () => {
    await render(
      <AuthFormScreen title="ログイン" testID="sign-in-screen">
        <Text>中身</Text>
      </AuthFormScreen>,
    );

    // handled でないと 1 回目のタップがキーボードを閉じるだけで終わり、
    // 「ログインボタンが 2 回押さないと効かない」不具合になる
    expect(screen.getByTestId('sign-in-screen')).toHaveProp('keyboardShouldPersistTaps', 'handled');
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- auth-form-screen`
Expected: FAIL（`Cannot find module './auth-form-screen'`）

- [ ] **Step 6: `components/auth/auth-form-screen.tsx` を作る**

```tsx
// apps/mobile/src/components/auth/auth-form-screen.tsx
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';

/** 既定の testID。画面側が testID を省略してもテストから掴めるようにする */
const DEFAULT_TEST_ID = 'auth-form-screen';

/** 説明文の testID。「省略したら描画しない」をテストで確かめるため固定値にする */
export const AUTH_FORM_DESCRIPTION_TEST_ID = `${DEFAULT_TEST_ID}-description`;

/**
 * iOS はキーボードがビューに被さるので、ビュー側の高さを詰める必要がある。
 * Android は android:windowSoftInputMode=adjustResize（Expo の既定）で OS 側が詰めるため、
 * behavior を付けると二重に縮んで入力欄が見切れる。だから undefined のままにする。
 * KeyboardAvoidingViewProps の behavior は `| undefined` を含むので明示的に渡してよい
 * （node_modules/react-native/Libraries/Components/Keyboard/KeyboardAvoidingView.d.ts:27）。
 */
const KEYBOARD_BEHAVIOR = Platform.OS === 'ios' ? 'padding' : undefined;

export interface AuthFormScreenProps {
  title: string;
  description?: string | undefined;
  children: ReactNode;
  testID?: string | undefined;
}

/**
 * 認証系フォーム画面の外枠。
 * キーボード回避・スクロール・見出しをここに閉じ込め、
 * 各画面は入力欄とボタンだけを書けばよいようにする。
 */
export function AuthFormScreen({
  title,
  description,
  children,
  testID = DEFAULT_TEST_ID,
}: AuthFormScreenProps) {
  return (
    <KeyboardAvoidingView behavior={KEYBOARD_BEHAVIOR} className="flex-1 bg-neutral-50">
      <ScrollView
        // 内容が短いときは中央、長いときはスクロールさせる
        contentContainerClassName="grow justify-center gap-lg px-lg py-xl"
        keyboardShouldPersistTaps="handled"
        testID={testID}
      >
        <View className="gap-xs">
          <Text accessibilityRole="header" className="font-display-bold text-xxl text-neutral-900">
            {title}
          </Text>
          {description === undefined ? null : (
            <Text
              className="font-body text-sm text-neutral-600"
              testID={AUTH_FORM_DESCRIPTION_TEST_ID}
            >
              {description}
            </Text>
          )}
        </View>

        <View className="gap-md">{children}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
```

- [ ] **Step 7: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- auth-error form-error-banner auth-form-screen`
Expected: PASS（`auth-error` は既存 7 件 + 追加 4 件、`form-error-banner` 5 件、`auth-form-screen` 5 件）

- [ ] **Step 8: わざと壊してテストが落ちることを確認する**

`toDisplayMessage` の `error instanceof AuthError ? error.message : AUTH_ERROR_MESSAGES.unknown` を `String(error)` に書き換え、「AuthError 以外の例外は中身を画面に出さない」が**失敗すること**を確認する。
続けて `FormErrorBanner` の `message === ''` の判定を削り、「空文字も『エラー無し』として扱う」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 9: 型を確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm run typecheck -w @meshimap/mobile`
Expected: エラーなし。`contentContainerClassName` が未知の prop として弾かれる場合は `nativewind-env.d.ts` の参照が効いていないので、`tsconfig.json` の `include` に `nativewind-env.d.ts` が残っているか確認する。

- [ ] **Step 10: コミットする**

```bash
git add apps/mobile/src/features/auth/auth-error.ts apps/mobile/src/features/auth/auth-error.test.ts apps/mobile/src/components/auth/form-error-banner.tsx apps/mobile/src/components/auth/form-error-banner.test.tsx apps/mobile/src/components/auth/auth-form-screen.tsx apps/mobile/src/components/auth/auth-form-screen.test.tsx
git commit -m "feat(mobile): 認証フォームの共通部品を追加する"
```

---

### Task 5-13: 認証ミューテーションの共通フックとサインイン画面を実装する

**設計上の要点 1（共通フック）:** sign-in / sign-up / パスワード再設定 / 確認メール再送の 4 つは、「送信中フラグ」「失敗理由を日本語にして公開」「画面側に例外を投げない」がまったく同じ。個別に `useMutation` を書くと 4 箇所にコピーが生まれるので、`useAuthMutation` を 1 つだけ置く（規約 3.4）。

**設計上の要点 2（成功後の遷移を書かない）:** サインインが成功すると `authClient.useSession()` のセッションが更新され、`AuthProvider` が `restoring` → `authenticated` と遷移する。するとルート `_layout.tsx` の `<Stack.Protected guard={status === 'unauthenticated'}>` が false になって `(auth)` が外れ、アンカーの `index.tsx` がロールごとの着地先へ飛ばす（Task 5-8 / 5-9）。画面側にも `router.replace` を書くと遷移が二重になり、戻る操作でログイン画面に戻れてしまう。

**Files:**

- Create: `apps/mobile/src/features/auth/use-auth-mutation.ts`
- Create: `apps/mobile/src/features/auth/use-auth-mutation.test.tsx`
- Modify: `apps/mobile/src/app/(auth)/sign-in.tsx`（Task 5-7 のプレースホルダを差し替える）
- Create: `apps/mobile/src/app/(auth)/sign-in.test.tsx`

**Interfaces:**

- Consumes:
  - `signInWithEmail(input: SignInInput): Promise<void>`（Task 5-4）
  - `toDisplayMessage(error: unknown): string | undefined`（Task 5-12）
  - `signInSchema` と `type SignInInput = { email: string; password: string }`（Task 5-4 で作った `@/features/auth/schema`。`@meshimap/core` には無い）
    - **前提:** `signInSchema` は `transform` を含まない（`z.input` と `z.output` が一致する）こと。`zodResolver` は `Resolver<z4.input<T>, Context, z4.output<T>>` を返すため（`node_modules/@hookform/resolvers/zod/dist/zod.d.ts`）、両者がズレると `useForm<SignInInput>` に代入できない
  - `useForm` / `Controller`（`react-hook-form` 7.88.0。`ControllerRenderProps` は `{ onChange; onBlur; value; name; ref }`。`node_modules/react-hook-form/dist/types/controller.d.ts:11`）
  - `AuthFormScreen` / `FormErrorBanner`（Task 5-12）、`Input` / `INPUT_TEXT_BEHAVIORS`（Task 5-10）、`PasswordInput`（Task 5-11）、`Button`（既存）
  - `FORGOT_PASSWORD_ROUTE` / `SIGN_UP_ROUTE`（Task 5-1）
- Produces:
  - `interface AuthMutationResult<TInput> { submit: (input: TInput) => Promise<boolean>; isSubmitting: boolean; errorMessage: string | undefined; hasSucceeded: boolean }`
  - `function useAuthMutation<TInput>(mutationFn: (input: TInput) => Promise<void>): AuthMutationResult<TInput>`
  - `export default function SignInScreen(): ReactElement`

- [ ] **Step 1: `useAuthMutation` の失敗するテストを書く**

```tsx
// apps/mobile/src/features/auth/use-auth-mutation.test.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { createQueryClient } from '@/lib/query-client';

import { AUTH_ERROR_MESSAGES, AuthError } from './auth-error';
import { useAuthMutation } from './use-auth-mutation';

interface Credentials {
  email: string;
  password: string;
}

const CREDENTIALS: Credentials = { email: 'taro@example.com', password: 'Passw0rd!' };

/** QueryClient はテストごとに作り直す。使い回すと前のテストの状態が残る */
function QueryWrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>;
}

/** RNTL 14 の renderHook は Promise を返す（dist/render-hook.d.ts） */
function renderAuthMutation(mutationFn: (input: Credentials) => Promise<void>) {
  return renderHook(() => useAuthMutation(mutationFn), { wrapper: QueryWrapper });
}

describe('useAuthMutation', () => {
  it('初期状態は送信中でも成功でもエラーでもない', async () => {
    const { result } = await renderAuthMutation(jest.fn());

    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.hasSucceeded).toBe(false);
    expect(result.current.errorMessage).toBeUndefined();
  });

  it('成功したら true を返し、入力をそのまま渡す', async () => {
    const mutationFn = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderAuthMutation(mutationFn);

    let didSucceed: boolean | undefined;
    await act(async () => {
      didSucceed = await result.current.submit(CREDENTIALS);
    });

    expect(didSucceed).toBe(true);
    expect(mutationFn).toHaveBeenCalledWith(CREDENTIALS);
  });

  it('成功したら hasSucceeded が true になる', async () => {
    const { result } = await renderAuthMutation(jest.fn().mockResolvedValue(undefined));

    await act(async () => {
      await result.current.submit(CREDENTIALS);
    });

    await waitFor(() => {
      expect(result.current.hasSucceeded).toBe(true);
    });
  });

  it('失敗しても例外を投げず false を返す（画面側に try/catch を書かせない）', async () => {
    const { result } = await renderAuthMutation(
      jest.fn().mockRejectedValue(new AuthError('invalid-credentials')),
    );

    let didSucceed: boolean | undefined;
    await act(async () => {
      didSucceed = await result.current.submit(CREDENTIALS);
    });

    expect(didSucceed).toBe(false);
  });

  it('失敗の理由を日本語の文言として公開する', async () => {
    const { result } = await renderAuthMutation(
      jest.fn().mockRejectedValue(new AuthError('invalid-credentials')),
    );

    await act(async () => {
      await result.current.submit(CREDENTIALS);
    });

    await waitFor(() => {
      expect(result.current.errorMessage).toBe(AUTH_ERROR_MESSAGES['invalid-credentials']);
    });
  });

  it('想定外の例外ではサーバ由来の文言を公開しない', async () => {
    const { result } = await renderAuthMutation(
      jest.fn().mockRejectedValue(new Error('D1_ERROR: no such table: profiles')),
    );

    await act(async () => {
      await result.current.submit(CREDENTIALS);
    });

    await waitFor(() => {
      expect(result.current.errorMessage).toBe(AUTH_ERROR_MESSAGES.unknown);
    });
  });

  it('送信中は isSubmitting が true になり、完了で false に戻る', async () => {
    let finishSubmit: (() => void) | undefined;
    const mutationFn = jest.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        finishSubmit = () => {
          resolve();
        };
      }),
    );
    const { result } = await renderAuthMutation(mutationFn);

    const submitPromise = result.current.submit(CREDENTIALS);
    await waitFor(() => {
      expect(result.current.isSubmitting).toBe(true);
    });

    finishSubmit?.();
    await act(async () => {
      await submitPromise;
    });

    expect(result.current.isSubmitting).toBe(false);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- use-auth-mutation`
Expected: FAIL（`Cannot find module './use-auth-mutation'`）

- [ ] **Step 2: `features/auth/use-auth-mutation.ts` を作る**

```ts
// apps/mobile/src/features/auth/use-auth-mutation.ts
import { useMutation } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toDisplayMessage } from './auth-error';

export interface AuthMutationResult<TInput> {
  /** 成功したら true。失敗時は false を返し、理由は errorMessage に入る */
  submit: (input: TInput) => Promise<boolean>;
  isSubmitting: boolean;
  errorMessage: string | undefined;
  /** 一度でも成功したか。「送信しました」のような完了表示に使う */
  hasSucceeded: boolean;
}

/**
 * 認証系ミューテーションの共通土台。
 * サインイン / 新規登録 / パスワード再設定 / 確認メール再送で、
 * 「送信中」「失敗理由を日本語で」「例外を投げない」の 3 点がまったく同じなのでここに 1 つだけ置く。
 */
export function useAuthMutation<TInput>(
  mutationFn: (input: TInput) => Promise<void>,
): AuthMutationResult<TInput> {
  const { mutateAsync, isPending, isSuccess, error } = useMutation<void, Error, TInput>({
    mutationFn,
  });

  const submit = useCallback(
    async (input: TInput): Promise<boolean> => {
      try {
        await mutateAsync(input);
        return true;
      } catch {
        // 例外の中身は error に入っており errorMessage から読める。
        // ここで握るのは、画面のイベントハンドラを try/catch だらけにしないため
        return false;
      }
    },
    // mutateAsync は参照が安定しているので依存に入れてよい
    [mutateAsync],
  );

  return {
    submit,
    isSubmitting: isPending,
    errorMessage: toDisplayMessage(error),
    hasSucceeded: isSuccess,
  };
}
```

- [ ] **Step 3: `useAuthMutation` のテストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- use-auth-mutation`
Expected: PASS（7 件）

- [ ] **Step 4: サインイン画面の失敗するテストを書く**

```tsx
// apps/mobile/src/app/(auth)/sign-in.test.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { FORGOT_PASSWORD_ROUTE, SIGN_UP_ROUTE } from '@/constants/auth';
import { AUTH_ERROR_MESSAGES, AuthError } from '@/features/auth/auth-error';
import { createQueryClient } from '@/lib/query-client';

const mockSignInWithEmail = jest.fn();
const mockPush = jest.fn();

jest.mock('@/features/auth/api', () => ({ signInWithEmail: mockSignInWithEmail }));
// 画面は router.push しか使わない。ナビゲータ無しで描画するためここだけ差し替える
jest.mock('expo-router', () => ({ router: { push: mockPush } }));

import SignInScreen from './sign-in';

const EMAIL_INPUT_TEST_ID = 'sign-in-email-input';
const PASSWORD_INPUT_TEST_ID = 'sign-in-password-input';
const SUBMIT_BUTTON_TEST_ID = 'sign-in-submit-button';
const ERROR_BANNER_TEST_ID = 'sign-in-error';

const VALID_EMAIL = 'taro@example.com';
const VALID_PASSWORD = 'Passw0rd!';

function renderSignInScreen() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <SignInScreen />
    </QueryClientProvider>,
  );
}

async function fillValidCredentials() {
  await fireEvent.changeText(screen.getByTestId(EMAIL_INPUT_TEST_ID), VALID_EMAIL);
  await fireEvent.changeText(screen.getByTestId(PASSWORD_INPUT_TEST_ID), VALID_PASSWORD);
}

describe('SignInScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('メールアドレス・パスワード・ログインボタンを表示する', async () => {
    await renderSignInScreen();

    expect(screen.getByTestId(EMAIL_INPUT_TEST_ID)).toBeOnTheScreen();
    expect(screen.getByTestId(PASSWORD_INPUT_TEST_ID)).toBeOnTheScreen();
    expect(screen.getByTestId(SUBMIT_BUTTON_TEST_ID)).toBeOnTheScreen();
  });

  it('初期表示ではエラーバナーを出さない', async () => {
    await renderSignInScreen();

    expect(screen.queryByTestId(ERROR_BANNER_TEST_ID)).toBeNull();
  });

  it('未入力のまま送信すると API を呼ばずに入力エラーを示す', async () => {
    await renderSignInScreen();

    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      // Input はエラー文言をアクセシビリティラベルに載せる（components/ui/input.tsx）
      expect(screen.getByTestId(EMAIL_INPUT_TEST_ID)).toHaveProp(
        'accessibilityLabel',
        expect.stringContaining('エラー: '),
      );
    });
    expect(mockSignInWithEmail).not.toHaveBeenCalled();
  });

  it('入力を検証してから API に渡す', async () => {
    mockSignInWithEmail.mockResolvedValue(undefined);
    await renderSignInScreen();

    await fillValidCredentials();
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(mockSignInWithEmail).toHaveBeenCalledWith({
        email: VALID_EMAIL,
        password: VALID_PASSWORD,
      });
    });
  });

  it('成功しても画面側では遷移しない（グループの切り替えに任せる）', async () => {
    mockSignInWithEmail.mockResolvedValue(undefined);
    await renderSignInScreen();

    await fillValidCredentials();
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(mockSignInWithEmail).toHaveBeenCalledTimes(1);
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('失敗したら理由をバナーに出す', async () => {
    mockSignInWithEmail.mockRejectedValue(new AuthError('invalid-credentials'));
    await renderSignInScreen();

    await fillValidCredentials();
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(ERROR_BANNER_TEST_ID)).toHaveTextContent(
        AUTH_ERROR_MESSAGES['invalid-credentials'],
      );
    });
  });

  it('失敗したらパスワードを画面に残さない（メールアドレスは残す）', async () => {
    mockSignInWithEmail.mockRejectedValue(new AuthError('invalid-credentials'));
    await renderSignInScreen();

    await fillValidCredentials();
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(PASSWORD_INPUT_TEST_ID)).toHaveProp('value', '');
    });
    // 打ち直しの手間が大きいメールアドレスは消さない
    expect(screen.getByTestId(EMAIL_INPUT_TEST_ID)).toHaveProp('value', VALID_EMAIL);
  });

  it('パスワード再設定への導線がある', async () => {
    await renderSignInScreen();

    await fireEvent.press(screen.getByTestId('sign-in-forgot-password-link'));

    expect(mockPush).toHaveBeenCalledWith(FORGOT_PASSWORD_ROUTE);
  });

  it('新規登録への導線がある', async () => {
    await renderSignInScreen();

    await fireEvent.press(screen.getByTestId('sign-in-sign-up-link'));

    expect(mockPush).toHaveBeenCalledWith(SIGN_UP_ROUTE);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- "app/(auth)/sign-in"`
Expected: FAIL（プレースホルダのままなので `sign-in-email-input` が見つからない）

- [ ] **Step 5: `app/(auth)/sign-in.tsx` を実装に差し替える**

```tsx
// apps/mobile/src/app/(auth)/sign-in.tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { router } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { AuthFormScreen } from '@/components/auth/auth-form-screen';
import { FormErrorBanner } from '@/components/auth/form-error-banner';
import { Button } from '@/components/ui/button';
import { INPUT_TEXT_BEHAVIORS, Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { FORGOT_PASSWORD_ROUTE, SIGN_UP_ROUTE } from '@/constants/auth';
import { signInWithEmail } from '@/features/auth/api';
import { signInSchema, type SignInInput } from '@/features/auth/schema';
import { useAuthMutation } from '@/features/auth/use-auth-mutation';

/**
 * 空文字で初期化する。undefined 始まりにすると react-hook-form が
 * 非制御入力とみなし、resetField でも画面の値が消えない。
 */
const EMPTY_SIGN_IN_INPUT: SignInInput = { email: '', password: '' };

export default function SignInScreen() {
  const { control, handleSubmit, resetField } = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    defaultValues: EMPTY_SIGN_IN_INPUT,
    // 入力中ずっと赤字が出るのを避け、一度フォーカスが外れてから検証する
    mode: 'onTouched',
  });
  const {
    submit: signIn,
    isSubmitting: isSigningIn,
    errorMessage,
  } = useAuthMutation(signInWithEmail);

  const submitSignIn = handleSubmit(async (values) => {
    const didSignIn = await signIn(values);

    if (!didSignIn) {
      // 通らなかったパスワードを画面に残さない。肩越しに見られる事故を減らし、
      // 打ち直しを促す。メールアドレスは打ち直しの手間が大きいので残す
      resetField('password');
    }
    // 成功時に遷移コードを書かないのは意図的。
    // セッションが変わると Stack.Protected が (auth) を閉じ、index.tsx が着地先へ飛ばす
  });

  return (
    <AuthFormScreen
      description="メールアドレスとパスワードでログインします"
      testID="sign-in-screen"
      title="ログイン"
    >
      <FormErrorBanner message={errorMessage} testID="sign-in-error" />

      <Controller
        control={control}
        name="email"
        render={({ field, fieldState }) => (
          <Input
            errorMessage={fieldState.error?.message}
            isDisabled={isSigningIn}
            isRequired
            label="メールアドレス"
            onBlur={field.onBlur}
            onChangeText={field.onChange}
            placeholder="taro@example.com"
            testID="sign-in-email-input"
            textBehavior={INPUT_TEXT_BEHAVIORS.email}
            value={field.value}
          />
        )}
      />

      <Controller
        control={control}
        name="password"
        render={({ field, fieldState }) => (
          <PasswordInput
            errorMessage={fieldState.error?.message}
            isDisabled={isSigningIn}
            isRequired
            label="パスワード"
            onBlur={field.onBlur}
            onChangeText={field.onChange}
            testID="sign-in-password-input"
            value={field.value}
          />
        )}
      />

      <Button
        isLoading={isSigningIn}
        label="ログイン"
        onPress={() => {
          // handleSubmit は Promise を返すが onPress は同期。
          // 失敗は errorMessage に出るので、ここでは void で捨ててよい
          void submitSignIn();
        }}
        testID="sign-in-submit-button"
      />

      <View className="gap-xs">
        <Button
          isDisabled={isSigningIn}
          label="パスワードをお忘れですか？"
          onPress={() => {
            router.push(FORGOT_PASSWORD_ROUTE);
          }}
          testID="sign-in-forgot-password-link"
          variant="ghost"
        />
        <Button
          isDisabled={isSigningIn}
          label="アカウントを新規作成する"
          onPress={() => {
            router.push(SIGN_UP_ROUTE);
          }}
          testID="sign-in-sign-up-link"
          variant="ghost"
        />
      </View>
    </AuthFormScreen>
  );
}
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- use-auth-mutation "app/(auth)/sign-in"`
Expected: PASS（`use-auth-mutation` 7 件 + `sign-in` 画面 9 件）
**「未入力のまま送信すると API を呼ばずに入力エラーを示す」が落ちる場合**は `@/features/auth/schema` の `signInSchema` が空文字を通している。`email` が `z.email()`、`password` が `z.string().min(1)` になっているか確認する（Task 5-4 Step 5）。

- [ ] **Step 7: わざと壊してテストが落ちることを確認する**

`if (!didSignIn) { resetField('password'); }` を削除し、「失敗したらパスワードを画面に残さない」が**失敗すること**を確認する。
続けて `submitSignIn` の中の `await signIn(values)` のあとに `router.push(SIGN_UP_ROUTE);` を足し、「成功しても画面側では遷移しない」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 8: 型と lint を確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm run typecheck -w @meshimap/mobile && npm run lint -w @meshimap/mobile`
Expected: エラーなし。`zodResolver(signInSchema)` が `useForm<SignInInput>` に代入できない場合、`signInSchema` に `z.input` と `z.output` をずらす要素（`transform` / `default` / `pipe`）が入っている。**ここで `as` で潰さず**、`@/features/auth/schema` 側から外す。

- [ ] **Step 9: コミットする**

```bash
git add apps/mobile/src/features/auth/use-auth-mutation.ts apps/mobile/src/features/auth/use-auth-mutation.test.tsx "apps/mobile/src/app/(auth)/sign-in.tsx" "apps/mobile/src/app/(auth)/sign-in.test.tsx"
git commit -m "feat(mobile): サインイン画面と認証ミューテーションの共通フックを追加する"
```

---

### Task 5-14: 新規登録画面を実装する

**設計上の要点（ここだけ成功時に遷移する）:** サインインと違い、新規登録の成功後は**確認メール待機画面へ `router.replace` する**。設計書 §5.1 が `verify-email.tsx` を「確認メール送信後の待機」と定めており、登録直後はまだセッションが無い＝グループが切り替わらないため、画面側で動かす必要がある。`push` ではなく `replace` を使うのは、戻る操作で登録フォームに戻れると二重登録を招くため。

**前提（apps/api / Phase 4 側の設定）:** Better Auth の `emailAndPassword` を `autoSignIn: false` / `requireEmailVerification: true` で設定すること。`autoSignIn: true` のままだと登録直後にセッションが張られ、`Stack.Protected` が `(auth)` を閉じてしまい、`verify-email` に到達できない。**この前提は本計画では検証できないため「未確認事項」にも記載する。**

**Files:**

- Modify: `apps/mobile/src/constants/auth.ts`
- Modify: `apps/mobile/src/constants/auth.test.ts`
- Modify: `apps/mobile/src/app/(auth)/sign-up.tsx`（Task 5-7 のプレースホルダを差し替える）
- Create: `apps/mobile/src/app/(auth)/sign-up.test.tsx`

**Interfaces:**

- Consumes:
  - `signUpWithEmail(input: SignUpInput): Promise<void>`（Task 5-4）
  - `useAuthMutation`（Task 5-13）、`AuthFormScreen` / `FormErrorBanner`（Task 5-12）、`Input` / `INPUT_TEXT_BEHAVIORS`（Task 5-10）、`PasswordInput`（Task 5-11）、`Button`（既存）
  - `signUpSchema` / `DISPLAY_NAME_MAX_LENGTH` と `type SignUpInput = { displayName: string; email: string; password: string }`（Task 5-4 の `@/features/auth/schema`。`z.input` と `z.output` が一致すること）
  - `HrefObject = { pathname: string; params?: UnknownInputParams }`（`node_modules/expo-router/build/typed-routes/types.d.ts:11`）
- Produces:
  - `function buildVerifyEmailRoute(email: string): Href`
  - `export default function SignUpScreen(): ReactElement`

- [ ] **Step 1: ルート生成関数の失敗するテストを書く（既存ファイルに追記）**

```ts
// apps/mobile/src/constants/auth.test.ts の describe('認証まわりの定数') の中に追記する
// ファイル先頭の import に buildVerifyEmailRoute と VERIFY_EMAIL_ROUTE を足す

it('メール確認待機画面へのリンクに宛先アドレスを載せる', () => {
  // どのアドレス宛に送ったかを待機画面で表示するため、パラメータで運ぶ
  expect(buildVerifyEmailRoute('taro@example.com')).toEqual({
    pathname: VERIFY_EMAIL_ROUTE,
    params: { email: 'taro@example.com' },
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- constants/auth`
Expected: FAIL（`buildVerifyEmailRoute` が export されていない）

- [ ] **Step 2: `constants/auth.ts` にルート生成関数を足す**

`export const VERIFY_EMAIL_ROUTE: Href = '/verify-email';` の行を次に置き換える。

```ts
/**
 * verify-email のパス。
 * Href のオブジェクト形式は pathname にリテラル型を要求する
 * （typedRoutes が有効だと .expo/types でルート名の union になる）ため、
 * Href に代入した定数とは別にリテラルのまま持つ。
 */
const VERIFY_EMAIL_PATHNAME = '/verify-email' as const;

export const VERIFY_EMAIL_ROUTE: Href = VERIFY_EMAIL_PATHNAME;

/**
 * メール確認待機画面へのリンク。
 * 「どのアドレス宛に送ったか」を待機画面で表示し、再送もそのアドレスに対して行うため、
 * メールアドレスをパラメータに載せる。
 */
export function buildVerifyEmailRoute(email: string): Href {
  return { pathname: VERIFY_EMAIL_PATHNAME, params: { email } };
}
```

- [ ] **Step 3: 定数テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- constants/auth`
Expected: PASS（既存 6 件 + 追加 1 件 = 7 件。**既存 6 件が落ちないこと**が回帰の合格条件）

- [ ] **Step 4: 新規登録画面の失敗するテストを書く**

```tsx
// apps/mobile/src/app/(auth)/sign-up.test.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { SIGN_IN_ROUTE, buildVerifyEmailRoute } from '@/constants/auth';
import { AUTH_ERROR_MESSAGES, AuthError } from '@/features/auth/auth-error';
import { createQueryClient } from '@/lib/query-client';

const mockSignUpWithEmail = jest.fn();
const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock('@/features/auth/api', () => ({ signUpWithEmail: mockSignUpWithEmail }));
jest.mock('expo-router', () => ({ router: { push: mockPush, replace: mockReplace } }));

import SignUpScreen from './sign-up';

const DISPLAY_NAME_INPUT_TEST_ID = 'sign-up-display-name-input';
const EMAIL_INPUT_TEST_ID = 'sign-up-email-input';
const PASSWORD_INPUT_TEST_ID = 'sign-up-password-input';
const SUBMIT_BUTTON_TEST_ID = 'sign-up-submit-button';
const ERROR_BANNER_TEST_ID = 'sign-up-error';

const VALID_DISPLAY_NAME = '山田太郎';
const VALID_EMAIL = 'taro@example.com';
const VALID_PASSWORD = 'Passw0rd!';

function renderSignUpScreen() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <SignUpScreen />
    </QueryClientProvider>,
  );
}

async function fillValidForm() {
  await fireEvent.changeText(screen.getByTestId(DISPLAY_NAME_INPUT_TEST_ID), VALID_DISPLAY_NAME);
  await fireEvent.changeText(screen.getByTestId(EMAIL_INPUT_TEST_ID), VALID_EMAIL);
  await fireEvent.changeText(screen.getByTestId(PASSWORD_INPUT_TEST_ID), VALID_PASSWORD);
}

describe('SignUpScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('表示名・メールアドレス・パスワード・登録ボタンを表示する', async () => {
    await renderSignUpScreen();

    expect(screen.getByTestId(DISPLAY_NAME_INPUT_TEST_ID)).toBeOnTheScreen();
    expect(screen.getByTestId(EMAIL_INPUT_TEST_ID)).toBeOnTheScreen();
    expect(screen.getByTestId(PASSWORD_INPUT_TEST_ID)).toBeOnTheScreen();
    expect(screen.getByTestId(SUBMIT_BUTTON_TEST_ID)).toBeOnTheScreen();
  });

  it('未入力のまま送信すると API を呼ばない', async () => {
    await renderSignUpScreen();

    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(EMAIL_INPUT_TEST_ID)).toHaveProp(
        'accessibilityLabel',
        expect.stringContaining('エラー: '),
      );
    });
    expect(mockSignUpWithEmail).not.toHaveBeenCalled();
  });

  it('入力を検証してから API に渡す', async () => {
    mockSignUpWithEmail.mockResolvedValue(undefined);
    await renderSignUpScreen();

    await fillValidForm();
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(mockSignUpWithEmail).toHaveBeenCalledWith({
        displayName: VALID_DISPLAY_NAME,
        email: VALID_EMAIL,
        password: VALID_PASSWORD,
      });
    });
  });

  it('成功したらメール確認待機画面へ宛先つきで置き換え遷移する', async () => {
    mockSignUpWithEmail.mockResolvedValue(undefined);
    await renderSignUpScreen();

    await fillValidForm();
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(buildVerifyEmailRoute(VALID_EMAIL));
    });
    // push だと戻る操作でフォームに戻れてしまい、二重登録を招く
    expect(mockPush).not.toHaveBeenCalledWith(buildVerifyEmailRoute(VALID_EMAIL));
  });

  it('失敗したら理由をバナーに出す', async () => {
    mockSignUpWithEmail.mockRejectedValue(new AuthError('email-already-used'));
    await renderSignUpScreen();

    await fillValidForm();
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(ERROR_BANNER_TEST_ID)).toHaveTextContent(
        AUTH_ERROR_MESSAGES['email-already-used'],
      );
    });
  });

  it('失敗したらメール確認待機画面へ進まない', async () => {
    mockSignUpWithEmail.mockRejectedValue(new AuthError('email-already-used'));
    await renderSignUpScreen();

    await fillValidForm();
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(ERROR_BANNER_TEST_ID)).toBeOnTheScreen();
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('失敗したらパスワードを画面に残さない', async () => {
    mockSignUpWithEmail.mockRejectedValue(new AuthError('email-already-used'));
    await renderSignUpScreen();

    await fillValidForm();
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(PASSWORD_INPUT_TEST_ID)).toHaveProp('value', '');
    });
    // 打ち直しの手間が大きい表示名とメールアドレスは残す
    expect(screen.getByTestId(DISPLAY_NAME_INPUT_TEST_ID)).toHaveProp('value', VALID_DISPLAY_NAME);
    expect(screen.getByTestId(EMAIL_INPUT_TEST_ID)).toHaveProp('value', VALID_EMAIL);
  });

  it('ログイン画面へ戻る導線がある', async () => {
    await renderSignUpScreen();

    await fireEvent.press(screen.getByTestId('sign-up-sign-in-link'));

    expect(mockPush).toHaveBeenCalledWith(SIGN_IN_ROUTE);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- "app/(auth)/sign-up"`
Expected: FAIL（プレースホルダのままなので入力欄が見つからない）

- [ ] **Step 5: `app/(auth)/sign-up.tsx` を実装に差し替える**

```tsx
// apps/mobile/src/app/(auth)/sign-up.tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { router } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';

import { AuthFormScreen } from '@/components/auth/auth-form-screen';
import { FormErrorBanner } from '@/components/auth/form-error-banner';
import { Button } from '@/components/ui/button';
import { INPUT_TEXT_BEHAVIORS, Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { SIGN_IN_ROUTE, buildVerifyEmailRoute } from '@/constants/auth';
import { signUpWithEmail } from '@/features/auth/api';
// 上限はスキーマと画面で二重管理しない。DISPLAY_NAME_MAX_LENGTH は schema.ts が唯一の出所
import { DISPLAY_NAME_MAX_LENGTH, signUpSchema, type SignUpInput } from '@/features/auth/schema';
import { useAuthMutation } from '@/features/auth/use-auth-mutation';

const EMPTY_SIGN_UP_INPUT: SignUpInput = { displayName: '', email: '', password: '' };

export default function SignUpScreen() {
  const { control, handleSubmit, resetField } = useForm<SignUpInput>({
    resolver: zodResolver(signUpSchema),
    defaultValues: EMPTY_SIGN_UP_INPUT,
    mode: 'onTouched',
  });
  const {
    submit: signUp,
    isSubmitting: isSigningUp,
    errorMessage,
  } = useAuthMutation(signUpWithEmail);

  const submitSignUp = handleSubmit(async (values) => {
    const didSignUp = await signUp(values);

    if (!didSignUp) {
      resetField('password');
      return;
    }

    // 登録直後はまだセッションが無く、グループは切り替わらない。
    // replace にするのは、戻る操作でフォームに戻れると二重登録になるため
    router.replace(buildVerifyEmailRoute(values.email));
  });

  return (
    <AuthFormScreen
      description="メールアドレスでアカウントを作成します"
      testID="sign-up-screen"
      title="新規登録"
    >
      <FormErrorBanner message={errorMessage} testID="sign-up-error" />

      <Controller
        control={control}
        name="displayName"
        render={({ field, fieldState }) => (
          <Input
            errorMessage={fieldState.error?.message}
            isDisabled={isSigningUp}
            isRequired
            label="表示名"
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            onBlur={field.onBlur}
            onChangeText={field.onChange}
            placeholder="山田太郎"
            testID="sign-up-display-name-input"
            textBehavior={INPUT_TEXT_BEHAVIORS.personName}
            value={field.value}
          />
        )}
      />

      <Controller
        control={control}
        name="email"
        render={({ field, fieldState }) => (
          <Input
            errorMessage={fieldState.error?.message}
            isDisabled={isSigningUp}
            isRequired
            label="メールアドレス"
            onBlur={field.onBlur}
            onChangeText={field.onChange}
            placeholder="taro@example.com"
            testID="sign-up-email-input"
            textBehavior={INPUT_TEXT_BEHAVIORS.email}
            value={field.value}
          />
        )}
      />

      <Controller
        control={control}
        name="password"
        render={({ field, fieldState }) => (
          <PasswordInput
            errorMessage={fieldState.error?.message}
            isDisabled={isSigningUp}
            isNewPassword
            isRequired
            label="パスワード"
            onBlur={field.onBlur}
            onChangeText={field.onChange}
            testID="sign-up-password-input"
            value={field.value}
          />
        )}
      />

      <Button
        isLoading={isSigningUp}
        label="アカウントを作成する"
        onPress={() => {
          void submitSignUp();
        }}
        testID="sign-up-submit-button"
      />

      <Button
        isDisabled={isSigningUp}
        label="すでにアカウントをお持ちの方"
        onPress={() => {
          router.push(SIGN_IN_ROUTE);
        }}
        testID="sign-up-sign-in-link"
        variant="ghost"
      />
    </AuthFormScreen>
  );
}
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- "app/(auth)/sign-up" constants/auth`
Expected: PASS（`sign-up` 画面 8 件 + `constants/auth` 7 件）

- [ ] **Step 7: わざと壊してテストが落ちることを確認する**

`router.replace(buildVerifyEmailRoute(values.email))` を `router.replace(VERIFY_EMAIL_ROUTE)` に書き換え、「成功したらメール確認待機画面へ宛先つきで置き換え遷移する」が**失敗すること**を確認する。
続けて `if (!didSignUp) { ...; return; }` の `return` を消し、「失敗したらメール確認待機画面へ進まない」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 8: コミットする**

```bash
git add apps/mobile/src/constants/auth.ts apps/mobile/src/constants/auth.test.ts "apps/mobile/src/app/(auth)/sign-up.tsx" "apps/mobile/src/app/(auth)/sign-up.test.tsx"
git commit -m "feat(mobile): 新規登録画面を実装する"
```

---

### Task 5-15: メール確認待機画面を実装する

**Files:**

- Modify: `apps/mobile/src/features/auth/api.ts`
- Modify: `apps/mobile/src/features/auth/api.test.ts`
- Modify: `apps/mobile/src/app/(auth)/verify-email.tsx`（Task 5-7 のプレースホルダを差し替える）
- Create: `apps/mobile/src/app/(auth)/verify-email.test.tsx`

**Interfaces:**

- Consumes:
  - `authClient.sendVerificationEmail(body)` — body: `{ email: string; callbackURL?: string }`（`node_modules/better-auth/dist/api/index.d.mts:747` の `sendVerificationEmail` エンドポイント定義で確認）
  - `useLocalSearchParams<TParams extends UnknownOutputParams>(): TParams` と `UnknownOutputParams = Record<string, string | string[]>`（`node_modules/expo-router/build/hooks/useLocalSearchParams.d.ts` / `build/typed-routes/types.d.ts:89`）
  - `useAuthMutation`（Task 5-13）、`AuthFormScreen` / `FormErrorBanner`（Task 5-12）、`Button`（既存）
- Produces:
  - `interface VerificationEmailInput { email: string }`
  - `async function resendVerificationEmail(input: VerificationEmailInput): Promise<void>`
  - `export default function VerifyEmailScreen(): ReactElement`

- [ ] **Step 1: 再送 API の失敗するテストを書く（既存ファイルに追記）**

```ts
// apps/mobile/src/features/auth/api.test.ts を次のように変える
// 1) mock 定義に 1 行足す
const mockSendVerificationEmail = jest.fn();
// 2) jest.mock('@/lib/auth-client', ...) の authClient に 1 行足す
//      sendVerificationEmail: mockSendVerificationEmail,
// 3) import に resendVerificationEmail を足す
// 4) 末尾に次の describe を足す

describe('resendVerificationEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('宛先アドレスをそのまま送る', async () => {
    mockSendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null });

    await expect(resendVerificationEmail({ email: 'taro@example.com' })).resolves.toBeUndefined();
    expect(mockSendVerificationEmail).toHaveBeenCalledWith({ email: 'taro@example.com' });
  });

  it('429 のときは回数制限の日本語メッセージで投げる', async () => {
    mockSendVerificationEmail.mockResolvedValue({
      data: null,
      error: { status: HTTP_STATUS.tooManyRequests, statusText: 'Too Many Requests' },
    });

    await expect(resendVerificationEmail({ email: 'taro@example.com' })).rejects.toThrow(
      AUTH_ERROR_MESSAGES['rate-limited'],
    );
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- features/auth/api`
Expected: FAIL（`resendVerificationEmail` が export されていない）

- [ ] **Step 2: `features/auth/api.ts` に再送関数を足す**

```ts
/**
 * 確認メールの再送に渡す値。
 * 画面入力ではなくルートパラメータから来るので検証スキーマは要らず、
 * packages/core ではなくここで型だけ定義する。
 */
export interface VerificationEmailInput {
  email: string;
}

export async function resendVerificationEmail(input: VerificationEmailInput): Promise<void> {
  // callbackURL は省略する。サーバ側（Better Auth の emailVerification 設定）が
  // アプリのスキームへ戻すリンクを組み立てる責務を持つ
  const result = await authClient.sendVerificationEmail({ email: input.email });
  throwIfFailed(result, 'sendVerificationEmail');
}
```

- [ ] **Step 3: api のテストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- features/auth/api`
Expected: PASS（既存 9 件 + 追加 2 件 = 11 件。**既存 9 件が落ちないこと**が回帰の合格条件）

- [ ] **Step 4: メール確認待機画面の失敗するテストを書く**

```tsx
// apps/mobile/src/app/(auth)/verify-email.test.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { SIGN_IN_ROUTE } from '@/constants/auth';
import { AUTH_ERROR_MESSAGES, AuthError } from '@/features/auth/auth-error';
import { createQueryClient } from '@/lib/query-client';

const mockResendVerificationEmail = jest.fn();
const mockReplace = jest.fn();
const mockUseLocalSearchParams = jest.fn();

jest.mock('@/features/auth/api', () => ({
  resendVerificationEmail: mockResendVerificationEmail,
}));
jest.mock('expo-router', () => ({
  router: { replace: mockReplace },
  useLocalSearchParams: mockUseLocalSearchParams,
}));

import VerifyEmailScreen from './verify-email';

const RESEND_BUTTON_TEST_ID = 'verify-email-resend-button';
const RESENT_NOTICE_TEST_ID = 'verify-email-resent-notice';
const ERROR_BANNER_TEST_ID = 'verify-email-error';

const REGISTERED_EMAIL = 'taro@example.com';

function renderVerifyEmailScreen() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <VerifyEmailScreen />
    </QueryClientProvider>,
  );
}

describe('VerifyEmailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLocalSearchParams.mockReturnValue({ email: REGISTERED_EMAIL });
  });

  it('どのアドレスに送ったかを表示する', async () => {
    await renderVerifyEmailScreen();

    expect(screen.getByText(new RegExp(REGISTERED_EMAIL))).toBeOnTheScreen();
  });

  it('初期表示では再送完了もエラーも出さない', async () => {
    await renderVerifyEmailScreen();

    expect(screen.queryByTestId(RESENT_NOTICE_TEST_ID)).toBeNull();
    expect(screen.queryByTestId(ERROR_BANNER_TEST_ID)).toBeNull();
  });

  it('再送ボタンで宛先アドレス宛に再送する', async () => {
    mockResendVerificationEmail.mockResolvedValue(undefined);
    await renderVerifyEmailScreen();

    await fireEvent.press(screen.getByTestId(RESEND_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(mockResendVerificationEmail).toHaveBeenCalledWith({ email: REGISTERED_EMAIL });
    });
  });

  it('再送に成功したらその旨を伝える', async () => {
    mockResendVerificationEmail.mockResolvedValue(undefined);
    await renderVerifyEmailScreen();

    await fireEvent.press(screen.getByTestId(RESEND_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(RESENT_NOTICE_TEST_ID)).toBeOnTheScreen();
    });
  });

  it('再送に失敗したら理由をバナーに出す', async () => {
    mockResendVerificationEmail.mockRejectedValue(new AuthError('rate-limited'));
    await renderVerifyEmailScreen();

    await fireEvent.press(screen.getByTestId(RESEND_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(ERROR_BANNER_TEST_ID)).toHaveTextContent(
        AUTH_ERROR_MESSAGES['rate-limited'],
      );
    });
    expect(screen.queryByTestId(RESENT_NOTICE_TEST_ID)).toBeNull();
  });

  it('アドレスが渡ってこないときは再送ボタンを押せない', async () => {
    // リンクを直接開かれた場合など。宛先が分からないまま送信して失敗させない
    mockUseLocalSearchParams.mockReturnValue({});
    await renderVerifyEmailScreen();

    await fireEvent.press(screen.getByTestId(RESEND_BUTTON_TEST_ID));

    expect(mockResendVerificationEmail).not.toHaveBeenCalled();
    expect(screen.getByTestId(RESEND_BUTTON_TEST_ID)).toHaveProp('accessibilityState', {
      disabled: true,
      busy: false,
    });
  });

  it('同じ名前のパラメータが複数来ても送信しない', async () => {
    // useLocalSearchParams は string | string[] を返す（build/typed-routes/types.d.ts:89）
    mockUseLocalSearchParams.mockReturnValue({ email: ['a@example.com', 'b@example.com'] });
    await renderVerifyEmailScreen();

    await fireEvent.press(screen.getByTestId(RESEND_BUTTON_TEST_ID));

    expect(mockResendVerificationEmail).not.toHaveBeenCalled();
  });

  it('ログイン画面へ置き換え遷移できる', async () => {
    await renderVerifyEmailScreen();

    await fireEvent.press(screen.getByTestId('verify-email-sign-in-link'));

    // 戻る操作で待機画面に戻れても意味がないので replace
    expect(mockReplace).toHaveBeenCalledWith(SIGN_IN_ROUTE);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- verify-email`
Expected: FAIL（プレースホルダのままなので再送ボタンが見つからない）

- [ ] **Step 5: `app/(auth)/verify-email.tsx` を実装に差し替える**

```tsx
// apps/mobile/src/app/(auth)/verify-email.tsx
import { router, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { AuthFormScreen } from '@/components/auth/auth-form-screen';
import { FormErrorBanner } from '@/components/auth/form-error-banner';
import { Button } from '@/components/ui/button';
import { SIGN_IN_ROUTE } from '@/constants/auth';
import { resendVerificationEmail } from '@/features/auth/api';
import { useAuthMutation } from '@/features/auth/use-auth-mutation';

const SCREEN_TITLE = '確認メールを送りました';
const DESCRIPTION_SUFFIX =
  ' 宛に確認メールを送りました。メール内のリンクを開くと登録が完了します。';
const DESCRIPTION_WITHOUT_EMAIL =
  '登録したメールアドレス宛に確認メールを送りました。メール内のリンクを開くと登録が完了します。';
const RESENT_MESSAGE =
  '確認メールを再送しました。数分待っても届かない場合は迷惑メールをご確認ください。';

/**
 * ルートパラメータは `string | string[]` で返る
 * （expo-router build/typed-routes/types.d.ts:89 の UnknownOutputParams）。
 * 同じ名前が複数来た場合は宛先を決められないので、単一の非空文字列のときだけ採用する。
 */
function readEmailParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function buildDescription(email: string | undefined): string {
  return email === undefined ? DESCRIPTION_WITHOUT_EMAIL : `${email}${DESCRIPTION_SUFFIX}`;
}

export default function VerifyEmailScreen() {
  const params = useLocalSearchParams();
  const email = readEmailParam(params.email);

  const {
    submit: resend,
    isSubmitting: isResending,
    errorMessage,
    hasSucceeded: hasResent,
  } = useAuthMutation(resendVerificationEmail);

  return (
    <AuthFormScreen
      description={buildDescription(email)}
      testID="verify-email-screen"
      title={SCREEN_TITLE}
    >
      <FormErrorBanner message={errorMessage} testID="verify-email-error" />

      {hasResent ? (
        <View
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          className="rounded-card border border-green-500 bg-green-50 px-md py-sm"
          testID="verify-email-resent-notice"
        >
          <Text className="font-body text-sm text-green-700">{RESENT_MESSAGE}</Text>
        </View>
      ) : null}

      <Button
        // 宛先が分からないまま送って必ず失敗させるより、押せなくして理由を示す
        isDisabled={email === undefined}
        isLoading={isResending}
        label="確認メールを再送する"
        onPress={() => {
          if (email === undefined) {
            return;
          }
          void resend({ email });
        }}
        testID="verify-email-resend-button"
        variant="secondary"
      />

      <Button
        label="ログイン画面へ"
        onPress={() => {
          // 戻る操作で待機画面へ戻れても意味がないので replace
          router.replace(SIGN_IN_ROUTE);
        }}
        testID="verify-email-sign-in-link"
        variant="ghost"
      />
    </AuthFormScreen>
  );
}
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- verify-email features/auth/api`
Expected: PASS（`verify-email` 8 件 + `api` 11 件）

- [ ] **Step 7: わざと壊してテストが落ちることを確認する**

`readEmailParam` の `typeof value === 'string'` を `value !== undefined` に書き換え、「同じ名前のパラメータが複数来ても送信しない」が**失敗すること**を確認する。
続けて `isDisabled={email === undefined}` を削除し、「アドレスが渡ってこないときは再送ボタンを押せない」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 8: コミットする**

```bash
git add apps/mobile/src/features/auth/api.ts apps/mobile/src/features/auth/api.test.ts "apps/mobile/src/app/(auth)/verify-email.tsx" "apps/mobile/src/app/(auth)/verify-email.test.tsx"
git commit -m "feat(mobile): メール確認待機画面と確認メール再送を実装する"
```

---

### Task 5-16: パスワード再設定の申請画面を実装する

**設計上の要点（アカウントの存在を漏らさない）:** 送信結果に関わらず同じ完了文言を出す。「そのアドレスは登録されていません」と返すと、総当たりでアカウントの存在を調べられてしまう。Better Auth の `requestPasswordReset` も未登録アドレスで成功を返す作りなので、画面側でも分岐を作らない。

**Files:**

- Modify: `apps/mobile/src/app/(auth)/forgot-password.tsx`（Task 5-7 のプレースホルダを差し替える）
- Create: `apps/mobile/src/app/(auth)/forgot-password.test.tsx`

**Interfaces:**

- Consumes:
  - `requestPasswordReset(input: PasswordResetRequestInput): Promise<void>`（Task 5-4）
  - `passwordResetRequestSchema` と `type PasswordResetRequestInput = { email: string }`（Task 5-4 の `@/features/auth/schema`）
  - `useAuthMutation`（Task 5-13）、`AuthFormScreen` / `FormErrorBanner`（Task 5-12）、`Input` / `INPUT_TEXT_BEHAVIORS`（Task 5-10）、`Button`（既存）
- Produces: `export default function ForgotPasswordScreen(): ReactElement`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/app/(auth)/forgot-password.test.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { SIGN_IN_ROUTE } from '@/constants/auth';
import { AUTH_ERROR_MESSAGES, AuthError } from '@/features/auth/auth-error';
import { createQueryClient } from '@/lib/query-client';

const mockRequestPasswordReset = jest.fn();
const mockPush = jest.fn();

jest.mock('@/features/auth/api', () => ({ requestPasswordReset: mockRequestPasswordReset }));
jest.mock('expo-router', () => ({ router: { push: mockPush } }));

import ForgotPasswordScreen from './forgot-password';

const EMAIL_INPUT_TEST_ID = 'forgot-password-email-input';
const SUBMIT_BUTTON_TEST_ID = 'forgot-password-submit-button';
const SENT_NOTICE_TEST_ID = 'forgot-password-sent-notice';
const ERROR_BANNER_TEST_ID = 'forgot-password-error';

const REGISTERED_EMAIL = 'taro@example.com';

function renderForgotPasswordScreen() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ForgotPasswordScreen />
    </QueryClientProvider>,
  );
}

describe('ForgotPasswordScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('メールアドレス欄と送信ボタンを表示する', async () => {
    await renderForgotPasswordScreen();

    expect(screen.getByTestId(EMAIL_INPUT_TEST_ID)).toBeOnTheScreen();
    expect(screen.getByTestId(SUBMIT_BUTTON_TEST_ID)).toBeOnTheScreen();
  });

  it('未入力のまま送信すると API を呼ばない', async () => {
    await renderForgotPasswordScreen();

    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(EMAIL_INPUT_TEST_ID)).toHaveProp(
        'accessibilityLabel',
        expect.stringContaining('エラー: '),
      );
    });
    expect(mockRequestPasswordReset).not.toHaveBeenCalled();
  });

  it('入力したアドレス宛に再設定メールを申請する', async () => {
    mockRequestPasswordReset.mockResolvedValue(undefined);
    await renderForgotPasswordScreen();

    await fireEvent.changeText(screen.getByTestId(EMAIL_INPUT_TEST_ID), REGISTERED_EMAIL);
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(mockRequestPasswordReset).toHaveBeenCalledWith({ email: REGISTERED_EMAIL });
    });
  });

  it('送信に成功したら完了案内に差し替え、フォームを隠す', async () => {
    mockRequestPasswordReset.mockResolvedValue(undefined);
    await renderForgotPasswordScreen();

    await fireEvent.changeText(screen.getByTestId(EMAIL_INPUT_TEST_ID), REGISTERED_EMAIL);
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(SENT_NOTICE_TEST_ID)).toBeOnTheScreen();
    });
    // 連打で回数制限に当たらないよう、送信後はフォームごと隠す
    expect(screen.queryByTestId(SUBMIT_BUTTON_TEST_ID)).toBeNull();
  });

  it('完了案内はアカウントの有無を明かさない', async () => {
    mockRequestPasswordReset.mockResolvedValue(undefined);
    await renderForgotPasswordScreen();

    await fireEvent.changeText(screen.getByTestId(EMAIL_INPUT_TEST_ID), REGISTERED_EMAIL);
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(SENT_NOTICE_TEST_ID)).toBeOnTheScreen();
    });
    // 「登録されています」と読める文言を出すと、総当たりで存在確認ができてしまう
    expect(screen.getByTestId(SENT_NOTICE_TEST_ID)).toHaveTextContent('登録されている場合');
  });

  it('失敗したら理由をバナーに出し、完了案内は出さない', async () => {
    mockRequestPasswordReset.mockRejectedValue(new AuthError('rate-limited'));
    await renderForgotPasswordScreen();

    await fireEvent.changeText(screen.getByTestId(EMAIL_INPUT_TEST_ID), REGISTERED_EMAIL);
    await fireEvent.press(screen.getByTestId(SUBMIT_BUTTON_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(ERROR_BANNER_TEST_ID)).toHaveTextContent(
        AUTH_ERROR_MESSAGES['rate-limited'],
      );
    });
    expect(screen.queryByTestId(SENT_NOTICE_TEST_ID)).toBeNull();
  });

  it('ログイン画面へ戻る導線がある', async () => {
    await renderForgotPasswordScreen();

    await fireEvent.press(screen.getByTestId('forgot-password-sign-in-link'));

    expect(mockPush).toHaveBeenCalledWith(SIGN_IN_ROUTE);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- forgot-password`
Expected: FAIL（プレースホルダのままなので入力欄が見つからない）

- [ ] **Step 2: `app/(auth)/forgot-password.tsx` を実装に差し替える**

```tsx
// apps/mobile/src/app/(auth)/forgot-password.tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { router } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { Text, View } from 'react-native';

import { AuthFormScreen } from '@/components/auth/auth-form-screen';
import { FormErrorBanner } from '@/components/auth/form-error-banner';
import { Button } from '@/components/ui/button';
import { INPUT_TEXT_BEHAVIORS, Input } from '@/components/ui/input';
import { SIGN_IN_ROUTE } from '@/constants/auth';
import { requestPasswordReset } from '@/features/auth/api';
import { passwordResetRequestSchema, type PasswordResetRequestInput } from '@/features/auth/schema';
import { useAuthMutation } from '@/features/auth/use-auth-mutation';

const EMPTY_REQUEST_INPUT: PasswordResetRequestInput = { email: '' };

/**
 * 「登録されている場合」と条件付きで書くのが要点。
 * 「送りました」と断定するとアドレスの登録有無が分かり、総当たりで会員を特定できてしまう。
 */
const SENT_MESSAGE =
  'ご入力のメールアドレスが登録されている場合、パスワード再設定用のリンクをお送りしました。';

export default function ForgotPasswordScreen() {
  const { control, handleSubmit } = useForm<PasswordResetRequestInput>({
    resolver: zodResolver(passwordResetRequestSchema),
    defaultValues: EMPTY_REQUEST_INPUT,
    mode: 'onTouched',
  });
  const {
    submit: sendResetRequest,
    isSubmitting: isSending,
    errorMessage,
    hasSucceeded: hasSent,
  } = useAuthMutation(requestPasswordReset);

  const submitRequest = handleSubmit(async (values) => {
    await sendResetRequest(values);
    // 成否で文言を変えない。変えるとアカウントの存在が漏れる
  });

  return (
    <AuthFormScreen
      description="登録済みのメールアドレスに再設定用のリンクを送ります"
      testID="forgot-password-screen"
      title="パスワードの再設定"
    >
      <FormErrorBanner message={errorMessage} testID="forgot-password-error" />

      {hasSent ? (
        <View
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          className="rounded-card border border-green-500 bg-green-50 px-md py-sm"
          testID="forgot-password-sent-notice"
        >
          <Text className="font-body text-sm text-green-700">{SENT_MESSAGE}</Text>
        </View>
      ) : (
        <>
          <Controller
            control={control}
            name="email"
            render={({ field, fieldState }) => (
              <Input
                errorMessage={fieldState.error?.message}
                isDisabled={isSending}
                isRequired
                label="メールアドレス"
                onBlur={field.onBlur}
                onChangeText={field.onChange}
                placeholder="taro@example.com"
                testID="forgot-password-email-input"
                textBehavior={INPUT_TEXT_BEHAVIORS.email}
                value={field.value}
              />
            )}
          />

          <Button
            isLoading={isSending}
            label="再設定メールを送る"
            onPress={() => {
              void submitRequest();
            }}
            testID="forgot-password-submit-button"
          />
        </>
      )}

      <Button
        isDisabled={isSending}
        label="ログイン画面へ戻る"
        onPress={() => {
          router.push(SIGN_IN_ROUTE);
        }}
        testID="forgot-password-sign-in-link"
        variant="ghost"
      />
    </AuthFormScreen>
  );
}
```

- [ ] **Step 3: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- forgot-password`
Expected: PASS（7 件）

- [ ] **Step 4: わざと壊してテストが落ちることを確認する**

`SENT_MESSAGE` を `'再設定用のリンクをお送りしました。'` に書き換え、「完了案内はアカウントの有無を明かさない」が**失敗すること**を確認する。
続けて `hasSent ? ... : <>...</>` の三項を外して常にフォームを出すようにし、「送信に成功したら完了案内に差し替え、フォームを隠す」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 5: コミットする**

```bash
git add "apps/mobile/src/app/(auth)/forgot-password.tsx" "apps/mobile/src/app/(auth)/forgot-password.test.tsx"
git commit -m "feat(mobile): パスワード再設定の申請画面を実装する"
```

---

### Task 5-17: welcome（オンボーディング）画面を実装する

**ゲスト導線の扱い（設計判断）**

設計書 §5.1 は `welcome.tsx` を「オンボーディング（3 スライド + ゲスト利用導線）」としているが、**Phase 5 ではゲスト導線のボタンを置かない**。理由は次の 2 点。

| 論点               | 判断                                                                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 行き先が無い       | ゲストが見る対象は地図・店舗詳細で、どちらも Phase 6 の成果物。押しても何も起きないボタンを出すのは、無いより悪い                                                                                                                                                                         |
| ガード設計が変わる | ゲスト閲覧を通すには `AuthState` に 5 つ目の状態（`guest`）を足し、Task 5-8 の `(user)` グループのガードを「認証済み user **または** ゲスト」に緩める必要がある。ロールの出所（`profiles.role`）が無い状態を `(user)` に入れる判断は、閲覧できる範囲が確定する Phase 6 と同時に決めるべき |

したがって Phase 5 の welcome は「3 スライド + 新規登録 + ログイン」までとし、ゲスト導線は Phase 6 への引き継ぎ事項として本計画書末尾の「Phase 6 への引き継ぎ」に記載する。

**Files:**

- Modify: `apps/mobile/src/app/(auth)/welcome.tsx`（Task 5-7 のプレースホルダを差し替える）
- Create: `apps/mobile/src/app/(auth)/welcome.test.tsx`

**Interfaces:**

- Consumes:
  - `SIGN_IN_ROUTE` / `SIGN_UP_ROUTE`（Task 5-1）
  - `Button`（既存）
  - `useWindowDimensions(): { width: number; height: number; scale: number; fontScale: number }`（`react-native`）
  - `NativeSyntheticEvent<NativeScrollEvent>` — `nativeEvent.contentOffset: { x: number; y: number }` / `nativeEvent.layoutMeasurement: { width: number; height: number }`（`node_modules/react-native/types/public/ReactNativeTypes.d.ts` 由来の `ScrollViewProps.onMomentumScrollEnd`）
- Produces:
  - `interface OnboardingSlide { key: string; title: string; description: string }`
  - `const ONBOARDING_SLIDES: readonly OnboardingSlide[]`
  - `function buildSlidePositionLabel(index: number): string`
  - `export default function WelcomeScreen(): ReactElement`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/app/(auth)/welcome.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { SIGN_IN_ROUTE, SIGN_UP_ROUTE } from '@/constants/auth';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({ router: { push: mockPush } }));

import WelcomeScreen, { ONBOARDING_SLIDES, buildSlidePositionLabel } from './welcome';

const SLIDES_TEST_ID = 'welcome-slides';
const POSITION_TEST_ID = 'welcome-slide-position';
const DOT_TEST_ID = 'welcome-slide-dot';
const SLIDE_TEST_ID = 'welcome-slide';

/** 端末幅の代わりに使う固定値。実測値に依存しないようイベント側で幅を与える */
const PAGE_WIDTH = 390;

/** 指定ページまでスクロールし終えたことを表すイベントを作る */
function buildMomentumScrollEvent(pageIndex: number, pageWidth = PAGE_WIDTH) {
  return {
    nativeEvent: {
      contentOffset: { x: pageWidth * pageIndex, y: 0 },
      layoutMeasurement: { width: pageWidth, height: 800 },
      contentSize: { width: pageWidth * ONBOARDING_SLIDES.length, height: 800 },
    },
  };
}

describe('WelcomeScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('最初のスライドの見出しと説明を表示する', async () => {
    await render(<WelcomeScreen />);

    const firstSlide = ONBOARDING_SLIDES[0];
    if (firstSlide === undefined) {
      throw new Error('オンボーディングのスライドが 1 枚も定義されていない');
    }
    expect(screen.getByText(firstSlide.title)).toBeOnTheScreen();
    expect(screen.getByText(firstSlide.description)).toBeOnTheScreen();
  });

  it('スライドを定義どおりの枚数だけ描画する', async () => {
    await render(<WelcomeScreen />);

    expect(screen.getAllByTestId(SLIDE_TEST_ID)).toHaveLength(ONBOARDING_SLIDES.length);
  });

  it('ドットの数はスライドの枚数と一致する', async () => {
    await render(<WelcomeScreen />);

    expect(screen.getAllByTestId(DOT_TEST_ID)).toHaveLength(ONBOARDING_SLIDES.length);
  });

  it('現在位置を先頭として伝える', async () => {
    await render(<WelcomeScreen />);

    expect(screen.getByTestId(POSITION_TEST_ID)).toHaveTextContent(buildSlidePositionLabel(0));
  });

  it('2 枚目まで送ると現在位置の表示が変わる', async () => {
    await render(<WelcomeScreen />);

    await fireEvent(
      screen.getByTestId(SLIDES_TEST_ID),
      'momentumScrollEnd',
      buildMomentumScrollEvent(1),
    );

    expect(screen.getByTestId(POSITION_TEST_ID)).toHaveTextContent(buildSlidePositionLabel(1));
  });

  it('画面幅が 0 のイベントでは先頭のままにする（境界値）', async () => {
    // 初回レイアウト前にスクロールイベントが来ても 0 除算で NaN にしない
    await render(<WelcomeScreen />);

    await fireEvent(
      screen.getByTestId(SLIDES_TEST_ID),
      'momentumScrollEnd',
      buildMomentumScrollEvent(3, 0),
    );

    expect(screen.getByTestId(POSITION_TEST_ID)).toHaveTextContent(buildSlidePositionLabel(0));
  });

  it('最終ページを超える位置へ送られても最後のスライドで止まる（境界値）', async () => {
    await render(<WelcomeScreen />);

    await fireEvent(
      screen.getByTestId(SLIDES_TEST_ID),
      'momentumScrollEnd',
      buildMomentumScrollEvent(ONBOARDING_SLIDES.length + 2),
    );

    expect(screen.getByTestId(POSITION_TEST_ID)).toHaveTextContent(
      buildSlidePositionLabel(ONBOARDING_SLIDES.length - 1),
    );
  });

  it('新規登録を押すと登録画面へ進む', async () => {
    await render(<WelcomeScreen />);

    await fireEvent.press(screen.getByTestId('welcome-sign-up-button'));

    expect(mockPush).toHaveBeenCalledWith(SIGN_UP_ROUTE);
  });

  it('ログインを押すとログイン画面へ進む', async () => {
    await render(<WelcomeScreen />);

    await fireEvent.press(screen.getByTestId('welcome-sign-in-button'));

    expect(mockPush).toHaveBeenCalledWith(SIGN_IN_ROUTE);
  });

  it('現在位置はスクリーンリーダーにも読み上げられる', async () => {
    await render(<WelcomeScreen />);

    expect(screen.getByLabelText(buildSlidePositionLabel(0))).toBeOnTheScreen();
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- welcome`
Expected: FAIL（`ONBOARDING_SLIDES` が export されていない）

- [ ] **Step 2: `app/(auth)/welcome.tsx` を実装に差し替える**

```tsx
// apps/mobile/src/app/(auth)/welcome.tsx
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';

import { Button } from '@/components/ui/button';
import { SIGN_IN_ROUTE, SIGN_UP_ROUTE } from '@/constants/auth';

export interface OnboardingSlide {
  key: string;
  title: string;
  description: string;
}

/** テストからも参照するので export する（枚数のハードコードを避けるため） */
export const ONBOARDING_SLIDES: readonly OnboardingSlide[] = [
  {
    key: 'map',
    title: '地図から店を探す',
    description: '現在地のまわりのお店を、地図の上でまとめて見つけられます。',
  },
  {
    key: 'review',
    title: '行った人の声が見える',
    description: '写真つきの口コミで、入る前にお店の雰囲気が分かります。',
  },
  {
    key: 'reserve',
    title: 'そのまま席を予約',
    description: '空いている時間を選んで、アプリから席を押さえられます。',
  },
];

const FIRST_SLIDE_INDEX = 0;
const LAST_SLIDE_INDEX = ONBOARDING_SLIDES.length - 1;

/** 「2 / 3 枚目」のような現在位置の文言。表示と読み上げで同じ文字列を使う */
export function buildSlidePositionLabel(index: number): string {
  return `${index + 1} / ${ONBOARDING_SLIDES.length} 枚目`;
}

/**
 * スクロールイベントから何枚目かを求める。
 * 幅はイベントの layoutMeasurement から取る（Dimensions に依存させないため）。
 * 初回レイアウト前は幅が 0 で来ることがあるので、その場合は先頭に倒す。
 */
function toSlideIndex(event: NativeSyntheticEvent<NativeScrollEvent>): number {
  const { contentOffset, layoutMeasurement } = event.nativeEvent;

  if (layoutMeasurement.width <= 0) {
    return FIRST_SLIDE_INDEX;
  }

  const rawIndex = Math.round(contentOffset.x / layoutMeasurement.width);
  // バウンスで端を超えた位置が来ても配列の範囲に収める
  return Math.min(Math.max(rawIndex, FIRST_SLIDE_INDEX), LAST_SLIDE_INDEX);
}

export default function WelcomeScreen() {
  const { width } = useWindowDimensions();
  const [currentIndex, setCurrentIndex] = useState(FIRST_SLIDE_INDEX);

  const handleMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setCurrentIndex(toSlideIndex(event));
  }, []);

  const positionLabel = buildSlidePositionLabel(currentIndex);

  return (
    <View className="flex-1 bg-neutral-50" testID="welcome-screen">
      <ScrollView
        horizontal
        // 1 枚ずつ吸着させる。ドットと現在位置の表示をページ単位に保つため
        pagingEnabled
        onMomentumScrollEnd={handleMomentumScrollEnd}
        showsHorizontalScrollIndicator={false}
        testID="welcome-slides"
      >
        {ONBOARDING_SLIDES.map((slide) => (
          <View
            key={slide.key}
            className="items-center justify-center gap-md px-xl"
            // 幅は端末ごとに変わるため className では表せない。ここだけ style で渡す
            style={{ width }}
            testID="welcome-slide"
          >
            <Text className="text-center font-display-bold text-display text-neutral-900">
              {slide.title}
            </Text>
            <Text className="text-center font-body text-base text-neutral-600">
              {slide.description}
            </Text>
          </View>
        ))}
      </ScrollView>

      <View
        accessibilityLabel={positionLabel}
        accessibilityRole="progressbar"
        className="flex-row items-center justify-center gap-xs py-md"
        testID={
          // 表示と読み上げの両方をこの 1 要素に集約し、文言のコピーがズレないようにする
          'welcome-slide-position'
        }
      >
        {ONBOARDING_SLIDES.map((slide, index) => (
          <View
            key={slide.key}
            className={
              index === currentIndex
                ? 'h-2 w-6 rounded-full bg-primary-500'
                : 'h-2 w-2 rounded-full bg-neutral-300'
            }
            testID="welcome-slide-dot"
          />
        ))}
        {/* 読み上げ用の文言をそのまま画面にも出す（テストが文言の一致を見張る） */}
        <Text className="ml-sm font-body text-xs text-neutral-500">{positionLabel}</Text>
      </View>

      <View className="gap-sm px-lg pb-xl">
        <Button
          label="はじめる（新規登録）"
          onPress={() => {
            router.push(SIGN_UP_ROUTE);
          }}
          testID="welcome-sign-up-button"
        />
        <Button
          label="アカウントをお持ちの方はログイン"
          onPress={() => {
            router.push(SIGN_IN_ROUTE);
          }}
          testID="welcome-sign-in-button"
          variant="outline"
        />
      </View>
    </View>
  );
}
```

- [ ] **Step 3: テストが通ることを確認する**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- welcome`
Expected: PASS（10 件）

- [ ] **Step 4: わざと壊してテストが落ちることを確認する**

`toSlideIndex` の `if (layoutMeasurement.width <= 0)` を削除し、「画面幅が 0 のイベントでは先頭のままにする（境界値）」が**失敗すること**を確認する。
続けて `Math.min(Math.max(rawIndex, FIRST_SLIDE_INDEX), LAST_SLIDE_INDEX)` を `rawIndex` に書き換え、「最終ページを超える位置へ送られても最後のスライドで止まる（境界値）」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 5: コミットする**

```bash
git add "apps/mobile/src/app/(auth)/welcome.tsx" "apps/mobile/src/app/(auth)/welcome.test.tsx"
git commit -m "feat(mobile): オンボーディングの welcome 画面を実装する"
```

---

### Task 5-18: サインアウトを実装する（3 ロール分の設定画面まで）

**サインアウト後に画面遷移を書かない理由**

`router.replace(WELCOME_ROUTE)` を書きたくなるが、書かない。セッションが消えると `useAuth()` が `unauthenticated` になり、ルート `_layout.tsx` の `<Stack.Protected guard={...}>` が閉じ、expo-router がアンカー（`index`）へ落とし、`index` が `<Redirect href={WELCOME_ROUTE} />` を返す（Task 5-8 / 5-9）。遷移を二重に書くと、ガードによる巻き戻しと `replace` が競合して履歴が壊れる。**遷移の責務はガードと `index` だけが持つ。**

**Files:**

- Modify: `apps/mobile/src/constants/auth.ts`
- Modify: `apps/mobile/src/app/route-files.test.ts`
- Create: `apps/mobile/src/features/auth/use-sign-out.ts`
- Create: `apps/mobile/src/features/auth/use-sign-out.test.tsx`
- Create: `apps/mobile/src/features/auth/sign-out-storage.test.ts`
- Create: `apps/mobile/src/components/auth/sign-out-button.tsx`
- Create: `apps/mobile/src/components/auth/sign-out-button.test.tsx`
- Modify: `apps/mobile/src/app/(user)/settings/index.tsx`
- Create: `apps/mobile/src/app/(user)/settings/index.test.tsx`
- Modify: `apps/mobile/src/app/(user)/settings/account.tsx`
- Create: `apps/mobile/src/app/(user)/settings/account.test.tsx`
- Modify: `apps/mobile/src/app/(owner)/(tabs)/account.tsx`
- Create: `apps/mobile/src/app/(owner)/(tabs)/account.test.tsx`
- Modify: `apps/mobile/src/app/(admin)/(tabs)/more.tsx`
- Create: `apps/mobile/src/app/(admin)/(tabs)/more.test.tsx`

**Interfaces:**

- Consumes:
  - `signOutFromApp(): Promise<void>`（Task 5-4）
  - `useAuthMutation`（Task 5-13）、`useAuth(): AuthState`（Task 5-5）、`FormErrorBanner`（Task 5-12）、`Button`（既存）
  - `useQueryClient(): QueryClient` と `QueryClient.clear(): void`（`queryClient.d.ts` は再エクスポートのバレルなので、実体は `node_modules/@tanstack/query-core/build/modern/hydration-Bjs0MSgg.d.ts:510` の `clear(): void`）
  - `Alert.alert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions): void`、`AlertButton = { text?: string; onPress?: ((value?: string) => void) | ((value?: { login: string; password: string }) => void); isPreferred?: boolean; style?: 'default' | 'cancel' | 'destructive' }`（`node_modules/react-native/Libraries/Alert/Alert.d.ts:13-30`）
  - `@better-auth/expo` の `clearSessionCache` が `<prefix>_cookie` と `<prefix>_session_data` に `"{}"` を書き戻す挙動（`node_modules/@better-auth/expo/dist/client.js:598-606`）。呼び出しは `fetchPlugins[0].init` の中（同 :723）なので、**リクエスト送信前**に失効する
- Produces:
  - `const SETTINGS_ROUTE: Href`、`const ACCOUNT_SETTINGS_ROUTE: Href`、`const ROLE_LABELS: Record<Role, string>`
  - `interface SignOutResult { requestSignOut: () => Promise<boolean>; isSigningOut: boolean; errorMessage: string | undefined }`
  - `function useSignOut(): SignOutResult`
  - `interface SignOutButtonProps { testID?: string | undefined }`
  - `function SignOutButton(props: SignOutButtonProps): ReactElement`

- [ ] **Step 1: `constants/auth.ts` にルートとロール表示名を足す**

`ROLE_HOME_ROUTES` の定義の直前に次を挿入する。

```ts
export const SETTINGS_ROUTE: Href = '/settings';
export const ACCOUNT_SETTINGS_ROUTE: Href = '/settings/account';

/**
 * 画面に出すロールの呼び名。
 * `Role` をキーにした Record にしておくと、ロールが増えたとき型エラーで気づける。
 */
export const ROLE_LABELS: Record<Role, string> = {
  user: '一般会員',
  owner: '店舗管理者',
  admin: 'システム管理者',
};
```

`app/route-files.test.ts` の `ROUTE_TO_FILE` にも 2 行足す（import にも `ACCOUNT_SETTINGS_ROUTE` / `SETTINGS_ROUTE` を追加）。

```ts
  [String(SETTINGS_ROUTE), '(user)/settings/index.tsx'],
  [String(ACCOUNT_SETTINGS_ROUTE), '(user)/settings/account.tsx'],
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- route-files constants/auth`
Expected: PASS（Task 5-7 で実ファイルは既に存在するため通る。ここは回帰の確認）

- [ ] **Step 2: useSignOut の失敗するテストを書く**

```tsx
// apps/mobile/src/features/auth/use-sign-out.test.tsx
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { AUTH_ERROR_MESSAGES, AuthError } from '@/features/auth/auth-error';
import { createQueryClient } from '@/lib/query-client';

const mockSignOutFromApp = jest.fn();

jest.mock('./api', () => ({ signOutFromApp: mockSignOutFromApp }));

import { useSignOut } from './use-sign-out';

/** サインアウト前から残っているサーバ状態の代わり */
const STALE_QUERY_KEY = ['shops', 'nearby'] as const;
const STALE_QUERY_DATA = { shopIds: ['shp_1'] };

function buildWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useSignOut', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('初期状態では送信中でもエラーでもない', async () => {
    const queryClient = createQueryClient();
    const { result } = await renderHook(() => useSignOut(), { wrapper: buildWrapper(queryClient) });

    expect(result.current.isSigningOut).toBe(false);
    expect(result.current.errorMessage).toBeUndefined();
  });

  it('成功すると true を返す', async () => {
    mockSignOutFromApp.mockResolvedValue(undefined);
    const queryClient = createQueryClient();
    const { result } = await renderHook(() => useSignOut(), { wrapper: buildWrapper(queryClient) });

    await expect(result.current.requestSignOut()).resolves.toBe(true);
  });

  it('成功したら前の利用者のキャッシュを残さない', async () => {
    mockSignOutFromApp.mockResolvedValue(undefined);
    const queryClient = createQueryClient();
    queryClient.setQueryData(STALE_QUERY_KEY, STALE_QUERY_DATA);
    const { result } = await renderHook(() => useSignOut(), { wrapper: buildWrapper(queryClient) });

    await result.current.requestSignOut();

    expect(queryClient.getQueryData(STALE_QUERY_KEY)).toBeUndefined();
  });

  it('失敗したらキャッシュを消さない', async () => {
    // 消してからサインアウトに失敗すると、ログイン中なのに何も表示されない画面になる
    mockSignOutFromApp.mockRejectedValue(new AuthError('network'));
    const queryClient = createQueryClient();
    queryClient.setQueryData(STALE_QUERY_KEY, STALE_QUERY_DATA);
    const { result } = await renderHook(() => useSignOut(), { wrapper: buildWrapper(queryClient) });

    await expect(result.current.requestSignOut()).resolves.toBe(false);

    expect(queryClient.getQueryData(STALE_QUERY_KEY)).toEqual(STALE_QUERY_DATA);
  });

  it('失敗の理由を日本語で返す', async () => {
    mockSignOutFromApp.mockRejectedValue(new AuthError('network'));
    const queryClient = createQueryClient();
    const { result } = await renderHook(() => useSignOut(), { wrapper: buildWrapper(queryClient) });

    await result.current.requestSignOut();

    await waitFor(() => {
      expect(result.current.errorMessage).toBe(AUTH_ERROR_MESSAGES.network);
    });
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- use-sign-out`
Expected: FAIL（`Cannot find module './use-sign-out'`）

- [ ] **Step 3: `features/auth/use-sign-out.ts` を作る**

```ts
// apps/mobile/src/features/auth/use-sign-out.ts
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { signOutFromApp } from '@/features/auth/api';
import { useAuthMutation } from '@/features/auth/use-auth-mutation';

export interface SignOutResult {
  /** 成功したら true。失敗したら false（理由は errorMessage に入る） */
  requestSignOut: () => Promise<boolean>;
  isSigningOut: boolean;
  errorMessage: string | undefined;
}

/**
 * サインアウトと、それに伴うキャッシュの後始末。
 *
 * 画面遷移はここではしない。セッションが消えれば useAuth() が unauthenticated になり、
 * ルート _layout のガードと index のディスパッチャが行き先を決める（Task 5-8 / 5-9）。
 */
export function useSignOut(): SignOutResult {
  const queryClient = useQueryClient();
  const { submit, isSubmitting, errorMessage } = useAuthMutation<void>(signOutFromApp);

  const requestSignOut = useCallback(async (): Promise<boolean> => {
    // TInput が void なので引数は undefined を明示して渡す
    const hasSignedOut = await submit(undefined);

    if (!hasSignedOut) {
      // 失敗時にキャッシュまで消すと、ログイン状態のまま中身が空の画面になる
      return false;
    }

    // 次に使う人へ前の利用者のデータを見せないため、キャッシュを丸ごと捨てる。
    // removeQueries ではなく clear にするのは、購読中のクエリが保持している
    // 最後のデータまで確実に落とすため
    queryClient.clear();
    return true;
  }, [queryClient, submit]);

  return { requestSignOut, isSigningOut: isSubmitting, errorMessage };
}
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- use-sign-out`
Expected: PASS（5 件）

- [ ] **Step 4: SignOutButton の失敗するテストを書く**

```tsx
// apps/mobile/src/components/auth/sign-out-button.test.tsx
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AlertButton } from 'react-native';
import { Alert } from 'react-native';

import { AUTH_ERROR_MESSAGES, AuthError } from '@/features/auth/auth-error';
import { createQueryClient } from '@/lib/query-client';

const mockSignOutFromApp = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();

jest.mock('@/features/auth/api', () => ({ signOutFromApp: mockSignOutFromApp }));
jest.mock('expo-router', () => ({ router: { replace: mockReplace, push: mockPush } }));

import { SignOutButton } from './sign-out-button';

const BUTTON_TEST_ID = 'sign-out-button';
const ERROR_TEST_ID = 'sign-out-button-error';
const STALE_QUERY_KEY = ['shops', 'nearby'] as const;

function renderSignOutButton(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <SignOutButton />
    </QueryClientProvider>,
  );
}

/** 確認ダイアログから、指定したスタイルのボタンを取り出して押す */
async function pressAlertButton(
  alertSpy: jest.SpyInstance,
  style: NonNullable<AlertButton['style']>,
): Promise<void> {
  const call = alertSpy.mock.calls[0];
  const buttons = (call?.[2] ?? []) as AlertButton[];
  const target = buttons.find((button) => button.style === style);

  if (target === undefined) {
    throw new Error(`確認ダイアログに style=${style} のボタンが無い`);
  }

  await act(async () => {
    target.onPress?.();
  });
}

describe('SignOutButton', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('ログアウトのボタンを表示する', async () => {
    await renderSignOutButton(createQueryClient());

    expect(screen.getByTestId(BUTTON_TEST_ID)).toBeOnTheScreen();
  });

  it('押しただけではログアウトせず、確認を求める', async () => {
    await renderSignOutButton(createQueryClient());

    await fireEvent.press(screen.getByTestId(BUTTON_TEST_ID));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mockSignOutFromApp).not.toHaveBeenCalled();
  });

  it('確認ダイアログには取り消しと破壊的操作の両方がある', async () => {
    await renderSignOutButton(createQueryClient());

    await fireEvent.press(screen.getByTestId(BUTTON_TEST_ID));

    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as AlertButton[];
    expect(buttons.map((button) => button.style)).toEqual(
      expect.arrayContaining(['cancel', 'destructive']),
    );
  });

  it('確認して初めてログアウトする', async () => {
    mockSignOutFromApp.mockResolvedValue(undefined);
    await renderSignOutButton(createQueryClient());

    await fireEvent.press(screen.getByTestId(BUTTON_TEST_ID));
    await pressAlertButton(alertSpy, 'destructive');

    await waitFor(() => {
      expect(mockSignOutFromApp).toHaveBeenCalledTimes(1);
    });
  });

  it('取り消しを選ぶとログアウトしない', async () => {
    await renderSignOutButton(createQueryClient());

    await fireEvent.press(screen.getByTestId(BUTTON_TEST_ID));
    await pressAlertButton(alertSpy, 'cancel');

    expect(mockSignOutFromApp).not.toHaveBeenCalled();
  });

  it('ログアウトに成功したらキャッシュが空になる', async () => {
    mockSignOutFromApp.mockResolvedValue(undefined);
    const queryClient = createQueryClient();
    queryClient.setQueryData(STALE_QUERY_KEY, { shopIds: ['shp_1'] });
    await renderSignOutButton(queryClient);

    await fireEvent.press(screen.getByTestId(BUTTON_TEST_ID));
    await pressAlertButton(alertSpy, 'destructive');

    await waitFor(() => {
      expect(queryClient.getQueryData(STALE_QUERY_KEY)).toBeUndefined();
    });
  });

  it('ログアウトに失敗したら理由を画面に出す', async () => {
    mockSignOutFromApp.mockRejectedValue(new AuthError('network'));
    await renderSignOutButton(createQueryClient());

    await fireEvent.press(screen.getByTestId(BUTTON_TEST_ID));
    await pressAlertButton(alertSpy, 'destructive');

    await waitFor(() => {
      expect(screen.getByTestId(ERROR_TEST_ID)).toHaveTextContent(AUTH_ERROR_MESSAGES.network);
    });
  });

  it('遷移は自分では行わない（ガードと index に任せる）', async () => {
    mockSignOutFromApp.mockResolvedValue(undefined);
    await renderSignOutButton(createQueryClient());

    await fireEvent.press(screen.getByTestId(BUTTON_TEST_ID));
    await pressAlertButton(alertSpy, 'destructive');

    await waitFor(() => {
      expect(mockSignOutFromApp).toHaveBeenCalled();
    });
    // ここで replace を書くと、ガードによる巻き戻しと競合して履歴が壊れる
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- sign-out-button`
Expected: FAIL（`Cannot find module './sign-out-button'`）

- [ ] **Step 5: `components/auth/sign-out-button.tsx` を作る**

```tsx
// apps/mobile/src/components/auth/sign-out-button.tsx
import { useCallback } from 'react';
import { Alert, View } from 'react-native';

import { FormErrorBanner } from '@/components/auth/form-error-banner';
import { Button } from '@/components/ui/button';
import { useSignOut } from '@/features/auth/use-sign-out';

const CONFIRM_TITLE = 'ログアウトしますか？';
const CONFIRM_MESSAGE = '次に使うときは、もう一度ログインが必要になります。';
const CONFIRM_LABEL = 'ログアウトする';
const CANCEL_LABEL = 'やめる';
const BUTTON_LABEL = 'ログアウト';
const DEFAULT_TEST_ID = 'sign-out-button';

export interface SignOutButtonProps {
  testID?: string | undefined;
}

/**
 * 3 ロール共通のログアウトボタン。
 * 誤タップで即ログアウトさせないよう、必ず 1 段の確認を挟む。
 */
export function SignOutButton({ testID = DEFAULT_TEST_ID }: SignOutButtonProps) {
  const { requestSignOut, isSigningOut, errorMessage } = useSignOut();

  const confirmSignOut = useCallback(() => {
    Alert.alert(CONFIRM_TITLE, CONFIRM_MESSAGE, [
      { text: CANCEL_LABEL, style: 'cancel' },
      {
        text: CONFIRM_LABEL,
        style: 'destructive',
        onPress: () => {
          void requestSignOut();
        },
      },
    ]);
  }, [requestSignOut]);

  return (
    <View className="gap-sm">
      <FormErrorBanner message={errorMessage} testID={`${testID}-error`} />
      <Button
        isLoading={isSigningOut}
        label={BUTTON_LABEL}
        onPress={confirmSignOut}
        testID={testID}
        variant="danger"
      />
    </View>
  );
}
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- sign-out-button`
Expected: PASS（8 件）

- [ ] **Step 6: SecureStore が実際に失効することを確かめるテストを書く**

`useSignOut` のテストは `signOutFromApp` をモックしているため、**端末から資格情報が消えたことは何も保証していない**。その部分は `@better-auth/expo` の責務なので、このファイルだけ実体を動かして確認する。

```ts
// apps/mobile/src/features/auth/sign-out-storage.test.ts
import { AUTH_STORAGE_PREFIX } from '@/constants/auth';

const mockSetItemAsync = jest.fn(async () => undefined);
const mockGetItemAsync = jest.fn(async () => null);

// authClient は**モックしない**。SecureStore だけ差し替えて書き込みを観測する
jest.mock('expo-secure-store', () => ({
  getItem: jest.fn(() => null),
  getItemAsync: mockGetItemAsync,
  setItem: jest.fn(),
  setItemAsync: mockSetItemAsync,
}));

import { authClient } from '@/lib/auth-client';

const COOKIE_STORAGE_KEY = `${AUTH_STORAGE_PREFIX}_cookie`;
const SESSION_CACHE_STORAGE_KEY = `${AUTH_STORAGE_PREFIX}_session_data`;

/**
 * 失効時に書き戻される値。
 * @better-auth/expo は deleteItemAsync ではなく空 JSON の上書きで消す
 * （node_modules/@better-auth/expo/dist/client.js:598-606 の clearSessionCache）。
 */
const CLEARED_VALUE = '{}';

function buildOkResponse(): Response {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('サインアウト時の SecureStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(async () => buildOkResponse()) as unknown as typeof fetch;
  });

  it('Cookie とセッションキャッシュの両方を失効させる', async () => {
    await authClient.signOut();

    expect(mockSetItemAsync).toHaveBeenCalledWith(COOKIE_STORAGE_KEY, CLEARED_VALUE);
    expect(mockSetItemAsync).toHaveBeenCalledWith(SESSION_CACHE_STORAGE_KEY, CLEARED_VALUE);
  });

  it('通信に失敗しても端末側の資格情報は残さない', async () => {
    // init フック（= リクエスト送信前）で失効させる実装のため、通信の成否に依存しない
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await authClient.signOut().catch(() => undefined);

    expect(mockSetItemAsync).toHaveBeenCalledWith(COOKIE_STORAGE_KEY, CLEARED_VALUE);
  });

  it('保存キーは storagePrefix から組み立てられている', async () => {
    // 接頭辞を変えたのにキーだけ古いまま、という取り違えを防ぐ
    await authClient.signOut();

    const writtenKeys = mockSetItemAsync.mock.calls.map(([key]) => key);
    for (const key of writtenKeys) {
      expect(key).toContain(AUTH_STORAGE_PREFIX);
    }
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- sign-out-storage`
Expected: PASS（3 件）

**通らなかった場合の切り分け順:** ①`transformIgnorePatterns`（Task 5-2 Step 1 の追加分）が効いているか、②`Response` が globalThis にあるか（無ければ `jest-setup.ts` ではなくこのファイル内で最小のスタブを定義する）、③`API_BASE_URL` が絶対 URL か（`new URL(url, options?.baseURL)` が投げる）。

- [ ] **Step 7: 利用者の設定画面の失敗するテストを書く**

```tsx
// apps/mobile/src/app/(user)/settings/index.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ACCOUNT_SETTINGS_ROUTE, SHOP_APPLICATION_ROUTE } from '@/constants/auth';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({ router: { push: mockPush } }));

import SettingsScreen from './index';

describe('SettingsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('アカウント設定への導線がある', async () => {
    await render(<SettingsScreen />);

    await fireEvent.press(screen.getByTestId('settings-account-link'));

    expect(mockPush).toHaveBeenCalledWith(ACCOUNT_SETTINGS_ROUTE);
  });

  it('店舗の登録申請への導線がある', async () => {
    await render(<SettingsScreen />);

    await fireEvent.press(screen.getByTestId('settings-shop-application-link'));

    expect(mockPush).toHaveBeenCalledWith(SHOP_APPLICATION_ROUTE);
  });

  it('設定画面自体はログアウトボタンを持たない', async () => {
    // 一覧から直接ログアウトできると誤タップの危険が上がる。アカウント画面に置く
    await render(<SettingsScreen />);

    expect(screen.queryByTestId('user-sign-out-button')).toBeNull();
  });
});
```

```tsx
// apps/mobile/src/app/(user)/settings/account.test.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';

import { ROLE_LABELS } from '@/constants/auth';
import { createQueryClient } from '@/lib/query-client';

const mockUseAuth = jest.fn();

jest.mock('@/features/auth/auth-context', () => ({ useAuth: mockUseAuth }));
jest.mock('@/features/auth/api', () => ({ signOutFromApp: jest.fn() }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn() } }));

import AccountSettingsScreen from './account';

const AUTHENTICATED_USER = {
  status: 'authenticated' as const,
  userId: 'usr_1',
  role: 'user' as const,
  displayName: '山田太郎',
};

function renderAccountSettingsScreen() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AccountSettingsScreen />
    </QueryClientProvider>,
  );
}

describe('AccountSettingsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue(AUTHENTICATED_USER);
  });

  it('表示名とロールを表示する', async () => {
    await renderAccountSettingsScreen();

    expect(screen.getByText(AUTHENTICATED_USER.displayName)).toBeOnTheScreen();
    expect(screen.getByText(ROLE_LABELS.user)).toBeOnTheScreen();
  });

  it('ログアウトボタンがある', async () => {
    await renderAccountSettingsScreen();

    expect(screen.getByTestId('user-sign-out-button')).toBeOnTheScreen();
  });

  it('認証済みでないときは身元の表示を出さない（ログアウト直後の 1 フレーム対策）', async () => {
    // ガードが閉じるまでの 1 フレーム、unauthenticated のままこの画面が描かれうる
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });

    await renderAccountSettingsScreen();

    expect(screen.queryByTestId('account-settings-identity')).toBeNull();
    expect(screen.getByTestId('user-sign-out-button')).toBeOnTheScreen();
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- "settings/"`
Expected: FAIL（プレースホルダのため導線もログアウトも無い）

- [ ] **Step 8: 利用者の設定画面 2 枚を実装に差し替える**

```tsx
// apps/mobile/src/app/(user)/settings/index.tsx
import { router } from 'expo-router';
import { ScrollView } from 'react-native';

import { Button } from '@/components/ui/button';
import { ACCOUNT_SETTINGS_ROUTE, SHOP_APPLICATION_ROUTE } from '@/constants/auth';

export default function SettingsScreen() {
  return (
    <ScrollView
      className="flex-1 bg-neutral-50"
      contentContainerClassName="gap-sm p-lg"
      testID="settings-screen"
    >
      <Button
        label="アカウント"
        onPress={() => {
          router.push(ACCOUNT_SETTINGS_ROUTE);
        }}
        testID="settings-account-link"
        variant="outline"
      />
      <Button
        label="お店の方へ（店舗の登録申請）"
        onPress={() => {
          router.push(SHOP_APPLICATION_ROUTE);
        }}
        testID="settings-shop-application-link"
        variant="outline"
      />
    </ScrollView>
  );
}
```

```tsx
// apps/mobile/src/app/(user)/settings/account.tsx
import { ScrollView, Text, View } from 'react-native';

import { SignOutButton } from '@/components/auth/sign-out-button';
import { ROLE_LABELS } from '@/constants/auth';
import { useAuth } from '@/features/auth/auth-context';

export default function AccountSettingsScreen() {
  const authState = useAuth();

  return (
    <ScrollView
      className="flex-1 bg-neutral-50"
      contentContainerClassName="gap-lg p-lg"
      testID="account-settings-screen"
    >
      {authState.status === 'authenticated' ? (
        <View className="gap-xs" testID="account-settings-identity">
          <Text className="font-body-bold text-lg text-neutral-900">{authState.displayName}</Text>
          <Text className="font-body text-sm text-neutral-600">{ROLE_LABELS[authState.role]}</Text>
        </View>
      ) : null}

      <SignOutButton testID="user-sign-out-button" />
    </ScrollView>
  );
}
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- "settings/"`
Expected: PASS（6 件）

- [ ] **Step 9: 店舗管理者のアカウント画面の失敗するテストを書く**

```tsx
// apps/mobile/src/app/(owner)/(tabs)/account.test.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { OWNER_ONBOARDING_STATUS_ROUTE, ROLE_LABELS } from '@/constants/auth';
import { createQueryClient } from '@/lib/query-client';

const mockUseAuth = jest.fn();
const mockPush = jest.fn();

jest.mock('@/features/auth/auth-context', () => ({ useAuth: mockUseAuth }));
jest.mock('@/features/auth/api', () => ({ signOutFromApp: jest.fn() }));
jest.mock('expo-router', () => ({ router: { push: mockPush, replace: jest.fn() } }));

import OwnerAccountScreen from './account';

const AUTHENTICATED_OWNER = {
  status: 'authenticated' as const,
  userId: 'usr_2',
  role: 'owner' as const,
  displayName: '鈴木商店',
};

function renderOwnerAccountScreen() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <OwnerAccountScreen />
    </QueryClientProvider>,
  );
}

describe('OwnerAccountScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue(AUTHENTICATED_OWNER);
  });

  it('表示名と店舗管理者であることを表示する', async () => {
    await renderOwnerAccountScreen();

    expect(screen.getByText(AUTHENTICATED_OWNER.displayName)).toBeOnTheScreen();
    expect(screen.getByText(ROLE_LABELS.owner)).toBeOnTheScreen();
  });

  it('審査状況への導線がある', async () => {
    await renderOwnerAccountScreen();

    await fireEvent.press(screen.getByTestId('owner-onboarding-status-link'));

    expect(mockPush).toHaveBeenCalledWith(OWNER_ONBOARDING_STATUS_ROUTE);
  });

  it('ログアウトボタンがある', async () => {
    await renderOwnerAccountScreen();

    expect(screen.getByTestId('owner-sign-out-button')).toBeOnTheScreen();
  });
});
```

```tsx
// apps/mobile/src/app/(admin)/(tabs)/more.test.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';

import { ROLE_LABELS } from '@/constants/auth';
import { createQueryClient } from '@/lib/query-client';

const mockUseAuth = jest.fn();

jest.mock('@/features/auth/auth-context', () => ({ useAuth: mockUseAuth }));
jest.mock('@/features/auth/api', () => ({ signOutFromApp: jest.fn() }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn() } }));

import AdminMoreScreen from './more';

const AUTHENTICATED_ADMIN = {
  status: 'authenticated' as const,
  userId: 'usr_3',
  role: 'admin' as const,
  displayName: '運営担当',
};

function renderAdminMoreScreen() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AdminMoreScreen />
    </QueryClientProvider>,
  );
}

describe('AdminMoreScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue(AUTHENTICATED_ADMIN);
  });

  it('表示名とシステム管理者であることを表示する', async () => {
    await renderAdminMoreScreen();

    expect(screen.getByText(AUTHENTICATED_ADMIN.displayName)).toBeOnTheScreen();
    expect(screen.getByText(ROLE_LABELS.admin)).toBeOnTheScreen();
  });

  it('ログアウトボタンがある', async () => {
    await renderAdminMoreScreen();

    expect(screen.getByTestId('admin-sign-out-button')).toBeOnTheScreen();
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- "(tabs)/account" "(tabs)/more"`
Expected: FAIL（どちらもプレースホルダのまま）

- [ ] **Step 10: 店舗管理者 / システム管理者の画面を実装に差し替える**

```tsx
// apps/mobile/src/app/(owner)/(tabs)/account.tsx
import { router } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';

import { SignOutButton } from '@/components/auth/sign-out-button';
import { Button } from '@/components/ui/button';
import { OWNER_ONBOARDING_STATUS_ROUTE, ROLE_LABELS } from '@/constants/auth';
import { useAuth } from '@/features/auth/auth-context';

export default function OwnerAccountScreen() {
  const authState = useAuth();

  return (
    <ScrollView
      className="flex-1 bg-neutral-50"
      contentContainerClassName="gap-lg p-lg"
      testID="owner-account-screen"
    >
      {authState.status === 'authenticated' ? (
        <View className="gap-xs" testID="owner-account-identity">
          <Text className="font-body-bold text-lg text-neutral-900">{authState.displayName}</Text>
          <Text className="font-body text-sm text-neutral-600">{ROLE_LABELS[authState.role]}</Text>
        </View>
      ) : null}

      <Button
        label="申請・審査の状況"
        onPress={() => {
          router.push(OWNER_ONBOARDING_STATUS_ROUTE);
        }}
        testID="owner-onboarding-status-link"
        variant="outline"
      />

      <SignOutButton testID="owner-sign-out-button" />
    </ScrollView>
  );
}
```

```tsx
// apps/mobile/src/app/(admin)/(tabs)/more.tsx
import { ScrollView, Text, View } from 'react-native';

import { SignOutButton } from '@/components/auth/sign-out-button';
import { ROLE_LABELS } from '@/constants/auth';
import { useAuth } from '@/features/auth/auth-context';

export default function AdminMoreScreen() {
  const authState = useAuth();

  return (
    <ScrollView
      className="flex-1 bg-neutral-50"
      contentContainerClassName="gap-lg p-lg"
      testID="admin-more-screen"
    >
      {authState.status === 'authenticated' ? (
        <View className="gap-xs" testID="admin-more-identity">
          <Text className="font-body-bold text-lg text-neutral-900">{authState.displayName}</Text>
          <Text className="font-body text-sm text-neutral-600">{ROLE_LABELS[authState.role]}</Text>
        </View>
      ) : null}

      <SignOutButton testID="admin-sign-out-button" />
    </ScrollView>
  );
}
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- "(tabs)/account" "(tabs)/more"`
Expected: PASS（5 件）

- [ ] **Step 11: わざと壊してテストが落ちることを確認する**

`useSignOut` の `if (!hasSignedOut) { return false; }` を削除し、「失敗したらキャッシュを消さない」が**失敗すること**を確認する。
続けて `SignOutButton` の `Alert.alert(...)` を `void requestSignOut();` の直接呼び出しに書き換え、「押しただけではログアウトせず、確認を求める」が**失敗すること**を確認する。
さらに `sign-out-storage.test.ts` の `CLEARED_VALUE` を `''` に書き換え、3 件すべてが**失敗すること**（= このテストが実際に書き込み値を見張っていること）を確認してから、すべて元に戻す。

- [ ] **Step 12: 認証まわりのテストをまとめて流す（回帰）**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile && npm run typecheck -w @meshimap/mobile`
Expected: すべて PASS。型エラー 0 件。

- [ ] **Step 13: コミットする**

```bash
git add apps/mobile/src/constants/auth.ts apps/mobile/src/app/route-files.test.ts apps/mobile/src/features/auth/use-sign-out.ts apps/mobile/src/features/auth/use-sign-out.test.tsx apps/mobile/src/features/auth/sign-out-storage.test.ts apps/mobile/src/components/auth/sign-out-button.tsx apps/mobile/src/components/auth/sign-out-button.test.tsx "apps/mobile/src/app/(user)/settings" "apps/mobile/src/app/(owner)/(tabs)/account.tsx" "apps/mobile/src/app/(owner)/(tabs)/account.test.tsx" "apps/mobile/src/app/(admin)/(tabs)/more.tsx" "apps/mobile/src/app/(admin)/(tabs)/more.test.tsx"
git commit -m "feat(mobile): 3 ロール共通のサインアウトと設定画面を実装する"
```

---

### Task 5-19: 店舗申請（user → owner 昇格）の導線を実装する

**ロール選択画面を作らない理由**

新規登録時に「利用者 / 店舗管理者 / システム管理者」を選ばせる画面は**作らない**。設計書 §4 は「1 アカウント 1 ロール。ただし `user` から店舗申請を出し、審査通過で `owner` へ昇格する」と定めており、ロールは**サーバの `profiles.role` が唯一の出所**（Task 5-5）。登録時に自己申告で選ばせると、

- `owner` を自称した利用者が店舗管理画面へ入れてしまう（`admin` なら更に致命的）
- クライアントの選択とサーバの `profiles.role` の 2 か所に真実ができる

の 2 点が起きる。よって Phase 5 のロール決定は「登録直後は必ず `user`、`owner` へは審査つきの申請だけが道」とし、この Task がその申請導線にあたる。`admin` はアプリから昇格させない（運用側で直接付与する）。

**Files:**

- Modify: `apps/mobile/src/lib/api-types.ts`
- Create: `apps/mobile/src/constants/shop-application.ts`
- Create: `apps/mobile/src/constants/shop-application.test.ts`
- Create: `apps/mobile/src/features/shop-application/schema.ts`
- Create: `apps/mobile/src/features/shop-application/schema.test.ts`
- Create: `apps/mobile/src/features/shop-application/api.ts`
- Create: `apps/mobile/src/features/shop-application/api.test.ts`
- Modify: `apps/mobile/src/app/(user)/settings/shop-application.tsx`
- Create: `apps/mobile/src/app/(user)/settings/shop-application.test.tsx`
- Modify: `apps/mobile/src/app/(owner)/onboarding/status.tsx`
- Create: `apps/mobile/src/app/(owner)/onboarding/status.test.tsx`

**Interfaces:**

- Consumes:
  - `@meshimap/core` の `SHOP_NAME_MAX_LENGTH`（= 100）
  - `apiClient.api['shop-applications'].$post` / `apiClient.api['shop-applications'].me.$get`（Task 5-3 の暫定 `AppType` を拡張して生やす）
  - `useAuthMutation`（Task 5-13）、`useQuery`（TanStack Query v5）、`Input` / `INPUT_TEXT_BEHAVIORS`（Task 5-10）、`AuthFormScreen` / `FormErrorBanner`（Task 5-12）、`ErrorState`（既存）
- Produces:
  - `const shopApplicationSchema` と `type ShopApplicationInput = { shopName: string; contactName: string; phoneNumber: string }`（**モバイル側で定義する**。`@meshimap/core` に申請スキーマは存在しない）
  - `const CONTACT_NAME_MAX_LENGTH: 50`
  - `type ShopApplicationStatus = 'pending' | 'approved' | 'rejected'`
  - `interface ShopApplicationSummary { id: string; shopName: string; status: ShopApplicationStatus; submittedAt: string; rejectionReason: string | null }`
  - `const SHOP_APPLICATION_QUERY_KEY: readonly ['shop-application', 'me']`
  - `const SHOP_APPLICATION_STATUS_LABELS: Record<ShopApplicationStatus, string>`
  - `async function submitShopApplication(input: ShopApplicationInput): Promise<void>`
  - `async function fetchMyShopApplication(): Promise<ShopApplicationSummary | null>`

- [ ] **Step 1: 暫定 `AppType` に申請エンドポイントを足す**

`apps/mobile/src/lib/api-types.ts` に次を追記し、`MobileApiSchema` にエントリを 2 つ足す。

```ts
export type ShopApplicationStatus = 'pending' | 'approved' | 'rejected';

/** 申請 1 件の要約。審査に必要な書類や写真は Phase 9 の管理画面側で扱う */
export interface ShopApplicationSummary {
  id: string;
  shopName: string;
  status: ShopApplicationStatus;
  /** ISO 8601 の文字列。JSON をまたぐので Date にはしない */
  submittedAt: string;
  rejectionReason: string | null;
}

/** 申請の送信内容。features/shop-application/schema.ts の ShopApplicationInput と同じ形 */
interface ShopApplicationRequestBody {
  shopName: string;
  contactName: string;
  phoneNumber: string;
}
```

```ts
// MobileApiSchema に足す 2 エントリ
  '/api/shop-applications': {
    $post: {
      input: { json: ShopApplicationRequestBody };
      output: { applicationId: string };
      outputFormat: 'json';
      status: 201;
    };
  };
  '/api/shop-applications/me': {
    $get: {
      input: Record<string, never>;
      // 未申請を null で表す。204 にすると RPC 側の型が空になって扱いにくい
      output: { application: ShopApplicationSummary | null };
      outputFormat: 'json';
      status: 200;
    };
  };
```

- [ ] **Step 2: 入力スキーマ `features/shop-application/schema.ts` と `schema.test.ts` を作る**

Task 5-4 と同じ理由で `@meshimap/core` には申請スキーマが無いので、モバイル側に置く。
店舗名の上限だけは core が `SHOP_NAME_MAX_LENGTH`（= 100）を export しているのでそれを使う
（申請で通った店舗名が `shopCreateSchema` で弾かれないようにするため）。

```ts
// apps/mobile/src/features/shop-application/schema.ts
import { SHOP_NAME_MAX_LENGTH } from '@meshimap/core';
import { z } from 'zod';

/** ご担当者名の上限。profiles.display_name と同じ 50 文字に揃える（設計書 §6） */
export const CONTACT_NAME_MAX_LENGTH = 50;

/**
 * 国内の市外局番形式（ハイフン必須）。`packages/core/src/schema.ts` の PHONE_PATTERN と同じ式。
 * core 側は module private で export されていないため、ここで持つしかない。
 * ここを緩めると、申請時に通った番号が店舗登録（`shopCreateSchema.phone`）で弾かれて
 * 「申請は通ったのに店舗が作れない」という直しにくい不整合になる。
 * TODO(Phase 2): packages/core が PHONE_PATTERN を export したら、この定義を捨てて import に差し替える。
 */
const PHONE_PATTERN = /^0[0-9]{1,4}-[0-9]{1,4}-[0-9]{3,4}$/;

const SHOP_NAME_REQUIRED_MESSAGE = '店舗名を入力してください。';
const SHOP_NAME_MAX_MESSAGE = `店舗名は ${SHOP_NAME_MAX_LENGTH} 文字以内で入力してください。`;
const CONTACT_NAME_REQUIRED_MESSAGE = 'ご担当者名を入力してください。';
const CONTACT_NAME_MAX_MESSAGE = `ご担当者名は ${CONTACT_NAME_MAX_LENGTH} 文字以内で入力してください。`;
const PHONE_NUMBER_MESSAGE = '電話番号はハイフン区切りで入力してください（例: 03-1234-5678）。';

/** transform / default を入れない。z.input と z.output を一致させないと zodResolver に渡せない */
export const shopApplicationSchema = z.object({
  shopName: z
    .string()
    .trim()
    .min(1, { error: SHOP_NAME_REQUIRED_MESSAGE })
    .max(SHOP_NAME_MAX_LENGTH, { error: SHOP_NAME_MAX_MESSAGE }),
  contactName: z
    .string()
    .trim()
    .min(1, { error: CONTACT_NAME_REQUIRED_MESSAGE })
    .max(CONTACT_NAME_MAX_LENGTH, { error: CONTACT_NAME_MAX_MESSAGE }),
  phoneNumber: z.string().regex(PHONE_PATTERN, { error: PHONE_NUMBER_MESSAGE }),
});

export type ShopApplicationInput = z.infer<typeof shopApplicationSchema>;
```

```ts
// apps/mobile/src/features/shop-application/schema.test.ts
import { SHOP_NAME_MAX_LENGTH } from '@meshimap/core';

import { CONTACT_NAME_MAX_LENGTH, shopApplicationSchema } from './schema';

const VALID_APPLICATION = {
  shopName: '定食や まる',
  contactName: '山田太郎',
  phoneNumber: '03-1234-5678',
};

describe('shopApplicationSchema', () => {
  it('3 項目が揃っていれば通る', () => {
    expect(shopApplicationSchema.safeParse(VALID_APPLICATION).success).toBe(true);
  });

  it('未入力は弾く（送信ボタンから API を呼ばせないため）', () => {
    expect(
      shopApplicationSchema.safeParse({ shopName: '', contactName: '', phoneNumber: '' }).success,
    ).toBe(false);
  });

  it('店舗名は上限ちょうどなら通り、1 文字超過は弾く（境界値）', () => {
    const atMax = 'あ'.repeat(SHOP_NAME_MAX_LENGTH);

    expect(shopApplicationSchema.safeParse({ ...VALID_APPLICATION, shopName: atMax }).success).toBe(
      true,
    );
    expect(
      shopApplicationSchema.safeParse({ ...VALID_APPLICATION, shopName: `${atMax}あ` }).success,
    ).toBe(false);
  });

  it('ご担当者名は上限ちょうどなら通り、1 文字超過は弾く（境界値）', () => {
    const atMax = 'あ'.repeat(CONTACT_NAME_MAX_LENGTH);

    expect(
      shopApplicationSchema.safeParse({ ...VALID_APPLICATION, contactName: atMax }).success,
    ).toBe(true);
    expect(
      shopApplicationSchema.safeParse({ ...VALID_APPLICATION, contactName: `${atMax}あ` }).success,
    ).toBe(false);
  });

  it('電話番号はハイフン無しを弾く（core の PHONE_PATTERN と同じ規則）', () => {
    expect(
      shopApplicationSchema.safeParse({ ...VALID_APPLICATION, phoneNumber: '0312345678' }).success,
    ).toBe(false);
  });

  it('0 始まりでない電話番号を弾く', () => {
    expect(
      shopApplicationSchema.safeParse({ ...VALID_APPLICATION, phoneNumber: '13-1234-5678' })
        .success,
    ).toBe(false);
  });

  it('フリーダイヤル形式も通る', () => {
    expect(
      shopApplicationSchema.safeParse({ ...VALID_APPLICATION, phoneNumber: '0120-123-456' })
        .success,
    ).toBe(true);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- shop-application/schema`
Expected: PASS（7 件）

- [ ] **Step 3: `constants/shop-application.ts` を作る**

```ts
// apps/mobile/src/constants/shop-application.ts
import type { ShopApplicationStatus } from '@/lib/api-types';

/** 申請状況を TanStack Query で保持するときのキー */
export const SHOP_APPLICATION_QUERY_KEY = ['shop-application', 'me'] as const;

/** 申請状況の再取得間隔。審査は人手なので短く見に行っても意味がない（5 分） */
export const SHOP_APPLICATION_STALE_TIME_MS = 5 * 60 * 1000;

export const SHOP_APPLICATION_STATUS_LABELS: Record<ShopApplicationStatus, string> = {
  pending: '審査中',
  approved: '承認済み',
  rejected: '否認',
};

export const SHOP_APPLICATION_STATUS_DESCRIPTIONS: Record<ShopApplicationStatus, string> = {
  pending: '運営が内容を確認しています。結果はメールでお知らせします。',
  approved: '店舗管理者としてご利用いただけます。店舗情報の登録へお進みください。',
  rejected: '内容を確認のうえ、修正して再度お申し込みください。',
};
```

`constants/shop-application.ts` は `src/app/**` の外にある実装ファイルなので、テストが無いと
カバレッジ 0% で集計されて 100% 閾値に引っかかる。同じステップでテストも作る。

```ts
// apps/mobile/src/constants/shop-application.test.ts
import {
  SHOP_APPLICATION_QUERY_KEY,
  SHOP_APPLICATION_STALE_TIME_MS,
  SHOP_APPLICATION_STATUS_DESCRIPTIONS,
  SHOP_APPLICATION_STATUS_LABELS,
} from './shop-application';

/** api-types.ts の ShopApplicationStatus と対になる値。状態が増減したらここで落ちる */
const ALL_STATUSES = ['pending', 'approved', 'rejected'] as const;

describe('店舗申請の定数', () => {
  it('クエリキーは他機能と衝突しない名前空間から始まる', () => {
    expect(SHOP_APPLICATION_QUERY_KEY[0]).toBe('shop-application');
  });

  it('状況ラベルは 3 状態すべてを埋めている', () => {
    expect(Object.keys(SHOP_APPLICATION_STATUS_LABELS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('状況の説明文も 3 状態すべてを埋めている', () => {
    expect(Object.keys(SHOP_APPLICATION_STATUS_DESCRIPTIONS).sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
  });

  it('ラベルと説明文はどちらも空文字にしない', () => {
    for (const status of ALL_STATUSES) {
      expect(SHOP_APPLICATION_STATUS_LABELS[status].length).toBeGreaterThan(0);
      expect(SHOP_APPLICATION_STATUS_DESCRIPTIONS[status].length).toBeGreaterThan(0);
    }
  });

  it('再取得間隔は正の値', () => {
    expect(SHOP_APPLICATION_STALE_TIME_MS).toBeGreaterThan(0);
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- constants/shop-application`
Expected: PASS（5 件）

- [ ] **Step 4: 申請 API の失敗するテストを書く**

```ts
// apps/mobile/src/features/shop-application/api.test.ts
import { HTTP_STATUS } from '@/constants/http';
import { AUTH_ERROR_MESSAGES } from '@/features/auth/auth-error';

const mockApplicationPost = jest.fn();
const mockApplicationMeGet = jest.fn();

jest.mock('@/lib/api-client', () => ({
  apiClient: {
    api: {
      'shop-applications': {
        $post: mockApplicationPost,
        me: { $get: mockApplicationMeGet },
      },
    },
  },
}));

import { fetchMyShopApplication, submitShopApplication } from './api';

const VALID_APPLICATION = {
  shopName: '定食や まる',
  contactName: '山田太郎',
  phoneNumber: '03-1234-5678',
};

const PENDING_APPLICATION = {
  id: 'sap_1',
  shopName: '定食や まる',
  status: 'pending' as const,
  submittedAt: '2026-09-15T02:00:00.000Z',
  rejectionReason: null,
};

describe('submitShopApplication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('入力を json ボディとして送る', async () => {
    mockApplicationPost.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ applicationId: 'sap_1' }),
    });

    await expect(submitShopApplication(VALID_APPLICATION)).resolves.toBeUndefined();
    expect(mockApplicationPost).toHaveBeenCalledWith({ json: VALID_APPLICATION });
  });

  it('409 のときは重複として日本語で投げる', async () => {
    // 申請済みの利用者が二重送信したときに届く
    mockApplicationPost.mockResolvedValue({
      ok: false,
      status: HTTP_STATUS.conflict,
      json: async () => ({}),
    });

    await expect(submitShopApplication(VALID_APPLICATION)).rejects.toThrow(
      AUTH_ERROR_MESSAGES['email-already-used'],
    );
  });
});

describe('fetchMyShopApplication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('申請があればその要約を返す', async () => {
    mockApplicationMeGet.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ application: PENDING_APPLICATION }),
    });

    await expect(fetchMyShopApplication()).resolves.toEqual(PENDING_APPLICATION);
  });

  it('未申請なら null を返す（境界値）', async () => {
    mockApplicationMeGet.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ application: null }),
    });

    await expect(fetchMyShopApplication()).resolves.toBeNull();
  });

  it('401 なら例外を投げる', async () => {
    mockApplicationMeGet.mockResolvedValue({
      ok: false,
      status: HTTP_STATUS.unauthorized,
      json: async () => ({}),
    });

    await expect(fetchMyShopApplication()).rejects.toThrow(
      AUTH_ERROR_MESSAGES['invalid-credentials'],
    );
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- shop-application/api`
Expected: FAIL（`Cannot find module './api'`）

- [ ] **Step 5: `features/shop-application/api.ts` を作る**

```ts
// apps/mobile/src/features/shop-application/api.ts
import { toAuthError } from '@/features/auth/auth-error';
import type { ShopApplicationInput } from '@/features/shop-application/schema';
import { apiClient } from '@/lib/api-client';
import type { ShopApplicationSummary } from '@/lib/api-types';
import { logger } from '@/lib/logger';

export async function submitShopApplication(input: ShopApplicationInput): Promise<void> {
  const response = await apiClient.api['shop-applications'].$post({ json: input });

  if (!response.ok) {
    logger.warn('店舗申請の送信に失敗した', { status: response.status });
    // 409 は toAuthError が 'email-already-used'（= 既に登録済み）へ寄せる。
    // 文言は「このメールアドレスは〜」ではなく汎用にしたいが、画面側で
    // 状況（申請済み）を先に出すので、ここでは種別の一貫性を優先する
    throw toAuthError({ status: response.status });
  }
}

export async function fetchMyShopApplication(): Promise<ShopApplicationSummary | null> {
  const response = await apiClient.api['shop-applications'].me.$get();

  if (!response.ok) {
    logger.warn('店舗申請の状況取得に失敗した', { status: response.status });
    throw toAuthError({ status: response.status });
  }

  const body = await response.json();
  return body.application;
}
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- shop-application/api`
Expected: PASS（5 件）

- [ ] **Step 6: 利用者側の申請画面の失敗するテストを書く**

```tsx
// apps/mobile/src/app/(user)/settings/shop-application.test.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { SHOP_APPLICATION_STATUS_LABELS } from '@/constants/shop-application';
import { AUTH_ERROR_MESSAGES, AuthError } from '@/features/auth/auth-error';
import { createQueryClient } from '@/lib/query-client';

const mockSubmitShopApplication = jest.fn();
const mockFetchMyShopApplication = jest.fn();

jest.mock('@/features/shop-application/api', () => ({
  submitShopApplication: mockSubmitShopApplication,
  fetchMyShopApplication: mockFetchMyShopApplication,
}));

import ShopApplicationScreen from './shop-application';

const SHOP_NAME_TEST_ID = 'shop-application-shop-name-input';
const CONTACT_NAME_TEST_ID = 'shop-application-contact-name-input';
const PHONE_TEST_ID = 'shop-application-phone-number-input';
const SUBMIT_TEST_ID = 'shop-application-submit-button';
const STATUS_TEST_ID = 'shop-application-status';
const LOADING_TEST_ID = 'shop-application-loading';
const ERROR_TEST_ID = 'shop-application-error';

const VALID_APPLICATION = {
  shopName: '定食や まる',
  contactName: '山田太郎',
  phoneNumber: '03-1234-5678',
};

const PENDING_APPLICATION = {
  id: 'sap_1',
  shopName: VALID_APPLICATION.shopName,
  status: 'pending' as const,
  submittedAt: '2026-09-15T02:00:00.000Z',
  rejectionReason: null,
};

function renderShopApplicationScreen() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ShopApplicationScreen />
    </QueryClientProvider>,
  );
}

async function fillApplicationForm(): Promise<void> {
  await fireEvent.changeText(screen.getByTestId(SHOP_NAME_TEST_ID), VALID_APPLICATION.shopName);
  await fireEvent.changeText(
    screen.getByTestId(CONTACT_NAME_TEST_ID),
    VALID_APPLICATION.contactName,
  );
  await fireEvent.changeText(screen.getByTestId(PHONE_TEST_ID), VALID_APPLICATION.phoneNumber);
}

describe('ShopApplicationScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchMyShopApplication.mockResolvedValue(null);
  });

  it('申請状況の取得中は入力欄を出さない', async () => {
    // 取得前にフォームを出すと、申請済みの人が二重に書いてしまう
    mockFetchMyShopApplication.mockReturnValue(new Promise(() => undefined));

    await renderShopApplicationScreen();

    expect(screen.getByTestId(LOADING_TEST_ID)).toBeOnTheScreen();
    expect(screen.queryByTestId(SHOP_NAME_TEST_ID)).toBeNull();
  });

  it('未申請なら入力欄を出す', async () => {
    await renderShopApplicationScreen();

    await waitFor(() => {
      expect(screen.getByTestId(SHOP_NAME_TEST_ID)).toBeOnTheScreen();
    });
    expect(screen.getByTestId(CONTACT_NAME_TEST_ID)).toBeOnTheScreen();
    expect(screen.getByTestId(PHONE_TEST_ID)).toBeOnTheScreen();
  });

  it('申請済みなら状況だけを出し、入力欄は出さない', async () => {
    mockFetchMyShopApplication.mockResolvedValue(PENDING_APPLICATION);

    await renderShopApplicationScreen();

    await waitFor(() => {
      expect(screen.getByTestId(STATUS_TEST_ID)).toHaveTextContent(
        SHOP_APPLICATION_STATUS_LABELS.pending,
      );
    });
    expect(screen.queryByTestId(SHOP_NAME_TEST_ID)).toBeNull();
  });

  it('未入力のまま送信すると API を呼ばない', async () => {
    await renderShopApplicationScreen();
    await waitFor(() => {
      expect(screen.getByTestId(SUBMIT_TEST_ID)).toBeOnTheScreen();
    });

    await fireEvent.press(screen.getByTestId(SUBMIT_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(SHOP_NAME_TEST_ID)).toHaveProp(
        'accessibilityLabel',
        expect.stringContaining('エラー: '),
      );
    });
    expect(mockSubmitShopApplication).not.toHaveBeenCalled();
  });

  it('入力を揃えて送信すると申請を送る', async () => {
    mockSubmitShopApplication.mockResolvedValue(undefined);
    await renderShopApplicationScreen();
    await waitFor(() => {
      expect(screen.getByTestId(SHOP_NAME_TEST_ID)).toBeOnTheScreen();
    });

    await fillApplicationForm();
    await fireEvent.press(screen.getByTestId(SUBMIT_TEST_ID));

    await waitFor(() => {
      expect(mockSubmitShopApplication).toHaveBeenCalledWith(VALID_APPLICATION);
    });
  });

  it('送信に成功したら状況を取り直す', async () => {
    mockSubmitShopApplication.mockResolvedValue(undefined);
    mockFetchMyShopApplication.mockResolvedValueOnce(null).mockResolvedValue(PENDING_APPLICATION);
    await renderShopApplicationScreen();
    await waitFor(() => {
      expect(screen.getByTestId(SHOP_NAME_TEST_ID)).toBeOnTheScreen();
    });

    await fillApplicationForm();
    await fireEvent.press(screen.getByTestId(SUBMIT_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(STATUS_TEST_ID)).toHaveTextContent(
        SHOP_APPLICATION_STATUS_LABELS.pending,
      );
    });
  });

  it('送信に失敗したら理由を出し、入力は消さない', async () => {
    mockSubmitShopApplication.mockRejectedValue(new AuthError('network'));
    await renderShopApplicationScreen();
    await waitFor(() => {
      expect(screen.getByTestId(SHOP_NAME_TEST_ID)).toBeOnTheScreen();
    });

    await fillApplicationForm();
    await fireEvent.press(screen.getByTestId(SUBMIT_TEST_ID));

    await waitFor(() => {
      expect(screen.getByTestId(ERROR_TEST_ID)).toHaveTextContent(AUTH_ERROR_MESSAGES.network);
    });
    // 書き直させると離脱する。パスワードと違って消す理由がない
    expect(screen.getByTestId(SHOP_NAME_TEST_ID)).toHaveProp('value', VALID_APPLICATION.shopName);
  });

  it('状況の取得に失敗したら再試行できる', async () => {
    mockFetchMyShopApplication.mockRejectedValue(new AuthError('network'));

    await renderShopApplicationScreen();

    await waitFor(() => {
      expect(screen.getByTestId('shop-application-load-error')).toBeOnTheScreen();
    });
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- "settings/shop-application"`
Expected: FAIL（プレースホルダのまま）

- [ ] **Step 7: `app/(user)/settings/shop-application.tsx` を実装に差し替える**

```tsx
// apps/mobile/src/app/(user)/settings/shop-application.tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { Text, View } from 'react-native';

import { AuthFormScreen } from '@/components/auth/auth-form-screen';
import { FormErrorBanner } from '@/components/auth/form-error-banner';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { INPUT_TEXT_BEHAVIORS, Input } from '@/components/ui/input';
import {
  SHOP_APPLICATION_QUERY_KEY,
  SHOP_APPLICATION_STALE_TIME_MS,
  SHOP_APPLICATION_STATUS_DESCRIPTIONS,
  SHOP_APPLICATION_STATUS_LABELS,
} from '@/constants/shop-application';
import { useAuthMutation } from '@/features/auth/use-auth-mutation';
import { fetchMyShopApplication, submitShopApplication } from '@/features/shop-application/api';
import {
  shopApplicationSchema,
  type ShopApplicationInput,
} from '@/features/shop-application/schema';

const EMPTY_APPLICATION: ShopApplicationInput = {
  shopName: '',
  contactName: '',
  phoneNumber: '',
};

const LOADING_MESSAGE = '申請の状況を確認しています';
const LOAD_ERROR_TITLE = '申請の状況を取得できませんでした';
const LOAD_ERROR_DESCRIPTION = '通信状況を確認して、もう一度お試しください。';

export default function ShopApplicationScreen() {
  const queryClient = useQueryClient();

  const {
    data: application,
    isPending: isLoadingApplication,
    isError: hasLoadFailed,
    refetch,
  } = useQuery({
    queryKey: SHOP_APPLICATION_QUERY_KEY,
    queryFn: fetchMyShopApplication,
    staleTime: SHOP_APPLICATION_STALE_TIME_MS,
  });

  const { control, handleSubmit } = useForm<ShopApplicationInput>({
    resolver: zodResolver(shopApplicationSchema),
    defaultValues: EMPTY_APPLICATION,
    mode: 'onTouched',
  });

  const {
    submit: sendApplication,
    isSubmitting,
    errorMessage,
  } = useAuthMutation(submitShopApplication);

  const submitApplication = handleSubmit(async (values) => {
    const hasSubmitted = await sendApplication(values);

    if (!hasSubmitted) {
      // 入力は残す。書き直させると離脱する（パスワードのように消す理由がない）
      return;
    }

    // 送信直後は状況を取り直して、フォームから審査中の表示へ切り替える
    await queryClient.invalidateQueries({ queryKey: SHOP_APPLICATION_QUERY_KEY });
  });

  if (isLoadingApplication) {
    return (
      <AuthFormScreen
        description="申請済みかどうかを確認しています"
        testID="shop-application-screen"
        title="店舗の登録申請"
      >
        <Text
          accessibilityLiveRegion="polite"
          className="text-center font-body text-base text-neutral-600"
          testID="shop-application-loading"
        >
          {LOADING_MESSAGE}
        </Text>
      </AuthFormScreen>
    );
  }

  if (hasLoadFailed) {
    return (
      <View className="flex-1 justify-center bg-neutral-50">
        <ErrorState
          description={LOAD_ERROR_DESCRIPTION}
          onRetry={() => {
            void refetch();
          }}
          testID="shop-application-load-error"
          title={LOAD_ERROR_TITLE}
        />
      </View>
    );
  }

  if (application !== null && application !== undefined) {
    return (
      <AuthFormScreen
        description={SHOP_APPLICATION_STATUS_DESCRIPTIONS[application.status]}
        testID="shop-application-screen"
        title="店舗の登録申請"
      >
        <View
          className="gap-xs rounded-card border border-neutral-200 bg-white px-md py-md"
          testID="shop-application-status"
        >
          <Text className="font-body-bold text-lg text-neutral-900">{application.shopName}</Text>
          <Text className="font-body text-base text-neutral-700">
            {SHOP_APPLICATION_STATUS_LABELS[application.status]}
          </Text>
          {application.rejectionReason === null ? null : (
            <Text className="font-body text-sm text-neutral-600">
              {application.rejectionReason}
            </Text>
          )}
        </View>
      </AuthFormScreen>
    );
  }

  return (
    <AuthFormScreen
      description="審査のうえ、店舗管理者としてご利用いただけるようにします"
      testID="shop-application-screen"
      title="店舗の登録申請"
    >
      <FormErrorBanner message={errorMessage} testID="shop-application-error" />

      <Controller
        control={control}
        name="shopName"
        render={({ field, fieldState }) => (
          <Input
            errorMessage={fieldState.error?.message}
            isDisabled={isSubmitting}
            isRequired
            label="店舗名"
            onBlur={field.onBlur}
            onChangeText={field.onChange}
            placeholder="定食や まる"
            testID="shop-application-shop-name-input"
            value={field.value}
          />
        )}
      />

      <Controller
        control={control}
        name="contactName"
        render={({ field, fieldState }) => (
          <Input
            errorMessage={fieldState.error?.message}
            isDisabled={isSubmitting}
            isRequired
            label="ご担当者名"
            onBlur={field.onBlur}
            onChangeText={field.onChange}
            placeholder="山田太郎"
            testID="shop-application-contact-name-input"
            textBehavior={INPUT_TEXT_BEHAVIORS.personName}
            value={field.value}
          />
        )}
      />

      <Controller
        control={control}
        name="phoneNumber"
        render={({ field, fieldState }) => (
          <Input
            errorMessage={fieldState.error?.message}
            isDisabled={isSubmitting}
            isRequired
            label="連絡先電話番号"
            onBlur={field.onBlur}
            onChangeText={field.onChange}
            placeholder="03-1234-5678"
            testID="shop-application-phone-number-input"
            textBehavior={INPUT_TEXT_BEHAVIORS.telephone}
            value={field.value}
          />
        )}
      />

      <Button
        isLoading={isSubmitting}
        label="申請する"
        onPress={() => {
          void submitApplication();
        }}
        testID="shop-application-submit-button"
      />
    </AuthFormScreen>
  );
}
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- "settings/shop-application"`
Expected: PASS（8 件）

- [ ] **Step 8: 店舗管理者側の審査状況画面の失敗するテストを書く**

```tsx
// apps/mobile/src/app/(owner)/onboarding/status.test.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react-native';

import { SHOP_APPLICATION_STATUS_LABELS } from '@/constants/shop-application';
import { AuthError } from '@/features/auth/auth-error';
import { createQueryClient } from '@/lib/query-client';

const mockFetchMyShopApplication = jest.fn();

jest.mock('@/features/shop-application/api', () => ({
  fetchMyShopApplication: mockFetchMyShopApplication,
}));

import OwnerOnboardingStatusScreen from './status';

const APPROVED_APPLICATION = {
  id: 'sap_1',
  shopName: '定食や まる',
  status: 'approved' as const,
  submittedAt: '2026-09-15T02:00:00.000Z',
  rejectionReason: null,
};

const REJECTED_APPLICATION = {
  id: 'sap_2',
  shopName: '定食や まる',
  status: 'rejected' as const,
  submittedAt: '2026-09-15T02:00:00.000Z',
  rejectionReason: '営業許可証の写しが確認できませんでした。',
};

function renderStatusScreen() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <OwnerOnboardingStatusScreen />
    </QueryClientProvider>,
  );
}

describe('OwnerOnboardingStatusScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchMyShopApplication.mockResolvedValue(APPROVED_APPLICATION);
  });

  it('承認済みの申請を表示する', async () => {
    await renderStatusScreen();

    await waitFor(() => {
      expect(screen.getByTestId('owner-onboarding-status')).toHaveTextContent(
        SHOP_APPLICATION_STATUS_LABELS.approved,
      );
    });
    expect(screen.getByText(APPROVED_APPLICATION.shopName)).toBeOnTheScreen();
  });

  it('否認なら理由も表示する', async () => {
    mockFetchMyShopApplication.mockResolvedValue(REJECTED_APPLICATION);

    await renderStatusScreen();

    await waitFor(() => {
      expect(screen.getByText(REJECTED_APPLICATION.rejectionReason)).toBeOnTheScreen();
    });
  });

  it('申請が見つからないときは空の案内を出す（境界値）', async () => {
    // 運営が直接 owner を付与した場合、申請レコードが無いことがある
    mockFetchMyShopApplication.mockResolvedValue(null);

    await renderStatusScreen();

    await waitFor(() => {
      expect(screen.getByTestId('owner-onboarding-empty')).toBeOnTheScreen();
    });
  });

  it('取得に失敗したら再試行できる', async () => {
    mockFetchMyShopApplication.mockRejectedValue(new AuthError('network'));

    await renderStatusScreen();

    await waitFor(() => {
      expect(screen.getByTestId('owner-onboarding-error')).toBeOnTheScreen();
    });
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- "onboarding/status"`
Expected: FAIL（プレースホルダのまま）

- [ ] **Step 9: `app/(owner)/onboarding/status.tsx` を実装に差し替える**

```tsx
// apps/mobile/src/app/(owner)/onboarding/status.tsx
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react-native';
import { ScrollView, Text, View } from 'react-native';

import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import {
  SHOP_APPLICATION_QUERY_KEY,
  SHOP_APPLICATION_STALE_TIME_MS,
  SHOP_APPLICATION_STATUS_DESCRIPTIONS,
  SHOP_APPLICATION_STATUS_LABELS,
} from '@/constants/shop-application';
import { fetchMyShopApplication } from '@/features/shop-application/api';

const LOADING_MESSAGE = '申請の状況を確認しています';
const EMPTY_TITLE = '申請の記録がありません';
const EMPTY_DESCRIPTION = '運営から直接ご案内した場合、このページには何も表示されません。';
const ERROR_TITLE = '申請の状況を取得できませんでした';
const ERROR_DESCRIPTION = '通信状況を確認して、もう一度お試しください。';

export default function OwnerOnboardingStatusScreen() {
  const {
    data: application,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: SHOP_APPLICATION_QUERY_KEY,
    queryFn: fetchMyShopApplication,
    staleTime: SHOP_APPLICATION_STALE_TIME_MS,
  });

  if (isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50">
        <Text
          accessibilityLiveRegion="polite"
          className="font-body text-base text-neutral-600"
          testID="owner-onboarding-loading"
        >
          {LOADING_MESSAGE}
        </Text>
      </View>
    );
  }

  if (isError) {
    return (
      <View className="flex-1 justify-center bg-neutral-50">
        <ErrorState
          description={ERROR_DESCRIPTION}
          onRetry={() => {
            void refetch();
          }}
          testID="owner-onboarding-error"
          title={ERROR_TITLE}
        />
      </View>
    );
  }

  if (application === null) {
    return (
      <View className="flex-1 justify-center bg-neutral-50">
        <EmptyState
          description={EMPTY_DESCRIPTION}
          // EmptyState の icon は必須 prop（components/ui/empty-state.tsx の EmptyStateProps）。
          // 「申請書の記録が無い」状態なので書類アイコンを選ぶ
          icon={FileText}
          testID="owner-onboarding-empty"
          title={EMPTY_TITLE}
        />
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-neutral-50"
      contentContainerClassName="gap-md p-lg"
      testID="owner-onboarding-status-screen"
    >
      <View
        className="gap-xs rounded-card border border-neutral-200 bg-white px-md py-md"
        testID="owner-onboarding-status"
      >
        <Text className="font-body-bold text-lg text-neutral-900">{application.shopName}</Text>
        <Text className="font-body text-base text-neutral-700">
          {SHOP_APPLICATION_STATUS_LABELS[application.status]}
        </Text>
        <Text className="font-body text-sm text-neutral-600">
          {SHOP_APPLICATION_STATUS_DESCRIPTIONS[application.status]}
        </Text>
        {application.rejectionReason === null ? null : (
          <Text className="text-danger-600 font-body text-sm">{application.rejectionReason}</Text>
        )}
      </View>
    </ScrollView>
  );
}
```

**注意:** `EmptyState` / `ErrorState` の props は Phase 0 の実装（`apps/mobile/src/components/ui/empty-state.tsx` / `error-state.tsx`）を読んで確認済み。

- `EmptyStateProps`: `icon: LucideIcon`（**必須**）/ `title: string`（必須）/ `description?` / `action?: { label; onPress; isDisabled?; isLoading? }` / `testID?`
- `ErrorStateProps`: `title?`（既定値 `'エラーが発生しました'`）/ `description?` / `onRetry: () => void`（**必須**）/ `testID?`

`actionLabel` / `onAction` という prop は**存在しない**。アクションを渡すのは `EmptyState` の `action` オブジェクトだけで、`ErrorState` の再試行は `onRetry` 固定（ボタン文言も `'再試行'` 固定）。

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- "onboarding/status"`
Expected: PASS（4 件）

- [ ] **Step 10: わざと壊してテストが落ちることを確認する**

`ShopApplicationScreen` の `if (isLoadingApplication) { ... }` ブロックを削除し、「申請状況の取得中は入力欄を出さない」が**失敗すること**を確認する。
続けて `if (application !== null && application !== undefined)` を `if (application !== undefined)` に書き換え、「未申請なら入力欄を出す」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 11: コミットする**

```bash
git add apps/mobile/src/lib/api-types.ts apps/mobile/src/constants/shop-application.ts apps/mobile/src/constants/shop-application.test.ts apps/mobile/src/features/shop-application "apps/mobile/src/app/(user)/settings/shop-application.tsx" "apps/mobile/src/app/(user)/settings/shop-application.test.tsx" "apps/mobile/src/app/(owner)/onboarding/status.tsx" "apps/mobile/src/app/(owner)/onboarding/status.test.tsx"
git commit -m "feat(mobile): 店舗申請（user から owner への昇格）の導線を実装する"
```

---

### Task 5-20: ルーティングの統合テストを書く

**このテストだけ実ファイルを読み込む理由**

Task 5-8 / 5-9 の単体テストは `_layout.tsx` と `index.tsx` を個別に描画するので、「ガードで弾かれたあとアンカーへ落ち、そこからロール別に配り直される」という**つながり**は検証できていない。`renderRouter` に実際の `src/app` を渡し、認証状態だけを差し替えて通しで確認する。

**`renderRouter` を使ううえで押さえる実装上の事実（すべて `node_modules/expo-router/build/testing-library/` で確認）**

| 事実                                                                                                                                                 | 出典                             | 影響                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `renderRouter(context, { initialUrl })` の戻り値は `render()` の戻り値（RNTL 14 では **Promise**）に `getPathname()` などを `Object.assign` したもの | `index.js:47-70`                 | `const app = renderRouter(...); await app;` のあと、**同じ `app`** から `app.getPathname()` を呼ぶ |
| 内部で `jest.useFakeTimers()` を呼ぶ                                                                                                                 | `index.js:36`                    | テストごとに `jest.useRealTimers()` で後始末する。待ちは `await act(...)` とタイマー進行で行う     |
| `getMockContext('./src/app')` は `path.resolve(process.cwd(), './src/app')` を読む                                                                   | `mock-config.js:20-21`           | Jest の cwd は `apps/mobile`。ワークスペース指定で実行すること                                     |
| `testRouter.push/replace` は `toHavePathnameWithParams` マッチャに依存し、型定義が無い（`expect.d.ts` は `export {};`）                              | `index.js:76-92` / `expect.d.ts` | `testRouter` とカスタムマッチャは使わず、`router` + `act()` + `getPathname()` で書く               |

**Files:**

- Create: `apps/mobile/src/app/routing.test.tsx`

**Interfaces:**

- Consumes:
  - `renderRouter(context?: MockContextConfig, options?: RenderRouterOptions): Result`、`Result = ReturnType<render> & { getPathname(): string; getPathnameWithParams(): string; getSegments(): string[]; getSearchParams(): Record<string, string | string[]>; getRouterState(): ReactNavigationState | undefined }`（`node_modules/expo-router/build/testing-library/index.d.ts`）
  - `act: typeof import('react').act` / `screen`（同ファイルの再 export）
  - `ROLE_HOME_ROUTES` / `WELCOME_ROUTE`（Task 5-1）、`type AuthState`（Task 5-1）、`ROLE_USER` / `ROLE_OWNER` / `ROLE_ADMIN` / `type Role`（`@meshimap/core`）
- Produces: なし（テストのみ）

- [ ] **Step 1: 認証状態を外から差し替えられるテストダブルを書く**

```tsx
// apps/mobile/src/app/routing.test.tsx
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER, type Role } from '@meshimap/core';
import { act, renderRouter, screen } from 'expo-router/testing-library';

import { ROLE_HOME_ROUTES, WELCOME_ROUTE } from '@/constants/auth';
import type { AuthState } from '@/features/auth/types';

/** 実ファイルを読み込む起点。Jest の cwd（apps/mobile）からの相対パス */
const APP_DIR = './src/app';

const RESTORING_STATE: AuthState = { status: 'restoring' };
const UNAUTHENTICATED_STATE: AuthState = { status: 'unauthenticated' };

/** ブランド型 UserId はテスト専用に `as never` で満たす（Task 5-8 の注記と同じ方針）*/
function buildAuthenticatedState(role: Role): AuthState {
  return {
    status: 'authenticated',
    userId: 'usr_1' as never,
    role,
    displayName: '山田太郎',
  };
}

/**
 * useAuth の差し替え先。
 * useState をコンポーネント内に置くと呼び出し箇所ごとに状態が分かれてしまうため、
 * 外部ストア + useSyncExternalStore にして全箇所が必ず同じ値を見るようにする。
 */
interface MockAuthStore {
  state: AuthState;
  listeners: Set<() => void>;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => AuthState;
  set: (next: AuthState) => void;
}

const mockAuthStore: MockAuthStore = {
  state: RESTORING_STATE,
  listeners: new Set<() => void>(),
  subscribe(listener: () => void): () => void {
    mockAuthStore.listeners.add(listener);
    return () => {
      mockAuthStore.listeners.delete(listener);
    };
  },
  getSnapshot(): AuthState {
    return mockAuthStore.state;
  },
  set(next: AuthState): void {
    mockAuthStore.state = next;
    for (const listener of mockAuthStore.listeners) {
      listener();
    }
  },
};

jest.mock('@/features/auth/auth-context', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');

  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) =>
      mockReact.createElement(mockReact.Fragment, null, children),
    useAuth: () =>
      mockReact.useSyncExternalStore(mockAuthStore.subscribe, mockAuthStore.getSnapshot),
  };
});

// フォントとスプラッシュは行き先の判定に関係しないので決着済みに固定する
jest.mock('@/hooks/use-app-fonts', () => ({
  useAppFonts: () => ({ hasFontLoadingSettled: true }),
}));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => true),
}));

// 画面が import するだけで実体が動かないよう、通信の末端だけ潰す
jest.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: { email: jest.fn() },
    signUp: { email: jest.fn() },
    requestPasswordReset: jest.fn(),
    sendVerificationEmail: jest.fn(),
    signOut: jest.fn(),
    useSession: jest.fn(() => ({ data: null, isPending: false })),
  },
}));
jest.mock('@/lib/api-client', () => ({
  apiClient: {
    api: {
      me: { $get: jest.fn() },
      'shop-applications': { $post: jest.fn(), me: { $get: jest.fn() } },
    },
  },
}));
```

- [ ] **Step 2: 遷移の落ち着きを待つヘルパーを書く**

```tsx
/**
 * renderRouter は内部で jest.useFakeTimers() を呼ぶ（index.js:36）。
 * React Navigation の状態更新はタイマーとマイクロタスクの両方に乗るため、
 * 判定の前に両方を進める。
 */
async function settleNavigation(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockAuthStore.state = RESTORING_STATE;
  mockAuthStore.listeners.clear();
});

afterEach(() => {
  // renderRouter が入れたフェイクタイマーを次のテストへ持ち越さない
  jest.useRealTimers();
});
```

- [ ] **Step 3: 復元中と未認証のテストを書く**

```tsx
describe('復元中', () => {
  it('ログイン画面を出さずに読み込み中だけを見せる', async () => {
    mockAuthStore.state = RESTORING_STATE;

    const app = renderRouter(APP_DIR, { initialUrl: '/' });
    await app;
    await settleNavigation();

    expect(screen.getByTestId('auth-loading-screen')).toBeOnTheScreen();
    // ちらつきの正体は「復元中に一瞬ログイン系画面が出ること」。ここが本丸
    expect(screen.queryByTestId('welcome-screen')).toBeNull();
    expect(screen.queryByTestId('sign-in-screen')).toBeNull();
    expect(app.getPathname()).toBe('/');
  });

  it('復元が終わると保留していた判定が動く', async () => {
    mockAuthStore.state = RESTORING_STATE;

    const app = renderRouter(APP_DIR, { initialUrl: '/' });
    await app;
    await settleNavigation();

    await act(async () => {
      mockAuthStore.set(UNAUTHENTICATED_STATE);
    });
    await settleNavigation();

    expect(app.getPathname()).toBe(String(WELCOME_ROUTE));
  });
});

describe('未認証', () => {
  it('入り口を開くと welcome へ送られる', async () => {
    mockAuthStore.state = UNAUTHENTICATED_STATE;

    const app = renderRouter(APP_DIR, { initialUrl: '/' });
    await app;
    await settleNavigation();

    expect(app.getPathname()).toBe(String(WELCOME_ROUTE));
  });

  it('利用者向けのパスを直接開いても入れない', async () => {
    // ディープリンクや古い通知から /home が叩かれる場合を想定
    mockAuthStore.state = UNAUTHENTICATED_STATE;

    const app = renderRouter(APP_DIR, { initialUrl: String(ROLE_HOME_ROUTES.user) });
    await app;
    await settleNavigation();

    expect(app.getPathname()).toBe(String(WELCOME_ROUTE));
  });

  it('サインイン画面へは入れる', async () => {
    mockAuthStore.state = UNAUTHENTICATED_STATE;

    const app = renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    await app;
    await settleNavigation();

    expect(app.getPathname()).toBe('/sign-in');
  });
});
```

- [ ] **Step 4: ロールごとの着地と越境のテストを書く**

```tsx
describe('ロールごとの着地', () => {
  it.each([
    [ROLE_USER, String(ROLE_HOME_ROUTES.user)],
    [ROLE_OWNER, String(ROLE_HOME_ROUTES.owner)],
    [ROLE_ADMIN, String(ROLE_HOME_ROUTES.admin)],
  ])('%s は %s に着地する', async (role, expectedPathname) => {
    mockAuthStore.state = buildAuthenticatedState(role);

    const app = renderRouter(APP_DIR, { initialUrl: '/' });
    await app;
    await settleNavigation();

    expect(app.getPathname()).toBe(expectedPathname);
  });

  it('利用者は店舗管理者のパスへ入れない', async () => {
    mockAuthStore.state = buildAuthenticatedState(ROLE_USER);

    const app = renderRouter(APP_DIR, { initialUrl: String(ROLE_HOME_ROUTES.owner) });
    await app;
    await settleNavigation();

    expect(app.getPathname()).toBe(String(ROLE_HOME_ROUTES.user));
  });

  it('店舗管理者は管理者のパスへ入れない', async () => {
    mockAuthStore.state = buildAuthenticatedState(ROLE_OWNER);

    const app = renderRouter(APP_DIR, { initialUrl: String(ROLE_HOME_ROUTES.admin) });
    await app;
    await settleNavigation();

    expect(app.getPathname()).toBe(String(ROLE_HOME_ROUTES.owner));
  });

  it('認証済みでも welcome には入れない', async () => {
    // ログイン済みの人が古いリンクから welcome を開いても、自分のホームへ戻る
    mockAuthStore.state = buildAuthenticatedState(ROLE_USER);

    const app = renderRouter(APP_DIR, { initialUrl: String(WELCOME_ROUTE) });
    await app;
    await settleNavigation();

    expect(app.getPathname()).toBe(String(ROLE_HOME_ROUTES.user));
  });

  it('ロールが変わると着地先も変わる（審査通過で owner に昇格した場合）', async () => {
    mockAuthStore.state = buildAuthenticatedState(ROLE_USER);

    const app = renderRouter(APP_DIR, { initialUrl: '/' });
    await app;
    await settleNavigation();
    expect(app.getPathname()).toBe(String(ROLE_HOME_ROUTES.user));

    await act(async () => {
      mockAuthStore.set(buildAuthenticatedState(ROLE_OWNER));
    });
    await settleNavigation();

    expect(app.getPathname()).toBe(String(ROLE_HOME_ROUTES.owner));
  });
});
```

- [ ] **Step 5: サインアウトと異常系のテストを書く**

```tsx
describe('サインアウトと異常系', () => {
  it('セッションが消えると未認証の入り口へ戻る', async () => {
    mockAuthStore.state = buildAuthenticatedState(ROLE_USER);

    const app = renderRouter(APP_DIR, { initialUrl: '/' });
    await app;
    await settleNavigation();

    await act(async () => {
      mockAuthStore.set(UNAUTHENTICATED_STATE);
    });
    await settleNavigation();

    expect(app.getPathname()).toBe(String(WELCOME_ROUTE));
  });

  it('プロフィールを取れないときはログイン画面に戻さず再試行を出す', async () => {
    // セッションは生きているのでログアウト扱いにしてはいけない
    const retry = jest.fn();
    mockAuthStore.state = { status: 'profile-unavailable', retry };

    const app = renderRouter(APP_DIR, { initialUrl: '/' });
    await app;
    await settleNavigation();

    expect(screen.getByTestId('profile-unavailable-error')).toBeOnTheScreen();
    expect(app.getPathname()).toBe('/');
    expect(screen.queryByTestId('welcome-screen')).toBeNull();
  });

  it('存在しないパスは 404 の画面になる', async () => {
    mockAuthStore.state = buildAuthenticatedState(ROLE_USER);

    const app = renderRouter(APP_DIR, { initialUrl: '/this-route-does-not-exist' });
    await app;
    await settleNavigation();

    expect(screen.getByTestId('not-found-root-button')).toBeOnTheScreen();
  });
});
```

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- routing`
Expected: すべて PASS（15 件 = 復元中 2 + 未認証 3 + ロールごとの着地 7（`it.each` の 3 件を含む） + サインアウトと異常系 3）

**通らなかった場合の切り分け順:**

1. `app.getPathname()` が `undefined` → `await app` を忘れている（`renderRouter` の戻り値は Promise 兼オブジェクト）
2. パスが遷移前のまま → `settleNavigation()` の呼び忘れ。`jest.advanceTimersByTime(0)` を `advanceTimersByTimeAsync` に替えて再試行する
3. `Multiple routes resolved to the same route` → `src/app` 配下に同名・別拡張子のファイルがある（`normalizeKeys` が投げる：`context-stubs.js:51-56`）
4. グループが平坦化されて全部が同じスタックに入る → どこかの `_layout.tsx` が欠けている（Task 5-7 の `route-files.test.ts` が守っている）

- [ ] **Step 6: わざと壊してテストが落ちることを確認する**

`app/_layout.tsx` の `(owner)` の `<Stack.Protected>` の `guard` を `guard={isAuthenticated}` に書き換え、「利用者は店舗管理者のパスへ入れない」が**失敗すること**を確認する。
続けて `app/index.tsx` の `if (authState.status === 'restoring')` ブロックを削除し、「ログイン画面を出さずに読み込み中だけを見せる」が**失敗すること**を確認してから両方を元に戻す。

- [ ] **Step 7: コミットする**

```bash
git add apps/mobile/src/app/routing.test.tsx
git commit -m "test(mobile): ロールルーティングの統合テストを追加する"
```

---

### Task 5-21: Phase 5 の総点検と設計書の追従

**このタスクの位置づけ**

ここまでのタスクは「新しく書いたものが動く」ことを確認してきた。最後に「**既にあったものを壊していない**」ことと「**紙（設計書）と実物がずれていない**」ことを確認する。Phase 6 以降のエージェントは設計書を読んで実装するため、§5.1 のずれを残すと次のフェーズが誤った前提で走る。

**Files:**

- Modify: `apps/mobile/jest.config.js`（`collectCoverageFrom` の `!src/app/**` を `!src/app/_dev/**` に差し替える。Step 4-a）
- Modify: `docs/superpowers/specs/2026-09-15-meshimap-design.md`（§5.1 のみ）
- Modify: `docs/superpowers/plans/2026-09-15-phase-5-auth-routing.md`（チェックボックスを埋める）

**Interfaces:**

- Consumes: なし（確認のみ）
- Produces: なし（確認のみ）

- [ ] **Step 1: 全テストを通す**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile`
Expected: 全スイート PASS。**Task 5-1 完了時点の 128 件が 1 件も減っていないこと**（Task 5-10 で `Input` に手を入れているので、ここが回帰の本命）。

128 件の内訳は「Phase 0 の 117 件 + Task 5-1 で足した 11 件（`constants/auth` 6 + `constants/http` 2 + `constants/api` 3）」。
2026-09-15 時点で `npx jest` を実行して `Tests: 128 passed, 128 total` を確認済み。
失敗した場合は件数が減っていないかを最初に見る。減っていれば削除・上書きの事故。

- [ ] **Step 2: 型チェックを通す**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm run typecheck -w @meshimap/mobile`
Expected: エラーなし。
`typedRoutes` が生成する `.expo/types/router.d.ts` は `expo start` 実行時に更新されるため、`Href` の型エラーが出た場合は一度 `npm run mobile` を起動してから再実行する。

- [ ] **Step 3: 禁止パターンが混入していないか機械的に確認する**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
cd /Users/hattori/Downloads/alee/apps/mobile

# console.log は logger.ts の sink 以外に存在してはいけない
grep -rn "console\.log" src/ --include="*.ts" --include="*.tsx" | grep -v "src/lib/logger.ts"

# any は全面禁止
grep -rn ": any\|<any>\|as any" src/ --include="*.ts" --include="*.tsx"

# 型アサーションは「ブランド型の生成」だけに許している。想定は auth-context.tsx の 1 行とテストの as never のみ
grep -rn " as " src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\." | grep -v "as const" | grep -v "import "

# 非 null アサーション
grep -rn "!\." src/ --include="*.ts" --include="*.tsx" | grep -v "!==" | grep -v "\.test\."
```

Expected: 1 つ目・2 つ目・4 つ目は**出力ゼロ**。3 つ目は `src/features/auth/auth-context.tsx` の `as UserId` **1 行だけ**。
それ以外が出たら、その場で直してから Step 1 に戻る。

- [ ] **Step 4: カバレッジを確認する（まず `src/app/` を除外したまま）**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm run test:coverage -w @meshimap/mobile`
Expected: **statements / branches / functions / lines すべて 100%**。

このタスクでカバレッジを 2 回測るのは、**落ちたときの原因を切り分けるため**。ここ（Step 4）は Phase 5 が足した `src/` 配下の非画面コードだけを見る。画面を含めた測定は除外を差し替えたあとの Step 4-b が持つ。1 回で済ませると「`auth-error.ts` の分岐漏れ」と「画面に到達していない」が同じ赤で混ざる。

`apps/mobile/jest.config.js:65-72` の `coverageThreshold.global` は 4 指標とも **100%** なので、1 行でも到達しない実装が残っていればこのコマンドは失敗する（「90% 以上あればよい」ではない）。
`collectCoverageFrom` は `['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}', '!src/app/**']`（同 :54）。**テストから一度も import されないファイルも 0% として分母に入る**ため、実装ファイルを足したタスクに対応するテストが無いとここで落ちる。
型しか持たないファイル（`features/auth/types.ts` / `lib/api-types.ts`）は babel が型を消して中身が空になり、分子も分母も 0 になるので閾値には影響しない（同 :55-59 のコメントと `coverage-summary.json` の実測で確認済み）。
落ちた場合、足りないのはたいてい `auth-error.ts` の未到達分岐。`auth-error.test.ts` にケースを足す。

**方針対立の決着（2026-09-15 に実測して確定。未確認事項 #13）:** `jest.config.js:63-64` のコメント（「`src/app/` は画面ができる Phase 5 のタイミングで除外を外し、同じ 100% を課すこと」）に**従う**。ただし外すのは `!src/app/**` 全体ではなく、`!src/app/_dev/**` を代わりに置く。切り替えるのは **Task 5-8 ではなくこの Task 5-21**。

決めた根拠（いずれも今日この作業ツリーで測った値）:

| 事実                                                           | 実測値                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `!src/app/**` を外したときの `src/app/` 全体                   | statements / branches / functions / lines すべて **0%**（テスト 128 件は PASS。閾値だけが落ちる） |
| 同じ条件での `src/app/_dev/`                                   | **100 / 100 / 80 / 100** — functions だけ 80%                                                     |
| Phase 5 開始時点で `src/app/` にある実装ファイル               | `_dev/catalog.tsx` / `_layout.tsx` / `index.tsx` の 3 つだけ                                      |
| Phase 5 が `src/app/` に置く実装ファイル（`.test.tsx` を除く） | **25 個**。うち `_layout.tsx` と `index.tsx` は既存の書き換え（Task 5-8 / 5-9）                   |

読み方は 2 つ。

1. **0% は「テストが無い」ではなく「除外されていたから一度も測っていない」だけ**。`_layout.tsx` と `index.tsx` は Phase 5 が書き換えるので、この 0% は Phase 5 の成果物で置き換わる。除外を外して困る既存ファイルは `_dev/catalog.tsx` **1 つだけ**で、その不足も functions の 80%（5 個中 1 個）に限られる。
2. **`_dev/catalog.tsx` は Phase 5 の所有物ではない**。Phase 0 が作った開発者向けの UI カタログで、Phase 5 はこのファイルを 1 行も触らない。他フェーズの資産を埋めるために Phase 5 の完了を止めるのは筋が違う。だから「除外を外す」と「`_dev` は除外に残す」は両立させる。

切り替えを Task 5-8 ではなく Task 5-21 に置くのは、**Phase 5 が置く 25 個の実装ファイルのうち専用テストを持つのは 13 個**で、残り 12 個（`(admin)/_layout.tsx` / `(admin)/(tabs)/_layout.tsx` / `(admin)/(tabs)/overview.tsx` / `(auth)/_layout.tsx` / `(owner)/_layout.tsx` / `(owner)/(tabs)/_layout.tsx` / `(owner)/(tabs)/dashboard.tsx` / `(user)/_layout.tsx` / `(user)/(tabs)/_layout.tsx` / `(user)/(tabs)/home.tsx` / `(user)/(tabs)/profile.tsx` / `+not-found.tsx`）は Task 5-20 の `routing.test.tsx` が `renderRouter` で実際に描画することでしか到達しないため。Task 5-8 の時点で外すと、まだ存在しない 24 ファイル分の 0% で `test:coverage` が落ち続け、Task 5-9 以降のすべてのタスクが赤いゲートを跨ぐことになる。**全画面が揃った最後に 1 度だけ外す。**

- [ ] **Step 4-a: `collectCoverageFrom` の除外を差し替える**

`apps/mobile/jest.config.js` の `collectCoverageFrom` を次に変える。

```js
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    // src/app/_dev/ は Phase 0 が作った開発者向けの UI カタログで、製品の画面ではない。
    // Phase 5 で src/app/ の除外を外したが、ここだけは Phase 5 の所有物ではないので残す。
    // （外すと functions が 80% になり、他フェーズの都合で Phase 5 が止まる）
    '!src/app/_dev/**',
  ],
```

同時に `:63-64` のコメント（「src/app/ は collectCoverageFrom で除外済み。……実装が入るタイミングで除外を外して同じ 100% を課すこと」）を、指示ではなく**実施済みの記録**に書き換える。

```js
// src/app/ の除外は Phase 5（画面の実装）で外した。残しているのは _dev のみで、
// 理由は collectCoverageFrom のコメントにある。
```

- [ ] **Step 4-b: 除外を外した状態でカバレッジを測り直す**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm run test:coverage -w @meshimap/mobile`
Expected: **4 指標とも 100%**。

落ちたときに見る場所は、たいてい上に挙げた「専用テストを持たない 12 ファイル」のどれか。埋め方は 2 通りあり、**先に前者を試す**。

1. Task 5-20 の `routing.test.tsx` に、その画面へ実際に遷移するケースを足す（統合テストで担保する、という本計画の方針そのもの）
2. それでも届かない分岐だけ、その画面に専用の `.test.tsx` を足す

`src/app/_dev/catalog.tsx` がレポートに出てきたら Step 4-a の除外が効いていない。`collectCoverageFrom` の並び順ではなく、パターンが `!src/app/_dev/**` になっているかを見る。

- [ ] **Step 5: 書式を揃える**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm run format:check`
Expected: エラーなし。落ちた場合のみ `npm run format` を実行し、差分が意図した範囲（Phase 5 で触ったファイル）に閉じていることを確認する。
`prettier-plugin-tailwindcss` が `className` のクラス順を並べ替えるため、**フォーマット後にもう一度 Step 1 を通す**こと。

- [ ] **Step 6: 3 ロールを実機（シミュレータ）で通す**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm run mobile:ios`

| 確認                         | 期待                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| 初回起動（未ログイン）       | スプラッシュ → welcome。**ログイン画面が一瞬も映らない**                 |
| サインイン（user）           | `/home` に着地し、タブが 2 つ表示される                                  |
| アプリを再起動               | スプラッシュのまま復元が終わり、welcome を経由せず `/home` へ直行する    |
| 設定 → ログアウト            | 確認ダイアログ → welcome に戻る。**戻るジェスチャで `/home` に戻れない** |
| owner アカウントでサインイン | `/dashboard` に着地する                                                  |
| admin アカウントでサインイン | `/overview` に着地する                                                   |
| 機内モードでサインイン       | 「通信できませんでした」系の文言が出て、パスワード欄が空になる           |

テスト用アカウントが未整備の場合は Phase 4 の seed 完了を待つ。**ここを飛ばして完了扱いにしない**（スプラッシュのちらつきは自動テストでは検出しきれない性質のもの）。

- [ ] **Step 7: 設計書 §5.1 を実装に合わせる**

`docs/superpowers/specs/2026-09-15-meshimap-design.md` の 144 行目を書き換える。

```diff
 │   ├── (tabs)/
 │   │   ├── _layout.tsx                # 5 タブ
-│   │   ├── index.tsx                  # ホーム：現在地周辺のおすすめ / 特集 / 履歴からの再訪提案
+│   │   ├── home.tsx                   # ホーム：現在地周辺のおすすめ / 特集 / 履歴からの再訪提案
 │   │   ├── map.tsx                    # ★主役：地図検索（クラスタ + ボトムシート + 絞り込み）
```

同じ §5.1 のツリー直後に、次の 1 行を追記する。

```markdown
> `(user)/(tabs)` のホームだけ `home.tsx` にしている。グループ名は URL に含まれないため `index.tsx` にすると root の `index.tsx`（ロールディスパッチャ）と同じ URL `/` を指してしまうため（Phase 5 計画の「設計書 §5.1 からの意図的な逸脱」を参照）。
```

**他の行は触らない。** Phase 6 以降の担当が書く予定の画面を先回りして変更しない。

- [ ] **Step 8: わざと壊して安全網が生きていることを確認する**

`apps/mobile/src/app/(user)/(tabs)/home.tsx` を `home-2.tsx` にリネームし、次の 2 つが**両方失敗すること**を確認する。

1. `route-files.test.ts`（Task 5-7）… 定数のパスに対応する実ファイルが無いことを検出する
2. `routing.test.tsx`（Task 5-20）… `user` の着地先が `/home` にならないことを検出する

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" && npm test -w @meshimap/mobile -- route-files routing`
Expected: FAIL（2 スイートとも）
確認できたらファイル名を元に戻し、再実行して PASS になることを確認する。
**この 2 段構えが Phase 6 以降でルートを増やすときの保険になる。**片方しか落ちない場合は、落ちなかった側のテストが実ファイルを見ていない（モックで閉じてしまっている）ということなので、そのテストを直す。

- [ ] **Step 9: 計画書のチェックボックスを埋めてコミットする**

本計画書の `- [ ]` を実施済みの状態に更新し、下の「Phase 5 完了条件」も埋める。

```bash
git add docs/superpowers/specs/2026-09-15-meshimap-design.md docs/superpowers/plans/2026-09-15-phase-5-auth-routing.md
git commit -m "docs: Phase 5 の完了を反映し設計書 5.1 のホームを home.tsx に揃える"
```

---

## Phase 5 完了条件

- [ ] `npm test -w @meshimap/mobile` が全件 PASS（Phase 0 の 105 件を含む）
- [ ] `npm run typecheck -w @meshimap/mobile` がエラーなし
- [ ] `npm run format:check` がエラーなし
- [ ] 未認証でアプリ内のどのパスを叩いても `(auth)` の外に入れない（Task 5-20 で自動検証）
- [ ] `user` / `owner` / `admin` がそれぞれ `/home` / `/dashboard` / `/overview` に着地する（Task 5-20 で自動検証）
- [ ] 他ロールのグループへは URL 直打ちでも入れない（Task 5-20 で自動検証）
- [ ] セッション復元中にログイン系画面が描画されない。スプラッシュはフォント読込と復元の**両方**が終わるまで閉じない（Task 5-20 + Step 6 の実機確認）
- [ ] プロフィール取得に失敗したときログイン画面に戻さず、再試行できる（Task 5-9 / 5-20）
- [ ] サインイン失敗時にエラー文言が出て、パスワード欄が空になる（Task 5-13）
- [ ] ログアウトで SecureStore の `meshimap-auth_cookie` / `meshimap-auth_session_data` が空になる。**通信に失敗しても端末側に資格情報が残らない**（Task 5-18 の `sign-out-storage.test.ts`）
- [ ] ログアウト後に TanStack Query のキャッシュが全消去され、次のユーザーに前のユーザーのデータが見えない（Task 5-18）
- [ ] `console.log` / `any` / 想定外の型アサーション / 非 null アサーションがゼロ（Task 5-21 Step 3）
- [ ] 設計書 §5.1 の `(user)/(tabs)` のホームが `home.tsx` に更新され、理由が追記されている（Task 5-21 Step 7）
- [ ] `route-files.test.ts` と `routing.test.tsx` がわざと壊して落ちることを確認済み（Task 5-21 Step 8）

## Phase 6 への引き継ぎ

| 項目                | Phase 5 で決めたこと                                                                                                                           | Phase 6 でやること                                                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ゲスト閲覧          | Phase 5 では**ゲスト導線を出さない**。行き先（地図・店舗詳細）がまだ無く、出口のない導線になるため（Task 5-17 の判断表）                       | `AuthState` に 5 つ目の `{ status: 'guest' }` を足し、`app/_layout.tsx` の `(user)` ガードを `isAuthenticatedUser \|\| isGuest` に緩める。`(user)/settings/**` と予約・レビュー系は `isAuthenticatedUser` のままにして、ゲストが入れない範囲を分ける。`welcome.tsx` に「まずは見てみる」の CTA を追加する |
| `lib/api-types.ts`  | `AppType` が `apps/api` から出ていないため、モバイル側で手書きの `MobileApiSchema` を置いて `hc<MobileApiSchema>` で型を付けている（Task 5-3） | Phase 4 が `AppType` を export したら `lib/api-client.ts` を `hc<AppType>` に差し替え、`lib/api-types.ts` を**削除**する。`api-client.test.ts` の「レスポンス型が想定どおり」テストがそのまま差し替え後の回帰テストになる                                                                                 |
| `(user)/(tabs)`     | Phase 5 は `home` / `profile` の 2 タブのみ（`▽` プレースホルダ）                                                                              | `map` / `search` / `saved` を足して 5 タブにする。`home.tsx` の中身を作る                                                                                                                                                                                                                                 |
| `PlaceholderScreen` | Phase 6 以降で中身を作る画面の枠として `▽` 印のファイルが使っている                                                                            | 実装した画面から順に `PlaceholderScreen` を剥がす。`src/` 全体から `PlaceholderScreen` の参照が消えた時点でコンポーネント自体を削除する                                                                                                                                                                   |
| 店舗申請            | `(user)/settings/shop-application.tsx` から申請を送り、`(owner)/onboarding/status.tsx` で審査状況を見るところまで（Task 5-19）                 | 審査通過時のロール変更をアプリに反映する経路（プッシュ通知 → `PROFILE_QUERY_KEY` の invalidate）を Phase 7 以降で追加する。ロールが変われば着地先が変わることは Task 5-20 で検証済み                                                                                                                      |

## 未確認事項

計画の作成時に**確認できなかった**点。実装時に最初に潰すこと。

| #   | 未確認の内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 影響するタスク                   | 実装時の確認方法                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `renderRouter` を**このリポジトリで実行していない**。とくに「RNTL 14 の全 API が Promise を返す」×「`renderRouter` が内部で `jest.useFakeTimers()` を呼ぶ（`node_modules/expo-router/build/testing-library/index.js:38`）」の組み合わせは型定義とソースからの推論にとどまる                                                                                                                                                                                                                                                                                                                                                                        | 5-20                             | Task 5-20 Step 3 を最初に単独で走らせる。`getPathname()` が `undefined` / 遷移が進まない場合は `settleNavigation()` を `await act(async () => { await jest.advanceTimersByTimeAsync(0); })` に替える                                                                                                                                                                            |
| 2   | `toHavePathname` 系のカスタムマッチャに**型定義が無い**（`expo-router/build/testing-library/expect.d.ts` の中身は `export {};`）。また `testRouter.*` は `act()` を await せずに呼ぶ実装（`index.js:76-92`）                                                                                                                                                                                                                                                                                                                                                                                                                                       | 5-20                             | 本計画ではどちらも使わず `getPathname()` で判定している。もし将来 `toHavePathname` を使うなら型拡張を自前で書く必要がある                                                                                                                                                                                                                                                       |
| 3   | **解消済み（2026-09-15 に実体を確認）。** `packages/core/src/index.ts` が export するロール系は `ROLES`（**`as const` のタプル**）/ `ROLE_USER` / `ROLE_OWNER` / `ROLE_ADMIN` / `type Role` / `isRole` / `toRole` / `canManageShop` / `canModerate`。`UserRole` / `USER_ROLES` は**存在しない**。認証・店舗申請の入力スキーマ（`signInSchema` / `signUpSchema` / `passwordResetRequestSchema` / `shopApplicationSchema`）も core に無く、`packages/core/src/index.test.ts` が公開 export 名を完全一致で固定しているため追加コストが高い。→ **モバイル側**（`features/auth/schema.ts` / `features/shop-application/schema.ts`）に置く方針に変更済み | 5-1, 5-4, 5-13, 5-14, 5-16, 5-19 | 対応不要。core の export を増やしたくなったら `packages/core/src/index.test.ts` の一覧も同時に直すこと                                                                                                                                                                                                                                                                          |
| 4   | **解消済み。** 本計画で使うスキーマはすべてモバイル側で新規に定義し、`transform` / `default` を持たせていない。`signUpSchema.displayName` の `.trim()` は値を変えるが TypeScript の型は `string` のままなので `z.input` と `z.output` は一致する                                                                                                                                                                                                                                                                                                                                                                                                   | 5-13, 5-14, 5-16, 5-19           | `features/auth/schema.ts` / `features/shop-application/schema.ts` に `transform` を足すときだけ再確認する。`zodResolver` は `Resolver<z4.input<T>, Context, z4.output<T>>` を返す（`node_modules/@hookform/resolvers/zod/dist/zod.d.ts`）                                                                                                                                       |
| 5   | `apps/api` が `AppType` を export していない。`lib/api-types.ts` の `MeResponseBody` / `MobileApiSchema`（`/api/me`・`/api/shop-applications`・`/api/shop-applications/me`）は**設計書 §7 から起こした暫定型**で、実際のレスポンスと突き合わせていない                                                                                                                                                                                                                                                                                                                                                                                             | 5-3, 5-19                        | Phase 4 完了後に `hc<AppType>` へ差し替える。差し替えで型エラーが出た箇所が、想定とサーバ実装のずれ                                                                                                                                                                                                                                                                             |
| 6   | `apps/api` 側の Better Auth の `emailAndPassword` 設定（`autoSignIn` / `requireEmailVerification`）が未確認。Task 5-14 は「サインアップ直後は認証済みにならず、メール確認待ち画面へ送る」前提で書いている                                                                                                                                                                                                                                                                                                                                                                                                                                          | 5-14, 5-15                       | Phase 4 の `auth.ts` を読む。`autoSignIn: true` なら Task 5-14 の遷移先を「確認待ち画面」から「ロールディスパッチャ」に変える                                                                                                                                                                                                                                                   |
| 7   | `authClient.getCookie()` の型が Better Auth の動的パスプロキシ経由で解決されることを**実行では確認していない**（`@better-auth/expo/dist/client.js` のソース読みのみ）                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 5-3                              | Task 5-3 Step 2 で `npm run typecheck` を通す。型が出ない場合は `authClient.getCookie` の代わりに `expo-secure-store` から `${AUTH_STORAGE_PREFIX}_cookie` を直接読む実装に切り替える                                                                                                                                                                                           |
| 8   | `authClient.useSession()` が**初回レンダーで `isPending: true` を返すか**を実行確認していない。ここが `false` スタートだと復元中の判定が 1 フレーム抜ける                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 5-5                              | Task 5-5 のテストで初回レンダーの `status` を assert している。実機（Step 6 の「初回起動」）でちらつきが出たら、`AuthProvider` 側に「初回マウント完了まで無条件で restoring」のガードを足す                                                                                                                                                                                     |
| 9   | `unstable_settings.anchor` が**入れ子グループのレイアウト**でどう効くかはソース（`getRoutesCore.js:655`）読みのみで、実行確認していない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 5-8                              | Task 5-8 のテストと Task 5-20 の「ガードで弾かれたら index に戻る」ケースで検証される。効かない場合は各グループの `_layout.tsx` にも `unstable_settings` を置く                                                                                                                                                                                                                 |
| 10  | **解消済み（2026-09-15 に実装を確認）。** `EmptyStateProps` = `icon: LucideIcon`（**必須**）/ `title: string` / `description?` / `action?: { label; onPress; isDisabled?; isLoading? }` / `testID?`。`ErrorStateProps` = `title?`（既定 `エラーが発生しました`）/ `description?` / `onRetry: () => void`（必須）/ `testID?`。`actionLabel` / `onAction` は**存在しない**。Task 5-19 の `EmptyState` 呼び出しに `icon={FileText}` を補って修正済み                                                                                                                                                                                                  | 5-9, 5-19                        | 対応不要。Phase 0 側の API を変えず、呼ぶ側を合わせる方針は維持する                                                                                                                                                                                                                                                                                                             |
| 11  | jest-expo の環境で `Response` がグローバルに存在するかを確認していない。`sign-out-storage.test.ts` は `global.fetch` を `new Response(...)` で差し替える                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 5-18                             | 無ければ `{ ok: true, status: 200, json: async () => ({}), headers: new Headers() }` を返すオブジェクトに置き換える                                                                                                                                                                                                                                                             |
| 12  | `better-auth` / `@better-auth/expo` が Jest で変換なしに読めるか未確認（`transformIgnorePatterns` に未追加）。Task 5-2 で `TRANSPILED_NODE_MODULES` に追加する前提で書いている                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 5-2, 5-18                        | Task 5-2 Step 1 でテストを走らせた時点で分かる。`SyntaxError: Cannot use import statement outside a module` が出たら `jest.config.js` に `'better-auth'`, `'@better-auth'` を足す                                                                                                                                                                                               |
| 13  | **解消済み（2026-09-15 に実測して決定）。** `jest.config.js:63-64` のコメントに**従う**。ただし `!src/app/**` を丸ごと外すのではなく `!src/app/_dev/**` に差し替え、外すのは **Task 5-21 Step 4-a**（全画面が揃った後）にする。実測: 除外を外すと `src/app/` は 0/0/0/0、`src/app/_dev/` は 100/100/**80**/100（テスト 128 件は PASS）。つまり既存で足りないのは Phase 5 が 1 行も触らない `_dev/catalog.tsx` の functions だけ                                                                                                                                                                                                                    | 5-8, 5-20, 5-21                  | 対応不要。Task 5-8 は `moduleNameMapper` だけを触り `collectCoverageFrom` には手を付けない。Task 5-21 Step 4-a / 4-b が差し替えと測り直しを持つ。落ちたら Task 5-20 の `routing.test.tsx` に遷移ケースを足すのが第一手                                                                                                                                                          |
| 14  | 電話番号の正規表現が二重定義になる。`packages/core/src/schema.ts` の `PHONE_PATTERN`（`/^0[0-9]{1,4}-[0-9]{1,4}-[0-9]{3,4}$/`、**ハイフン必須**）は module private で export されていないため、モバイル側 `features/shop-application/schema.ts` に同じ値を書き写している                                                                                                                                                                                                                                                                                                                                                                           | 5-19                             | core が `PHONE_PATTERN` を export するようになったら、モバイル側の定義を消して import に置き換える。それまでは片方だけ直すと検証がズレる                                                                                                                                                                                                                                        |
| 15  | `@tanstack/query-core` の型実体ファイル名 `build/modern/hydration-Bjs0MSgg.d.ts` は**ビルドごとのハッシュ付き**で、バージョンを上げると変わる（`queryClient.d.ts` 自体は 2 行の再エクスポートバレル）                                                                                                                                                                                                                                                                                                                                                                                                                                              | 5-5                              | 行番号が合わなくなったら `grep -rn "clear(): void" node_modules/@tanstack/query-core/build/modern/` で引き直す。API そのもの（`clear(): void` / `getDefaultOptions(): DefaultOptions`）は変わっていない                                                                                                                                                                         |
| 16  | `renderHook` / `render` / `fireEvent` が Promise を返すこと（RNTL 14）は `node_modules/@testing-library/react-native/dist/render-hook.d.ts` で型を確認したが、**Jest 環境では動的 `import()` が使えない**（`TypeError: A dynamic import callback was invoked without --experimental-vm-modules`）。本計画のテストは `jest.resetModules()` + `require()`（型は `typeof import('./module')`）で統一している                                                                                                                                                                                                                                          | 5-1, 5-2, 5-8                    | `await import(...)` を書きたくなったら必ず `require()` に置き換える。`.json` を `require` する箇所に `// eslint-disable-next-line @typescript-eslint/no-require-imports` を付けると `Unused eslint-disable directive` の warning になる（`eslint-config-expo/flat/utils/typescript.js:85-96` の `allow` 正規表現に `json` が含まれるため）。`.js` / `.ts` の `require` には必要 |
