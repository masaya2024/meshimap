# Phase 6: 利用者コア（地図 / 検索 / 店舗詳細 / レビュー / お気に入り）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 地図から店を探し、絞り込み、詳細を見て、レビューを書き、お気に入りに入れるまでの一連の動線を動かす。ここまでで「デモできるアプリ」になる。

**Architecture:** 画面（`src/app/`）は組み立てだけを行い、データ取得は `src/features/<domain>/` の hooks に閉じる。地図の幾何計算は全て `@meshimap/geo` の純粋関数へ委譲し、モバイル側には「Region ⇔ geo 型の変換」しか置かない。Reanimated / react-native-maps / @gorhom/bottom-sheet はテスト環境でネイティブ実装を持たないため、**判断ロジックは必ず純粋関数へ抜き出してから**アニメーションやネイティブ描画に渡す。

**Tech Stack:** Expo SDK 57.0.22 / React Native 0.86.3 / React 19.2.3 / TypeScript 6.0 / expo-router 57.0.21 / react-native-maps 1.27.2 / @gorhom/bottom-sheet 5.2.14 / react-native-reanimated 4.5.1 / react-native-gesture-handler 2.32.0 / expo-location 57.0.17 / expo-image 57.0.5 / react-native-svg 15.15.4 / @tanstack/react-query 5.102.8 / zustand 5.0.15 / react-hook-form 7.88 + zod 4.6.5 / Jest 30 + jest-expo 57 + @testing-library/react-native 14.0.1

## Global Constraints

- ファイル名・ディレクトリ名は **kebab-case**（例外なし）。expo-router の動的セグメントは `[shopId]` のように具体名にする
- コンポーネント名は **PascalCase**、関数・変数は **camelCase**、定数は **UPPER_SNAKE_CASE**
- `any` 禁止・`as` によるアサーション禁止（ブランド型生成のみ例外）・`console.log` 禁止（`@/lib/logger` を使う）・マジックナンバー禁止（`src/constants/` に定義する）
- デフォルトエクスポート禁止（expo-router の画面ファイルのみ例外）
- 数値には単位を名前に含める（`radiusM`, `widthPx`, `REGION_SETTLE_DEBOUNCE_MS`）
- 真偽値は `is` / `has` / `can` / `should` で始める
- **`exactOptionalPropertyTypes` が有効**なので、省略可能な props は必ず `?: T | undefined` と書く
- **`verbatimModuleSyntax` が有効**なので、型だけの import は必ず `import type` にする
- **`noUncheckedIndexedAccess` が有効**なので、配列・インデックスアクセスの結果は `T | undefined` として扱う
- コメントは日本語で、「なぜ」を書く。テスト名も日本語で振る舞いを記述する
- データ取得は `features/*/api.ts` の中だけ。コンポーネントから直接 `fetch` しない
- 外部から来たデータは必ず zod で `parse` してから型を信じる
- 全リスト画面に **loading / empty / error** の 3 状態を用意する（`Skeleton` / `EmptyState` / `ErrorState` を使う）
- 1 ファイル 1 コンポーネント。200 行を超えたら分割する
- **`className` は NativeWind が `cssInterop` で登録したコンポーネントにしか効かない。**登録済みなのは RN の `View` / `Text` / `Pressable` / `ScrollView` / `FlatList` / `TextInput` / `Image` / `TouchableOpacity` / `ActivityIndicator` / `SafeAreaView` などのみ。`MapView` / `Marker` / `BottomSheetView` / `expo-image` の `Image` / `react-native-svg` の各要素には **`className` を書かず `style` に `@/constants/theme` の値を渡す**
- `@meshimap/geo` の `BoundingBox` と `react-native-maps` の `BoundingBox` は名前が衝突する。geo 側を使うときは `import type { BoundingBox as GeoBoundingBox }` のように別名にする
- テスト環境では babel の worklets / reanimated プラグインが無効化されている（`apps/mobile/babel.config.js` 参照）。`'worklet';` ディレクティブ付きの関数は Jest では**ただの関数**として実行できるので、アニメーションの計算式はこの形で純粋関数に切り出してテストする
- `Icon` は a11y から隠れているため、テストでは `screen.getByTestId(id, { includeHiddenElements: true })` で取る
- RNTL 14 の `render` / `fireEvent` / `renderHook` は **Promise を返す。必ず `await` する**
- 作業ディレクトリはリポジトリルート `/Users/hattori/Downloads/alee`。モバイル向けコマンドは `-w @meshimap/mobile` を付ける
- Node は 22.23.2（`.nvmrc`）。ターミナルを開くたび `nvm use` を実行する

## 他フェーズから受け取るもの（このフェーズでは作らない）

| 提供元                                               | 名前                                                                                                                                                                             | 用途                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 2 `@meshimap/core`                             | `ShopId` / `toShopId` / `UserId` / `ReviewId` / `toReviewId`                                                                                                                     | ID のブランド型                                                                                                                        |
| Phase 2 `@meshimap/core`                             | `Rating` / `toRating` / `RATING_MIN` / `RATING_MAX`                                                                                                                              | 評価値                                                                                                                                 |
| Phase 2 `@meshimap/core`                             | `OpenStatus` / `BusinessHours` / `ShopClosure` / `getOpenStatus` / `formatBusinessHours`                                                                                         | 営業状況の算出                                                                                                                         |
| Phase 2 `@meshimap/core`                             | `REVIEW_BODY_MAX_LENGTH` / `BUDGET_YEN_MAX`                                                                                                                                      | レビューフォームの検証                                                                                                                 |
| Phase 2 `@meshimap/core`                             | `formatBudgetRange` / `BUDGET_UNSET_LABEL`                                                                                                                                       | 予算帯の表示                                                                                                                           |
| Phase 4 `apps/api`                                   | `GET /shops/nearby` `GET /shops/search` `GET /shops/:shopId` `GET /shops/:shopId/reviews` `POST /reviews` `GET /favorites` `POST /favorites/:shopId` `DELETE /favorites/:shopId` | エンドポイント                                                                                                                         |
| Phase 5 `@/lib/api-client`                           | `apiFetch(path, init?): Promise<unknown>` / `ApiError`                                                                                                                           | 認証ヘッダ付きの HTTP 呼び出し                                                                                                         |
| Phase 5 `src/app/(user)/(tabs)/_layout.tsx`          | タブレイアウト                                                                                                                                                                   | 本フェーズは `map.tsx` / `search.tsx` / `saved.tsx` の中身だけを作る                                                                   |
| Phase 5 `@/features/auth/use-session`                | `useSession(): { userId: UserId \| null; isAuthenticated: boolean }`                                                                                                             | レビューが自分の投稿かの判定・未ログイン時の投稿導線の出し分け                                                                         |
| Phase 7 `src/app/(user)/shop/[shopId]/reserve.tsx`   | 予約画面                                                                                                                                                                         | 本フェーズは詳細画面に**入口のボタンだけ**を置く                                                                                       |
| 別タスク `src/app/(user)/review/[reviewId]/edit.tsx` | レビュー編集画面                                                                                                                                                                 | ロードマップ 6-21 の後半にあたる。本計画書は依頼範囲（投稿・一覧・評価分布）に絞ったため作らない。詳細画面の編集導線はこのルートを指す |

Phase 1 `@meshimap/geo` と Phase 2 `@meshimap/core` は実装済みで、本計画書が import する名前が
すべてバレル（`packages/geo/src/index.ts` / `packages/core/src/index.ts`）に存在することを確認した。
本計画書が `@meshimap/core` から使うのは 41 個、`@meshimap/geo` から使うのは次の 21 個である。

| パッケージ           | 使う名前                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@meshimap/geo` 関数 | `boundingBox` / `clusterByGrid` / `coordinate` / `distanceMeters` / `encodeGeohash` / `formatDistance` / `isWithinBounds` / `precisionForRadius` / `precisionForZoom` / `toLatitude` / `wrapLongitude` |
| `@meshimap/geo` 定数 | `DEGREES_TO_RADIANS` / `LATITUDE_MAX` / `LATITUDE_MIN` / `ZOOM_MAX` / `ZOOM_MIN`                                                                                                                       |
| `@meshimap/geo` 型   | `BoundingBox` / `Cluster` / `Coordinate` / `Geohash` / `GridPoint`                                                                                                                                     |

---

### Task 6-1: 地図とボトムシートが動く土台を作る

**Files:**

- Modify: `apps/mobile/app.json`
- Modify: `apps/mobile/src/app/_layout.tsx`
- Create: `apps/mobile/src/lib/query-client.ts`
- Create: `apps/mobile/src/lib/query-client.test.ts`

**Interfaces:**

- Consumes: なし
- Produces: `createQueryClient(): QueryClient` / ルートに `GestureHandlerRootView` と `QueryClientProvider` が入った状態

- [ ] **Step 1: app.json に位置情報と地図のプラグインを登録する**

`react-native-maps` と `expo-location` は config plugin を登録しないとネイティブ側の権限・API キーが設定されない。プラグイン名とオプション名は `node_modules/react-native-maps/plugin/build/android.js`（`androidGoogleMapsApiKey`）と expo-location の公式ドキュメントで確認済み。

```json
    "plugins": [
      "expo-router",
      [
        "expo-splash-screen",
        {
          "backgroundColor": "#208AEF",
          "image": "./assets/images/splash-icon.png",
          "imageWidth": 76
        }
      ],
      "expo-secure-store",
      [
        "expo-location",
        {
          "locationWhenInUsePermission": "現在地周辺のお店を地図に表示するために位置情報を使用します。"
        }
      ],
      [
        "react-native-maps",
        {
          "androidGoogleMapsApiKey": "$GOOGLE_MAPS_ANDROID_API_KEY"
        }
      ]
    ],
```

API キーは `.env` から `app.config.ts` 経由で渡すのが本来だが、Phase 6 では `app.json` に環境変数名を書いておき、`eas.json` / ローカルの `.env` で解決する。iOS は `PROVIDER_DEFAULT`（Apple Maps）を使うのでキー不要。

- [ ] **Step 2: 失敗するテストを書く（query-client）**

```ts
// apps/mobile/src/lib/query-client.test.ts
import { createQueryClient } from './query-client';

describe('createQueryClient', () => {
  it('クエリの既定の鮮度が 1 分である', () => {
    const queryClient = createQueryClient();

    expect(queryClient.getDefaultOptions().queries?.staleTime).toBe(60_000);
  });

  it('クエリのリトライ回数が 1 回である', () => {
    const queryClient = createQueryClient();

    expect(queryClient.getDefaultOptions().queries?.retry).toBe(1);
  });

  it('ミューテーションはリトライしない', () => {
    const queryClient = createQueryClient();

    // お気に入りの追加を勝手に再送すると二重登録になるため、書き込みは再試行しない
    expect(queryClient.getDefaultOptions().mutations?.retry).toBe(false);
  });
});
```

Run: `npm test -w @meshimap/mobile -- query-client`
Expected: FAIL（`Cannot find module './query-client'`）

- [ ] **Step 3: query-client.ts を実装する**

```ts
// apps/mobile/src/lib/query-client.ts
import { QueryClient } from '@tanstack/react-query';

/** 取得済みデータを新鮮とみなす時間。地図を少し動かすたびに再取得しないための下限 */
const DEFAULT_STALE_TIME_MS = 60_000;

/** 読み取りのリトライ回数。モバイル回線の瞬断は 1 回の再試行で十分吸収できる */
const QUERY_RETRY_COUNT = 1;

/**
 * アプリ全体で使う QueryClient を作る。
 * テストごとに独立したインスタンスが必要なので、シングルトンにせず関数で返す。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
        retry: QUERY_RETRY_COUNT,
      },
      mutations: {
        // 書き込みの自動再送は二重登録を生むため無効にする
        retry: false,
      },
    },
  });
}
```

Run: `npm test -w @meshimap/mobile -- query-client`
Expected: PASS（3 件）

- [ ] **Step 4: ルートレイアウトに Provider を積む**

`@gorhom/bottom-sheet` は `GestureHandlerRootView` がツリーの最上位にないとジェスチャを受け取れない（公式の必須要件）。`flex: 1` を付け忘れると高さ 0 になって何も表示されないため `style` で明示する。

```tsx
// apps/mobile/src/app/_layout.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useAppFonts } from '@/hooks/use-app-fonts';
import { createQueryClient } from '@/lib/query-client';
// これを忘れると NativeWind のスタイルが一切適用されない
import '../global.css';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { areFontsLoaded } = useAppFonts();
  // 再レンダリングのたびにキャッシュが捨てられないよう、初回だけ生成する
  const [queryClient] = useState(createQueryClient);

  useEffect(() => {
    // フォント未読込のまま表示すると文字がちらつくため、読み込み完了までスプラッシュを維持する
    if (areFontsLoaded) {
      void SplashScreen.hideAsync();
    }
  }, [areFontsLoaded]);

  if (!areFontsLoaded) {
    return null;
  }

  return (
    // GestureHandlerRootView がないとボトムシートのドラッグが一切効かない
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Stack screenOptions={{ headerShown: false }} />
        </ThemeProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
```

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`createQueryClient` の `mutations.retry` を `1` に変えて「ミューテーションはリトライしない」が **FAIL** することを確認し、`false` に戻す。

- [ ] **Step 6: 型チェックとコミット**

Run: `npm run typecheck -w @meshimap/mobile`
Expected: エラーなし

```bash
git add apps/mobile/app.json apps/mobile/src/app/_layout.tsx apps/mobile/src/lib/query-client.ts apps/mobile/src/lib/query-client.test.ts
git commit -m "feat(mobile): 地図・位置情報プラグインと Query/Gesture の Provider を追加する"
```

---

### Task 6-2: テスト基盤（ネイティブモジュールのモックと共通ユーティリティ）を作る

**Files:**

- Create: `apps/mobile/src/test-support/react-native-maps-mock.tsx`
- Create: `apps/mobile/src/test-support/query-wrapper.tsx`
- Create: `apps/mobile/src/test-support/shop-fixtures.ts`
- Create: `apps/mobile/src/test-support/test-support.test.tsx`
- Modify: `apps/mobile/jest-setup.ts`
- Modify: `apps/mobile/jest.config.js`

**Interfaces:**

- Consumes: `createQueryClient`（Task 6-1）
- Produces: `createTestQueryClient(): QueryClient` / `QueryWrapper` / `buildShopSummary(overrides?): ShopSummary` / `react-native-maps` と `@gorhom/bottom-sheet` と `expo-location` の Jest モック

- [ ] **Step 1: react-native-maps のモックを書く**

`react-native-maps` は `__mocks__` を同梱していない（`node_modules/react-native-maps` を確認済み）ので自前で用意する。**`Marker` を素の `View` にすると RNTL の `fireEvent.press` が反応しない**（press は responder を持つ host 要素を探すため）。`Pressable` にして `onPress` を橋渡しする。

```tsx
// apps/mobile/src/test-support/react-native-maps-mock.tsx
import { forwardRef, useImperativeHandle } from 'react';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import type { ViewProps } from 'react-native';

/** react-native-maps の LatLng と同じ形。モック内で完結させるため再定義する */
interface MockLatLng {
  latitude: number;
  longitude: number;
}

interface MockRegion extends MockLatLng {
  latitudeDelta: number;
  longitudeDelta: number;
}

interface MockMapViewProps extends ViewProps {
  children?: ReactNode | undefined;
  initialRegion?: MockRegion | undefined;
  region?: MockRegion | undefined;
  onRegionChangeComplete?:
    ((region: MockRegion, details: { isGesture?: boolean }) => void) | undefined;
  onMapReady?: (() => void) | undefined;
}

/** テストから `animateToRegion` の呼び出しを検証できるようにするための記録 */
export const mapViewCalls = {
  animateToRegion: jest.fn<void, [MockRegion, number | undefined]>(),
  animateCamera: jest.fn<void, [Record<string, unknown>, Record<string, unknown> | undefined]>(),
  fitToCoordinates: jest.fn<void, [readonly MockLatLng[], Record<string, unknown> | undefined]>(),
};

const MockMapView = forwardRef<unknown, MockMapViewProps>(function MockMapView(props, ref) {
  const { children, testID, onRegionChangeComplete, onMapReady, ...rest } = props;

  useImperativeHandle(ref, () => ({
    animateToRegion: (region: MockRegion, duration?: number) => {
      mapViewCalls.animateToRegion(region, duration);
    },
    animateCamera: (camera: Record<string, unknown>, options?: Record<string, unknown>) => {
      mapViewCalls.animateCamera(camera, options);
    },
    fitToCoordinates: (coordinates: readonly MockLatLng[], options?: Record<string, unknown>) => {
      mapViewCalls.fitToCoordinates(coordinates, options);
    },
  }));

  return (
    <View
      testID={testID}
      // テストから地図移動を起こせるように、実装のハンドラをそのまま props として残す
      onRegionChangeComplete={onRegionChangeComplete}
      onMapReady={onMapReady}
      {...rest}
    >
      {children}
    </View>
  );
});

interface MockMarkerProps extends ViewProps {
  children?: ReactNode | undefined;
  coordinate: MockLatLng;
  identifier?: string | undefined;
  onPress?: ((event: unknown) => void) | undefined;
}

function MockMarker({
  children,
  coordinate,
  identifier,
  onPress,
  testID,
  ...rest
}: MockMarkerProps) {
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      onPress={() => {
        onPress?.({ nativeEvent: { id: identifier ?? '', action: 'marker-press', coordinate } });
      }}
      {...rest}
    >
      {children}
    </Pressable>
  );
}

function MockPassThrough({ children }: { children?: ReactNode | undefined }) {
  return <>{children}</>;
}

export const PROVIDER_GOOGLE = 'google';
export const PROVIDER_DEFAULT = undefined;
export const Marker = MockMarker;
export const Callout = MockPassThrough;
export const Circle = MockPassThrough;
export const Polygon = MockPassThrough;
export const Polyline = MockPassThrough;
export default MockMapView;
```

- [ ] **Step 2: jest-setup.ts にモックを登録する**

`@gorhom/bottom-sheet` は**公式のモックを同梱している**（`node_modules/@gorhom/bottom-sheet/mock.js`）。自前で書かずこれを使う。`expo-location` は挙動をテストごとに変えたいので、`jest.fn()` を並べたファクトリで差し替える。

```ts
// apps/mobile/jest-setup.ts
// RNTL 14 は import した時点で expect を拡張する（extend-expect サブパスは 13 で廃止された）
import '@testing-library/react-native';

// react-native-reanimated はテスト環境でネイティブモジュールを持たないためモックする
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

// react-native-gesture-handler の公式 Jest セットアップ。これがないと Pressable 系が警告を出す
require('react-native-gesture-handler/jestSetup');

// react-native-maps はネイティブビューなので、ツリー構造だけ保つモックへ差し替える
jest.mock('react-native-maps', () => require('./src/test-support/react-native-maps-mock'));

// @gorhom/bottom-sheet は公式モックを同梱している（children をそのまま描画する）
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));

// expo-location はテストごとに許可状態を変えたいので、全て jest.fn() で置く
jest.mock('expo-location', () => ({
  Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  PermissionStatus: { GRANTED: 'granted', UNDETERMINED: 'undetermined', DENIED: 'denied' },
  requestForegroundPermissionsAsync: jest.fn(),
  getForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  getLastKnownPositionAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
}));

// expo-image はネイティブビュー。source を props に残した View にして testID で検証できるようにする
jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return {
    Image: View,
    ImageBackground: View,
  };
});
```

- [ ] **Step 3: jest.config.js のカバレッジ対象からテスト補助を除く**

```js
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/app/**',
    // テスト補助コードはプロダクトコードではないのでカバレッジの分母に入れない
    '!src/test-support/**',
  ],
```

- [ ] **Step 4: QueryWrapper とフィクスチャを作る**

```tsx
// apps/mobile/src/test-support/query-wrapper.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * テスト用の QueryClient。
 * リトライを切らないと失敗系のテストが既定の指数バックオフで待たされる。
 * gcTime を 0 にしてテスト間でキャッシュが漏れないようにする。
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

interface QueryWrapperProps {
  queryClient: QueryClient;
  children: ReactNode;
}

export function QueryWrapper({ queryClient, children }: QueryWrapperProps) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
```

```ts
// apps/mobile/src/test-support/shop-fixtures.ts
import { toShopId } from '@meshimap/core';

import type { ShopSummary } from '@/features/shops/schema';

/** テストで使う既定の店舗。渋谷駅付近の座標を使う */
const DEFAULT_SHOP: ShopSummary = {
  id: toShopId('shop-001'),
  name: '炭火焼鳥 とりまる',
  genreName: '焼き鳥',
  areaName: '渋谷',
  latitude: 35.658034,
  longitude: 139.701636,
  coverPhotoUrl: 'https://cdn.example.test/shops/001/cover.jpg',
  ratingAverage: 4.2,
  ratingCount: 128,
  budgetDinnerMinYen: 3000,
  budgetDinnerMaxYen: 4999,
  openStatus: 'open',
};

/** 差分だけ指定して店舗サマリを作る。テストごとに全フィールドを書かないため */
export function buildShopSummary(overrides: Partial<ShopSummary> = {}): ShopSummary {
  return { ...DEFAULT_SHOP, ...overrides };
}
```

`ShopSummary` は Task 6-8 で作る。このタスクでは `shop-fixtures.ts` の作成を **Task 6-8 の後**に回してよい（Step 5 のテストは maps モックと QueryWrapper だけを検証する）。

- [ ] **Step 5: モックが効いていることを検証するテストを書く**

```tsx
// apps/mobile/src/test-support/test-support.test.tsx
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { useQuery } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { Text } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

import { QueryWrapper, createTestQueryClient } from './query-wrapper';

function QueryProbe() {
  const { data } = useQuery({ queryKey: ['probe'], queryFn: () => Promise.resolve('取得できた') });
  return <Text>{data ?? '読込中'}</Text>;
}

describe('テスト基盤', () => {
  it('MapView のモックが children を描画する', async () => {
    await render(
      <MapView
        testID="map"
        initialRegion={{ latitude: 0, longitude: 0, latitudeDelta: 1, longitudeDelta: 1 }}
      >
        <Marker coordinate={{ latitude: 0, longitude: 0 }} testID="marker">
          <Text>ピン</Text>
        </Marker>
      </MapView>,
    );

    expect(screen.getByTestId('map')).toBeOnTheScreen();
    expect(screen.getByText('ピン')).toBeOnTheScreen();
  });

  it('BottomSheet のモックが children を描画する', async () => {
    await render(
      <BottomSheet index={0} snapPoints={['50%']}>
        <BottomSheetView>
          <Text>シートの中身</Text>
        </BottomSheetView>
      </BottomSheet>,
    );

    expect(screen.getByText('シートの中身')).toBeOnTheScreen();
  });

  it('expo-location が jest.fn() に置き換わっている', () => {
    expect(jest.isMockFunction(Location.requestForegroundPermissionsAsync)).toBe(true);
  });

  it('QueryWrapper 配下で useQuery が解決する', async () => {
    const queryClient = createTestQueryClient();

    await render(
      <QueryWrapper queryClient={queryClient}>
        <QueryProbe />
      </QueryWrapper>,
    );

    expect(await screen.findByText('取得できた')).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- test-support`
Expected: PASS（4 件）

- [ ] **Step 6: わざと壊してテストが落ちることを確認する**

`jest-setup.ts` の `jest.mock('react-native-maps', ...)` を一時的にコメントアウトし、「MapView のモックが children を描画する」が **FAIL**（ネイティブモジュール未登録のエラー）することを確認してから戻す。

- [ ] **Step 7: コミットする**

```bash
git add apps/mobile/jest-setup.ts apps/mobile/jest.config.js apps/mobile/src/test-support/
git commit -m "test(mobile): 地図・ボトムシート・位置情報のモックとテスト補助を追加する"
```

---

### Task 6-3: 地図の定数を定義する

**Files:**

- Create: `apps/mobile/src/constants/map.ts`
- Create: `apps/mobile/src/constants/map.test.ts`

**Interfaces:**

- Consumes: `@meshimap/geo` の `coordinate` / 型 `Coordinate`
- Produces: `FALLBACK_CENTER` / `INITIAL_LATITUDE_DELTA` / `INITIAL_LONGITUDE_DELTA` / `REGION_SETTLE_DEBOUNCE_MS` / `REGION_MOVE_RATIO_THRESHOLD` / `CLUSTER_ZOOM_IN_FACTOR` / `MAP_TILE_SIZE_PX` / `BOTTOM_SHEET_SNAP_POINTS` / `BOTTOM_SHEET_INDEX_PEEK` / `BOTTOM_SHEET_INDEX_HALF` / `BOTTOM_SHEET_INDEX_FULL` / `NEARBY_SHOPS_LIMIT` / `SEARCH_RADIUS_MIN_M` / `SEARCH_RADIUS_MAX_M` / `CLUSTER_LABEL_MAX_COUNT`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/mobile/src/constants/map.test.ts
import { isWithinBounds, boundingBox } from '@meshimap/geo';

import {
  BOTTOM_SHEET_INDEX_FULL,
  BOTTOM_SHEET_INDEX_HALF,
  BOTTOM_SHEET_INDEX_PEEK,
  BOTTOM_SHEET_SNAP_POINTS,
  FALLBACK_CENTER,
  REGION_MOVE_RATIO_THRESHOLD,
  REGION_SETTLE_DEBOUNCE_MS,
  SEARCH_RADIUS_MAX_M,
  SEARCH_RADIUS_MIN_M,
} from './map';

describe('地図の定数', () => {
  it('位置情報が無いときの初期位置が東京駅である', () => {
    // 東京駅の座標から半径 100m 以内にあることで「東京駅である」と判定する
    expect(isWithinBounds(FALLBACK_CENTER, boundingBox(FALLBACK_CENTER, 100))).toBe(true);
    expect(FALLBACK_CENTER.latitude).toBeCloseTo(35.681236, 5);
    expect(FALLBACK_CENTER.longitude).toBeCloseTo(139.767125, 5);
  });

  it('再検索のデバウンスが設計どおり 500ms である', () => {
    expect(REGION_SETTLE_DEBOUNCE_MS).toBe(500);
  });

  it('再検索の移動しきい値が 0 より大きい比率である', () => {
    // 0 にすると 1px 動かすたびに再検索ボタンが出てしまう
    expect(REGION_MOVE_RATIO_THRESHOLD).toBeGreaterThan(0);
    expect(REGION_MOVE_RATIO_THRESHOLD).toBeLessThan(1);
  });

  it('スナップポイントが 3 段階で下から上へ並んでいる', () => {
    expect(BOTTOM_SHEET_SNAP_POINTS).toHaveLength(3);
    expect(BOTTOM_SHEET_INDEX_PEEK).toBe(0);
    expect(BOTTOM_SHEET_INDEX_HALF).toBe(1);
    expect(BOTTOM_SHEET_INDEX_FULL).toBe(2);
  });

  it('検索半径の上限が下限より大きい', () => {
    expect(SEARCH_RADIUS_MAX_M).toBeGreaterThan(SEARCH_RADIUS_MIN_M);
  });
});
```

Run: `npm test -w @meshimap/mobile -- constants/map`
Expected: FAIL（`Cannot find module './map'`）

- [ ] **Step 2: map.ts を実装する**

```ts
// apps/mobile/src/constants/map.ts
import { coordinate } from '@meshimap/geo';
import type { Coordinate } from '@meshimap/geo';

/**
 * 位置情報が取得できないときの初期表示位置（東京駅）。
 * 許可が無いからといって地図を出さないと「何もできない画面」になるため、必ずどこかを表示する。
 */
export const FALLBACK_CENTER: Coordinate = coordinate(35.681236, 139.767125);

/** 初期表示の緯度方向の幅（度）。約 2km 四方が入る */
export const INITIAL_LATITUDE_DELTA = 0.018;

/** 初期表示の経度方向の幅（度）。日本の緯度では緯度側より広めにすると見た目が正方形に近づく */
export const INITIAL_LONGITUDE_DELTA = 0.022;

/** 地図の移動が落ち着いたと判断するまでの待ち時間（design 5.2 で 500ms と決めている） */
export const REGION_SETTLE_DEBOUNCE_MS = 500;

/**
 * 「このエリアを再検索」を出す移動量のしきい値。
 * 絶対距離ではなく表示半径に対する比率で見る。ズームアウト時に過敏に反応させないため。
 */
export const REGION_MOVE_RATIO_THRESHOLD = 0.25;

/** クラスタをタップしたときに寄る倍率。1 タップで 1 段深く入る感覚になる値 */
export const CLUSTER_ZOOM_IN_FACTOR = 2.5;

/** 地図タイル 1 枚のピクセル幅。Web メルカトルの標準値で、ズーム計算式の定数 */
export const MAP_TILE_SIZE_PX = 256;

/**
 * ボトムシートのスナップ位置（peek / half / full）。
 * `as const` にすると `readonly` になり `BottomSheetProps['snapPoints']`（`Array<string | number>`）へ
 * 渡せないため、あえて可変配列の型で定義する。モジュールスコープなので参照は安定する。
 */
export const BOTTOM_SHEET_SNAP_POINTS: (string | number)[] = ['14%', '50%', '92%'];

export const BOTTOM_SHEET_INDEX_PEEK = 0;
export const BOTTOM_SHEET_INDEX_HALF = 1;
export const BOTTOM_SHEET_INDEX_FULL = 2;

/** 1 回の周辺検索で取得する最大件数。これ以上はクラスタリングしても描画が重くなる */
export const NEARBY_SHOPS_LIMIT = 200;

/** 周辺検索の半径の下限（m）。寄りすぎたときに 0 件になるのを防ぐ */
export const SEARCH_RADIUS_MIN_M = 200;

/** 周辺検索の半径の上限（m）。引きすぎたときに全国検索が走るのを防ぐ */
export const SEARCH_RADIUS_MAX_M = 20_000;

/** クラスタのラベルに出す最大件数。これを超えたら「99+」と表示する */
export const CLUSTER_LABEL_MAX_COUNT = 99;
```

Run: `npm test -w @meshimap/mobile -- constants/map`
Expected: PASS（5 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`REGION_SETTLE_DEBOUNCE_MS` を `0` に変えて「再検索のデバウンスが設計どおり 500ms である」が **FAIL** することを確認し、戻す。

- [ ] **Step 4: コミットする**

```bash
git add apps/mobile/src/constants/map.ts apps/mobile/src/constants/map.test.ts
git commit -m "feat(mobile): 地図の定数を追加する"
```

---

### Task 6-4: Region と `@meshimap/geo` の橋渡しを作る

**Files:**

- Create: `apps/mobile/src/lib/map-region.ts`
- Create: `apps/mobile/src/lib/map-region.test.ts`

**Interfaces:**

- Consumes: `@meshimap/geo` の `DEGREES_TO_RADIANS` / `LATITUDE_MAX` / `LATITUDE_MIN` / `ZOOM_MAX` / `ZOOM_MIN` / `coordinate` / `distanceMeters` / `precisionForZoom` / `toLatitude` / `wrapLongitude` / 型 `BoundingBox` `Coordinate`、`react-native-maps` の型 `Region`、`@/constants/map`
- Produces:
  - `regionCenter(region: Region): Coordinate`
  - `regionToBoundingBox(region: Region): GeoBoundingBox`
  - `regionRadiusM(region: Region): number`
  - `regionZoom(region: Region, viewportWidthPx: number): number`
  - `regionFromCenter(center: Coordinate, latitudeDelta: number, longitudeDelta: number): Region`
  - `zoomInRegion(center: Coordinate, region: Region): Region`
  - `hasRegionMovedEnough(current: Region, searched: Region, viewportWidthPx: number): boolean`

- [ ] **Step 1: 失敗するテストを書く（変換系）**

```ts
// apps/mobile/src/lib/map-region.test.ts
import { coordinate, precisionForZoom } from '@meshimap/geo';
import type { Region } from 'react-native-maps';

import { CLUSTER_ZOOM_IN_FACTOR, SEARCH_RADIUS_MAX_M, SEARCH_RADIUS_MIN_M } from '@/constants/map';

import {
  hasRegionMovedEnough,
  regionCenter,
  regionFromCenter,
  regionRadiusM,
  regionToBoundingBox,
  regionZoom,
  zoomInRegion,
} from './map-region';

/** 渋谷駅周辺・約 2km 四方 */
const SHIBUYA_REGION: Region = {
  latitude: 35.658034,
  longitude: 139.701636,
  latitudeDelta: 0.018,
  longitudeDelta: 0.022,
};

const VIEWPORT_WIDTH_PX = 390;

describe('regionCenter', () => {
  it('Region の中心を Coordinate に変換する', () => {
    const center = regionCenter(SHIBUYA_REGION);

    expect(center.latitude).toBeCloseTo(35.658034, 6);
    expect(center.longitude).toBeCloseTo(139.701636, 6);
  });
});

describe('regionToBoundingBox', () => {
  it('delta の半分ずつ広げた矩形になる', () => {
    const bounds = regionToBoundingBox(SHIBUYA_REGION);

    expect(bounds.latitudeMin).toBeCloseTo(35.658034 - 0.009, 6);
    expect(bounds.latitudeMax).toBeCloseTo(35.658034 + 0.009, 6);
    expect(bounds.longitudeMin).toBeCloseTo(139.701636 - 0.011, 6);
    expect(bounds.longitudeMax).toBeCloseTo(139.701636 + 0.011, 6);
  });

  it('極を跨ぐ delta を渡しても緯度が範囲内に収まる', () => {
    // toLatitude は ±90 を超えると RangeError を投げるため、クランプしていないとここで落ちる
    const bounds = regionToBoundingBox({
      latitude: 89,
      longitude: 0,
      latitudeDelta: 10,
      longitudeDelta: 10,
    });

    expect(bounds.latitudeMax).toBe(90);
  });

  it('日付変更線を跨ぐと longitudeMin が longitudeMax より大きくなる', () => {
    const bounds = regionToBoundingBox({
      latitude: 0,
      longitude: 179.5,
      latitudeDelta: 1,
      longitudeDelta: 2,
    });

    expect(bounds.longitudeMin).toBeCloseTo(178.5, 6);
    expect(bounds.longitudeMax).toBeCloseTo(-179.5, 6);
  });
});

describe('regionRadiusM', () => {
  it('中心から北東角までの距離を返す', () => {
    // 緯度 0.009 度 ≒ 1000m、経度 0.011 度 ≒ 995m（渋谷の緯度）なので対角は約 1.4km
    expect(regionRadiusM(SHIBUYA_REGION)).toBeGreaterThan(1300);
    expect(regionRadiusM(SHIBUYA_REGION)).toBeLessThan(1500);
  });

  it('寄りすぎたときは下限でクランプされる', () => {
    expect(
      regionRadiusM({
        latitude: 35.6,
        longitude: 139.7,
        latitudeDelta: 0.0001,
        longitudeDelta: 0.0001,
      }),
    ).toBe(SEARCH_RADIUS_MIN_M);
  });

  it('引きすぎたときは上限でクランプされる', () => {
    expect(
      regionRadiusM({ latitude: 35.6, longitude: 139.7, latitudeDelta: 5, longitudeDelta: 5 }),
    ).toBe(SEARCH_RADIUS_MAX_M);
  });
});

describe('regionZoom', () => {
  it('longitudeDelta が半分になるとズームが 1 上がる', () => {
    const wide = regionZoom(SHIBUYA_REGION, VIEWPORT_WIDTH_PX);
    const narrow = regionZoom({ ...SHIBUYA_REGION, longitudeDelta: 0.011 }, VIEWPORT_WIDTH_PX);

    expect(narrow - wide).toBeCloseTo(1, 6);
  });

  it('longitudeDelta が 0 でも有限のズームを返す', () => {
    // 0 除算で Infinity になると precisionForZoom が RangeError を投げる
    expect(
      Number.isFinite(regionZoom({ ...SHIBUYA_REGION, longitudeDelta: 0 }, VIEWPORT_WIDTH_PX)),
    ).toBe(true);
  });

  it('返したズームは必ず precisionForZoom に渡せる', () => {
    expect(() =>
      precisionForZoom(regionZoom({ ...SHIBUYA_REGION, longitudeDelta: 360 }, VIEWPORT_WIDTH_PX)),
    ).not.toThrow();
    expect(() =>
      precisionForZoom(regionZoom({ ...SHIBUYA_REGION, longitudeDelta: 0 }, VIEWPORT_WIDTH_PX)),
    ).not.toThrow();
  });
});

describe('regionFromCenter', () => {
  it('中心と delta から Region を作る', () => {
    const region = regionFromCenter(coordinate(35.0, 139.0), 0.01, 0.02);

    expect(region).toEqual({
      latitude: 35.0,
      longitude: 139.0,
      latitudeDelta: 0.01,
      longitudeDelta: 0.02,
    });
  });
});

describe('zoomInRegion', () => {
  it('クラスタ中心へ寄った Region を返す', () => {
    const target = coordinate(35.66, 139.71);
    const zoomed = zoomInRegion(target, SHIBUYA_REGION);

    expect(zoomed.latitude).toBeCloseTo(35.66, 6);
    expect(zoomed.longitude).toBeCloseTo(139.71, 6);
    expect(zoomed.latitudeDelta).toBeCloseTo(0.018 / CLUSTER_ZOOM_IN_FACTOR, 8);
    expect(zoomed.longitudeDelta).toBeCloseTo(0.022 / CLUSTER_ZOOM_IN_FACTOR, 8);
  });
});

describe('hasRegionMovedEnough', () => {
  it('ほとんど動いていないなら false', () => {
    const moved: Region = { ...SHIBUYA_REGION, latitude: 35.658234 };

    // 約 22m の移動。表示半径 1.4km の 25% には遠く及ばない
    expect(hasRegionMovedEnough(moved, SHIBUYA_REGION, VIEWPORT_WIDTH_PX)).toBe(false);
  });

  it('表示半径の 25% を超えて動いたら true', () => {
    const moved: Region = { ...SHIBUYA_REGION, latitude: 35.6681 };

    // 約 1.1km の移動。1.4km × 0.25 = 350m を超える
    expect(hasRegionMovedEnough(moved, SHIBUYA_REGION, VIEWPORT_WIDTH_PX)).toBe(true);
  });

  it('動いていなくてもクラスタ精度が変わるズームなら true', () => {
    const zoomedOut: Region = { ...SHIBUYA_REGION, latitudeDelta: 5, longitudeDelta: 5 };

    expect(hasRegionMovedEnough(zoomedOut, SHIBUYA_REGION, VIEWPORT_WIDTH_PX)).toBe(true);
  });

  it('精度が変わらない程度の微小なズーム変化では false', () => {
    const slightlyZoomed: Region = { ...SHIBUYA_REGION, longitudeDelta: 0.0225 };

    expect(hasRegionMovedEnough(slightlyZoomed, SHIBUYA_REGION, VIEWPORT_WIDTH_PX)).toBe(false);
  });
});
```

Run: `npm test -w @meshimap/mobile -- map-region`
Expected: FAIL（`Cannot find module './map-region'`）

- [ ] **Step 2: map-region.ts を実装する**

```ts
// apps/mobile/src/lib/map-region.ts
import {
  DEGREES_TO_RADIANS,
  LATITUDE_MAX,
  LATITUDE_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  coordinate,
  distanceMeters,
  precisionForZoom,
  toLatitude,
  wrapLongitude,
} from '@meshimap/geo';
import type { BoundingBox as GeoBoundingBox, Coordinate } from '@meshimap/geo';
import type { Region } from 'react-native-maps';

import {
  CLUSTER_ZOOM_IN_FACTOR,
  MAP_TILE_SIZE_PX,
  REGION_MOVE_RATIO_THRESHOLD,
  SEARCH_RADIUS_MAX_M,
  SEARCH_RADIUS_MIN_M,
} from '@/constants/map';

/** 1 周（度）。Web メルカトルのズーム計算式で使う */
const FULL_TURN_DEGREES = 360;

/** toLatitude は範囲外で RangeError を投げるため、渡す前に必ずここを通す */
function clampLatitude(value: number): number {
  return Math.min(LATITUDE_MAX, Math.max(LATITUDE_MIN, value));
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) {
    // longitudeDelta が 0 のとき Infinity になる。最大ズーム扱いにする
    return value > 0 ? ZOOM_MAX : ZOOM_MIN;
  }
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/** Region の中心を geo の Coordinate へ変換する */
export function regionCenter(region: Region): Coordinate {
  return coordinate(clampLatitude(region.latitude), wrapLongitude(region.longitude));
}

/**
 * Region を geo の境界ボックスへ変換する。
 * longitudeMin > longitudeMax になった場合は日付変更線を跨いでいる（geo 側の規約）。
 */
export function regionToBoundingBox(region: Region): GeoBoundingBox {
  const halfLatitudeDelta = region.latitudeDelta / 2;
  const halfLongitudeDelta = region.longitudeDelta / 2;

  return {
    latitudeMin: toLatitude(clampLatitude(region.latitude - halfLatitudeDelta)),
    latitudeMax: toLatitude(clampLatitude(region.latitude + halfLatitudeDelta)),
    longitudeMin: wrapLongitude(region.longitude - halfLongitudeDelta),
    longitudeMax: wrapLongitude(region.longitude + halfLongitudeDelta),
  };
}

/**
 * 中心から北東角までの距離（m）。API へ渡す円の半径になる。
 * 矩形に外接する円なので、画面端の店も取りこぼさない。
 */
export function regionRadiusM(region: Region): number {
  const center = regionCenter(region);
  const northEast = coordinate(
    clampLatitude(region.latitude + region.latitudeDelta / 2),
    wrapLongitude(region.longitude + region.longitudeDelta / 2),
  );

  const rawRadiusM = Math.round(distanceMeters(center, northEast));
  return Math.min(SEARCH_RADIUS_MAX_M, Math.max(SEARCH_RADIUS_MIN_M, rawRadiusM));
}

/**
 * Region からズームレベルを求める。
 * Web メルカトルでは「タイル 256px あたり 360 / 2^zoom 度」なので、それを逆に解く。
 * 戻り値は必ず ZOOM_MIN..ZOOM_MAX に収まるので precisionForZoom へそのまま渡せる。
 */
export function regionZoom(region: Region, viewportWidthPx: number): number {
  const rawZoom = Math.log2(
    (FULL_TURN_DEGREES * viewportWidthPx) / (MAP_TILE_SIZE_PX * region.longitudeDelta),
  );
  return clampZoom(rawZoom);
}

/** 中心と delta から Region を組み立てる */
export function regionFromCenter(
  center: Coordinate,
  latitudeDelta: number,
  longitudeDelta: number,
): Region {
  return {
    latitude: center.latitude,
    longitude: center.longitude,
    latitudeDelta,
    longitudeDelta,
  };
}

/** クラスタをタップしたときに寄る先の Region。現在の縮尺を一定倍率で縮める */
export function zoomInRegion(center: Coordinate, region: Region): Region {
  return regionFromCenter(
    center,
    region.latitudeDelta / CLUSTER_ZOOM_IN_FACTOR,
    region.longitudeDelta / CLUSTER_ZOOM_IN_FACTOR,
  );
}

/**
 * 「このエリアを再検索」を出すべきかを判定する。
 *
 * - クラスタの粒度（geohash 精度）が変わるズーム変化なら、移動量に関係なく取り直す価値がある
 * - そうでなければ、前回検索時の表示半径に対する比率で移動量を見る
 *   絶対距離で判定すると、広域表示のときに少し動かしただけで再検索が走ってしまう
 */
export function hasRegionMovedEnough(
  current: Region,
  searched: Region,
  viewportWidthPx: number,
): boolean {
  const currentPrecision = precisionForZoom(regionZoom(current, viewportWidthPx));
  const searchedPrecision = precisionForZoom(regionZoom(searched, viewportWidthPx));
  if (currentPrecision !== searchedPrecision) {
    return true;
  }

  const movedM = distanceMeters(regionCenter(current), regionCenter(searched));
  return movedM > regionRadiusM(searched) * REGION_MOVE_RATIO_THRESHOLD;
}

/**
 * 緯度による経度方向の収縮率。
 * 正方形の画面で見た目の縦横比を保つために latitudeDelta を求めるときに使う。
 */
export function longitudeShrinkRatio(latitude: number): number {
  return Math.cos(clampLatitude(latitude) * DEGREES_TO_RADIANS);
}
```

Run: `npm test -w @meshimap/mobile -- map-region`
Expected: PASS（15 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する（しきい値）**

`REGION_MOVE_RATIO_THRESHOLD` を `@/constants/map` で `0` に変えて、「ほとんど動いていないなら false」が **FAIL** することを確認してから戻す。これで「無駄な再検索を抑える仕組み」がテストで守られていることが分かる。

- [ ] **Step 4: わざと壊してテストが落ちることを確認する（クランプ）**

`regionToBoundingBox` の `clampLatitude` を外して素の値を `toLatitude` に渡し、「極を跨ぐ delta を渡しても緯度が範囲内に収まる」が **RangeError で FAIL** することを確認してから戻す。

- [ ] **Step 5: コミットする**

```bash
git add apps/mobile/src/lib/map-region.ts apps/mobile/src/lib/map-region.test.ts
git commit -m "feat(mobile): Region と geo パッケージの相互変換を追加する"
```

---

### Task 6-5: 地図ビューポートのストアを作る

**Files:**

- Create: `apps/mobile/src/stores/map-viewport.ts`
- Create: `apps/mobile/src/stores/map-viewport.test.ts`

**Interfaces:**

- Consumes: `@meshimap/core` の型 `ShopId`、`react-native-maps` の型 `Region`
- Produces: `useMapViewportStore` / 型 `MapViewportStore`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/mobile/src/stores/map-viewport.test.ts
import { toShopId } from '@meshimap/core';
import type { Region } from 'react-native-maps';

import { useMapViewportStore } from './map-viewport';

const REGION_A: Region = {
  latitude: 35.0,
  longitude: 139.0,
  latitudeDelta: 0.02,
  longitudeDelta: 0.02,
};
const REGION_B: Region = {
  latitude: 35.1,
  longitude: 139.1,
  latitudeDelta: 0.02,
  longitudeDelta: 0.02,
};

describe('useMapViewportStore', () => {
  beforeEach(() => {
    useMapViewportStore.getState().reset();
  });

  it('初期状態では Region も選択中の店舗も無い', () => {
    const state = useMapViewportStore.getState();

    expect(state.currentRegion).toBeNull();
    expect(state.searchedRegion).toBeNull();
    expect(state.selectedShopId).toBeNull();
  });

  it('最初の setCurrentRegion は searchedRegion も同時に埋める', () => {
    // 初回表示直後に「再検索ボタン」が出ないよう、基準を現在地に合わせておく
    useMapViewportStore.getState().setCurrentRegion(REGION_A);

    expect(useMapViewportStore.getState().currentRegion).toEqual(REGION_A);
    expect(useMapViewportStore.getState().searchedRegion).toEqual(REGION_A);
  });

  it('2 回目以降の setCurrentRegion は searchedRegion を変えない', () => {
    useMapViewportStore.getState().setCurrentRegion(REGION_A);
    useMapViewportStore.getState().setCurrentRegion(REGION_B);

    expect(useMapViewportStore.getState().currentRegion).toEqual(REGION_B);
    expect(useMapViewportStore.getState().searchedRegion).toEqual(REGION_A);
  });

  it('commitSearchedRegion で現在の Region が検索基準になる', () => {
    useMapViewportStore.getState().setCurrentRegion(REGION_A);
    useMapViewportStore.getState().setCurrentRegion(REGION_B);
    useMapViewportStore.getState().commitSearchedRegion();

    expect(useMapViewportStore.getState().searchedRegion).toEqual(REGION_B);
  });

  it('currentRegion が無いときの commitSearchedRegion は何もしない', () => {
    useMapViewportStore.getState().commitSearchedRegion();

    expect(useMapViewportStore.getState().searchedRegion).toBeNull();
  });

  it('店舗を選択・解除できる', () => {
    const shopId = toShopId('shop-001');

    useMapViewportStore.getState().selectShop(shopId);
    expect(useMapViewportStore.getState().selectedShopId).toBe(shopId);

    useMapViewportStore.getState().selectShop(null);
    expect(useMapViewportStore.getState().selectedShopId).toBeNull();
  });

  it('地図の横幅を保持する', () => {
    useMapViewportStore.getState().setViewportWidthPx(390);

    expect(useMapViewportStore.getState().viewportWidthPx).toBe(390);
  });
});
```

Run: `npm test -w @meshimap/mobile -- map-viewport`
Expected: FAIL（`Cannot find module './map-viewport'`）

- [ ] **Step 2: map-viewport.ts を実装する**

```ts
// apps/mobile/src/stores/map-viewport.ts
import type { ShopId } from '@meshimap/core';
import type { Region } from 'react-native-maps';
import { create } from 'zustand';

/** 地図の横幅が測れるまでの暫定値（iPhone 14 相当）。ズーム計算が 0 除算にならないようにする */
const DEFAULT_VIEWPORT_WIDTH_PX = 390;

export interface MapViewportStore {
  /** いま画面に映っている範囲。地図の移動が止まるたびに更新される */
  readonly currentRegion: Region | null;
  /** 最後に検索を実行した範囲。「このエリアを再検索」の表示判定の基準 */
  readonly searchedRegion: Region | null;
  /** 地図ビューの実測幅（px）。ズームレベルの計算に必要 */
  readonly viewportWidthPx: number;
  /** ボトムシート／ピンで選択中の店舗 */
  readonly selectedShopId: ShopId | null;
  setCurrentRegion: (region: Region) => void;
  commitSearchedRegion: () => void;
  setViewportWidthPx: (widthPx: number) => void;
  selectShop: (shopId: ShopId | null) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  currentRegion: null,
  searchedRegion: null,
  viewportWidthPx: DEFAULT_VIEWPORT_WIDTH_PX,
  selectedShopId: null,
} satisfies Pick<
  MapViewportStore,
  'currentRegion' | 'searchedRegion' | 'viewportWidthPx' | 'selectedShopId'
>;

export const useMapViewportStore = create<MapViewportStore>()((set) => ({
  ...INITIAL_STATE,

  setCurrentRegion: (region) => {
    set((state) => ({
      currentRegion: region,
      // 初回だけは検索基準も揃える。揃えないと表示直後に再検索ボタンが出てしまう
      searchedRegion: state.searchedRegion ?? region,
    }));
  },

  commitSearchedRegion: () => {
    set((state) =>
      state.currentRegion === null ? state : { searchedRegion: state.currentRegion },
    );
  },

  setViewportWidthPx: (widthPx) => {
    set({ viewportWidthPx: widthPx });
  },

  selectShop: (shopId) => {
    set({ selectedShopId: shopId });
  },

  reset: () => {
    set({ ...INITIAL_STATE });
  },
}));
```

Run: `npm test -w @meshimap/mobile -- map-viewport`
Expected: PASS（7 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`setCurrentRegion` の `searchedRegion: state.searchedRegion ?? region` を `searchedRegion: region` に変えて、「2 回目以降の setCurrentRegion は searchedRegion を変えない」が **FAIL** することを確認してから戻す。

- [ ] **Step 4: コミットする**

```bash
git add apps/mobile/src/stores/map-viewport.ts apps/mobile/src/stores/map-viewport.test.ts
git commit -m "feat(mobile): 地図ビューポートのストアを追加する"
```

---

### Task 6-6: 現在地取得フック（権限拒否時のフォールバック付き）を作る

**Files:**

- Create: `apps/mobile/src/hooks/use-current-location.ts`
- Create: `apps/mobile/src/hooks/use-current-location.test.ts`

**Interfaces:**

- Consumes: `expo-location` の `Accuracy` / `getCurrentPositionAsync` / `requestForegroundPermissionsAsync`、`@meshimap/geo` の `coordinate`、`@/constants/map` の `FALLBACK_CENTER`、`@/lib/logger`
- Produces: `useCurrentLocation(): CurrentLocation` / 型 `CurrentLocation` `CurrentLocationStatus`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/mobile/src/hooks/use-current-location.test.ts
import { renderHook, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';

import { FALLBACK_CENTER } from '@/constants/map';

import { useCurrentLocation } from './use-current-location';

const requestPermissionsMock = jest.mocked(Location.requestForegroundPermissionsAsync);
const getCurrentPositionMock = jest.mocked(Location.getCurrentPositionAsync);

/** expo-location の LocationPermissionResponse の必要な部分だけを組み立てる */
function permissionResponse(isGranted: boolean) {
  return {
    granted: isGranted,
    canAskAgain: true,
    expires: 'never' as const,
    status: isGranted ? Location.PermissionStatus.GRANTED : Location.PermissionStatus.DENIED,
  };
}

function positionResponse(latitude: number, longitude: number) {
  return {
    coords: {
      latitude,
      longitude,
      altitude: null,
      accuracy: 10,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: 1_757_900_000_000,
  };
}

describe('useCurrentLocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('許可されたら端末の位置を返す', async () => {
    requestPermissionsMock.mockResolvedValue(permissionResponse(true));
    getCurrentPositionMock.mockResolvedValue(positionResponse(35.658034, 139.701636));

    const { result } = await renderHook(() => useCurrentLocation());

    await waitFor(() => {
      expect(result.current.status).toBe('granted');
    });
    expect(result.current.center.latitude).toBeCloseTo(35.658034, 6);
    expect(result.current.isDeviceLocation).toBe(true);
  });

  it('拒否されても落ちずに東京駅を返す', async () => {
    requestPermissionsMock.mockResolvedValue(permissionResponse(false));

    const { result } = await renderHook(() => useCurrentLocation());

    await waitFor(() => {
      expect(result.current.status).toBe('denied');
    });
    expect(result.current.center).toEqual(FALLBACK_CENTER);
    expect(result.current.isDeviceLocation).toBe(false);
    // 拒否されたのに位置を取りにいくと OS のエラーになるため、呼んではいけない
    expect(getCurrentPositionMock).not.toHaveBeenCalled();
  });

  it('許可はあるが取得に失敗したら unavailable で東京駅を返す', async () => {
    requestPermissionsMock.mockResolvedValue(permissionResponse(true));
    getCurrentPositionMock.mockRejectedValue(new Error('Location services are disabled'));

    const { result } = await renderHook(() => useCurrentLocation());

    await waitFor(() => {
      expect(result.current.status).toBe('unavailable');
    });
    expect(result.current.center).toEqual(FALLBACK_CENTER);
    expect(result.current.isDeviceLocation).toBe(false);
  });

  it('解決前の初期状態は loading で、座標は東京駅である', async () => {
    requestPermissionsMock.mockReturnValue(new Promise(() => undefined));

    const { result } = await renderHook(() => useCurrentLocation());

    // 地図を「座標が無い状態」で描かないため、loading 中も必ず座標を持つ
    expect(result.current.status).toBe('loading');
    expect(result.current.center).toEqual(FALLBACK_CENTER);
  });

  it('アンマウント後に解決しても setState しない', async () => {
    let resolvePermission: ((value: ReturnType<typeof permissionResponse>) => void) | undefined;
    requestPermissionsMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePermission = resolve;
      }),
    );

    const { unmount } = await renderHook(() => useCurrentLocation());
    await unmount();
    resolvePermission?.(permissionResponse(true));

    // React の "state update on unmounted component" 警告が出ないことを確認する
    await waitFor(() => {
      expect(requestPermissionsMock).toHaveBeenCalledTimes(1);
    });
  });
});
```

Run: `npm test -w @meshimap/mobile -- use-current-location`
Expected: FAIL（`Cannot find module './use-current-location'`）

- [ ] **Step 2: use-current-location.ts を実装する**

```ts
// apps/mobile/src/hooks/use-current-location.ts
import { coordinate } from '@meshimap/geo';
import type { Coordinate } from '@meshimap/geo';
import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

import { FALLBACK_CENTER } from '@/constants/map';
import { logger } from '@/lib/logger';

export type CurrentLocationStatus = 'loading' | 'granted' | 'denied' | 'unavailable';

export interface CurrentLocation {
  readonly status: CurrentLocationStatus;
  /** status によらず必ず座標を返す。許可が無いときは FALLBACK_CENTER（東京駅） */
  readonly center: Coordinate;
  /** 端末の実測位置かどうか。false のときは距離表示を出さない */
  readonly isDeviceLocation: boolean;
}

const INITIAL_LOCATION: CurrentLocation = {
  status: 'loading',
  center: FALLBACK_CENTER,
  isDeviceLocation: false,
};

const FALLBACK_LOCATION = {
  center: FALLBACK_CENTER,
  isDeviceLocation: false,
} as const;

/**
 * 現在地を解決する。
 *
 * 位置情報が使えない場合でも必ず座標を返すのが最大の役目。
 * 「許可してください」だけの画面にすると、ユーザーは一度も店を見ずに離脱する。
 */
export function useCurrentLocation(): CurrentLocation {
  const [location, setLocation] = useState<CurrentLocation>(INITIAL_LOCATION);

  useEffect(() => {
    // アンマウント後の setState を防ぐフラグ。AbortController は expo-location が対応していない
    let isActive = true;

    const resolveLocation = async (): Promise<void> => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!isActive) {
        return;
      }

      if (!permission.granted) {
        setLocation({ status: 'denied', ...FALLBACK_LOCATION });
        return;
      }

      try {
        // Balanced は数十メートル精度。店探しには十分で、Highest より圧倒的に速い
        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!isActive) {
          return;
        }

        setLocation({
          status: 'granted',
          center: coordinate(position.coords.latitude, position.coords.longitude),
          isDeviceLocation: true,
        });
      } catch (error) {
        if (!isActive) {
          return;
        }

        // 端末の位置情報サービス自体が無効、機内モード、タイムアウトなど
        logger.warn('現在地を取得できなかったためフォールバック位置を使う', { error });
        setLocation({ status: 'unavailable', ...FALLBACK_LOCATION });
      }
    };

    void resolveLocation();

    return () => {
      isActive = false;
    };
  }, []);

  return location;
}
```

Run: `npm test -w @meshimap/mobile -- use-current-location`
Expected: PASS（5 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`if (!permission.granted)` の分岐を削除して常に `getCurrentPositionAsync` を呼ぶようにし、「拒否されても落ちずに東京駅を返す」が **FAIL** することを確認してから戻す。次に `FALLBACK_LOCATION.center` を `coordinate(0, 0)` に変えて同テストが **FAIL** することも確認する。

- [ ] **Step 4: コミットする**

```bash
git add apps/mobile/src/hooks/use-current-location.ts apps/mobile/src/hooks/use-current-location.test.ts
git commit -m "feat(mobile): 権限拒否時にフォールバックする現在地フックを追加する"
```

---

### Task 6-7: 「このエリアを再検索」の表示判定フックを作る

**Files:**

- Create: `apps/mobile/src/hooks/use-search-this-area.ts`
- Create: `apps/mobile/src/hooks/use-search-this-area.test.ts`

**Interfaces:**

- Consumes: `@/stores/map-viewport` の `useMapViewportStore`、`@/lib/map-region` の `hasRegionMovedEnough`、`@/constants/map` の `REGION_SETTLE_DEBOUNCE_MS`
- Produces: `useSearchThisArea(): SearchThisAreaResult` / 型 `SearchThisAreaResult`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/mobile/src/hooks/use-search-this-area.test.ts
import { act, renderHook } from '@testing-library/react-native';
import type { Region } from 'react-native-maps';

import { REGION_SETTLE_DEBOUNCE_MS } from '@/constants/map';
import { useMapViewportStore } from '@/stores/map-viewport';

import { useSearchThisArea } from './use-search-this-area';

const BASE_REGION: Region = {
  latitude: 35.658034,
  longitude: 139.701636,
  latitudeDelta: 0.018,
  longitudeDelta: 0.022,
};

/** 約 1.1km 北へ移動した Region。しきい値（表示半径の 25% ≒ 350m）を確実に超える */
const FAR_REGION: Region = { ...BASE_REGION, latitude: 35.6681 };

/** 約 22m だけ移動した Region。しきい値には届かない */
const NEAR_REGION: Region = { ...BASE_REGION, latitude: 35.658234 };

describe('useSearchThisArea', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useMapViewportStore.getState().reset();
    useMapViewportStore.getState().setViewportWidthPx(390);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('初期表示ではボタンを出さない', async () => {
    const { result } = await renderHook(() => useSearchThisArea());

    await act(async () => {
      useMapViewportStore.getState().setCurrentRegion(BASE_REGION);
      jest.advanceTimersByTime(REGION_SETTLE_DEBOUNCE_MS);
    });

    expect(result.current.isVisible).toBe(false);
  });

  it('十分に移動してデバウンス時間が経つとボタンを出す', async () => {
    const { result } = await renderHook(() => useSearchThisArea());

    await act(async () => {
      useMapViewportStore.getState().setCurrentRegion(BASE_REGION);
      useMapViewportStore.getState().setCurrentRegion(FAR_REGION);
      jest.advanceTimersByTime(REGION_SETTLE_DEBOUNCE_MS);
    });

    expect(result.current.isVisible).toBe(true);
  });

  it('デバウンス時間が経つ前はボタンを出さない', async () => {
    const { result } = await renderHook(() => useSearchThisArea());

    await act(async () => {
      useMapViewportStore.getState().setCurrentRegion(BASE_REGION);
      useMapViewportStore.getState().setCurrentRegion(FAR_REGION);
      jest.advanceTimersByTime(REGION_SETTLE_DEBOUNCE_MS - 1);
    });

    expect(result.current.isVisible).toBe(false);
  });

  it('指を動かし続けている間は判定が走らない', async () => {
    const { result } = await renderHook(() => useSearchThisArea());

    await act(async () => {
      useMapViewportStore.getState().setCurrentRegion(BASE_REGION);
    });

    // 400ms ごとに動かし続ける＝一度も 500ms 静止していないので出ない
    for (let step = 0; step < 5; step += 1) {
      await act(async () => {
        useMapViewportStore
          .getState()
          .setCurrentRegion({ ...FAR_REGION, latitude: 35.67 + step * 0.01 });
        jest.advanceTimersByTime(REGION_SETTLE_DEBOUNCE_MS - 100);
      });
      expect(result.current.isVisible).toBe(false);
    }
  });

  it('しきい値未満の移動ではボタンを出さない', async () => {
    const { result } = await renderHook(() => useSearchThisArea());

    await act(async () => {
      useMapViewportStore.getState().setCurrentRegion(BASE_REGION);
      useMapViewportStore.getState().setCurrentRegion(NEAR_REGION);
      jest.advanceTimersByTime(REGION_SETTLE_DEBOUNCE_MS);
    });

    expect(result.current.isVisible).toBe(false);
  });

  it('searchThisArea を呼ぶと検索基準が更新されボタンが消える', async () => {
    const { result } = await renderHook(() => useSearchThisArea());

    await act(async () => {
      useMapViewportStore.getState().setCurrentRegion(BASE_REGION);
      useMapViewportStore.getState().setCurrentRegion(FAR_REGION);
      jest.advanceTimersByTime(REGION_SETTLE_DEBOUNCE_MS);
    });
    expect(result.current.isVisible).toBe(true);

    await act(async () => {
      result.current.searchThisArea();
      jest.advanceTimersByTime(REGION_SETTLE_DEBOUNCE_MS);
    });

    expect(useMapViewportStore.getState().searchedRegion).toEqual(FAR_REGION);
    expect(result.current.isVisible).toBe(false);
  });
});
```

Run: `npm test -w @meshimap/mobile -- use-search-this-area`
Expected: FAIL（`Cannot find module './use-search-this-area'`）

- [ ] **Step 2: use-search-this-area.ts を実装する**

```ts
// apps/mobile/src/hooks/use-search-this-area.ts
import { useCallback, useEffect, useState } from 'react';

import { REGION_SETTLE_DEBOUNCE_MS } from '@/constants/map';
import { hasRegionMovedEnough } from '@/lib/map-region';
import { useMapViewportStore } from '@/stores/map-viewport';

export interface SearchThisAreaResult {
  /** 「このエリアを再検索」ボタンを表示すべきか */
  readonly isVisible: boolean;
  /** 現在の表示範囲を検索基準に昇格させる（＝再検索を発火させる） */
  readonly searchThisArea: () => void;
}

/**
 * 地図の移動量を見て再検索ボタンの表示を決める。
 *
 * 判定を debounce するのは 2 つの理由から:
 * 1. ドラッグ中にボタンが点滅して視覚的にうるさい
 * 2. 判定のたびに距離計算が走るのを、静止したときの 1 回に減らせる
 */
export function useSearchThisArea(): SearchThisAreaResult {
  const currentRegion = useMapViewportStore((state) => state.currentRegion);
  const searchedRegion = useMapViewportStore((state) => state.searchedRegion);
  const viewportWidthPx = useMapViewportStore((state) => state.viewportWidthPx);
  const commitSearchedRegion = useMapViewportStore((state) => state.commitSearchedRegion);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (currentRegion === null || searchedRegion === null) {
      setIsVisible(false);
      return;
    }

    // 依存が変わるたびに前回のタイマーが破棄されるので、動かし続けている間は判定が走らない
    const timerId = setTimeout(() => {
      setIsVisible(hasRegionMovedEnough(currentRegion, searchedRegion, viewportWidthPx));
    }, REGION_SETTLE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timerId);
    };
  }, [currentRegion, searchedRegion, viewportWidthPx]);

  const searchThisArea = useCallback(() => {
    commitSearchedRegion();
    // searchedRegion の更新は次の effect でも false になるが、押した瞬間に消したいので即座に落とす
    setIsVisible(false);
  }, [commitSearchedRegion]);

  return { isVisible, searchThisArea };
}
```

Run: `npm test -w @meshimap/mobile -- use-search-this-area`
Expected: PASS（6 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する（デバウンス）**

`setTimeout(...)` を外して `setIsVisible(hasRegionMovedEnough(...))` を同期実行にし、「デバウンス時間が経つ前はボタンを出さない」と「指を動かし続けている間は判定が走らない」が **FAIL** することを確認してから戻す。

- [ ] **Step 4: わざと壊してテストが落ちることを確認する（しきい値）**

`hasRegionMovedEnough` の戻り値を `true` 固定にし、「しきい値未満の移動ではボタンを出さない」と「初期表示ではボタンを出さない」が **FAIL** することを確認してから戻す。

- [ ] **Step 5: コミットする**

```bash
git add apps/mobile/src/hooks/use-search-this-area.ts apps/mobile/src/hooks/use-search-this-area.test.ts
git commit -m "feat(mobile): このエリアを再検索の表示判定フックを追加する"
```

---

### Task 6-8: 検索フィルタの型と URL クエリ変換を作る

**Files:**

- Create: `apps/mobile/src/constants/search.ts`
- Create: `apps/mobile/src/lib/query-params.ts`
- Create: `apps/mobile/src/lib/query-params.test.ts`
- Create: `apps/mobile/src/lib/search-filter.ts`
- Create: `apps/mobile/src/lib/search-filter.test.ts`

**Interfaces:**

- Consumes: `@meshimap/core` の `RATING_MAX` / `RATING_MIN` / `toRating` / 型 `Rating`
- Produces:
  - 型 `SearchFilter` / `EMPTY_SEARCH_FILTER`
  - `toSearchQueryParams(filter: SearchFilter): Record<string, string>`
  - `fromSearchQueryParams(params: SearchQueryParams): SearchFilter`
  - `countActiveFilters(filter: SearchFilter): number`
  - 型 `SearchQueryParams = QueryParams`
  - 型 `QueryParams = Readonly<Record<string, string | string[] | undefined>>` / `readSingleQueryValue(value: string | string[] | undefined): string | undefined`

- [ ] **Step 1: 定数ファイルを作る**

```ts
// apps/mobile/src/constants/search.ts
/** URL クエリのキー。画面とストアの両方から同じ名前を参照するため一箇所に集める */
export const SEARCH_QUERY_KEYS = {
  keyword: 'keyword',
  genres: 'genres',
  area: 'area',
  budgetMax: 'budgetMax',
  openNow: 'openNow',
  minRating: 'minRating',
  distance: 'distance',
} as const;

/** 複数ジャンルを 1 つのクエリ値にまとめるときの区切り文字 */
export const GENRE_ID_SEPARATOR = ',';

/** 真偽値のクエリ表現。'true' より短く、'0' との対比が明確 */
export const QUERY_TRUE_VALUE = '1';

/** 距離フィルタの選択肢（m）。地図の徒歩圏〜電車圏を 4 段階で用意する */
export const DISTANCE_OPTIONS_M: readonly number[] = [500, 1000, 3000, 5000];

/** 予算上限フィルタの選択肢（円） */
export const BUDGET_MAX_OPTIONS_YEN: readonly number[] = [1000, 2000, 3000, 5000, 10_000];

/** 検索結果 1 ページあたりの件数 */
export const SEARCH_PAGE_SIZE = 20;
```

同じ Step で、URL クエリの値を読むユーティリティも作る。
`useLocalSearchParams` は同名キーが複数あると配列を返す。この正規化は検索フィルタだけでなく
店舗詳細（`[shopId]`）やレビュー投稿画面でも必要になるので、最初から独立させておく。

```ts
// apps/mobile/src/lib/query-params.ts
/** expo-router の useLocalSearchParams が返す形。同名キーが複数あると配列になる */
export type QueryParams = Readonly<Record<string, string | string[] | undefined>>;

/**
 * クエリ値を 1 件の文字列に正規化する。
 * 空文字は「指定なし」と同じ扱いにして、`?keyword=` のような URL でも既定値に戻れるようにする。
 */
export function readSingleQueryValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return value === '' ? undefined : value;
  }
  if (Array.isArray(value)) {
    // noUncheckedIndexedAccess により value[0] は string | undefined
    const first = value[0];
    return first === undefined || first === '' ? undefined : first;
  }
  return undefined;
}
```

```ts
// apps/mobile/src/lib/query-params.test.ts
import { readSingleQueryValue } from './query-params';

describe('readSingleQueryValue', () => {
  it('文字列はそのまま返す', () => {
    expect(readSingleQueryValue('寿司')).toBe('寿司');
  });

  it('空文字は指定なしとして扱う', () => {
    expect(readSingleQueryValue('')).toBeUndefined();
  });

  it('配列は先頭を採用する', () => {
    expect(readSingleQueryValue(['寿司', '焼肉'])).toBe('寿司');
  });

  it('空配列は指定なしとして扱う', () => {
    expect(readSingleQueryValue([])).toBeUndefined();
  });

  it('先頭が空文字の配列も指定なしとして扱う', () => {
    expect(readSingleQueryValue(['', '焼肉'])).toBeUndefined();
  });

  it('undefined はそのまま指定なし', () => {
    expect(readSingleQueryValue(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 失敗するテストを書く**

```ts
// apps/mobile/src/lib/search-filter.test.ts
import { toRating } from '@meshimap/core';

import { SEARCH_QUERY_KEYS } from '@/constants/search';

import {
  EMPTY_SEARCH_FILTER,
  countActiveFilters,
  fromSearchQueryParams,
  toSearchQueryParams,
} from './search-filter';
import type { SearchFilter } from './search-filter';

const FULL_FILTER: SearchFilter = {
  keyword: '焼き鳥',
  genreIds: ['genre-yakitori', 'genre-izakaya'],
  areaId: 'area-shibuya',
  budgetMaxYen: 5000,
  isOpenNowOnly: true,
  minRating: toRating(4),
  distanceM: 1000,
};

describe('toSearchQueryParams', () => {
  it('空のフィルタはクエリを 1 つも作らない', () => {
    expect(toSearchQueryParams(EMPTY_SEARCH_FILTER)).toEqual({});
  });

  it('全ての条件をクエリへ変換する', () => {
    expect(toSearchQueryParams(FULL_FILTER)).toEqual({
      [SEARCH_QUERY_KEYS.keyword]: '焼き鳥',
      [SEARCH_QUERY_KEYS.genres]: 'genre-yakitori,genre-izakaya',
      [SEARCH_QUERY_KEYS.area]: 'area-shibuya',
      [SEARCH_QUERY_KEYS.budgetMax]: '5000',
      [SEARCH_QUERY_KEYS.openNow]: '1',
      [SEARCH_QUERY_KEYS.minRating]: '4',
      [SEARCH_QUERY_KEYS.distance]: '1000',
    });
  });

  it('営業中フィルタが off のときはキー自体を出さない', () => {
    // openNow=0 を出すと URL が無駄に長くなり、共有リンクも読みにくい
    expect(toSearchQueryParams({ ...EMPTY_SEARCH_FILTER, isOpenNowOnly: false })).toEqual({});
  });
});

describe('fromSearchQueryParams', () => {
  it('クエリが空なら空のフィルタになる', () => {
    expect(fromSearchQueryParams({})).toEqual(EMPTY_SEARCH_FILTER);
  });

  it('往復変換しても同じフィルタに戻る', () => {
    expect(fromSearchQueryParams(toSearchQueryParams(FULL_FILTER))).toEqual(FULL_FILTER);
  });

  it('配列で渡されたクエリは先頭だけを採用する', () => {
    // expo-router の useLocalSearchParams は同名キーが複数あると配列を返す
    const filter = fromSearchQueryParams({ [SEARCH_QUERY_KEYS.keyword]: ['寿司', '焼肉'] });

    expect(filter.keyword).toBe('寿司');
  });

  it('数値でないクエリは無視する', () => {
    const filter = fromSearchQueryParams({
      [SEARCH_QUERY_KEYS.budgetMax]: 'たくさん',
      [SEARCH_QUERY_KEYS.distance]: '-100',
    });

    expect(filter.budgetMaxYen).toBeNull();
    expect(filter.distanceM).toBeNull();
  });

  it('範囲外の評価は無視する', () => {
    expect(fromSearchQueryParams({ [SEARCH_QUERY_KEYS.minRating]: '9' }).minRating).toBeNull();
    expect(fromSearchQueryParams({ [SEARCH_QUERY_KEYS.minRating]: '0' }).minRating).toBeNull();
  });

  it('空文字のジャンルは取り除く', () => {
    expect(fromSearchQueryParams({ [SEARCH_QUERY_KEYS.genres]: 'a,,b' }).genreIds).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('countActiveFilters', () => {
  it('空のフィルタは 0 件', () => {
    expect(countActiveFilters(EMPTY_SEARCH_FILTER)).toBe(0);
  });

  it('キーワードは件数に含めない', () => {
    // キーワードは検索バーに表示されるので、チップのバッジで二重に数えない
    expect(countActiveFilters({ ...EMPTY_SEARCH_FILTER, keyword: '寿司' })).toBe(0);
  });

  it('ジャンルは選んだ数だけ数える', () => {
    expect(countActiveFilters({ ...EMPTY_SEARCH_FILTER, genreIds: ['a', 'b', 'c'] })).toBe(3);
  });

  it('全部指定すると 7 件になる', () => {
    // ジャンル 2 件 + エリア + 予算 + 営業中 + 評価 + 距離 = 7
    expect(countActiveFilters(FULL_FILTER)).toBe(7);
  });
});
```

Run: `npm test -w @meshimap/mobile -- search-filter`
Expected: FAIL（`Cannot find module './search-filter'`）

- [ ] **Step 3: search-filter.ts を実装する**

```ts
// apps/mobile/src/lib/search-filter.ts
import { RATING_MAX, RATING_MIN, toRating } from '@meshimap/core';
import type { Rating } from '@meshimap/core';

import { GENRE_ID_SEPARATOR, QUERY_TRUE_VALUE, SEARCH_QUERY_KEYS } from '@/constants/search';

import { readSingleQueryValue } from './query-params';
import type { QueryParams } from './query-params';

/** 地図・検索の両画面で共有する絞り込み条件 */
export interface SearchFilter {
  readonly keyword: string;
  readonly genreIds: readonly string[];
  readonly areaId: string | null;
  readonly budgetMaxYen: number | null;
  readonly isOpenNowOnly: boolean;
  readonly minRating: Rating | null;
  readonly distanceM: number | null;
}

export const EMPTY_SEARCH_FILTER: SearchFilter = {
  keyword: '',
  genreIds: [],
  areaId: null,
  budgetMaxYen: null,
  isOpenNowOnly: false,
  minRating: null,
  distanceM: null,
};

/**
 * expo-router の useLocalSearchParams が返す形。
 * 店舗詳細やレビュー投稿の画面でも同じ形を読むので、実体は query-params.ts に置く。
 */
export type SearchQueryParams = QueryParams;

/** フィルタを URL クエリへ。指定が無い条件はキーごと省いて URL を短く保つ */
export function toSearchQueryParams(filter: SearchFilter): Record<string, string> {
  const params: Record<string, string> = {};

  if (filter.keyword !== '') {
    params[SEARCH_QUERY_KEYS.keyword] = filter.keyword;
  }
  if (filter.genreIds.length > 0) {
    params[SEARCH_QUERY_KEYS.genres] = filter.genreIds.join(GENRE_ID_SEPARATOR);
  }
  if (filter.areaId !== null) {
    params[SEARCH_QUERY_KEYS.area] = filter.areaId;
  }
  if (filter.budgetMaxYen !== null) {
    params[SEARCH_QUERY_KEYS.budgetMax] = String(filter.budgetMaxYen);
  }
  if (filter.isOpenNowOnly) {
    params[SEARCH_QUERY_KEYS.openNow] = QUERY_TRUE_VALUE;
  }
  if (filter.minRating !== null) {
    params[SEARCH_QUERY_KEYS.minRating] = String(filter.minRating);
  }
  if (filter.distanceM !== null) {
    params[SEARCH_QUERY_KEYS.distance] = String(filter.distanceM);
  }

  return params;
}

/** URL クエリからフィルタへ。壊れた値は全て「指定なし」に倒す（画面を落とさない） */
export function fromSearchQueryParams(params: SearchQueryParams): SearchFilter {
  return {
    keyword: readSingleQueryValue(params[SEARCH_QUERY_KEYS.keyword]) ?? EMPTY_SEARCH_FILTER.keyword,
    genreIds: splitGenreIds(readSingleQueryValue(params[SEARCH_QUERY_KEYS.genres])),
    areaId: readSingleQueryValue(params[SEARCH_QUERY_KEYS.area]) ?? null,
    budgetMaxYen: readPositiveInteger(readSingleQueryValue(params[SEARCH_QUERY_KEYS.budgetMax])),
    isOpenNowOnly: readSingleQueryValue(params[SEARCH_QUERY_KEYS.openNow]) === QUERY_TRUE_VALUE,
    minRating: readRating(readSingleQueryValue(params[SEARCH_QUERY_KEYS.minRating])),
    distanceM: readPositiveInteger(readSingleQueryValue(params[SEARCH_QUERY_KEYS.distance])),
  };
}

/** チップに出す「絞り込み中」の件数。キーワードは検索バーに出ているので数えない */
export function countActiveFilters(filter: SearchFilter): number {
  return (
    filter.genreIds.length +
    (filter.areaId === null ? 0 : 1) +
    (filter.budgetMaxYen === null ? 0 : 1) +
    (filter.isOpenNowOnly ? 1 : 0) +
    (filter.minRating === null ? 0 : 1) +
    (filter.distanceM === null ? 0 : 1)
  );
}

function splitGenreIds(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return EMPTY_SEARCH_FILTER.genreIds;
  }
  return value.split(GENRE_ID_SEPARATOR).filter((genreId) => genreId !== '');
}

function readPositiveInteger(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readRating(value: string | undefined): Rating | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < RATING_MIN || parsed > RATING_MAX) {
    return null;
  }
  return toRating(parsed);
}
```

Run: `npm test -w @meshimap/mobile -- query-params search-filter`
Expected: PASS（20 件 = query-params 6 件 + search-filter 14 件）

- [ ] **Step 4: わざと壊してテストが落ちることを確認する**

`toSearchQueryParams` から `isOpenNowOnly` の分岐を削除し、「往復変換しても同じフィルタに戻る」が **FAIL** することを確認してから戻す。次に `readPositiveInteger` の `parsed > 0` を `true` に変えて「数値でないクエリは無視する」が **FAIL** することも確認する。

- [ ] **Step 5: コミットする**

```bash
git add apps/mobile/src/constants/search.ts apps/mobile/src/lib/query-params.ts apps/mobile/src/lib/query-params.test.ts apps/mobile/src/lib/search-filter.ts apps/mobile/src/lib/search-filter.test.ts
git commit -m "feat(mobile): 検索フィルタの型と URL クエリ変換を追加する"
```

---

### Task 6-9: 店舗 API 層（zod スキーマ + fetch）を作る

**Files:**

- Create: `apps/mobile/src/features/shops/schema.ts`
- Create: `apps/mobile/src/features/shops/schema.test.ts`
- Create: `apps/mobile/src/features/shops/api.ts`
- Create: `apps/mobile/src/features/shops/api.test.ts`
- Create: `apps/mobile/src/features/shops/query-keys.ts`
- Create: `apps/mobile/src/test-support/shop-fixtures.ts`（Task 6-2 Step 4 で保留した分）

**Interfaces:**

- Consumes: `@meshimap/core` の `businessHoursSchema` / `identifierSchema` / `latitudeSchema` / `longitudeSchema` / `webUrlSchema` / `budgetYenSchema` / `toShopId` / `toDayOfWeek` / `toMinuteOfDay` / `toJstDate` / `toRating` / `RATING_MAX` / `RATING_MIN` / 型 `ShopId` `BusinessHours` `ShopClosure` `Rating` `RatingDistribution` `OpenStatus`、`@meshimap/geo` の `coordinate` / 型 `Coordinate`、`@/lib/api-client` の `apiFetch`（Phase 5）、`@/lib/search-filter` の `toSearchQueryParams`
- Produces:
  - 型 `ShopSummary` `ShopDetail` `ShopMenuItem`
  - `shopSummarySchema` / `shopDetailSchema`
  - `shopCoordinate(shop: ShopSummary): Coordinate`
  - `RATING_VALUES: readonly Rating[]`
  - `fetchNearbyShops(params: NearbyShopsParams): Promise<readonly ShopSummary[]>`
  - `fetchSearchShops(params: SearchShopsParams): Promise<SearchShopsPage>`
  - `fetchShopDetail(shopId: ShopId): Promise<ShopDetail>`
  - `shopKeys`（クエリキー）

- [ ] **Step 1: 失敗するテストを書く（スキーマ）**

```ts
// apps/mobile/src/features/shops/schema.test.ts
import { shopCoordinate, shopDetailSchema, shopSummarySchema } from './schema';

const VALID_SHOP = {
  id: 'shop-001',
  name: '炭火焼鳥 とりまる',
  genreName: '焼き鳥',
  areaName: '渋谷',
  latitude: 35.658034,
  longitude: 139.701636,
  coverPhotoUrl: 'https://cdn.example.test/shops/001/cover.jpg',
  ratingAverage: 4.2,
  ratingCount: 128,
  budgetDinnerMinYen: 3000,
  budgetDinnerMaxYen: 4999,
  openStatus: 'open',
};

describe('shopSummarySchema', () => {
  it('正しい JSON を ShopSummary へ変換する', () => {
    const shop = shopSummarySchema.parse(VALID_SHOP);

    expect(shop.id).toBe('shop-001');
    expect(shop.ratingAverage).toBe(4.2);
  });

  it('カバー写真が null でも受け付ける', () => {
    expect(() => shopSummarySchema.parse({ ...VALID_SHOP, coverPhotoUrl: null })).not.toThrow();
  });

  it('緯度が数値でなければ弾く', () => {
    expect(() => shopSummarySchema.parse({ ...VALID_SHOP, latitude: '35.6' })).toThrow();
  });

  it('評価件数が負なら弾く', () => {
    expect(() => shopSummarySchema.parse({ ...VALID_SHOP, ratingCount: -1 })).toThrow();
  });

  it('id が空文字なら弾く', () => {
    expect(() => shopSummarySchema.parse({ ...VALID_SHOP, id: '' })).toThrow();
  });

  it('営業状態が既定の 4 値以外なら弾く', () => {
    // サーバ側が core の OpenStatus を変えたのに端末が古いままだと、
    // バッジが静かに「閉店」表示になる。入口で落として気づけるようにする
    expect(() => shopSummarySchema.parse({ ...VALID_SHOP, openStatus: 'unknown' })).toThrow();
  });
});

const VALID_MENU_ITEM = {
  name: 'せせり',
  priceYen: 280,
  description: '首肉。1 羽からわずかしか取れない部位です。',
  photoUrl: 'https://cdn.example.test/shops/001/menu/seseri.jpg',
  isRecommended: true,
};

/** 詳細は summary の全項目に加えて店舗ページ専用の項目を持つ */
const VALID_SHOP_DETAIL = {
  ...VALID_SHOP,
  description: '備長炭で焼く一本一本。',
  postalCode: '150-0002',
  address: '東京都渋谷区渋谷 1-1-1',
  phone: '03-0000-0000',
  website: null,
  budgetLunchMinYen: null,
  budgetLunchMaxYen: null,
  photoUrls: [],
  menuItems: [VALID_MENU_ITEM],
  hours: [],
  closures: [],
  ratingDistribution: { 1: 2, 2: 3, 3: 15, 4: 48, 5: 60 },
};

describe('shopDetailSchema のメニュー', () => {
  it('価格が null の品（時価）を受け付ける', () => {
    const detail = shopDetailSchema.parse({
      ...VALID_SHOP_DETAIL,
      menuItems: [{ ...VALID_MENU_ITEM, priceYen: null }],
    });

    expect(detail.menuItems[0]?.priceYen).toBeNull();
  });

  it('品名が空文字なら弾く', () => {
    // 名前の無い品を一覧に並べると、押せない空行が出て操作不能に見える
    expect(() =>
      shopDetailSchema.parse({
        ...VALID_SHOP_DETAIL,
        menuItems: [{ ...VALID_MENU_ITEM, name: '' }],
      }),
    ).toThrow();
  });
});

describe('shopCoordinate', () => {
  it('店舗の緯度経度を geo の Coordinate へ変換する', () => {
    const shop = shopSummarySchema.parse(VALID_SHOP);
    const center = shopCoordinate(shop);

    expect(center.latitude).toBeCloseTo(35.658034, 6);
    expect(center.longitude).toBeCloseTo(139.701636, 6);
  });
});
```

Run: `npm test -w @meshimap/mobile -- shops/schema`
Expected: FAIL（`Cannot find module './schema'`）

- [ ] **Step 2: schema.ts を実装する**

```ts
// apps/mobile/src/features/shops/schema.ts
import {
  RATING_MAX,
  RATING_MIN,
  budgetYenSchema,
  businessHoursSchema,
  identifierSchema,
  latitudeSchema,
  longitudeSchema,
  toDayOfWeek,
  toJstDate,
  toMinuteOfDay,
  toRating,
  toShopId,
  webUrlSchema,
} from '@meshimap/core';
import type {
  BusinessHours,
  OpenStatus,
  Rating,
  RatingDistribution,
  ShopClosure,
} from '@meshimap/core';
import { coordinate } from '@meshimap/geo';
import type { Coordinate } from '@meshimap/geo';
import { z } from 'zod';

/**
 * 営業状態。core の `OpenStatus` と同じ 4 値。
 * `z.enum` にリテラル配列を渡し、`satisfies` で core の型と食い違ったらコンパイルエラーにする。
 */
const OPEN_STATUS_VALUES = [
  'open',
  'closing-soon',
  'closed',
  'regular-holiday',
] as const satisfies readonly OpenStatus[];

const openStatusSchema = z.enum(OPEN_STATUS_VALUES);

/**
 * 評価分布。API は JSON のキーとして '1'〜'5' を返す。
 * TypeScript は数値リテラルのキーを文字列キーに正規化するため、
 * この形は core の `RatingDistribution`（`{ readonly [K in Rating]: number }`）と構造的に一致する。
 */
const ratingDistributionSchema = z.object({
  1: z.number().int().min(0),
  2: z.number().int().min(0),
  3: z.number().int().min(0),
  4: z.number().int().min(0),
  5: z.number().int().min(0),
}) satisfies z.ZodType<RatingDistribution, unknown>;

/**
 * 営業時間。core の businessHoursSchema が値域と「開店 < 閉店」「24 時間以内」を検証済みなので、
 * ここではブランド型（DayOfWeek / MinuteOfDay）への変換だけを足す。
 * 変換しないと `BusinessHours` へ代入できず、getOpenStatus に渡せない。
 */
const businessHoursDtoSchema = businessHoursSchema.transform((value): BusinessHours => ({
  dayOfWeek: toDayOfWeek(value.dayOfWeek),
  openMinute: toMinuteOfDay(value.openMinute),
  closeMinute: toMinuteOfDay(value.closeMinute),
  isClosed: value.isClosed,
}));

/** 臨時休業。date は JstDate（YYYY-MM-DD）へ変換して不正な日付を入口で弾く */
const shopClosureDtoSchema = z
  .object({ date: z.iso.date(), reason: z.string() })
  .transform((value): ShopClosure => ({ date: toJstDate(value.date), reason: value.reason }));

export const shopSummarySchema = z.object({
  // ブランド型への変換はここだけで行う。以降のコードは ShopId として扱える
  id: identifierSchema.transform(toShopId),
  name: z.string().min(1),
  genreName: z.string().min(1),
  areaName: z.string().min(1),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  coverPhotoUrl: webUrlSchema.nullable(),
  ratingAverage: z.number().min(0).max(RATING_MAX),
  ratingCount: z.number().int().min(0),
  budgetDinnerMinYen: budgetYenSchema,
  budgetDinnerMaxYen: budgetYenSchema,
  /**
   * サーバが `getOpenStatus` で算出した営業状態。
   * 一覧で使う 200 件ぶんの営業時間テーブルを端末に送ると転送量が跳ね上がるため、
   * サマリでは結果だけを受け取る（詳細画面は hours を持つので端末側で再計算する）。
   */
  openStatus: openStatusSchema,
});

export type ShopSummary = z.infer<typeof shopSummarySchema>;

/**
 * メニュー 1 品。価格は「時価」があるので null を許す（budgetYenSchema は nullable）。
 * 値段順の並べ替えは行わない。API が返した順＝店が見せたい順として扱う。
 */
const shopMenuItemSchema = z.object({
  name: z.string().min(1),
  priceYen: budgetYenSchema,
  description: z.string(),
  photoUrl: webUrlSchema.nullable(),
  isRecommended: z.boolean(),
});

export type ShopMenuItem = z.infer<typeof shopMenuItemSchema>;

export const shopDetailSchema = shopSummarySchema.extend({
  description: z.string(),
  postalCode: z.string().min(1),
  address: z.string().min(1),
  phone: z.string().min(1).nullable(),
  website: webUrlSchema.nullable(),
  budgetLunchMinYen: budgetYenSchema,
  budgetLunchMaxYen: budgetYenSchema,
  photoUrls: z.array(webUrlSchema),
  menuItems: z.array(shopMenuItemSchema),
  hours: z.array(businessHoursDtoSchema),
  closures: z.array(shopClosureDtoSchema),
  ratingDistribution: ratingDistributionSchema,
});

export type ShopDetail = z.infer<typeof shopDetailSchema>;

/** 店舗の緯度経度を geo の Coordinate へ。距離計算・クラスタリングの入口 */
export function shopCoordinate(shop: Pick<ShopSummary, 'latitude' | 'longitude'>): Coordinate {
  return coordinate(shop.latitude, shop.longitude);
}

/**
 * 評価が取りうる値。分布グラフの行数の根拠になる。
 * 星の数を UI 側でハードコードすると、core の RATING_MAX を変えたときに追随できない。
 */
export const RATING_VALUES: readonly Rating[] = Array.from(
  { length: RATING_MAX - RATING_MIN + 1 },
  (_unused, index) => toRating(RATING_MIN + index),
);
```

Run: `npm test -w @meshimap/mobile -- shops/schema`
Expected: PASS（9 件 = shopSummarySchema 6 件 + shopDetailSchema のメニュー 2 件 + shopCoordinate 1 件）

`businessHoursDtoSchema` / `shopClosureDtoSchema` は `.transform()` の戻り値を `BusinessHours` / `ShopClosure` と明示注釈しているため、`packages/core` の型とずれた場合はここで型エラーになる。API の DTO 側を直すか、変換関数を足して吸収する。

- [ ] **Step 3: クエリキーを作る**

```ts
// apps/mobile/src/features/shops/query-keys.ts
import type { ShopId } from '@meshimap/core';
import type { Geohash } from '@meshimap/geo';

import type { SearchFilter } from '@/lib/search-filter';
import { toSearchQueryParams } from '@/lib/search-filter';

/**
 * 店舗まわりのクエリキー。
 * 周辺検索のキーに生の緯度経度を入れるとピクセル単位の移動でキャッシュが総入れ替えになるため、
 * geohash セル + 半径に丸めた値をキーにする。同じセルの中を動く限りキャッシュが効く。
 */
export const shopKeys = {
  all: ['shops'] as const,
  nearby: (cell: Geohash, radiusM: number, filter: SearchFilter) =>
    [...shopKeys.all, 'nearby', cell, radiusM, toSearchQueryParams(filter)] as const,
  search: (filter: SearchFilter) =>
    [...shopKeys.all, 'search', toSearchQueryParams(filter)] as const,
  detail: (shopId: ShopId) => [...shopKeys.all, 'detail', shopId] as const,
};
```

- [ ] **Step 4: 失敗するテストを書く（API）**

```ts
// apps/mobile/src/features/shops/api.test.ts
import { toShopId } from '@meshimap/core';
import { coordinate } from '@meshimap/geo';

import { apiFetch } from '@/lib/api-client';
import { EMPTY_SEARCH_FILTER } from '@/lib/search-filter';

import { fetchNearbyShops, fetchShopDetail } from './api';

jest.mock('@/lib/api-client', () => ({
  apiFetch: jest.fn(),
  ApiError: class ApiError extends Error {},
}));

const apiFetchMock = jest.mocked(apiFetch);

const SHOP_JSON = {
  id: 'shop-001',
  name: '炭火焼鳥 とりまる',
  genreName: '焼き鳥',
  areaName: '渋谷',
  latitude: 35.658034,
  longitude: 139.701636,
  coverPhotoUrl: null,
  ratingAverage: 4.2,
  ratingCount: 128,
  budgetDinnerMinYen: 3000,
  budgetDinnerMaxYen: 4999,
};

describe('fetchNearbyShops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('中心・半径・件数をクエリに載せる', async () => {
    apiFetchMock.mockResolvedValue([]);

    await fetchNearbyShops({
      center: coordinate(35.658034, 139.701636),
      radiusM: 1400,
      limit: 200,
      filter: EMPTY_SEARCH_FILTER,
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/shops/nearby', {
      method: 'GET',
      searchParams: {
        lat: '35.658034',
        lng: '139.701636',
        radiusM: '1400',
        limit: '200',
      },
    });
  });

  it('フィルタをクエリに合成する', async () => {
    apiFetchMock.mockResolvedValue([]);

    await fetchNearbyShops({
      center: coordinate(35.658034, 139.701636),
      radiusM: 1400,
      limit: 200,
      filter: { ...EMPTY_SEARCH_FILTER, isOpenNowOnly: true, genreIds: ['genre-yakitori'] },
    });

    expect(apiFetchMock.mock.calls[0]?.[1]?.searchParams).toMatchObject({
      openNow: '1',
      genres: 'genre-yakitori',
    });
  });

  it('レスポンスを ShopSummary の配列へ変換する', async () => {
    apiFetchMock.mockResolvedValue([SHOP_JSON]);

    const shops = await fetchNearbyShops({
      center: coordinate(35.658034, 139.701636),
      radiusM: 1400,
      limit: 200,
      filter: EMPTY_SEARCH_FILTER,
    });

    expect(shops).toHaveLength(1);
    expect(shops[0]?.name).toBe('炭火焼鳥 とりまる');
  });

  it('形の違うレスポンスは例外にする', async () => {
    // 壊れた JSON をそのまま画面へ流すと、描画時に意味不明な落ち方をする
    apiFetchMock.mockResolvedValue([{ ...SHOP_JSON, latitude: null }]);

    await expect(
      fetchNearbyShops({
        center: coordinate(35.658034, 139.701636),
        radiusM: 1400,
        limit: 200,
        filter: EMPTY_SEARCH_FILTER,
      }),
    ).rejects.toThrow();
  });
});

describe('fetchShopDetail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('店舗 ID をパスに埋め込む', async () => {
    apiFetchMock.mockResolvedValue({
      ...SHOP_JSON,
      description: '備長炭で焼く一本一本。',
      postalCode: '150-0002',
      address: '東京都渋谷区渋谷 1-1-1',
      phone: '03-0000-0000',
      website: null,
      budgetLunchMinYen: null,
      budgetLunchMaxYen: null,
      photoUrls: [],
      hours: [],
      closures: [],
      ratingDistribution: { '1': 2, '2': 3, '3': 15, '4': 48, '5': 60 },
    });

    await fetchShopDetail(toShopId('shop-001'));

    expect(apiFetchMock).toHaveBeenCalledWith('/shops/shop-001', { method: 'GET' });
  });
});
```

Run: `npm test -w @meshimap/mobile -- shops/api`
Expected: FAIL（`Cannot find module './api'`）

- [ ] **Step 5: api.ts を実装する**

```ts
// apps/mobile/src/features/shops/api.ts
import type { ShopId } from '@meshimap/core';
import type { Coordinate } from '@meshimap/geo';
import { z } from 'zod';

import { apiFetch } from '@/lib/api-client';
import type { SearchFilter } from '@/lib/search-filter';
import { toSearchQueryParams } from '@/lib/search-filter';

import { shopDetailSchema, shopSummarySchema } from './schema';
import type { ShopDetail, ShopSummary } from './schema';

const shopSummaryListSchema = z.array(shopSummarySchema);

const searchShopsPageSchema = z.object({
  shops: shopSummaryListSchema,
  /** 次ページがあるときだけ入る。null で終端 */
  nextCursor: z.string().min(1).nullable(),
  totalCount: z.number().int().min(0),
});

export type SearchShopsPage = z.infer<typeof searchShopsPageSchema>;

export interface NearbyShopsParams {
  readonly center: Coordinate;
  readonly radiusM: number;
  readonly limit: number;
  readonly filter: SearchFilter;
}

export interface SearchShopsParams {
  readonly filter: SearchFilter;
  readonly center: Coordinate | null;
  readonly cursor: string | null;
  readonly limit: number;
}

/** 地図の表示範囲に外接する円で店舗を取る。3 段階の地理検索は API 側（Phase 4）が担う */
export async function fetchNearbyShops(params: NearbyShopsParams): Promise<readonly ShopSummary[]> {
  const payload = await apiFetch('/shops/nearby', {
    method: 'GET',
    searchParams: {
      lat: String(params.center.latitude),
      lng: String(params.center.longitude),
      radiusM: String(params.radiusM),
      limit: String(params.limit),
      ...toSearchQueryParams(params.filter),
    },
  });

  return shopSummaryListSchema.parse(payload);
}

/** キーワード + 条件検索。全文検索（FTS5）は API 側で行う */
export async function fetchSearchShops(params: SearchShopsParams): Promise<SearchShopsPage> {
  const searchParams: Record<string, string> = {
    limit: String(params.limit),
    ...toSearchQueryParams(params.filter),
  };
  if (params.cursor !== null) {
    searchParams.cursor = params.cursor;
  }
  if (params.center !== null) {
    // 距離順ソートと距離フィルタに使う。現在地が無い場合は API 側が距離条件を無視する
    searchParams.lat = String(params.center.latitude);
    searchParams.lng = String(params.center.longitude);
  }

  const payload = await apiFetch('/shops/search', { method: 'GET', searchParams });
  return searchShopsPageSchema.parse(payload);
}

export async function fetchShopDetail(shopId: ShopId): Promise<ShopDetail> {
  const payload = await apiFetch(`/shops/${shopId}`, { method: 'GET' });
  return shopDetailSchema.parse(payload);
}
```

Run: `npm test -w @meshimap/mobile -- shops/api`
Expected: PASS（5 件）

- [ ] **Step 6: Task 6-2 で保留した shop-fixtures.ts を作る**

Task 6-2 Step 4 に載せたコードをそのまま `apps/mobile/src/test-support/shop-fixtures.ts` に作成する。加えて詳細用のフィクスチャも足す。

`ShopDetail` の `hours` / `closures` は `MinuteOfDay` `JstDate` といったブランド型を含むので、
オブジェクトリテラルを `ShopDetail` として直接書くとコンパイルが通らない。
素の JSON を組み立てて `shopDetailSchema.parse` に通す形にする。
テストのフィクスチャが実際の API レスポンスと食い違う事故も同時に防げる。

```ts
// apps/mobile/src/test-support/shop-fixtures.ts に追記
import { shopDetailSchema } from '@/features/shops/schema';
import type { ShopDetail } from '@/features/shops/schema';

/** 店舗詳細の素の JSON。スキーマを通す前の、API が返すのと同じ形 */
const DEFAULT_SHOP_DETAIL_JSON = {
  id: 'shop-001',
  name: '炭火焼鳥 とりまる',
  genreName: '焼き鳥',
  areaName: '渋谷',
  latitude: 35.658034,
  longitude: 139.701636,
  coverPhotoUrl: 'https://cdn.example.test/shops/001/cover.jpg',
  ratingAverage: 4.2,
  ratingCount: 128,
  budgetDinnerMinYen: 3000,
  budgetDinnerMaxYen: 4999,
  openStatus: 'open',
  description: '備長炭で焼く一本一本。カウンター 10 席の小さな店です。',
  postalCode: '150-0002',
  address: '東京都渋谷区渋谷 1-1-1',
  phone: '03-0000-0000',
  website: null,
  budgetLunchMinYen: null,
  budgetLunchMaxYen: null,
  photoUrls: [
    'https://cdn.example.test/shops/001/1.jpg',
    'https://cdn.example.test/shops/001/2.jpg',
  ],
  menuItems: [
    {
      name: 'おまかせ 10 本コース',
      priceYen: 3800,
      description: 'その日の仕入れから 10 本。',
      photoUrl: 'https://cdn.example.test/shops/001/menu/course.jpg',
      isRecommended: true,
    },
    {
      name: 'せせり',
      priceYen: 280,
      description: '首肉。1 羽からわずかしか取れない部位です。',
      photoUrl: null,
      isRecommended: false,
    },
  ],
  hours: [
    { dayOfWeek: 1, openMinute: 1020, closeMinute: 1380, isClosed: false },
    { dayOfWeek: 2, openMinute: 1020, closeMinute: 1380, isClosed: false },
    { dayOfWeek: 3, openMinute: 0, closeMinute: 0, isClosed: true },
  ],
  closures: [],
  ratingDistribution: { 1: 2, 2: 3, 3: 15, 4: 48, 5: 60 },
};

/**
 * 差分を素の JSON で渡して店舗詳細を作る。
 * キー名だけ型で縛り、値はスキーマの検証に任せる（ブランド型を手で作らずに済む）。
 */
export type ShopDetailOverrides = Partial<Record<keyof ShopDetail, unknown>>;

export function buildShopDetail(overrides: ShopDetailOverrides = {}): ShopDetail {
  return shopDetailSchema.parse({ ...DEFAULT_SHOP_DETAIL_JSON, ...overrides });
}
```

- [ ] **Step 7: わざと壊してテストが落ちることを確認する**

`fetchNearbyShops` の `shopSummaryListSchema.parse(payload)` を `payload` の素返しに変え（戻り値の型は `as` を使わず一時的に `unknown` 経由の関数に変更）、「形の違うレスポンスは例外にする」が **FAIL** することを確認してから戻す。

- [ ] **Step 8: コミットする**

```bash
git add apps/mobile/src/features/shops/ apps/mobile/src/test-support/shop-fixtures.ts
git commit -m "feat(mobile): 店舗 API のスキーマと取得関数を追加する"
```

---

### Task 6-10: 店舗のクラスタリングと周辺検索フックを作る

**Files:**

- Create: `apps/mobile/src/lib/shop-cluster.ts`
- Create: `apps/mobile/src/lib/shop-cluster.test.ts`
- Create: `apps/mobile/src/features/shops/use-nearby-shops.ts`
- Create: `apps/mobile/src/features/shops/use-nearby-shops.test.tsx`

**Interfaces:**

- Consumes: `@meshimap/geo` の `clusterByGrid` / `encodeGeohash` / `isWithinBounds` / `precisionForRadius` / `precisionForZoom` / 型 `BoundingBox` `Cluster` `GridPoint`、`@/lib/map-region`、`@/stores/map-viewport`、`./api` の `fetchNearbyShops`
- Produces:
  - `clusterShops(shops, zoom): readonly Cluster<ShopSummary>[]`
  - `shopsWithinBounds(shops, bounds): readonly ShopSummary[]`
  - `singleShopOf(cluster): ShopSummary | null`
  - `clusterMarkerKey(cluster, selectedShopId): string`
  - `useNearbyShops(filter: SearchFilter): NearbyShopsResult`

- [ ] **Step 1: 失敗するテストを書く（クラスタリング）**

```ts
// apps/mobile/src/lib/shop-cluster.test.ts
import { toShopId } from '@meshimap/core';

import { buildShopSummary } from '@/test-support/shop-fixtures';

import { regionToBoundingBox } from './map-region';
import { clusterMarkerKey, clusterShops, shopsWithinBounds, singleShopOf } from './shop-cluster';

const SHIBUYA = buildShopSummary({
  id: toShopId('shop-shibuya'),
  latitude: 35.658034,
  longitude: 139.701636,
});
/** 渋谷から約 30m。どのズームでも同じセルに入る */
const SHIBUYA_NEIGHBOR = buildShopSummary({
  id: toShopId('shop-neighbor'),
  latitude: 35.658304,
  longitude: 139.701636,
});
/** 品川。渋谷から約 6km */
const SHINAGAWA = buildShopSummary({
  id: toShopId('shop-shinagawa'),
  latitude: 35.62876,
  longitude: 139.73876,
});

describe('clusterShops', () => {
  it('ズームが浅いと離れた店も 1 つにまとまる', () => {
    // zoom 8 → geohash 精度 3（セル約 156km 四方）。渋谷と品川は同じセル
    const clusters = clusterShops([SHIBUYA, SHINAGAWA], 8);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.values).toHaveLength(2);
  });

  it('ズームが深いと離れた店は別クラスタになる', () => {
    // zoom 17 → geohash 精度 7（セル約 152m 四方）
    const clusters = clusterShops([SHIBUYA, SHINAGAWA], 17);

    expect(clusters).toHaveLength(2);
  });

  it('近接した店は深いズームでもまとまる', () => {
    const clusters = clusterShops([SHIBUYA, SHIBUYA_NEIGHBOR], 17);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.values).toHaveLength(2);
  });

  it('同じ入力なら同じ順序のクラスタを返す', () => {
    // React の key が毎回変わるとマーカーが総入れ替えになるため、順序の安定は必須
    const first = clusterShops([SHINAGAWA, SHIBUYA], 17).map((cluster) => cluster.cell);
    const second = clusterShops([SHIBUYA, SHINAGAWA], 17).map((cluster) => cluster.cell);

    expect(first).toEqual(second);
  });

  it('店舗が無ければ空配列', () => {
    expect(clusterShops([], 17)).toEqual([]);
  });
});

describe('shopsWithinBounds', () => {
  it('表示範囲の外にある店を除く', () => {
    const bounds = regionToBoundingBox({
      latitude: 35.658034,
      longitude: 139.701636,
      latitudeDelta: 0.018,
      longitudeDelta: 0.022,
    });

    const visible = shopsWithinBounds([SHIBUYA, SHINAGAWA], bounds);

    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe(SHIBUYA.id);
  });
});

describe('singleShopOf', () => {
  it('1 件だけのクラスタは店舗を返す', () => {
    const clusters = clusterShops([SHIBUYA], 17);

    expect(singleShopOf(clusters[0]!)?.id).toBe(SHIBUYA.id);
  });

  it('複数件のクラスタは null を返す', () => {
    const clusters = clusterShops([SHIBUYA, SHIBUYA_NEIGHBOR], 17);

    expect(singleShopOf(clusters[0]!)).toBeNull();
  });
});

describe('clusterMarkerKey', () => {
  it('選択状態が変わるとキーが変わる', () => {
    const clusters = clusterShops([SHIBUYA], 17);
    const cluster = clusters[0]!;

    // tracksViewChanges=false のマーカーは再マウントしないと見た目が更新されないため、
    // 選択状態を key に含めて意図的に作り直す
    expect(clusterMarkerKey(cluster, null)).not.toBe(clusterMarkerKey(cluster, SHIBUYA.id));
  });

  it('関係ない店が選ばれてもキーは変わらない', () => {
    const clusters = clusterShops([SHIBUYA], 17);
    const cluster = clusters[0]!;

    expect(clusterMarkerKey(cluster, null)).toBe(clusterMarkerKey(cluster, SHINAGAWA.id));
  });
});
```

`!` 非 null アサーションは規約で禁止のため、実装時は次のヘルパーをテストの先頭に置いて置き換える。

```ts
/** noUncheckedIndexedAccess 下で配列の要素を取り出すテスト用ヘルパー */
function at<TValue>(values: readonly TValue[], index: number): TValue {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`テストの前提が壊れている: index ${index} に要素が無い`);
  }
  return value;
}
```

Run: `npm test -w @meshimap/mobile -- shop-cluster`
Expected: FAIL（`Cannot find module './shop-cluster'`）

- [ ] **Step 2: shop-cluster.ts を実装する**

```ts
// apps/mobile/src/lib/shop-cluster.ts
import type { ShopId } from '@meshimap/core';
import { clusterByGrid, isWithinBounds } from '@meshimap/geo';
import type { BoundingBox as GeoBoundingBox, Cluster, GridPoint } from '@meshimap/geo';

import { shopCoordinate } from '@/features/shops/schema';
import type { ShopSummary } from '@/features/shops/schema';

/** 選択中の店舗が無いときに key へ入れる値 */
const NO_SELECTION_KEY = 'none';

export type ShopCluster = Cluster<ShopSummary>;

/**
 * 店舗をズームに応じた geohash セルでまとめる。
 * clusterByGrid はセルの辞書順で返すので、同じ入力なら並びが変わらず React の key が安定する。
 */
export function clusterShops(shops: readonly ShopSummary[], zoom: number): readonly ShopCluster[] {
  const points: readonly GridPoint<ShopSummary>[] = shops.map((shop) => ({
    coordinate: shopCoordinate(shop),
    value: shop,
  }));

  return clusterByGrid(points, zoom);
}

/**
 * 表示範囲内の店舗だけを残す。
 * API は円で取ってくるので、矩形の画面外にある店がボトムシートのカードに混ざる。
 * 「見えている店だけがリストに出る」ほうが地図とリストの対応が取れて分かりやすい。
 */
export function shopsWithinBounds(
  shops: readonly ShopSummary[],
  bounds: GeoBoundingBox,
): readonly ShopSummary[] {
  return shops.filter((shop) => isWithinBounds(shopCoordinate(shop), bounds));
}

/** 1 件だけのクラスタなら店舗、複数件なら null */
export function singleShopOf(cluster: ShopCluster): ShopSummary | null {
  const [first, ...rest] = cluster.values;
  return first !== undefined && rest.length === 0 ? first : null;
}

/**
 * マーカーの React key。
 * セル ID だけだと選択状態が変わってもマーカーが再マウントされず、
 * tracksViewChanges={false} のスナップショットが古いままになる。
 */
export function clusterMarkerKey(cluster: ShopCluster, selectedShopId: ShopId | null): string {
  const isSelected =
    selectedShopId !== null && cluster.values.some((shop) => shop.id === selectedShopId);
  return `${cluster.cell}:${isSelected ? selectedShopId : NO_SELECTION_KEY}`;
}
```

Run: `npm test -w @meshimap/mobile -- shop-cluster`
Expected: PASS（10 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`clusterMarkerKey` を `cluster.cell` だけ返すように変え、「選択状態が変わるとキーが変わる」が **FAIL** することを確認してから戻す。

- [ ] **Step 4: 失敗するテストを書く（useNearbyShops）**

```tsx
// apps/mobile/src/features/shops/use-nearby-shops.test.tsx
import { toShopId } from '@meshimap/core';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { Region } from 'react-native-maps';

import { EMPTY_SEARCH_FILTER } from '@/lib/search-filter';
import { useMapViewportStore } from '@/stores/map-viewport';
import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildShopSummary } from '@/test-support/shop-fixtures';

import { fetchNearbyShops } from './api';
import { useNearbyShops } from './use-nearby-shops';

jest.mock('./api', () => ({ fetchNearbyShops: jest.fn() }));

const fetchNearbyShopsMock = jest.mocked(fetchNearbyShops);

const SHIBUYA_REGION: Region = {
  latitude: 35.658034,
  longitude: 139.701636,
  latitudeDelta: 0.018,
  longitudeDelta: 0.022,
};

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  };
}

describe('useNearbyShops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useMapViewportStore.getState().reset();
    useMapViewportStore.getState().setViewportWidthPx(390);
  });

  it('検索範囲が決まるまでは取得しない', async () => {
    const { result } = await renderHook(() => useNearbyShops(EMPTY_SEARCH_FILTER), {
      wrapper: createWrapper(),
    });

    expect(result.current.status).toBe('loading');
    expect(fetchNearbyShopsMock).not.toHaveBeenCalled();
  });

  it('Region の中心と半径で取得する', async () => {
    fetchNearbyShopsMock.mockResolvedValue([]);
    useMapViewportStore.getState().setCurrentRegion(SHIBUYA_REGION);

    const { result } = await renderHook(() => useNearbyShops(EMPTY_SEARCH_FILTER), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const params = fetchNearbyShopsMock.mock.calls[0]?.[0];
    expect(params?.center.latitude).toBeCloseTo(35.658034, 6);
    expect(params?.radiusM).toBeGreaterThan(1300);
    expect(params?.radiusM).toBeLessThan(1500);
  });

  it('取得した店舗をズームに応じてクラスタへまとめる', async () => {
    fetchNearbyShopsMock.mockResolvedValue([
      buildShopSummary({ id: toShopId('shop-a'), latitude: 35.658034, longitude: 139.701636 }),
      buildShopSummary({ id: toShopId('shop-b'), latitude: 35.658304, longitude: 139.701636 }),
    ]);
    useMapViewportStore.getState().setCurrentRegion(SHIBUYA_REGION);

    const { result } = await renderHook(() => useNearbyShops(EMPTY_SEARCH_FILTER), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.clusters).toHaveLength(1);
    });
    expect(result.current.clusters[0]?.values).toHaveLength(2);
  });

  it('表示範囲の外にある店はリストから外す', async () => {
    fetchNearbyShopsMock.mockResolvedValue([
      buildShopSummary({ id: toShopId('shop-a'), latitude: 35.658034, longitude: 139.701636 }),
      buildShopSummary({ id: toShopId('shop-b'), latitude: 35.62876, longitude: 139.73876 }),
    ]);
    useMapViewportStore.getState().setCurrentRegion(SHIBUYA_REGION);

    const { result } = await renderHook(() => useNearbyShops(EMPTY_SEARCH_FILTER), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.visibleShops).toHaveLength(1);
    });
  });

  it('地図を少し動かしただけでは再取得しない', async () => {
    fetchNearbyShopsMock.mockResolvedValue([]);
    useMapViewportStore.getState().setCurrentRegion(SHIBUYA_REGION);

    const { result } = await renderHook(() => useNearbyShops(EMPTY_SEARCH_FILTER), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    // searchedRegion を更新しない限りクエリキーは変わらない
    useMapViewportStore.getState().setCurrentRegion({ ...SHIBUYA_REGION, latitude: 35.6582 });
    await waitFor(() => {
      expect(fetchNearbyShopsMock).toHaveBeenCalledTimes(1);
    });
  });

  it('commitSearchedRegion のあとは新しい中心で取得する', async () => {
    fetchNearbyShopsMock.mockResolvedValue([]);
    useMapViewportStore.getState().setCurrentRegion(SHIBUYA_REGION);

    const { result } = await renderHook(() => useNearbyShops(EMPTY_SEARCH_FILTER), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    useMapViewportStore.getState().setCurrentRegion({ ...SHIBUYA_REGION, latitude: 35.69 });
    useMapViewportStore.getState().commitSearchedRegion();

    await waitFor(() => {
      expect(fetchNearbyShopsMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchNearbyShopsMock.mock.calls[1]?.[0].center.latitude).toBeCloseTo(35.69, 4);
  });

  it('取得に失敗したら error になる', async () => {
    fetchNearbyShopsMock.mockRejectedValue(new Error('network'));
    useMapViewportStore.getState().setCurrentRegion(SHIBUYA_REGION);

    const { result } = await renderHook(() => useNearbyShops(EMPTY_SEARCH_FILTER), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
  });
});
```

Run: `npm test -w @meshimap/mobile -- use-nearby-shops`
Expected: FAIL（`Cannot find module './use-nearby-shops'`）

- [ ] **Step 5: use-nearby-shops.ts を実装する**

```ts
// apps/mobile/src/features/shops/use-nearby-shops.ts
import { encodeGeohash, precisionForRadius, precisionForZoom } from '@meshimap/geo';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { NEARBY_SHOPS_LIMIT } from '@/constants/map';
import { regionCenter, regionRadiusM, regionToBoundingBox, regionZoom } from '@/lib/map-region';
import type { SearchFilter } from '@/lib/search-filter';
import { clusterShops, shopsWithinBounds } from '@/lib/shop-cluster';
import type { ShopCluster } from '@/lib/shop-cluster';
import { useMapViewportStore } from '@/stores/map-viewport';

import { fetchNearbyShops } from './api';
import { shopKeys } from './query-keys';
import type { ShopSummary } from './schema';

export type NearbyShopsStatus = 'loading' | 'error' | 'success';

export interface NearbyShopsResult {
  /** API から返ってきた全件 */
  readonly shops: readonly ShopSummary[];
  /** いま画面に映っている店舗だけ。ボトムシートのカード一覧に使う */
  readonly visibleShops: readonly ShopSummary[];
  /** 現在のズームでまとめたクラスタ。地図のマーカーに使う */
  readonly clusters: readonly ShopCluster[];
  readonly status: NearbyShopsStatus;
  readonly refetch: () => void;
}

const EMPTY_SHOPS: readonly ShopSummary[] = [];
const EMPTY_CLUSTERS: readonly ShopCluster[] = [];

/**
 * 地図の表示範囲から店舗を取得してクラスタリングする。
 *
 * クエリキーに緯度経度をそのまま入れると数ピクセルの移動で別キーになりキャッシュが無駄になる。
 * 半径に応じた geohash セルへ丸めることで「同じセルの中を動く限り再取得しない」を実現する。
 */
export function useNearbyShops(filter: SearchFilter): NearbyShopsResult {
  const currentRegion = useMapViewportStore((state) => state.currentRegion);
  const searchedRegion = useMapViewportStore((state) => state.searchedRegion);
  const viewportWidthPx = useMapViewportStore((state) => state.viewportWidthPx);

  const searchParams = useMemo(() => {
    if (searchedRegion === null) {
      return null;
    }
    const center = regionCenter(searchedRegion);
    const radiusM = regionRadiusM(searchedRegion);
    return { center, radiusM, cell: encodeGeohash(center, precisionForRadius(radiusM)) };
  }, [searchedRegion]);

  const query = useQuery({
    queryKey:
      searchParams === null
        ? [...shopKeys.all, 'nearby', 'pending']
        : shopKeys.nearby(searchParams.cell, searchParams.radiusM, filter),
    queryFn: () => {
      if (searchParams === null) {
        // enabled: false のときは呼ばれないが、型を絞るために必要
        return Promise.resolve(EMPTY_SHOPS);
      }
      return fetchNearbyShops({
        center: searchParams.center,
        radiusM: searchParams.radiusM,
        limit: NEARBY_SHOPS_LIMIT,
        filter,
      });
    },
    enabled: searchParams !== null,
  });

  const shops = query.data ?? EMPTY_SHOPS;

  // クラスタの粒度はズームではなく geohash 精度で決まる。
  // 精度を依存に入れることで、同じ粒度のままの微小なズーム変化では再計算しない。
  const precision =
    currentRegion === null ? null : precisionForZoom(regionZoom(currentRegion, viewportWidthPx));

  const clusters = useMemo(() => {
    if (currentRegion === null || precision === null) {
      return EMPTY_CLUSTERS;
    }
    return clusterShops(shops, regionZoom(currentRegion, viewportWidthPx));
    // currentRegion 自体を依存に入れると 1px 動かすたびに再計算されるため precision で代用する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shops, precision]);

  const visibleShops = useMemo(() => {
    if (currentRegion === null) {
      return EMPTY_SHOPS;
    }
    return shopsWithinBounds(shops, regionToBoundingBox(currentRegion));
  }, [shops, currentRegion]);

  const status: NearbyShopsStatus = query.isError
    ? 'error'
    : query.data === undefined
      ? 'loading'
      : 'success';

  return {
    shops,
    visibleShops,
    clusters,
    status,
    refetch: () => {
      void query.refetch();
    },
  };
}
```

`clusters` の `useMemo` で `currentRegion` を依存から外しているのは意図的な最適化なので、`eslint-disable-next-line` の直上に理由を必ず書く（規約の「根拠なく TODO を残さない」と同じ趣旨）。

Run: `npm test -w @meshimap/mobile -- use-nearby-shops`
Expected: PASS（7 件）

- [ ] **Step 6: わざと壊してテストが落ちることを確認する**

`shopKeys.nearby` の `cell` を `String(center.latitude)` に変えて、「地図を少し動かしただけでは再取得しない」が **FAIL**（2 回呼ばれる）することを確認してから戻す。次に `visibleShops` の `shopsWithinBounds` を素の `shops` に変えて「表示範囲の外にある店はリストから外す」が **FAIL** することも確認する。

- [ ] **Step 7: コミットする**

```bash
git add apps/mobile/src/lib/shop-cluster.ts apps/mobile/src/lib/shop-cluster.test.ts apps/mobile/src/features/shops/use-nearby-shops.ts apps/mobile/src/features/shops/use-nearby-shops.test.tsx
git commit -m "feat(mobile): 店舗のクラスタリングと周辺検索フックを追加する"
```

---

### Task 6-11: 店舗マーカーを作る

**Files:**

- Create: `apps/mobile/src/components/map/shop-marker.tsx`
- Create: `apps/mobile/src/components/map/shop-marker.test.tsx`

**Interfaces:**

- Consumes: `react-native-maps` の `Marker`、`@/features/shops/schema` の型 `ShopSummary`、`@/constants/theme`
- Produces: `ShopMarker`（`memo` 済み） / 型 `ShopMarkerProps`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/components/map/shop-marker.tsx のテスト
// apps/mobile/src/components/map/shop-marker.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { COLORS } from '@/constants/theme';
import { buildShopSummary } from '@/test-support/shop-fixtures';

import { ShopMarker } from './shop-marker';

describe('ShopMarker', () => {
  it('店名をラベルに表示する', async () => {
    await render(
      <ShopMarker
        shop={buildShopSummary()}
        isSelected={false}
        onPress={jest.fn()}
        testID="shop-marker"
      />,
    );

    expect(screen.getByText('炭火焼鳥 とりまる')).toBeOnTheScreen();
  });

  it('タップすると店舗 ID を渡して呼ばれる', async () => {
    const handlePress = jest.fn();
    const shop = buildShopSummary();

    await render(
      <ShopMarker shop={shop} isSelected={false} onPress={handlePress} testID="shop-marker" />,
    );
    await fireEvent.press(screen.getByTestId('shop-marker'));

    expect(handlePress).toHaveBeenCalledWith(shop.id);
  });

  it('選択中はピンの背景がブランド色になる', async () => {
    await render(
      <ShopMarker shop={buildShopSummary()} isSelected onPress={jest.fn()} testID="shop-marker" />,
    );

    expect(screen.getByTestId('shop-marker-pin')).toHaveStyle({
      backgroundColor: COLORS.primary[500],
    });
  });

  it('非選択のピンは白背景になる', async () => {
    await render(
      <ShopMarker
        shop={buildShopSummary()}
        isSelected={false}
        onPress={jest.fn()}
        testID="shop-marker"
      />,
    );

    expect(screen.getByTestId('shop-marker-pin')).toHaveStyle({ backgroundColor: COLORS.white });
  });

  it('再描画の追従を止めてある', async () => {
    // 多数のピンで tracksViewChanges が true のままだと、毎フレーム再スナップショットされて地図が固まる
    await render(
      <ShopMarker
        shop={buildShopSummary()}
        isSelected={false}
        onPress={jest.fn()}
        testID="shop-marker"
      />,
    );

    expect(screen.getByTestId('shop-marker').props.tracksViewChanges).toBe(false);
  });
});
```

Run: `npm test -w @meshimap/mobile -- shop-marker`
Expected: FAIL（`Cannot find module './shop-marker'`）

- [ ] **Step 2: shop-marker.tsx を実装する**

`Marker` は NativeWind に登録されていないため `className` は効かない。`StyleSheet` とテーマ定数で書く。

```tsx
// apps/mobile/src/components/map/shop-marker.tsx
import { memo, useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Marker } from 'react-native-maps';
import type { ShopId } from '@meshimap/core';

import { COLORS, FONT_SIZES, RADIUS, SPACING, Z_INDEX } from '@/constants/theme';
import type { ShopSummary } from '@/features/shops/schema';

/** ラベルに出す店名の最大文字数。長いとピン同士が重なって地図が読めなくなる */
const LABEL_MAX_LENGTH = 8;

const LABEL_ELLIPSIS = '…';

export interface ShopMarkerProps {
  shop: ShopSummary;
  isSelected: boolean;
  onPress: (shopId: ShopId) => void;
  testID?: string | undefined;
}

function ShopMarkerComponent({ shop, isSelected, onPress, testID }: ShopMarkerProps) {
  const handlePress = useCallback(() => {
    onPress(shop.id);
  }, [onPress, shop.id]);

  return (
    <Marker
      identifier={shop.id}
      coordinate={{ latitude: shop.latitude, longitude: shop.longitude }}
      onPress={handlePress}
      // 選択中のピンを他のピンより手前に出す
      zIndex={isSelected ? Z_INDEX.mapOverlayButton : Z_INDEX.mapMarker}
      // カスタムビューのスナップショットを 1 回で固定する。選択状態の変化は key の付け替えで反映する
      tracksViewChanges={false}
      testID={testID}
    >
      <View
        testID={testID === undefined ? undefined : `${testID}-pin`}
        style={[styles.pin, isSelected ? styles.pinSelected : styles.pinDefault]}
      >
        <Text style={[styles.label, isSelected ? styles.labelSelected : styles.labelDefault]}>
          {truncateLabel(shop.name)}
        </Text>
      </View>
    </Marker>
  );
}

/** 長い店名を丸める。丸めた印として末尾に三点リーダを付ける */
function truncateLabel(name: string): string {
  return name.length <= LABEL_MAX_LENGTH
    ? name
    : `${name.slice(0, LABEL_MAX_LENGTH)}${LABEL_ELLIPSIS}`;
}

const styles = StyleSheet.create({
  pin: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
  pinDefault: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.neutral[300],
  },
  pinSelected: {
    backgroundColor: COLORS.primary[500],
    borderColor: COLORS.primary[700],
  },
  label: {
    fontSize: FONT_SIZES.xs,
  },
  labelDefault: {
    color: COLORS.neutral[800],
  },
  labelSelected: {
    color: COLORS.white,
  },
});

/**
 * 200 件のピンが親の再レンダリングで全部作り直されるのを防ぐ。
 * props は shop（参照が安定）/ isSelected / onPress（useCallback）なので既定の浅い比較で足りる。
 */
export const ShopMarker = memo(ShopMarkerComponent);
```

Run: `npm test -w @meshimap/mobile -- shop-marker`
Expected: PASS（5 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`tracksViewChanges={false}` を削除して「再描画の追従を止めてある」が **FAIL** することを確認してから戻す。

- [ ] **Step 4: コミットする**

```bash
git add apps/mobile/src/components/map/shop-marker.tsx apps/mobile/src/components/map/shop-marker.test.tsx
git commit -m "feat(mobile): 店舗マーカーを追加する"
```

---

### Task 6-12: クラスタマーカーを作る

**Files:**

- Create: `apps/mobile/src/components/map/cluster-marker.tsx`
- Create: `apps/mobile/src/components/map/cluster-marker.test.tsx`

**Interfaces:**

- Consumes: `react-native-maps` の `Marker`、`@meshimap/geo` の型 `Coordinate`、`@/constants/map` の `CLUSTER_LABEL_MAX_COUNT`
- Produces: `ClusterMarker`（`memo` 済み） / 型 `ClusterMarkerProps` / `clusterLabel(count: number): string` / `clusterDiameterPx(count: number): number`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/components/map/cluster-marker.test.tsx
import { coordinate } from '@meshimap/geo';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ClusterMarker, clusterDiameterPx, clusterLabel } from './cluster-marker';

const CENTER = coordinate(35.658034, 139.701636);

describe('clusterLabel', () => {
  it('件数をそのまま表示する', () => {
    expect(clusterLabel(12)).toBe('12');
  });

  it('99 件まではそのまま', () => {
    expect(clusterLabel(99)).toBe('99');
  });

  it('100 件以上は 99+ にまとめる', () => {
    // 3 桁以上を出すと円が横に伸びてピンに見えなくなる
    expect(clusterLabel(100)).toBe('99+');
    expect(clusterLabel(1234)).toBe('99+');
  });
});

describe('clusterDiameterPx', () => {
  it('件数が多いほど大きくなる', () => {
    expect(clusterDiameterPx(3)).toBeLessThan(clusterDiameterPx(30));
    expect(clusterDiameterPx(30)).toBeLessThan(clusterDiameterPx(300));
  });

  it('どんな件数でも上限を超えない', () => {
    expect(clusterDiameterPx(100_000)).toBe(clusterDiameterPx(300));
  });
});

describe('ClusterMarker', () => {
  it('件数を表示する', async () => {
    await render(
      <ClusterMarker center={CENTER} count={12} onPress={jest.fn()} testID="cluster-marker" />,
    );

    expect(screen.getByText('12')).toBeOnTheScreen();
  });

  it('タップすると中心座標を渡して呼ばれる', async () => {
    const handlePress = jest.fn();

    await render(
      <ClusterMarker center={CENTER} count={12} onPress={handlePress} testID="cluster-marker" />,
    );
    await fireEvent.press(screen.getByTestId('cluster-marker'));

    expect(handlePress).toHaveBeenCalledWith(CENTER);
  });

  it('スクリーンリーダーに件数を伝える', async () => {
    await render(
      <ClusterMarker center={CENTER} count={12} onPress={jest.fn()} testID="cluster-marker" />,
    );

    expect(screen.getByLabelText('このあたりに 12 件。タップで拡大')).toBeOnTheScreen();
  });

  it('件数に応じて円の大きさが変わる', async () => {
    await render(
      <ClusterMarker center={CENTER} count={300} onPress={jest.fn()} testID="cluster-marker" />,
    );

    expect(screen.getByTestId('cluster-marker-circle')).toHaveStyle({
      width: clusterDiameterPx(300),
    });
  });
});
```

Run: `npm test -w @meshimap/mobile -- cluster-marker`
Expected: FAIL（`Cannot find module './cluster-marker'`）

- [ ] **Step 2: cluster-marker.tsx を実装する**

```tsx
// apps/mobile/src/components/map/cluster-marker.tsx
import type { Coordinate } from '@meshimap/geo';
import { memo, useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Marker } from 'react-native-maps';

import { CLUSTER_LABEL_MAX_COUNT } from '@/constants/map';
import { COLORS, FONT_SIZES, RADIUS, Z_INDEX } from '@/constants/theme';

/** 件数の刻みと直径（px）。3 段階に絞って地図上の情報量を抑える */
const CLUSTER_SIZE_STEPS = [
  { maxCount: 9, diameterPx: 36 },
  { maxCount: 99, diameterPx: 46 },
] as const;

/** 100 件以上で使う直径 */
const CLUSTER_DIAMETER_MAX_PX = 56;

const OVERFLOW_LABEL_SUFFIX = '+';

export interface ClusterMarkerProps {
  center: Coordinate;
  count: number;
  onPress: (center: Coordinate) => void;
  testID?: string | undefined;
}

/** 円に収まる桁数に丸めたラベル */
export function clusterLabel(count: number): string {
  return count > CLUSTER_LABEL_MAX_COUNT
    ? `${CLUSTER_LABEL_MAX_COUNT}${OVERFLOW_LABEL_SUFFIX}`
    : String(count);
}

/** 件数に応じた円の直径。密集度が一目で分かるようにする */
export function clusterDiameterPx(count: number): number {
  for (const step of CLUSTER_SIZE_STEPS) {
    if (count <= step.maxCount) {
      return step.diameterPx;
    }
  }
  return CLUSTER_DIAMETER_MAX_PX;
}

function ClusterMarkerComponent({ center, count, onPress, testID }: ClusterMarkerProps) {
  const handlePress = useCallback(() => {
    onPress(center);
  }, [center, onPress]);

  const diameterPx = clusterDiameterPx(count);

  return (
    <Marker
      coordinate={{ latitude: center.latitude, longitude: center.longitude }}
      onPress={handlePress}
      zIndex={Z_INDEX.mapMarker}
      tracksViewChanges={false}
      accessibilityLabel={`このあたりに ${count} 件。タップで拡大`}
      testID={testID}
    >
      <View
        testID={testID === undefined ? undefined : `${testID}-circle`}
        style={[
          styles.circle,
          { width: diameterPx, height: diameterPx, borderRadius: RADIUS.pill },
        ]}
      >
        <Text style={styles.label}>{clusterLabel(count)}</Text>
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary[500],
    borderColor: COLORS.white,
    borderWidth: 2,
  },
  label: {
    color: COLORS.white,
    fontSize: FONT_SIZES.sm,
  },
});

export const ClusterMarker = memo(ClusterMarkerComponent);
```

Run: `npm test -w @meshimap/mobile -- cluster-marker`
Expected: PASS（7 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`clusterLabel` の丸め（`count > CLUSTER_LABEL_MAX_COUNT` の分岐）を外して `String(count)` だけにし、「100 件以上は 99+ にまとめる」が **FAIL** することを確認してから戻す。

- [ ] **Step 4: コミットする**

```bash
git add apps/mobile/src/components/map/cluster-marker.tsx apps/mobile/src/components/map/cluster-marker.test.tsx
git commit -m "feat(mobile): クラスタマーカーを追加する"
```

---

### Task 6-13: 「このエリアを再検索」ボタンを作る

**Files:**

- Create: `apps/mobile/src/components/map/search-this-area-button.tsx`
- Create: `apps/mobile/src/components/map/search-this-area-button.test.tsx`

**Interfaces:**

- Consumes: `@/components/ui/button` の `Button`、`@/components/ui/icon` の `Icon`、`lucide-react-native` の `RefreshCw`
- Produces: `SearchThisAreaButton` / 型 `SearchThisAreaButtonProps` / `SEARCH_THIS_AREA_LABEL`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/components/map/search-this-area-button.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { SEARCH_THIS_AREA_LABEL, SearchThisAreaButton } from './search-this-area-button';

describe('SearchThisAreaButton', () => {
  it('isVisible が false のときは何も描画しない', async () => {
    await render(
      <SearchThisAreaButton
        isVisible={false}
        isLoading={false}
        onPress={jest.fn()}
        testID="search-this-area"
      />,
    );

    expect(screen.queryByTestId('search-this-area')).toBeNull();
  });

  it('isVisible が true のときラベルを表示する', async () => {
    await render(
      <SearchThisAreaButton
        isVisible
        isLoading={false}
        onPress={jest.fn()}
        testID="search-this-area"
      />,
    );

    expect(screen.getByText(SEARCH_THIS_AREA_LABEL)).toBeOnTheScreen();
  });

  it('タップすると onPress が呼ばれる', async () => {
    const handlePress = jest.fn();

    await render(
      <SearchThisAreaButton
        isVisible
        isLoading={false}
        onPress={handlePress}
        testID="search-this-area"
      />,
    );
    await fireEvent.press(screen.getByTestId('search-this-area-button'));

    expect(handlePress).toHaveBeenCalledTimes(1);
  });

  it('読込中はインジケータを出して二重タップを防ぐ', async () => {
    const handlePress = jest.fn();

    await render(
      <SearchThisAreaButton isVisible isLoading onPress={handlePress} testID="search-this-area" />,
    );
    await fireEvent.press(screen.getByTestId('search-this-area-button'));

    expect(screen.getByTestId('search-this-area-button-indicator')).toBeOnTheScreen();
    expect(handlePress).not.toHaveBeenCalled();
  });
});
```

`Button` は `isLoading` のとき `onPress` を呼ばず、`${testID}-indicator` のインジケータを出す（Phase 0 の実装済み仕様）。

Run: `npm test -w @meshimap/mobile -- search-this-area-button`
Expected: FAIL（`Cannot find module './search-this-area-button'`）

- [ ] **Step 2: search-this-area-button.tsx を実装する**

```tsx
// apps/mobile/src/components/map/search-this-area-button.tsx
import { RefreshCw } from 'lucide-react-native';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { COLORS } from '@/constants/theme';

export const SEARCH_THIS_AREA_LABEL = 'このエリアを再検索';

export interface SearchThisAreaButtonProps {
  isVisible: boolean;
  isLoading: boolean;
  onPress: () => void;
  testID?: string | undefined;
}

/**
 * 地図の上に重ねる再検索ボタン。
 * 表示・非表示の判定は useSearchThisArea が持ち、ここは見た目だけを担う。
 */
export function SearchThisAreaButton({
  isVisible,
  isLoading,
  onPress,
  testID,
}: SearchThisAreaButtonProps) {
  if (!isVisible) {
    return null;
  }

  return (
    // 地図の上に重ねるため absolute。z は mapOverlayButton でマーカーより手前に置く
    <View
      testID={testID}
      className="absolute left-0 right-0 top-md z-mapOverlayButton items-center"
    >
      <Button
        label={SEARCH_THIS_AREA_LABEL}
        onPress={onPress}
        variant="primary"
        size="sm"
        isLoading={isLoading}
        leadingIcon={<Icon icon={RefreshCw} size="sm" color={COLORS.white} />}
        testID={testID === undefined ? undefined : `${testID}-button`}
      />
    </View>
  );
}
```

Run: `npm test -w @meshimap/mobile -- search-this-area-button`
Expected: PASS（4 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`if (!isVisible) return null;` を削除して「isVisible が false のときは何も描画しない」が **FAIL** することを確認してから戻す。

- [ ] **Step 4: コミットする**

```bash
git add apps/mobile/src/components/map/search-this-area-button.tsx apps/mobile/src/components/map/search-this-area-button.test.tsx
git commit -m "feat(mobile): このエリアを再検索ボタンを追加する"
```

---

### Task 6-14: 営業状態バッジと営業状態の算出を作る

**Files:**

- Create: `apps/mobile/src/lib/shop-open-status.ts`
- Create: `apps/mobile/src/lib/shop-open-status.test.ts`
- Create: `apps/mobile/src/components/shop/open-status-badge.tsx`
- Create: `apps/mobile/src/components/shop/open-status-badge.test.tsx`

**Interfaces:**

- Consumes: `@meshimap/core` の `getOpenStatus` / `minutesUntilClose` / `businessHoursOn` / `formatBusinessHours` / `toJstClock` / 型 `OpenStatus` `BusinessHours`、`@/components/ui/badge` の `Badge` / 型 `BadgeTone`、`@/components/ui/icon` の `Icon`、`lucide-react-native` の `Clock`
- Produces:
  - `shopOpenStatus(detail: ShopDetail, now: Date): OpenStatus`
  - `shopClosesInMinutes(detail: ShopDetail, now: Date): number | null`
  - `todayBusinessHoursLabel(detail: ShopDetail, now: Date): string`
  - `OpenStatusBadge` / 型 `OpenStatusBadgeProps`
  - `OPEN_STATUS_LABELS: Record<OpenStatus, string>`

- [ ] **Step 1: 失敗するテストを書く（営業状態の算出）**

`packages/core` の `getOpenStatus` は `(hours, closures, now)` の 3 引数で、`ShopDetail` を直接受け取らない。画面から毎回 3 つに分解して渡すのは呼び出し側の責務が増えるので、`ShopDetail` を受け取る薄い層をモバイル側に置く。

```ts
// apps/mobile/src/lib/shop-open-status.test.ts
import { buildShopDetail } from '@/test-support/shop-fixtures';

import { shopClosesInMinutes, shopOpenStatus, todayBusinessHoursLabel } from './shop-open-status';

/**
 * 2026-09-15 は火曜日。JST で組み立てるため UTC からは 9 時間引く。
 * 例: JST 19:00 → UTC 10:00
 */
function jst(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 8, 15, hour - 9, minute));
}

/** 火曜（dayOfWeek = 2）の 17:00 - 翌 1:00 営業 */
const TUESDAY_HOURS = [
  { dayOfWeek: 2, openMinute: 1020, closeMinute: 1500, isClosed: false },
] as const;

describe('shopOpenStatus', () => {
  it('営業時間の真ん中は open', () => {
    const detail = buildShopDetail({ hours: [...TUESDAY_HOURS] });

    expect(shopOpenStatus(detail, jst(19, 0))).toBe('open');
  });

  it('閉店 30 分以内は closing-soon', () => {
    const detail = buildShopDetail({ hours: [...TUESDAY_HOURS] });

    // 閉店は翌 1:00（1500 分）。JST 0:40 は「前日から続く日跨ぎ分」として 1480 分に相当
    expect(shopOpenStatus(detail, new Date(Date.UTC(2026, 8, 15, 15, 40)))).toBe('closing-soon');
  });

  it('営業時間外は closed', () => {
    const detail = buildShopDetail({ hours: [...TUESDAY_HOURS] });

    expect(shopOpenStatus(detail, jst(10, 0))).toBe('closed');
  });

  it('その曜日の営業行が無ければ regular-holiday', () => {
    const detail = buildShopDetail({ hours: [] });

    expect(shopOpenStatus(detail, jst(19, 0))).toBe('regular-holiday');
  });

  it('臨時休業日は closed', () => {
    const detail = buildShopDetail({
      hours: [...TUESDAY_HOURS],
      closures: [{ date: '2026-09-15', reason: '設備点検' }],
    });

    expect(shopOpenStatus(detail, jst(19, 0))).toBe('closed');
  });
});

describe('shopClosesInMinutes', () => {
  it('営業中なら閉店までの分を返す', () => {
    const detail = buildShopDetail({ hours: [...TUESDAY_HOURS] });

    // 19:00（1140 分）から閉店 1500 分まで 360 分
    expect(shopClosesInMinutes(detail, jst(19, 0))).toBe(360);
  });

  it('営業時間外なら null', () => {
    const detail = buildShopDetail({ hours: [...TUESDAY_HOURS] });

    expect(shopClosesInMinutes(detail, jst(10, 0))).toBeNull();
  });
});

describe('todayBusinessHoursLabel', () => {
  it('その日の営業時間を整形して返す', () => {
    const detail = buildShopDetail({ hours: [...TUESDAY_HOURS] });

    expect(todayBusinessHoursLabel(detail, jst(19, 0))).toBe('17:00 - 翌 1:00');
  });

  it('営業行が無い曜日は定休日と表示する', () => {
    const detail = buildShopDetail({ hours: [] });

    expect(todayBusinessHoursLabel(detail, jst(19, 0))).toBe('定休日');
  });
});
```

`buildShopDetail` は Task 6-9 で作った素の JSON を `shopDetailSchema.parse` に通すフィクスチャなので、
`hours` や `closures` はブランド型ではなく API と同じ素の形で上書きできる。

Run: `npm test -w @meshimap/mobile -- shop-open-status`
Expected: FAIL（`Cannot find module './shop-open-status'`）

- [ ] **Step 2: shop-open-status.ts を実装する**

```ts
// apps/mobile/src/lib/shop-open-status.ts
import {
  businessHoursOn,
  formatBusinessHours,
  getOpenStatus,
  minutesUntilClose,
  toJstClock,
} from '@meshimap/core';
import type { OpenStatus } from '@meshimap/core';

import type { ShopDetail } from '@/features/shops/schema';

/**
 * 店舗詳細から営業状態を出す。
 * core の関数は（営業時間, 臨時休業, 現在時刻）の 3 引数なので、
 * 画面のたびに分解して渡さなくて済むようここで束ねる。
 */
export function shopOpenStatus(detail: ShopDetail, now: Date): OpenStatus {
  return getOpenStatus(detail.hours, detail.closures, now);
}

/** 閉店までの残り分。営業時間外なら null */
export function shopClosesInMinutes(detail: ShopDetail, now: Date): number | null {
  return minutesUntilClose(detail.hours, detail.closures, now);
}

/** 「今日の営業時間」の表示用文字列。営業行が無い曜日は「定休日」になる */
export function todayBusinessHoursLabel(detail: ShopDetail, now: Date): string {
  const clock = toJstClock(now);
  return formatBusinessHours(businessHoursOn(detail.hours, clock.dayOfWeek));
}
```

Run: `npm test -w @meshimap/mobile -- shop-open-status`
Expected: PASS（9 件）

- [ ] **Step 3: 失敗するテストを書く（バッジ）**

```tsx
// apps/mobile/src/components/shop/open-status-badge.test.tsx
import type { OpenStatus } from '@meshimap/core';
import { render, screen } from '@testing-library/react-native';

import { OPEN_STATUS_LABELS, OpenStatusBadge } from './open-status-badge';

/** 網羅漏れを型で検出するため、Record のキーとして全ステータスを列挙する */
const ALL_STATUSES = Object.keys({
  open: true,
  'closing-soon': true,
  closed: true,
  'regular-holiday': true,
} satisfies Record<OpenStatus, true>) as OpenStatus[];

/** NativeWind はテスト環境で className を style に変換しないため、props から直接読める */
function getClassName(testID: string): string {
  const { className } = screen.getByTestId(testID).props;
  return typeof className === 'string' ? className : '';
}

describe('OpenStatusBadge', () => {
  it('4 つのステータスすべてに日本語ラベルがある', async () => {
    await render(
      <>
        {ALL_STATUSES.map((status) => (
          <OpenStatusBadge key={status} status={status} testID={`badge-${status}`} />
        ))}
      </>,
    );

    for (const status of ALL_STATUSES) {
      expect(screen.getByText(OPEN_STATUS_LABELS[status])).toBeOnTheScreen();
    }
  });

  it('営業中は緑系、まもなく閉店は琥珀系の背景になる', async () => {
    await render(
      <>
        <OpenStatusBadge status="open" testID="badge-open" />
        <OpenStatusBadge status="closing-soon" testID="badge-closing-soon" />
      </>,
    );

    expect(getClassName('badge-open')).toContain('bg-green-50');
    expect(getClassName('badge-closing-soon')).toContain('bg-amber-50');
  });

  it('営業時間外と本日定休は中立色になる', async () => {
    await render(
      <>
        <OpenStatusBadge status="closed" testID="badge-closed" />
        <OpenStatusBadge status="regular-holiday" testID="badge-regular-holiday" />
      </>,
    );

    expect(getClassName('badge-closed')).toContain('bg-neutral-100');
    expect(getClassName('badge-regular-holiday')).toContain('bg-neutral-100');
  });

  it('閉店までの残り分を渡すとラベルに時間が入る', async () => {
    await render(<OpenStatusBadge status="closing-soon" closesInMinutes={20} testID="badge" />);

    expect(screen.getByText('あと 20 分で閉店')).toBeOnTheScreen();
  });

  it('営業中に残り分を渡してもラベルは変えない', async () => {
    // 「あと 300 分で閉店」は情報として役に立たない。closing-soon のときだけ出す
    await render(<OpenStatusBadge status="open" closesInMinutes={300} testID="badge" />);

    expect(screen.getByText('営業中')).toBeOnTheScreen();
  });

  it('時計アイコンを添える', async () => {
    await render(<OpenStatusBadge status="open" testID="badge" />);

    expect(screen.getByTestId('badge-leading-icon')).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- open-status-badge`
Expected: FAIL（`Cannot find module './open-status-badge'`）

- [ ] **Step 4: open-status-badge.tsx を実装する**

```tsx
// apps/mobile/src/components/shop/open-status-badge.tsx
import type { OpenStatus } from '@meshimap/core';
import { Clock } from 'lucide-react-native';

import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { SEMANTIC_COLORS } from '@/constants/theme';

/**
 * ステータスごとの日本語ラベル。
 * `Record<OpenStatus, string>` にしているので、core が OpenStatus を増やすと
 * ここがコンパイルエラーになり、文言の付け忘れに必ず気づける。
 */
export const OPEN_STATUS_LABELS: Record<OpenStatus, string> = {
  open: '営業中',
  'closing-soon': 'まもなく閉店',
  closed: '営業時間外',
  'regular-holiday': '本日定休',
};

const OPEN_STATUS_TONES: Record<OpenStatus, BadgeTone> = {
  open: 'success',
  'closing-soon': 'warning',
  closed: 'neutral',
  'regular-holiday': 'neutral',
};

const OPEN_STATUS_ICON_COLORS: Record<OpenStatus, string> = {
  open: SEMANTIC_COLORS.open,
  'closing-soon': SEMANTIC_COLORS.closingSoon,
  closed: SEMANTIC_COLORS.closed,
  'regular-holiday': SEMANTIC_COLORS.regularHoliday,
};

const CLOSING_SOON_LABEL_PREFIX = 'あと ';
const CLOSING_SOON_LABEL_SUFFIX = ' 分で閉店';

export interface OpenStatusBadgeProps {
  status: OpenStatus;
  /** 閉店までの残り分。まもなく閉店のときだけラベルに反映する */
  closesInMinutes?: number | null | undefined;
  testID?: string | undefined;
}

/** まもなく閉店のときだけ残り分を出す。営業中の「あと 300 分」は情報にならない */
function buildLabel(status: OpenStatus, closesInMinutes: number | null | undefined): string {
  if (status === 'closing-soon' && typeof closesInMinutes === 'number') {
    return `${CLOSING_SOON_LABEL_PREFIX}${closesInMinutes}${CLOSING_SOON_LABEL_SUFFIX}`;
  }
  return OPEN_STATUS_LABELS[status];
}

export function OpenStatusBadge({ status, closesInMinutes, testID }: OpenStatusBadgeProps) {
  return (
    <Badge
      label={buildLabel(status, closesInMinutes)}
      tone={OPEN_STATUS_TONES[status]}
      leadingIcon={<Icon icon={Clock} size="sm" color={OPEN_STATUS_ICON_COLORS[status]} />}
      testID={testID}
    />
  );
}
```

Run: `npm test -w @meshimap/mobile -- open-status-badge`
Expected: PASS（6 件）

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`OPEN_STATUS_TONES` の `'closing-soon'` を `'success'` に変え、「営業中は緑系、まもなく閉店は琥珀系の背景になる」が **FAIL** することを確認してから戻す。次に `buildLabel` の `status === 'closing-soon'` の条件を外し、「営業中に残り分を渡してもラベルは変えない」が **FAIL** することも確認する。

- [ ] **Step 6: コミットする**

```bash
git add apps/mobile/src/lib/shop-open-status.ts apps/mobile/src/lib/shop-open-status.test.ts apps/mobile/src/components/shop/open-status-badge.tsx apps/mobile/src/components/shop/open-status-badge.test.tsx apps/mobile/src/test-support/shop-fixtures.ts
git commit -m "feat(mobile): 営業状態の算出とバッジを追加する"
```

---

### Task 6-15: 店舗カードを作る

**Files:**

- Create: `apps/mobile/src/components/shop/shop-card.tsx`
- Create: `apps/mobile/src/components/shop/shop-card.test.tsx`

**Interfaces:**

- Consumes: `@meshimap/core` の `formatBudgetRange` / `BUDGET_UNSET_LABEL`、`@meshimap/geo` の `formatDistance`、`@/components/ui/card` の `Card`、`@/components/shop/open-status-badge` の `OpenStatusBadge`、`expo-image` の `Image`、`lucide-react-native` の `Star` `ImageOff`
- Produces:
  - `ShopCard`（`memo` 済み） / 型 `ShopCardProps`
  - `SHOP_CARD_HEIGHT_PX: number`
  - `SHOP_CARD_GAP_PX: number`
  - `SHOP_CARD_ROW_HEIGHT_PX: number`（= 高さ + 余白。`getItemLayout` に使う）
  - `ratingLabel(shop: ShopSummary): string`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/components/shop/shop-card.test.tsx
import { toShopId } from '@meshimap/core';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { buildShopSummary } from '@/test-support/shop-fixtures';

import {
  SHOP_CARD_GAP_PX,
  SHOP_CARD_HEIGHT_PX,
  SHOP_CARD_ROW_HEIGHT_PX,
  ShopCard,
  ratingLabel,
} from './shop-card';

describe('ratingLabel', () => {
  it('評価と件数を並べる', () => {
    expect(ratingLabel(buildShopSummary({ ratingAverage: 4.2, ratingCount: 128 }))).toBe(
      '4.2（128件）',
    );
  });

  it('評価が 0 件なら「評価なし」', () => {
    // 0.0 と表示すると「最低評価の店」に見えてしまう
    expect(ratingLabel(buildShopSummary({ ratingAverage: 0, ratingCount: 0 }))).toBe('評価なし');
  });
});

describe('SHOP_CARD_ROW_HEIGHT_PX', () => {
  it('カード高さと余白の合計になっている', () => {
    // getItemLayout がこの値に依存するため、ずれるとスクロール位置が狂う
    expect(SHOP_CARD_ROW_HEIGHT_PX).toBe(SHOP_CARD_HEIGHT_PX + SHOP_CARD_GAP_PX);
  });
});

describe('ShopCard', () => {
  it('店名・ジャンル・エリアを表示する', async () => {
    await render(
      <ShopCard
        shop={buildShopSummary()}
        distanceM={null}
        isSelected={false}
        onPress={jest.fn()}
        testID="shop-card"
      />,
    );

    expect(screen.getByText('炭火焼鳥 とりまる')).toBeOnTheScreen();
    expect(screen.getByText('焼き鳥・渋谷')).toBeOnTheScreen();
  });

  it('営業状態バッジを表示する', async () => {
    await render(
      <ShopCard
        shop={buildShopSummary({ openStatus: 'regular-holiday' })}
        distanceM={null}
        isSelected={false}
        onPress={jest.fn()}
        testID="shop-card"
      />,
    );

    expect(screen.getByText('本日定休')).toBeOnTheScreen();
  });

  it('距離を渡すと m / km 表記で表示する', async () => {
    await render(
      <ShopCard
        shop={buildShopSummary()}
        distanceM={1500}
        isSelected={false}
        onPress={jest.fn()}
        testID="shop-card"
      />,
    );

    expect(screen.getByText('1.5km')).toBeOnTheScreen();
  });

  it('距離が null のときは距離を出さない', async () => {
    // 位置情報が許可されていないときに「0m」と出すと嘘になる
    await render(
      <ShopCard
        shop={buildShopSummary()}
        distanceM={null}
        isSelected={false}
        onPress={jest.fn()}
        testID="shop-card"
      />,
    );

    expect(screen.queryByTestId('shop-card-distance')).toBeNull();
  });

  it('予算帯を表示する', async () => {
    await render(
      <ShopCard
        shop={buildShopSummary()}
        distanceM={null}
        isSelected={false}
        onPress={jest.fn()}
        testID="shop-card"
      />,
    );

    expect(screen.getByText('¥3,000 〜 ¥4,999')).toBeOnTheScreen();
  });

  it('カバー写真が無いときはプレースホルダを出す', async () => {
    await render(
      <ShopCard
        shop={buildShopSummary({ coverPhotoUrl: null })}
        distanceM={null}
        isSelected={false}
        onPress={jest.fn()}
        testID="shop-card"
      />,
    );

    expect(screen.queryByTestId('shop-card-cover')).toBeNull();
    expect(screen.getByTestId('shop-card-cover-placeholder')).toBeOnTheScreen();
  });

  it('タップすると店舗 ID を渡して呼ばれる', async () => {
    const handlePress = jest.fn();
    const shop = buildShopSummary({ id: toShopId('shop-777') });

    await render(
      <ShopCard
        shop={shop}
        distanceM={null}
        isSelected={false}
        onPress={handlePress}
        testID="shop-card"
      />,
    );
    await fireEvent.press(screen.getByTestId('shop-card'));

    expect(handlePress).toHaveBeenCalledWith(shop.id);
  });

  it('選択中は枠線が強調される', async () => {
    await render(
      <ShopCard
        shop={buildShopSummary()}
        distanceM={null}
        isSelected
        onPress={jest.fn()}
        testID="shop-card"
      />,
    );

    expect(screen.getByTestId('shop-card-frame')).toHaveStyle({ borderWidth: 2 });
  });

  it('非選択のときは枠線を出さない', async () => {
    await render(
      <ShopCard
        shop={buildShopSummary()}
        distanceM={null}
        isSelected={false}
        onPress={jest.fn()}
        testID="shop-card"
      />,
    );

    expect(screen.getByTestId('shop-card-frame')).toHaveStyle({ borderWidth: 0 });
  });

  it('スクリーンリーダーに 1 枚ぶんの情報をまとめて伝える', async () => {
    await render(
      <ShopCard
        shop={buildShopSummary()}
        distanceM={1500}
        isSelected={false}
        onPress={jest.fn()}
        testID="shop-card"
      />,
    );

    expect(
      screen.getByLabelText('炭火焼鳥 とりまる。焼き鳥・渋谷。営業中。評価 4.2（128件）。1.5km'),
    ).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- shop-card`
Expected: FAIL（`Cannot find module './shop-card'`）

- [ ] **Step 2: shop-card.tsx を実装する**

`Card` は `className` を受け取らない設計なので、選択中の枠線は内側の `View` に `style` で持たせる。`expo-image` の `Image` も NativeWind に登録されていないため `style` を使う。

```tsx
// apps/mobile/src/components/shop/shop-card.tsx
import { formatBudgetRange } from '@meshimap/core';
import type { ShopId } from '@meshimap/core';
import { formatDistance } from '@meshimap/geo';
import { Image } from 'expo-image';
import { ImageOff, Star } from 'lucide-react-native';
import { memo, useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { OpenStatusBadge, OPEN_STATUS_LABELS } from '@/components/shop/open-status-badge';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { COLORS, RADIUS, SEMANTIC_COLORS, SPACING } from '@/constants/theme';
import type { ShopSummary } from '@/features/shops/schema';

/** カード 1 枚の高さ（px）。getItemLayout で使うので必ず固定にする */
export const SHOP_CARD_HEIGHT_PX = 104;

/** カード同士の縦の間隔（px） */
export const SHOP_CARD_GAP_PX = SPACING.sm;

/** リストの 1 行ぶんの高さ。getItemLayout の length / offset の計算元 */
export const SHOP_CARD_ROW_HEIGHT_PX = SHOP_CARD_HEIGHT_PX + SHOP_CARD_GAP_PX;

/** カバー写真の 1 辺（px）。正方形にしてカードの高さに合わせる */
const COVER_SIZE_PX = SHOP_CARD_HEIGHT_PX;

/** 評価が 0 件のときの表示。0.0 と出すと最低評価の店に見える */
const RATING_UNSET_LABEL = '評価なし';

const RATING_COUNT_PREFIX = '（';
const RATING_COUNT_SUFFIX = '件）';

/** ジャンルとエリアの区切り */
const GENRE_AREA_SEPARATOR = '・';

/** 読み上げラベルの区切り。句点で一拍置かせる */
const ACCESSIBILITY_LABEL_SEPARATOR = '。';

const RATING_ACCESSIBILITY_PREFIX = '評価 ';

/** 画像の差し替えアニメーションの長さ（ms）。0 だとちらつく */
const IMAGE_TRANSITION_MS = 150;

export interface ShopCardProps {
  shop: ShopSummary;
  /** 現在地からの距離（m）。位置情報が使えないときは null を渡す */
  distanceM: number | null;
  isSelected: boolean;
  onPress: (shopId: ShopId) => void;
  testID?: string | undefined;
}

/** 「4.2（128件）」。0 件なら「評価なし」 */
export function ratingLabel(shop: ShopSummary): string {
  if (shop.ratingCount === 0) {
    return RATING_UNSET_LABEL;
  }
  return `${shop.ratingAverage.toFixed(1)}${RATING_COUNT_PREFIX}${shop.ratingCount}${RATING_COUNT_SUFFIX}`;
}

/** カード 1 枚ぶんの情報を 1 つの読み上げ単位にまとめる */
function buildAccessibilityLabel(shop: ShopSummary, distanceM: number | null): string {
  const parts = [
    shop.name,
    `${shop.genreName}${GENRE_AREA_SEPARATOR}${shop.areaName}`,
    OPEN_STATUS_LABELS[shop.openStatus],
    `${RATING_ACCESSIBILITY_PREFIX}${ratingLabel(shop)}`,
  ];
  if (distanceM !== null) {
    parts.push(formatDistance(distanceM));
  }
  return parts.join(ACCESSIBILITY_LABEL_SEPARATOR);
}

function ShopCardComponent({ shop, distanceM, isSelected, onPress, testID }: ShopCardProps) {
  const handlePress = useCallback(() => {
    onPress(shop.id);
  }, [onPress, shop.id]);

  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  return (
    <Card onPress={handlePress} padding="none" testID={testID}>
      {/*
        選択中の枠線。Card 自体は className で border-neutral-200 を持つので、
        重ねて描くと二重線になる。内側の View に style で持たせて塗り分ける。
      */}
      <View
        testID={childTestId('frame')}
        accessible
        accessibilityLabel={buildAccessibilityLabel(shop, distanceM)}
        style={[styles.frame, isSelected ? styles.frameSelected : styles.frameDefault]}
      >
        {shop.coverPhotoUrl === null ? (
          <View testID={childTestId('cover-placeholder')} style={styles.coverPlaceholder}>
            <Icon icon={ImageOff} size="lg" color={COLORS.neutral[400]} />
          </View>
        ) : (
          <Image
            testID={childTestId('cover')}
            source={shop.coverPhotoUrl}
            contentFit="cover"
            transition={IMAGE_TRANSITION_MS}
            style={styles.cover}
          />
        )}

        <View style={styles.body}>
          <Text numberOfLines={1} className="font-body-bold text-base text-neutral-900">
            {shop.name}
          </Text>
          <Text numberOfLines={1} className="font-body text-xs text-neutral-600">
            {`${shop.genreName}${GENRE_AREA_SEPARATOR}${shop.areaName}`}
          </Text>

          <View style={styles.metaRow}>
            <Icon icon={Star} size="sm" color={SEMANTIC_COLORS.rating} />
            <Text className="font-body-medium text-xs text-neutral-800">{ratingLabel(shop)}</Text>
            {distanceM === null ? null : (
              <Text testID={childTestId('distance')} className="font-body text-xs text-neutral-600">
                {formatDistance(distanceM)}
              </Text>
            )}
          </View>

          <View style={styles.metaRow}>
            <OpenStatusBadge status={shop.openStatus} testID={childTestId('open-status')} />
            <Text className="font-body text-xs text-neutral-600">
              {formatBudgetRange(shop.budgetDinnerMinYen, shop.budgetDinnerMaxYen)}
            </Text>
          </View>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  frame: {
    flexDirection: 'row',
    height: SHOP_CARD_HEIGHT_PX,
    overflow: 'hidden',
    borderRadius: RADIUS.card,
  },
  frameDefault: {
    borderWidth: 0,
    borderColor: 'transparent',
  },
  frameSelected: {
    borderWidth: 2,
    borderColor: COLORS.primary[500],
  },
  cover: {
    width: COVER_SIZE_PX,
    height: COVER_SIZE_PX,
  },
  coverPlaceholder: {
    width: COVER_SIZE_PX,
    height: COVER_SIZE_PX,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.neutral[100],
  },
  body: {
    flex: 1,
    justifyContent: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.sm,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
});

/**
 * 200 件ぶんのカードが親の再レンダリングで作り直されるのを防ぐ。
 * distanceM は数値、onPress は useCallback なので既定の浅い比較で足りる。
 */
export const ShopCard = memo(ShopCardComponent);
```

Run: `npm test -w @meshimap/mobile -- shop-card`
Expected: PASS（13 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`ratingLabel` の `shop.ratingCount === 0` の分岐を削除し、「評価が 0 件なら『評価なし』」が **FAIL** することを確認してから戻す。次に `SHOP_CARD_ROW_HEIGHT_PX` を `SHOP_CARD_HEIGHT_PX` だけにして、「カード高さと余白の合計になっている」が **FAIL** することも確認する。

- [ ] **Step 4: コミットする**

```bash
git add apps/mobile/src/components/shop/shop-card.tsx apps/mobile/src/components/shop/shop-card.test.tsx
git commit -m "feat(mobile): 店舗カードを追加する"
```

---

### Task 6-16: 地図のボトムシートを作る

**Files:**

- Create: `apps/mobile/src/components/map/map-bottom-sheet.tsx`
- Create: `apps/mobile/src/components/map/map-bottom-sheet.test.tsx`

**Interfaces:**

- Consumes: `@gorhom/bottom-sheet` の `default`（`BottomSheet`）/ `BottomSheetFlatList` / `BottomSheetView` / 型 `BottomSheetFlatListMethods`、`@meshimap/geo` の `distanceMeters` / 型 `Coordinate`、`@/components/shop/shop-card`、`@/components/ui/skeleton` `empty-state` `error-state`、`@/constants/map` の `BOTTOM_SHEET_SNAP_POINTS` / `BOTTOM_SHEET_INDEX_PEEK` / `BOTTOM_SHEET_INDEX_HALF`
- Produces:
  - `MapBottomSheet` / 型 `MapBottomSheetProps`
  - `indexOfShop(shops: readonly ShopSummary[], shopId: ShopId | null): number`
  - `shopDistanceM(shop: ShopSummary, center: Coordinate | null): number | null`
  - `resultCountLabel(count: number): string`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/components/map/map-bottom-sheet.test.tsx
import { toShopId } from '@meshimap/core';
import { coordinate } from '@meshimap/geo';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { FlatList } from 'react-native';

import type { ShopSummary } from '@/features/shops/schema';
import { buildShopSummary } from '@/test-support/shop-fixtures';

import { MapBottomSheet, indexOfShop, resultCountLabel, shopDistanceM } from './map-bottom-sheet';

const SHIBUYA = coordinate(35.658034, 139.701636);

const SHOPS = [
  buildShopSummary({ id: toShopId('shop-a'), name: 'A 亭' }),
  buildShopSummary({
    id: toShopId('shop-b'),
    name: 'B 亭',
    latitude: 35.62876,
    longitude: 139.73876,
  }),
  buildShopSummary({ id: toShopId('shop-c'), name: 'C 亭' }),
];

/** noUncheckedIndexedAccess のため SHOPS[0] は undefined 込みの型になる。取り出しを一箇所に閉じる */
function firstShop(): ShopSummary {
  const [shop] = SHOPS;
  if (shop === undefined) {
    throw new Error('テスト用の店舗一覧が空です');
  }
  return shop;
}

describe('indexOfShop', () => {
  it('該当する店舗の位置を返す', () => {
    expect(indexOfShop(SHOPS, toShopId('shop-c'))).toBe(2);
  });

  it('選択中の店舗が無ければ -1', () => {
    expect(indexOfShop(SHOPS, null)).toBe(-1);
  });

  it('一覧に含まれない店舗なら -1', () => {
    // 表示範囲外へ出た店を選んだままスクロールすると scrollToIndex が例外を投げるため、
    // -1 を返して呼び出し側でスクロールを止める
    expect(indexOfShop(SHOPS, toShopId('shop-zzz'))).toBe(-1);
  });
});

describe('shopDistanceM', () => {
  it('現在地があれば距離を返す', () => {
    expect(shopDistanceM(firstShop(), SHIBUYA)).toBeCloseTo(0, 0);
  });

  it('現在地が無ければ null', () => {
    expect(shopDistanceM(firstShop(), null)).toBeNull();
  });
});

describe('resultCountLabel', () => {
  it('件数を日本語で表す', () => {
    expect(resultCountLabel(12)).toBe('この範囲に 12 件');
  });

  it('0 件でも文言が崩れない', () => {
    expect(resultCountLabel(0)).toBe('この範囲に 0 件');
  });
});

describe('MapBottomSheet', () => {
  const baseProps = {
    shops: SHOPS,
    selectedShopId: null,
    currentCenter: SHIBUYA,
    onSelectShop: jest.fn(),
    onRetry: jest.fn(),
    testID: 'map-sheet',
  } as const;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('読み込み中はスケルトンを出す', async () => {
    await render(<MapBottomSheet {...baseProps} shops={[]} status="loading" />);

    expect(screen.getByTestId('map-sheet-skeleton')).toBeOnTheScreen();
    expect(screen.queryByTestId('map-sheet-list')).toBeNull();
  });

  it('エラー時は再試行ボタンを出す', async () => {
    const handleRetry = jest.fn();

    await render(<MapBottomSheet {...baseProps} shops={[]} status="error" onRetry={handleRetry} />);
    await fireEvent.press(screen.getByTestId('map-sheet-error-retry-button'));

    expect(handleRetry).toHaveBeenCalledTimes(1);
  });

  it('0 件のときは空状態を出す', async () => {
    await render(<MapBottomSheet {...baseProps} shops={[]} status="success" />);

    expect(screen.getByTestId('map-sheet-empty')).toBeOnTheScreen();
    expect(screen.getByText('この範囲にお店が見つかりませんでした')).toBeOnTheScreen();
  });

  it('件数の見出しを出す', async () => {
    await render(<MapBottomSheet {...baseProps} status="success" />);

    expect(screen.getByText('この範囲に 3 件')).toBeOnTheScreen();
  });

  it('店舗ぶんのカードを並べる', async () => {
    await render(<MapBottomSheet {...baseProps} status="success" />);

    expect(screen.getByText('A 亭')).toBeOnTheScreen();
    expect(screen.getByText('B 亭')).toBeOnTheScreen();
  });

  it('カードをタップすると店舗 ID を渡して呼ばれる', async () => {
    const handleSelect = jest.fn();

    await render(<MapBottomSheet {...baseProps} status="success" onSelectShop={handleSelect} />);
    await fireEvent.press(screen.getByTestId('map-sheet-card-shop-b'));

    expect(handleSelect).toHaveBeenCalledWith(toShopId('shop-b'));
  });

  it('getItemLayout が固定行高で offset を返す', async () => {
    await render(<MapBottomSheet {...baseProps} status="success" />);

    const { getItemLayout } = screen.getByTestId('map-sheet-list').props;
    expect(getItemLayout(SHOPS, 2)).toEqual({ length: 112, offset: 224, index: 2 });
  });

  it('選択中の店舗があるとその行までスクロールする', async () => {
    // 公式モックは BottomSheetFlatList を RN の FlatList（クラスコンポーネント）に差し替えるので、
    // prototype を spy すれば実際の scrollToIndex 呼び出しを観測できる
    const scrollToIndexSpy = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    await render(
      <MapBottomSheet {...baseProps} status="success" selectedShopId={toShopId('shop-c')} />,
    );

    expect(scrollToIndexSpy).toHaveBeenCalledWith({ index: 2, animated: true, viewPosition: 0 });
    scrollToIndexSpy.mockRestore();
  });

  it('一覧に無い店舗が選ばれてもスクロールしない', async () => {
    const scrollToIndexSpy = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    await render(
      <MapBottomSheet {...baseProps} status="success" selectedShopId={toShopId('shop-zzz')} />,
    );

    expect(scrollToIndexSpy).not.toHaveBeenCalled();
    scrollToIndexSpy.mockRestore();
  });
});
```

Run: `npm test -w @meshimap/mobile -- map-bottom-sheet`
Expected: FAIL（`Cannot find module './map-bottom-sheet'`）

- [ ] **Step 2: map-bottom-sheet.tsx を実装する**

```tsx
// apps/mobile/src/components/map/map-bottom-sheet.tsx
import BottomSheet, { BottomSheetFlatList, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetFlatListMethods } from '@gorhom/bottom-sheet';
import type { ShopId } from '@meshimap/core';
import { distanceMeters } from '@meshimap/geo';
import type { Coordinate } from '@meshimap/geo';
import { MapPinOff } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';

import { SHOP_CARD_ROW_HEIGHT_PX, ShopCard } from '@/components/shop/shop-card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { BOTTOM_SHEET_INDEX_PEEK, BOTTOM_SHEET_SNAP_POINTS } from '@/constants/map';
import { SPACING } from '@/constants/theme';
import { shopCoordinate } from '@/features/shops/schema';
import type { ShopSummary } from '@/features/shops/schema';
import type { NearbyShopsStatus } from '@/features/shops/use-nearby-shops';

/** 一覧に無い店舗が選ばれていることを表す番兵。FlatList の index と衝突しない値 */
const INDEX_NOT_FOUND = -1;

/** 読み込み中に出すスケルトンの枚数。シートの half スナップに収まる枚数 */
const SKELETON_COUNT = 3;

const RESULT_COUNT_PREFIX = 'この範囲に ';
const RESULT_COUNT_SUFFIX = ' 件';

const EMPTY_TITLE = 'この範囲にお店が見つかりませんでした';
const EMPTY_DESCRIPTION = '地図を動かすか、条件を緩めて探してみてください。';
const ERROR_TITLE = 'お店を取得できませんでした';
const ERROR_DESCRIPTION = '通信状況を確認して、もう一度お試しください。';

export interface MapBottomSheetProps {
  shops: readonly ShopSummary[];
  status: NearbyShopsStatus;
  selectedShopId: ShopId | null;
  /** 距離表示の基準。位置情報が使えないときは null */
  currentCenter: Coordinate | null;
  onSelectShop: (shopId: ShopId) => void;
  onRetry: () => void;
  testID?: string | undefined;
}

/** 選択中の店舗が一覧の何番目か。見つからなければ -1 */
export function indexOfShop(shops: readonly ShopSummary[], shopId: ShopId | null): number {
  if (shopId === null) {
    return INDEX_NOT_FOUND;
  }
  return shops.findIndex((shop) => shop.id === shopId);
}

/** 現在地からの距離。現在地が無ければ null（カード側で距離行を消す） */
export function shopDistanceM(shop: ShopSummary, center: Coordinate | null): number | null {
  return center === null ? null : distanceMeters(center, shopCoordinate(shop));
}

export function resultCountLabel(count: number): string {
  return `${RESULT_COUNT_PREFIX}${count}${RESULT_COUNT_SUFFIX}`;
}

export function MapBottomSheet({
  shops,
  status,
  selectedShopId,
  currentCenter,
  onSelectShop,
  onRetry,
  testID,
}: MapBottomSheetProps) {
  const listRef = useRef<BottomSheetFlatListMethods>(null);
  const selectedIndex = indexOfShop(shops, selectedShopId);

  // ピンをタップしたとき、シート内の該当カードまで送る。
  // 一覧に無い店舗（表示範囲外へ出た店）で scrollToIndex を呼ぶと例外になるため index で弾く
  useEffect(() => {
    if (selectedIndex === INDEX_NOT_FOUND) {
      return;
    }
    listRef.current?.scrollToIndex({ index: selectedIndex, animated: true, viewPosition: 0 });
  }, [selectedIndex]);

  const childTestId = useCallback(
    (suffix: string): string | undefined =>
      testID === undefined ? undefined : `${testID}-${suffix}`,
    [testID],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ShopSummary>) => (
      <ShopCard
        shop={item}
        distanceM={shopDistanceM(item, currentCenter)}
        isSelected={item.id === selectedShopId}
        onPress={onSelectShop}
        testID={childTestId(`card-${item.id}`)}
      />
    ),
    [childTestId, currentCenter, onSelectShop, selectedShopId],
  );

  const keyExtractor = useCallback((item: ShopSummary) => item.id, []);

  /**
   * 行の高さが固定なので事前に返せる。
   * これが無いと scrollToIndex が未描画の行へ飛べず「scrollToIndex should be used in conjunction
   * with getItemLayout」の警告とともに失敗する。
   */
  const getItemLayout = useCallback(
    (_data: ArrayLike<ShopSummary> | null | undefined, index: number) => ({
      length: SHOP_CARD_ROW_HEIGHT_PX,
      offset: SHOP_CARD_ROW_HEIGHT_PX * index,
      index,
    }),
    [],
  );

  const skeletonKeys = useMemo(
    () => Array.from({ length: SKELETON_COUNT }, (_unused, index) => `skeleton-${index}`),
    [],
  );

  return (
    <BottomSheet
      index={BOTTOM_SHEET_INDEX_PEEK}
      snapPoints={BOTTOM_SHEET_SNAP_POINTS}
      // 下に引いて閉じられると地図だけの画面になり、店へ戻る導線が消える
      enablePanDownToClose={false}
    >
      {/*
        公式モックの BottomSheetView は props.children をそのまま返すだけで
        ホスト要素を作らない。testID と style は内側の View に持たせる。
      */}
      <BottomSheetView>
        <View style={styles.header}>
          <Text testID={childTestId('count')} className="font-body-bold text-base text-neutral-900">
            {resultCountLabel(shops.length)}
          </Text>
        </View>
      </BottomSheetView>

      {status === 'loading' ? (
        <BottomSheetView>
          <View testID={childTestId('skeleton')} style={styles.stateContainer}>
            {skeletonKeys.map((key) => (
              <Skeleton key={key} height={SHOP_CARD_ROW_HEIGHT_PX} />
            ))}
          </View>
        </BottomSheetView>
      ) : status === 'error' ? (
        <BottomSheetView>
          <View style={styles.stateContainer}>
            <ErrorState
              title={ERROR_TITLE}
              description={ERROR_DESCRIPTION}
              onRetry={onRetry}
              testID={childTestId('error')}
            />
          </View>
        </BottomSheetView>
      ) : shops.length === 0 ? (
        <BottomSheetView>
          <View style={styles.stateContainer}>
            <EmptyState
              icon={MapPinOff}
              title={EMPTY_TITLE}
              description={EMPTY_DESCRIPTION}
              testID={childTestId('empty')}
            />
          </View>
        </BottomSheetView>
      ) : (
        <BottomSheetFlatList
          ref={listRef}
          testID={childTestId('list')}
          // FlatListProps['data'] は readonly 配列を受け付けないのでコピーを渡す。
          // 参照が毎回変わるが、行の再利用は keyExtractor で判定されるため描画コストは増えない
          data={[...shops]}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          contentContainerStyle={styles.listContent}
          // 画面外のカードを保持しすぎるとメモリが伸びる。行高が固定なので小さめで問題ない
          windowSize={5}
          removeClippedSubviews
        />
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  stateContainer: {
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  listContent: {
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.xl,
  },
});
```

Run: `npm test -w @meshimap/mobile -- map-bottom-sheet`
Expected: PASS（15 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`useEffect` の `if (selectedIndex === INDEX_NOT_FOUND) return;` を削除し、「一覧に無い店舗が選ばれてもスクロールしない」が **FAIL** することを確認してから戻す。次に `getItemLayout` の `offset` を `0` 固定にして、「getItemLayout が固定行高で offset を返す」が **FAIL** することも確認する。

- [ ] **Step 4: コミットする**

```bash
git add apps/mobile/src/components/map/map-bottom-sheet.tsx apps/mobile/src/components/map/map-bottom-sheet.test.tsx
git commit -m "feat(mobile): 地図のボトムシートを追加する"
```

---

### Task 6-17: 地図画面を組み上げる

**Files:**

- Create: `apps/mobile/src/app/(user)/(tabs)/map.tsx`
- Create: `apps/mobile/src/app/(user)/(tabs)/map.test.tsx`
- Create: `apps/mobile/src/components/map/location-fallback-notice.tsx`
- Create: `apps/mobile/src/components/map/location-fallback-notice.test.tsx`

`app/(user)/(tabs)/_layout.tsx`（タブバー本体）は **Phase 5 が作る**。このタスクでは画面ファイルだけを置き、テストはコンポーネントを直接 `render` して行う（`jest.config.js` の `collectCoverageFrom` は `!src/app/**` を除外しているが、テスト自体は実行される）。

**Interfaces:**

- Consumes: `@/hooks/use-current-location`、`@/hooks/use-search-this-area`、`@/features/shops/use-nearby-shops`、`@/stores/map-viewport`、`@/stores/search-filter`（Task 6-18。このタスク時点では `EMPTY_SEARCH_FILTER` を直接使う）、`@/lib/map-region`、`@/lib/shop-cluster`、`@/components/map/*`
- Produces: `MapScreen`（default export）/ `LocationFallbackNotice` / 型 `LocationFallbackNoticeProps`

- [ ] **Step 1: 失敗するテストを書く（位置情報フォールバックの案内）**

```tsx
// apps/mobile/src/components/map/location-fallback-notice.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { LOCATION_FALLBACK_MESSAGE, LocationFallbackNotice } from './location-fallback-notice';

describe('LocationFallbackNotice', () => {
  it('位置情報が使えているときは何も出さない', async () => {
    await render(<LocationFallbackNotice status="granted" onDismiss={jest.fn()} testID="notice" />);

    expect(screen.queryByTestId('notice')).toBeNull();
  });

  it('読み込み中は何も出さない', async () => {
    // 判定が終わる前に「使えません」と出すとちらつく
    await render(<LocationFallbackNotice status="loading" onDismiss={jest.fn()} testID="notice" />);

    expect(screen.queryByTestId('notice')).toBeNull();
  });

  it('拒否されたときは代替表示中であることを伝える', async () => {
    await render(<LocationFallbackNotice status="denied" onDismiss={jest.fn()} testID="notice" />);

    expect(screen.getByText(LOCATION_FALLBACK_MESSAGE)).toBeOnTheScreen();
  });

  it('位置情報が使えない端末でも同じ案内を出す', async () => {
    await render(
      <LocationFallbackNotice status="unavailable" onDismiss={jest.fn()} testID="notice" />,
    );

    expect(screen.getByText(LOCATION_FALLBACK_MESSAGE)).toBeOnTheScreen();
  });

  it('閉じるボタンで消せる', async () => {
    const handleDismiss = jest.fn();

    await render(
      <LocationFallbackNotice status="denied" onDismiss={handleDismiss} testID="notice" />,
    );
    await fireEvent.press(screen.getByTestId('notice-dismiss'));

    expect(handleDismiss).toHaveBeenCalledTimes(1);
  });
});
```

Run: `npm test -w @meshimap/mobile -- location-fallback-notice`
Expected: FAIL（`Cannot find module './location-fallback-notice'`）

- [ ] **Step 2: location-fallback-notice.tsx を実装する**

```tsx
// apps/mobile/src/components/map/location-fallback-notice.tsx
import { MapPinOff, X } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { COLORS } from '@/constants/theme';
import type { CurrentLocationStatus } from '@/hooks/use-current-location';

export const LOCATION_FALLBACK_MESSAGE = '位置情報が使えないため、東京駅周辺を表示しています';

const DISMISS_ACCESSIBILITY_LABEL = '案内を閉じる';

export interface LocationFallbackNoticeProps {
  status: CurrentLocationStatus;
  onDismiss: () => void;
  testID?: string | undefined;
}

/**
 * 現在地が取れなかったことを伝える帯。
 * 「許可してください」のブロッキング画面にはしない。店が見えないまま離脱されるより、
 * 代替の場所を出して触れるようにするほうがはるかに良い。
 */
export function LocationFallbackNotice({ status, onDismiss, testID }: LocationFallbackNoticeProps) {
  if (status === 'loading' || status === 'granted') {
    return null;
  }

  return (
    <View
      testID={testID}
      className="absolute left-md right-md top-md z-mapOverlayButton flex-row items-center gap-sm rounded-card bg-neutral-900/90 px-md py-sm"
    >
      <Icon icon={MapPinOff} size="sm" color={COLORS.white} />
      <Text className="flex-1 font-body text-xs text-white">{LOCATION_FALLBACK_MESSAGE}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={DISMISS_ACCESSIBILITY_LABEL}
        onPress={onDismiss}
        testID={testID === undefined ? undefined : `${testID}-dismiss`}
      >
        <Icon icon={X} size="sm" color={COLORS.white} />
      </Pressable>
    </View>
  );
}
```

`bg-neutral-900/90` の不透明度指定は Tailwind 標準のスラッシュ記法で、NativeWind 4 が対応している。効かない場合は `style={{ backgroundColor: COLORS.neutral[900] }}` に置き換える。

Run: `npm test -w @meshimap/mobile -- location-fallback-notice`
Expected: PASS（5 件）

- [ ] **Step 3: 失敗するテストを書く（地図画面）**

```tsx
// apps/mobile/src/app/(user)/(tabs)/map.test.tsx
import { toShopId } from '@meshimap/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import type { ReactNode } from 'react';

import { fetchNearbyShops } from '@/features/shops/api';
import { REGION_SETTLE_DEBOUNCE_MS } from '@/constants/map';
import { useMapViewportStore } from '@/stores/map-viewport';
import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { mapViewCalls } from '@/test-support/react-native-maps-mock';
import { buildShopSummary } from '@/test-support/shop-fixtures';

import MapScreen from './map';

jest.mock('@/features/shops/api', () => ({ fetchNearbyShops: jest.fn() }));

const fetchNearbyShopsMock = jest.mocked(fetchNearbyShops);
const requestPermissionMock = jest.mocked(Location.requestForegroundPermissionsAsync);
const getCurrentPositionMock = jest.mocked(Location.getCurrentPositionAsync);

/** 許可された状態にする。座標は渋谷駅 */
function grantLocation(): void {
  requestPermissionMock.mockResolvedValue({
    granted: true,
    status: Location.PermissionStatus.GRANTED,
    canAskAgain: true,
    expires: 'never',
  } as never);
  getCurrentPositionMock.mockResolvedValue({
    coords: {
      latitude: 35.658034,
      longitude: 139.701636,
      accuracy: 10,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: 0,
  } as never);
}

/** 拒否された状態にする */
function denyLocation(): void {
  requestPermissionMock.mockResolvedValue({
    granted: false,
    status: Location.PermissionStatus.DENIED,
    canAskAgain: false,
    expires: 'never',
  } as never);
}

async function renderMapScreen(): Promise<void> {
  const queryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  }
  await render(<MapScreen />, { wrapper: Wrapper });
}

describe('MapScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mapViewCalls.animateToRegion.mockClear();
    useMapViewportStore.getState().reset();
    fetchNearbyShopsMock.mockResolvedValue([]);
    grantLocation();
  });

  it('位置情報が拒否されてもクラッシュせず東京駅周辺を表示する', async () => {
    denyLocation();

    await renderMapScreen();

    await waitFor(() => {
      expect(screen.getByTestId('map-fallback-notice')).toBeOnTheScreen();
    });
    const { initialRegion } = screen.getByTestId('map-view').props;
    expect(initialRegion.latitude).toBeCloseTo(35.681236, 4);
    expect(initialRegion.longitude).toBeCloseTo(139.767125, 4);
  });

  it('位置情報が許可されていれば案内を出さない', async () => {
    await renderMapScreen();

    await waitFor(() => {
      expect(screen.getByTestId('map-view')).toBeOnTheScreen();
    });
    expect(screen.queryByTestId('map-fallback-notice')).toBeNull();
  });

  it('取得中はボトムシートにスケルトンを出す', async () => {
    await renderMapScreen();

    expect(screen.getByTestId('map-sheet-skeleton')).toBeOnTheScreen();
  });

  it('0 件なら空状態を出す', async () => {
    await renderMapScreen();

    await waitFor(() => {
      expect(screen.getByTestId('map-sheet-empty')).toBeOnTheScreen();
    });
  });

  it('取得に失敗したら再試行ボタンを出す', async () => {
    fetchNearbyShopsMock.mockRejectedValue(new Error('network'));

    await renderMapScreen();

    await waitFor(() => {
      expect(screen.getByTestId('map-sheet-error-retry-button')).toBeOnTheScreen();
    });
  });

  it('取得できた店舗をマーカーとカードの両方に出す', async () => {
    fetchNearbyShopsMock.mockResolvedValue([
      buildShopSummary({ id: toShopId('shop-a'), name: 'A 亭' }),
    ]);

    await renderMapScreen();

    await waitFor(() => {
      expect(screen.getByTestId('map-marker-shop-a')).toBeOnTheScreen();
    });
    expect(screen.getByText('A 亭')).toBeOnTheScreen();
  });

  it('マーカーをタップするとその店舗が選択状態になる', async () => {
    fetchNearbyShopsMock.mockResolvedValue([
      buildShopSummary({ id: toShopId('shop-a'), name: 'A 亭' }),
    ]);

    await renderMapScreen();
    await waitFor(() => {
      expect(screen.getByTestId('map-marker-shop-a')).toBeOnTheScreen();
    });
    await fireEvent.press(screen.getByTestId('map-marker-shop-a'));

    expect(useMapViewportStore.getState().selectedShopId).toBe(toShopId('shop-a'));
  });

  it('カードをタップすると地図がその店へ寄る', async () => {
    fetchNearbyShopsMock.mockResolvedValue([
      buildShopSummary({ id: toShopId('shop-a'), name: 'A 亭', latitude: 35.66, longitude: 139.7 }),
    ]);

    await renderMapScreen();
    await waitFor(() => {
      expect(screen.getByTestId('map-sheet-card-shop-a')).toBeOnTheScreen();
    });
    await fireEvent.press(screen.getByTestId('map-sheet-card-shop-a'));

    expect(mapViewCalls.animateToRegion).toHaveBeenCalledTimes(1);
    expect(mapViewCalls.animateToRegion.mock.calls[0]?.[0].latitude).toBeCloseTo(35.66, 4);
  });

  it('地図を大きく動かすと再検索ボタンが出る', async () => {
    jest.useFakeTimers();
    try {
      await renderMapScreen();

      const mapView = screen.getByTestId('map-view');
      await act(async () => {
        mapView.props.onRegionChangeComplete(
          { latitude: 35.8, longitude: 139.9, latitudeDelta: 0.018, longitudeDelta: 0.022 },
          { isGesture: true },
        );
        jest.advanceTimersByTime(REGION_SETTLE_DEBOUNCE_MS);
      });

      expect(screen.getByTestId('map-search-this-area')).toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }
  });

  it('わずかな移動では再検索ボタンを出さない', async () => {
    jest.useFakeTimers();
    try {
      await renderMapScreen();

      const mapView = screen.getByTestId('map-view');
      await act(async () => {
        mapView.props.onRegionChangeComplete(
          {
            latitude: 35.681336,
            longitude: 139.767225,
            latitudeDelta: 0.018,
            longitudeDelta: 0.022,
          },
          { isGesture: true },
        );
        jest.advanceTimersByTime(REGION_SETTLE_DEBOUNCE_MS);
      });

      expect(screen.queryByTestId('map-search-this-area')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('再検索ボタンを押すと新しい中心で取り直す', async () => {
    jest.useFakeTimers();
    try {
      await renderMapScreen();

      const mapView = screen.getByTestId('map-view');
      await act(async () => {
        mapView.props.onRegionChangeComplete(
          { latitude: 35.8, longitude: 139.9, latitudeDelta: 0.018, longitudeDelta: 0.022 },
          { isGesture: true },
        );
        jest.advanceTimersByTime(REGION_SETTLE_DEBOUNCE_MS);
      });
      await fireEvent.press(screen.getByTestId('map-search-this-area-button'));

      await waitFor(() => {
        expect(fetchNearbyShopsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
      const lastCall = fetchNearbyShopsMock.mock.calls.at(-1);
      expect(lastCall?.[0].center.latitude).toBeCloseTo(35.8, 4);
    } finally {
      jest.useRealTimers();
    }
  });
});
```

Run: `npm test -w @meshimap/mobile -- "\(tabs\)/map"`
Expected: FAIL（`Cannot find module './map'`）

- [ ] **Step 4: map.tsx を実装する**

```tsx
// apps/mobile/src/app/(user)/(tabs)/map.tsx
import type { ShopId } from '@meshimap/core';
import type { Coordinate } from '@meshimap/geo';
import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import MapView from 'react-native-maps';
import type { Region } from 'react-native-maps';

import { ClusterMarker } from '@/components/map/cluster-marker';
import { LocationFallbackNotice } from '@/components/map/location-fallback-notice';
import { MapBottomSheet } from '@/components/map/map-bottom-sheet';
import { SearchThisAreaButton } from '@/components/map/search-this-area-button';
import { ShopMarker } from '@/components/map/shop-marker';
import { INITIAL_LATITUDE_DELTA, INITIAL_LONGITUDE_DELTA } from '@/constants/map';
import { useNearbyShops } from '@/features/shops/use-nearby-shops';
import { shopCoordinate } from '@/features/shops/schema';
import { useCurrentLocation } from '@/hooks/use-current-location';
import { useSearchThisArea } from '@/hooks/use-search-this-area';
import { regionFromCenter, zoomInRegion } from '@/lib/map-region';
import { EMPTY_SEARCH_FILTER } from '@/lib/search-filter';
import { clusterMarkerKey, singleShopOf } from '@/lib/shop-cluster';
import { useMapViewportStore } from '@/stores/map-viewport';

/** 地図移動アニメーションの長さ（ms）。短すぎると瞬間移動に見え、長いと待たされる */
const MAP_ANIMATION_MS = 350;

export default function MapScreen() {
  const mapRef = useRef<MapView>(null);
  const location = useCurrentLocation();
  const setCurrentRegion = useMapViewportStore((state) => state.setCurrentRegion);
  const setViewportWidthPx = useMapViewportStore((state) => state.setViewportWidthPx);
  const selectedShopId = useMapViewportStore((state) => state.selectedShopId);
  const selectShop = useMapViewportStore((state) => state.selectShop);
  const currentRegion = useMapViewportStore((state) => state.currentRegion);

  const { isVisible: isSearchThisAreaVisible, searchThisArea } = useSearchThisArea();
  const { visibleShops, clusters, status, refetch } = useNearbyShops(EMPTY_SEARCH_FILTER);
  const [isFallbackNoticeDismissed, setIsFallbackNoticeDismissed] = useState(false);

  // 位置情報が解決するまで地図を描かないと白い画面になる。
  // useCurrentLocation は必ず座標を返すので、初回の値で初期表示を決められる
  const initialRegion = useMemo(
    () => regionFromCenter(location.center, INITIAL_LATITUDE_DELTA, INITIAL_LONGITUDE_DELTA),
    [location.center],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      // ズームレベルの計算に地図の実測幅が要る。端末幅と地図幅は必ずしも一致しない
      setViewportWidthPx(event.nativeEvent.layout.width);
    },
    [setViewportWidthPx],
  );

  const handleRegionChangeComplete = useCallback(
    (region: Region) => {
      setCurrentRegion(region);
    },
    [setCurrentRegion],
  );

  const moveTo = useCallback((region: Region) => {
    mapRef.current?.animateToRegion(region, MAP_ANIMATION_MS);
  }, []);

  const handleClusterPress = useCallback(
    (center: Coordinate) => {
      if (currentRegion === null) {
        return;
      }
      // 1 タップで 1 段深く入る。クラスタが割れて中身が見える
      moveTo(zoomInRegion(center, currentRegion));
    },
    [currentRegion, moveTo],
  );

  const handleMarkerPress = useCallback(
    (shopId: ShopId) => {
      // ピン → カードの同期はシート側の scrollToIndex が担う。ここは選択状態を変えるだけ
      selectShop(shopId);
    },
    [selectShop],
  );

  const handleCardPress = useCallback(
    (shopId: ShopId) => {
      selectShop(shopId);
      const shop = visibleShops.find((candidate) => candidate.id === shopId);
      if (shop === undefined || currentRegion === null) {
        return;
      }
      // カード → 地図の同期。ズームは変えず中心だけ動かす
      moveTo(
        regionFromCenter(
          shopCoordinate(shop),
          currentRegion.latitudeDelta,
          currentRegion.longitudeDelta,
        ),
      );
    },
    [currentRegion, moveTo, selectShop, visibleShops],
  );

  const handleDismissNotice = useCallback(() => {
    setIsFallbackNoticeDismissed(true);
  }, []);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        testID="map-view"
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        onLayout={handleLayout}
        onRegionChangeComplete={handleRegionChangeComplete}
        showsUserLocation={location.isDeviceLocation}
        // 既定の「現在地へ戻る」ボタンは位置が OS 依存で崩れるため自前の導線に寄せる
        showsMyLocationButton={false}
        toolbarEnabled={false}
      >
        {clusters.map((cluster) => {
          const shop = singleShopOf(cluster);
          const key = clusterMarkerKey(cluster, selectedShopId);

          return shop === null ? (
            <ClusterMarker
              key={key}
              center={cluster.center}
              count={cluster.values.length}
              onPress={handleClusterPress}
              testID={`map-cluster-${cluster.cell}`}
            />
          ) : (
            <ShopMarker
              key={key}
              shop={shop}
              isSelected={shop.id === selectedShopId}
              onPress={handleMarkerPress}
              testID={`map-marker-${shop.id}`}
            />
          );
        })}
      </MapView>

      {isFallbackNoticeDismissed ? null : (
        <LocationFallbackNotice
          status={location.status}
          onDismiss={handleDismissNotice}
          testID="map-fallback-notice"
        />
      )}

      <SearchThisAreaButton
        isVisible={isSearchThisAreaVisible}
        isLoading={status === 'loading'}
        onPress={searchThisArea}
        testID="map-search-this-area"
      />

      <MapBottomSheet
        shops={visibleShops}
        status={status}
        selectedShopId={selectedShopId}
        currentCenter={location.isDeviceLocation ? location.center : null}
        onSelectShop={handleCardPress}
        onRetry={refetch}
        testID="map-sheet"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
```

再検索ボタンが出ている状態でも `LocationFallbackNotice` と縦位置が重なるため、案内が出ている間はボタンを `top-xxl` へ下げる（`SearchThisAreaButton` に `offsetTop` を足すのではなく、案内側が `absolute` で上に載るだけなので実害はない）。実機確認で重なりが気になった場合のみ調整する。

Run: `npm test -w @meshimap/mobile -- "\(tabs\)/map"`
Expected: PASS（12 件）

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

1. `useCurrentLocation` の戻り値を使わず `initialRegion` を固定の渋谷座標にすると、「位置情報が拒否されてもクラッシュせず東京駅周辺を表示する」が **FAIL**。
2. `handleRegionChangeComplete` を空関数にすると、「地図を大きく動かすと再検索ボタンが出る」が **FAIL**。
3. `handleCardPress` から `moveTo(...)` を削ると、「カードをタップすると地図がその店へ寄る」が **FAIL**。
4. `handleMarkerPress` から `selectShop(shopId)` を削ると、「マーカーをタップするとその店舗が選択状態になる」が **FAIL**。

4 つすべてを確認してから戻す。

- [ ] **Step 6: 型チェックを通す**

Run: `npm run typecheck -w @meshimap/mobile`
Expected: エラー 0 件

- [ ] **Step 7: コミットする**

```bash
git add apps/mobile/src/app/\(user\)/\(tabs\)/map.tsx apps/mobile/src/app/\(user\)/\(tabs\)/map.test.tsx apps/mobile/src/components/map/location-fallback-notice.tsx apps/mobile/src/components/map/location-fallback-notice.test.tsx
git commit -m "feat(mobile): 地図画面を組み上げる"
```

---

### Task 6-18: 検索フィルタのストアと URL 同期を作る

**Files:**

- Create: `apps/mobile/src/stores/search-filter.ts`
- Create: `apps/mobile/src/stores/search-filter.test.ts`
- Create: `apps/mobile/src/hooks/use-search-filter-url-sync.ts`
- Create: `apps/mobile/src/hooks/use-search-filter-url-sync.test.tsx`

**Interfaces:**

- Consumes: `zustand` の `create`、`@/lib/search-filter` の `EMPTY_SEARCH_FILTER` / `fromSearchQueryParams` / `toSearchQueryParams` / 型 `SearchFilter`、`expo-router` の `router` / `useLocalSearchParams`
- Produces:
  - `useSearchFilterStore`（Zustand ストア）/ 型 `SearchFilterState`
  - `useSearchFilterUrlSync(): void`

- [ ] **Step 1: 失敗するテストを書く（ストア）**

```ts
// apps/mobile/src/stores/search-filter.test.ts
import { toRating } from '@meshimap/core';

import { EMPTY_SEARCH_FILTER } from '@/lib/search-filter';

import { useSearchFilterStore } from './search-filter';

describe('useSearchFilterStore', () => {
  beforeEach(() => {
    useSearchFilterStore.getState().reset();
  });

  it('初期状態は条件なし', () => {
    expect(useSearchFilterStore.getState().filter).toEqual(EMPTY_SEARCH_FILTER);
  });

  it('キーワードを設定できる', () => {
    useSearchFilterStore.getState().setKeyword('焼き鳥');

    expect(useSearchFilterStore.getState().filter.keyword).toBe('焼き鳥');
  });

  it('ジャンルは選ぶと増え、もう一度選ぶと外れる', () => {
    const { toggleGenre } = useSearchFilterStore.getState();

    toggleGenre('genre-a');
    toggleGenre('genre-b');
    expect(useSearchFilterStore.getState().filter.genreIds).toEqual(['genre-a', 'genre-b']);

    toggleGenre('genre-a');
    expect(useSearchFilterStore.getState().filter.genreIds).toEqual(['genre-b']);
  });

  it('営業中トグルは押すたびに反転する', () => {
    const { toggleOpenNow } = useSearchFilterStore.getState();

    toggleOpenNow();
    expect(useSearchFilterStore.getState().filter.isOpenNowOnly).toBe(true);

    toggleOpenNow();
    expect(useSearchFilterStore.getState().filter.isOpenNowOnly).toBe(false);
  });

  it('同じ予算をもう一度選ぶと解除になる', () => {
    // チップ UI では「押す＝選ぶ」「もう一度押す＝外す」が自然な操作
    const { setBudgetMaxYen } = useSearchFilterStore.getState();

    setBudgetMaxYen(3000);
    expect(useSearchFilterStore.getState().filter.budgetMaxYen).toBe(3000);

    setBudgetMaxYen(3000);
    expect(useSearchFilterStore.getState().filter.budgetMaxYen).toBeNull();
  });

  it('同じ評価をもう一度選ぶと解除になる', () => {
    const { setMinRating } = useSearchFilterStore.getState();

    setMinRating(toRating(4));
    expect(useSearchFilterStore.getState().filter.minRating).toBe(4);

    setMinRating(toRating(4));
    expect(useSearchFilterStore.getState().filter.minRating).toBeNull();
  });

  it('同じ距離をもう一度選ぶと解除になる', () => {
    const { setDistanceM } = useSearchFilterStore.getState();

    setDistanceM(1000);
    expect(useSearchFilterStore.getState().filter.distanceM).toBe(1000);

    setDistanceM(1000);
    expect(useSearchFilterStore.getState().filter.distanceM).toBeNull();
  });

  it('エリアは上書きで切り替わる', () => {
    const { setAreaId } = useSearchFilterStore.getState();

    setAreaId('area-shibuya');
    setAreaId('area-shinjuku');

    expect(useSearchFilterStore.getState().filter.areaId).toBe('area-shinjuku');
  });

  it('条件クリアはキーワードを残す', () => {
    // 検索バーの文字まで消えると「何を消したのか」が分からなくなる
    const state = useSearchFilterStore.getState();
    state.setKeyword('寿司');
    state.toggleGenre('genre-a');
    state.toggleOpenNow();

    useSearchFilterStore.getState().clearConditions();

    const { filter } = useSearchFilterStore.getState();
    expect(filter.keyword).toBe('寿司');
    expect(filter.genreIds).toEqual([]);
    expect(filter.isOpenNowOnly).toBe(false);
  });

  it('replaceFilter は丸ごと差し替える', () => {
    useSearchFilterStore.getState().setKeyword('寿司');

    useSearchFilterStore.getState().replaceFilter({ ...EMPTY_SEARCH_FILTER, keyword: '焼肉' });

    expect(useSearchFilterStore.getState().filter).toEqual({
      ...EMPTY_SEARCH_FILTER,
      keyword: '焼肉',
    });
  });

  it('reset で初期状態へ戻る', () => {
    useSearchFilterStore.getState().setKeyword('寿司');

    useSearchFilterStore.getState().reset();

    expect(useSearchFilterStore.getState().filter).toEqual(EMPTY_SEARCH_FILTER);
  });
});
```

Run: `npm test -w @meshimap/mobile -- stores/search-filter`
Expected: FAIL（`Cannot find module './search-filter'`）

- [ ] **Step 2: stores/search-filter.ts を実装する**

```ts
// apps/mobile/src/stores/search-filter.ts
import type { Rating } from '@meshimap/core';
import { create } from 'zustand';

import { EMPTY_SEARCH_FILTER } from '@/lib/search-filter';
import type { SearchFilter } from '@/lib/search-filter';

export interface SearchFilterState {
  filter: SearchFilter;
  setKeyword: (keyword: string) => void;
  toggleGenre: (genreId: string) => void;
  setAreaId: (areaId: string | null) => void;
  /** 同じ値をもう一度渡すと解除になる（チップの再タップ） */
  setBudgetMaxYen: (budgetMaxYen: number) => void;
  toggleOpenNow: () => void;
  setMinRating: (minRating: Rating) => void;
  setDistanceM: (distanceM: number) => void;
  /** キーワード以外の条件を消す */
  clearConditions: () => void;
  replaceFilter: (filter: SearchFilter) => void;
  reset: () => void;
}

/** 同じ値を選び直したら解除、違う値なら差し替え。チップの再タップ挙動を 1 箇所にまとめる */
function toggleValue<T>(current: T | null, next: T): T | null {
  return current === next ? null : next;
}

export const useSearchFilterStore = create<SearchFilterState>((set) => ({
  filter: EMPTY_SEARCH_FILTER,

  setKeyword: (keyword) => {
    set((state) => ({ filter: { ...state.filter, keyword } }));
  },

  toggleGenre: (genreId) => {
    set((state) => {
      const isSelected = state.filter.genreIds.includes(genreId);
      const genreIds = isSelected
        ? state.filter.genreIds.filter((candidate) => candidate !== genreId)
        : [...state.filter.genreIds, genreId];
      return { filter: { ...state.filter, genreIds } };
    });
  },

  setAreaId: (areaId) => {
    set((state) => ({ filter: { ...state.filter, areaId } }));
  },

  setBudgetMaxYen: (budgetMaxYen) => {
    set((state) => ({
      filter: {
        ...state.filter,
        budgetMaxYen: toggleValue(state.filter.budgetMaxYen, budgetMaxYen),
      },
    }));
  },

  toggleOpenNow: () => {
    set((state) => ({ filter: { ...state.filter, isOpenNowOnly: !state.filter.isOpenNowOnly } }));
  },

  setMinRating: (minRating) => {
    set((state) => ({
      filter: { ...state.filter, minRating: toggleValue(state.filter.minRating, minRating) },
    }));
  },

  setDistanceM: (distanceM) => {
    set((state) => ({
      filter: { ...state.filter, distanceM: toggleValue(state.filter.distanceM, distanceM) },
    }));
  },

  clearConditions: () => {
    set((state) => ({ filter: { ...EMPTY_SEARCH_FILTER, keyword: state.filter.keyword } }));
  },

  replaceFilter: (filter) => {
    set({ filter });
  },

  reset: () => {
    set({ filter: EMPTY_SEARCH_FILTER });
  },
}));
```

Run: `npm test -w @meshimap/mobile -- stores/search-filter`
Expected: PASS（12 件）

- [ ] **Step 3: 失敗するテストを書く（URL 同期）**

URL 同期の方針は 2 方向で、優先順位を明確に分ける。

| タイミング                     | 向き         | 目的                                                   |
| ------------------------------ | ------------ | ------------------------------------------------------ |
| 画面のマウント時（1 回だけ）   | URL → ストア | ディープリンク・共有リンクで開いたときに条件を復元する |
| ストアの `filter` が変わるたび | ストア → URL | 戻る操作と共有リンクを成立させる                       |

マウント後に URL → ストアを繰り返すと、ストア更新 → URL 更新 → URL 変化検知 → ストア更新…の無限ループになる。
だから **URL を読むのは初回だけ**にする。

```tsx
// apps/mobile/src/hooks/use-search-filter-url-sync.test.tsx
import { renderHook } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { act } from 'react';

import { EMPTY_SEARCH_FILTER } from '@/lib/search-filter';
import { useSearchFilterStore } from '@/stores/search-filter';

import { useSearchFilterUrlSync } from './use-search-filter-url-sync';

jest.mock('expo-router', () => ({
  router: { setParams: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));

const setParamsMock = jest.mocked(router.setParams);
const useLocalSearchParamsMock = jest.mocked(useLocalSearchParams);

describe('useSearchFilterUrlSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useLocalSearchParamsMock.mockReturnValue({});
    useSearchFilterStore.getState().reset();
  });

  it('URL の条件をマウント時にストアへ取り込む', async () => {
    useLocalSearchParamsMock.mockReturnValue({ keyword: '焼き鳥', openNow: '1' });

    await renderHook(() => {
      useSearchFilterUrlSync();
    });

    const { filter } = useSearchFilterStore.getState();
    expect(filter.keyword).toBe('焼き鳥');
    expect(filter.isOpenNowOnly).toBe(true);
  });

  it('条件なしで開いたときはストアを書き換えない', async () => {
    useSearchFilterStore.getState().setKeyword('前の画面で入れた語');

    await renderHook(() => {
      useSearchFilterUrlSync();
    });

    // 空のクエリで上書きすると、タブを行き来しただけで条件が消える
    expect(useSearchFilterStore.getState().filter.keyword).toBe('前の画面で入れた語');
  });

  it('ストアの変更を URL へ書き戻す', async () => {
    await renderHook(() => {
      useSearchFilterUrlSync();
    });

    await act(async () => {
      useSearchFilterStore.getState().setKeyword('寿司');
    });

    expect(setParamsMock).toHaveBeenLastCalledWith({ keyword: '寿司' });
  });

  it('条件を消すと URL からもキーが消える', async () => {
    useSearchFilterStore.getState().setKeyword('寿司');

    await renderHook(() => {
      useSearchFilterUrlSync();
    });

    await act(async () => {
      useSearchFilterStore.getState().replaceFilter(EMPTY_SEARCH_FILTER);
    });

    expect(setParamsMock).toHaveBeenLastCalledWith({});
  });

  it('マウント後に URL が変わってもストアへは取り込まない', async () => {
    const { rerender } = await renderHook(() => {
      useSearchFilterUrlSync();
    });

    useLocalSearchParamsMock.mockReturnValue({ keyword: 'URL から後入れ' });
    await act(async () => {
      rerender(undefined);
    });

    // 取り込むと「ストア→URL→ストア」の往復が止まらなくなる
    expect(useSearchFilterStore.getState().filter.keyword).toBe('');
  });
});
```

Run: `npm test -w @meshimap/mobile -- use-search-filter-url-sync`
Expected: FAIL（`Cannot find module './use-search-filter-url-sync'`）

- [ ] **Step 4: use-search-filter-url-sync.ts を実装する**

```ts
// apps/mobile/src/hooks/use-search-filter-url-sync.ts
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';

import { fromSearchQueryParams, toSearchQueryParams } from '@/lib/search-filter';
import { useSearchFilterStore } from '@/stores/search-filter';

export function useSearchFilterUrlSync(): void {
  const params = useLocalSearchParams();
  const filter = useSearchFilterStore((state) => state.filter);
  const replaceFilter = useSearchFilterStore((state) => state.replaceFilter);

  // 初回だけ URL を読む。以降も読むと「ストア更新 → URL 更新 → 再取り込み」で往復が止まらない
  const hasImportedRef = useRef(false);
  // 初回の書き戻しを飛ばす。マウント直後に setParams を呼ぶと履歴に無駄な 1 件が入る
  const hasSyncedOnceRef = useRef(false);

  useEffect(() => {
    if (hasImportedRef.current) {
      return;
    }
    hasImportedRef.current = true;

    // 条件なしで開いたときは何もしない。空クエリで上書きすると
    // タブを往復しただけで前の条件が消える
    if (Object.keys(params).length === 0) {
      return;
    }
    replaceFilter(fromSearchQueryParams(params));
  }, [params, replaceFilter]);

  useEffect(() => {
    if (!hasSyncedOnceRef.current) {
      hasSyncedOnceRef.current = true;
      return;
    }
    router.setParams(toSearchQueryParams(filter));
  }, [filter]);
}
```

`router.setParams` の型は `<T extends RoutePath>(params: Partial<RouteInputParams<T>>) => void`（`node_modules/expo-router/build/global-state/router.d.ts`）。
`experiments.typedRoutes` で `.expo/types/router.d.ts` が生成されると引数型が実ルートの params 型に狭まるため、
`Record<string, string>` が通らなくなる可能性がある。その場合は `router.setParams<'/search'>(...)` のように
生成された型引数を明示する（→ 未確認事項に記載）。

Run: `npm test -w @meshimap/mobile -- use-search-filter-url-sync`
Expected: PASS（5 件）

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`hasImportedRef` のガードを外し、「マウント後に URL が変わってもストアへは取り込まない」が **FAIL** することを確認してから戻す。次に `Object.keys(params).length === 0` の早期 return を消し、「条件なしで開いたときはストアを書き換えない」が **FAIL** することも確認する。

- [ ] **Step 6: コミットする**

```bash
git add apps/mobile/src/stores/search-filter.ts apps/mobile/src/stores/search-filter.test.ts apps/mobile/src/hooks/use-search-filter-url-sync.ts apps/mobile/src/hooks/use-search-filter-url-sync.test.tsx
git commit -m "feat(mobile): 検索フィルタのストアと URL 同期を追加する"
```

---

### Task 6-19: フィルタチップとフィルタシートを作る

**Files:**

- Create: `apps/mobile/src/components/search/filter-chip.tsx`
- Create: `apps/mobile/src/components/search/filter-chip.test.tsx`
- Create: `apps/mobile/src/components/search/filter-chip-bar.tsx`
- Create: `apps/mobile/src/components/search/filter-chip-bar.test.tsx`
- Create: `apps/mobile/src/components/search/filter-sheet.tsx`
- Create: `apps/mobile/src/components/search/filter-sheet.test.tsx`

**Interfaces:**

- Consumes: `@/stores/search-filter` の `useSearchFilterStore`、`@/constants/search` の `BUDGET_MAX_OPTIONS_YEN` / `DISTANCE_OPTIONS_M`、`@meshimap/core` の `formatYen` / `toRating` / 型 `Rating`、`@meshimap/geo` の `formatDistance`、`@/components/ui/button` の `Button`
- Produces:
  - `FilterChip` / 型 `FilterChipProps`
  - `FilterChipBar` / 型 `FilterChipBarProps`
  - `FilterSheet` / 型 `FilterSheetProps`
  - `RATING_FILTER_OPTIONS: readonly Rating[]`
  - `budgetChipLabel(budgetMaxYen: number): string` / `distanceChipLabel(distanceM: number): string` / `ratingChipLabel(minRating: Rating): string`

- [ ] **Step 1: 失敗するテストを書く（チップ 1 個）**

```tsx
// apps/mobile/src/components/search/filter-chip.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { FilterChip } from './filter-chip';

/** NativeWind はテスト環境で className を style に変換しないので props から読む */
function getClassName(testID: string): string {
  const { className } = screen.getByTestId(testID).props;
  return typeof className === 'string' ? className : '';
}

describe('FilterChip', () => {
  it('ラベルを表示する', async () => {
    await render(
      <FilterChip label="営業中" isSelected={false} onPress={jest.fn()} testID="chip" />,
    );

    expect(screen.getByText('営業中')).toBeOnTheScreen();
  });

  it('タップすると呼ばれる', async () => {
    const handlePress = jest.fn();

    await render(
      <FilterChip label="営業中" isSelected={false} onPress={handlePress} testID="chip" />,
    );
    await fireEvent.press(screen.getByTestId('chip'));

    expect(handlePress).toHaveBeenCalledTimes(1);
  });

  it('選択中はブランド色の背景になる', async () => {
    await render(<FilterChip label="営業中" isSelected onPress={jest.fn()} testID="chip" />);

    expect(getClassName('chip')).toContain('bg-primary-500');
  });

  it('非選択は白背景になる', async () => {
    await render(
      <FilterChip label="営業中" isSelected={false} onPress={jest.fn()} testID="chip" />,
    );

    expect(getClassName('chip')).toContain('bg-white');
  });

  it('選択状態をスクリーンリーダーへ伝える', async () => {
    await render(<FilterChip label="営業中" isSelected onPress={jest.fn()} testID="chip" />);

    expect(screen.getByTestId('chip')).toHaveAccessibilityState({ selected: true });
  });

  it('件数バッジを添えられる', async () => {
    await render(
      <FilterChip label="ジャンル" isSelected count={3} onPress={jest.fn()} testID="chip" />,
    );

    expect(screen.getByText('ジャンル 3')).toBeOnTheScreen();
  });

  it('件数が 0 のときはバッジを出さない', async () => {
    await render(
      <FilterChip
        label="ジャンル"
        isSelected={false}
        count={0}
        onPress={jest.fn()}
        testID="chip"
      />,
    );

    expect(screen.getByText('ジャンル')).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- filter-chip.test`
Expected: FAIL（`Cannot find module './filter-chip'`）

- [ ] **Step 2: filter-chip.tsx を実装する**

```tsx
// apps/mobile/src/components/search/filter-chip.tsx
import { memo } from 'react';
import { Pressable, Text } from 'react-native';

/** ラベルと件数の区切り。「ジャンル 3」のように空白ひとつで並べる */
const COUNT_SEPARATOR = ' ';

export interface FilterChipProps {
  label: string;
  isSelected: boolean;
  onPress: () => void;
  /** 選択件数。0 のときはラベルだけを出す */
  count?: number | undefined;
  testID?: string | undefined;
}

function FilterChipComponent({ label, isSelected, onPress, count, testID }: FilterChipProps) {
  const displayLabel =
    count !== undefined && count > 0 ? `${label}${COUNT_SEPARATOR}${count}` : label;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      accessibilityLabel={displayLabel}
      onPress={onPress}
      className={
        isSelected
          ? 'rounded-pill border border-primary-500 bg-primary-500 px-md py-xs'
          : 'rounded-pill border border-neutral-200 bg-white px-md py-xs'
      }
    >
      <Text
        className={
          isSelected
            ? 'font-body-medium text-sm text-white'
            : 'font-body-medium text-sm text-neutral-800'
        }
      >
        {displayLabel}
      </Text>
    </Pressable>
  );
}

/** チップは横一列に 5〜10 個並ぶ。親の再描画で全部作り直さないよう memo する */
export const FilterChip = memo(FilterChipComponent);
```

Run: `npm test -w @meshimap/mobile -- filter-chip.test`
Expected: PASS（7 件）

- [ ] **Step 3: 失敗するテストを書く（チップ列）**

```tsx
// apps/mobile/src/components/search/filter-chip-bar.test.tsx
import { toRating } from '@meshimap/core';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { useSearchFilterStore } from '@/stores/search-filter';

import {
  FilterChipBar,
  budgetChipLabel,
  distanceChipLabel,
  ratingChipLabel,
} from './filter-chip-bar';

describe('ラベル生成', () => {
  it('予算は「〜」付きの円表記になる', () => {
    expect(budgetChipLabel(3000)).toBe('〜¥3,000');
  });

  it('距離は m / km 表記になる', () => {
    expect(distanceChipLabel(1000)).toBe('1.0km以内');
    expect(distanceChipLabel(500)).toBe('500m以内');
  });

  it('評価は「以上」付きになる', () => {
    expect(ratingChipLabel(toRating(4))).toBe('★4.0以上');
  });
});

describe('FilterChipBar', () => {
  beforeEach(() => {
    useSearchFilterStore.getState().reset();
  });

  it('営業中チップを押すと条件が入る', async () => {
    await render(<FilterChipBar onOpenFilterSheet={jest.fn()} testID="chips" />);
    await fireEvent.press(screen.getByTestId('chips-open-now'));

    expect(useSearchFilterStore.getState().filter.isOpenNowOnly).toBe(true);
  });

  it('営業中チップをもう一度押すと条件が外れる', async () => {
    await render(<FilterChipBar onOpenFilterSheet={jest.fn()} testID="chips" />);
    await fireEvent.press(screen.getByTestId('chips-open-now'));
    await fireEvent.press(screen.getByTestId('chips-open-now'));

    expect(useSearchFilterStore.getState().filter.isOpenNowOnly).toBe(false);
  });

  it('評価 4.0 以上チップを押すと条件が入る', async () => {
    await render(<FilterChipBar onOpenFilterSheet={jest.fn()} testID="chips" />);
    await fireEvent.press(screen.getByTestId('chips-min-rating'));

    expect(useSearchFilterStore.getState().filter.minRating).toBe(4);
  });

  it('絞り込みチップを押すとシートを開く要求が飛ぶ', async () => {
    const handleOpen = jest.fn();

    await render(<FilterChipBar onOpenFilterSheet={handleOpen} testID="chips" />);
    await fireEvent.press(screen.getByTestId('chips-more'));

    expect(handleOpen).toHaveBeenCalledTimes(1);
  });

  it('絞り込みチップに有効な条件の件数が出る', async () => {
    const state = useSearchFilterStore.getState();
    state.toggleGenre('genre-a');
    state.setAreaId('area-shibuya');

    await render(<FilterChipBar onOpenFilterSheet={jest.fn()} testID="chips" />);

    expect(screen.getByText('絞り込み 2')).toBeOnTheScreen();
  });

  it('条件が無いときは件数を出さない', async () => {
    await render(<FilterChipBar onOpenFilterSheet={jest.fn()} testID="chips" />);

    expect(screen.getByText('絞り込み')).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- filter-chip-bar`
Expected: FAIL（`Cannot find module './filter-chip-bar'`）

- [ ] **Step 4: filter-chip-bar.tsx を実装する**

```tsx
// apps/mobile/src/components/search/filter-chip-bar.tsx
import { formatYen, toRating } from '@meshimap/core';
import type { Rating } from '@meshimap/core';
import { formatDistance } from '@meshimap/geo';
import { useCallback } from 'react';
import { ScrollView } from 'react-native';

import { FilterChip } from '@/components/search/filter-chip';
import { SPACING } from '@/constants/theme';
import { countActiveFilters } from '@/lib/search-filter';
import { useSearchFilterStore } from '@/stores/search-filter';

/** チップ列に常設する評価のしきい値。4.0 以上は「良い店だけ見たい」の定番 */
const QUICK_MIN_RATING: Rating = toRating(4);

const OPEN_NOW_LABEL = '営業中';
const MORE_LABEL = '絞り込み';
const BUDGET_MAX_PREFIX = '〜';
const DISTANCE_SUFFIX = '以内';
const RATING_PREFIX = '★';
const RATING_SUFFIX = '以上';

export function budgetChipLabel(budgetMaxYen: number): string {
  return `${BUDGET_MAX_PREFIX}${formatYen(budgetMaxYen)}`;
}

export function distanceChipLabel(distanceM: number): string {
  return `${formatDistance(distanceM)}${DISTANCE_SUFFIX}`;
}

export function ratingChipLabel(minRating: Rating): string {
  return `${RATING_PREFIX}${minRating.toFixed(1)}${RATING_SUFFIX}`;
}

export interface FilterChipBarProps {
  /** 詳細な絞り込みシートを開く。表示状態は画面側が持つ */
  onOpenFilterSheet: () => void;
  testID?: string | undefined;
}

export function FilterChipBar({ onOpenFilterSheet, testID }: FilterChipBarProps) {
  const filter = useSearchFilterStore((state) => state.filter);
  const toggleOpenNow = useSearchFilterStore((state) => state.toggleOpenNow);
  const setMinRating = useSearchFilterStore((state) => state.setMinRating);

  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  const handleQuickRating = useCallback(() => {
    setMinRating(QUICK_MIN_RATING);
  }, [setMinRating]);

  const activeCount = countActiveFilters(filter);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: SPACING.xs, paddingHorizontal: SPACING.md }}
      testID={testID}
    >
      <FilterChip
        label={OPEN_NOW_LABEL}
        isSelected={filter.isOpenNowOnly}
        onPress={toggleOpenNow}
        testID={childTestId('open-now')}
      />
      <FilterChip
        label={ratingChipLabel(QUICK_MIN_RATING)}
        isSelected={filter.minRating === QUICK_MIN_RATING}
        onPress={handleQuickRating}
        testID={childTestId('min-rating')}
      />
      <FilterChip
        label={MORE_LABEL}
        count={activeCount}
        isSelected={activeCount > 0}
        onPress={onOpenFilterSheet}
        testID={childTestId('more')}
      />
    </ScrollView>
  );
}
```

Run: `npm test -w @meshimap/mobile -- filter-chip-bar`
Expected: PASS（9 件）

- [ ] **Step 5: 失敗するテストを書く（絞り込みシート）**

```tsx
// apps/mobile/src/components/search/filter-sheet.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { useSearchFilterStore } from '@/stores/search-filter';

import { FilterSheet } from './filter-sheet';

describe('FilterSheet', () => {
  beforeEach(() => {
    useSearchFilterStore.getState().reset();
  });

  it('閉じているときは中身を描画しない', async () => {
    await render(<FilterSheet isOpen={false} onClose={jest.fn()} testID="filter-sheet" />);

    expect(screen.queryByTestId('filter-sheet')).toBeNull();
  });

  it('予算の選択肢を並べる', async () => {
    await render(<FilterSheet isOpen onClose={jest.fn()} testID="filter-sheet" />);

    expect(screen.getByTestId('filter-sheet-budget-1000')).toBeOnTheScreen();
    expect(screen.getByTestId('filter-sheet-budget-10000')).toBeOnTheScreen();
  });

  it('予算を選ぶとストアへ反映される', async () => {
    await render(<FilterSheet isOpen onClose={jest.fn()} testID="filter-sheet" />);
    await fireEvent.press(screen.getByTestId('filter-sheet-budget-3000'));

    expect(useSearchFilterStore.getState().filter.budgetMaxYen).toBe(3000);
  });

  it('距離を選ぶとストアへ反映される', async () => {
    await render(<FilterSheet isOpen onClose={jest.fn()} testID="filter-sheet" />);
    await fireEvent.press(screen.getByTestId('filter-sheet-distance-1000'));

    expect(useSearchFilterStore.getState().filter.distanceM).toBe(1000);
  });

  it('評価を選ぶとストアへ反映される', async () => {
    await render(<FilterSheet isOpen onClose={jest.fn()} testID="filter-sheet" />);
    await fireEvent.press(screen.getByTestId('filter-sheet-rating-5'));

    expect(useSearchFilterStore.getState().filter.minRating).toBe(5);
  });

  it('条件クリアで全部外れる', async () => {
    const state = useSearchFilterStore.getState();
    state.setBudgetMaxYen(3000);
    state.setDistanceM(1000);

    await render(<FilterSheet isOpen onClose={jest.fn()} testID="filter-sheet" />);
    await fireEvent.press(screen.getByTestId('filter-sheet-clear-button'));

    const { filter } = useSearchFilterStore.getState();
    expect(filter.budgetMaxYen).toBeNull();
    expect(filter.distanceM).toBeNull();
  });

  it('適用ボタンで閉じる', async () => {
    const handleClose = jest.fn();

    await render(<FilterSheet isOpen onClose={handleClose} testID="filter-sheet" />);
    await fireEvent.press(screen.getByTestId('filter-sheet-apply-button'));

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('件数を見出しに出す', async () => {
    useSearchFilterStore.getState().setBudgetMaxYen(3000);

    await render(<FilterSheet isOpen onClose={jest.fn()} testID="filter-sheet" />);

    expect(screen.getByText('絞り込み（1 件）')).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- filter-sheet`
Expected: FAIL（`Cannot find module './filter-sheet'`）

- [ ] **Step 6: filter-sheet.tsx を実装する**

```tsx
// apps/mobile/src/components/search/filter-sheet.tsx
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { RATING_MAX, toRating } from '@meshimap/core';
import type { Rating } from '@meshimap/core';
import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { FilterChip } from '@/components/search/filter-chip';
import {
  budgetChipLabel,
  distanceChipLabel,
  ratingChipLabel,
} from '@/components/search/filter-chip-bar';
import { Button } from '@/components/ui/button';
import { BUDGET_MAX_OPTIONS_YEN, DISTANCE_OPTIONS_M } from '@/constants/search';
import { SPACING } from '@/constants/theme';
import { countActiveFilters } from '@/lib/search-filter';
import { useSearchFilterStore } from '@/stores/search-filter';

/** シートのスナップ位置。絞り込みは一気に全部見せたいので 1 段だけ */
const FILTER_SHEET_SNAP_POINTS: (string | number)[] = ['72%'];

/** 評価の選択肢は「3 以上」「4 以上」「5」。1 と 2 は実用上選ばれない */
const MIN_SELECTABLE_RATING = 3;

export const RATING_FILTER_OPTIONS: readonly Rating[] = Array.from(
  { length: RATING_MAX - MIN_SELECTABLE_RATING + 1 },
  (_unused, index) => toRating(MIN_SELECTABLE_RATING + index),
);

const SHEET_TITLE_PREFIX = '絞り込み（';
const SHEET_TITLE_SUFFIX = ' 件）';
const BUDGET_SECTION_TITLE = '予算（ディナー上限）';
const DISTANCE_SECTION_TITLE = '現在地からの距離';
const RATING_SECTION_TITLE = '評価';
const CLEAR_LABEL = '条件をクリア';
const APPLY_LABEL = 'この条件で見る';

export interface FilterSheetProps {
  isOpen: boolean;
  onClose: () => void;
  testID?: string | undefined;
}

export function FilterSheet({ isOpen, onClose, testID }: FilterSheetProps) {
  const filter = useSearchFilterStore((state) => state.filter);
  const setBudgetMaxYen = useSearchFilterStore((state) => state.setBudgetMaxYen);
  const setDistanceM = useSearchFilterStore((state) => state.setDistanceM);
  const setMinRating = useSearchFilterStore((state) => state.setMinRating);
  const clearConditions = useSearchFilterStore((state) => state.clearConditions);

  const childTestId = useCallback(
    (suffix: string): string | undefined =>
      testID === undefined ? undefined : `${testID}-${suffix}`,
    [testID],
  );

  // 閉じているときは中身ごと外す。フィルタの状態はストアにあるので再マウントで失われない
  if (!isOpen) {
    return null;
  }

  return (
    <BottomSheet
      index={0}
      snapPoints={FILTER_SHEET_SNAP_POINTS}
      enablePanDownToClose
      onClose={onClose}
    >
      <BottomSheetScrollView contentContainerStyle={styles.content} testID={testID}>
        <Text className="font-body-bold text-lg text-neutral-900">
          {`${SHEET_TITLE_PREFIX}${countActiveFilters(filter)}${SHEET_TITLE_SUFFIX}`}
        </Text>

        <Text className="font-body-medium text-sm text-neutral-700">{BUDGET_SECTION_TITLE}</Text>
        <View style={styles.optionRow}>
          {BUDGET_MAX_OPTIONS_YEN.map((budgetMaxYen) => (
            <FilterChip
              key={budgetMaxYen}
              label={budgetChipLabel(budgetMaxYen)}
              isSelected={filter.budgetMaxYen === budgetMaxYen}
              onPress={() => {
                setBudgetMaxYen(budgetMaxYen);
              }}
              testID={childTestId(`budget-${budgetMaxYen}`)}
            />
          ))}
        </View>

        <Text className="font-body-medium text-sm text-neutral-700">{DISTANCE_SECTION_TITLE}</Text>
        <View style={styles.optionRow}>
          {DISTANCE_OPTIONS_M.map((distanceM) => (
            <FilterChip
              key={distanceM}
              label={distanceChipLabel(distanceM)}
              isSelected={filter.distanceM === distanceM}
              onPress={() => {
                setDistanceM(distanceM);
              }}
              testID={childTestId(`distance-${distanceM}`)}
            />
          ))}
        </View>

        <Text className="font-body-medium text-sm text-neutral-700">{RATING_SECTION_TITLE}</Text>
        <View style={styles.optionRow}>
          {RATING_FILTER_OPTIONS.map((minRating) => (
            <FilterChip
              key={minRating}
              label={ratingChipLabel(minRating)}
              isSelected={filter.minRating === minRating}
              onPress={() => {
                setMinRating(minRating);
              }}
              testID={childTestId(`rating-${minRating}`)}
            />
          ))}
        </View>

        <View style={styles.actionRow}>
          {/* Button は渡した testID をそのまま自身に付ける（ErrorState のように接尾辞を足さない）ため、
              テストから参照する名前をここで完成させる */}
          <Button
            label={CLEAR_LABEL}
            variant="ghost"
            onPress={clearConditions}
            testID={childTestId('clear-button')}
          />
          <Button label={APPLY_LABEL} onPress={onClose} testID={childTestId('apply-button')} />
        </View>
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.xl,
  },
  optionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
  },
  actionRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
});
```

`RATING_MIN` は使わないので import 文から外す（`noUnusedLocals` に引っかかる）。
`@/components/ui/button` の `Button` は渡された `testID` を `Pressable` にそのまま付ける実装なので、
`ErrorState`（`${testID}-retry-button`）や `EmptyState`（`${testID}-action-button`）とは接尾辞の付き方が違う。
ここでは呼び出し側で `-button` まで含めた名前を渡してテストと揃える。

Run: `npm test -w @meshimap/mobile -- filter-sheet`
Expected: PASS（9 件）

- [ ] **Step 7: わざと壊してテストが落ちることを確認する**

`toggleValue` を「常に next を返す」に変え、「営業中チップをもう一度押すと条件が外れる」が **FAIL** することを確認してから戻す。次に `FilterSheet` の `if (!isOpen) return null;` を消し、「閉じているときは中身を描画しない」が **FAIL** することも確認する。

- [ ] **Step 8: コミットする**

```bash
git add apps/mobile/src/components/search/
git commit -m "feat(mobile): 検索のフィルタチップと絞り込みシートを追加する"
```

---

### Task 6-20: キーワード検索フックと検索画面を作る

**Files:**

- Create: `apps/mobile/src/features/shops/use-search-shops.ts`
- Create: `apps/mobile/src/features/shops/use-search-shops.test.tsx`
- Create: `apps/mobile/src/components/search/search-bar.tsx`
- Create: `apps/mobile/src/components/search/search-bar.test.tsx`
- Create: `apps/mobile/src/app/(user)/(tabs)/search.tsx`
- Create: `apps/mobile/src/app/(user)/(tabs)/search.test.tsx`

**Interfaces:**

- Consumes: `@tanstack/react-query` の `useInfiniteQuery`、`@/features/shops/api` の `fetchSearchShops` / 型 `SearchShopsPage`、`@/features/shops/query-keys` の `shopKeys`、`@/constants/search` の `SEARCH_PAGE_SIZE`
- Produces:
  - `useSearchShops(filter: SearchFilter): SearchShopsResult` / 型 `SearchShopsResult` / 型 `SearchShopsStatus`
  - `SearchBar` / 型 `SearchBarProps`
  - `SearchScreen`（default export）

- [ ] **Step 1: 失敗するテストを書く（検索フック）**

```tsx
// apps/mobile/src/features/shops/use-search-shops.test.tsx
import { toShopId } from '@meshimap/core';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { EMPTY_SEARCH_FILTER } from '@/lib/search-filter';
import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildShopSummary } from '@/test-support/shop-fixtures';

import { fetchSearchShops } from './api';
import { useSearchShops } from './use-search-shops';

jest.mock('./api', () => ({ fetchSearchShops: jest.fn() }));

const fetchSearchShopsMock = jest.mocked(fetchSearchShops);

function renderSearchHook(filter = { ...EMPTY_SEARCH_FILTER, keyword: '焼き鳥' }) {
  const queryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  }
  return renderHook(() => useSearchShops(filter), { wrapper: Wrapper });
}

describe('useSearchShops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('キーワードが空のときは取得しない', async () => {
    // 全件取得は重いうえ、ユーザーが何も入れていない状態で結果を出す意味がない
    const { result } = await renderSearchHook(EMPTY_SEARCH_FILTER);

    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    expect(fetchSearchShopsMock).not.toHaveBeenCalled();
  });

  it('キーワードがあれば 1 ページ目を取得する', async () => {
    fetchSearchShopsMock.mockResolvedValue({
      shops: [buildShopSummary()],
      nextCursor: null,
      totalCount: 1,
    });

    const { result } = await renderSearchHook();

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.shops).toHaveLength(1);
    expect(result.current.totalCount).toBe(1);
    expect(fetchSearchShopsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({ keyword: '焼き鳥' }),
        cursor: null,
      }),
    );
  });

  it('次ページがあれば読み込める', async () => {
    fetchSearchShopsMock
      .mockResolvedValueOnce({
        shops: [buildShopSummary({ id: toShopId('shop-a') })],
        nextCursor: 'cursor-2',
        totalCount: 2,
      })
      .mockResolvedValueOnce({
        shops: [buildShopSummary({ id: toShopId('shop-b') })],
        nextCursor: null,
        totalCount: 2,
      });

    const { result } = await renderSearchHook();
    await waitFor(() => {
      expect(result.current.hasNextPage).toBe(true);
    });

    result.current.fetchNextPage();

    await waitFor(() => {
      expect(result.current.shops).toHaveLength(2);
    });
    expect(result.current.hasNextPage).toBe(false);
    expect(fetchSearchShopsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-2' }),
    );
  });

  it('取得に失敗したら error になる', async () => {
    fetchSearchShopsMock.mockRejectedValue(new Error('network'));

    const { result } = await renderSearchHook();

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.shops).toEqual([]);
  });

  it('フィルタが変わると別のキャッシュとして取り直す', async () => {
    fetchSearchShopsMock.mockResolvedValue({ shops: [], nextCursor: null, totalCount: 0 });

    const { result, rerender } = await renderSearchHook();
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    rerender(undefined);
    await waitFor(() => {
      expect(fetchSearchShopsMock).toHaveBeenCalled();
    });

    // 同じフィルタなら再取得しない（キャッシュが効いている）
    expect(fetchSearchShopsMock).toHaveBeenCalledTimes(1);
  });
});
```

Run: `npm test -w @meshimap/mobile -- use-search-shops`
Expected: FAIL（`Cannot find module './use-search-shops'`）

- [ ] **Step 2: use-search-shops.ts を実装する**

```ts
// apps/mobile/src/features/shops/use-search-shops.ts
import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { SearchFilter } from '@/lib/search-filter';

import { fetchSearchShops } from './api';
import { shopKeys } from './query-keys';
import type { ShopSummary } from './schema';

/** idle はキーワード未入力。loading / error / success と区別して空状態の文言を変える */
export type SearchShopsStatus = 'idle' | 'loading' | 'error' | 'success';

export interface SearchShopsResult {
  shops: readonly ShopSummary[];
  totalCount: number;
  status: SearchShopsStatus;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
}

export function useSearchShops(filter: SearchFilter): SearchShopsResult {
  // キーワードが空のときは検索そのものを走らせない
  const isEnabled = filter.keyword.trim() !== '';

  const query = useInfiniteQuery({
    queryKey: shopKeys.search(filter),
    queryFn: ({ pageParam }) => fetchSearchShops({ filter, cursor: pageParam }),
    // 1 ページ目のカーソルは null。API 側は null を「先頭から」と解釈する
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: isEnabled,
  });

  const shops = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.shops),
    [query.data],
  );

  const totalCount = query.data?.pages[0]?.totalCount ?? 0;

  const status: SearchShopsStatus = !isEnabled
    ? 'idle'
    : query.isError
      ? 'error'
      : query.isPending
        ? 'loading'
        : 'success';

  return {
    shops,
    totalCount,
    status,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => {
      // 取得中に重ねて呼ぶと同じページを 2 回引く
      if (query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    },
    refetch: () => {
      void query.refetch();
    },
  };
}
```

`shopKeys.search(filter)` は Task 6-9 で `['shops', 'search', toSearchQueryParams(filter)] as const` として定義済み。
フィルタが変われば配列の中身が変わるので、TanStack が自動的に別キャッシュとして扱う。

Run: `npm test -w @meshimap/mobile -- use-search-shops`
Expected: PASS（5 件）

- [ ] **Step 3: 失敗するテストを書く（検索バー）**

```tsx
// apps/mobile/src/components/search/search-bar.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { SearchBar } from './search-bar';

describe('SearchBar', () => {
  it('入力値を表示する', async () => {
    await render(
      <SearchBar value="焼き鳥" onChangeText={jest.fn()} onClear={jest.fn()} testID="search-bar" />,
    );

    expect(screen.getByTestId('search-bar-input').props.value).toBe('焼き鳥');
  });

  it('入力すると通知される', async () => {
    const handleChange = jest.fn();

    await render(
      <SearchBar value="" onChangeText={handleChange} onClear={jest.fn()} testID="search-bar" />,
    );
    await fireEvent.changeText(screen.getByTestId('search-bar-input'), '寿司');

    expect(handleChange).toHaveBeenCalledWith('寿司');
  });

  it('入力があるときだけクリアボタンを出す', async () => {
    await render(
      <SearchBar value="寿司" onChangeText={jest.fn()} onClear={jest.fn()} testID="search-bar" />,
    );

    expect(screen.getByTestId('search-bar-clear')).toBeOnTheScreen();
  });

  it('空のときはクリアボタンを出さない', async () => {
    await render(
      <SearchBar value="" onChangeText={jest.fn()} onClear={jest.fn()} testID="search-bar" />,
    );

    expect(screen.queryByTestId('search-bar-clear')).toBeNull();
  });

  it('クリアボタンで通知される', async () => {
    const handleClear = jest.fn();

    await render(
      <SearchBar value="寿司" onChangeText={jest.fn()} onClear={handleClear} testID="search-bar" />,
    );
    await fireEvent.press(screen.getByTestId('search-bar-clear'));

    expect(handleClear).toHaveBeenCalledTimes(1);
  });

  it('プレースホルダで何を入れるか示す', async () => {
    await render(
      <SearchBar value="" onChangeText={jest.fn()} onClear={jest.fn()} testID="search-bar" />,
    );

    expect(screen.getByPlaceholderText('店名・ジャンル・エリアで探す')).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- search-bar`
Expected: FAIL（`Cannot find module './search-bar'`）

- [ ] **Step 4: search-bar.tsx を実装する**

`@/components/ui/input` の `Input` はラベル必須のフォーム部品で、検索バーの見た目とは別物。
共通化するとどちらの責務も濁るので、検索バーは `TextInput` から組む。

```tsx
// apps/mobile/src/components/search/search-bar.tsx
import { Search, X } from 'lucide-react-native';
import { Pressable, TextInput, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { COLORS } from '@/constants/theme';

export const SEARCH_PLACEHOLDER = '店名・ジャンル・エリアで探す';

const CLEAR_ACCESSIBILITY_LABEL = '入力をクリア';
const INPUT_ACCESSIBILITY_LABEL = 'お店を検索';

export interface SearchBarProps {
  value: string;
  onChangeText: (value: string) => void;
  onClear: () => void;
  testID?: string | undefined;
}

export function SearchBar({ value, onChangeText, onClear, testID }: SearchBarProps) {
  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  return (
    <View
      testID={testID}
      className="rounded-pill mx-md flex-row items-center gap-sm border border-neutral-200 bg-white px-md py-sm"
    >
      <Icon icon={Search} size="sm" color={COLORS.neutral[500]} />
      <TextInput
        testID={childTestId('input')}
        accessibilityLabel={INPUT_ACCESSIBILITY_LABEL}
        value={value}
        onChangeText={onChangeText}
        placeholder={SEARCH_PLACEHOLDER}
        placeholderTextColor={COLORS.neutral[400]}
        // 検索語に大文字始まりの補正が入ると日本語入力の邪魔になる
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        className="flex-1 font-body text-base text-neutral-900"
      />
      {value === '' ? null : (
        <Pressable
          testID={childTestId('clear')}
          accessibilityRole="button"
          accessibilityLabel={CLEAR_ACCESSIBILITY_LABEL}
          onPress={onClear}
        >
          <Icon icon={X} size="sm" color={COLORS.neutral[500]} />
        </Pressable>
      )}
    </View>
  );
}
```

Run: `npm test -w @meshimap/mobile -- search-bar`
Expected: PASS（6 件）

- [ ] **Step 5: 失敗するテストを書く（検索画面）**

```tsx
// apps/mobile/src/app/(user)/(tabs)/search.test.tsx
import { toShopId } from '@meshimap/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { fetchSearchShops } from '@/features/shops/api';
import { useSearchFilterStore } from '@/stores/search-filter';
import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildShopSummary } from '@/test-support/shop-fixtures';

import SearchScreen from './search';

jest.mock('@/features/shops/api', () => ({ fetchSearchShops: jest.fn() }));
jest.mock('expo-router', () => ({
  router: { setParams: jest.fn(), push: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));

const fetchSearchShopsMock = jest.mocked(fetchSearchShops);

async function renderSearchScreen(): Promise<void> {
  const queryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  }
  await render(<SearchScreen />, { wrapper: Wrapper });
}

describe('SearchScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSearchFilterStore.getState().reset();
    fetchSearchShopsMock.mockResolvedValue({ shops: [], nextCursor: null, totalCount: 0 });
  });

  it('未入力のときは探し方の案内を出す', async () => {
    await renderSearchScreen();

    expect(screen.getByTestId('search-idle')).toBeOnTheScreen();
    expect(screen.getByText('キーワードを入れて探す')).toBeOnTheScreen();
  });

  it('入力するとストアへ反映される', async () => {
    await renderSearchScreen();
    await fireEvent.changeText(screen.getByTestId('search-bar-input'), '焼き鳥');

    expect(useSearchFilterStore.getState().filter.keyword).toBe('焼き鳥');
  });

  it('取得中はスケルトンを出す', async () => {
    useSearchFilterStore.getState().setKeyword('焼き鳥');

    await renderSearchScreen();

    expect(screen.getByTestId('search-skeleton')).toBeOnTheScreen();
  });

  it('0 件のときは空状態を出す', async () => {
    useSearchFilterStore.getState().setKeyword('存在しない店');

    await renderSearchScreen();

    await waitFor(() => {
      expect(screen.getByTestId('search-empty')).toBeOnTheScreen();
    });
    expect(screen.getByText('条件に合うお店が見つかりませんでした')).toBeOnTheScreen();
  });

  it('失敗したら再試行ボタンを出す', async () => {
    useSearchFilterStore.getState().setKeyword('焼き鳥');
    fetchSearchShopsMock.mockRejectedValue(new Error('network'));

    await renderSearchScreen();

    await waitFor(() => {
      expect(screen.getByTestId('search-error-retry-button')).toBeOnTheScreen();
    });
  });

  it('結果を件数つきで並べる', async () => {
    useSearchFilterStore.getState().setKeyword('焼き鳥');
    fetchSearchShopsMock.mockResolvedValue({
      shops: [buildShopSummary({ id: toShopId('shop-a'), name: 'A 亭' })],
      nextCursor: null,
      totalCount: 1,
    });

    await renderSearchScreen();

    await waitFor(() => {
      expect(screen.getByText('A 亭')).toBeOnTheScreen();
    });
    expect(screen.getByText('1 件')).toBeOnTheScreen();
  });

  it('絞り込みチップを押すとシートが開く', async () => {
    await renderSearchScreen();
    await fireEvent.press(screen.getByTestId('search-chips-more'));

    expect(screen.getByTestId('search-filter-sheet')).toBeOnTheScreen();
  });

  it('フィルタを変えると取得し直す', async () => {
    useSearchFilterStore.getState().setKeyword('焼き鳥');

    await renderSearchScreen();
    await waitFor(() => {
      expect(fetchSearchShopsMock).toHaveBeenCalledTimes(1);
    });

    await fireEvent.press(screen.getByTestId('search-chips-open-now'));

    await waitFor(() => {
      expect(fetchSearchShopsMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchSearchShopsMock.mock.calls.at(-1)?.[0].filter.isOpenNowOnly).toBe(true);
  });
});
```

Run: `npm test -w @meshimap/mobile -- "\(tabs\)/search"`
Expected: FAIL（`Cannot find module './search'`）

- [ ] **Step 6: search.tsx を実装する**

```tsx
// apps/mobile/src/app/(user)/(tabs)/search.tsx
import type { ShopId } from '@meshimap/core';
import { router } from 'expo-router';
import { Search as SearchIcon, UtensilsCrossed } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';

import { FilterChipBar } from '@/components/search/filter-chip-bar';
import { FilterSheet } from '@/components/search/filter-sheet';
import { SearchBar } from '@/components/search/search-bar';
import { SHOP_CARD_ROW_HEIGHT_PX, ShopCard } from '@/components/shop/shop-card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { SPACING } from '@/constants/theme';
import type { ShopSummary } from '@/features/shops/schema';
import { useSearchShops } from '@/features/shops/use-search-shops';
import { useSearchFilterUrlSync } from '@/hooks/use-search-filter-url-sync';
import { useSearchFilterStore } from '@/stores/search-filter';

const SKELETON_COUNT = 6;
const RESULT_COUNT_SUFFIX = ' 件';
const IDLE_TITLE = 'キーワードを入れて探す';
const IDLE_DESCRIPTION = '店名・ジャンル・エリアのどれでも検索できます。';
const EMPTY_TITLE = '条件に合うお店が見つかりませんでした';
const EMPTY_DESCRIPTION = '絞り込みを減らすか、別のキーワードをお試しください。';
const ERROR_TITLE = '検索できませんでした';
const ERROR_DESCRIPTION = '通信状況を確認して、もう一度お試しください。';

/** 末尾からこの割合まで来たら次ページを取りに行く */
const END_REACHED_THRESHOLD = 0.6;

export default function SearchScreen() {
  useSearchFilterUrlSync();

  const filter = useSearchFilterStore((state) => state.filter);
  const setKeyword = useSearchFilterStore((state) => state.setKeyword);
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);

  const { shops, totalCount, status, isFetchingNextPage, fetchNextPage, refetch } =
    useSearchShops(filter);

  const handleClearKeyword = useCallback(() => {
    setKeyword('');
  }, [setKeyword]);

  const handleOpenFilterSheet = useCallback(() => {
    setIsFilterSheetOpen(true);
  }, []);

  const handleCloseFilterSheet = useCallback(() => {
    setIsFilterSheetOpen(false);
  }, []);

  const handleSelectShop = useCallback((shopId: ShopId) => {
    router.push(`/shop/${shopId}`);
  }, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ShopSummary>) => (
      <ShopCard
        shop={item}
        // 検索結果は現在地基準の並びではないため距離は出さない（地図タブの役割）
        distanceM={null}
        isSelected={false}
        onPress={handleSelectShop}
        testID={`search-card-${item.id}`}
      />
    ),
    [handleSelectShop],
  );

  const keyExtractor = useCallback((item: ShopSummary) => item.id, []);

  const getItemLayout = useCallback(
    (_data: ArrayLike<ShopSummary> | null | undefined, index: number) => ({
      length: SHOP_CARD_ROW_HEIGHT_PX,
      offset: SHOP_CARD_ROW_HEIGHT_PX * index,
      index,
    }),
    [],
  );

  return (
    <View style={styles.container}>
      <SearchBar
        value={filter.keyword}
        onChangeText={setKeyword}
        onClear={handleClearKeyword}
        testID="search-bar"
      />

      <View style={styles.chipRow}>
        <FilterChipBar onOpenFilterSheet={handleOpenFilterSheet} testID="search-chips" />
      </View>

      {status === 'idle' ? (
        <EmptyState
          icon={SearchIcon}
          title={IDLE_TITLE}
          description={IDLE_DESCRIPTION}
          testID="search-idle"
        />
      ) : status === 'loading' ? (
        <View testID="search-skeleton" style={styles.stateContainer}>
          {Array.from({ length: SKELETON_COUNT }, (_unused, index) => (
            <Skeleton key={`skeleton-${index}`} height={SHOP_CARD_ROW_HEIGHT_PX} />
          ))}
        </View>
      ) : status === 'error' ? (
        <ErrorState
          title={ERROR_TITLE}
          description={ERROR_DESCRIPTION}
          onRetry={refetch}
          testID="search-error"
        />
      ) : shops.length === 0 ? (
        <EmptyState
          icon={UtensilsCrossed}
          title={EMPTY_TITLE}
          description={EMPTY_DESCRIPTION}
          testID="search-empty"
        />
      ) : (
        <>
          <Text
            testID="search-count"
            className="px-md py-sm font-body-medium text-sm text-neutral-600"
          >
            {`${totalCount}${RESULT_COUNT_SUFFIX}`}
          </Text>
          <FlatList
            testID="search-list"
            data={[...shops]}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            getItemLayout={getItemLayout}
            contentContainerStyle={styles.listContent}
            onEndReached={fetchNextPage}
            onEndReachedThreshold={END_REACHED_THRESHOLD}
            ListFooterComponent={
              isFetchingNextPage ? (
                <Skeleton height={SHOP_CARD_ROW_HEIGHT_PX} testID="search-next-skeleton" />
              ) : null
            }
          />
        </>
      )}

      <FilterSheet
        isOpen={isFilterSheetOpen}
        onClose={handleCloseFilterSheet}
        testID="search-filter-sheet"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: SPACING.sm,
    paddingTop: SPACING.sm,
  },
  chipRow: {
    height: 40,
  },
  stateContainer: {
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  listContent: {
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.xl,
  },
});
```

`router.push('/shop/${shopId}')` はテンプレートリテラルなので、`typedRoutes` の型が生成された後は
`Href` に合う文字列として解決される必要がある。解決できない場合は `router.push({ pathname: '/shop/[shopId]', params: { shopId } })`
の形に置き換える（→ 未確認事項）。

Run: `npm test -w @meshimap/mobile -- "\(tabs\)/search"`
Expected: PASS（8 件）

- [ ] **Step 7: わざと壊してテストが落ちることを確認する**

1. `useSearchShops` の `enabled: isEnabled` を消すと、「キーワードが空のときは取得しない」が **FAIL**。
2. `status` の `idle` 判定を消すと、「未入力のときは探し方の案内を出す」が **FAIL**。
3. `useInfiniteQuery` の `queryKey` を `shopKeys.all` 固定にすると、「フィルタを変えると取得し直す」が **FAIL**。

3 つすべてを確認してから戻す。

- [ ] **Step 8: コミットする**

```bash
git add apps/mobile/src/features/shops/use-search-shops.ts apps/mobile/src/features/shops/use-search-shops.test.tsx apps/mobile/src/components/search/search-bar.tsx apps/mobile/src/components/search/search-bar.test.tsx apps/mobile/src/app/\(user\)/\(tabs\)/search.tsx apps/mobile/src/app/\(user\)/\(tabs\)/search.test.tsx
git commit -m "feat(mobile): キーワード検索の画面とフックを追加する"
```

---

### Task 6-21: 店舗詳細の取得フックを作る

**Files:**

- Create: `apps/mobile/src/features/shops/use-shop-detail.ts`
- Create: `apps/mobile/src/features/shops/use-shop-detail.test.tsx`

**Interfaces:**

- Consumes: `@tanstack/react-query` の `useQuery`、`@/features/shops/api` の `fetchShopDetail`、`@/features/shops/query-keys` の `shopKeys`、`@/lib/shop-open-status` の `shopOpenStatus` / `shopClosesInMinutes`
- Produces: `useShopDetail(shopId: ShopId, now: Date): ShopDetailResult` / 型 `ShopDetailResult` / 型 `ShopDetailStatus`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/features/shops/use-shop-detail.test.tsx
import { toShopId } from '@meshimap/core';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildShopDetail } from '@/test-support/shop-fixtures';

import { fetchShopDetail } from './api';
import { useShopDetail } from './use-shop-detail';

jest.mock('./api', () => ({ fetchShopDetail: jest.fn() }));

const fetchShopDetailMock = jest.mocked(fetchShopDetail);

const SHOP_ID = toShopId('shop-001');

/** 2026-09-15（火）19:00 JST = 10:00 UTC */
const TUESDAY_EVENING = new Date(Date.UTC(2026, 8, 15, 10, 0));

function renderDetailHook(now: Date = TUESDAY_EVENING) {
  const queryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  }
  return renderHook(() => useShopDetail(SHOP_ID, now), { wrapper: Wrapper });
}

describe('useShopDetail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('最初は loading', async () => {
    fetchShopDetailMock.mockReturnValue(new Promise(() => {}));

    const { result } = await renderDetailHook();

    expect(result.current.status).toBe('loading');
    expect(result.current.shop).toBeNull();
  });

  it('取得できたら詳細を返す', async () => {
    fetchShopDetailMock.mockResolvedValue(buildShopDetail());

    const { result } = await renderDetailHook();

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.shop?.name).toBe('炭火焼鳥 とりまる');
    expect(fetchShopDetailMock).toHaveBeenCalledWith(SHOP_ID);
  });

  it('営業時間から算出した営業状態を添える', async () => {
    // API の openStatus は取得時点の値なので、画面に長く留まると古くなる。
    // 詳細では hours / closures から毎レンダリング計算し直す
    fetchShopDetailMock.mockResolvedValue(
      buildShopDetail({
        openStatus: 'open',
        hours: [{ dayOfWeek: 2, openMinute: 1020, closeMinute: 1500, isClosed: false }],
      }),
    );

    const { result } = await renderDetailHook();

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.openStatus).toBe('open');
    expect(result.current.closesInMinutes).toBe(360);
  });

  it('営業時間外なら closed になり残り分は null', async () => {
    fetchShopDetailMock.mockResolvedValue(
      buildShopDetail({
        hours: [{ dayOfWeek: 2, openMinute: 1020, closeMinute: 1500, isClosed: false }],
      }),
    );

    // JST 10:00 = UTC 01:00
    const { result } = await renderDetailHook(new Date(Date.UTC(2026, 8, 15, 1, 0)));

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.openStatus).toBe('closed');
    expect(result.current.closesInMinutes).toBeNull();
  });

  it('失敗したら error になる', async () => {
    fetchShopDetailMock.mockRejectedValue(new Error('not found'));

    const { result } = await renderDetailHook();

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.shop).toBeNull();
    expect(result.current.openStatus).toBeNull();
  });

  it('再試行できる', async () => {
    fetchShopDetailMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(buildShopDetail());

    const { result } = await renderDetailHook();
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    result.current.refetch();

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
  });
});
```

Run: `npm test -w @meshimap/mobile -- use-shop-detail`
Expected: FAIL（`Cannot find module './use-shop-detail'`）

- [ ] **Step 2: use-shop-detail.ts を実装する**

```ts
// apps/mobile/src/features/shops/use-shop-detail.ts
import type { OpenStatus, ShopId } from '@meshimap/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { shopClosesInMinutes, shopOpenStatus } from '@/lib/shop-open-status';

import { fetchShopDetail } from './api';
import { shopKeys } from './query-keys';
import type { ShopDetail } from './schema';

export type ShopDetailStatus = 'loading' | 'error' | 'success';

export interface ShopDetailResult {
  shop: ShopDetail | null;
  /** hours / closures から now 時点で計算し直した営業状態。未取得なら null */
  openStatus: OpenStatus | null;
  closesInMinutes: number | null;
  status: ShopDetailStatus;
  refetch: () => void;
}

/**
 * 店舗詳細を取得する。
 * now を引数に取るのはテストのためだけではなく、
 * 「画面を開いたまま閉店時刻をまたぐ」ケースで呼び出し側が時計を進められるようにするため。
 */
export function useShopDetail(shopId: ShopId, now: Date): ShopDetailResult {
  const query = useQuery({
    queryKey: shopKeys.detail(shopId),
    queryFn: () => fetchShopDetail(shopId),
  });

  const shop = query.data ?? null;

  // 一覧の openStatus はサーバーが返した取得時点の値。詳細では手元の営業時間から出し直す
  const openStatus = useMemo(() => (shop === null ? null : shopOpenStatus(shop, now)), [shop, now]);
  const closesInMinutes = useMemo(
    () => (shop === null ? null : shopClosesInMinutes(shop, now)),
    [shop, now],
  );

  const status: ShopDetailStatus = query.isError
    ? 'error'
    : query.isPending
      ? 'loading'
      : 'success';

  return {
    shop,
    openStatus,
    closesInMinutes,
    status,
    refetch: () => {
      void query.refetch();
    },
  };
}
```

Run: `npm test -w @meshimap/mobile -- use-shop-detail`
Expected: PASS（6 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`openStatus` を `shop?.openStatus ?? null`（API の値をそのまま返す形）に変え、「営業時間外なら closed になり残り分は null」が **FAIL** することを確認してから戻す。

- [ ] **Step 4: コミットする**

```bash
git add apps/mobile/src/features/shops/use-shop-detail.ts apps/mobile/src/features/shops/use-shop-detail.test.tsx
git commit -m "feat(mobile): 店舗詳細の取得フックを追加する"
```

---

### Task 6-22: スクロール連動ヘッダーを作る

**Files:**

- Create: `apps/mobile/src/lib/collapsing-header.ts`
- Create: `apps/mobile/src/lib/collapsing-header.test.ts`
- Create: `apps/mobile/src/components/shop/shop-hero-header.tsx`
- Create: `apps/mobile/src/components/shop/shop-hero-header.test.tsx`
- Create: `apps/mobile/src/components/shop/shop-header-bar.tsx`
- Create: `apps/mobile/src/components/shop/shop-header-bar.test.tsx`

**Interfaces:**

- Consumes: `react-native-reanimated` の `default as Animated` / `useAnimatedStyle` / `useSharedValue` / 型 `SharedValue`、`expo-image` の `Image`、`@/components/ui/icon`、`lucide-react-native` の `ChevronLeft` / `ImageOff`
- Produces:
  - `HERO_HEIGHT_PX` / `HEADER_COLLAPSED_HEIGHT_PX` / `HERO_SCROLL_RANGE_PX`
  - `heroTranslateY(offsetY: number): number`
  - `heroScale(offsetY: number): number`
  - `headerBarOpacity(offsetY: number): number`
  - `heroOverlayOpacity(offsetY: number): number`
  - `ShopHeroHeader` / 型 `ShopHeroHeaderProps`
  - `ShopHeaderBar` / 型 `ShopHeaderBarProps`

- [ ] **Step 1: 失敗するテストを書く（計算）**

Reanimated のモックでは `interpolate` が `undefined` を返す（`node_modules/react-native-reanimated/src/mock.ts` の `interpolation.interpolate: NOOP`）。
よって補間は自前で書く。書いた分そのままテストできるので、むしろ都合が良い。

```ts
// apps/mobile/src/lib/collapsing-header.test.ts
import {
  HEADER_COLLAPSED_HEIGHT_PX,
  HERO_HEIGHT_PX,
  HERO_SCROLL_RANGE_PX,
  headerBarOpacity,
  heroOverlayOpacity,
  heroScale,
  heroTranslateY,
} from './collapsing-header';

describe('定数', () => {
  it('スクロール範囲はヒーローと固定ヘッダーの差になっている', () => {
    expect(HERO_SCROLL_RANGE_PX).toBe(HERO_HEIGHT_PX - HEADER_COLLAPSED_HEIGHT_PX);
  });
});

describe('heroTranslateY', () => {
  it('先頭では動かさない', () => {
    expect(heroTranslateY(0)).toBe(0);
  });

  it('下へ引っ張ったぶんは追従させる（パララックス）', () => {
    // 引っ張り量の半分だけ動かすと、画像が伸びる感覚になる
    expect(heroTranslateY(-100)).toBe(-50);
  });

  it('上へスクロールすると半分の速さで上へ逃がす', () => {
    expect(heroTranslateY(100)).toBe(50);
  });

  it('スクロール範囲を超えても動き続けない', () => {
    // 固定ヘッダーの裏へ潜り込ませすぎると、戻したときに白い帯が出る
    expect(heroTranslateY(HERO_SCROLL_RANGE_PX + 500)).toBe(HERO_SCROLL_RANGE_PX / 2);
  });
});

describe('heroScale', () => {
  it('先頭では等倍', () => {
    expect(heroScale(0)).toBe(1);
  });

  it('下へ引っ張ると拡大する', () => {
    // 100px 引っ張ったら 100 / HERO_HEIGHT_PX ぶん拡大する
    expect(heroScale(-HERO_HEIGHT_PX)).toBeCloseTo(2, 5);
  });

  it('上へスクロールしても縮小はしない', () => {
    // 縮むと画像の左右に隙間ができる
    expect(heroScale(200)).toBe(1);
  });
});

describe('headerBarOpacity', () => {
  it('先頭では透明', () => {
    expect(headerBarOpacity(0)).toBe(0);
  });

  it('スクロール範囲の半分でおよそ半分の濃さになる', () => {
    expect(headerBarOpacity(HERO_SCROLL_RANGE_PX / 2)).toBeCloseTo(0.5, 5);
  });

  it('スクロール範囲を超えたら不透明で止まる', () => {
    expect(headerBarOpacity(HERO_SCROLL_RANGE_PX + 300)).toBe(1);
  });

  it('下へ引っ張っても負にならない', () => {
    expect(headerBarOpacity(-200)).toBe(0);
  });
});

describe('heroOverlayOpacity', () => {
  it('先頭でも最低限の暗さを持つ', () => {
    // 白い写真の上に白文字を置くと読めなくなる
    expect(heroOverlayOpacity(0)).toBeCloseTo(0.25, 5);
  });

  it('スクロールするほど濃くなる', () => {
    expect(heroOverlayOpacity(HERO_SCROLL_RANGE_PX)).toBeCloseTo(0.6, 5);
  });

  it('範囲を超えても濃くなり続けない', () => {
    expect(heroOverlayOpacity(HERO_SCROLL_RANGE_PX * 3)).toBeCloseTo(0.6, 5);
  });
});
```

Run: `npm test -w @meshimap/mobile -- collapsing-header`
Expected: FAIL（`Cannot find module './collapsing-header'`）

- [ ] **Step 2: collapsing-header.ts を実装する**

```ts
// apps/mobile/src/lib/collapsing-header.ts
/**
 * 店舗詳細のスクロール連動ヘッダーの計算。
 *
 * すべて worklet として UI スレッドで走らせるため、モジュールの外部状態を参照しない
 * 純関数にしている。純関数なので Jest からも普通に呼べる。
 * Reanimated のテスト用モックは interpolate を no-op にしていて undefined を返すため、
 * 補間は自前で書く。
 */

/** ヒーロー画像の高さ（px） */
export const HERO_HEIGHT_PX = 280;

/** 縮み切ったときのヘッダーバーの高さ（px）。ステータスバー下の標準的な高さ */
export const HEADER_COLLAPSED_HEIGHT_PX = 88;

/** ヘッダーが縮み切るまでのスクロール量（px） */
export const HERO_SCROLL_RANGE_PX = HERO_HEIGHT_PX - HEADER_COLLAPSED_HEIGHT_PX;

/** 画像がスクロールに追従する割合。1 未満にすると奥にあるように見える */
const PARALLAX_RATIO = 0.5;

/** 先頭でも掛けておく黒オーバーレイの濃さ。白い写真の上の白文字を読ませるため */
const OVERLAY_OPACITY_MIN = 0.25;

/** 縮み切ったときのオーバーレイの濃さ */
const OVERLAY_OPACITY_MAX = 0.6;

/** 値を範囲内に収める。Reanimated の clamp はモックが no-op なので自前で持つ */
function clampValue(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(max, Math.max(min, value));
}

/** 0〜1 の進捗。offsetY が負（下へ引っ張っている）のときは 0 */
function scrollProgress(offsetY: number): number {
  'worklet';
  return clampValue(offsetY / HERO_SCROLL_RANGE_PX, 0, 1);
}

/**
 * ヒーロー画像の縦移動量。
 * 下へ引っ張ったぶんも半分だけ追従させると、画像が引き伸ばされる感覚になる。
 */
export function heroTranslateY(offsetY: number): number {
  'worklet';
  // 縮み切ったあとも動かし続けると固定ヘッダーの裏へ潜りすぎる
  return clampValue(offsetY, -HERO_HEIGHT_PX, HERO_SCROLL_RANGE_PX) * PARALLAX_RATIO;
}

/** 下へ引っ張った量に応じて拡大する。上スクロール時は等倍のまま */
export function heroScale(offsetY: number): number {
  'worklet';
  if (offsetY >= 0) {
    return 1;
  }
  return 1 + Math.min(-offsetY, HERO_HEIGHT_PX) / HERO_HEIGHT_PX;
}

/** 固定ヘッダーバーの不透明度。スクロールし切ると完全に不透明になる */
export function headerBarOpacity(offsetY: number): number {
  'worklet';
  return scrollProgress(offsetY);
}

/** ヒーロー上の黒オーバーレイの濃さ */
export function heroOverlayOpacity(offsetY: number): number {
  'worklet';
  return (
    OVERLAY_OPACITY_MIN + (OVERLAY_OPACITY_MAX - OVERLAY_OPACITY_MIN) * scrollProgress(offsetY)
  );
}
```

Run: `npm test -w @meshimap/mobile -- collapsing-header`
Expected: PASS（15 件）

- [ ] **Step 3: 失敗するテストを書く（ヒーローと固定バー）**

部品は 2 つに分ける。

| 部品             | 置き場所                      | 役割                                       |
| ---------------- | ----------------------------- | ------------------------------------------ |
| `ShopHeroHeader` | ScrollView の**中**の先頭     | 写真・パララックス・大きな店名             |
| `ShopHeaderBar`  | ScrollView の**上**に絶対配置 | 戻るボタンと、縮んだときに現れる不透明バー |

1 つのコンポーネントにまとめると重なり順が破綻する。ヒーローを ScrollView の外に絶対配置すると
本文がヒーローの裏へ潜り、逆に固定バーを ScrollView の中に入れるとバーが一緒に流れていくため。
スクロール量は `useAnimatedScrollHandler` が `NOOP_FACTORY` でテストから駆動できないので、
どちらも `SharedValue` を props で受け取る形にしてテスト可能にする。

```tsx
// apps/mobile/src/components/shop/shop-hero-header.test.tsx
import { render, screen } from '@testing-library/react-native';
import { useSharedValue } from 'react-native-reanimated';

import { HERO_HEIGHT_PX, HERO_SCROLL_RANGE_PX } from '@/lib/collapsing-header';

import { ShopHeroHeader } from './shop-hero-header';

/** SharedValue をテストから固定値で用意するためのラッパ */
function Harness({
  offsetY,
  photoUrl = 'https://cdn.example.test/shops/001/cover.jpg',
}: {
  offsetY: number;
  photoUrl?: string | null;
}) {
  const scrollY = useSharedValue(offsetY);
  return (
    <ShopHeroHeader title="炭火焼鳥 とりまる" photoUrl={photoUrl} scrollY={scrollY} testID="hero" />
  );
}

describe('ShopHeroHeader', () => {
  it('写真を表示する', async () => {
    await render(<Harness offsetY={0} />);

    expect(screen.getByTestId('hero-photo')).toBeOnTheScreen();
  });

  it('写真が無いときはプレースホルダを出す', async () => {
    await render(<Harness offsetY={0} photoUrl={null} />);

    expect(screen.queryByTestId('hero-photo')).toBeNull();
    expect(screen.getByTestId('hero-photo-placeholder')).toBeOnTheScreen();
  });

  it('ヒーローの高さは固定', async () => {
    // ScrollView の中で場所を占めるので、高さが揺れると本文の開始位置が動く
    await render(<Harness offsetY={0} />);

    expect(screen.getByTestId('hero')).toHaveStyle({ height: HERO_HEIGHT_PX });
  });

  it('先頭では写真を動かさない', async () => {
    await render(<Harness offsetY={0} />);

    expect(screen.getByTestId('hero-photo-layer')).toHaveStyle({
      transform: [{ translateY: 0 }, { scale: 1 }],
    });
  });

  it('スクロールすると写真が半分の速さで追従する', async () => {
    await render(<Harness offsetY={HERO_SCROLL_RANGE_PX} />);

    expect(screen.getByTestId('hero-photo-layer')).toHaveStyle({
      transform: [{ translateY: HERO_SCROLL_RANGE_PX / 2 }, { scale: 1 }],
    });
  });

  it('下へ引っ張ると写真が拡大する', async () => {
    await render(<Harness offsetY={-HERO_HEIGHT_PX} />);

    expect(screen.getByTestId('hero-photo-layer')).toHaveStyle({
      transform: [{ translateY: -HERO_HEIGHT_PX / 2 }, { scale: 2 }],
    });
  });

  it('先頭でも黒オーバーレイを敷く', async () => {
    // 白い写真の上に白文字を置くと読めなくなる
    await render(<Harness offsetY={0} />);

    expect(screen.getByTestId('hero-overlay')).toHaveStyle({ opacity: 0.25 });
  });

  it('スクロールするとオーバーレイが濃くなる', async () => {
    await render(<Harness offsetY={HERO_SCROLL_RANGE_PX} />);

    expect(screen.getByTestId('hero-overlay')).toHaveStyle({ opacity: 0.6 });
  });

  it('店名を表示する', async () => {
    await render(<Harness offsetY={0} />);

    expect(screen.getByText('炭火焼鳥 とりまる')).toBeOnTheScreen();
  });
});
```

```tsx
// apps/mobile/src/components/shop/shop-header-bar.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { useSharedValue } from 'react-native-reanimated';

import { HEADER_COLLAPSED_HEIGHT_PX, HERO_SCROLL_RANGE_PX } from '@/lib/collapsing-header';

import { ShopHeaderBar } from './shop-header-bar';

function Harness({ offsetY, onBack = jest.fn() }: { offsetY: number; onBack?: () => void }) {
  const scrollY = useSharedValue(offsetY);
  return <ShopHeaderBar title="炭火焼鳥 とりまる" scrollY={scrollY} onBack={onBack} testID="bar" />;
}

describe('ShopHeaderBar', () => {
  it('先頭では背景が透明', async () => {
    await render(<Harness offsetY={0} />);

    expect(screen.getByTestId('bar-background')).toHaveStyle({ opacity: 0 });
  });

  it('スクロールし切ると背景が不透明になる', async () => {
    await render(<Harness offsetY={HERO_SCROLL_RANGE_PX} />);

    expect(screen.getByTestId('bar-background')).toHaveStyle({ opacity: 1 });
  });

  it('先頭では固定ヘッダーの店名を隠す', async () => {
    // 写真の上に大きく店名が出ているので、同じ文字列が 2 つ見えるのは冗長
    await render(<Harness offsetY={0} />);

    expect(screen.getByTestId('bar-title')).toHaveStyle({ opacity: 0 });
  });

  it('スクロールし切ると固定ヘッダーに店名が出る', async () => {
    await render(<Harness offsetY={HERO_SCROLL_RANGE_PX} />);

    expect(screen.getByTestId('bar-title')).toHaveStyle({ opacity: 1 });
  });

  it('高さは縮んだ状態のヘッダー高で固定', async () => {
    await render(<Harness offsetY={0} />);

    expect(screen.getByTestId('bar')).toHaveStyle({ height: HEADER_COLLAPSED_HEIGHT_PX });
  });

  it('戻るボタンを押すと通知される', async () => {
    const handleBack = jest.fn();

    await render(<Harness offsetY={0} onBack={handleBack} />);
    await fireEvent.press(screen.getByTestId('bar-back'));

    expect(handleBack).toHaveBeenCalledTimes(1);
  });

  it('戻るボタンはスクロール位置にかかわらず押せる', async () => {
    const handleBack = jest.fn();

    await render(<Harness offsetY={HERO_SCROLL_RANGE_PX * 2} onBack={handleBack} />);
    await fireEvent.press(screen.getByTestId('bar-back'));

    expect(handleBack).toHaveBeenCalledTimes(1);
  });

  it('戻るボタンにラベルを付ける', async () => {
    await render(<Harness offsetY={0} />);

    expect(screen.getByLabelText('前の画面へ戻る')).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- shop-hero-header shop-header-bar`
Expected: FAIL（`Cannot find module './shop-hero-header'`）

`useAnimatedStyle` はモックでコールバックを即時実行し、戻り値のスタイルオブジェクトをそのまま返す
（`node_modules/react-native-reanimated/src/mock.ts` の `IMMEDIATE_CALLBACK_INVOCATION`）。
`useSharedValue` は `.value` が読み書きできる Proxy を返すので、ラッパで値を先に確定させれば
`toHaveStyle` でアニメーション結果を検証できる。

- [ ] **Step 4: 2 つのコンポーネントを実装する**

```tsx
// apps/mobile/src/components/shop/shop-hero-header.tsx
import { Image } from 'expo-image';
import { ImageOff } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import { Icon } from '@/components/ui/icon';
import { COLORS, FONT_SIZES, SPACING } from '@/constants/theme';
import {
  HERO_HEIGHT_PX,
  heroOverlayOpacity,
  heroScale,
  heroTranslateY,
} from '@/lib/collapsing-header';

const IMAGE_TRANSITION_MS = 200;

export interface ShopHeroHeaderProps {
  title: string;
  photoUrl: string | null;
  /** スクロール量。画面側の useAnimatedScrollHandler から渡す */
  scrollY: SharedValue<number>;
  testID?: string | undefined;
}

/**
 * ScrollView の中の先頭に置くヒーロー。
 * 通常フローで高さ HERO_HEIGHT_PX を占めるので、本文は自然にこの下から始まる。
 * 固定バーは別コンポーネント（ShopHeaderBar）が ScrollView の上に重ねる。
 */
export function ShopHeroHeader({ title, photoUrl, scrollY, testID }: ShopHeroHeaderProps) {
  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  const photoStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: heroTranslateY(scrollY.value) }, { scale: heroScale(scrollY.value) }],
  }));

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: heroOverlayOpacity(scrollY.value),
  }));

  return (
    <View testID={testID} style={styles.container}>
      <Animated.View testID={childTestId('photo-layer')} style={[styles.photoLayer, photoStyle]}>
        {photoUrl === null ? (
          <View testID={childTestId('photo-placeholder')} style={styles.photoPlaceholder}>
            <Icon icon={ImageOff} size="lg" color={COLORS.neutral[400]} />
          </View>
        ) : (
          <Image
            testID={childTestId('photo')}
            source={photoUrl}
            contentFit="cover"
            transition={IMAGE_TRANSITION_MS}
            style={styles.photo}
          />
        )}
      </Animated.View>

      {/* 黒オーバーレイ。白文字の可読性を確保する */}
      <Animated.View
        testID={childTestId('overlay')}
        style={[styles.overlay, overlayStyle]}
        pointerEvents="none"
      />

      <Text numberOfLines={2} style={styles.heroTitle}>
        {title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: HERO_HEIGHT_PX,
    // 拡大した写真がはみ出さないように切る
    overflow: 'hidden',
    backgroundColor: COLORS.neutral[200],
  },
  photoLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  photoPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.neutral[200],
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.neutral[900],
  },
  heroTitle: {
    position: 'absolute',
    bottom: SPACING.md,
    left: SPACING.md,
    right: SPACING.md,
    color: COLORS.white,
    fontSize: FONT_SIZES.xxl,
  },
});
```

```tsx
// apps/mobile/src/components/shop/shop-header-bar.tsx
import { ChevronLeft } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import { Icon } from '@/components/ui/icon';
import { COLORS, FONT_SIZES, RADIUS, SPACING, Z_INDEX } from '@/constants/theme';
import { HEADER_COLLAPSED_HEIGHT_PX, headerBarOpacity } from '@/lib/collapsing-header';

const BACK_ACCESSIBILITY_LABEL = '前の画面へ戻る';

export interface ShopHeaderBarProps {
  title: string;
  scrollY: SharedValue<number>;
  onBack: () => void;
  testID?: string | undefined;
}

/**
 * ScrollView の上に絶対配置する固定ヘッダー。
 * 戻るボタンは常に押せる必要があるので、背景の不透明度とは独立したレイヤーに置く。
 */
export function ShopHeaderBar({ title, scrollY, onBack, testID }: ShopHeaderBarProps) {
  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  const backgroundStyle = useAnimatedStyle(() => ({
    opacity: headerBarOpacity(scrollY.value),
  }));

  const titleStyle = useAnimatedStyle(() => ({
    opacity: headerBarOpacity(scrollY.value),
  }));

  return (
    <View testID={testID} style={styles.container} pointerEvents="box-none">
      <Animated.View
        testID={childTestId('background')}
        style={[styles.background, backgroundStyle]}
        pointerEvents="none"
      />

      <View style={styles.content} pointerEvents="box-none">
        <Pressable
          testID={childTestId('back')}
          accessibilityRole="button"
          accessibilityLabel={BACK_ACCESSIBILITY_LABEL}
          onPress={onBack}
          style={styles.backButton}
        >
          <Icon icon={ChevronLeft} size="md" color={COLORS.white} />
        </Pressable>

        <Animated.Text
          testID={childTestId('title')}
          numberOfLines={1}
          style={[styles.title, titleStyle]}
        >
          {title}
        </Animated.Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: HEADER_COLLAPSED_HEIGHT_PX,
    zIndex: Z_INDEX.mapOverlayButton,
  },
  background: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.primary[500],
  },
  content: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: SPACING.sm,
    paddingBottom: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  backButton: {
    padding: SPACING.xs,
    borderRadius: RADIUS.pill,
    // 明るい写真の上でも矢印が見えるよう、常に暗い円を敷く
    backgroundColor: 'rgba(26, 23, 20, 0.45)',
  },
  title: {
    flex: 1,
    color: COLORS.white,
    fontSize: FONT_SIZES.lg,
  },
});
```

`Animated.View` / `Animated.Text` はモックでは RN の `View` / `Text` に差し替わる
（`node_modules/react-native-reanimated/src/mock.ts` の `Animated.View: ViewRN` / `Animated.Text: TextRN`）。
`style` 配列はそのまま渡るので `toHaveStyle` が効く。
`className` は使わない。Reanimated のコンポーネントは NativeWind の cssInterop に登録されていないため。

Run: `npm test -w @meshimap/mobile -- shop-hero-header shop-header-bar`
Expected: PASS（9 件 + 8 件）

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`clampValue` の上限を外し（`Math.max(min, value)` だけにする）、「スクロール範囲を超えたら不透明で止まる」が **FAIL** することを確認してから戻す。次に `heroScale` の `offsetY >= 0` の早期 return を消し、「上へスクロールしても縮小はしない」が **FAIL** することも確認する。

- [ ] **Step 6: コミットする**

```bash
git add apps/mobile/src/lib/collapsing-header.ts apps/mobile/src/lib/collapsing-header.test.ts apps/mobile/src/components/shop/shop-hero-header.tsx apps/mobile/src/components/shop/shop-hero-header.test.tsx apps/mobile/src/components/shop/shop-header-bar.tsx apps/mobile/src/components/shop/shop-header-bar.test.tsx
git commit -m "feat(mobile): スクロール連動ヘッダーを追加する"
```

---

### Task 6-23: 評価分布グラフを作る

**Files:**

- Create: `apps/mobile/src/components/chart/rating-distribution.ts`
- Create: `apps/mobile/src/components/chart/rating-distribution.test.ts`
- Create: `apps/mobile/src/components/chart/rating-distribution-chart.tsx`
- Create: `apps/mobile/src/components/chart/rating-distribution-chart.test.tsx`

**Interfaces:**

- Consumes: `react-native-svg` の `default as Svg` / `Rect`、`@meshimap/core` の 型 `Rating` `RatingDistribution`、`@/features/shops/schema` の `RATING_VALUES`
- Produces:
  - `ratingBars(distribution: RatingDistribution, trackWidthPx: number): readonly RatingBar[]` / 型 `RatingBar`
  - `totalRatingCount(distribution: RatingDistribution): number`
  - `RatingDistributionChart` / 型 `RatingDistributionChartProps`
  - `RATING_BAR_HEIGHT_PX` / `RATING_BAR_GAP_PX` / `RATING_CHART_HEIGHT_PX`

- [ ] **Step 1: 失敗するテストを書く（計算）**

グラフの見た目は SVG 要素になるため、寸法の検証は純関数側で全部やる。
`react-native-svg` の要素に付けた `testID` がテスト環境のツリーに出るかは未検証なので、そこに依存しない設計にする。

```ts
// apps/mobile/src/components/chart/rating-distribution.test.ts
import type { RatingDistribution } from '@meshimap/core';

import {
  RATING_BAR_GAP_PX,
  RATING_BAR_HEIGHT_PX,
  RATING_CHART_HEIGHT_PX,
  ratingBars,
  totalRatingCount,
} from './rating-distribution';

const DISTRIBUTION: RatingDistribution = { 1: 2, 2: 4, 3: 14, 4: 48, 5: 60 };
const EMPTY_DISTRIBUTION: RatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

const TRACK_WIDTH_PX = 200;

describe('totalRatingCount', () => {
  it('全ての星の件数を足す', () => {
    expect(totalRatingCount(DISTRIBUTION)).toBe(128);
  });

  it('0 件なら 0', () => {
    expect(totalRatingCount(EMPTY_DISTRIBUTION)).toBe(0);
  });
});

describe('ratingBars', () => {
  it('星 5 から星 1 の順に 5 本返す', () => {
    // 上から 5 → 1 の並びが一般的な評価分布の見せ方
    expect(ratingBars(DISTRIBUTION, TRACK_WIDTH_PX).map((bar) => bar.rating)).toEqual([
      5, 4, 3, 2, 1,
    ]);
  });

  it('件数をそのまま持つ', () => {
    const [top] = ratingBars(DISTRIBUTION, TRACK_WIDTH_PX);

    expect(top?.count).toBe(60);
  });

  it('最多の星がトラック幅いっぱいになる', () => {
    // 総数比にすると最多でも半分以下になり、差が読み取りにくい
    const [top] = ratingBars(DISTRIBUTION, TRACK_WIDTH_PX);

    expect(top?.widthPx).toBe(TRACK_WIDTH_PX);
  });

  it('幅は最多件数に対する比になる', () => {
    const bars = ratingBars(DISTRIBUTION, TRACK_WIDTH_PX);
    const fourStar = bars.find((bar) => bar.rating === 4);

    // 48 / 60 * 200 = 160
    expect(fourStar?.widthPx).toBeCloseTo(160, 5);
  });

  it('割合は総数に対する比で返す', () => {
    const bars = ratingBars(DISTRIBUTION, TRACK_WIDTH_PX);
    const fiveStar = bars.find((bar) => bar.rating === 5);

    // 60 / 128 = 0.46875
    expect(fiveStar?.ratio).toBeCloseTo(0.46875, 5);
  });

  it('0 件のときは全て幅 0 になり NaN を出さない', () => {
    const bars = ratingBars(EMPTY_DISTRIBUTION, TRACK_WIDTH_PX);

    for (const bar of bars) {
      expect(bar.widthPx).toBe(0);
      expect(bar.ratio).toBe(0);
    }
  });

  it('縦位置は上から順に等間隔になる', () => {
    const bars = ratingBars(DISTRIBUTION, TRACK_WIDTH_PX);

    expect(bars[0]?.y).toBe(0);
    expect(bars[1]?.y).toBe(RATING_BAR_HEIGHT_PX + RATING_BAR_GAP_PX);
    expect(bars[4]?.y).toBe((RATING_BAR_HEIGHT_PX + RATING_BAR_GAP_PX) * 4);
  });

  it('トラック幅が 0 でも壊れない', () => {
    // 初回レンダリングの onLayout 前は幅が 0 で来る
    expect(ratingBars(DISTRIBUTION, 0).every((bar) => bar.widthPx === 0)).toBe(true);
  });
});

describe('RATING_CHART_HEIGHT_PX', () => {
  it('5 本ぶんの高さと 4 つの隙間の合計になる', () => {
    expect(RATING_CHART_HEIGHT_PX).toBe(RATING_BAR_HEIGHT_PX * 5 + RATING_BAR_GAP_PX * 4);
  });
});
```

Run: `npm test -w @meshimap/mobile -- chart/rating-distribution.test`
Expected: FAIL（`Cannot find module './rating-distribution'`）

- [ ] **Step 2: rating-distribution.ts を実装する**

```ts
// apps/mobile/src/components/chart/rating-distribution.ts
import type { Rating, RatingDistribution } from '@meshimap/core';

import { RATING_VALUES } from '@/features/shops/schema';

/** 棒 1 本の高さ（px） */
export const RATING_BAR_HEIGHT_PX = 10;

/** 棒の間隔（px） */
export const RATING_BAR_GAP_PX = 6;

/** 星の段数。core の RATING_MIN / RATING_MAX を変えたら自動で追随する */
const RATING_STEP_COUNT = RATING_VALUES.length;

/** グラフ全体の高さ（px）。SVG の height にそのまま使う */
export const RATING_CHART_HEIGHT_PX =
  RATING_BAR_HEIGHT_PX * RATING_STEP_COUNT + RATING_BAR_GAP_PX * (RATING_STEP_COUNT - 1);

export interface RatingBar {
  readonly rating: Rating;
  readonly count: number;
  /** 総数に対する割合（0〜1）。ラベルの「◯%」に使う */
  readonly ratio: number;
  /** 描画する棒の幅（px） */
  readonly widthPx: number;
  /** SVG 内の y 座標（px） */
  readonly y: number;
}

export function totalRatingCount(distribution: RatingDistribution): number {
  return RATING_VALUES.reduce((total, rating) => total + distribution[rating], 0);
}

/**
 * 評価分布を棒グラフの描画パラメータへ変換する。
 *
 * 幅は「最多件数に対する比」で出す。総数に対する比にすると、評価が 1 つの星に
 * 集中していない店で全部の棒が短くなり、どの星が多いのか読み取れなくなるため。
 * 一方ラベル用の割合（ratio）は総数比でないと意味が通らないので、別の値として返す。
 */
export function ratingBars(
  distribution: RatingDistribution,
  trackWidthPx: number,
): readonly RatingBar[] {
  const total = totalRatingCount(distribution);
  const maxCount = RATING_VALUES.reduce((max, rating) => Math.max(max, distribution[rating]), 0);
  // 最多が 0（＝レビュー 0 件）でも 0 除算しない
  const safeMaxCount = maxCount === 0 ? 1 : maxCount;
  const safeTotal = total === 0 ? 1 : total;

  // 星 5 を先頭にするため降順に並べ替える
  const descendingRatings = [...RATING_VALUES].sort((left, right) => right - left);

  return descendingRatings.map((rating, index) => {
    const count = distribution[rating];
    return {
      rating,
      count,
      ratio: total === 0 ? 0 : count / safeTotal,
      widthPx: (count / safeMaxCount) * trackWidthPx,
      y: (RATING_BAR_HEIGHT_PX + RATING_BAR_GAP_PX) * index,
    };
  });
}
```

Run: `npm test -w @meshimap/mobile -- chart/rating-distribution.test`
Expected: PASS（11 件）

- [ ] **Step 3: 失敗するテストを書く（グラフ本体）**

```tsx
// apps/mobile/src/components/chart/rating-distribution-chart.test.tsx
import type { RatingDistribution } from '@meshimap/core';
import { render, screen } from '@testing-library/react-native';

import { RatingDistributionChart } from './rating-distribution-chart';

const DISTRIBUTION: RatingDistribution = { 1: 2, 2: 4, 3: 14, 4: 48, 5: 60 };
const EMPTY_DISTRIBUTION: RatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

describe('RatingDistributionChart', () => {
  it('平均と件数を表示する', async () => {
    await render(
      <RatingDistributionChart average={4.2} distribution={DISTRIBUTION} testID="rating-chart" />,
    );

    expect(screen.getByText('4.2')).toBeOnTheScreen();
    expect(screen.getByText('128件の評価')).toBeOnTheScreen();
  });

  it('星のラベルを 5 から 1 まで並べる', async () => {
    await render(
      <RatingDistributionChart average={4.2} distribution={DISTRIBUTION} testID="rating-chart" />,
    );

    for (const rating of [5, 4, 3, 2, 1]) {
      expect(screen.getByTestId(`rating-chart-label-${rating}`)).toBeOnTheScreen();
    }
  });

  it('各星の件数を出す', async () => {
    await render(
      <RatingDistributionChart average={4.2} distribution={DISTRIBUTION} testID="rating-chart" />,
    );

    expect(screen.getByTestId('rating-chart-count-5')).toHaveTextContent('60');
    expect(screen.getByTestId('rating-chart-count-1')).toHaveTextContent('2');
  });

  it('レビューが 0 件のときは案内を出す', async () => {
    await render(
      <RatingDistributionChart
        average={0}
        distribution={EMPTY_DISTRIBUTION}
        testID="rating-chart"
      />,
    );

    expect(screen.getByTestId('rating-chart-empty')).toBeOnTheScreen();
    expect(screen.getByText('まだ評価がありません')).toBeOnTheScreen();
  });

  it('0 件のときは棒グラフ自体を描かない', async () => {
    await render(
      <RatingDistributionChart
        average={0}
        distribution={EMPTY_DISTRIBUTION}
        testID="rating-chart"
      />,
    );

    expect(screen.queryByTestId('rating-chart-bars')).toBeNull();
  });

  it('スクリーンリーダーに分布を 1 文で伝える', async () => {
    await render(
      <RatingDistributionChart average={4.2} distribution={DISTRIBUTION} testID="rating-chart" />,
    );

    expect(
      screen.getByLabelText(
        '平均 4.2、128 件の評価。星5が60件、星4が48件、星3が14件、星2が4件、星1が2件',
      ),
    ).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- rating-distribution-chart`
Expected: FAIL（`Cannot find module './rating-distribution-chart'`）

- [ ] **Step 4: rating-distribution-chart.tsx を実装する**

```tsx
// apps/mobile/src/components/chart/rating-distribution-chart.tsx
import type { RatingDistribution } from '@meshimap/core';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

import {
  RATING_BAR_HEIGHT_PX,
  RATING_CHART_HEIGHT_PX,
  ratingBars,
  totalRatingCount,
} from '@/components/chart/rating-distribution';
import { COLORS, FONT_SIZES, RADIUS, SEMANTIC_COLORS, SPACING } from '@/constants/theme';

const EMPTY_MESSAGE = 'まだ評価がありません';
const COUNT_SUFFIX = '件の評価';
const AVERAGE_LABEL_PREFIX = '平均 ';
const ACCESSIBILITY_SEPARATOR = '。';
const BAR_ACCESSIBILITY_SEPARATOR = '、';
const STAR_PREFIX = '星';
const STAR_COUNT_SUFFIX = '件';

/** 棒の角丸。棒が細いので半径は高さの半分にして完全な丸端にする */
const BAR_RADIUS_PX = RATING_BAR_HEIGHT_PX / 2;

/** 星ラベル欄の幅（px）。1 桁固定なので狭くてよい */
const LABEL_COLUMN_WIDTH_PX = 16;

/** 件数欄の幅（px）。4 桁まで折り返さない幅 */
const COUNT_COLUMN_WIDTH_PX = 40;

export interface RatingDistributionChartProps {
  average: number;
  distribution: RatingDistribution;
  testID?: string | undefined;
}

/** 「星5が60件、星4が48件、…」を組み立てる */
function buildDistributionLabel(distribution: RatingDistribution): string {
  return ratingBars(distribution, 0)
    .map((bar) => `${STAR_PREFIX}${bar.rating}が${bar.count}${STAR_COUNT_SUFFIX}`)
    .join(BAR_ACCESSIBILITY_SEPARATOR);
}

export function RatingDistributionChart({
  average,
  distribution,
  testID,
}: RatingDistributionChartProps) {
  // SVG は固定幅を要求するので、実測幅を onLayout で受け取ってから描く
  const [trackWidthPx, setTrackWidthPx] = useState(0);

  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackWidthPx(event.nativeEvent.layout.width);
  }, []);

  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  const total = totalRatingCount(distribution);
  const bars = ratingBars(distribution, trackWidthPx);

  if (total === 0) {
    return (
      <View testID={childTestId('empty')} style={styles.container}>
        <Text className="font-body text-sm text-neutral-600">{EMPTY_MESSAGE}</Text>
      </View>
    );
  }

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={[
        `${AVERAGE_LABEL_PREFIX}${average.toFixed(1)}、${total} ${COUNT_SUFFIX}`,
        buildDistributionLabel(distribution),
      ].join(ACCESSIBILITY_SEPARATOR)}
      style={styles.container}
    >
      <View style={styles.summary}>
        <Text className="font-display text-display text-neutral-900">{average.toFixed(1)}</Text>
        <Text className="font-body text-sm text-neutral-600">{`${total}${COUNT_SUFFIX}`}</Text>
      </View>

      <View style={styles.rows}>
        {/* 星ラベルと件数は Text で出し、棒だけを SVG にする。
            SVG 内のテキストはフォント指定が端末依存になりやすい */}
        <View style={styles.labelColumn}>
          {bars.map((bar) => (
            <Text
              key={bar.rating}
              testID={childTestId(`label-${bar.rating}`)}
              style={styles.rowText}
              className="font-body text-xs text-neutral-700"
            >
              {bar.rating}
            </Text>
          ))}
        </View>

        <View style={styles.track} onLayout={handleTrackLayout}>
          {trackWidthPx === 0 ? null : (
            <Svg testID={childTestId('bars')} width={trackWidthPx} height={RATING_CHART_HEIGHT_PX}>
              {bars.map((bar) => (
                <Rect
                  key={`track-${bar.rating}`}
                  x={0}
                  y={bar.y}
                  width={trackWidthPx}
                  height={RATING_BAR_HEIGHT_PX}
                  rx={BAR_RADIUS_PX}
                  fill={COLORS.neutral[200]}
                />
              ))}
              {bars.map((bar) => (
                <Rect
                  key={`value-${bar.rating}`}
                  x={0}
                  y={bar.y}
                  width={bar.widthPx}
                  height={RATING_BAR_HEIGHT_PX}
                  rx={BAR_RADIUS_PX}
                  fill={SEMANTIC_COLORS.rating}
                />
              ))}
            </Svg>
          )}
        </View>

        <View style={styles.countColumn}>
          {bars.map((bar) => (
            <Text
              key={bar.rating}
              testID={childTestId(`count-${bar.rating}`)}
              style={styles.rowText}
              className="font-body text-xs text-neutral-700"
            >
              {bar.count}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: SPACING.sm,
    padding: SPACING.md,
    borderRadius: RADIUS.card,
    backgroundColor: COLORS.neutral[50],
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: SPACING.sm,
  },
  rows: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  labelColumn: {
    width: LABEL_COLUMN_WIDTH_PX,
    height: RATING_CHART_HEIGHT_PX,
    justifyContent: 'space-between',
  },
  countColumn: {
    width: COUNT_COLUMN_WIDTH_PX,
    height: RATING_CHART_HEIGHT_PX,
    justifyContent: 'space-between',
  },
  track: {
    flex: 1,
    height: RATING_CHART_HEIGHT_PX,
  },
  rowText: {
    // 棒 1 本ぶんの高さに合わせて行を揃える
    height: RATING_BAR_HEIGHT_PX,
    lineHeight: RATING_BAR_HEIGHT_PX,
    fontSize: FONT_SIZES.xs,
    textAlign: 'right',
  },
});
```

`Svg` には `accessibilityElementsHidden` を渡さない。`react-native-svg` 15.15.4 の `SvgProps` が継承する
`AccessibilityProps`（`node_modules/react-native-svg/lib/typescript/lib/extract/types.d.ts`）は
`accessible` / `accessibilityLabel` / `testID` の 3 つしか持たず、型に存在しないため。
外側の `View` に `accessible` を付けた時点で内部は 1 つの読み上げ単位にまとまるので、これで足りる。

Run: `npm test -w @meshimap/mobile -- rating-distribution-chart`
Expected: PASS（6 件）

`rating-chart-bars` を参照するテストは `trackWidthPx === 0` の間は `Svg` を描かない実装のため、
0 件テスト（`queryByTestId(...)).toBeNull()`）だけが通り、非 0 件では `onLayout` が発火しない Jest 環境でも
`queryByTestId` を使っていないので支障がない。`react-native-svg` の要素に付けた `testID` がツリーに現れるかは
未検証のため、**これ以外のテストは SVG に依存させない**（→ 未確認事項）。

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`ratingBars` の `safeMaxCount` を `total` に変え、「最多の星がトラック幅いっぱいになる」が **FAIL** することを確認してから戻す。次に `total === 0` の早期 return を消し、「レビューが 0 件のときは案内を出す」が **FAIL** することも確認する。

- [ ] **Step 6: コミットする**

```bash
git add apps/mobile/src/components/chart/
git commit -m "feat(mobile): 評価分布グラフを追加する"
```

---

### Task 6-24: 週間営業時間の表を作る

**Files:**

- Create: `apps/mobile/src/constants/shop.ts`
- Create: `apps/mobile/src/lib/weekly-business-hours.ts`
- Create: `apps/mobile/src/lib/weekly-business-hours.test.ts`
- Create: `apps/mobile/src/components/shop/business-hours-table.tsx`
- Create: `apps/mobile/src/components/shop/business-hours-table.test.tsx`

**Interfaces:**

- Consumes: `@meshimap/core` の `businessHoursOn` / `formatBusinessHours` / `toJstClock` / `toDayOfWeek` / `addJstDays` / `DAYS_PER_WEEK` / 型 `BusinessHours` `ShopClosure` `DayOfWeek` `JstDate`
- Produces:
  - `DAY_OF_WEEK_LABELS: Record<DayOfWeek, string>` / `UPCOMING_CLOSURE_LIMIT`
  - `weeklyBusinessHours(hours, now): readonly WeeklyHoursRow[]` / 型 `WeeklyHoursRow`
  - `upcomingClosures(closures, now): readonly ShopClosure[]`
  - `formatJstDateLabel(date: JstDate): string`
  - `BusinessHoursTable` / 型 `BusinessHoursTableProps`

- [ ] **Step 1: 定数ファイルを作る**

```ts
// apps/mobile/src/constants/shop.ts
import type { DayOfWeek } from '@meshimap/core';

/**
 * 曜日の表示名。DayOfWeek は 0 = 日曜（D1 の shop_hours.day_of_week と同じ並び）。
 * core 側は表示文言を持たないので、表記の責務はアプリに置く。
 */
export const DAY_OF_WEEK_LABELS: Record<DayOfWeek, string> = {
  0: '日',
  1: '月',
  2: '火',
  3: '水',
  4: '木',
  5: '金',
  6: '土',
};

/** 詳細画面に出す臨時休業の最大件数。先の予定まで並べても読まれないため絞る */
export const UPCOMING_CLOSURE_LIMIT = 3;

/** 詳細画面の写真ギャラリーに出す最大枚数。これを超えたぶんは「+N」で畳む */
export const SHOP_PHOTO_PREVIEW_LIMIT = 6;
```

- [ ] **Step 2: 失敗するテストを書く**

```ts
// apps/mobile/src/lib/weekly-business-hours.test.ts
import { toJstDate } from '@meshimap/core';
import type { BusinessHours, ShopClosure } from '@meshimap/core';
import { toDayOfWeek, toMinuteOfDay } from '@meshimap/core';

import { UPCOMING_CLOSURE_LIMIT } from '@/constants/shop';

import { formatJstDateLabel, upcomingClosures, weeklyBusinessHours } from './weekly-business-hours';

/** ブランド型を通した営業時間を組み立てる小道具 */
function hoursOf(dayOfWeek: number, openMinute: number, closeMinute: number): BusinessHours {
  return {
    dayOfWeek: toDayOfWeek(dayOfWeek),
    openMinute: toMinuteOfDay(openMinute),
    closeMinute: toMinuteOfDay(closeMinute),
    isClosed: false,
  };
}

function closedOn(dayOfWeek: number): BusinessHours {
  return {
    dayOfWeek: toDayOfWeek(dayOfWeek),
    openMinute: toMinuteOfDay(0),
    closeMinute: toMinuteOfDay(0),
    isClosed: true,
  };
}

/** 2026-09-15（火）19:00 JST */
const TUESDAY_EVENING = new Date(Date.UTC(2026, 8, 15, 10, 0));

describe('weeklyBusinessHours', () => {
  it('日曜から土曜まで 7 行返す', () => {
    const rows = weeklyBusinessHours([], TUESDAY_EVENING);

    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('曜日ラベルを付ける', () => {
    const rows = weeklyBusinessHours([], TUESDAY_EVENING);

    expect(rows.map((row) => row.label)).toEqual(['日', '月', '火', '水', '木', '金', '土']);
  });

  it('営業時間を整形して入れる', () => {
    const rows = weeklyBusinessHours([hoursOf(2, 1020, 1380)], TUESDAY_EVENING);

    expect(rows[2]?.hoursText).toBe('17:00 - 23:00');
  });

  it('昼夜 2 部は 1 行にまとめる', () => {
    const rows = weeklyBusinessHours(
      [hoursOf(2, 660, 870), hoursOf(2, 1020, 1380)],
      TUESDAY_EVENING,
    );

    expect(rows[2]?.hoursText).toBe('11:00 - 14:30 / 17:00 - 23:00');
  });

  it('日跨ぎは翌日表記になる', () => {
    const rows = weeklyBusinessHours([hoursOf(5, 1080, 1530)], TUESDAY_EVENING);

    expect(rows[5]?.hoursText).toBe('18:00 - 翌 1:30');
  });

  it('定休日の行は定休日と出す', () => {
    const rows = weeklyBusinessHours([closedOn(1)], TUESDAY_EVENING);

    expect(rows[1]?.hoursText).toBe('定休日');
    expect(rows[1]?.isRegularHoliday).toBe(true);
  });

  it('営業時間が未登録の曜日も定休日として扱う', () => {
    // 行が無い曜日と isClosed の行がある曜日を画面上で区別しても利用者の役に立たない
    const rows = weeklyBusinessHours([hoursOf(2, 1020, 1380)], TUESDAY_EVENING);

    expect(rows[3]?.hoursText).toBe('定休日');
    expect(rows[3]?.isRegularHoliday).toBe(true);
  });

  it('今日の行に印を付ける', () => {
    const rows = weeklyBusinessHours([], TUESDAY_EVENING);

    expect(rows.map((row) => row.isToday)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('JST で日付が変わることを基準にする', () => {
    // 2026-09-15 16:00 UTC = 2026-09-16（水）01:00 JST
    const rows = weeklyBusinessHours([], new Date(Date.UTC(2026, 8, 15, 16, 0)));

    expect(rows[3]?.isToday).toBe(true);
  });
});

describe('upcomingClosures', () => {
  const CLOSURES: readonly ShopClosure[] = [
    { date: toJstDate('2026-09-20'), reason: '設備点検' },
    { date: toJstDate('2026-09-10'), reason: '過去の休業' },
    { date: toJstDate('2026-09-15'), reason: '本日休業' },
    { date: toJstDate('2026-09-18'), reason: '貸切' },
    { date: toJstDate('2026-09-25'), reason: '棚卸し' },
  ];

  it('今日以降だけを残す', () => {
    // 過去の休業日を出しても予定の役に立たない
    const result = upcomingClosures(CLOSURES, TUESDAY_EVENING);

    expect(result.some((closure) => closure.date === '2026-09-10')).toBe(false);
  });

  it('今日ちょうどは含める', () => {
    const result = upcomingClosures(CLOSURES, TUESDAY_EVENING);

    expect(result[0]?.date).toBe('2026-09-15');
  });

  it('日付の昇順に並べる', () => {
    const result = upcomingClosures(CLOSURES, TUESDAY_EVENING);

    expect(result.map((closure) => closure.date)).toEqual([
      '2026-09-15',
      '2026-09-18',
      '2026-09-20',
    ]);
  });

  it('上限件数で打ち切る', () => {
    const result = upcomingClosures(CLOSURES, TUESDAY_EVENING);

    expect(result).toHaveLength(UPCOMING_CLOSURE_LIMIT);
  });

  it('引数の配列を並べ替えない', () => {
    const input = [...CLOSURES];
    upcomingClosures(input, TUESDAY_EVENING);

    expect(input[0]?.date).toBe('2026-09-20');
  });

  it('休業日が無ければ空配列', () => {
    expect(upcomingClosures([], TUESDAY_EVENING)).toEqual([]);
  });
});

describe('formatJstDateLabel', () => {
  it('月日と曜日にする', () => {
    expect(formatJstDateLabel(toJstDate('2026-09-15'))).toBe('9/15（火）');
  });

  it('1 桁の月日でも 0 詰めしない', () => {
    expect(formatJstDateLabel(toJstDate('2026-01-04'))).toBe('1/4（日）');
  });
});
```

Run: `npm test -w @meshimap/mobile -- weekly-business-hours`
Expected: FAIL（`Cannot find module './weekly-business-hours'`）

- [ ] **Step 3: weekly-business-hours.ts を実装する**

```ts
// apps/mobile/src/lib/weekly-business-hours.ts
import {
  DAYS_PER_WEEK,
  businessHoursOn,
  dayOfWeekOf,
  formatBusinessHours,
  toDayOfWeek,
  toJstClock,
} from '@meshimap/core';
import type { BusinessHours, DayOfWeek, JstDate, ShopClosure } from '@meshimap/core';

import { DAY_OF_WEEK_LABELS, UPCOMING_CLOSURE_LIMIT } from '@/constants/shop';

/** 日付ラベルの区切り。`9/15（火）` の形にする */
const DATE_LABEL_SEPARATOR = '/';
const DAY_LABEL_OPEN = '（';
const DAY_LABEL_CLOSE = '）';

export interface WeeklyHoursRow {
  readonly dayOfWeek: DayOfWeek;
  /** 「月」など 1 文字の曜日名 */
  readonly label: string;
  /** 「17:00 - 23:00」または「定休日」 */
  readonly hoursText: string;
  /** 営業する行が 1 つも無い曜日 */
  readonly isRegularHoliday: boolean;
  /** JST で見て今日の曜日か */
  readonly isToday: boolean;
}

/**
 * 日曜〜土曜の 7 行を作る。
 * 「行が無い曜日」と「isClosed の行がある曜日」を画面で区別しても利用者の役に立たないので、
 * どちらも定休日として同じ見た目に寄せる。判定は core の businessHoursOn に任せる
 * （isClosed の行はそこで落ちる）。
 */
export function weeklyBusinessHours(
  hours: readonly BusinessHours[],
  now: Date,
): readonly WeeklyHoursRow[] {
  const clock = toJstClock(now);

  return Array.from({ length: DAYS_PER_WEEK }, (_unused, index) => {
    const dayOfWeek = toDayOfWeek(index);
    const openEntries = businessHoursOn(hours, dayOfWeek);
    return {
      dayOfWeek,
      label: DAY_OF_WEEK_LABELS[dayOfWeek],
      // formatBusinessHours は空配列に定休日ラベルを返す
      hoursText: formatBusinessHours(openEntries),
      isRegularHoliday: openEntries.length === 0,
      isToday: dayOfWeek === clock.dayOfWeek,
    };
  });
}

/** 今日以降の臨時休業を日付昇順で最大 UPCOMING_CLOSURE_LIMIT 件返す */
export function upcomingClosures(
  closures: readonly ShopClosure[],
  now: Date,
): readonly ShopClosure[] {
  const today = toJstClock(now).date;

  return (
    closures
      .filter((closure) => closure.date >= today)
      // JstDate は YYYY-MM-DD 固定長なので辞書順が日付順と一致する。
      // 引数の配列を壊さないよう filter の戻り値（新しい配列）を並べ替える
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(0, UPCOMING_CLOSURE_LIMIT)
  );
}

/** `2026-09-15` を `9/15（火）` にする */
export function formatJstDateLabel(date: JstDate): string {
  const [, month, day] = date.split('-');
  if (month === undefined || day === undefined) {
    // toJstDate を通った値なら到達しないが、noUncheckedIndexedAccess のため明示する
    throw new RangeError(`日付の形式が不正です: "${date}"`);
  }
  const label = DAY_OF_WEEK_LABELS[dayOfWeekOf(date)];
  return `${Number(month)}${DATE_LABEL_SEPARATOR}${Number(day)}${DAY_LABEL_OPEN}${label}${DAY_LABEL_CLOSE}`;
}
```

Run: `npm test -w @meshimap/mobile -- weekly-business-hours`
Expected: PASS（17 件）

- [ ] **Step 4: 失敗するテストを書く（表の描画）**

```tsx
// apps/mobile/src/components/shop/business-hours-table.test.tsx
import { toDayOfWeek, toJstDate, toMinuteOfDay } from '@meshimap/core';
import type { BusinessHours, ShopClosure } from '@meshimap/core';
import { render, screen } from '@testing-library/react-native';

import { COLORS } from '@/constants/theme';

import { BusinessHoursTable } from './business-hours-table';

function hoursOf(dayOfWeek: number, openMinute: number, closeMinute: number): BusinessHours {
  return {
    dayOfWeek: toDayOfWeek(dayOfWeek),
    openMinute: toMinuteOfDay(openMinute),
    closeMinute: toMinuteOfDay(closeMinute),
    isClosed: false,
  };
}

const HOURS: readonly BusinessHours[] = [
  hoursOf(2, 1020, 1380),
  hoursOf(3, 1020, 1380),
  hoursOf(4, 1020, 1380),
];

const CLOSURES: readonly ShopClosure[] = [{ date: toJstDate('2026-09-18'), reason: '貸切営業' }];

/** 2026-09-15（火）19:00 JST */
const TUESDAY_EVENING = new Date(Date.UTC(2026, 8, 15, 10, 0));

describe('BusinessHoursTable', () => {
  it('7 曜日ぶんの行を出す', async () => {
    await render(
      <BusinessHoursTable hours={HOURS} closures={[]} now={TUESDAY_EVENING} testID="hours" />,
    );

    for (const dayOfWeek of [0, 1, 2, 3, 4, 5, 6]) {
      expect(screen.getByTestId(`hours-row-${dayOfWeek}`)).toBeOnTheScreen();
    }
  });

  it('営業時間を表示する', async () => {
    await render(
      <BusinessHoursTable hours={HOURS} closures={[]} now={TUESDAY_EVENING} testID="hours" />,
    );

    expect(screen.getByTestId('hours-value-2')).toHaveTextContent('17:00 - 23:00');
  });

  it('定休日の曜日は定休日と出す', async () => {
    await render(
      <BusinessHoursTable hours={HOURS} closures={[]} now={TUESDAY_EVENING} testID="hours" />,
    );

    expect(screen.getByTestId('hours-value-1')).toHaveTextContent('定休日');
  });

  it('今日の行だけ背景色を変える', async () => {
    await render(
      <BusinessHoursTable hours={HOURS} closures={[]} now={TUESDAY_EVENING} testID="hours" />,
    );

    expect(screen.getByTestId('hours-row-2')).toHaveStyle({ backgroundColor: COLORS.primary[50] });
    expect(screen.getByTestId('hours-row-3')).toHaveStyle({ backgroundColor: 'transparent' });
  });

  it('今日の行はスクリーンリーダーにも今日と伝える', async () => {
    await render(
      <BusinessHoursTable hours={HOURS} closures={[]} now={TUESDAY_EVENING} testID="hours" />,
    );

    expect(screen.getByLabelText('本日 火曜日 17:00 - 23:00')).toBeOnTheScreen();
  });

  it('今日以外の行は曜日と時間だけ読み上げる', async () => {
    await render(
      <BusinessHoursTable hours={HOURS} closures={[]} now={TUESDAY_EVENING} testID="hours" />,
    );

    expect(screen.getByLabelText('水曜日 17:00 - 23:00')).toBeOnTheScreen();
  });

  it('臨時休業があれば日付と理由を出す', async () => {
    await render(
      <BusinessHoursTable hours={HOURS} closures={CLOSURES} now={TUESDAY_EVENING} testID="hours" />,
    );

    expect(screen.getByTestId('hours-closures')).toBeOnTheScreen();
    expect(screen.getByText('9/18（金）')).toBeOnTheScreen();
    expect(screen.getByText('貸切営業')).toBeOnTheScreen();
  });

  it('臨時休業が無ければその欄ごと出さない', async () => {
    await render(
      <BusinessHoursTable hours={HOURS} closures={[]} now={TUESDAY_EVENING} testID="hours" />,
    );

    expect(screen.queryByTestId('hours-closures')).toBeNull();
  });

  it('過ぎた臨時休業は出さない', async () => {
    const past: readonly ShopClosure[] = [{ date: toJstDate('2026-09-01'), reason: '改装' }];

    await render(
      <BusinessHoursTable hours={HOURS} closures={past} now={TUESDAY_EVENING} testID="hours" />,
    );

    expect(screen.queryByTestId('hours-closures')).toBeNull();
  });
});
```

Run: `npm test -w @meshimap/mobile -- business-hours-table`
Expected: FAIL（`Cannot find module './business-hours-table'`）

- [ ] **Step 5: business-hours-table.tsx を実装する**

```tsx
// apps/mobile/src/components/shop/business-hours-table.tsx
import type { BusinessHours, ShopClosure } from '@meshimap/core';
import { StyleSheet, Text, View } from 'react-native';

import { COLORS, RADIUS, SPACING } from '@/constants/theme';
import {
  formatJstDateLabel,
  upcomingClosures,
  weeklyBusinessHours,
} from '@/lib/weekly-business-hours';

const CLOSURES_HEADING = '臨時休業';
const TODAY_PREFIX = '本日 ';
const DAY_SUFFIX = '曜日';
const ACCESSIBILITY_SPACE = ' ';

/** 曜日欄の幅（px）。1 文字固定なので狭くてよい */
const DAY_COLUMN_WIDTH_PX = 28;

export interface BusinessHoursTableProps {
  hours: readonly BusinessHours[];
  closures: readonly ShopClosure[];
  now: Date;
  testID?: string | undefined;
}

export function BusinessHoursTable({ hours, closures, now, testID }: BusinessHoursTableProps) {
  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  const rows = weeklyBusinessHours(hours, now);
  const closureRows = upcomingClosures(closures, now);

  return (
    <View testID={testID} style={styles.container}>
      {rows.map((row) => (
        <View
          key={row.dayOfWeek}
          testID={childTestId(`row-${row.dayOfWeek}`)}
          accessible
          accessibilityRole="text"
          accessibilityLabel={[
            row.isToday ? `${TODAY_PREFIX}${row.label}${DAY_SUFFIX}` : `${row.label}${DAY_SUFFIX}`,
            row.hoursText,
          ].join(ACCESSIBILITY_SPACE)}
          style={[styles.row, row.isToday ? styles.todayRow : styles.normalRow]}
        >
          <Text
            className={
              row.isToday
                ? 'font-body-bold text-sm text-primary-700'
                : 'font-body text-sm text-neutral-700'
            }
            style={styles.dayLabel}
          >
            {row.label}
          </Text>
          <Text
            testID={childTestId(`value-${row.dayOfWeek}`)}
            className={
              row.isRegularHoliday
                ? 'font-body text-sm text-neutral-500'
                : row.isToday
                  ? 'font-body-bold text-sm text-primary-700'
                  : 'font-body text-sm text-neutral-700'
            }
          >
            {row.hoursText}
          </Text>
        </View>
      ))}

      {closureRows.length === 0 ? null : (
        <View testID={childTestId('closures')} style={styles.closures}>
          <Text className="font-body-bold text-xs text-neutral-600">{CLOSURES_HEADING}</Text>
          {closureRows.map((closure) => (
            <View key={closure.date} style={styles.closureRow}>
              <Text className="font-body-medium text-sm text-neutral-800">
                {formatJstDateLabel(closure.date)}
              </Text>
              <Text className="font-body text-sm text-neutral-600">{closure.reason}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: SPACING.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.sm,
  },
  // 背景色は className の条件分岐でも書けるが、テストで toHaveStyle を使いたいので style に置く。
  // NativeWind は Jest 環境で className をスタイルへ変換しないため
  todayRow: {
    backgroundColor: COLORS.primary[50],
  },
  normalRow: {
    backgroundColor: 'transparent',
  },
  dayLabel: {
    width: DAY_COLUMN_WIDTH_PX,
  },
  closures: {
    gap: SPACING.xs,
    marginTop: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.neutral[200],
  },
  closureRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
});
```

Run: `npm test -w @meshimap/mobile -- business-hours-table`
Expected: PASS（9 件）

- [ ] **Step 6: わざと壊してテストが落ちることを確認する**

`upcomingClosures` の `closure.date >= today` を `closure.date > today` に変え、「今日ちょうどは含める」が **FAIL** することを確認してから戻す。次に `weeklyBusinessHours` の `businessHoursOn` を素の `hours.filter((entry) => entry.dayOfWeek === dayOfWeek)` に置き換え、「定休日の行は定休日と出す」が **FAIL**（`formatBusinessHours` が空文字ではなく時刻を返す）することも確認する。

- [ ] **Step 7: コミットする**

```bash
git add apps/mobile/src/constants/shop.ts apps/mobile/src/lib/weekly-business-hours.ts apps/mobile/src/lib/weekly-business-hours.test.ts apps/mobile/src/components/shop/business-hours-table.tsx apps/mobile/src/components/shop/business-hours-table.test.tsx
git commit -m "feat(mobile): 週間営業時間の表を追加する"
```

---

### Task 6-25: 店舗基本情報と写真ギャラリーの部品を作る

**Files:**

- Create: `apps/mobile/src/lib/half-width-digits.ts`
- Create: `apps/mobile/src/lib/half-width-digits.test.ts`
- Create: `apps/mobile/src/lib/shop-links.ts`
- Create: `apps/mobile/src/lib/shop-links.test.ts`
- Create: `apps/mobile/src/components/shop/shop-info-list.tsx`
- Create: `apps/mobile/src/components/shop/shop-info-list.test.tsx`
- Create: `apps/mobile/src/components/shop/shop-photo-gallery.tsx`
- Create: `apps/mobile/src/components/shop/shop-photo-gallery.test.tsx`

**Interfaces:**

- Consumes: `react-native` の `Linking`、`expo-image` の `Image`、`@meshimap/core` の `formatBudgetRange` / `BUDGET_UNSET_LABEL`、`@/features/shops/schema` の 型 `ShopDetail`、`@/constants/shop` の `SHOP_PHOTO_PREVIEW_LIMIT`
- Produces:
  - `formatPostalCode(raw: string): string`
  - `telUrl(phone: string): string`
  - `mapsUrl(latitude: number, longitude: number): string`
  - `visiblePhotos(urls: readonly string[]): PhotoPreview` / 型 `PhotoPreview`
  - `ShopInfoList` / 型 `ShopInfoListProps`
  - `ShopPhotoGallery` / 型 `ShopPhotoGalleryProps`

- [ ] **Step 1: 失敗するテストを書く（リンク生成）**

```ts
// apps/mobile/src/lib/shop-links.test.ts
import { SHOP_PHOTO_PREVIEW_LIMIT } from '@/constants/shop';

import { formatPostalCode, mapsUrl, telUrl, visiblePhotos } from './shop-links';

describe('formatPostalCode', () => {
  it('7 桁の数字にハイフンを入れる', () => {
    expect(formatPostalCode('1500002')).toBe('〒150-0002');
  });

  it('すでにハイフン付きでも同じ結果になる', () => {
    expect(formatPostalCode('150-0002')).toBe('〒150-0002');
  });

  it('全角数字も受け付ける', () => {
    // 店舗管理画面からの入力を想定。全角のまま表示すると桁がそろわない
    expect(formatPostalCode('１５００００２')).toBe('〒150-0002');
  });

  it('7 桁でない値はそのまま返す', () => {
    // 海外表記など想定外の値を握りつぶして空にしない
    expect(formatPostalCode('ABC-123')).toBe('ABC-123');
  });

  it('空文字は空文字のまま', () => {
    expect(formatPostalCode('')).toBe('');
  });
});

describe('telUrl', () => {
  it('ハイフンを取り除いた tel スキームにする', () => {
    expect(telUrl('03-1234-5678')).toBe('tel:0312345678');
  });

  it('括弧や空白も取り除く', () => {
    expect(telUrl('(03) 1234 5678')).toBe('tel:0312345678');
  });

  it('国番号の + は残す', () => {
    // +81 を消すと国際電話が発信できなくなる
    expect(telUrl('+81 3-1234-5678')).toBe('tel:+81312345678');
  });
});

describe('mapsUrl', () => {
  it('緯度経度で検索する URL を作る', () => {
    expect(mapsUrl(35.6809591, 139.7673068)).toBe(
      'https://www.google.com/maps/search/?api=1&query=35.6809591%2C139.7673068',
    );
  });

  it('負の座標も扱える', () => {
    expect(mapsUrl(-33.8688, 151.2093)).toBe(
      'https://www.google.com/maps/search/?api=1&query=-33.8688%2C151.2093',
    );
  });
});

describe('visiblePhotos', () => {
  const URLS = Array.from(
    { length: 10 },
    (_unused, index) => `https://cdn.example.test/p${index}.jpg`,
  );

  it('上限まで切り出す', () => {
    expect(visiblePhotos(URLS).photos).toHaveLength(SHOP_PHOTO_PREVIEW_LIMIT);
  });

  it('あふれた枚数を返す', () => {
    expect(visiblePhotos(URLS).overflowCount).toBe(10 - SHOP_PHOTO_PREVIEW_LIMIT);
  });

  it('上限以下ならあふれは 0', () => {
    expect(visiblePhotos(URLS.slice(0, 2)).overflowCount).toBe(0);
  });

  it('0 枚でも壊れない', () => {
    expect(visiblePhotos([])).toEqual({ photos: [], overflowCount: 0 });
  });
});
```

Run: `npm test -w @meshimap/mobile -- shop-links`
Expected: FAIL（`Cannot find module './shop-links'`）

- [ ] **Step 2: 半角化ユーティリティと shop-links.ts を実装する**

全角数字の半角化は郵便番号・電話番号だけでなく、Task 6-30 の予算入力でも使う。
最初から独立したモジュールに切り出しておき、あとで同じ関数を書き直さずに済ませる。

```ts
// apps/mobile/src/lib/half-width-digits.ts
/** 全角数字を半角にする。Hermes でも動く単純な符号点シフトで済ませる */
const FULL_WIDTH_DIGIT_PATTERN = /[０-９]/g;
const FULL_WIDTH_ZERO_CODE = '０'.charCodeAt(0);
const HALF_WIDTH_ZERO_CODE = '0'.charCodeAt(0);

export function toHalfWidthDigits(value: string): string {
  return value.replace(FULL_WIDTH_DIGIT_PATTERN, (char) =>
    String.fromCharCode(char.charCodeAt(0) - FULL_WIDTH_ZERO_CODE + HALF_WIDTH_ZERO_CODE),
  );
}
```

```ts
// apps/mobile/src/lib/half-width-digits.test.ts
import { toHalfWidthDigits } from './half-width-digits';

describe('toHalfWidthDigits', () => {
  it('全角数字を半角にする', () => {
    expect(toHalfWidthDigits('１５００００２')).toBe('1500002');
  });

  it('半角数字はそのまま', () => {
    expect(toHalfWidthDigits('1500002')).toBe('1500002');
  });

  it('数字以外は変えない', () => {
    expect(toHalfWidthDigits('〒１５０-０００２')).toBe('〒150-0002');
  });

  it('空文字でも壊れない', () => {
    expect(toHalfWidthDigits('')).toBe('');
  });
});
```

```ts
// apps/mobile/src/lib/shop-links.ts
import { SHOP_PHOTO_PREVIEW_LIMIT } from '@/constants/shop';

import { toHalfWidthDigits } from './half-width-digits';

const POSTAL_CODE_PREFIX = '〒';
/** 郵便番号は 7 桁。前 3 桁と後 4 桁の間にハイフンを入れる */
const POSTAL_CODE_LENGTH = 7;
const POSTAL_CODE_HEAD_LENGTH = 3;

const TEL_SCHEME = 'tel:';
/** 電話番号として残す文字。国番号の + は消すと国際発信ができなくなるので残す */
const TEL_ALLOWED_PATTERN = /[^\d+]/g;

const MAPS_SEARCH_BASE = 'https://www.google.com/maps/search/?api=1&query=';
const COORDINATE_SEPARATOR = ',';

/**
 * 郵便番号を `〒150-0002` の形にする。
 * 7 桁の数字にならない値は想定外なので、握りつぶさずそのまま返して目視で気づけるようにする。
 */
export function formatPostalCode(raw: string): string {
  const digits = toHalfWidthDigits(raw).replace(/\D/g, '');
  if (digits.length !== POSTAL_CODE_LENGTH) {
    return raw;
  }
  const head = digits.slice(0, POSTAL_CODE_HEAD_LENGTH);
  const tail = digits.slice(POSTAL_CODE_HEAD_LENGTH);
  return `${POSTAL_CODE_PREFIX}${head}-${tail}`;
}

/** 発信用の tel スキーム。ハイフンや括弧は端末によって弾かれるので落とす */
export function telUrl(phone: string): string {
  return `${TEL_SCHEME}${toHalfWidthDigits(phone).replace(TEL_ALLOWED_PATTERN, '')}`;
}

/**
 * 地図アプリを開く URL。
 * 店名で検索すると同名店にずれるため、必ず座標で開く。
 * `query` はカンマを含むので encodeURIComponent を通す（`%2C` になる）。
 */
export function mapsUrl(latitude: number, longitude: number): string {
  return `${MAPS_SEARCH_BASE}${encodeURIComponent(`${latitude}${COORDINATE_SEPARATOR}${longitude}`)}`;
}

export interface PhotoPreview {
  readonly photos: readonly string[];
  /** 表示しきれなかった枚数。0 なら「+N」を出さない */
  readonly overflowCount: number;
}

/** ギャラリーに並べる枚数を上限で切り、あふれた枚数を添える */
export function visiblePhotos(urls: readonly string[]): PhotoPreview {
  return {
    photos: urls.slice(0, SHOP_PHOTO_PREVIEW_LIMIT),
    overflowCount: Math.max(0, urls.length - SHOP_PHOTO_PREVIEW_LIMIT),
  };
}
```

Run: `npm test -w @meshimap/mobile -- half-width-digits shop-links`
Expected: PASS（18 件 = half-width-digits 4 件 + shop-links 14 件）

- [ ] **Step 3: 失敗するテストを書く（基本情報リスト）**

```tsx
// apps/mobile/src/components/shop/shop-info-list.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { buildShopDetail } from '@/test-support/shop-fixtures';

import { ShopInfoList } from './shop-info-list';

describe('ShopInfoList', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('郵便番号と住所を表示する', async () => {
    await render(
      <ShopInfoList
        shop={buildShopDetail({ postalCode: '1500002', address: '東京都渋谷区渋谷1-2-3' })}
        testID="info"
      />,
    );

    expect(screen.getByTestId('info-address')).toHaveTextContent(
      '〒150-0002 東京都渋谷区渋谷1-2-3',
    );
  });

  it('地図ボタンを押すと地図アプリを開く', async () => {
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    await render(
      <ShopInfoList
        shop={buildShopDetail({ latitude: 35.6809591, longitude: 139.7673068 })}
        testID="info"
      />,
    );
    await fireEvent.press(screen.getByTestId('info-map-button'));

    expect(openUrl).toHaveBeenCalledWith(
      'https://www.google.com/maps/search/?api=1&query=35.6809591%2C139.7673068',
    );
  });

  it('電話番号を押すと発信する', async () => {
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    await render(<ShopInfoList shop={buildShopDetail({ phone: '03-1234-5678' })} testID="info" />);
    await fireEvent.press(screen.getByTestId('info-phone-button'));

    expect(openUrl).toHaveBeenCalledWith('tel:0312345678');
  });

  it('電話番号が無ければ行ごと出さない', async () => {
    await render(<ShopInfoList shop={buildShopDetail({ phone: null })} testID="info" />);

    expect(screen.queryByTestId('info-phone-button')).toBeNull();
  });

  it('公式サイトを押すとブラウザを開く', async () => {
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    await render(
      <ShopInfoList
        shop={buildShopDetail({ website: 'https://torimaru.example.test' })}
        testID="info"
      />,
    );
    await fireEvent.press(screen.getByTestId('info-website-button'));

    expect(openUrl).toHaveBeenCalledWith('https://torimaru.example.test');
  });

  it('公式サイトが無ければ行ごと出さない', async () => {
    await render(<ShopInfoList shop={buildShopDetail({ website: null })} testID="info" />);

    expect(screen.queryByTestId('info-website-button')).toBeNull();
  });

  it('夜と昼の予算を出す', async () => {
    await render(
      <ShopInfoList
        shop={buildShopDetail({
          budgetDinnerMinYen: 3000,
          budgetDinnerMaxYen: 4999,
          budgetLunchMinYen: 1000,
          budgetLunchMaxYen: 1999,
        })}
        testID="info"
      />,
    );

    expect(screen.getByTestId('info-budget-dinner')).toHaveTextContent('¥3,000 〜 ¥4,999');
    expect(screen.getByTestId('info-budget-lunch')).toHaveTextContent('¥1,000 〜 ¥1,999');
  });

  it('予算が未登録ならダッシュを出す', async () => {
    // 行ごと消すと「安いのか高いのか不明」であることが伝わらない
    await render(
      <ShopInfoList
        shop={buildShopDetail({ budgetLunchMinYen: null, budgetLunchMaxYen: null })}
        testID="info"
      />,
    );

    expect(screen.getByTestId('info-budget-lunch')).toHaveTextContent('－');
  });

  it('リンクを開けなくても落ちない', async () => {
    // 電話アプリの無い端末では openURL が reject する
    const openUrl = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));

    await render(<ShopInfoList shop={buildShopDetail({ phone: '03-1234-5678' })} testID="info" />);

    await expect(fireEvent.press(screen.getByTestId('info-phone-button'))).resolves.toBeUndefined();
    expect(openUrl).toHaveBeenCalledTimes(1);
  });
});
```

Run: `npm test -w @meshimap/mobile -- shop-info-list`
Expected: FAIL（`Cannot find module './shop-info-list'`）

- [ ] **Step 4: shop-info-list.tsx を実装する**

```tsx
// apps/mobile/src/components/shop/shop-info-list.tsx
import { BUDGET_UNSET_LABEL, formatBudgetRange } from '@meshimap/core';
import { Globe, MapPin, Phone, Sun, UtensilsCrossed } from 'lucide-react-native';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { COLORS, SPACING } from '@/constants/theme';
import { logger } from '@/lib/logger';
import { formatPostalCode, mapsUrl, telUrl } from '@/lib/shop-links';
import type { ShopDetail } from '@/features/shops/schema';

const MAP_BUTTON_LABEL = '地図アプリで開く';
const PHONE_BUTTON_LABEL_PREFIX = '電話をかける ';
const WEBSITE_BUTTON_LABEL = '公式サイトを開く';
const DINNER_LABEL = 'ディナー';
const LUNCH_LABEL = 'ランチ';
const ADDRESS_SEPARATOR = ' ';

export interface ShopInfoListProps {
  shop: ShopDetail;
  testID?: string | undefined;
}

/**
 * URL を開く。開けない端末（電話アプリ無しなど）では openURL が reject するため、
 * 握りつぶしてログだけ残す。ここで throw すると押した瞬間にアプリが落ちる。
 */
async function openExternalUrl(url: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch (error) {
    logger.warn('外部リンクを開けませんでした', { url, error });
  }
}

export function ShopInfoList({ shop, testID }: ShopInfoListProps) {
  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  const { phone, website } = shop;

  return (
    <View testID={testID} style={styles.container}>
      <View style={styles.row}>
        <Icon icon={MapPin} size="sm" color={COLORS.neutral[500]} />
        <View style={styles.rowBody}>
          <Text testID={childTestId('address')} className="font-body text-sm text-neutral-800">
            {`${formatPostalCode(shop.postalCode)}${ADDRESS_SEPARATOR}${shop.address}`}
          </Text>
          <Pressable
            testID={childTestId('map-button')}
            accessibilityRole="link"
            accessibilityLabel={MAP_BUTTON_LABEL}
            onPress={() => {
              void openExternalUrl(mapsUrl(shop.latitude, shop.longitude));
            }}
          >
            <Text className="font-body-medium text-sm text-primary-600">{MAP_BUTTON_LABEL}</Text>
          </Pressable>
        </View>
      </View>

      {phone === null ? null : (
        <View style={styles.row}>
          <Icon icon={Phone} size="sm" color={COLORS.neutral[500]} />
          <Pressable
            testID={childTestId('phone-button')}
            accessibilityRole="link"
            accessibilityLabel={`${PHONE_BUTTON_LABEL_PREFIX}${phone}`}
            style={styles.rowBody}
            onPress={() => {
              void openExternalUrl(telUrl(phone));
            }}
          >
            <Text className="font-body-medium text-sm text-primary-600">{phone}</Text>
          </Pressable>
        </View>
      )}

      {website === null ? null : (
        <View style={styles.row}>
          <Icon icon={Globe} size="sm" color={COLORS.neutral[500]} />
          <Pressable
            testID={childTestId('website-button')}
            accessibilityRole="link"
            accessibilityLabel={WEBSITE_BUTTON_LABEL}
            style={styles.rowBody}
            onPress={() => {
              void openExternalUrl(website);
            }}
          >
            <Text numberOfLines={1} className="font-body-medium text-sm text-primary-600">
              {website}
            </Text>
          </Pressable>
        </View>
      )}

      <View style={styles.row}>
        <Icon icon={UtensilsCrossed} size="sm" color={COLORS.neutral[500]} />
        <View style={styles.budgetRow}>
          <Text className="font-body text-sm text-neutral-500">{DINNER_LABEL}</Text>
          <Text
            testID={childTestId('budget-dinner')}
            className="font-body-medium text-sm text-neutral-800"
          >
            {formatBudgetRange(shop.budgetDinnerMinYen, shop.budgetDinnerMaxYen)}
          </Text>
        </View>
      </View>

      <View style={styles.row}>
        <Icon icon={Sun} size="sm" color={COLORS.neutral[500]} />
        <View style={styles.budgetRow}>
          <Text className="font-body text-sm text-neutral-500">{LUNCH_LABEL}</Text>
          <Text
            testID={childTestId('budget-lunch')}
            className="font-body-medium text-sm text-neutral-800"
          >
            {formatBudgetRange(shop.budgetLunchMinYen, shop.budgetLunchMaxYen)}
          </Text>
        </View>
      </View>
    </View>
  );
}

// BUDGET_UNSET_LABEL は formatBudgetRange が未登録時に返す値。
// 画面側で別の記号を使わないよう、参照していることをここで明示する
export const BUDGET_PLACEHOLDER = BUDGET_UNSET_LABEL;

const styles = StyleSheet.create({
  container: {
    gap: SPACING.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  rowBody: {
    flex: 1,
    gap: SPACING.xs,
  },
  budgetRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
});
```

`Globe` / `Sun` は lucide-react-native に存在することを確認済み（Task 6-2 のアイコン実在確認リストに追加すること）。
`logger` は Phase 1 で用意済みの `apps/mobile/src/lib/logger.ts` を使う。`console.log` は禁止。

Run: `npm test -w @meshimap/mobile -- shop-info-list`
Expected: PASS（9 件）

- [ ] **Step 5: 失敗するテストを書く（写真ギャラリー）**

```tsx
// apps/mobile/src/components/shop/shop-photo-gallery.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { SHOP_PHOTO_PREVIEW_LIMIT } from '@/constants/shop';

import { ShopPhotoGallery } from './shop-photo-gallery';

const URLS = Array.from(
  { length: SHOP_PHOTO_PREVIEW_LIMIT + 4 },
  (_unused, index) => `https://cdn.example.test/p${index}.jpg`,
);

describe('ShopPhotoGallery', () => {
  it('上限までのサムネイルを並べる', async () => {
    await render(<ShopPhotoGallery photoUrls={URLS} onPressPhoto={jest.fn()} testID="gallery" />);

    expect(screen.getByTestId(`gallery-photo-${SHOP_PHOTO_PREVIEW_LIMIT - 1}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`gallery-photo-${SHOP_PHOTO_PREVIEW_LIMIT}`)).toBeNull();
  });

  it('あふれた枚数を最後のサムネイルに重ねる', async () => {
    await render(<ShopPhotoGallery photoUrls={URLS} onPressPhoto={jest.fn()} testID="gallery" />);

    expect(screen.getByTestId('gallery-overflow')).toHaveTextContent('+4');
  });

  it('上限以下なら枚数バッジを出さない', async () => {
    await render(
      <ShopPhotoGallery photoUrls={URLS.slice(0, 2)} onPressPhoto={jest.fn()} testID="gallery" />,
    );

    expect(screen.queryByTestId('gallery-overflow')).toBeNull();
  });

  it('サムネイルを押すと元配列の添字を通知する', async () => {
    const handlePress = jest.fn();

    await render(<ShopPhotoGallery photoUrls={URLS} onPressPhoto={handlePress} testID="gallery" />);
    await fireEvent.press(screen.getByTestId('gallery-photo-2'));

    expect(handlePress).toHaveBeenCalledWith(2);
  });

  it('写真が 1 枚も無ければ何も描かない', async () => {
    await render(<ShopPhotoGallery photoUrls={[]} onPressPhoto={jest.fn()} testID="gallery" />);

    expect(screen.queryByTestId('gallery')).toBeNull();
  });

  it('スクリーンリーダーに枚数を伝える', async () => {
    await render(<ShopPhotoGallery photoUrls={URLS} onPressPhoto={jest.fn()} testID="gallery" />);

    expect(screen.getByLabelText('店舗写真 1 枚目')).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- shop-photo-gallery`
Expected: FAIL（`Cannot find module './shop-photo-gallery'`）

- [ ] **Step 6: shop-photo-gallery.tsx を実装する**

```tsx
// apps/mobile/src/components/shop/shop-photo-gallery.tsx
import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { COLORS, RADIUS, SPACING } from '@/constants/theme';
import { visiblePhotos } from '@/lib/shop-links';

const PHOTO_LABEL_PREFIX = '店舗写真 ';
const PHOTO_LABEL_SUFFIX = ' 枚目';
const OVERFLOW_PREFIX = '+';
const IMAGE_TRANSITION_MS = 200;

/** サムネイルの一辺（px）。横スクロールで 3 枚強が見える大きさ */
const THUMBNAIL_SIZE_PX = 112;

export interface ShopPhotoGalleryProps {
  photoUrls: readonly string[];
  /** 押された写真の、元配列における添字 */
  onPressPhoto: (index: number) => void;
  testID?: string | undefined;
}

export function ShopPhotoGallery({ photoUrls, onPressPhoto, testID }: ShopPhotoGalleryProps) {
  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  const { photos, overflowCount } = visiblePhotos(photoUrls);

  if (photos.length === 0) {
    return null;
  }

  const lastIndex = photos.length - 1;

  return (
    <ScrollView
      testID={testID}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}
    >
      {photos.map((url, index) => (
        <Pressable
          key={url}
          testID={childTestId(`photo-${index}`)}
          accessibilityRole="imagebutton"
          accessibilityLabel={`${PHOTO_LABEL_PREFIX}${index + 1}${PHOTO_LABEL_SUFFIX}`}
          onPress={() => {
            onPressPhoto(index);
          }}
          style={styles.thumbnail}
        >
          <Image
            source={url}
            contentFit="cover"
            transition={IMAGE_TRANSITION_MS}
            style={styles.image}
          />
          {index === lastIndex && overflowCount > 0 ? (
            // 最後の 1 枚に「+N」を重ねる。別枠にすると押せる的が 1 つ増えて操作が読みにくくなる
            <View style={styles.overflow} pointerEvents="none">
              <Text testID={childTestId('overflow')} className="font-body-bold text-lg text-white">
                {`${OVERFLOW_PREFIX}${overflowCount}`}
              </Text>
            </View>
          ) : null}
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  thumbnail: {
    width: THUMBNAIL_SIZE_PX,
    height: THUMBNAIL_SIZE_PX,
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    backgroundColor: COLORS.neutral[200],
  },
  image: {
    width: '100%',
    height: '100%',
  },
  overflow: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    // 半透明の黒。NativeWind のスラッシュ記法に頼らず rgba で書く
    backgroundColor: 'rgba(26, 23, 20, 0.6)',
  },
});
```

`expo-image` の `Image` は NativeWind の cssInterop に登録されていないため `className` は効かない。`style` で指定する。
`ScrollView` の `contentContainerStyle` に `gap` を置くのは RN 0.86 で有効（`gap` は View のスタイルプロパティ）。

Run: `npm test -w @meshimap/mobile -- shop-photo-gallery`
Expected: PASS（6 件）

- [ ] **Step 7: わざと壊してテストが落ちることを確認する**

`visiblePhotos` の `Math.max(0, ...)` を外し、「上限以下ならあふれは 0」が **FAIL**（負の値になる）することを確認してから戻す。次に `openExternalUrl` の `try/catch` を外し、「リンクを開けなくても落ちない」が **FAIL**（未処理の Promise 拒否になる）することも確認する。

- [ ] **Step 8: コミットする**

```bash
git add apps/mobile/src/lib/half-width-digits.ts apps/mobile/src/lib/half-width-digits.test.ts apps/mobile/src/lib/shop-links.ts apps/mobile/src/lib/shop-links.test.ts apps/mobile/src/components/shop/shop-info-list.tsx apps/mobile/src/components/shop/shop-info-list.test.tsx apps/mobile/src/components/shop/shop-photo-gallery.tsx apps/mobile/src/components/shop/shop-photo-gallery.test.tsx
git commit -m "feat(mobile): 店舗基本情報と写真ギャラリーの部品を追加する"
```

---

### Task 6-26: レビューの型と星表示を作る

**Files:**

- Create: `apps/mobile/src/features/reviews/schema.ts`
- Create: `apps/mobile/src/features/reviews/schema.test.ts`
- Create: `apps/mobile/src/test-support/review-fixtures.ts`
- Create: `apps/mobile/src/lib/star-rating.ts`
- Create: `apps/mobile/src/lib/star-rating.test.ts`
- Create: `apps/mobile/src/components/review/star-rating.tsx`
- Create: `apps/mobile/src/components/review/star-rating.test.tsx`

**Interfaces:**

- Consumes: `zod` の `z`、`@meshimap/core` の `budgetYenSchema` / `identifierSchema` / `ratingSchema` / `webUrlSchema` / `toJstDate` / `toRating` / `toReviewId` / `toShopId` / `toUserId` / `RATING_MAX` / 型 `Rating`、`@/features/shops/schema` の `RATING_VALUES`、`lucide-react-native` の `Star`
- Produces:
  - `reviewSchema` / 型 `Review`、`reviewPageSchema` / 型 `ReviewPage`
  - `buildReview(overrides?: ReviewOverrides): Review` / 型 `ReviewOverrides`
  - `filledStarCount(rating: number): number`
  - `starAppearance(starValue: number, filledCount: number): StarAppearance` / 型 `StarAppearance`
  - `StarRating` / 型 `StarRatingProps` / 型 `StarRatingSize`

- [ ] **Step 1: 失敗するテストを書く（スキーマ）**

```ts
// apps/mobile/src/features/reviews/schema.test.ts
import { reviewPageSchema, reviewSchema } from './schema';

const VALID_REVIEW = {
  id: 'review-001',
  shopId: 'shop-001',
  userId: 'user-001',
  userName: 'たろう',
  userAvatarUrl: 'https://cdn.example.test/users/001.jpg',
  rating: 4,
  body: '串が一本ずつ丁寧でした。',
  visitedOn: '2026-09-10',
  budgetYen: 4000,
  photoUrls: ['https://cdn.example.test/reviews/001/1.jpg'],
  createdAt: '2026-09-12T10:30:00.000Z',
};

describe('reviewSchema', () => {
  it('正しいレスポンスを受け付ける', () => {
    expect(() => reviewSchema.parse(VALID_REVIEW)).not.toThrow();
  });

  it('ID をブランド型に変換する', () => {
    const review = reviewSchema.parse(VALID_REVIEW);

    // 値は文字列のまま。型だけが ReviewId になる
    expect(review.id).toBe('review-001');
  });

  it('評価を Rating に変換する', () => {
    const review = reviewSchema.parse(VALID_REVIEW);

    expect(review.rating).toBe(4);
  });

  it('範囲外の評価を弾く', () => {
    expect(() => reviewSchema.parse({ ...VALID_REVIEW, rating: 6 })).toThrow();
  });

  it('小数の評価を弾く', () => {
    // 投稿できるのは整数の星だけ
    expect(() => reviewSchema.parse({ ...VALID_REVIEW, rating: 4.5 })).toThrow();
  });

  it('存在しない訪問日を弾く', () => {
    expect(() => reviewSchema.parse({ ...VALID_REVIEW, visitedOn: '2026-02-30' })).toThrow();
  });

  it('アバターと予算の null を受け付ける', () => {
    const review = reviewSchema.parse({ ...VALID_REVIEW, userAvatarUrl: null, budgetYen: null });

    expect(review.userAvatarUrl).toBeNull();
    expect(review.budgetYen).toBeNull();
  });

  it('http/https 以外の写真 URL を弾く', () => {
    expect(() =>
      reviewSchema.parse({ ...VALID_REVIEW, photoUrls: ['javascript:alert(1)'] }),
    ).toThrow();
  });

  it('ID に使えない文字を弾く', () => {
    expect(() => reviewSchema.parse({ ...VALID_REVIEW, id: 'review 001' })).toThrow();
  });
});

describe('reviewPageSchema', () => {
  it('ページを受け付ける', () => {
    const page = reviewPageSchema.parse({
      reviews: [VALID_REVIEW],
      nextCursor: 'cursor-2',
      totalCount: 128,
    });

    expect(page.reviews).toHaveLength(1);
    expect(page.nextCursor).toBe('cursor-2');
  });

  it('最終ページは nextCursor が null', () => {
    const page = reviewPageSchema.parse({ reviews: [], nextCursor: null, totalCount: 0 });

    expect(page.nextCursor).toBeNull();
  });

  it('空文字のカーソルを弾く', () => {
    // 空文字を「次がある」と誤解すると無限ループになる
    expect(() => reviewPageSchema.parse({ reviews: [], nextCursor: '', totalCount: 0 })).toThrow();
  });
});
```

Run: `npm test -w @meshimap/mobile -- reviews/schema`
Expected: FAIL（`Cannot find module './schema'`）

- [ ] **Step 2: schema.ts を実装する**

```ts
// apps/mobile/src/features/reviews/schema.ts
import {
  budgetYenSchema,
  identifierSchema,
  ratingSchema,
  toJstDate,
  toRating,
  toReviewId,
  toShopId,
  toUserId,
  webUrlSchema,
} from '@meshimap/core';
import { z } from 'zod';

/**
 * API が返すレビュー 1 件。
 * ID・評価・日付はここでブランド型へ変換し、以降のコードが素の string / number を
 * 取り違えないようにする。変換点をスキーマに集約するのは shops/schema.ts と同じ方針。
 */
export const reviewSchema = z.object({
  id: identifierSchema.transform(toReviewId),
  shopId: identifierSchema.transform(toShopId),
  userId: identifierSchema.transform(toUserId),
  userName: z.string().min(1),
  userAvatarUrl: webUrlSchema.nullable(),
  // ratingSchema は整数 1〜5 を検証するだけなので、Rating へは toRating で絞り込む
  rating: ratingSchema.transform(toRating),
  body: z.string(),
  // toJstDate は 2026-02-30 のような存在しない日付も弾く
  visitedOn: z.iso.date().transform(toJstDate),
  budgetYen: budgetYenSchema,
  photoUrls: z.array(webUrlSchema),
  createdAt: z.iso.datetime(),
});
export type Review = z.infer<typeof reviewSchema>;

export const reviewPageSchema = z.object({
  reviews: z.array(reviewSchema),
  /** 次ページのカーソル。空文字を「次がある」と誤解しないよう min(1) を課す */
  nextCursor: z.string().min(1).nullable(),
  totalCount: z.number().int().min(0),
});
export type ReviewPage = z.infer<typeof reviewPageSchema>;
```

Run: `npm test -w @meshimap/mobile -- reviews/schema`
Expected: PASS（12 件）

- [ ] **Step 3: レビューのフィクスチャを作る**

```ts
// apps/mobile/src/test-support/review-fixtures.ts
import { reviewSchema } from '@/features/reviews/schema';
import type { Review } from '@/features/reviews/schema';

/** レビューの素の JSON。API が返すのと同じ形。overrides もこの形（変換前の値）で渡す */
const DEFAULT_REVIEW_JSON = {
  id: 'review-001',
  shopId: 'shop-001',
  userId: 'user-001',
  userName: 'たろう',
  userAvatarUrl: 'https://cdn.example.test/users/001.jpg',
  rating: 4,
  body: '備長炭の香りがしっかりついていて、ねぎまが特に良かったです。カウンターで焼き手を見ながら食べられます。',
  visitedOn: '2026-09-10',
  budgetYen: 4000,
  photoUrls: ['https://cdn.example.test/reviews/001/1.jpg'],
  createdAt: '2026-09-12T10:30:00.000Z',
};

/** overrides は「スキーマを通す前」の素の値で渡す。ブランド型を手で作らなくて済む */
export type ReviewOverrides = Partial<Record<keyof Review, unknown>>;

export function buildReview(overrides: ReviewOverrides = {}): Review {
  return reviewSchema.parse({ ...DEFAULT_REVIEW_JSON, ...overrides });
}

/** 連番の ID を振ったレビュー一覧。一覧描画やページングのテストに使う */
export function buildReviewList(count: number): readonly Review[] {
  return Array.from({ length: count }, (_unused, index) =>
    buildReview({ id: `review-${String(index + 1).padStart(3, '0')}` }),
  );
}
```

- [ ] **Step 4: 失敗するテストを書く（星の計算）**

```ts
// apps/mobile/src/lib/star-rating.test.ts
import { COLORS, SEMANTIC_COLORS } from '@/constants/theme';

import { STAR_EMPTY_FILL, filledStarCount, starAppearance } from './star-rating';

describe('filledStarCount', () => {
  it('整数はそのまま', () => {
    expect(filledStarCount(4)).toBe(4);
  });

  it('0 は 0', () => {
    expect(filledStarCount(0)).toBe(0);
  });

  it('小数は四捨五入する', () => {
    expect(filledStarCount(4.4)).toBe(4);
    expect(filledStarCount(4.5)).toBe(5);
  });

  it('上限を超えても 5 で止める', () => {
    expect(filledStarCount(7)).toBe(5);
  });

  it('負の値は 0 にする', () => {
    expect(filledStarCount(-2)).toBe(0);
  });

  it('NaN は 0 にする', () => {
    // 平均値の計算が 0 件で NaN になる事故を画面まで持ち込まない
    expect(filledStarCount(Number.NaN)).toBe(0);
  });
});

describe('starAppearance', () => {
  it('塗る星は評価色で塗りつぶす', () => {
    expect(starAppearance(3, 4)).toEqual({
      color: SEMANTIC_COLORS.rating,
      fill: SEMANTIC_COLORS.rating,
    });
  });

  it('境界の星も塗る', () => {
    expect(starAppearance(4, 4).fill).toBe(SEMANTIC_COLORS.rating);
  });

  it('塗らない星は輪郭だけ残す', () => {
    expect(starAppearance(5, 4)).toEqual({
      color: COLORS.neutral[300],
      fill: STAR_EMPTY_FILL,
    });
  });

  it('0 個のときは全部空', () => {
    expect(starAppearance(1, 0).fill).toBe(STAR_EMPTY_FILL);
  });
});
```

Run: `npm test -w @meshimap/mobile -- star-rating.test`
Expected: FAIL（`Cannot find module './star-rating'`）

- [ ] **Step 5: star-rating.ts を実装する**

```ts
// apps/mobile/src/lib/star-rating.ts
import { RATING_MAX } from '@meshimap/core';

import { COLORS, SEMANTIC_COLORS } from '@/constants/theme';

/** 塗らない星の塗り色。SVG の fill に none ではなく transparent を渡す（RN の SVG 実装差を避ける） */
export const STAR_EMPTY_FILL = 'transparent';

/**
 * 平均評価を「塗る星の数」に変換する。
 * 半分だけ塗る表現は SVG のクリップが必要で端末差が出やすいので、四捨五入で丸める。
 * 正確な数値は必ず数字（4.2）と併記するので、丸めても情報は失われない。
 */
export function filledStarCount(rating: number): number {
  if (Number.isNaN(rating)) {
    return 0;
  }
  return Math.min(RATING_MAX, Math.max(0, Math.round(rating)));
}

export interface StarAppearance {
  readonly color: string;
  readonly fill: string;
}

/** starValue 番目の星の色。描画から切り離しておくとテストが SVG に依存しない */
export function starAppearance(starValue: number, filledCount: number): StarAppearance {
  return starValue <= filledCount
    ? { color: SEMANTIC_COLORS.rating, fill: SEMANTIC_COLORS.rating }
    : { color: COLORS.neutral[300], fill: STAR_EMPTY_FILL };
}
```

Run: `npm test -w @meshimap/mobile -- star-rating.test`
Expected: PASS（10 件）

- [ ] **Step 6: 失敗するテストを書く（星の描画）**

```tsx
// apps/mobile/src/components/review/star-rating.test.tsx
import { render, screen } from '@testing-library/react-native';

import { StarRating } from './star-rating';

describe('StarRating', () => {
  it('星を 5 つ並べる', async () => {
    await render(<StarRating rating={4.2} testID="stars" />);

    for (const value of [1, 2, 3, 4, 5]) {
      expect(screen.getByTestId(`stars-star-${value}`)).toBeOnTheScreen();
    }
  });

  it('評価をスクリーンリーダーに読ませる', async () => {
    await render(<StarRating rating={4.2} testID="stars" />);

    expect(screen.getByLabelText('5 段階中 4.2')).toBeOnTheScreen();
  });

  it('整数の評価も小数第 1 位まで読ませる', async () => {
    // 「4」と「4.0」が混在すると読み上げが揺れる
    await render(<StarRating rating={4} testID="stars" />);

    expect(screen.getByLabelText('5 段階中 4.0')).toBeOnTheScreen();
  });

  it('既定のサイズは sm', async () => {
    await render(<StarRating rating={4} testID="stars" />);

    expect(screen.getByTestId('stars-star-1')).toHaveStyle({ width: 14, height: 14 });
  });

  it('md を指定すると大きくなる', async () => {
    await render(<StarRating rating={4} size="md" testID="stars" />);

    expect(screen.getByTestId('stars-star-1')).toHaveStyle({ width: 20, height: 20 });
  });
});
```

Run: `npm test -w @meshimap/mobile -- review/star-rating`
Expected: FAIL（`Cannot find module './star-rating'`）

- [ ] **Step 7: star-rating.tsx を実装する**

```tsx
// apps/mobile/src/components/review/star-rating.tsx
import { Star } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { RATING_VALUES } from '@/features/shops/schema';
import { SPACING } from '@/constants/theme';
import { filledStarCount, starAppearance } from '@/lib/star-rating';

const ACCESSIBILITY_LABEL_PREFIX = '5 段階中 ';
/** 読み上げの桁数。整数でも 4.0 と読ませて表記を揃える */
const RATING_LABEL_DIGITS = 1;

export type StarRatingSize = 'sm' | 'md';

/** 星 1 つの実ピクセル。ui/icon.tsx の IconSize とは用途が違うので独立して持つ */
const STAR_PIXEL_SIZES: Record<StarRatingSize, number> = {
  sm: 14,
  md: 20,
};

export interface StarRatingProps {
  rating: number;
  size?: StarRatingSize | undefined;
  testID?: string | undefined;
}

/**
 * 読み取り専用の星表示。
 * lucide のアイコンは受け取った testID を SVG 側へ渡すため RN のツリーに現れない。
 * testID は必ずラッパの View に付ける（ui/icon.tsx と同じ理由）。
 * 塗り分けの正しさは lib/star-rating.ts の starAppearance で検証する。
 */
export function StarRating({ rating, size = 'sm', testID }: StarRatingProps) {
  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  const pixelSize = STAR_PIXEL_SIZES[size];
  const filledCount = filledStarCount(rating);

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${ACCESSIBILITY_LABEL_PREFIX}${rating.toFixed(RATING_LABEL_DIGITS)}`}
      style={styles.row}
    >
      {RATING_VALUES.map((value) => {
        const appearance = starAppearance(value, filledCount);
        return (
          <View
            key={value}
            testID={childTestId(`star-${value}`)}
            style={{ width: pixelSize, height: pixelSize }}
          >
            <Star size={pixelSize} color={appearance.color} fill={appearance.fill} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs / 2,
  },
});
```

Run: `npm test -w @meshimap/mobile -- review/star-rating`
Expected: PASS（5 件）

- [ ] **Step 8: わざと壊してテストが落ちることを確認する**

`filledStarCount` の `Math.min(RATING_MAX, ...)` を外し、「上限を超えても 5 で止める」が **FAIL** することを確認してから戻す。次に `starAppearance` の `<=` を `<` に変え、「境界の星も塗る」が **FAIL** することも確認する。

- [ ] **Step 9: コミットする**

```bash
git add apps/mobile/src/features/reviews/ apps/mobile/src/test-support/review-fixtures.ts apps/mobile/src/lib/star-rating.ts apps/mobile/src/lib/star-rating.test.ts apps/mobile/src/components/review/
git commit -m "feat(mobile): レビューの型と星表示を追加する"
```

---

### Task 6-27: レビューカードを作る

**Files:**

- Create: `apps/mobile/src/lib/review-format.ts`
- Create: `apps/mobile/src/lib/review-format.test.ts`
- Create: `apps/mobile/src/components/review/review-card.tsx`
- Create: `apps/mobile/src/components/review/review-card.test.tsx`

**Interfaces:**

- Consumes: `@meshimap/core` の `BUDGET_UNSET_LABEL` / `formatYen` / 型 `JstDate` `ReviewId`、`@/features/reviews/schema` の 型 `Review`、`@/components/review/star-rating`、`@/components/ui/card`、`expo-image` の `Image`
- Produces:
  - `REVIEW_BODY_COLLAPSED_LINES` / `REVIEW_BODY_EXPAND_THRESHOLD`
  - `formatVisitedOnLabel(date: JstDate): string`
  - `needsBodyExpansion(body: string): boolean`
  - `formatReviewBudget(budgetYen: number | null): string`
  - `ReviewCard` / 型 `ReviewCardProps`

- [ ] **Step 1: 失敗するテストを書く（整形）**

```ts
// apps/mobile/src/lib/review-format.test.ts
import { BUDGET_UNSET_LABEL, toJstDate } from '@meshimap/core';

import {
  REVIEW_BODY_EXPAND_THRESHOLD,
  formatReviewBudget,
  formatVisitedOnLabel,
  needsBodyExpansion,
} from './review-format';

describe('formatVisitedOnLabel', () => {
  it('年月日と訪問の語を付ける', () => {
    expect(formatVisitedOnLabel(toJstDate('2026-09-10'))).toBe('2026年9月10日 訪問');
  });

  it('1 桁の月日は 0 を落とす', () => {
    expect(formatVisitedOnLabel(toJstDate('2026-01-04'))).toBe('2026年1月4日 訪問');
  });
});

describe('needsBodyExpansion', () => {
  it('しきい値以下なら折りたたまない', () => {
    expect(needsBodyExpansion('a'.repeat(REVIEW_BODY_EXPAND_THRESHOLD))).toBe(false);
  });

  it('しきい値を超えたら折りたたむ', () => {
    expect(needsBodyExpansion('a'.repeat(REVIEW_BODY_EXPAND_THRESHOLD + 1))).toBe(true);
  });

  it('改行が多い本文も折りたたむ', () => {
    // 文字数は少なくても行数が多いとカードが伸びる
    expect(needsBodyExpansion('短い行\n'.repeat(6))).toBe(true);
  });

  it('空文字は折りたたまない', () => {
    expect(needsBodyExpansion('')).toBe(false);
  });
});

describe('formatReviewBudget', () => {
  it('金額を円表記にする', () => {
    expect(formatReviewBudget(4000)).toBe('¥4,000');
  });

  it('0 円も表示する', () => {
    // 0 を未入力と同じ扱いにすると「無料だった」が伝わらない
    expect(formatReviewBudget(0)).toBe('¥0');
  });

  it('未入力はダッシュにする', () => {
    expect(formatReviewBudget(null)).toBe(BUDGET_UNSET_LABEL);
  });
});
```

Run: `npm test -w @meshimap/mobile -- review-format`
Expected: FAIL（`Cannot find module './review-format'`）

- [ ] **Step 2: review-format.ts を実装する**

```ts
// apps/mobile/src/lib/review-format.ts
import { BUDGET_UNSET_LABEL, formatYen } from '@meshimap/core';
import type { JstDate } from '@meshimap/core';

/** 折りたたみ時に見せる行数 */
export const REVIEW_BODY_COLLAPSED_LINES = 4;

/** これを超える文字数なら「もっと見る」を出す */
export const REVIEW_BODY_EXPAND_THRESHOLD = 120;

const VISITED_SUFFIX = ' 訪問';
const YEAR_LABEL = '年';
const MONTH_LABEL = '月';
const DAY_LABEL = '日';
const LINE_BREAK = '\n';

/** `2026-09-10` を `2026年9月10日 訪問` にする */
export function formatVisitedOnLabel(date: JstDate): string {
  const [year, month, day] = date.split('-');
  if (year === undefined || month === undefined || day === undefined) {
    // toJstDate を通った値なら到達しないが、noUncheckedIndexedAccess のため明示する
    throw new RangeError(`訪問日の形式が不正です: "${date}"`);
  }
  return `${Number(year)}${YEAR_LABEL}${Number(month)}${MONTH_LABEL}${Number(day)}${DAY_LABEL}${VISITED_SUFFIX}`;
}

/**
 * 折りたたみが必要か。
 * 文字数だけで判定すると、短い行を並べた本文でカードが縦に伸びるのを止められないので、
 * 行数も条件に入れる。
 */
export function needsBodyExpansion(body: string): boolean {
  if (body.length > REVIEW_BODY_EXPAND_THRESHOLD) {
    return true;
  }
  return body.split(LINE_BREAK).length > REVIEW_BODY_COLLAPSED_LINES;
}

/** 支払額の表示。未入力は core と同じダッシュに揃える */
export function formatReviewBudget(budgetYen: number | null): string {
  return budgetYen === null ? BUDGET_UNSET_LABEL : formatYen(budgetYen);
}
```

Run: `npm test -w @meshimap/mobile -- review-format`
Expected: PASS（9 件）

- [ ] **Step 3: 失敗するテストを書く（カード）**

```tsx
// apps/mobile/src/components/review/review-card.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { REVIEW_BODY_COLLAPSED_LINES } from '@/lib/review-format';
import { buildReview } from '@/test-support/review-fixtures';

import { ReviewCard } from './review-card';

const SHORT_BODY = '串が一本ずつ丁寧でした。';
const LONG_BODY = 'あ'.repeat(200);

describe('ReviewCard', () => {
  it('投稿者名と本文を表示する', async () => {
    await render(
      <ReviewCard
        review={buildReview({ userName: 'たろう', body: SHORT_BODY })}
        isOwn={false}
        onPressEdit={jest.fn()}
        testID="review"
      />,
    );

    expect(screen.getByText('たろう')).toBeOnTheScreen();
    expect(screen.getByText(SHORT_BODY)).toBeOnTheScreen();
  });

  it('星と訪問日と支払額を表示する', async () => {
    await render(
      <ReviewCard
        review={buildReview({ rating: 4, visitedOn: '2026-09-10', budgetYen: 4000 })}
        isOwn={false}
        onPressEdit={jest.fn()}
        testID="review"
      />,
    );

    expect(screen.getByTestId('review-stars')).toBeOnTheScreen();
    expect(screen.getByText('2026年9月10日 訪問')).toBeOnTheScreen();
    expect(screen.getByText('¥4,000')).toBeOnTheScreen();
  });

  it('アバターが無いときは名前の頭文字を出す', async () => {
    await render(
      <ReviewCard
        review={buildReview({ userAvatarUrl: null, userName: 'たろう' })}
        isOwn={false}
        onPressEdit={jest.fn()}
        testID="review"
      />,
    );

    expect(screen.queryByTestId('review-avatar')).toBeNull();
    expect(screen.getByTestId('review-avatar-initial')).toHaveTextContent('た');
  });

  it('短い本文では行数を制限しない', async () => {
    await render(
      <ReviewCard
        review={buildReview({ body: SHORT_BODY })}
        isOwn={false}
        onPressEdit={jest.fn()}
        testID="review"
      />,
    );

    expect(screen.getByTestId('review-body').props.numberOfLines).toBeUndefined();
    expect(screen.queryByTestId('review-expand-button')).toBeNull();
  });

  it('長い本文は折りたたむ', async () => {
    await render(
      <ReviewCard
        review={buildReview({ body: LONG_BODY })}
        isOwn={false}
        onPressEdit={jest.fn()}
        testID="review"
      />,
    );

    expect(screen.getByTestId('review-body').props.numberOfLines).toBe(REVIEW_BODY_COLLAPSED_LINES);
    expect(screen.getByTestId('review-expand-button')).toHaveTextContent('もっと見る');
  });

  it('もっと見るを押すと全文が出る', async () => {
    await render(
      <ReviewCard
        review={buildReview({ body: LONG_BODY })}
        isOwn={false}
        onPressEdit={jest.fn()}
        testID="review"
      />,
    );
    await fireEvent.press(screen.getByTestId('review-expand-button'));

    expect(screen.getByTestId('review-body').props.numberOfLines).toBeUndefined();
    expect(screen.getByTestId('review-expand-button')).toHaveTextContent('折りたたむ');
  });

  it('写真を並べる', async () => {
    await render(
      <ReviewCard
        review={buildReview({
          photoUrls: ['https://cdn.example.test/r/1.jpg', 'https://cdn.example.test/r/2.jpg'],
        })}
        isOwn={false}
        onPressEdit={jest.fn()}
        testID="review"
      />,
    );

    expect(screen.getByTestId('review-photo-0')).toBeOnTheScreen();
    expect(screen.getByTestId('review-photo-1')).toBeOnTheScreen();
  });

  it('写真が無ければ並びごと出さない', async () => {
    await render(
      <ReviewCard
        review={buildReview({ photoUrls: [] })}
        isOwn={false}
        onPressEdit={jest.fn()}
        testID="review"
      />,
    );

    expect(screen.queryByTestId('review-photos')).toBeNull();
  });

  it('自分のレビューには編集ボタンを出す', async () => {
    const handleEdit = jest.fn();

    await render(
      <ReviewCard
        review={buildReview({ id: 'review-009' })}
        isOwn
        onPressEdit={handleEdit}
        testID="review"
      />,
    );
    await fireEvent.press(screen.getByTestId('review-edit-button'));

    expect(handleEdit).toHaveBeenCalledWith('review-009');
  });

  it('他人のレビューには編集ボタンを出さない', async () => {
    await render(
      <ReviewCard review={buildReview()} isOwn={false} onPressEdit={jest.fn()} testID="review" />,
    );

    expect(screen.queryByTestId('review-edit-button')).toBeNull();
  });
});
```

Run: `npm test -w @meshimap/mobile -- review-card`
Expected: FAIL（`Cannot find module './review-card'`）

- [ ] **Step 4: review-card.tsx を実装する**

```tsx
// apps/mobile/src/components/review/review-card.tsx
import type { ReviewId } from '@meshimap/core';
import { Image } from 'expo-image';
import { Pencil } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { StarRating } from '@/components/review/star-rating';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { COLORS, RADIUS, SPACING } from '@/constants/theme';
import type { Review } from '@/features/reviews/schema';
import {
  REVIEW_BODY_COLLAPSED_LINES,
  formatReviewBudget,
  formatVisitedOnLabel,
  needsBodyExpansion,
} from '@/lib/review-format';

const EXPAND_LABEL = 'もっと見る';
const COLLAPSE_LABEL = '折りたたむ';
const EDIT_LABEL = 'このレビューを編集する';
const PHOTO_LABEL_PREFIX = 'レビュー写真 ';
const PHOTO_LABEL_SUFFIX = ' 枚目';
const IMAGE_TRANSITION_MS = 200;

/** アバターの直径（px） */
const AVATAR_SIZE_PX = 36;
/** レビュー写真の一辺（px） */
const REVIEW_PHOTO_SIZE_PX = 96;

export interface ReviewCardProps {
  review: Review;
  /** ログイン中の利用者自身の投稿か。編集導線の出し分けに使う */
  isOwn: boolean;
  onPressEdit: (reviewId: ReviewId) => void;
  testID?: string | undefined;
}

export function ReviewCard({ review, isOwn, onPressEdit, testID }: ReviewCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  const canExpand = needsBodyExpansion(review.body);
  // 折りたたむ必要が無い本文に numberOfLines を付けると、端末によっては末尾が切れる
  const collapsedLines = canExpand && !isExpanded ? REVIEW_BODY_COLLAPSED_LINES : undefined;
  const { userAvatarUrl } = review;

  return (
    <Card testID={testID} padding="md">
      <View style={styles.header}>
        {userAvatarUrl === null ? (
          <View style={styles.avatarFallback}>
            <Text
              testID={childTestId('avatar-initial')}
              className="font-body-bold text-sm text-neutral-700"
            >
              {/* 配列添字ではなく slice を使う。noUncheckedIndexedAccess で undefined 分岐が増えるのを避ける */}
              {review.userName.slice(0, 1)}
            </Text>
          </View>
        ) : (
          <Image
            testID={childTestId('avatar')}
            source={userAvatarUrl}
            contentFit="cover"
            transition={IMAGE_TRANSITION_MS}
            style={styles.avatar}
          />
        )}

        <View style={styles.headerBody}>
          <Text className="font-body-medium text-sm text-neutral-900">{review.userName}</Text>
          <View style={styles.metaRow}>
            <StarRating rating={review.rating} testID={childTestId('stars')} />
            <Text className="font-body text-xs text-neutral-500">
              {formatVisitedOnLabel(review.visitedOn)}
            </Text>
            <Text className="font-body text-xs text-neutral-500">
              {formatReviewBudget(review.budgetYen)}
            </Text>
          </View>
        </View>

        {isOwn ? (
          <Pressable
            testID={childTestId('edit-button')}
            accessibilityRole="button"
            accessibilityLabel={EDIT_LABEL}
            onPress={() => {
              onPressEdit(review.id);
            }}
            style={styles.editButton}
          >
            <Icon icon={Pencil} size="sm" color={COLORS.neutral[500]} />
          </Pressable>
        ) : null}
      </View>

      <Text
        testID={childTestId('body')}
        numberOfLines={collapsedLines}
        className="font-body text-sm text-neutral-800"
        style={styles.body}
      >
        {review.body}
      </Text>

      {canExpand ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setIsExpanded((current) => !current);
          }}
        >
          <Text
            testID={childTestId('expand-button')}
            className="font-body-medium text-sm text-primary-600"
          >
            {isExpanded ? COLLAPSE_LABEL : EXPAND_LABEL}
          </Text>
        </Pressable>
      ) : null}

      {review.photoUrls.length === 0 ? null : (
        <ScrollView
          testID={childTestId('photos')}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.photos}
        >
          {review.photoUrls.map((url, index) => (
            <View
              key={url}
              testID={childTestId(`photo-${index}`)}
              accessible
              accessibilityRole="image"
              accessibilityLabel={`${PHOTO_LABEL_PREFIX}${index + 1}${PHOTO_LABEL_SUFFIX}`}
              style={styles.photo}
            >
              <Image
                source={url}
                contentFit="cover"
                transition={IMAGE_TRANSITION_MS}
                style={styles.photoImage}
              />
            </View>
          ))}
        </ScrollView>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  headerBody: {
    flex: 1,
    gap: SPACING.xs,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  avatar: {
    width: AVATAR_SIZE_PX,
    height: AVATAR_SIZE_PX,
    borderRadius: RADIUS.pill,
  },
  avatarFallback: {
    width: AVATAR_SIZE_PX,
    height: AVATAR_SIZE_PX,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.neutral[200],
  },
  editButton: {
    padding: SPACING.xs,
  },
  body: {
    marginTop: SPACING.sm,
  },
  photos: {
    gap: SPACING.sm,
    paddingTop: SPACING.sm,
  },
  photo: {
    width: REVIEW_PHOTO_SIZE_PX,
    height: REVIEW_PHOTO_SIZE_PX,
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    backgroundColor: COLORS.neutral[200],
  },
  photoImage: {
    width: '100%',
    height: '100%',
  },
});
```

`collapsedLines` を `undefined` にして `numberOfLines` に渡すのは、`exactOptionalPropertyTypes` 下でも問題ない。
`TextProps['numberOfLines']` は `?: number | undefined` と宣言されており、`undefined` の明示的な代入を許すため。

Run: `npm test -w @meshimap/mobile -- review-card`
Expected: PASS（10 件）

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`collapsedLines` を `REVIEW_BODY_COLLAPSED_LINES` 固定に変え、「短い本文では行数を制限しない」が **FAIL** することを確認してから戻す。次に `needsBodyExpansion` の行数判定を消し、「改行が多い本文も折りたたむ」が **FAIL** することも確認する。

- [ ] **Step 6: コミットする**

```bash
git add apps/mobile/src/lib/review-format.ts apps/mobile/src/lib/review-format.test.ts apps/mobile/src/components/review/review-card.tsx apps/mobile/src/components/review/review-card.test.tsx
git commit -m "feat(mobile): レビューカードを追加する"
```

---

### Task 6-28: レビューの API 層と取得・投稿フックを作る

**Files:**

- Create: `apps/mobile/src/constants/review.ts`
- Create: `apps/mobile/src/features/reviews/query-keys.ts`
- Create: `apps/mobile/src/features/reviews/api.ts`
- Create: `apps/mobile/src/features/reviews/api.test.ts`
- Create: `apps/mobile/src/features/reviews/use-shop-reviews.ts`
- Create: `apps/mobile/src/features/reviews/use-shop-reviews.test.tsx`
- Create: `apps/mobile/src/features/reviews/use-create-review.ts`
- Create: `apps/mobile/src/features/reviews/use-create-review.test.tsx`

**Interfaces:**

- Consumes: `@meshimap/core` の `reviewCreateSchema` / `webUrlSchema` / 型 `ShopId`、`@/lib/api-client` の `apiFetch`（Phase 5）、`@/features/shops/query-keys` の `shopKeys`、`@tanstack/react-query` の `useInfiniteQuery` / `useMutation` / `useQueryClient`
- Produces:
  - `REVIEW_PAGE_SIZE` / `REVIEW_PHOTO_MAX_COUNT` / `REVIEW_PHOTO_QUALITY`
  - `reviewKeys`
  - `reviewSubmitSchema` / 型 `ReviewSubmitInput`
  - `fetchShopReviews(params: ShopReviewsParams): Promise<ReviewPage>` / 型 `ShopReviewsParams`
  - `createReview(input: ReviewSubmitInput): Promise<Review>`
  - `uploadReviewPhoto(localUri: string): Promise<string>`
  - `useShopReviews(shopId: ShopId): ShopReviewsResult` / 型 `ShopReviewsResult` / 型 `ShopReviewsStatus`
  - `useCreateReview(shopId: ShopId): CreateReviewResult` / 型 `CreateReviewResult`

- [ ] **Step 1: 定数とクエリキーを作る**

```ts
// apps/mobile/src/constants/review.ts
/** 一覧の 1 ページあたり件数。カードが縦に長いので少なめにして初回表示を速くする */
export const REVIEW_PAGE_SIZE = 20;

/** 1 レビューに添付できる写真の枚数 */
export const REVIEW_PHOTO_MAX_COUNT = 4;

/** 端末で圧縮してからアップロードする品質（0〜1）。回線が細い場所での投稿失敗を減らす */
export const REVIEW_PHOTO_QUALITY = 0.7;

/** アップロード時のフォーム項目名。API 側（Phase 4）と揃える */
export const REVIEW_PHOTO_FORM_FIELD = 'file';
```

```ts
// apps/mobile/src/features/reviews/query-keys.ts
import type { ShopId } from '@meshimap/core';

/**
 * レビューのクエリキー。
 * 店舗ごとに独立したキーにして、1 店舗に投稿しても他店のキャッシュを捨てずに済むようにする。
 */
export const reviewKeys = {
  all: ['reviews'] as const,
  forShop: (shopId: ShopId) => [...reviewKeys.all, 'shop', shopId] as const,
};
```

- [ ] **Step 2: 失敗するテストを書く（API）**

```ts
// apps/mobile/src/features/reviews/api.test.ts
import { toShopId } from '@meshimap/core';

import { REVIEW_PAGE_SIZE } from '@/constants/review';
import { apiFetch } from '@/lib/api-client';

import { createReview, fetchShopReviews, uploadReviewPhoto } from './api';

jest.mock('@/lib/api-client', () => ({
  apiFetch: jest.fn(),
}));

const apiFetchMock = jest.mocked(apiFetch);

const SHOP_ID = toShopId('shop-001');

const REVIEW_JSON = {
  id: 'review-001',
  shopId: 'shop-001',
  userId: 'user-001',
  userName: 'たろう',
  userAvatarUrl: null,
  rating: 4,
  body: '串が一本ずつ丁寧でした。',
  visitedOn: '2026-09-10',
  budgetYen: 4000,
  photoUrls: [],
  createdAt: '2026-09-12T10:30:00.000Z',
};

describe('fetchShopReviews', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('店舗のレビュー一覧を取りに行く', async () => {
    apiFetchMock.mockResolvedValue({ reviews: [], nextCursor: null, totalCount: 0 });

    await fetchShopReviews({ shopId: SHOP_ID, cursor: null });

    expect(apiFetchMock).toHaveBeenCalledWith('/shops/shop-001/reviews', {
      method: 'GET',
      searchParams: { limit: String(REVIEW_PAGE_SIZE) },
    });
  });

  it('カーソルがあれば送る', async () => {
    apiFetchMock.mockResolvedValue({ reviews: [], nextCursor: null, totalCount: 0 });

    await fetchShopReviews({ shopId: SHOP_ID, cursor: 'cursor-2' });

    expect(apiFetchMock.mock.calls[0]?.[1]?.searchParams).toEqual({
      limit: String(REVIEW_PAGE_SIZE),
      cursor: 'cursor-2',
    });
  });

  it('レスポンスをスキーマで検証する', async () => {
    apiFetchMock.mockResolvedValue({ reviews: [REVIEW_JSON], nextCursor: null, totalCount: 1 });

    const page = await fetchShopReviews({ shopId: SHOP_ID, cursor: null });

    expect(page.reviews[0]?.userName).toBe('たろう');
  });

  it('壊れたレスポンスで例外にする', async () => {
    // 画面まで不正な値を持ち込まない。ここで落ちれば error 状態として扱える
    apiFetchMock.mockResolvedValue({
      reviews: [{ ...REVIEW_JSON, rating: 9 }],
      nextCursor: null,
      totalCount: 1,
    });

    await expect(fetchShopReviews({ shopId: SHOP_ID, cursor: null })).rejects.toThrow();
  });
});

describe('createReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('本文をそのまま POST する', async () => {
    apiFetchMock.mockResolvedValue(REVIEW_JSON);

    await createReview({
      shopId: 'shop-001',
      rating: 4,
      body: '串が一本ずつ丁寧でした。',
      visitedOn: '2026-09-10',
      budgetYen: 4000,
      photoUrls: [],
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/reviews', {
      method: 'POST',
      body: {
        shopId: 'shop-001',
        rating: 4,
        body: '串が一本ずつ丁寧でした。',
        visitedOn: '2026-09-10',
        budgetYen: 4000,
        photoUrls: [],
      },
    });
  });

  it('送信前に入力を検証する', async () => {
    // 空本文をサーバまで運ばない。往復ぶんの待ち時間が無駄になる
    await expect(
      createReview({
        shopId: 'shop-001',
        rating: 4,
        body: '   ',
        visitedOn: '2026-09-10',
        budgetYen: null,
        photoUrls: [],
      }),
    ).rejects.toThrow();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('作成結果をスキーマで検証して返す', async () => {
    apiFetchMock.mockResolvedValue(REVIEW_JSON);

    const review = await createReview({
      shopId: 'shop-001',
      rating: 4,
      body: '串が一本ずつ丁寧でした。',
      visitedOn: '2026-09-10',
      budgetYen: 4000,
      photoUrls: [],
    });

    expect(review.id).toBe('review-001');
  });
});

describe('uploadReviewPhoto', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('FormData で送り、返ってきた URL を返す', async () => {
    apiFetchMock.mockResolvedValue({ url: 'https://cdn.example.test/reviews/new.jpg' });

    const url = await uploadReviewPhoto('file:///tmp/photo.jpg');

    expect(url).toBe('https://cdn.example.test/reviews/new.jpg');
    const [path, init] = apiFetchMock.mock.calls[0] ?? [];
    expect(path).toBe('/uploads/review-photos');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('http/https 以外の URL が返ったら例外にする', async () => {
    apiFetchMock.mockResolvedValue({ url: 'javascript:alert(1)' });

    await expect(uploadReviewPhoto('file:///tmp/photo.jpg')).rejects.toThrow();
  });
});
```

Run: `npm test -w @meshimap/mobile -- reviews/api`
Expected: FAIL（`Cannot find module './api'`）

- [ ] **Step 3: api.ts を実装する**

```ts
// apps/mobile/src/features/reviews/api.ts
import { reviewCreateSchema, webUrlSchema } from '@meshimap/core';
import type { ShopId } from '@meshimap/core';
import { z } from 'zod';

import {
  REVIEW_PAGE_SIZE,
  REVIEW_PHOTO_FORM_FIELD,
  REVIEW_PHOTO_MAX_COUNT,
} from '@/constants/review';
import { apiFetch } from '@/lib/api-client';

import { reviewPageSchema, reviewSchema } from './schema';
import type { Review, ReviewPage } from './schema';

/**
 * 投稿フォームが送る値。
 * core の reviewCreateSchema（shopId / rating / body / visitedOn / budgetYen）に、
 * アップロード済み写真の URL を足したもの。core 側に UI 都合の項目を持ち込まないため
 * 拡張はアプリ側で行う。
 */
export const reviewSubmitSchema = reviewCreateSchema.extend({
  photoUrls: z.array(webUrlSchema).max(REVIEW_PHOTO_MAX_COUNT),
});
export type ReviewSubmitInput = z.input<typeof reviewSubmitSchema>;

const uploadedPhotoSchema = z.object({ url: webUrlSchema });

export interface ShopReviewsParams {
  readonly shopId: ShopId;
  readonly cursor: string | null;
}

export async function fetchShopReviews(params: ShopReviewsParams): Promise<ReviewPage> {
  const searchParams: Record<string, string> = { limit: String(REVIEW_PAGE_SIZE) };
  if (params.cursor !== null) {
    searchParams.cursor = params.cursor;
  }

  const payload = await apiFetch(`/shops/${params.shopId}/reviews`, {
    method: 'GET',
    searchParams,
  });
  return reviewPageSchema.parse(payload);
}

/** 投稿する。送る前に手元で検証して、往復ぶんの待ち時間を無駄にしない */
export async function createReview(input: ReviewSubmitInput): Promise<Review> {
  const body = reviewSubmitSchema.parse(input);
  const payload = await apiFetch('/reviews', { method: 'POST', body });
  return reviewSchema.parse(payload);
}

/**
 * 端末内の写真を 1 枚アップロードして、公開 URL を得る。
 * React Native の FormData は `{ uri, name, type }` の形のオブジェクトを受け付ける
 * （ブラウザの File / Blob は使えない）。
 */
export async function uploadReviewPhoto(localUri: string): Promise<string> {
  const formData = new FormData();
  const fileName = localUri.split('/').pop() ?? 'photo.jpg';
  // React Native 固有の形。DOM の FormData 型とは食い違うため型注釈で明示する
  const filePart: { uri: string; name: string; type: string } = {
    uri: localUri,
    name: fileName,
    type: 'image/jpeg',
  };
  formData.append(REVIEW_PHOTO_FORM_FIELD, filePart as unknown as Blob);

  const payload = await apiFetch('/uploads/review-photos', { method: 'POST', body: formData });
  return uploadedPhotoSchema.parse(payload).url;
}
```

`formData.append(field, filePart as unknown as Blob)` の `as` は、RN の FormData が
DOM の型定義（`Blob | string` しか受け付けない）と食い違うためにここだけ必要になる。
ブランド型の生成点以外で `as` を使う唯一の箇所なので、理由をコメントに残す。

Run: `npm test -w @meshimap/mobile -- reviews/api`
Expected: PASS（9 件）

- [ ] **Step 4: 失敗するテストを書く（一覧フック）**

```tsx
// apps/mobile/src/features/reviews/use-shop-reviews.test.tsx
import { toShopId } from '@meshimap/core';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildReviewList } from '@/test-support/review-fixtures';

import { fetchShopReviews } from './api';
import { useShopReviews } from './use-shop-reviews';

jest.mock('./api', () => ({ fetchShopReviews: jest.fn() }));

const fetchShopReviewsMock = jest.mocked(fetchShopReviews);

const SHOP_ID = toShopId('shop-001');

function renderReviewsHook() {
  const queryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  }
  return renderHook(() => useShopReviews(SHOP_ID), { wrapper: Wrapper });
}

describe('useShopReviews', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('最初は loading', async () => {
    fetchShopReviewsMock.mockReturnValue(new Promise(() => {}));

    const { result } = await renderReviewsHook();

    expect(result.current.status).toBe('loading');
    expect(result.current.reviews).toEqual([]);
  });

  it('1 ページ目を平坦化して返す', async () => {
    fetchShopReviewsMock.mockResolvedValue({
      reviews: buildReviewList(3),
      nextCursor: null,
      totalCount: 3,
    });

    const { result } = await renderReviewsHook();

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.reviews).toHaveLength(3);
    expect(result.current.totalCount).toBe(3);
  });

  it('1 件も無ければ empty', async () => {
    fetchShopReviewsMock.mockResolvedValue({ reviews: [], nextCursor: null, totalCount: 0 });

    const { result } = await renderReviewsHook();

    await waitFor(() => {
      expect(result.current.status).toBe('empty');
    });
  });

  it('次ページを読み込むと連結する', async () => {
    fetchShopReviewsMock
      .mockResolvedValueOnce({ reviews: buildReviewList(2), nextCursor: 'cursor-2', totalCount: 4 })
      .mockResolvedValueOnce({ reviews: buildReviewList(2), nextCursor: null, totalCount: 4 });

    const { result } = await renderReviewsHook();
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    result.current.loadMore();

    await waitFor(() => {
      expect(result.current.reviews).toHaveLength(4);
    });
    expect(fetchShopReviewsMock).toHaveBeenLastCalledWith({ shopId: SHOP_ID, cursor: 'cursor-2' });
  });

  it('次ページが無いときは読みに行かない', async () => {
    fetchShopReviewsMock.mockResolvedValue({
      reviews: buildReviewList(2),
      nextCursor: null,
      totalCount: 2,
    });

    const { result } = await renderReviewsHook();
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    result.current.loadMore();

    await waitFor(() => {
      expect(result.current.hasMore).toBe(false);
    });
    expect(fetchShopReviewsMock).toHaveBeenCalledTimes(1);
  });

  it('失敗したら error', async () => {
    fetchShopReviewsMock.mockRejectedValue(new Error('network'));

    const { result } = await renderReviewsHook();

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
  });
});
```

Run: `npm test -w @meshimap/mobile -- use-shop-reviews`
Expected: FAIL（`Cannot find module './use-shop-reviews'`）

- [ ] **Step 5: use-shop-reviews.ts を実装する**

```ts
// apps/mobile/src/features/reviews/use-shop-reviews.ts
import type { ShopId } from '@meshimap/core';
import { useInfiniteQuery } from '@tanstack/react-query';

import { fetchShopReviews } from './api';
import { reviewKeys } from './query-keys';
import type { Review } from './schema';

export type ShopReviewsStatus = 'loading' | 'error' | 'empty' | 'success';

export interface ShopReviewsResult {
  reviews: readonly Review[];
  totalCount: number;
  status: ShopReviewsStatus;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

export function useShopReviews(shopId: ShopId): ShopReviewsResult {
  const query = useInfiniteQuery({
    queryKey: reviewKeys.forShop(shopId),
    queryFn: ({ pageParam }) => fetchShopReviews({ shopId, cursor: pageParam }),
    // 型注釈が無いと string へ推論され、2 ページ目以降のカーソルが渡せなくなる
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const pages = query.data?.pages ?? [];
  const reviews = pages.flatMap((page) => page.reviews);
  // totalCount は毎ページ同じ値が返る。最後に取れたページの値を採用する
  const totalCount = pages.at(-1)?.totalCount ?? 0;

  const status: ShopReviewsStatus = query.isError
    ? 'error'
    : query.isPending
      ? 'loading'
      : reviews.length === 0
        ? 'empty'
        : 'success';

  return {
    reviews,
    totalCount,
    status,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => {
      // hasNextPage の判定を呼び出し側に任せると、末尾スクロールのたびに無駄な再取得が走る
      if (query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    },
    refetch: () => {
      void query.refetch();
    },
  };
}
```

Run: `npm test -w @meshimap/mobile -- use-shop-reviews`
Expected: PASS（6 件）

- [ ] **Step 6: 失敗するテストを書く（投稿フック）**

```tsx
// apps/mobile/src/features/reviews/use-create-review.test.tsx
import { toShopId } from '@meshimap/core';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { shopKeys } from '@/features/shops/query-keys';
import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildReview } from '@/test-support/review-fixtures';

import { createReview, uploadReviewPhoto } from './api';
import { reviewKeys } from './query-keys';
import { useCreateReview } from './use-create-review';

jest.mock('./api', () => ({ createReview: jest.fn(), uploadReviewPhoto: jest.fn() }));

const createReviewMock = jest.mocked(createReview);
const uploadReviewPhotoMock = jest.mocked(uploadReviewPhoto);

const SHOP_ID = toShopId('shop-001');

const FORM_VALUES = {
  rating: 4,
  body: '串が一本ずつ丁寧でした。',
  visitedOn: '2026-09-10',
  budgetYen: 4000,
  localPhotoUris: [] as readonly string[],
};

function renderCreateHook() {
  const queryClient = createTestQueryClient();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  }
  const rendered = renderHook(() => useCreateReview(SHOP_ID), { wrapper: Wrapper });
  return { rendered, invalidate };
}

describe('useCreateReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('最初は idle', async () => {
    const { rendered } = renderCreateHook();
    const { result } = await rendered;

    expect(result.current.status).toBe('idle');
  });

  it('写真が無ければアップロードせずに投稿する', async () => {
    createReviewMock.mockResolvedValue(buildReview());
    const { rendered } = renderCreateHook();
    const { result } = await rendered;

    result.current.submit(FORM_VALUES);

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(uploadReviewPhotoMock).not.toHaveBeenCalled();
    expect(createReviewMock).toHaveBeenCalledWith({
      shopId: 'shop-001',
      rating: 4,
      body: '串が一本ずつ丁寧でした。',
      visitedOn: '2026-09-10',
      budgetYen: 4000,
      photoUrls: [],
    });
  });

  it('写真を先にアップロードしてから投稿する', async () => {
    uploadReviewPhotoMock
      .mockResolvedValueOnce('https://cdn.example.test/r/a.jpg')
      .mockResolvedValueOnce('https://cdn.example.test/r/b.jpg');
    createReviewMock.mockResolvedValue(buildReview());
    const { rendered } = renderCreateHook();
    const { result } = await rendered;

    result.current.submit({
      ...FORM_VALUES,
      localPhotoUris: ['file:///tmp/a.jpg', 'file:///tmp/b.jpg'],
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(uploadReviewPhotoMock).toHaveBeenCalledTimes(2);
    expect(createReviewMock.mock.calls[0]?.[0]?.photoUrls).toEqual([
      'https://cdn.example.test/r/a.jpg',
      'https://cdn.example.test/r/b.jpg',
    ]);
  });

  it('写真の順番を保つ', async () => {
    // Promise.all は解決順に並ばないので、添字での復元が必要
    uploadReviewPhotoMock.mockImplementation(async (uri) => {
      const delay = uri.endsWith('a.jpg') ? 20 : 0;
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
      return `https://cdn.example.test/r/${uri.endsWith('a.jpg') ? 'a' : 'b'}.jpg`;
    });
    createReviewMock.mockResolvedValue(buildReview());
    const { rendered } = renderCreateHook();
    const { result } = await rendered;

    result.current.submit({
      ...FORM_VALUES,
      localPhotoUris: ['file:///tmp/a.jpg', 'file:///tmp/b.jpg'],
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(createReviewMock.mock.calls[0]?.[0]?.photoUrls).toEqual([
      'https://cdn.example.test/r/a.jpg',
      'https://cdn.example.test/r/b.jpg',
    ]);
  });

  it('成功したらレビュー一覧と店舗詳細を無効化する', async () => {
    // 詳細に出す平均評価と評価分布が変わるので、詳細のキャッシュも捨てる
    createReviewMock.mockResolvedValue(buildReview());
    const { rendered, invalidate } = renderCreateHook();
    const { result } = await rendered;

    result.current.submit(FORM_VALUES);

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: reviewKeys.forShop(SHOP_ID) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: shopKeys.detail(SHOP_ID) });
  });

  it('アップロードに失敗したら投稿しない', async () => {
    uploadReviewPhotoMock.mockRejectedValue(new Error('upload failed'));
    const { rendered } = renderCreateHook();
    const { result } = await rendered;

    result.current.submit({ ...FORM_VALUES, localPhotoUris: ['file:///tmp/a.jpg'] });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(createReviewMock).not.toHaveBeenCalled();
  });

  it('投稿に失敗したらエラーメッセージを返す', async () => {
    createReviewMock.mockRejectedValue(new Error('投稿に失敗しました'));
    const { rendered } = renderCreateHook();
    const { result } = await rendered;

    result.current.submit(FORM_VALUES);

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorMessage).toBe('投稿に失敗しました');
  });

  it('やり直すと状態が戻る', async () => {
    createReviewMock.mockRejectedValue(new Error('network'));
    const { rendered } = renderCreateHook();
    const { result } = await rendered;

    result.current.submit(FORM_VALUES);
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    result.current.reset();

    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    expect(result.current.errorMessage).toBeNull();
  });
});
```

Run: `npm test -w @meshimap/mobile -- use-create-review`
Expected: FAIL（`Cannot find module './use-create-review'`）

- [ ] **Step 7: use-create-review.ts を実装する**

```ts
// apps/mobile/src/features/reviews/use-create-review.ts
import type { ShopId } from '@meshimap/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { shopKeys } from '@/features/shops/query-keys';

import { createReview, uploadReviewPhoto } from './api';
import { reviewKeys } from './query-keys';
import type { Review } from './schema';

const UNKNOWN_ERROR_MESSAGE = 'レビューの投稿に失敗しました';

export type CreateReviewStatus = 'idle' | 'submitting' | 'error' | 'success';

/** フォームが持つ値。写真は端末内のローカル URI のまま受け取り、送信時にアップロードする */
export interface ReviewFormValues {
  readonly rating: number;
  readonly body: string;
  readonly visitedOn: string;
  readonly budgetYen: number | null;
  readonly localPhotoUris: readonly string[];
}

export interface CreateReviewResult {
  status: CreateReviewStatus;
  errorMessage: string | null;
  createdReview: Review | null;
  submit: (values: ReviewFormValues) => void;
  reset: () => void;
}

export function useCreateReview(shopId: ShopId): CreateReviewResult {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (values: ReviewFormValues): Promise<Review> => {
      // Promise.all は解決順に並ばないが、戻り値の配列は入力順に対応するので順番は保たれる
      const photoUrls = await Promise.all(
        values.localPhotoUris.map((uri) => uploadReviewPhoto(uri)),
      );

      return createReview({
        shopId,
        rating: values.rating,
        body: values.body,
        visitedOn: values.visitedOn,
        budgetYen: values.budgetYen,
        photoUrls,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.forShop(shopId) });
      // 平均評価と評価分布が変わるので詳細も捨てる
      void queryClient.invalidateQueries({ queryKey: shopKeys.detail(shopId) });
    },
  });

  const status: CreateReviewStatus = mutation.isPending
    ? 'submitting'
    : mutation.isError
      ? 'error'
      : mutation.isSuccess
        ? 'success'
        : 'idle';

  return {
    status,
    errorMessage:
      mutation.error === null
        ? null
        : mutation.error instanceof Error
          ? mutation.error.message
          : UNKNOWN_ERROR_MESSAGE,
    createdReview: mutation.data ?? null,
    submit: (values) => {
      mutation.mutate(values);
    },
    reset: () => {
      mutation.reset();
    },
  };
}
```

`shopId` は `ReviewSubmitInput` の `shopId`（`identifierSchema` = 素の string）に代入する。
`ShopId` はブランド付きの string なので、そのまま渡せる（逆方向は不可）。

Run: `npm test -w @meshimap/mobile -- use-create-review`
Expected: PASS（8 件）

- [ ] **Step 8: わざと壊してテストが落ちることを確認する**

`Promise.all` を `for` ループの逐次 await から `Promise.race` に変え、「写真の順番を保つ」と「写真を先にアップロードしてから投稿する」が **FAIL** することを確認してから戻す。次に `onSuccess` の `shopKeys.detail` の無効化を消し、「成功したらレビュー一覧と店舗詳細を無効化する」が **FAIL** することも確認する。

- [ ] **Step 9: コミットする**

```bash
git add apps/mobile/src/constants/review.ts apps/mobile/src/features/reviews/
git commit -m "feat(mobile): レビューの API 層と取得・投稿フックを追加する"
```

---

### Task 6-29: レビュー投稿フォームの入力部品を作る

**Files:**

- Create: `apps/mobile/src/lib/visit-date-options.ts`
- Create: `apps/mobile/src/lib/visit-date-options.test.ts`
- Create: `apps/mobile/src/components/review/star-rating-input.tsx`
- Create: `apps/mobile/src/components/review/star-rating-input.test.tsx`
- Create: `apps/mobile/src/components/review/visit-date-picker.tsx`
- Create: `apps/mobile/src/components/review/visit-date-picker.test.tsx`
- Create: `apps/mobile/src/components/review/photo-picker.tsx`
- Create: `apps/mobile/src/components/review/photo-picker.test.tsx`

**Interfaces:**

- Consumes: `@meshimap/core` の `addJstDays` / `toJstClock` / `toRating` / 型 `JstDate` `Rating`、`@/lib/weekly-business-hours` の `formatJstDateLabel`、`@/lib/star-rating` の `filledStarCount` / `starAppearance`、`@/features/shops/schema` の `RATING_VALUES`、`@/constants/review` の `REVIEW_PHOTO_MAX_COUNT` / `REVIEW_PHOTO_QUALITY`、`expo-image-picker` の `launchImageLibraryAsync` / `requestMediaLibraryPermissionsAsync`、`lucide-react-native` の `Star` `Camera` `X`
- Produces:
  - `VISIT_DATE_OPTION_COUNT` / `visitDateOptions(now: Date): readonly VisitDateOption[]` / 型 `VisitDateOption`
  - `StarRatingInput` / 型 `StarRatingInputProps`
  - `VisitDatePicker` / 型 `VisitDatePickerProps`
  - `PhotoPicker` / 型 `PhotoPickerProps`

日付選択は端末のカレンダー UI を使わない。`@react-native-community/datetimepicker` は依存に無く、
`expo-image-picker` 以外の新規ネイティブ依存を Phase 6 で増やしたくないため、
「直近 14 日を横スクロールのチップで選ぶ」方式にする。レビューは訪問直後に書かれることが
ほとんどなので、これで実用上は足りる。

- [ ] **Step 1: 失敗するテストを書く（訪問日の選択肢）**

```ts
// apps/mobile/src/lib/visit-date-options.test.ts
import { VISIT_DATE_OPTION_COUNT, visitDateOptions } from './visit-date-options';

// 2026-09-15 08:00 JST（= 2026-09-14T23:00Z）。JST 換算を跨ぐ時刻をあえて選ぶ
const NOW = new Date('2026-09-14T23:00:00.000Z');

describe('visitDateOptions', () => {
  it('14 件返す', () => {
    expect(visitDateOptions(NOW)).toHaveLength(VISIT_DATE_OPTION_COUNT);
  });

  it('先頭は今日', () => {
    const [first] = visitDateOptions(NOW);

    expect(first?.value).toBe('2026-09-15');
    expect(first?.label).toBe('今日');
  });

  it('2 件目は昨日', () => {
    const second = visitDateOptions(NOW)[1];

    expect(second?.value).toBe('2026-09-14');
    expect(second?.label).toBe('昨日');
  });

  it('3 件目以降は日付と曜日を出す', () => {
    const third = visitDateOptions(NOW)[2];

    expect(third?.value).toBe('2026-09-13');
    expect(third?.label).toBe('9/13（日）');
  });

  it('末尾は 13 日前', () => {
    const options = visitDateOptions(NOW);

    expect(options.at(-1)?.value).toBe('2026-09-02');
  });

  it('月を跨いでも正しく遡る', () => {
    const options = visitDateOptions(new Date('2026-03-01T03:00:00.000Z'));

    expect(options[0]?.value).toBe('2026-03-01');
    expect(options[1]?.value).toBe('2026-02-28');
  });

  it('未来の日付は含まない', () => {
    const options = visitDateOptions(NOW);

    expect(options.every((option) => option.value <= '2026-09-15')).toBe(true);
  });
});
```

Run: `npm test -w @meshimap/mobile -- visit-date-options`
Expected: FAIL（`Cannot find module './visit-date-options'`）

- [ ] **Step 2: visit-date-options.ts を実装する**

```ts
// apps/mobile/src/lib/visit-date-options.ts
import { addJstDays, toJstClock } from '@meshimap/core';
import type { JstDate } from '@meshimap/core';

import { formatJstDateLabel } from './weekly-business-hours';

/** 選べる過去日数。訪問直後に書かれる前提で 2 週間ぶんに絞る */
export const VISIT_DATE_OPTION_COUNT = 14;

const TODAY_LABEL = '今日';
const YESTERDAY_LABEL = '昨日';
/** 「今日」「昨日」を文字で出す範囲。これより前は日付と曜日で示す */
const RELATIVE_LABELS = [TODAY_LABEL, YESTERDAY_LABEL] as const;

export interface VisitDateOption {
  readonly value: JstDate;
  readonly label: string;
}

/**
 * 今日から遡る訪問日の候補を新しい順に返す。
 * 未来日は返さないので、画面側で「未来は選べない」を別途検証しなくてよい。
 */
export function visitDateOptions(now: Date): readonly VisitDateOption[] {
  const today = toJstClock(now).date;

  return Array.from({ length: VISIT_DATE_OPTION_COUNT }, (_unused, index) => {
    const value = addJstDays(today, -index);
    const relativeLabel = RELATIVE_LABELS[index];
    return {
      value,
      label: relativeLabel ?? formatJstDateLabel(value),
    };
  });
}
```

Run: `npm test -w @meshimap/mobile -- visit-date-options`
Expected: PASS（7 件）

- [ ] **Step 3: 失敗するテストを書く（星の入力）**

```tsx
// apps/mobile/src/components/review/star-rating-input.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { COLORS } from '@/constants/theme';

import { StarRatingInput } from './star-rating-input';

describe('StarRatingInput', () => {
  it('星を 5 つ出す', async () => {
    await render(<StarRatingInput value={0} onChange={jest.fn()} testID="stars" />);

    expect(screen.getAllByTestId(/^stars-star-\d$/)).toHaveLength(5);
  });

  it('押した星の数を数値で通知する', async () => {
    const onChange = jest.fn();
    await render(<StarRatingInput value={0} onChange={onChange} testID="stars" />);

    fireEvent.press(screen.getByTestId('stars-star-4'));

    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('未選択のときは選択済みの星が無い', async () => {
    await render(<StarRatingInput value={0} onChange={jest.fn()} testID="stars" />);

    expect(screen.getByTestId('stars-star-1')).toHaveStyle({ opacity: 1 });
    expect(screen.queryByText('4')).toBeNull();
  });

  it('選択済みの数を文字でも示す', async () => {
    // 色だけで状態を伝えないようにする（色覚特性への配慮）
    await render(<StarRatingInput value={4} onChange={jest.fn()} testID="stars" />);

    expect(screen.getByTestId('stars-value')).toHaveTextContent('4 / 5');
  });

  it('未選択のときは選択を促す文言を出す', async () => {
    await render(<StarRatingInput value={0} onChange={jest.fn()} testID="stars" />);

    expect(screen.getByTestId('stars-value')).toHaveTextContent('未選択');
  });

  it('星ごとに読み上げ用のラベルを持つ', async () => {
    await render(<StarRatingInput value={0} onChange={jest.fn()} testID="stars" />);

    expect(screen.getByTestId('stars-star-3')).toHaveProp('accessibilityLabel', '星 3 をつける');
  });

  it('選択済みの星は選択状態を持つ', async () => {
    await render(<StarRatingInput value={3} onChange={jest.fn()} testID="stars" />);

    expect(screen.getByTestId('stars-star-3')).toHaveProp('accessibilityState', { selected: true });
    expect(screen.getByTestId('stars-star-4')).toHaveProp('accessibilityState', {
      selected: false,
    });
  });

  it('エラーメッセージを出す', async () => {
    await render(
      <StarRatingInput
        value={0}
        onChange={jest.fn()}
        errorMessage="評価を選択してください"
        testID="stars"
      />,
    );

    expect(screen.getByTestId('stars-error')).toHaveTextContent('評価を選択してください');
    expect(screen.getByTestId('stars-error')).toHaveStyle({ color: COLORS.red[700] });
  });

  it('エラーが無いときはエラー欄を出さない', async () => {
    await render(<StarRatingInput value={3} onChange={jest.fn()} testID="stars" />);

    expect(screen.queryByTestId('stars-error')).toBeNull();
  });
});
```

Run: `npm test -w @meshimap/mobile -- star-rating-input`
Expected: FAIL（`Cannot find module './star-rating-input'`）

- [ ] **Step 4: star-rating-input.tsx を実装する**

```tsx
// apps/mobile/src/components/review/star-rating-input.tsx
import { toRating } from '@meshimap/core';
import type { Rating } from '@meshimap/core';
import { Star } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { COLORS, RATING_MAX_LABEL } from '@/constants/theme';
import { RATING_VALUES } from '@/features/shops/schema';
import { filledStarCount, starAppearance } from '@/lib/star-rating';

/** 指で押す前提のサイズ。表示専用の星（14 / 20px）より大きくする */
const STAR_INPUT_PIXEL_SIZE = 36;

/** 未選択のときに数値欄へ出す文言 */
const UNSELECTED_LABEL = '未選択';

export interface StarRatingInputProps {
  value: number;
  onChange: (rating: Rating) => void;
  errorMessage?: string | undefined;
  testID?: string | undefined;
}

export function StarRatingInput({ value, onChange, errorMessage, testID }: StarRatingInputProps) {
  const filledCount = filledStarCount(value);
  const hasError = errorMessage !== undefined && errorMessage !== '';

  return (
    <View className="gap-xs">
      <View className="flex-row items-center gap-sm">
        <View className="flex-row items-center gap-xs">
          {RATING_VALUES.map((starValue) => {
            const appearance = starAppearance(starValue, filledCount);
            return (
              <Pressable
                accessibilityLabel={`星 ${starValue} をつける`}
                accessibilityRole="button"
                accessibilityState={{ selected: starValue <= filledCount }}
                key={starValue}
                onPress={() => {
                  // 0〜5 の範囲は RATING_VALUES 側で保証済み。ここで確実にブランド型へ変換する
                  onChange(toRating(starValue));
                }}
                testID={testID === undefined ? undefined : `${testID}-star-${starValue}`}
              >
                <Star
                  color={appearance.color}
                  fill={appearance.fill}
                  size={STAR_INPUT_PIXEL_SIZE}
                />
              </Pressable>
            );
          })}
        </View>

        {/* 色だけで状態を伝えないよう、選んだ数を文字でも出す */}
        <Text
          className="font-body-medium text-base text-neutral-700"
          testID={testID === undefined ? undefined : `${testID}-value`}
        >
          {filledCount === 0 ? UNSELECTED_LABEL : `${filledCount} / ${RATING_MAX_LABEL}`}
        </Text>
      </View>

      {hasError ? (
        <Text
          accessibilityRole="alert"
          className="font-body text-xs"
          // NativeWind は Jest で className を style に変換しないため、色は style で持たせる
          style={{ color: COLORS.red[700] }}
          testID={testID === undefined ? undefined : `${testID}-error`}
        >
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}
```

`RATING_MAX_LABEL` は `@/constants/theme` には無いので、`@/constants/review` に追加する。

```ts
// apps/mobile/src/constants/review.ts に追記
import { RATING_MAX } from '@meshimap/core';

/** 「4 / 5」のような表示に使う分母。RATING_MAX と二重管理しない */
export const RATING_MAX_LABEL = String(RATING_MAX);
```

`star-rating-input.tsx` の import は次のとおりに直す。

```tsx
import { COLORS } from '@/constants/theme';
import { RATING_MAX_LABEL } from '@/constants/review';
```

Run: `npm test -w @meshimap/mobile -- star-rating-input`
Expected: PASS（9 件）

- [ ] **Step 5: 失敗するテストを書く（訪問日の選択）**

```tsx
// apps/mobile/src/components/review/visit-date-picker.test.tsx
import { toJstDate } from '@meshimap/core';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { COLORS } from '@/constants/theme';

import { VisitDatePicker } from './visit-date-picker';

const NOW = new Date('2026-09-14T23:00:00.000Z'); // 2026-09-15 08:00 JST

describe('VisitDatePicker', () => {
  it('候補を 14 件出す', async () => {
    await render(
      <VisitDatePicker
        value={toJstDate('2026-09-15')}
        onChange={jest.fn()}
        now={NOW}
        testID="visited"
      />,
    );

    expect(screen.getAllByTestId(/^visited-option-\d{4}-\d{2}-\d{2}$/)).toHaveLength(14);
  });

  it('押した日付を通知する', async () => {
    const onChange = jest.fn();
    await render(
      <VisitDatePicker
        value={toJstDate('2026-09-15')}
        onChange={onChange}
        now={NOW}
        testID="visited"
      />,
    );

    fireEvent.press(screen.getByTestId('visited-option-2026-09-13'));

    expect(onChange).toHaveBeenCalledWith('2026-09-13');
  });

  it('選択中の日付だけ強調する', async () => {
    await render(
      <VisitDatePicker
        value={toJstDate('2026-09-13')}
        onChange={jest.fn()}
        now={NOW}
        testID="visited"
      />,
    );

    expect(screen.getByTestId('visited-option-2026-09-13')).toHaveStyle({
      backgroundColor: COLORS.primary[500],
    });
    expect(screen.getByTestId('visited-option-2026-09-15')).toHaveStyle({
      backgroundColor: COLORS.white,
    });
  });

  it('選択中の日付は選択状態を持つ', async () => {
    await render(
      <VisitDatePicker
        value={toJstDate('2026-09-13')}
        onChange={jest.fn()}
        now={NOW}
        testID="visited"
      />,
    );

    expect(screen.getByTestId('visited-option-2026-09-13')).toHaveProp('accessibilityState', {
      selected: true,
    });
  });

  it('相対表記のラベルを出す', async () => {
    await render(
      <VisitDatePicker
        value={toJstDate('2026-09-15')}
        onChange={jest.fn()}
        now={NOW}
        testID="visited"
      />,
    );

    expect(screen.getByText('今日')).toBeOnTheScreen();
    expect(screen.getByText('昨日')).toBeOnTheScreen();
    expect(screen.getByText('9/13（日）')).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- visit-date-picker`
Expected: FAIL（`Cannot find module './visit-date-picker'`）

- [ ] **Step 6: visit-date-picker.tsx を実装する**

```tsx
// apps/mobile/src/components/review/visit-date-picker.tsx
import type { JstDate } from '@meshimap/core';
import { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { COLORS, RADIUS, SPACING } from '@/constants/theme';
import { visitDateOptions } from '@/lib/visit-date-options';

export interface VisitDatePickerProps {
  /**
   * 選択中の日付（YYYY-MM-DD）。
   * react-hook-form の値は素の string で入ってくるので、受け取りは string にして
   * 画面側で toJstDate を通す必要をなくす。通知する側（onChange）はブランド型で返す。
   */
  value: string;
  onChange: (value: JstDate) => void;
  now: Date;
  testID?: string | undefined;
}

export function VisitDatePicker({ value, onChange, now, testID }: VisitDatePickerProps) {
  // now が変わらない限り 14 件の生成をやり直さない
  const options = useMemo(() => visitDateOptions(now), [now]);

  return (
    <View className="gap-xs">
      <Text className="font-body-medium text-sm text-neutral-700">訪問日</Text>
      <ScrollView
        contentContainerStyle={{ gap: SPACING.xs, paddingHorizontal: SPACING.xs }}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {options.map((option) => {
          const isSelected = option.value === value;
          return (
            <Pressable
              accessibilityLabel={`訪問日を ${option.label} にする`}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              key={option.value}
              onPress={() => {
                onChange(option.value);
              }}
              // 選択状態は toHaveStyle で検証するため style 側で持たせる
              style={{
                backgroundColor: isSelected ? COLORS.primary[500] : COLORS.white,
                borderColor: isSelected ? COLORS.primary[500] : COLORS.neutral[300],
                borderRadius: RADIUS.pill,
                borderWidth: 1,
                paddingHorizontal: SPACING.md,
                paddingVertical: SPACING.sm,
              }}
              testID={testID === undefined ? undefined : `${testID}-option-${option.value}`}
            >
              <Text
                className="font-body-medium text-sm"
                style={{ color: isSelected ? COLORS.white : COLORS.neutral[800] }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
```

Run: `npm test -w @meshimap/mobile -- visit-date-picker`
Expected: PASS（5 件）

- [ ] **Step 7: 失敗するテストを書く（写真の選択）**

```tsx
// apps/mobile/src/components/review/photo-picker.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PermissionStatus } from 'expo';
import { launchImageLibraryAsync, requestMediaLibraryPermissionsAsync } from 'expo-image-picker';
import type { ImagePickerAsset, MediaLibraryPermissionResponse } from 'expo-image-picker';

import { REVIEW_PHOTO_MAX_COUNT, REVIEW_PHOTO_QUALITY } from '@/constants/review';

import { PhotoPicker } from './photo-picker';

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
}));

const launchMock = jest.mocked(launchImageLibraryAsync);
const requestPermissionMock = jest.mocked(requestMediaLibraryPermissionsAsync);

// PermissionStatus は expo から直接読む。expo-image-picker 側をモックしても影響を受けない
function buildPermission(granted: boolean): MediaLibraryPermissionResponse {
  return {
    accessPrivileges: granted ? 'all' : 'none',
    canAskAgain: true,
    expires: 'never',
    granted,
    status: granted ? PermissionStatus.GRANTED : PermissionStatus.DENIED,
  };
}

function buildAsset(uri: string): ImagePickerAsset {
  return { height: 1200, uri, width: 1600 };
}

describe('PhotoPicker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requestPermissionMock.mockResolvedValue(buildPermission(true));
  });

  it('選択済みの写真をサムネイルで出す', async () => {
    await render(
      <PhotoPicker
        uris={['file:///tmp/a.jpg', 'file:///tmp/b.jpg']}
        onChange={jest.fn()}
        testID="photos"
      />,
    );

    expect(screen.getByTestId('photos-thumbnail-0')).toBeOnTheScreen();
    expect(screen.getByTestId('photos-thumbnail-1')).toBeOnTheScreen();
  });

  it('選んだ写真を末尾に足す', async () => {
    const onChange = jest.fn();
    launchMock.mockResolvedValue({ assets: [buildAsset('file:///tmp/new.jpg')], canceled: false });
    await render(<PhotoPicker uris={['file:///tmp/a.jpg']} onChange={onChange} testID="photos" />);

    fireEvent.press(screen.getByTestId('photos-add'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(['file:///tmp/a.jpg', 'file:///tmp/new.jpg']);
    });
  });

  it('残り枚数だけ選べるようにする', async () => {
    launchMock.mockResolvedValue({ assets: null, canceled: true });
    await render(
      <PhotoPicker
        uris={['file:///tmp/a.jpg', 'file:///tmp/b.jpg']}
        onChange={jest.fn()}
        testID="photos"
      />,
    );

    fireEvent.press(screen.getByTestId('photos-add'));

    await waitFor(() => {
      expect(launchMock).toHaveBeenCalledWith({
        allowsMultipleSelection: true,
        mediaTypes: ['images'],
        quality: REVIEW_PHOTO_QUALITY,
        selectionLimit: REVIEW_PHOTO_MAX_COUNT - 2,
      });
    });
  });

  it('上限まで選んだら追加ボタンを押せない', async () => {
    const uris = Array.from(
      { length: REVIEW_PHOTO_MAX_COUNT },
      (_unused, index) => `file:///${index}.jpg`,
    );
    await render(<PhotoPicker uris={uris} onChange={jest.fn()} testID="photos" />);

    expect(screen.getByTestId('photos-add')).toHaveProp('accessibilityState', {
      busy: false,
      disabled: true,
    });
  });

  it('キャンセルしたら何も変えない', async () => {
    const onChange = jest.fn();
    launchMock.mockResolvedValue({ assets: null, canceled: true });
    await render(<PhotoPicker uris={[]} onChange={onChange} testID="photos" />);

    fireEvent.press(screen.getByTestId('photos-add'));

    await waitFor(() => {
      expect(launchMock).toHaveBeenCalled();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('権限が無ければ案内を出して選択画面を開かない', async () => {
    requestPermissionMock.mockResolvedValue(buildPermission(false));
    await render(<PhotoPicker uris={[]} onChange={jest.fn()} testID="photos" />);

    fireEvent.press(screen.getByTestId('photos-add'));

    await waitFor(() => {
      expect(screen.getByTestId('photos-permission-denied')).toBeOnTheScreen();
    });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('削除ボタンでその 1 枚だけ外す', async () => {
    const onChange = jest.fn();
    await render(
      <PhotoPicker
        uris={['file:///tmp/a.jpg', 'file:///tmp/b.jpg', 'file:///tmp/c.jpg']}
        onChange={onChange}
        testID="photos"
      />,
    );

    fireEvent.press(screen.getByTestId('photos-remove-1'));

    expect(onChange).toHaveBeenCalledWith(['file:///tmp/a.jpg', 'file:///tmp/c.jpg']);
  });

  it('選択画面が例外を投げても落ちない', async () => {
    launchMock.mockRejectedValue(new Error('picker crashed'));
    await render(<PhotoPicker uris={[]} onChange={jest.fn()} testID="photos" />);

    fireEvent.press(screen.getByTestId('photos-add'));

    await waitFor(() => {
      expect(screen.getByTestId('photos-error')).toHaveTextContent('写真を読み込めませんでした');
    });
  });

  it('上限を超える枚数が返っても上限で切る', async () => {
    const onChange = jest.fn();
    launchMock.mockResolvedValue({
      assets: [
        buildAsset('file:///1.jpg'),
        buildAsset('file:///2.jpg'),
        buildAsset('file:///3.jpg'),
      ],
      canceled: false,
    });
    await render(
      <PhotoPicker uris={['file:///0.jpg', 'file:///x.jpg']} onChange={onChange} testID="photos" />,
    );

    fireEvent.press(screen.getByTestId('photos-add'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([
        'file:///0.jpg',
        'file:///x.jpg',
        'file:///1.jpg',
        'file:///2.jpg',
      ]);
    });
  });
});
```

Run: `npm test -w @meshimap/mobile -- photo-picker`
Expected: FAIL（`Cannot find module './photo-picker'`）

- [ ] **Step 8: photo-picker.tsx を実装する**

```tsx
// apps/mobile/src/components/review/photo-picker.tsx
import { Image } from 'expo-image';
import { launchImageLibraryAsync, requestMediaLibraryPermissionsAsync } from 'expo-image-picker';
import { Camera, X } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { REVIEW_PHOTO_MAX_COUNT, REVIEW_PHOTO_QUALITY } from '@/constants/review';
import { COLORS, RADIUS, SPACING } from '@/constants/theme';
import { logger } from '@/lib/logger';

const THUMBNAIL_SIZE_PX = 88;
const PERMISSION_DENIED_MESSAGE =
  '写真へのアクセスが許可されていません。端末の設定から許可してください';
const PICKER_ERROR_MESSAGE = '写真を読み込めませんでした';

/** 追加ボタンのラベル。残り枚数を出して上限を意識させる */
function addButtonLabel(remaining: number): string {
  return remaining === 0 ? '写真は上限に達しました' : `写真を追加（あと ${remaining} 枚）`;
}

export interface PhotoPickerProps {
  uris: readonly string[];
  onChange: (uris: readonly string[]) => void;
  errorMessage?: string | undefined;
  testID?: string | undefined;
}

export function PhotoPicker({ uris, onChange, errorMessage, testID }: PhotoPickerProps) {
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [noticeKind, setNoticeKind] = useState<'permission-denied' | 'error' | null>(null);
  const remaining = REVIEW_PHOTO_MAX_COUNT - uris.length;

  const handleAdd = async () => {
    setNoticeMessage(null);
    setNoticeKind(null);

    const permission = await requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNoticeMessage(PERMISSION_DENIED_MESSAGE);
      setNoticeKind('permission-denied');
      return;
    }

    try {
      const result = await launchImageLibraryAsync({
        allowsMultipleSelection: true,
        mediaTypes: ['images'],
        quality: REVIEW_PHOTO_QUALITY,
        selectionLimit: remaining,
      });
      if (result.canceled) {
        return;
      }
      // selectionLimit は OS 側の実装差で守られないことがあるので、こちらでも上限で切る
      const added = result.assets.map((asset) => asset.uri);
      onChange([...uris, ...added].slice(0, REVIEW_PHOTO_MAX_COUNT));
    } catch (error) {
      logger.warn('写真の選択に失敗しました', { error });
      setNoticeMessage(PICKER_ERROR_MESSAGE);
      setNoticeKind('error');
    }
  };

  const noticeTestID =
    testID === undefined || noticeKind === null ? undefined : `${testID}-${noticeKind}`;
  const hasFieldError = errorMessage !== undefined && errorMessage !== '';

  return (
    <View className="gap-sm">
      <Text className="font-body-medium text-sm text-neutral-700">写真</Text>

      {uris.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-sm">
          {uris.map((uri, index) => (
            <View key={uri} style={{ height: THUMBNAIL_SIZE_PX, width: THUMBNAIL_SIZE_PX }}>
              <Image
                contentFit="cover"
                source={{ uri }}
                style={{ borderRadius: RADIUS.md, height: '100%', width: '100%' }}
                testID={testID === undefined ? undefined : `${testID}-thumbnail-${index}`}
              />
              <Pressable
                accessibilityLabel={`${index + 1} 枚目の写真を削除`}
                accessibilityRole="button"
                onPress={() => {
                  onChange(uris.filter((_unused, target) => target !== index));
                }}
                style={{
                  alignItems: 'center',
                  backgroundColor: 'rgba(26, 23, 20, 0.6)',
                  borderRadius: RADIUS.pill,
                  height: SPACING.lg,
                  justifyContent: 'center',
                  position: 'absolute',
                  right: SPACING.xs,
                  top: SPACING.xs,
                  width: SPACING.lg,
                }}
                testID={testID === undefined ? undefined : `${testID}-remove-${index}`}
              >
                <Icon color={COLORS.white} icon={X} size="sm" />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <Button
        isDisabled={remaining === 0}
        label={addButtonLabel(remaining)}
        leadingIcon={<Icon color={COLORS.neutral[800]} icon={Camera} size="sm" />}
        onPress={() => {
          // Pressable の onPress は同期。Promise は握って logger に流す
          void handleAdd();
        }}
        testID={testID === undefined ? undefined : `${testID}-add`}
        variant="outline"
      />

      {noticeMessage === null ? null : (
        <Text
          accessibilityRole="alert"
          className="font-body text-xs"
          style={{ color: COLORS.red[700] }}
          testID={noticeTestID}
        >
          {noticeMessage}
        </Text>
      )}

      {hasFieldError ? (
        <Text
          accessibilityRole="alert"
          className="font-body text-xs"
          style={{ color: COLORS.red[700] }}
          testID={testID === undefined ? undefined : `${testID}-field-error`}
        >
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}
```

`Button` は `accessibilityState={{ disabled, busy }}` を持つので、「上限まで選んだら押せない」は
`toHaveProp('accessibilityState', { busy: false, disabled: true })` で検証できる（Task 6-1 で読んだ
`components/ui/button.tsx` の実装どおり）。

Run: `npm test -w @meshimap/mobile -- photo-picker`
Expected: PASS（9 件）

- [ ] **Step 9: わざと壊してテストが落ちることを確認する**

`onChange([...uris, ...added].slice(0, REVIEW_PHOTO_MAX_COUNT))` の `slice` を外し、
「上限を超える枚数が返っても上限で切る」が **FAIL** することを確認してから戻す。
次に `if (!permission.granted)` を `if (false)` にして、「権限が無ければ案内を出して選択画面を開かない」が
**FAIL** することも確認する。

- [ ] **Step 10: コミットする**

```bash
git add apps/mobile/src/lib/visit-date-options.ts apps/mobile/src/lib/visit-date-options.test.ts apps/mobile/src/components/review/ apps/mobile/src/constants/review.ts
git commit -m "feat(mobile): レビュー投稿フォームの星・訪問日・写真の入力部品を追加する"
```

---

### Task 6-30: 現在時刻フック・予算入力・投稿フォームのスキーマを作る

**Files:**

- Create: `apps/mobile/src/hooks/use-now.ts`
- Create: `apps/mobile/src/hooks/use-now.test.tsx`
- Create: `apps/mobile/src/lib/budget-input.ts`
- Create: `apps/mobile/src/lib/budget-input.test.ts`
- Create: `apps/mobile/src/features/reviews/form-schema.ts`
- Create: `apps/mobile/src/features/reviews/form-schema.test.ts`

**Interfaces:**

- Consumes: `react` の `useEffect` / `useState`、`@meshimap/core` の `BUDGET_YEN_MAX` / `BUDGET_YEN_MIN` / `RATING_MAX` / `RATING_MIN` / `REVIEW_BODY_MAX_LENGTH` / 型 `JstDate`、`@/lib/half-width-digits` の `toHalfWidthDigits`、`@/constants/review` の `REVIEW_PHOTO_MAX_COUNT`
- Produces:
  - `NOW_REFRESH_INTERVAL_MS` / `useNow(intervalMs?: number): Date` / `useStableNow(): Date`
  - `parseBudgetInput(text: string): number | null` / `formatBudgetInput(value: number | null): string`
  - `REVIEW_FORM_MESSAGES` / `reviewFormSchema` / 型 `ReviewFormFields` / `initialReviewFormValues(today: JstDate): ReviewFormFields`

- [ ] **Step 1: 失敗するテストを書く（現在時刻フック）**

```tsx
// apps/mobile/src/hooks/use-now.test.tsx
import { renderHook } from '@testing-library/react-native';
import { act } from 'react';

import { NOW_REFRESH_INTERVAL_MS, useNow, useStableNow } from './use-now';

const FIXED_NOW = new Date('2026-09-15T03:00:00.000Z');

describe('useNow / useStableNow', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('useNow は現在時刻を返す', async () => {
    const { result } = await renderHook(() => useNow());

    expect(result.current.toISOString()).toBe('2026-09-15T03:00:00.000Z');
  });

  it('useNow は既定の間隔で進む', async () => {
    const { result } = await renderHook(() => useNow());

    act(() => {
      jest.advanceTimersByTime(NOW_REFRESH_INTERVAL_MS);
    });

    expect(result.current.toISOString()).toBe('2026-09-15T03:01:00.000Z');
  });

  it('useNow は間隔前には進まない', async () => {
    // 1 秒ごとに再レンダリングされると地図やリストが無駄に描き直される
    const { result } = await renderHook(() => useNow());

    act(() => {
      jest.advanceTimersByTime(NOW_REFRESH_INTERVAL_MS - 1);
    });

    expect(result.current.toISOString()).toBe('2026-09-15T03:00:00.000Z');
  });

  it('useNow はアンマウントでタイマーを止める', async () => {
    const { unmount } = await renderHook(() => useNow());

    unmount();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('useStableNow は時間が経っても変わらない', async () => {
    const { result } = await renderHook(() => useStableNow());
    const first = result.current;

    act(() => {
      jest.advanceTimersByTime(NOW_REFRESH_INTERVAL_MS * 10);
    });

    expect(result.current).toBe(first);
  });

  it('useStableNow はタイマーを作らない', async () => {
    await renderHook(() => useStableNow());

    expect(jest.getTimerCount()).toBe(0);
  });
});
```

Run: `npm test -w @meshimap/mobile -- use-now`
Expected: FAIL（`Cannot find module './use-now'`）

- [ ] **Step 2: use-now.ts を実装する**

```ts
// apps/mobile/src/hooks/use-now.ts
import { useEffect, useState } from 'react';

/**
 * 現在時刻を更新する間隔（ms）。
 * 「まもなく閉店」は閉店 30 分前から出るので、1 分刻みで十分追従できる。
 * これより短くすると、地図のマーカーや一覧が無駄に描き直される。
 */
export const NOW_REFRESH_INTERVAL_MS = 60_000;

/**
 * 一定間隔で進む現在時刻。
 * 営業状況バッジのように、放置していても表示が変わってほしい画面で使う。
 */
export function useNow(intervalMs: number = NOW_REFRESH_INTERVAL_MS): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timerId = setInterval(() => {
      setNow(new Date());
    }, intervalMs);
    return () => {
      clearInterval(timerId);
    };
  }, [intervalMs]);

  return now;
}

/**
 * マウント時に固定した現在時刻。
 * 入力途中に「今日」がずれると訪問日の選択が壊れるので、フォームではこちらを使う。
 */
export function useStableNow(): Date {
  // 初期化関数を渡すと、再レンダリングのたびに new Date() が走るのを避けられる
  const [now] = useState(() => new Date());
  return now;
}
```

Run: `npm test -w @meshimap/mobile -- use-now`
Expected: PASS（6 件）

- [ ] **Step 3: 失敗するテストを書く（予算入力）**

```ts
// apps/mobile/src/lib/budget-input.test.ts
import { BUDGET_YEN_MAX } from '@meshimap/core';

import { formatBudgetInput, parseBudgetInput } from './budget-input';

describe('parseBudgetInput', () => {
  it('数字だけを取り出す', () => {
    expect(parseBudgetInput('4000')).toBe(4000);
  });

  it('カンマや円記号を落とす', () => {
    expect(parseBudgetInput('¥4,000')).toBe(4000);
  });

  it('全角数字を受け付ける', () => {
    expect(parseBudgetInput('４０００')).toBe(4000);
  });

  it('空文字は未入力として null', () => {
    expect(parseBudgetInput('')).toBeNull();
  });

  it('数字が 1 つも無ければ null', () => {
    expect(parseBudgetInput('いくらだったかな')).toBeNull();
  });

  it('0 は 0 として扱う（null ではない）', () => {
    expect(parseBudgetInput('0')).toBe(0);
  });

  it('上限を超えたら上限に丸める', () => {
    expect(parseBudgetInput('99999999')).toBe(BUDGET_YEN_MAX);
  });

  it('桁があふれても上限に収まる', () => {
    expect(parseBudgetInput('9'.repeat(400))).toBe(BUDGET_YEN_MAX);
  });

  it('先頭の 0 を落とす', () => {
    expect(parseBudgetInput('0004000')).toBe(4000);
  });
});

describe('formatBudgetInput', () => {
  it('数値を文字列にする', () => {
    expect(formatBudgetInput(4000)).toBe('4000');
  });

  it('null は空文字', () => {
    expect(formatBudgetInput(null)).toBe('');
  });

  it('0 は空文字にしない', () => {
    // 「0 円だった」と「未入力」を区別する
    expect(formatBudgetInput(0)).toBe('0');
  });
});
```

Run: `npm test -w @meshimap/mobile -- budget-input`
Expected: FAIL（`Cannot find module './budget-input'`）

- [ ] **Step 4: budget-input.ts を実装する**

```ts
// apps/mobile/src/lib/budget-input.ts
import { BUDGET_YEN_MAX } from '@meshimap/core';

import { toHalfWidthDigits } from './half-width-digits';

const NON_DIGIT_PATTERN = /\D/g;

/**
 * 「¥4,000」「４０００」のような入力から金額を取り出す。
 * 数字が 1 つも無ければ未入力（null）。0 は「0 円」として残し、未入力とは区別する。
 * 上限を超えた値は丸める。Number.parseInt は桁があふれると Infinity を返すが、
 * Math.min を通すので上限に収まる。
 */
export function parseBudgetInput(text: string): number | null {
  const digits = toHalfWidthDigits(text).replace(NON_DIGIT_PATTERN, '');
  if (digits === '') {
    return null;
  }
  return Math.min(Number.parseInt(digits, 10), BUDGET_YEN_MAX);
}

/** 金額を TextInput の value に戻す。未入力は空文字 */
export function formatBudgetInput(value: number | null): string {
  return value === null ? '' : String(value);
}
```

Run: `npm test -w @meshimap/mobile -- budget-input`
Expected: PASS（12 件）

- [ ] **Step 5: 失敗するテストを書く（フォームのスキーマ）**

```ts
// apps/mobile/src/features/reviews/form-schema.test.ts
import { BUDGET_YEN_MAX, REVIEW_BODY_MAX_LENGTH, toJstDate } from '@meshimap/core';

import { REVIEW_PHOTO_MAX_COUNT } from '@/constants/review';

import { REVIEW_FORM_MESSAGES, initialReviewFormValues, reviewFormSchema } from './form-schema';

const TODAY = toJstDate('2026-09-15');

const VALID_VALUES = {
  rating: 4,
  body: '串が一本ずつ丁寧でした。',
  visitedOn: '2026-09-15',
  budgetYen: 4000,
  localPhotoUris: [],
};

/** 指定したフィールドの最初のエラーメッセージを取り出す */
function firstMessageOf(values: unknown, field: string): string | undefined {
  const result = reviewFormSchema.safeParse(values);
  return result.error?.issues.find((issue) => issue.path[0] === field)?.message;
}

describe('initialReviewFormValues', () => {
  it('訪問日に今日を入れる', () => {
    expect(initialReviewFormValues(TODAY).visitedOn).toBe('2026-09-15');
  });

  it('評価は未選択（0）から始まる', () => {
    expect(initialReviewFormValues(TODAY).rating).toBe(0);
  });

  it('写真と本文は空から始まる', () => {
    const values = initialReviewFormValues(TODAY);

    expect(values.body).toBe('');
    expect(values.localPhotoUris).toEqual([]);
    expect(values.budgetYen).toBeNull();
  });

  it('初期値はそのままでは通らない', () => {
    // 未選択・未入力のまま送信できてしまうと、星 0 のレビューが保存される
    expect(reviewFormSchema.safeParse(initialReviewFormValues(TODAY)).success).toBe(false);
  });
});

describe('reviewFormSchema', () => {
  it('正しい値は通る', () => {
    expect(reviewFormSchema.safeParse(VALID_VALUES).success).toBe(true);
  });

  it('評価が未選択なら日本語で知らせる', () => {
    expect(firstMessageOf({ ...VALID_VALUES, rating: 0 }, 'rating')).toBe(
      REVIEW_FORM_MESSAGES.rating,
    );
  });

  it('評価が上限を超えたら弾く', () => {
    expect(firstMessageOf({ ...VALID_VALUES, rating: 6 }, 'rating')).toBe(
      REVIEW_FORM_MESSAGES.rating,
    );
  });

  it('本文が空白だけなら弾く', () => {
    expect(firstMessageOf({ ...VALID_VALUES, body: '   ' }, 'body')).toBe(
      REVIEW_FORM_MESSAGES.bodyRequired,
    );
  });

  it('本文の前後の空白は落とす', () => {
    const result = reviewFormSchema.safeParse({ ...VALID_VALUES, body: '  うまい  ' });

    expect(result.success && result.data.body).toBe('うまい');
  });

  it('本文が長すぎたら弾く', () => {
    expect(
      firstMessageOf({ ...VALID_VALUES, body: 'あ'.repeat(REVIEW_BODY_MAX_LENGTH + 1) }, 'body'),
    ).toBe(REVIEW_FORM_MESSAGES.bodyTooLong);
  });

  it('訪問日の形式が違えば弾く', () => {
    expect(firstMessageOf({ ...VALID_VALUES, visitedOn: '2026/09/15' }, 'visitedOn')).toBe(
      REVIEW_FORM_MESSAGES.visitedOn,
    );
  });

  it('金額は未入力でも通る', () => {
    expect(reviewFormSchema.safeParse({ ...VALID_VALUES, budgetYen: null }).success).toBe(true);
  });

  it('金額が上限を超えたら弾く', () => {
    expect(firstMessageOf({ ...VALID_VALUES, budgetYen: BUDGET_YEN_MAX + 1 }, 'budgetYen')).toBe(
      REVIEW_FORM_MESSAGES.budget,
    );
  });

  it('金額が負なら弾く', () => {
    expect(firstMessageOf({ ...VALID_VALUES, budgetYen: -1 }, 'budgetYen')).toBe(
      REVIEW_FORM_MESSAGES.budget,
    );
  });

  it('写真が上限を超えたら弾く', () => {
    const uris = Array.from(
      { length: REVIEW_PHOTO_MAX_COUNT + 1 },
      (_unused, index) => `file:///${index}.jpg`,
    );

    expect(firstMessageOf({ ...VALID_VALUES, localPhotoUris: uris }, 'localPhotoUris')).toBe(
      REVIEW_FORM_MESSAGES.photoCount,
    );
  });
});
```

Run: `npm test -w @meshimap/mobile -- reviews/form-schema`
Expected: FAIL（`Cannot find module './form-schema'`）

- [ ] **Step 6: form-schema.ts を実装する**

```ts
// apps/mobile/src/features/reviews/form-schema.ts
import {
  BUDGET_YEN_MAX,
  BUDGET_YEN_MIN,
  RATING_MAX,
  RATING_MIN,
  REVIEW_BODY_MAX_LENGTH,
} from '@meshimap/core';
import type { JstDate } from '@meshimap/core';
import { z } from 'zod';

import { REVIEW_PHOTO_MAX_COUNT } from '@/constants/review';

/**
 * 画面に出す検証メッセージ。
 * テストからも同じ定数を参照して、文言の変更でテストが壊れないようにする。
 */
export const REVIEW_FORM_MESSAGES = {
  rating: '評価を選んでください',
  bodyRequired: '感想を入力してください',
  bodyTooLong: `感想は ${REVIEW_BODY_MAX_LENGTH} 文字以内で入力してください`,
  visitedOn: '訪問日を選んでください',
  budget: `金額は 0 〜 ${BUDGET_YEN_MAX} 円で入力してください`,
  photoCount: `写真は ${REVIEW_PHOTO_MAX_COUNT} 枚までです`,
} as const;

/**
 * 投稿フォームのスキーマ。
 * core の reviewCreateSchema をそのまま使わない理由は 2 つある。
 * 1. core は API 境界用でメッセージを持たず、英語の既定文言がそのまま画面に出てしまう
 * 2. shopId は URL から決まるのでフォームの入力項目ではなく、写真はまだローカル URI のまま
 * 上限・下限の値は core の定数をそのまま使うので、数値が二重管理になることはない。
 */
export const reviewFormSchema = z.object({
  rating: z
    .number()
    .int({ error: REVIEW_FORM_MESSAGES.rating })
    .min(RATING_MIN, { error: REVIEW_FORM_MESSAGES.rating })
    .max(RATING_MAX, { error: REVIEW_FORM_MESSAGES.rating }),
  body: z
    .string()
    .trim()
    .min(1, { error: REVIEW_FORM_MESSAGES.bodyRequired })
    .max(REVIEW_BODY_MAX_LENGTH, { error: REVIEW_FORM_MESSAGES.bodyTooLong }),
  visitedOn: z.iso.date({ error: REVIEW_FORM_MESSAGES.visitedOn }),
  budgetYen: z
    .number()
    .int({ error: REVIEW_FORM_MESSAGES.budget })
    .min(BUDGET_YEN_MIN, { error: REVIEW_FORM_MESSAGES.budget })
    .max(BUDGET_YEN_MAX, { error: REVIEW_FORM_MESSAGES.budget })
    .nullable(),
  localPhotoUris: z
    .array(z.string().min(1))
    .max(REVIEW_PHOTO_MAX_COUNT, { error: REVIEW_FORM_MESSAGES.photoCount }),
});

/**
 * 入力型と出力型が同じになるよう、transform も default も使っていない。
 * これで useForm<ReviewFormFields> に zodResolver をそのまま渡せる。
 */
export type ReviewFormFields = z.infer<typeof reviewFormSchema>;

/** 未選択を表す評価値。RATING_MIN が 1 なので 0 は「まだ選んでいない」を意味できる */
const UNSELECTED_RATING = 0;

export function initialReviewFormValues(today: JstDate): ReviewFormFields {
  return {
    rating: UNSELECTED_RATING,
    body: '',
    visitedOn: today,
    budgetYen: null,
    localPhotoUris: [],
  };
}
```

Run: `npm test -w @meshimap/mobile -- reviews/form-schema`
Expected: PASS（15 件）

- [ ] **Step 7: わざと壊してテストが落ちることを確認する**

`reviewFormSchema` の `rating` から `.min(RATING_MIN, ...)` を外し、「初期値はそのままでは通らない」と
「評価が未選択なら日本語で知らせる」が **FAIL** することを確認してから戻す。
次に `parseBudgetInput` の `if (digits === '') return null;` を `if (digits === '' || digits === '0')` に変え、
「0 は 0 として扱う（null ではない）」が **FAIL** することも確認する。
最後に `useNow` の `useEffect` の戻り値（`clearInterval`）を消し、
「useNow はアンマウントでタイマーを止める」が **FAIL** することを確認してから戻す。

- [ ] **Step 8: コミットする**

```bash
git add apps/mobile/src/hooks/use-now.ts apps/mobile/src/hooks/use-now.test.tsx apps/mobile/src/lib/budget-input.ts apps/mobile/src/lib/budget-input.test.ts apps/mobile/src/features/reviews/form-schema.ts apps/mobile/src/features/reviews/form-schema.test.ts
git commit -m "feat(mobile): 現在時刻フックと投稿フォームのスキーマを追加する"
```

---

### Task 6-31: レビュー投稿画面を作る

**Files:**

- Create: `apps/mobile/src/app/(user)/review/new.tsx`
- Create: `apps/mobile/src/app/(user)/review/new.test.tsx`

**Interfaces:**

- Consumes: `@hookform/resolvers/zod` の `zodResolver`、`react-hook-form` の `Controller` / `useForm`、`@meshimap/core` の `identifierSchema` / `toJstClock` / `toShopId` / `REVIEW_BODY_MAX_LENGTH`、`expo-router` の `router` / `useLocalSearchParams`、`@/lib/query-params` の `readSingleQueryValue`、`@/hooks/use-now` の `useStableNow`、`@/features/reviews/form-schema` の `initialReviewFormValues` / `reviewFormSchema` / 型 `ReviewFormFields`、`@/features/reviews/use-create-review` の `useCreateReview`、`@/lib/budget-input` の `formatBudgetInput` / `parseBudgetInput`、`@/components/review/*`、`@/components/ui/*`
- Produces: `ReviewNewScreen`（default export。expo-router の `/review/new` に対応）

画面は 2 段構えにする。外側の `ReviewNewScreen` は `useLocalSearchParams` を必ず呼んでから
`shopId` を検証し、壊れた URL なら `ErrorState` を返す。フォーム本体は内側の
`ReviewNewForm` に閉じ込める。こうしないと「検証に失敗したら早期 return」と
「フォームのフックを呼ぶ」が同じ関数に同居して、フックの呼び出し順が条件分岐する。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/app/(user)/review/new.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { REVIEW_FORM_MESSAGES } from '@/features/reviews/form-schema';
import { useCreateReview } from '@/features/reviews/use-create-review';
import type { CreateReviewResult } from '@/features/reviews/use-create-review';

import ReviewNewScreen from './new';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ shopId: 'shop-001' })),
}));
jest.mock('@/features/reviews/use-create-review', () => ({ useCreateReview: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
}));
// 実時刻に依存させない。2026-09-14T23:00Z = 2026-09-15 08:00 JST
jest.mock('@/hooks/use-now', () => ({
  useStableNow: () => new Date('2026-09-14T23:00:00.000Z'),
}));

const useLocalSearchParamsMock = jest.mocked(useLocalSearchParams);
const useCreateReviewMock = jest.mocked(useCreateReview);
const submitMock = jest.fn();
const resetMock = jest.fn();

function buildCreateReviewResult(overrides: Partial<CreateReviewResult> = {}): CreateReviewResult {
  return {
    status: 'idle',
    errorMessage: null,
    createdReview: null,
    submit: submitMock,
    reset: resetMock,
    ...overrides,
  };
}

/** 有効な入力をひととおり埋める */
function fillValidForm(): void {
  fireEvent.press(screen.getByTestId('review-rating-star-4'));
  fireEvent.changeText(screen.getByTestId('review-body'), '串が一本ずつ丁寧でした。');
  fireEvent.changeText(screen.getByTestId('review-budget'), '¥4,000');
}

describe('ReviewNewScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useLocalSearchParamsMock.mockReturnValue({ shopId: 'shop-001' });
    useCreateReviewMock.mockReturnValue(buildCreateReviewResult());
  });

  it('shopId が無ければエラー表示にする', async () => {
    useLocalSearchParamsMock.mockReturnValue({});

    await render(<ReviewNewScreen />);

    expect(screen.getByTestId('review-new-invalid')).toBeOnTheScreen();
    expect(screen.queryByTestId('review-submit')).toBeNull();
  });

  it('shopId の形式が不正でもエラー表示にする', async () => {
    useLocalSearchParamsMock.mockReturnValue({ shopId: '../../etc/passwd' });

    await render(<ReviewNewScreen />);

    expect(screen.getByTestId('review-new-invalid')).toBeOnTheScreen();
  });

  it('入力欄をひととおり出す', async () => {
    await render(<ReviewNewScreen />);

    expect(screen.getByTestId('review-rating')).toBeOnTheScreen();
    expect(screen.getByTestId('review-body')).toBeOnTheScreen();
    expect(screen.getByTestId('review-visited')).toBeOnTheScreen();
    expect(screen.getByTestId('review-budget')).toBeOnTheScreen();
    expect(screen.getByTestId('review-photos')).toBeOnTheScreen();
  });

  it('訪問日の初期値は今日', async () => {
    await render(<ReviewNewScreen />);

    expect(screen.getByTestId('review-visited-option-2026-09-15')).toHaveProp(
      'accessibilityState',
      { selected: true },
    );
  });

  it('評価が未選択なら送信せずエラーを出す', async () => {
    await render(<ReviewNewScreen />);
    fireEvent.changeText(screen.getByTestId('review-body'), '串が一本ずつ丁寧でした。');

    fireEvent.press(screen.getByTestId('review-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('review-rating-error')).toHaveTextContent(
        REVIEW_FORM_MESSAGES.rating,
      );
    });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('本文が空なら送信せずエラーを出す', async () => {
    await render(<ReviewNewScreen />);
    fireEvent.press(screen.getByTestId('review-rating-star-4'));

    fireEvent.press(screen.getByTestId('review-submit'));

    await waitFor(() => {
      expect(screen.getByText(REVIEW_FORM_MESSAGES.bodyRequired)).toBeOnTheScreen();
    });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('入力が揃えば投稿フックに渡す', async () => {
    await render(<ReviewNewScreen />);
    fillValidForm();

    fireEvent.press(screen.getByTestId('review-submit'));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith({
        rating: 4,
        body: '串が一本ずつ丁寧でした。',
        visitedOn: '2026-09-15',
        budgetYen: 4000,
        localPhotoUris: [],
      });
    });
  });

  it('金額は数字だけ取り出して渡す', async () => {
    await render(<ReviewNewScreen />);
    fillValidForm();
    fireEvent.changeText(screen.getByTestId('review-budget'), '４８００円くらい');

    fireEvent.press(screen.getByTestId('review-submit'));

    await waitFor(() => {
      expect(submitMock.mock.calls[0]?.[0]?.budgetYen).toBe(4800);
    });
  });

  it('訪問日を変えると送信値に反映される', async () => {
    await render(<ReviewNewScreen />);
    fillValidForm();
    fireEvent.press(screen.getByTestId('review-visited-option-2026-09-13'));

    fireEvent.press(screen.getByTestId('review-submit'));

    await waitFor(() => {
      expect(submitMock.mock.calls[0]?.[0]?.visitedOn).toBe('2026-09-13');
    });
  });

  it('送信中はボタンを押せない', async () => {
    useCreateReviewMock.mockReturnValue(buildCreateReviewResult({ status: 'submitting' }));

    await render(<ReviewNewScreen />);

    expect(screen.getByTestId('review-submit')).toHaveProp('accessibilityState', {
      busy: true,
      disabled: true,
    });
  });

  it('失敗したら理由を出す', async () => {
    useCreateReviewMock.mockReturnValue(
      buildCreateReviewResult({ status: 'error', errorMessage: '通信に失敗しました' }),
    );

    await render(<ReviewNewScreen />);

    expect(screen.getByTestId('review-submit-error')).toHaveTextContent('通信に失敗しました');
  });

  it('成功したら前の画面に戻る', async () => {
    useCreateReviewMock.mockReturnValue(buildCreateReviewResult({ status: 'success' }));

    await render(<ReviewNewScreen />);

    await waitFor(() => {
      expect(router.back).toHaveBeenCalledTimes(1);
    });
  });

  it('idle のままなら戻らない', async () => {
    await render(<ReviewNewScreen />);

    expect(router.back).not.toHaveBeenCalled();
  });

  it('戻るボタンで前の画面に戻る', async () => {
    await render(<ReviewNewScreen />);

    fireEvent.press(screen.getByTestId('review-new-back'));

    expect(router.back).toHaveBeenCalledTimes(1);
  });
});
```

Run: `npm test -w @meshimap/mobile -- review/new`
Expected: FAIL（`Cannot find module './new'`）

- [ ] **Step 2: 画面を実装する**

```tsx
// apps/mobile/src/app/(user)/review/new.tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { REVIEW_BODY_MAX_LENGTH, identifierSchema, toJstClock, toShopId } from '@meshimap/core';
import type { ShopId } from '@meshimap/core';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';

import { PhotoPicker } from '@/components/review/photo-picker';
import { StarRatingInput } from '@/components/review/star-rating-input';
import { VisitDatePicker } from '@/components/review/visit-date-picker';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { COLORS, SPACING } from '@/constants/theme';
import { initialReviewFormValues, reviewFormSchema } from '@/features/reviews/form-schema';
import type { ReviewFormFields } from '@/features/reviews/form-schema';
import { useCreateReview } from '@/features/reviews/use-create-review';
import { useStableNow } from '@/hooks/use-now';
import { formatBudgetInput, parseBudgetInput } from '@/lib/budget-input';
import { readSingleQueryValue } from '@/lib/query-params';

const SCREEN_TITLE = 'レビューを書く';
const INVALID_SHOP_TITLE = '店舗が見つかりません';
const INVALID_SHOP_DESCRIPTION = 'URL が正しくありません。前の画面に戻ってやり直してください';
const SUBMIT_LABEL = '投稿する';
const BODY_LABEL = '感想';
const BODY_PLACEHOLDER = '何を食べて、どう感じましたか？';
const BUDGET_LABEL = '使った金額（任意）';
const BUDGET_PLACEHOLDER = '4000';

/** iOS だけキーボード分の余白を確保する。Android は既定の adjustResize に任せる */
const KEYBOARD_BEHAVIOR = Platform.OS === 'ios' ? 'padding' : undefined;

export default function ReviewNewScreen() {
  // フックは早期 return より前に必ず呼ぶ
  const params = useLocalSearchParams();
  const parsedShopId = identifierSchema.safeParse(readSingleQueryValue(params.shopId));

  if (!parsedShopId.success) {
    return (
      <ErrorState
        description={INVALID_SHOP_DESCRIPTION}
        onRetry={() => {
          router.back();
        }}
        testID="review-new-invalid"
        title={INVALID_SHOP_TITLE}
      />
    );
  }

  return <ReviewNewForm shopId={toShopId(parsedShopId.data)} />;
}

interface ReviewNewFormProps {
  readonly shopId: ShopId;
}

function ReviewNewForm({ shopId }: ReviewNewFormProps) {
  // 入力中に日付が変わると訪問日の選択がずれるので、固定した現在時刻を使う
  const now = useStableNow();
  const today = toJstClock(now).date;

  const { control, formState, handleSubmit } = useForm<ReviewFormFields>({
    defaultValues: initialReviewFormValues(today),
    resolver: zodResolver(reviewFormSchema),
  });
  const createReview = useCreateReview(shopId);

  useEffect(() => {
    if (createReview.status === 'success') {
      router.back();
    }
  }, [createReview.status]);

  const submitForm = handleSubmit((values) => {
    createReview.submit({
      rating: values.rating,
      body: values.body,
      visitedOn: values.visitedOn,
      budgetYen: values.budgetYen,
      localPhotoUris: values.localPhotoUris,
    });
  });

  return (
    <KeyboardAvoidingView behavior={KEYBOARD_BEHAVIOR} className="flex-1 bg-neutral-50">
      <View className="flex-row items-center gap-sm border-b border-neutral-200 bg-white px-md py-sm">
        <Pressable
          accessibilityLabel="前の画面に戻る"
          accessibilityRole="button"
          onPress={() => {
            router.back();
          }}
          testID="review-new-back"
        >
          <Icon color={COLORS.neutral[800]} icon={ChevronLeft} size="lg" />
        </Pressable>
        <Text className="font-display text-lg text-neutral-900">{SCREEN_TITLE}</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ gap: SPACING.lg, padding: SPACING.md }}
        keyboardShouldPersistTaps="handled"
      >
        <Controller
          control={control}
          name="rating"
          render={({ field }) => (
            <StarRatingInput
              errorMessage={formState.errors.rating?.message}
              onChange={field.onChange}
              testID="review-rating"
              value={field.value}
            />
          )}
        />

        <Controller
          control={control}
          name="body"
          render={({ field }) => (
            <Input
              errorMessage={formState.errors.body?.message}
              isMultiline
              isRequired
              label={BODY_LABEL}
              maxLength={REVIEW_BODY_MAX_LENGTH}
              onChangeText={field.onChange}
              placeholder={BODY_PLACEHOLDER}
              testID="review-body"
              value={field.value}
            />
          )}
        />

        <Controller
          control={control}
          name="visitedOn"
          render={({ field }) => (
            <VisitDatePicker
              now={now}
              onChange={field.onChange}
              testID="review-visited"
              value={field.value}
            />
          )}
        />

        {/*
          Input は keyboardType を受け取らないので数字キーボードには固定できない。
          全角数字や「¥」「円」が混じっても parseBudgetInput が数字だけを取り出す。
        */}
        <Controller
          control={control}
          name="budgetYen"
          render={({ field }) => (
            <Input
              errorMessage={formState.errors.budgetYen?.message}
              label={BUDGET_LABEL}
              onChangeText={(text) => {
                field.onChange(parseBudgetInput(text));
              }}
              placeholder={BUDGET_PLACEHOLDER}
              testID="review-budget"
              value={formatBudgetInput(field.value)}
            />
          )}
        />

        <Controller
          control={control}
          name="localPhotoUris"
          render={({ field }) => (
            <PhotoPicker
              errorMessage={formState.errors.localPhotoUris?.message}
              onChange={(uris) => {
                // react-hook-form は可変配列を期待するので、読み取り専用配列から作り直す
                field.onChange([...uris]);
              }}
              testID="review-photos"
              uris={field.value}
            />
          )}
        />

        {createReview.errorMessage === null ? null : (
          <Text
            accessibilityRole="alert"
            className="font-body text-sm"
            style={{ color: COLORS.red[700] }}
            testID="review-submit-error"
          >
            {createReview.errorMessage}
          </Text>
        )}

        <Button
          isLoading={createReview.status === 'submitting'}
          label={SUBMIT_LABEL}
          onPress={() => {
            // handleSubmit は Promise を返すが Pressable は同期の関数しか受け取らない
            void submitForm();
          }}
          testID="review-submit"
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
```

Run: `npm test -w @meshimap/mobile -- review/new`
Expected: PASS（14 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`ReviewNewScreen` の `if (!parsedShopId.success)` を `if (false)` に変え、
「shopId が無ければエラー表示にする」「shopId の形式が不正でもエラー表示にする」が
**FAIL** することを確認してから戻す。
次に `useEffect` の `createReview.status === 'success'` を `=== 'idle'` に変え、
「成功したら前の画面に戻る」が通ってしまう一方で「idle のままなら戻らない」が **FAIL** することを確認する。
最後に `onChangeText` の `parseBudgetInput(text)` を `Number(text)` に変え、
「金額は数字だけ取り出して渡す」が **FAIL** することも確認してから戻す。

- [ ] **Step 4: 型チェックを通す**

Run: `npm run typecheck -w @meshimap/mobile`
Expected: エラー 0 件

`zodResolver(reviewFormSchema)` は `Resolver<z4.input<T>, Context, z4.output<T>>` を返す
（`node_modules/@hookform/resolvers/zod/dist/zod.d.ts`）。`reviewFormSchema` は `transform` も
`default` も使っていないので `z4.input` と `z4.output` が一致し、`useForm<ReviewFormFields>` の
`resolver?: Resolver<ReviewFormFields, TContext, ReviewFormFields>` にそのまま収まる。
ここで型エラーが出る場合は、スキーマに `default` や `transform` が紛れ込んでいないか先に疑う。

- [ ] **Step 5: コミットする**

```bash
git add "apps/mobile/src/app/(user)/review/"
git commit -m "feat(mobile): レビュー投稿画面を追加する"
```

---

### Task 6-32: お気に入りの API 層と楽観更新フックを作る

**Files:**

- Create: `apps/mobile/src/features/favorites/query-keys.ts`
- Create: `apps/mobile/src/features/favorites/schema.ts`
- Create: `apps/mobile/src/features/favorites/api.ts`
- Create: `apps/mobile/src/features/favorites/api.test.ts`
- Create: `apps/mobile/src/features/favorites/use-favorite-ids.ts`
- Create: `apps/mobile/src/features/favorites/use-toggle-favorite.ts`
- Create: `apps/mobile/src/features/favorites/use-toggle-favorite.test.tsx`
- Create: `apps/mobile/src/features/favorites/use-favorite-shops.ts`
- Create: `apps/mobile/src/features/favorites/use-favorite-shops.test.tsx`

**Interfaces:**

- Consumes: `zod` の `z`、`@meshimap/core` の `identifierSchema` / `toShopId` / 型 `ShopId`、`@/features/shops/schema` の `shopSummarySchema` / 型 `ShopSummary`、`@/lib/api-client` の `apiFetch`（Phase 5）、`@tanstack/react-query` の `useMutation` / `useQuery` / `useQueryClient`
- Produces:
  - `favoriteKeys`
  - `favoriteShopIdsSchema` / `favoriteShopsSchema`
  - `fetchFavoriteShopIds(): Promise<readonly ShopId[]>` / `fetchFavoriteShops(): Promise<readonly ShopSummary[]>` / `addFavorite(shopId: ShopId): Promise<void>` / `removeFavorite(shopId: ShopId): Promise<void>`
  - `useFavoriteIds(): FavoriteIdsResult` / 型 `FavoriteIdsResult`
  - `useToggleFavorite(): ToggleFavoriteResult` / 型 `ToggleFavoriteResult`
  - `useFavoriteShops(): FavoriteShopsResult` / 型 `FavoriteShopsResult` / 型 `FavoriteShopsStatus`

**このタスクの肝**

お気に入りのハートは「押した瞬間に色が変わる」ことが価値なので、サーバ応答を待たずに
キャッシュを書き換える（楽観更新）。したがって **失敗したら必ず元に戻す**。
戻し忘れると「押したのに実際は登録されていない」という、ユーザーからは気づけない不整合が残る。
巻き戻しには 2 通りあり、両方テストする。

1. 押す前にキャッシュがあった → `setQueryData` で元の配列に戻す
2. 押す前にキャッシュが無かった（一覧未取得のまま詳細画面で押した） → `removeQueries` で消す

2 が必要なのは、`setQueryData(key, undefined)` が **何もしない** から。
`node_modules/@tanstack/query-core/build/modern/queryClient.js:92` に
`if (data === void 0) return;` があり、undefined を書いてもキャッシュは消えない。
ここを `setQueryData(key, context.previousIds)` だけで済ませると、楽観的に足した ID が
残り続ける。

- [ ] **Step 1: クエリキーとスキーマを作る**

```ts
// apps/mobile/src/features/favorites/query-keys.ts
/**
 * お気に入りのクエリキー。
 * ID の集合（ハートの塗り分け用）と店舗一覧（保存済み画面用）を別キーにする。
 * ID だけなら詳細画面でも軽く取れて、一覧の重いレスポンスを引かずに済む。
 */
export const favoriteKeys = {
  all: ['favorites'] as const,
  ids: () => [...favoriteKeys.all, 'ids'] as const,
  shops: () => [...favoriteKeys.all, 'shops'] as const,
};
```

```ts
// apps/mobile/src/features/favorites/schema.ts
import { identifierSchema, toShopId } from '@meshimap/core';
import { z } from 'zod';

import { shopSummarySchema } from '@/features/shops/schema';

export const favoriteShopIdsSchema = z.object({
  shopIds: z.array(identifierSchema.transform(toShopId)),
});

export const favoriteShopsSchema = z.object({
  shops: z.array(shopSummarySchema),
});
```

- [ ] **Step 2: 失敗するテストを書く（API）**

```ts
// apps/mobile/src/features/favorites/api.test.ts
import { toShopId } from '@meshimap/core';

import { apiFetch } from '@/lib/api-client';

import { addFavorite, fetchFavoriteShopIds, fetchFavoriteShops, removeFavorite } from './api';

jest.mock('@/lib/api-client', () => ({ apiFetch: jest.fn() }));

const apiFetchMock = jest.mocked(apiFetch);

const SHOP_ID = toShopId('shop-001');

describe('fetchFavoriteShopIds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ID の一覧を取りに行く', async () => {
    apiFetchMock.mockResolvedValue({ shopIds: ['shop-001', 'shop-002'] });

    const ids = await fetchFavoriteShopIds();

    expect(apiFetchMock).toHaveBeenCalledWith('/favorites/ids', { method: 'GET' });
    expect(ids).toEqual(['shop-001', 'shop-002']);
  });

  it('1 件も無ければ空配列', async () => {
    apiFetchMock.mockResolvedValue({ shopIds: [] });

    expect(await fetchFavoriteShopIds()).toEqual([]);
  });

  it('壊れたレスポンスで例外にする', async () => {
    apiFetchMock.mockResolvedValue({ shopIds: [''] });

    await expect(fetchFavoriteShopIds()).rejects.toThrow();
  });
});

describe('fetchFavoriteShops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('店舗一覧を取りに行く', async () => {
    apiFetchMock.mockResolvedValue({ shops: [] });

    const shops = await fetchFavoriteShops();

    expect(apiFetchMock).toHaveBeenCalledWith('/favorites', { method: 'GET' });
    expect(shops).toEqual([]);
  });
});

describe('addFavorite / removeFavorite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('追加は PUT', async () => {
    apiFetchMock.mockResolvedValue(null);

    await addFavorite(SHOP_ID);

    expect(apiFetchMock).toHaveBeenCalledWith('/favorites/shop-001', { method: 'PUT' });
  });

  it('削除は DELETE', async () => {
    apiFetchMock.mockResolvedValue(null);

    await removeFavorite(SHOP_ID);

    expect(apiFetchMock).toHaveBeenCalledWith('/favorites/shop-001', { method: 'DELETE' });
  });

  it('本文は検証しない（204 で空が返る想定）', async () => {
    apiFetchMock.mockResolvedValue(undefined);

    await expect(addFavorite(SHOP_ID)).resolves.toBeUndefined();
  });
});
```

Run: `npm test -w @meshimap/mobile -- favorites/api`
Expected: FAIL（`Cannot find module './api'`）

- [ ] **Step 3: api.ts を実装する**

```ts
// apps/mobile/src/features/favorites/api.ts
import type { ShopId } from '@meshimap/core';

import type { ShopSummary } from '@/features/shops/schema';
import { apiFetch } from '@/lib/api-client';

import { favoriteShopIdsSchema, favoriteShopsSchema } from './schema';

export async function fetchFavoriteShopIds(): Promise<readonly ShopId[]> {
  const payload = await apiFetch('/favorites/ids', { method: 'GET' });
  return favoriteShopIdsSchema.parse(payload).shopIds;
}

export async function fetchFavoriteShops(): Promise<readonly ShopSummary[]> {
  const payload = await apiFetch('/favorites', { method: 'GET' });
  return favoriteShopsSchema.parse(payload).shops;
}

/** 登録は冪等。すでに登録済みでも成功として扱う（連打しても壊れない） */
export async function addFavorite(shopId: ShopId): Promise<void> {
  await apiFetch(`/favorites/${shopId}`, { method: 'PUT' });
}

export async function removeFavorite(shopId: ShopId): Promise<void> {
  await apiFetch(`/favorites/${shopId}`, { method: 'DELETE' });
}
```

Run: `npm test -w @meshimap/mobile -- favorites/api`
Expected: PASS（7 件）

- [ ] **Step 4: 失敗するテストを書く（楽観更新と巻き戻し）**

```tsx
// apps/mobile/src/features/favorites/use-toggle-favorite.test.tsx
import { toShopId } from '@meshimap/core';
import type { QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import { act } from 'react';
import type { ReactNode } from 'react';

import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';

import { addFavorite, fetchFavoriteShopIds, removeFavorite } from './api';
import { favoriteKeys } from './query-keys';
import { useFavoriteIds } from './use-favorite-ids';
import { useToggleFavorite } from './use-toggle-favorite';

jest.mock('./api', () => ({
  addFavorite: jest.fn(),
  fetchFavoriteShopIds: jest.fn(),
  removeFavorite: jest.fn(),
}));

const addFavoriteMock = jest.mocked(addFavorite);
const removeFavoriteMock = jest.mocked(removeFavorite);
const fetchFavoriteShopIdsMock = jest.mocked(fetchFavoriteShopIds);

const SHOP_A = toShopId('shop-001');
const SHOP_B = toShopId('shop-002');

function buildWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  };
}

/** 一覧を読み込み済みの状態でフックを 2 つ同時に使う */
async function renderWithLoadedIds() {
  const queryClient = createTestQueryClient();
  const rendered = await renderHook(
    () => ({ ids: useFavoriteIds(), toggle: useToggleFavorite() }),
    { wrapper: buildWrapper(queryClient) },
  );
  await waitFor(() => {
    expect(rendered.result.current.ids.status).toBe('success');
  });
  return { queryClient, result: rendered.result };
}

/** 一覧を読み込まないまま、切り替えフックだけを使う（詳細画面から直接押す状況） */
async function renderToggleOnly() {
  const queryClient = createTestQueryClient();
  const rendered = await renderHook(() => useToggleFavorite(), {
    wrapper: buildWrapper(queryClient),
  });
  return { queryClient, result: rendered.result };
}

describe('useToggleFavorite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchFavoriteShopIdsMock.mockResolvedValue([SHOP_A]);
    addFavoriteMock.mockResolvedValue(undefined);
    removeFavoriteMock.mockResolvedValue(undefined);
  });

  it('応答を待たずにキャッシュへ足す', async () => {
    // 解決しない Promise。サーバ応答前の状態を見る
    addFavoriteMock.mockReturnValue(new Promise(() => {}));
    const { result } = await renderWithLoadedIds();

    act(() => {
      result.current.toggle.toggle(SHOP_B);
    });

    await waitFor(() => {
      expect(result.current.ids.isFavorite(SHOP_B)).toBe(true);
    });
    expect(addFavoriteMock).toHaveBeenCalledWith(SHOP_B);
  });

  it('登録済みを押すと外す', async () => {
    removeFavoriteMock.mockReturnValue(new Promise(() => {}));
    const { result } = await renderWithLoadedIds();

    act(() => {
      result.current.toggle.toggle(SHOP_A);
    });

    await waitFor(() => {
      expect(result.current.ids.isFavorite(SHOP_A)).toBe(false);
    });
    expect(removeFavoriteMock).toHaveBeenCalledWith(SHOP_A);
    expect(addFavoriteMock).not.toHaveBeenCalled();
  });

  it('同じ店を続けて足しても重複しない', async () => {
    const { queryClient, result } = await renderWithLoadedIds();

    act(() => {
      result.current.toggle.toggle(SHOP_B);
    });
    await waitFor(() => {
      expect(result.current.ids.isFavorite(SHOP_B)).toBe(true);
    });
    queryClient.setQueryData(favoriteKeys.ids(), [SHOP_A, SHOP_B, SHOP_B]);

    expect(new Set(result.current.ids.favoriteIds).size).toBe(2);
  });

  it('失敗したら元のキャッシュに戻す', async () => {
    addFavoriteMock.mockRejectedValue(new Error('network'));
    const { queryClient, result } = await renderWithLoadedIds();

    act(() => {
      result.current.toggle.toggle(SHOP_B);
    });

    await waitFor(() => {
      expect(result.current.toggle.errorMessage).toBe('お気に入りを更新できませんでした');
    });
    expect(result.current.ids.isFavorite(SHOP_B)).toBe(false);
    expect(queryClient.getQueryData(favoriteKeys.ids())).toEqual([SHOP_A]);
  });

  it('外すのに失敗したら元に戻す', async () => {
    removeFavoriteMock.mockRejectedValue(new Error('network'));
    const { queryClient, result } = await renderWithLoadedIds();

    act(() => {
      result.current.toggle.toggle(SHOP_A);
    });

    await waitFor(() => {
      expect(result.current.toggle.errorMessage).not.toBeNull();
    });
    expect(queryClient.getQueryData(favoriteKeys.ids())).toEqual([SHOP_A]);
  });

  it('キャッシュが無い状態で失敗したらキャッシュごと消す', async () => {
    // setQueryData(key, undefined) は NO-OP（query-core queryClient.js:92）なので
    // removeQueries で消さないと、楽観的に足した ID が残り続ける
    addFavoriteMock.mockRejectedValue(new Error('network'));
    const { queryClient, result } = await renderToggleOnly();

    act(() => {
      result.current.toggle(SHOP_B);
    });

    await waitFor(() => {
      expect(result.current.errorMessage).not.toBeNull();
    });
    expect(queryClient.getQueryData(favoriteKeys.ids())).toBeUndefined();
  });

  it('キャッシュが無い状態でも楽観更新はする', async () => {
    addFavoriteMock.mockReturnValue(new Promise(() => {}));
    const { queryClient, result } = await renderToggleOnly();

    act(() => {
      result.current.toggle(SHOP_B);
    });

    await waitFor(() => {
      expect(queryClient.getQueryData(favoriteKeys.ids())).toEqual([SHOP_B]);
    });
  });

  it('取得中のリクエストを止めてから書き換える', async () => {
    // 進行中の GET が後から古い配列で上書きするのを防ぐ
    const { queryClient, result } = await renderWithLoadedIds();
    const cancelQueries = jest.spyOn(queryClient, 'cancelQueries');

    act(() => {
      result.current.toggle.toggle(SHOP_B);
    });

    await waitFor(() => {
      expect(cancelQueries).toHaveBeenCalledWith({ queryKey: favoriteKeys.ids() });
    });
  });

  it('成功したらお気に入り系を無効化する', async () => {
    const { queryClient, result } = await renderWithLoadedIds();
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');

    act(() => {
      result.current.toggle.toggle(SHOP_B);
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: favoriteKeys.all });
    });
  });

  it('失敗したときは無効化しない', async () => {
    // 無効化すると再取得が走り、巻き戻した値が一瞬で上書きされて原因が追えなくなる
    addFavoriteMock.mockRejectedValue(new Error('network'));
    const { queryClient, result } = await renderWithLoadedIds();
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');

    act(() => {
      result.current.toggle.toggle(SHOP_B);
    });

    await waitFor(() => {
      expect(result.current.toggle.errorMessage).not.toBeNull();
    });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('処理中は isPending が立つ', async () => {
    addFavoriteMock.mockReturnValue(new Promise(() => {}));
    const { result } = await renderWithLoadedIds();

    act(() => {
      result.current.toggle.toggle(SHOP_B);
    });

    await waitFor(() => {
      expect(result.current.toggle.isPending).toBe(true);
    });
  });
});

describe('useFavoriteIds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('取得前は誰もお気に入りではない', async () => {
    fetchFavoriteShopIdsMock.mockReturnValue(new Promise(() => {}));
    const queryClient = createTestQueryClient();

    const { result } = await renderHook(() => useFavoriteIds(), {
      wrapper: buildWrapper(queryClient),
    });

    expect(result.current.status).toBe('loading');
    expect(result.current.isFavorite(SHOP_A)).toBe(false);
  });

  it('取得に失敗しても落ちない', async () => {
    fetchFavoriteShopIdsMock.mockRejectedValue(new Error('network'));
    const queryClient = createTestQueryClient();

    const { result } = await renderHook(() => useFavoriteIds(), {
      wrapper: buildWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.isFavorite(SHOP_A)).toBe(false);
  });
});
```

Run: `npm test -w @meshimap/mobile -- use-toggle-favorite`
Expected: FAIL（`Cannot find module './use-favorite-ids'`）

- [ ] **Step 5: use-favorite-ids.ts と use-toggle-favorite.ts を実装する**

```ts
// apps/mobile/src/features/favorites/use-favorite-ids.ts
import type { ShopId } from '@meshimap/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { fetchFavoriteShopIds } from './api';
import { favoriteKeys } from './query-keys';

export type FavoriteIdsStatus = 'loading' | 'error' | 'success';

export interface FavoriteIdsResult {
  favoriteIds: readonly ShopId[];
  status: FavoriteIdsStatus;
  /** 一覧をなめずに済むよう Set で判定する。マーカーが多い地図で効く */
  isFavorite: (shopId: ShopId) => boolean;
  refetch: () => void;
}

export function useFavoriteIds(): FavoriteIdsResult {
  const query = useQuery({
    queryKey: favoriteKeys.ids(),
    queryFn: fetchFavoriteShopIds,
  });

  const favoriteIds = query.data ?? [];
  const favoriteIdSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);

  return {
    favoriteIds,
    status: query.isError ? 'error' : query.isPending ? 'loading' : 'success',
    isFavorite: (shopId) => favoriteIdSet.has(shopId),
    refetch: () => {
      void query.refetch();
    },
  };
}
```

```ts
// apps/mobile/src/features/favorites/use-toggle-favorite.ts
import type { ShopId } from '@meshimap/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { addFavorite, removeFavorite } from './api';
import { favoriteKeys } from './query-keys';

const TOGGLE_ERROR_MESSAGE = 'お気に入りを更新できませんでした';

interface ToggleVariables {
  readonly shopId: ShopId;
  readonly nextIsFavorite: boolean;
}

/** 巻き戻し用の文脈。undefined は「押す前にキャッシュが無かった」ことを表す */
interface ToggleContext {
  readonly previousIds: readonly ShopId[] | undefined;
}

export interface ToggleFavoriteResult {
  toggle: (shopId: ShopId) => void;
  isPending: boolean;
  errorMessage: string | null;
}

export function useToggleFavorite(): ToggleFavoriteResult {
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, ToggleVariables, ToggleContext>({
    mutationFn: ({ shopId, nextIsFavorite }) =>
      nextIsFavorite ? addFavorite(shopId) : removeFavorite(shopId),

    onMutate: async ({ shopId, nextIsFavorite }) => {
      // 進行中の GET が後から古い配列で上書きするのを防ぐ
      await queryClient.cancelQueries({ queryKey: favoriteKeys.ids() });

      const previousIds = queryClient.getQueryData<readonly ShopId[]>(favoriteKeys.ids());
      const currentIds = previousIds ?? [];
      const nextIds = nextIsFavorite
        ? currentIds.includes(shopId)
          ? currentIds
          : [...currentIds, shopId]
        : currentIds.filter((id) => id !== shopId);

      queryClient.setQueryData<readonly ShopId[]>(favoriteKeys.ids(), nextIds);
      return { previousIds };
    },

    onError: (_error, _variables, context) => {
      if (context === undefined) {
        return;
      }
      if (context.previousIds === undefined) {
        // setQueryData(key, undefined) は NO-OP（query-core queryClient.js:92）。
        // 楽観的に作ったキャッシュを消すには removeQueries が要る
        queryClient.removeQueries({ queryKey: favoriteKeys.ids(), exact: true });
        return;
      }
      queryClient.setQueryData<readonly ShopId[]>(favoriteKeys.ids(), context.previousIds);
    },

    onSuccess: () => {
      // 失敗時には無効化しない。再取得が走ると巻き戻した値がすぐ上書きされ、
      // 「戻ったのか戻っていないのか」がユーザーにもテストにも分からなくなる
      void queryClient.invalidateQueries({ queryKey: favoriteKeys.all });
    },
  });

  return {
    isPending: mutation.isPending,
    errorMessage: mutation.isError ? TOGGLE_ERROR_MESSAGE : null,
    toggle: (shopId) => {
      const currentIds = queryClient.getQueryData<readonly ShopId[]>(favoriteKeys.ids()) ?? [];
      mutation.mutate({ shopId, nextIsFavorite: !currentIds.includes(shopId) });
    },
  };
}
```

`useMutation<void, Error, ToggleVariables, ToggleContext>` と型引数を明示する理由は 2 つ。
`onMutate` の戻り値を `ToggleContext` に固定して `onError` の `context` を
`ToggleContext | undefined` に確定させること、`mutation.error` を `Error | null` にして
`unknown` の絞り込みを書かずに済ませることの 2 点。

Run: `npm test -w @meshimap/mobile -- use-toggle-favorite`
Expected: PASS（13 件）

- [ ] **Step 6: 失敗するテストを書く（保存済み店舗の一覧）**

```tsx
// apps/mobile/src/features/favorites/use-favorite-shops.test.tsx
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildShopSummary } from '@/test-support/shop-fixtures';

import { fetchFavoriteShops } from './api';
import { useFavoriteShops } from './use-favorite-shops';

jest.mock('./api', () => ({ fetchFavoriteShops: jest.fn() }));

const fetchFavoriteShopsMock = jest.mocked(fetchFavoriteShops);

async function renderFavoriteShops() {
  const queryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  }
  return renderHook(() => useFavoriteShops(), { wrapper: Wrapper });
}

describe('useFavoriteShops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('最初は loading', async () => {
    fetchFavoriteShopsMock.mockReturnValue(new Promise(() => {}));

    const { result } = await renderFavoriteShops();

    expect(result.current.status).toBe('loading');
  });

  it('取得した店舗を返す', async () => {
    fetchFavoriteShopsMock.mockResolvedValue([buildShopSummary()]);

    const { result } = await renderFavoriteShops();

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.shops).toHaveLength(1);
  });

  it('0 件なら empty', async () => {
    fetchFavoriteShopsMock.mockResolvedValue([]);

    const { result } = await renderFavoriteShops();

    await waitFor(() => {
      expect(result.current.status).toBe('empty');
    });
  });

  it('失敗したら error', async () => {
    fetchFavoriteShopsMock.mockRejectedValue(new Error('network'));

    const { result } = await renderFavoriteShops();

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.shops).toEqual([]);
  });
});
```

Run: `npm test -w @meshimap/mobile -- use-favorite-shops`
Expected: FAIL（`Cannot find module './use-favorite-shops'`）

- [ ] **Step 7: use-favorite-shops.ts を実装する**

```ts
// apps/mobile/src/features/favorites/use-favorite-shops.ts
import { useQuery } from '@tanstack/react-query';

import type { ShopSummary } from '@/features/shops/schema';

import { fetchFavoriteShops } from './api';
import { favoriteKeys } from './query-keys';

export type FavoriteShopsStatus = 'loading' | 'error' | 'empty' | 'success';

export interface FavoriteShopsResult {
  shops: readonly ShopSummary[];
  status: FavoriteShopsStatus;
  refetch: () => void;
}

export function useFavoriteShops(): FavoriteShopsResult {
  const query = useQuery({
    queryKey: favoriteKeys.shops(),
    queryFn: fetchFavoriteShops,
  });

  const shops = query.data ?? [];

  return {
    shops,
    status: query.isError
      ? 'error'
      : query.isPending
        ? 'loading'
        : shops.length === 0
          ? 'empty'
          : 'success',
    refetch: () => {
      void query.refetch();
    },
  };
}
```

Run: `npm test -w @meshimap/mobile -- use-favorite-shops`
Expected: PASS（4 件）

- [ ] **Step 8: わざと壊してテストが落ちることを確認する（このタスクで最重要）**

1. `onError` を丸ごと削除 → 「失敗したら元のキャッシュに戻す」「外すのに失敗したら元に戻す」
   「キャッシュが無い状態で失敗したらキャッシュごと消す」が **FAIL**。
2. `onError` の `removeQueries` 分岐を消し、
   `queryClient.setQueryData(favoriteKeys.ids(), context.previousIds)` だけにする →
   「キャッシュが無い状態で失敗したらキャッシュごと消す」だけが **FAIL**
   （`[SHOP_B]` が残る）。これが `setQueryData(key, undefined)` の NO-OP を踏んだ状態。
3. `onMutate` の `setQueryData` を消す → 「応答を待たずにキャッシュへ足す」が **FAIL**。
4. `onSuccess` を `onSettled` に変える → 「失敗したときは無効化しない」が **FAIL**。
5. `cancelQueries` の行を消す → 「取得中のリクエストを止めてから書き換える」が **FAIL**。

すべて確認したら元に戻し、`npm test -w @meshimap/mobile -- favorites` が全件 PASS することを確認する。

- [ ] **Step 9: コミットする**

```bash
git add apps/mobile/src/features/favorites/
git commit -m "feat(mobile): お気に入りの楽観更新と巻き戻しを追加する"
```

---

### Task 6-33: お気に入りボタンと保存済み画面を作る

**Files:**

- Create: `apps/mobile/src/components/shop/favorite-button.tsx`
- Create: `apps/mobile/src/components/shop/favorite-button.test.tsx`
- Create: `apps/mobile/src/app/(user)/(tabs)/saved.tsx`
- Create: `apps/mobile/src/app/(user)/(tabs)/saved.test.tsx`

**Interfaces:**

- Consumes: `lucide-react-native` の `Heart` / `HeartOff`、`@/components/ui/icon` の `Icon`、`@/components/shop/shop-card` の `ShopCard`、`@/components/ui/empty-state` の `EmptyState`、`@/components/ui/error-state` の `ErrorState`、`@/components/ui/skeleton` の `Skeleton`、`@/features/favorites/*` の `useFavoriteIds` / `useFavoriteShops` / `useToggleFavorite`、`expo-router` の `router`
- Produces: `FavoriteButton` / 型 `FavoriteButtonProps`、`SavedScreen`（default export）

`FavoriteButton` は状態を持たない。`isFavorite` と `onToggle` を受け取るだけにして、
地図のボトムシート・店舗詳細・保存済み画面のどこからでも同じ部品を使えるようにする。
フックを内側で呼ぶと、1 画面に 20 個並んだときに `useFavoriteIds` が 20 回走る。

- [ ] **Step 1: 失敗するテストを書く（お気に入りボタン）**

```tsx
// apps/mobile/src/components/shop/favorite-button.test.tsx
import { toShopId } from '@meshimap/core';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { FavoriteButton } from './favorite-button';

const SHOP_ID = toShopId('shop-001');

describe('FavoriteButton', () => {
  it('押すと店舗 ID を通知する', async () => {
    const onToggle = jest.fn();
    await render(
      <FavoriteButton isFavorite={false} onToggle={onToggle} shopId={SHOP_ID} testID="favorite" />,
    );

    fireEvent.press(screen.getByTestId('favorite'));

    expect(onToggle).toHaveBeenCalledWith(SHOP_ID);
  });

  it('未登録なら登録を促すラベルにする', async () => {
    await render(
      <FavoriteButton isFavorite={false} onToggle={jest.fn()} shopId={SHOP_ID} testID="favorite" />,
    );

    expect(screen.getByTestId('favorite')).toHaveProp('accessibilityLabel', 'お気に入りに追加する');
  });

  it('登録済みなら解除を促すラベルにする', async () => {
    await render(
      <FavoriteButton isFavorite onToggle={jest.fn()} shopId={SHOP_ID} testID="favorite" />,
    );

    expect(screen.getByTestId('favorite')).toHaveProp('accessibilityLabel', 'お気に入りから外す');
  });

  it('登録状態を accessibilityState でも伝える', async () => {
    await render(
      <FavoriteButton isFavorite onToggle={jest.fn()} shopId={SHOP_ID} testID="favorite" />,
    );

    expect(screen.getByTestId('favorite')).toHaveProp('accessibilityState', {
      disabled: false,
      selected: true,
    });
  });

  it('処理中は押せない', async () => {
    const onToggle = jest.fn();
    await render(
      <FavoriteButton
        isFavorite={false}
        isPending
        onToggle={onToggle}
        shopId={SHOP_ID}
        testID="favorite"
      />,
    );

    fireEvent.press(screen.getByTestId('favorite'));

    expect(onToggle).not.toHaveBeenCalled();
  });

  it('登録済みはハートを塗る', async () => {
    await render(
      <FavoriteButton isFavorite onToggle={jest.fn()} shopId={SHOP_ID} testID="favorite" />,
    );

    // アイコン本体は lucide の SVG で testID が届かないため、塗り色は wrapper の style で検証する
    expect(screen.getByTestId('favorite-heart')).toHaveStyle({ opacity: 1 });
  });

  it('testID が無ければ子にも付けない', async () => {
    await render(<FavoriteButton isFavorite onToggle={jest.fn()} shopId={SHOP_ID} />);

    expect(screen.queryByTestId('undefined-heart')).toBeNull();
  });
});
```

Run: `npm test -w @meshimap/mobile -- favorite-button`
Expected: FAIL（`Cannot find module './favorite-button'`）

- [ ] **Step 2: favorite-button.tsx を実装する**

```tsx
// apps/mobile/src/components/shop/favorite-button.tsx
import type { ShopId } from '@meshimap/core';
import { Heart } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { COLORS, RADIUS, SEMANTIC_COLORS, SPACING } from '@/constants/theme';

const ADD_LABEL = 'お気に入りに追加する';
const REMOVE_LABEL = 'お気に入りから外す';

/** 未登録のハートは輪郭だけ。色名ではなく transparent を渡す */
const UNFILLED = 'transparent';

/**
 * ハートの大きさ（px）。Icon プリミティブの md と同じ 20px にそろえる。
 * Icon を経由しないのは、IconProps が `{ icon, size?, color?, testID? }` だけで
 * `fill` を受け取らず、塗り分けができないため。
 */
const HEART_PIXEL_SIZE = 20;

/** タップ領域。44px は iOS のヒューマンインターフェイスガイドラインの最小値 */
const HIT_AREA_PX = 44;

export interface FavoriteButtonProps {
  shopId: ShopId;
  isFavorite: boolean;
  onToggle: (shopId: ShopId) => void;
  /** 送信中は連打を止める。楽観更新が効くので見た目はすでに切り替わっている */
  isPending?: boolean | undefined;
  testID?: string | undefined;
}

export function FavoriteButton({
  shopId,
  isFavorite,
  onToggle,
  isPending = false,
  testID,
}: FavoriteButtonProps) {
  const heartColor = isFavorite ? SEMANTIC_COLORS.danger : COLORS.neutral[500];

  return (
    <Pressable
      accessibilityLabel={isFavorite ? REMOVE_LABEL : ADD_LABEL}
      accessibilityRole="button"
      accessibilityState={{ disabled: isPending, selected: isFavorite }}
      disabled={isPending}
      onPress={() => {
        onToggle(shopId);
      }}
      style={{
        alignItems: 'center',
        backgroundColor: COLORS.white,
        borderRadius: RADIUS.pill,
        height: HIT_AREA_PX,
        justifyContent: 'center',
        width: HIT_AREA_PX,
      }}
      testID={testID}
    >
      {/*
        lucide のアイコンは testID を data-testid に変換するため RN のツリーには残らない。
        見た目の検証用に wrapper の View へ testID を置く。
      */}
      <View
        style={{ opacity: isPending ? 0.5 : 1, padding: SPACING.xs }}
        testID={testID === undefined ? undefined : `${testID}-heart`}
      >
        <Heart
          color={heartColor}
          fill={isFavorite ? SEMANTIC_COLORS.danger : UNFILLED}
          size={HEART_PIXEL_SIZE}
        />
      </View>
    </Pressable>
  );
}
```

`lucide-react-native` のアイコンは `react-native-svg` の `Svg` に props を流すので、
`fill` はそのまま塗りに反映される（`node_modules/lucide-react-native/dist/esm/createLucideIcon.js`）。

Run: `npm test -w @meshimap/mobile -- favorite-button`
Expected: PASS（7 件）

- [ ] **Step 3: 失敗するテストを書く（保存済み画面）**

```tsx
// apps/mobile/src/app/(user)/(tabs)/saved.test.tsx
import { toShopId } from '@meshimap/core';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { useFavoriteIds } from '@/features/favorites/use-favorite-ids';
import type { FavoriteIdsResult } from '@/features/favorites/use-favorite-ids';
import { useFavoriteShops } from '@/features/favorites/use-favorite-shops';
import type { FavoriteShopsResult } from '@/features/favorites/use-favorite-shops';
import { useToggleFavorite } from '@/features/favorites/use-toggle-favorite';
import type { ToggleFavoriteResult } from '@/features/favorites/use-toggle-favorite';
import { buildShopSummary } from '@/test-support/shop-fixtures';

import SavedScreen from './saved';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/features/favorites/use-favorite-shops', () => ({ useFavoriteShops: jest.fn() }));
jest.mock('@/features/favorites/use-favorite-ids', () => ({ useFavoriteIds: jest.fn() }));
jest.mock('@/features/favorites/use-toggle-favorite', () => ({ useToggleFavorite: jest.fn() }));

const useFavoriteShopsMock = jest.mocked(useFavoriteShops);
const useFavoriteIdsMock = jest.mocked(useFavoriteIds);
const useToggleFavoriteMock = jest.mocked(useToggleFavorite);

const SHOP_ID = toShopId('shop-001');
const toggleMock = jest.fn();
const refetchMock = jest.fn();

function buildShopsResult(overrides: Partial<FavoriteShopsResult> = {}): FavoriteShopsResult {
  return { shops: [], status: 'success', refetch: refetchMock, ...overrides };
}

function buildIdsResult(overrides: Partial<FavoriteIdsResult> = {}): FavoriteIdsResult {
  return {
    favoriteIds: [SHOP_ID],
    status: 'success',
    isFavorite: (shopId) => shopId === SHOP_ID,
    refetch: refetchMock,
    ...overrides,
  };
}

function buildToggleResult(overrides: Partial<ToggleFavoriteResult> = {}): ToggleFavoriteResult {
  return { toggle: toggleMock, isPending: false, errorMessage: null, ...overrides };
}

describe('SavedScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useFavoriteIdsMock.mockReturnValue(buildIdsResult());
    useToggleFavoriteMock.mockReturnValue(buildToggleResult());
    useFavoriteShopsMock.mockReturnValue(buildShopsResult());
  });

  it('読み込み中はスケルトンを出す', async () => {
    useFavoriteShopsMock.mockReturnValue(buildShopsResult({ status: 'loading' }));

    await render(<SavedScreen />);

    expect(screen.getByTestId('saved-loading')).toBeOnTheScreen();
    expect(screen.queryByTestId('saved-empty')).toBeNull();
  });

  it('失敗したら再試行できる', async () => {
    useFavoriteShopsMock.mockReturnValue(buildShopsResult({ status: 'error' }));

    await render(<SavedScreen />);
    fireEvent.press(screen.getByTestId('saved-error-retry-button'));

    expect(refetchMock).toHaveBeenCalledTimes(1);
  });

  it('0 件なら探しに行く導線を出す', async () => {
    useFavoriteShopsMock.mockReturnValue(buildShopsResult({ status: 'empty' }));

    await render(<SavedScreen />);

    expect(screen.getByTestId('saved-empty')).toBeOnTheScreen();
  });

  it('0 件のボタンで検索画面へ行く', async () => {
    const { router } = jest.requireMock<{ router: { push: jest.Mock } }>('expo-router');
    useFavoriteShopsMock.mockReturnValue(buildShopsResult({ status: 'empty' }));

    await render(<SavedScreen />);
    fireEvent.press(screen.getByTestId('saved-empty-action-button'));

    expect(router.push).toHaveBeenCalledWith('/search');
  });

  it('保存した店を並べる', async () => {
    useFavoriteShopsMock.mockReturnValue(
      buildShopsResult({ shops: [buildShopSummary()], status: 'success' }),
    );

    await render(<SavedScreen />);

    expect(screen.getByTestId('saved-card-shop-001')).toBeOnTheScreen();
    expect(screen.getByTestId('saved-favorite-shop-001')).toBeOnTheScreen();
  });

  it('カードを押すと詳細へ行く', async () => {
    const { router } = jest.requireMock<{ router: { push: jest.Mock } }>('expo-router');
    useFavoriteShopsMock.mockReturnValue(
      buildShopsResult({ shops: [buildShopSummary()], status: 'success' }),
    );

    await render(<SavedScreen />);
    fireEvent.press(screen.getByTestId('saved-card-shop-001'));

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/shop/[shopId]',
      params: { shopId: 'shop-001' },
    });
  });

  it('ハートを押すと切り替えを呼ぶ', async () => {
    useFavoriteShopsMock.mockReturnValue(
      buildShopsResult({ shops: [buildShopSummary()], status: 'success' }),
    );

    await render(<SavedScreen />);
    fireEvent.press(screen.getByTestId('saved-favorite-shop-001'));

    expect(toggleMock).toHaveBeenCalledWith(SHOP_ID);
  });

  it('切り替えに失敗したら理由を出す', async () => {
    useToggleFavoriteMock.mockReturnValue(
      buildToggleResult({ errorMessage: 'お気に入りを更新できませんでした' }),
    );
    useFavoriteShopsMock.mockReturnValue(
      buildShopsResult({ shops: [buildShopSummary()], status: 'success' }),
    );

    await render(<SavedScreen />);

    expect(screen.getByTestId('saved-toggle-error')).toHaveTextContent(
      'お気に入りを更新できませんでした',
    );
  });

  it('距離は出さない（保存済み画面では現在地を使わない）', async () => {
    useFavoriteShopsMock.mockReturnValue(
      buildShopsResult({ shops: [buildShopSummary()], status: 'success' }),
    );

    await render(<SavedScreen />);

    expect(screen.queryByTestId('saved-card-shop-001-distance')).toBeNull();
  });
});
```

Run: `npm test -w @meshimap/mobile -- tabs/saved`
Expected: FAIL（`Cannot find module './saved'`）

- [ ] **Step 4: saved.tsx を実装する**

```tsx
// apps/mobile/src/app/(user)/(tabs)/saved.tsx
import type { ShopId } from '@meshimap/core';
import { router } from 'expo-router';
import { HeartOff } from 'lucide-react-native';
import { FlatList, Text, View } from 'react-native';

import { FavoriteButton } from '@/components/shop/favorite-button';
import { ShopCard } from '@/components/shop/shop-card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { COLORS, SPACING } from '@/constants/theme';
import { useFavoriteIds } from '@/features/favorites/use-favorite-ids';
import { useFavoriteShops } from '@/features/favorites/use-favorite-shops';
import { useToggleFavorite } from '@/features/favorites/use-toggle-favorite';
import type { ShopSummary } from '@/features/shops/schema';

const SCREEN_TITLE = '保存した店';
const ERROR_TITLE = '保存した店を読み込めませんでした';
const ERROR_DESCRIPTION = '通信状況を確かめて、もう一度お試しください';
const EMPTY_TITLE = 'まだ保存した店がありません';
const EMPTY_DESCRIPTION = '気になる店のハートを押すと、ここにたまります';
const EMPTY_ACTION_LABEL = '店を探す';

/** 読み込み中に並べるカードの枚数。1 画面に収まる程度に抑える */
const SKELETON_COUNT = 3;
const SKELETON_CARD_HEIGHT_PX = 112;

function goToShop(shopId: ShopId): void {
  // テンプレート文字列のパスは型付きルート生成後に Href へ解決できないことがあるため
  // pathname + params の形で渡す
  router.push({ pathname: '/shop/[shopId]', params: { shopId } });
}

export default function SavedScreen() {
  const favoriteShops = useFavoriteShops();
  const favoriteIds = useFavoriteIds();
  const toggleFavorite = useToggleFavorite();

  const renderItem = ({ item }: { item: ShopSummary }) => (
    <View className="flex-row items-center gap-sm">
      <View className="flex-1">
        <ShopCard
          distanceM={null}
          isSelected={false}
          onPress={goToShop}
          shop={item}
          testID={`saved-card-${item.id}`}
        />
      </View>
      <FavoriteButton
        isFavorite={favoriteIds.isFavorite(item.id)}
        isPending={toggleFavorite.isPending}
        onToggle={toggleFavorite.toggle}
        shopId={item.id}
        testID={`saved-favorite-${item.id}`}
      />
    </View>
  );

  return (
    <View className="flex-1 bg-neutral-50">
      <View className="border-b border-neutral-200 bg-white px-md py-sm">
        <Text className="font-display text-xl text-neutral-900">{SCREEN_TITLE}</Text>
      </View>

      {toggleFavorite.errorMessage === null ? null : (
        <Text
          accessibilityRole="alert"
          className="px-md py-sm font-body text-sm"
          style={{ color: COLORS.red[700] }}
          testID="saved-toggle-error"
        >
          {toggleFavorite.errorMessage}
        </Text>
      )}

      {favoriteShops.status === 'loading' ? (
        <View className="gap-sm p-md" testID="saved-loading">
          {Array.from({ length: SKELETON_COUNT }, (_unused, index) => (
            <Skeleton height={SKELETON_CARD_HEIGHT_PX} key={index} />
          ))}
        </View>
      ) : favoriteShops.status === 'error' ? (
        <ErrorState
          description={ERROR_DESCRIPTION}
          onRetry={favoriteShops.refetch}
          testID="saved-error"
          title={ERROR_TITLE}
        />
      ) : favoriteShops.status === 'empty' ? (
        <EmptyState
          action={{
            label: EMPTY_ACTION_LABEL,
            onPress: () => {
              router.push('/search');
            },
          }}
          description={EMPTY_DESCRIPTION}
          icon={HeartOff}
          testID="saved-empty"
          title={EMPTY_TITLE}
        />
      ) : (
        <FlatList
          contentContainerStyle={{ gap: SPACING.sm, padding: SPACING.md }}
          data={favoriteShops.shops}
          keyExtractor={(shop) => shop.id}
          renderItem={renderItem}
          testID="saved-list"
        />
      )}
    </View>
  );
}
```

`Skeleton` の `key={index}` は、この配列が「同じ高さの箱を N 個並べるだけ」で
並び替えも差し替えも起きないため、添字キーで問題ない。

Run: `npm test -w @meshimap/mobile -- tabs/saved`
Expected: PASS（9 件）

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`FavoriteButton` の `disabled={isPending}` を消し、「処理中は押せない」が **FAIL** することを確認してから戻す。
次に `saved.tsx` の `status === 'empty'` 分岐を消し、「0 件なら探しに行く導線を出す」が **FAIL**
（`FlatList` が空で描画される）することを確認する。
最後に `toggleFavorite.errorMessage` のブロックを消し、「切り替えに失敗したら理由を出す」が
**FAIL** することも確認してから戻す。

- [ ] **Step 6: コミットする**

```bash
git add apps/mobile/src/components/shop/favorite-button.tsx apps/mobile/src/components/shop/favorite-button.test.tsx "apps/mobile/src/app/(user)/(tabs)/saved.tsx" "apps/mobile/src/app/(user)/(tabs)/saved.test.tsx"
git commit -m "feat(mobile): お気に入りボタンと保存済み画面を追加する"
```

---

### Task 6-34: 区画枠・メニュー一覧・全画面写真ビューアを作る

**Files:**

- Create: `apps/mobile/src/components/shop/shop-section.tsx`
- Create: `apps/mobile/src/components/shop/shop-section.test.tsx`
- Create: `apps/mobile/src/components/shop/shop-menu-list.tsx`
- Create: `apps/mobile/src/components/shop/shop-menu-list.test.tsx`
- Create: `apps/mobile/src/lib/photo-pager.ts`
- Create: `apps/mobile/src/lib/photo-pager.test.ts`
- Create: `apps/mobile/src/components/shop/shop-photo-viewer.tsx`
- Create: `apps/mobile/src/components/shop/shop-photo-viewer.test.tsx`

**Interfaces:**

- Consumes: `@meshimap/core` の `formatYen`、`expo-image` の `Image`、`lucide-react-native` の `X`、`react-native` の `BackHandler` / `Pressable` / `ScrollView` / `StyleSheet` / `Text` / `View` / `useWindowDimensions`、`@/components/ui/badge` の `Badge`、`@/components/ui/icon` の `Icon`、`@/constants/theme` の `COLORS` / `RADIUS` / `SPACING` / `Z_INDEX`、`@/features/shops/schema` の 型 `ShopMenuItem`
- Produces:
  - `ShopSection` / `ShopSectionProps { title: string; children: ReactNode; action?: ReactNode | undefined; testID?: string | undefined }`
  - `ShopMenuList` / `ShopMenuListProps { items: readonly ShopMenuItem[]; testID?: string | undefined }`
  - `photoPageIndex(offsetX: number, pageWidthPx: number, photoCount: number): number`
  - `photoPageLabel(index: number, photoCount: number): string`
  - `ShopPhotoViewer` / `ShopPhotoViewerProps { photoUrls: readonly string[]; initialIndex: number | null; onClose: () => void; testID?: string | undefined }`

- [ ] **Step 1: 失敗するテストを書く（区画枠）**

```tsx
// apps/mobile/src/components/shop/shop-section.test.tsx
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { ShopSection } from './shop-section';

describe('ShopSection', () => {
  it('見出しを出す', async () => {
    await render(
      <ShopSection testID="section" title="メニュー">
        <Text>本文</Text>
      </ShopSection>,
    );

    expect(screen.getByTestId('section-title')).toHaveTextContent('メニュー');
  });

  it('見出しは header ロールで読み上げられる', async () => {
    // 詳細画面は区画が多い。見出しロールが無いとスクリーンリーダーで区画を飛ばせない
    await render(
      <ShopSection testID="section" title="メニュー">
        <Text>本文</Text>
      </ShopSection>,
    );

    expect(screen.getByRole('header', { name: 'メニュー' })).toBeOnTheScreen();
  });

  it('子要素を出す', async () => {
    await render(
      <ShopSection testID="section" title="メニュー">
        <Text testID="body">本文</Text>
      </ShopSection>,
    );

    expect(screen.getByTestId('body')).toBeOnTheScreen();
  });

  it('補助操作を省略できる', async () => {
    await render(
      <ShopSection testID="section" title="メニュー">
        <Text>本文</Text>
      </ShopSection>,
    );

    expect(screen.queryByTestId('section-action')).toBeNull();
  });

  it('補助操作を渡すと見出しの横に出る', async () => {
    await render(
      <ShopSection
        action={<Text testID="section-action">すべて見る</Text>}
        testID="section"
        title="レビュー"
      >
        <Text>本文</Text>
      </ShopSection>,
    );

    expect(screen.getByTestId('section-action')).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile -- shop-section`
Expected: FAIL（`Cannot find module './shop-section'`）

- [ ] **Step 2: shop-section.tsx を実装する**

```tsx
// apps/mobile/src/components/shop/shop-section.tsx
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

export interface ShopSectionProps {
  title: string;
  children: ReactNode;
  /** 見出しの右端に置く補助操作（「レビューを書く」など）。無ければ省略する */
  action?: ReactNode | undefined;
  testID?: string | undefined;
}

/**
 * 店舗詳細の 1 区画。見出しの書式と上下の余白をここに集約する。
 * 画面側が区画ごとに padding を書き分けると、区画が増えたときに必ずずれるため。
 */
export function ShopSection({ title, children, action, testID }: ShopSectionProps) {
  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  return (
    <View className="gap-sm border-t border-neutral-200 bg-white p-md" testID={testID}>
      <View className="flex-row items-center justify-between gap-sm">
        <Text
          accessibilityRole="header"
          className="font-display text-lg text-neutral-900"
          testID={childTestId('title')}
        >
          {title}
        </Text>
        {action ?? null}
      </View>
      {children}
    </View>
  );
}
```

Run: `npm test -w @meshimap/mobile -- shop-section`
Expected: PASS（5 件）

- [ ] **Step 3: 失敗するテストを書く（メニュー一覧）**

```tsx
// apps/mobile/src/components/shop/shop-menu-list.test.tsx
import { render, screen } from '@testing-library/react-native';

import { buildShopDetail } from '@/test-support/shop-fixtures';

import { ShopMenuList } from './shop-menu-list';

/** フィクスチャの店舗詳細からメニューだけを取り出す。スキーマを通した本物の形で試す */
const MENU_ITEMS = buildShopDetail().menuItems;

describe('ShopMenuList', () => {
  it('品名を並べる', async () => {
    await render(<ShopMenuList items={MENU_ITEMS} testID="menu" />);

    expect(screen.getByText('おまかせ 10 本コース')).toBeOnTheScreen();
    expect(screen.getByText('せせり')).toBeOnTheScreen();
  });

  it('価格を 3 桁区切りの円表記で出す', async () => {
    await render(<ShopMenuList items={MENU_ITEMS} testID="menu" />);

    expect(screen.getByTestId('menu-price-0')).toHaveTextContent('¥3,800');
  });

  it('価格が null の品は時価と出す', async () => {
    const items = buildShopDetail({
      menuItems: [
        {
          name: '本日の一品',
          priceYen: null,
          description: '',
          photoUrl: null,
          isRecommended: false,
        },
      ],
    }).menuItems;

    await render(<ShopMenuList items={items} testID="menu" />);

    // 0 円と紛れないよう、金額欄を空にせず文言で埋める
    expect(screen.getByTestId('menu-price-0')).toHaveTextContent('時価');
  });

  it('おすすめの品には印を付ける', async () => {
    await render(<ShopMenuList items={MENU_ITEMS} testID="menu" />);

    expect(screen.getByTestId('menu-recommended-0')).toHaveTextContent('おすすめ');
  });

  it('おすすめでない品には印を付けない', async () => {
    await render(<ShopMenuList items={MENU_ITEMS} testID="menu" />);

    expect(screen.queryByTestId('menu-recommended-1')).toBeNull();
  });

  it('写真がある品だけサムネイルを出す', async () => {
    await render(<ShopMenuList items={MENU_ITEMS} testID="menu" />);

    expect(screen.getByTestId('menu-photo-0')).toBeOnTheScreen();
    expect(screen.queryByTestId('menu-photo-1')).toBeNull();
  });

  it('0 件なら何も描かない', async () => {
    await render(<ShopMenuList items={[]} testID="menu" />);

    // 見出しだけが残る空区画を作らないため、呼び出し側も件数で出し分ける
    expect(screen.queryByTestId('menu')).toBeNull();
  });
});
```

Run: `npm test -w @meshimap/mobile -- shop-menu-list`
Expected: FAIL（`Cannot find module './shop-menu-list'`）

- [ ] **Step 4: shop-menu-list.tsx を実装する**

```tsx
// apps/mobile/src/components/shop/shop-menu-list.tsx
import { formatYen } from '@meshimap/core';
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { COLORS, RADIUS } from '@/constants/theme';
import type { ShopMenuItem } from '@/features/shops/schema';

const RECOMMENDED_LABEL = 'おすすめ';
/** 価格が未登録の品の表示。金額欄を空にすると 0 円と読み違えられる */
const PRICE_UNSET_LABEL = '時価';
const IMAGE_TRANSITION_MS = 200;

/** サムネイルの一辺（px）。品名 + 説明 2 行と同じくらいの高さ */
const THUMBNAIL_SIZE_PX = 64;

export interface ShopMenuListProps {
  items: readonly ShopMenuItem[];
  testID?: string | undefined;
}

/** 価格の表示。formatYen は負値・非整数で例外を投げるので null だけを分岐すれば足りる */
function formatMenuPrice(priceYen: number | null): string {
  return priceYen === null ? PRICE_UNSET_LABEL : formatYen(priceYen);
}

export function ShopMenuList({ items, testID }: ShopMenuListProps) {
  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  if (items.length === 0) {
    return null;
  }

  return (
    <View className="gap-md" testID={testID}>
      {items.map((item, index) => (
        <View
          className="flex-row items-start gap-sm"
          // 同名の品が並ぶ店があるため、名前だけでは一意にならない
          key={`${index}-${item.name}`}
          testID={childTestId(`item-${index}`)}
        >
          {item.photoUrl === null ? null : (
            <Image
              contentFit="cover"
              source={item.photoUrl}
              style={styles.thumbnail}
              testID={childTestId(`photo-${index}`)}
              transition={IMAGE_TRANSITION_MS}
            />
          )}
          <View className="flex-1 gap-xs">
            <View className="flex-row items-start gap-sm">
              <Text className="flex-1 font-body-bold text-base text-neutral-900">{item.name}</Text>
              <Text
                className="font-body-bold text-base text-neutral-900"
                testID={childTestId(`price-${index}`)}
              >
                {formatMenuPrice(item.priceYen)}
              </Text>
            </View>
            {item.description === '' ? null : (
              <Text className="font-body text-sm text-neutral-600">{item.description}</Text>
            )}
            {item.isRecommended ? (
              <Badge
                label={RECOMMENDED_LABEL}
                testID={childTestId(`recommended-${index}`)}
                tone="brand"
              />
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  thumbnail: {
    width: THUMBNAIL_SIZE_PX,
    height: THUMBNAIL_SIZE_PX,
    borderRadius: RADIUS.md,
    // 読み込み前に穴が空いて見えないよう、下敷きの色を置く
    backgroundColor: COLORS.neutral[200],
  },
});
```

`expo-image` の `Image` は NativeWind の `cssInterop` に登録されていないため `className` は効かない。
サムネイルの寸法は `StyleSheet` で渡す。

Run: `npm test -w @meshimap/mobile -- shop-menu-list`
Expected: PASS（7 件）

- [ ] **Step 5: 失敗するテストを書く（ページ計算）**

```ts
// apps/mobile/src/lib/photo-pager.test.ts
import { photoPageIndex, photoPageLabel } from './photo-pager';

const PAGE_WIDTH_PX = 390;
const PHOTO_COUNT = 4;

describe('photoPageIndex', () => {
  it('先頭は 0 になる', () => {
    expect(photoPageIndex(0, PAGE_WIDTH_PX, PHOTO_COUNT)).toBe(0);
  });

  it('1 ページぶん進むと 1 になる', () => {
    expect(photoPageIndex(PAGE_WIDTH_PX, PAGE_WIDTH_PX, PHOTO_COUNT)).toBe(1);
  });

  it('半分を超えたら次のページとみなす', () => {
    expect(photoPageIndex(PAGE_WIDTH_PX * 0.6, PAGE_WIDTH_PX, PHOTO_COUNT)).toBe(1);
  });

  it('半分に届かなければ手前のページのまま', () => {
    expect(photoPageIndex(PAGE_WIDTH_PX * 0.4, PAGE_WIDTH_PX, PHOTO_COUNT)).toBe(0);
  });

  it('バウンドで負の位置になっても 0 を下回らない', () => {
    // iOS は端で引っ張ると contentOffset が負になる
    expect(photoPageIndex(-120, PAGE_WIDTH_PX, PHOTO_COUNT)).toBe(0);
  });

  it('末尾を行き過ぎても最後のページに収まる', () => {
    expect(photoPageIndex(PAGE_WIDTH_PX * 99, PAGE_WIDTH_PX, PHOTO_COUNT)).toBe(PHOTO_COUNT - 1);
  });

  it('幅が未確定（0）でも 0 除算しない', () => {
    expect(photoPageIndex(100, 0, PHOTO_COUNT)).toBe(0);
  });

  it('写真が 0 枚なら 0 を返す', () => {
    expect(photoPageIndex(100, PAGE_WIDTH_PX, 0)).toBe(0);
  });
});

describe('photoPageLabel', () => {
  it('1 始まりで「現在 / 総数」を出す', () => {
    expect(photoPageLabel(2, PHOTO_COUNT)).toBe('3 / 4');
  });

  it('1 枚しかなくても総数を出す', () => {
    expect(photoPageLabel(0, 1)).toBe('1 / 1');
  });
});
```

Run: `npm test -w @meshimap/mobile -- photo-pager`
Expected: FAIL（`Cannot find module './photo-pager'`）

- [ ] **Step 6: photo-pager.ts を実装する**

```ts
// apps/mobile/src/lib/photo-pager.ts
/**
 * 全画面写真ビューアのページ計算。
 * ScrollView の onScroll から来る横位置をページ番号へ丸めるだけの純関数にして、
 * 端の丸め（引っ張りで負になる・末尾を行き過ぎる）をテストで固定する。
 */

/** 位置表示の区切り。全角スペースだと等幅にならず数字が揺れる */
const PAGE_LABEL_SEPARATOR = ' / ';

/** 幅や枚数が未確定のときに返す番号 */
const FALLBACK_INDEX = 0;

export function photoPageIndex(offsetX: number, pageWidthPx: number, photoCount: number): number {
  // 初回レイアウト前は幅が 0 で来る。0 除算すると NaN が位置表示まで漏れる
  if (pageWidthPx <= 0 || photoCount <= 0) {
    return FALLBACK_INDEX;
  }
  const rawIndex = Math.round(offsetX / pageWidthPx);
  return Math.min(Math.max(rawIndex, FALLBACK_INDEX), photoCount - 1);
}

/** 「3 / 4」のような位置表示。人が読む番号なので 1 始まりにする */
export function photoPageLabel(index: number, photoCount: number): string {
  return `${index + 1}${PAGE_LABEL_SEPARATOR}${photoCount}`;
}
```

Run: `npm test -w @meshimap/mobile -- photo-pager`
Expected: PASS（10 件）

- [ ] **Step 7: 失敗するテストを書く（全画面写真ビューア）**

`Modal` を使わず、画面の最前面に絶対配置した `View` で作る。理由は 2 つ。
RN 0.86 の `Modal` は開発ビルドで子を `AppContainer` に包み直すため
（`node_modules/react-native/Libraries/Modal/Modal.js:310-315`）テスト環境での描画が
バージョンに左右されること、そして `Z_INDEX.modal` を使えば同じ見た目を素の `View` で作れることの 2 点。
Android の戻るキーだけは `Modal` の `onRequestClose` が無くなるので `BackHandler` で自前に拾う。

```tsx
// apps/mobile/src/components/shop/shop-photo-viewer.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { BackHandler, Dimensions } from 'react-native';

import { ShopPhotoViewer } from './shop-photo-viewer';

const PHOTO_URLS = [
  'https://cdn.example.test/shops/001/1.jpg',
  'https://cdn.example.test/shops/001/2.jpg',
  'https://cdn.example.test/shops/001/3.jpg',
  'https://cdn.example.test/shops/001/4.jpg',
];

/** useWindowDimensions と同じ値。ページ幅を決め打ちにしないため実測値を使う */
const WINDOW_WIDTH_PX = Dimensions.get('window').width;

/** BackHandler に渡されるイベント。型は HardwareBackPressEvent と同じ形 */
const BACK_PRESS_EVENT = { type: 'hardwareBackPress', timeStamp: 0 };

describe('ShopPhotoViewer', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('initialIndex が null なら何も描かない', async () => {
    await render(
      <ShopPhotoViewer
        initialIndex={null}
        onClose={jest.fn()}
        photoUrls={PHOTO_URLS}
        testID="viewer"
      />,
    );

    expect(screen.queryByTestId('viewer')).toBeNull();
  });

  it('写真が 0 枚なら開かない', async () => {
    await render(
      <ShopPhotoViewer initialIndex={0} onClose={jest.fn()} photoUrls={[]} testID="viewer" />,
    );

    expect(screen.queryByTestId('viewer')).toBeNull();
  });

  it('写真を全部並べる', async () => {
    await render(
      <ShopPhotoViewer
        initialIndex={0}
        onClose={jest.fn()}
        photoUrls={PHOTO_URLS}
        testID="viewer"
      />,
    );

    expect(screen.getByTestId('viewer-photo-0')).toBeOnTheScreen();
    expect(screen.getByTestId('viewer-photo-3')).toBeOnTheScreen();
  });

  it('押された写真の位置から始まる', async () => {
    await render(
      <ShopPhotoViewer
        initialIndex={2}
        onClose={jest.fn()}
        photoUrls={PHOTO_URLS}
        testID="viewer"
      />,
    );

    expect(screen.getByTestId('viewer-counter')).toHaveTextContent('3 / 4');
  });

  it('横スクロールすると位置表示が追随する', async () => {
    await render(
      <ShopPhotoViewer
        initialIndex={0}
        onClose={jest.fn()}
        photoUrls={PHOTO_URLS}
        testID="viewer"
      />,
    );

    await fireEvent.scroll(screen.getByTestId('viewer-pager'), {
      nativeEvent: { contentOffset: { x: WINDOW_WIDTH_PX * 2, y: 0 } },
    });

    expect(screen.getByTestId('viewer-counter')).toHaveTextContent('3 / 4');
  });

  it('閉じるボタンで閉じる', async () => {
    const handleClose = jest.fn();
    await render(
      <ShopPhotoViewer
        initialIndex={0}
        onClose={handleClose}
        photoUrls={PHOTO_URLS}
        testID="viewer"
      />,
    );

    await fireEvent.press(screen.getByTestId('viewer-close'));

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('Android の戻るキーで閉じ、イベントを消費する', async () => {
    const handleClose = jest.fn();
    const addEventListener = jest.spyOn(BackHandler, 'addEventListener');
    await render(
      <ShopPhotoViewer
        initialIndex={0}
        onClose={handleClose}
        photoUrls={PHOTO_URLS}
        testID="viewer"
      />,
    );

    const handleBackPress = addEventListener.mock.calls[0]?.[1];

    // true を返さないと戻るがそのまま前の画面へ抜けて、ビューアだけ閉じない
    expect(handleBackPress?.(BACK_PRESS_EVENT)).toBe(true);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('閉じているあいだは戻るキーを横取りしない', async () => {
    const addEventListener = jest.spyOn(BackHandler, 'addEventListener');
    await render(
      <ShopPhotoViewer
        initialIndex={null}
        onClose={jest.fn()}
        photoUrls={PHOTO_URLS}
        testID="viewer"
      />,
    );

    expect(addEventListener).not.toHaveBeenCalled();
  });

  it('消えるときに戻るキーの購読を解除する', async () => {
    const remove = jest.fn();
    jest.spyOn(BackHandler, 'addEventListener').mockReturnValue({ remove });
    const view = await render(
      <ShopPhotoViewer
        initialIndex={0}
        onClose={jest.fn()}
        photoUrls={PHOTO_URLS}
        testID="viewer"
      />,
    );

    view.unmount();

    expect(remove).toHaveBeenCalledTimes(1);
  });
});
```

Run: `npm test -w @meshimap/mobile -- shop-photo-viewer`
Expected: FAIL（`Cannot find module './shop-photo-viewer'`）

- [ ] **Step 8: shop-photo-viewer.tsx を実装する**

```tsx
// apps/mobile/src/components/shop/shop-photo-viewer.tsx
import { Image } from 'expo-image';
import { X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { Icon } from '@/components/ui/icon';
import { COLORS, RADIUS, SPACING, Z_INDEX } from '@/constants/theme';
import { photoPageIndex, photoPageLabel } from '@/lib/photo-pager';

const CLOSE_LABEL = '写真を閉じる';
const IMAGE_TRANSITION_MS = 200;

/** 背景の黒。NativeWind のスラッシュ記法に頼らず rgba で書く */
const BACKDROP_COLOR = 'rgba(0, 0, 0, 0.94)';

/** 閉じるボタンの丸い当たり判定（px）。44px は iOS の最小推奨サイズ */
const CLOSE_HIT_AREA_PX = 44;

/** 閉じるボタンの下敷き。白い写真の上でもボタンが消えないように敷く */
const CONTROL_BACKGROUND_COLOR = 'rgba(0, 0, 0, 0.5)';

/** onScroll の間引き間隔（ms）。位置表示の更新はこの粒度で足りる */
const SCROLL_EVENT_THROTTLE_MS = 32;

/**
 * onScroll から必要なのは横位置だけ。
 * `NativeSyntheticEvent<NativeScrollEvent>` を丸ごと要求すると、テストで
 * preventDefault や dispatchConfig まで組む羽目になる。
 * 引数は反変なので、この形で受けても ScrollView の onScroll にそのまま渡せる。
 */
export interface PhotoScrollEvent {
  readonly nativeEvent: { readonly contentOffset: { readonly x: number } };
}

export interface ShopPhotoViewerProps {
  photoUrls: readonly string[];
  /** 最初に見せる写真の添字。null なら閉じている */
  initialIndex: number | null;
  onClose: () => void;
  testID?: string | undefined;
}

export function ShopPhotoViewer({
  photoUrls,
  initialIndex,
  onClose,
  testID,
}: ShopPhotoViewerProps) {
  const { width: windowWidthPx } = useWindowDimensions();
  const [currentIndex, setCurrentIndex] = useState(initialIndex ?? 0);

  const isOpen = initialIndex !== null && photoUrls.length > 0;

  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  // 開き直したときに前回見ていた位置が残らないようにする
  useEffect(() => {
    if (initialIndex !== null) {
      setCurrentIndex(initialIndex);
    }
  }, [initialIndex]);

  // Android の戻るは「前の画面へ」ではなく「ビューアを閉じる」に割り当てる。
  // 閉じているあいだに購読すると、詳細画面の戻るまで奪ってしまう
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      // true = このイベントは消費した、の意味。返さないと前の画面まで戻ってしまう
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [isOpen, onClose]);

  if (initialIndex === null || photoUrls.length === 0) {
    return null;
  }

  return (
    <View style={styles.backdrop} testID={testID}>
      <ScrollView
        // 押された写真の位置から開く。scrollTo を useEffect で呼ぶ形にすると 1 フレーム先頭が見える
        contentOffset={{ x: initialIndex * windowWidthPx, y: 0 }}
        horizontal
        onScroll={(event: PhotoScrollEvent) => {
          setCurrentIndex(
            photoPageIndex(event.nativeEvent.contentOffset.x, windowWidthPx, photoUrls.length),
          );
        }}
        pagingEnabled
        scrollEventThrottle={SCROLL_EVENT_THROTTLE_MS}
        showsHorizontalScrollIndicator={false}
        testID={childTestId('pager')}
      >
        {photoUrls.map((url, index) => (
          <View key={url} style={[styles.page, { width: windowWidthPx }]}>
            <Image
              contentFit="contain"
              source={url}
              style={styles.photo}
              testID={childTestId(`photo-${index}`)}
              transition={IMAGE_TRANSITION_MS}
            />
          </View>
        ))}
      </ScrollView>

      <View pointerEvents="box-none" style={styles.controls}>
        <Pressable
          accessibilityLabel={CLOSE_LABEL}
          accessibilityRole="button"
          onPress={onClose}
          style={styles.closeButton}
          testID={childTestId('close')}
        >
          <Icon color={COLORS.white} icon={X} size="md" />
        </Pressable>
        <Text className="font-body text-sm text-white" testID={childTestId('counter')}>
          {photoPageLabel(currentIndex, photoUrls.length)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BACKDROP_COLOR,
    zIndex: Z_INDEX.modal,
  },
  page: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: SPACING.md,
  },
  closeButton: {
    width: CLOSE_HIT_AREA_PX,
    height: CLOSE_HIT_AREA_PX,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.pill,
    backgroundColor: CONTROL_BACKGROUND_COLOR,
  },
});
```

`pointerEvents="box-none"` を控えの `View` に付けるのは、操作列の透明な余白が
下の `ScrollView` のスワイプを飲み込まないようにするため。閉じるボタン自身は
`box-none` の子なので押せる。

Run: `npm test -w @meshimap/mobile -- shop-photo-viewer`
Expected: PASS（9 件）

- [ ] **Step 9: わざと壊してテストが落ちることを確認する**

`photoPageIndex` の `Math.min(...)` を外し、「末尾を行き過ぎても最後のページに収まる」が
**FAIL** することを確認してから戻す。
次に `BackHandler` のハンドラの `return true` を `return false` に変え、
「Android の戻るキーで閉じ、イベントを消費する」が **FAIL** することを確認する。
さらに `useEffect` の `if (!isOpen) return undefined;` を消し、
「閉じているあいだは戻るキーを横取りしない」が **FAIL** することも確認してから戻す。
最後に `ShopMenuList` の `items.length === 0` の早期 return を消し、
「0 件なら何も描かない」が **FAIL** することを確認する。

- [ ] **Step 10: コミットする**

```bash
git add apps/mobile/src/components/shop/shop-section.tsx apps/mobile/src/components/shop/shop-section.test.tsx apps/mobile/src/components/shop/shop-menu-list.tsx apps/mobile/src/components/shop/shop-menu-list.test.tsx apps/mobile/src/lib/photo-pager.ts apps/mobile/src/lib/photo-pager.test.ts apps/mobile/src/components/shop/shop-photo-viewer.tsx apps/mobile/src/components/shop/shop-photo-viewer.test.tsx
git commit -m "feat(mobile): 店舗詳細の区画枠・メニュー一覧・写真ビューアを追加する"
```

---

### Task 6-35: レビュー一覧セクションを作る

**Files:**

- Create: `apps/mobile/src/components/review/review-list-section.tsx`
- Create: `apps/mobile/src/components/review/review-list-section.test.tsx`

**Interfaces:**

- Consumes: `@meshimap/core` の 型 `ReviewId` / `UserId`、`lucide-react-native` の `MessageSquare`、`@/components/review/review-card` の `ReviewCard`、`@/components/ui/button` の `Button`、`@/components/ui/empty-state` の `EmptyState`、`@/components/ui/error-state` の `ErrorState`、`@/components/ui/skeleton` の `Skeleton`、`@/features/reviews/schema` の 型 `Review`、`@/features/reviews/use-shop-reviews` の 型 `ShopReviewsStatus`
- Produces: `ReviewListSection` / `ReviewListSectionProps`

```ts
export interface ReviewListSectionProps {
  reviews: readonly Review[];
  totalCount: number;
  status: ShopReviewsStatus;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** ログイン中の利用者。null なら未ログイン。自分の投稿だけ編集導線を出すために使う */
  currentUserId: UserId | null;
  onLoadMore: () => void;
  onRetry: () => void;
  onPressEdit: (reviewId: ReviewId) => void;
  testID?: string | undefined;
}
```

この部品は**取得をしない**。`useShopReviews` を呼ぶのは画面側で、ここは受け取った状態を描くだけにする。
詳細画面は 1 本の `ScrollView` なので、ここで `FlatList` を使うと入れ子の
仮想リスト警告が出るうえスクロールが二重になる。素の `map` で並べる。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/components/review/review-list-section.test.tsx
import { toReviewId, toUserId } from '@meshimap/core';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { buildReview, buildReviewList } from '@/test-support/review-fixtures';

import { ReviewListSection } from './review-list-section';
import type { ReviewListSectionProps } from './review-list-section';

const OWN_USER_ID = toUserId('user-001');
const OTHER_USER_ID = toUserId('user-999');

function buildProps(overrides: Partial<ReviewListSectionProps> = {}): ReviewListSectionProps {
  return {
    reviews: buildReviewList(3),
    totalCount: 3,
    status: 'success',
    hasMore: false,
    isLoadingMore: false,
    currentUserId: null,
    onLoadMore: jest.fn(),
    onRetry: jest.fn(),
    onPressEdit: jest.fn(),
    testID: 'reviews',
    ...overrides,
  };
}

describe('ReviewListSection', () => {
  it('読み込み中はスケルトンを出す', async () => {
    await render(
      <ReviewListSection {...buildProps({ reviews: [], status: 'loading', totalCount: 0 })} />,
    );

    expect(screen.getByTestId('reviews-loading')).toBeOnTheScreen();
    expect(screen.queryByTestId('reviews-card-review-001')).toBeNull();
  });

  it('失敗したら再試行できる', async () => {
    const onRetry = jest.fn();
    await render(
      <ReviewListSection
        {...buildProps({ onRetry, reviews: [], status: 'error', totalCount: 0 })}
      />,
    );

    await fireEvent.press(screen.getByTestId('reviews-error-retry-button'));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('0 件なら最初の 1 件を促す', async () => {
    await render(
      <ReviewListSection {...buildProps({ reviews: [], status: 'empty', totalCount: 0 })} />,
    );

    expect(screen.getByTestId('reviews-empty')).toBeOnTheScreen();
  });

  it('総件数を出す', async () => {
    await render(<ReviewListSection {...buildProps({ totalCount: 128 })} />);

    expect(screen.getByTestId('reviews-count')).toHaveTextContent('128 件のレビュー');
  });

  it('レビューを並べる', async () => {
    await render(<ReviewListSection {...buildProps()} />);

    expect(screen.getByTestId('reviews-card-review-001')).toBeOnTheScreen();
    expect(screen.getByTestId('reviews-card-review-003')).toBeOnTheScreen();
  });

  it('自分の投稿にだけ編集導線を出す', async () => {
    const reviews = [
      buildReview({ id: 'review-001', userId: 'user-001' }),
      buildReview({ id: 'review-002', userId: 'user-999' }),
    ];
    await render(<ReviewListSection {...buildProps({ currentUserId: OWN_USER_ID, reviews })} />);

    expect(screen.getByTestId('reviews-card-review-001-edit')).toBeOnTheScreen();
    expect(screen.queryByTestId('reviews-card-review-002-edit')).toBeNull();
  });

  it('未ログインなら誰の投稿にも編集導線を出さない', async () => {
    const reviews = [buildReview({ id: 'review-001', userId: 'user-001' })];
    await render(<ReviewListSection {...buildProps({ currentUserId: null, reviews })} />);

    expect(screen.queryByTestId('reviews-card-review-001-edit')).toBeNull();
  });

  it('他人の ID でログインしていても自分の投稿とは判定しない', async () => {
    const reviews = [buildReview({ id: 'review-001', userId: 'user-001' })];
    await render(<ReviewListSection {...buildProps({ currentUserId: OTHER_USER_ID, reviews })} />);

    expect(screen.queryByTestId('reviews-card-review-001-edit')).toBeNull();
  });

  it('編集を押すとレビュー ID を渡す', async () => {
    const onPressEdit = jest.fn();
    const reviews = [buildReview({ id: 'review-001', userId: 'user-001' })];
    await render(
      <ReviewListSection {...buildProps({ currentUserId: OWN_USER_ID, onPressEdit, reviews })} />,
    );

    await fireEvent.press(screen.getByTestId('reviews-card-review-001-edit'));

    expect(onPressEdit).toHaveBeenCalledWith(toReviewId('review-001'));
  });

  it('続きがあるときだけ続きを読む導線を出す', async () => {
    await render(<ReviewListSection {...buildProps({ hasMore: true })} />);

    expect(screen.getByTestId('reviews-more')).toBeOnTheScreen();
  });

  it('続きが無ければ導線を出さない', async () => {
    await render(<ReviewListSection {...buildProps({ hasMore: false })} />);

    expect(screen.queryByTestId('reviews-more')).toBeNull();
  });

  it('続きを読む導線で追加取得を呼ぶ', async () => {
    const onLoadMore = jest.fn();
    await render(<ReviewListSection {...buildProps({ hasMore: true, onLoadMore })} />);

    await fireEvent.press(screen.getByTestId('reviews-more'));

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('追加取得中は導線を押せない', async () => {
    // 押せたままだと同じページを何度も取りに行き、同じレビューが二重に並ぶ
    await render(<ReviewListSection {...buildProps({ hasMore: true, isLoadingMore: true })} />);

    expect(screen.getByTestId('reviews-more')).toBeDisabled();
  });
});
```

Run: `npm test -w @meshimap/mobile -- review-list-section`
Expected: FAIL（`Cannot find module './review-list-section'`）

- [ ] **Step 2: review-list-section.tsx を実装する**

```tsx
// apps/mobile/src/components/review/review-list-section.tsx
import type { ReviewId, UserId } from '@meshimap/core';
import { MessageSquare } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { ReviewCard } from '@/components/review/review-card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import type { Review } from '@/features/reviews/schema';
import type { ShopReviewsStatus } from '@/features/reviews/use-shop-reviews';

const COUNT_SUFFIX = ' 件のレビュー';
const MORE_LABEL = 'レビューをもっと見る';
const ERROR_TITLE = 'レビューを読み込めませんでした';
const ERROR_DESCRIPTION = '通信状況を確かめて、もう一度お試しください';
const EMPTY_TITLE = 'まだレビューがありません';
const EMPTY_DESCRIPTION = '最初の 1 件を書いて、この店の良さを伝えてみませんか';

/** 読み込み中に並べるカードの枚数。区画の高さが急に変わらない程度に抑える */
const SKELETON_COUNT = 2;
const SKELETON_CARD_HEIGHT_PX = 148;

export interface ReviewListSectionProps {
  reviews: readonly Review[];
  totalCount: number;
  status: ShopReviewsStatus;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** ログイン中の利用者。null なら未ログイン。自分の投稿だけ編集導線を出すために使う */
  currentUserId: UserId | null;
  onLoadMore: () => void;
  onRetry: () => void;
  onPressEdit: (reviewId: ReviewId) => void;
  testID?: string | undefined;
}

export function ReviewListSection({
  reviews,
  totalCount,
  status,
  hasMore,
  isLoadingMore,
  currentUserId,
  onLoadMore,
  onRetry,
  onPressEdit,
  testID,
}: ReviewListSectionProps) {
  const childTestId = (suffix: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${suffix}`;

  if (status === 'loading') {
    return (
      <View className="gap-sm" testID={childTestId('loading')}>
        {Array.from({ length: SKELETON_COUNT }, (_unused, index) => (
          // 同じ高さの箱を並べるだけで差し替えも並べ替えも起きないため添字キーでよい
          <Skeleton height={SKELETON_CARD_HEIGHT_PX} key={index} />
        ))}
      </View>
    );
  }

  if (status === 'error') {
    return (
      <ErrorState
        description={ERROR_DESCRIPTION}
        onRetry={onRetry}
        testID={childTestId('error')}
        title={ERROR_TITLE}
      />
    );
  }

  if (status === 'empty') {
    return (
      <EmptyState
        description={EMPTY_DESCRIPTION}
        icon={MessageSquare}
        testID={childTestId('empty')}
        title={EMPTY_TITLE}
      />
    );
  }

  return (
    <View className="gap-md" testID={testID}>
      <Text className="font-body text-sm text-neutral-600" testID={childTestId('count')}>
        {`${totalCount}${COUNT_SUFFIX}`}
      </Text>

      {reviews.map((review) => (
        <ReviewCard
          // currentUserId が null のときに `null === null` で全件が自分の投稿になる事故を避ける
          isOwn={currentUserId !== null && review.userId === currentUserId}
          key={review.id}
          onPressEdit={onPressEdit}
          review={review}
          testID={childTestId(`card-${review.id}`)}
        />
      ))}

      {hasMore ? (
        <Button
          isDisabled={isLoadingMore}
          isLoading={isLoadingMore}
          label={MORE_LABEL}
          onPress={onLoadMore}
          testID={childTestId('more')}
          variant="outline"
        />
      ) : null}
    </View>
  );
}
```

`ReviewCard` の編集ボタンの testID は `${testID}-edit`（Task 6-27）。
ここで `card-${review.id}` を渡すので、画面からは `reviews-card-review-001-edit` で取れる。

Run: `npm test -w @meshimap/mobile -- review-list-section`
Expected: PASS（13 件）

- [ ] **Step 3: わざと壊してテストが落ちることを確認する**

`isOwn` の判定を `review.userId === currentUserId` だけにし、
「未ログインなら誰の投稿にも編集導線を出さない」が…**通ってしまう**ことを確認する
（`UserId` は `string` のブランド型なので `null` とは一致しない）。
そのうえで `isOwn` を `currentUserId === null || review.userId === currentUserId` に変え、
同じテストが **FAIL** することを確認してから戻す。これが「未ログイン時に他人の投稿を
編集できてしまう」事故の回帰テストになる。
次に `hasMore ? ... : null` を常時表示に変え、「続きが無ければ導線を出さない」が
**FAIL** することを確認する。
最後に `isDisabled={isLoadingMore}` を外し、「追加取得中は導線を押せない」が
**FAIL** することも確認してから戻す。

- [ ] **Step 4: コミットする**

```bash
git add apps/mobile/src/components/review/review-list-section.tsx apps/mobile/src/components/review/review-list-section.test.tsx
git commit -m "feat(mobile): レビュー一覧セクションを追加する"
```

---

### Task 6-36: 店舗詳細画面を組み立てる

**Files:**

- Create: `apps/mobile/src/app/(user)/shop/[shopId]/index.tsx`
- Create: `apps/mobile/src/app/(user)/shop/[shopId]/index.test.tsx`

**Interfaces:**

- Consumes: `@meshimap/core` の `identifierSchema` / `toShopId` / 型 `ReviewId` / 型 `ShopId`、`expo-router` の `router` / `useLocalSearchParams`、`react-native-reanimated` の `useSharedValue`、`@/hooks/use-now` の `useNow`、`@/features/shops/use-shop-detail` の `useShopDetail`、`@/features/reviews/use-shop-reviews` の `useShopReviews`、`@/features/favorites/use-favorite-ids` の `useFavoriteIds`、`@/features/favorites/use-toggle-favorite` の `useToggleFavorite`、`@/features/auth/use-session` の `useSession`（Phase 5）、`@/components/shop/*`、`@/components/review/review-list-section`、`@/components/ui/*`、`@/lib/query-params` の `readSingleQueryValue`
- Produces: ルート `/(user)/shop/[shopId]`（default export `ShopDetailScreen`）

画面は Task 6-31 と同じ 2 段構えにする。外側の `ShopDetailScreen` が
`useLocalSearchParams` を必ず呼んでから `shopId` を検証し、正しいときだけ
内側の `ShopDetailBody` を描く。こうしないと「不正な ID のときだけフックを呼ばない」
コードになり、フックの呼び出し順が実行ごとに変わる。

区画の並びは次の順に固定する。上から順に「今この店に行くか」を決める材料になる並びにする。

| 順  | 区画                                                     | 出す条件                             |
| --- | -------------------------------------------------------- | ------------------------------------ |
| 1   | ヒーロー（写真 + 店名）                                  | 常に                                 |
| 2   | 要約（ジャンル・エリア・営業状況・平均評価・お気に入り） | 常に                                 |
| 3   | 行動導線（予約する / レビューを書く）                    | 常に                                 |
| 4   | 紹介文                                                   | `description` が空文字でないとき     |
| 5   | 評価                                                     | 常に（0 件なら分布側が空表示を出す） |
| 6   | メニュー                                                 | `menuItems` が 1 件以上              |
| 7   | 写真                                                     | `photoUrls` が 1 枚以上              |
| 8   | 営業時間                                                 | 常に                                 |
| 9   | 店舗情報                                                 | 常に                                 |
| 10  | レビュー                                                 | 常に（0 件なら空状態）               |

- [ ] **Step 1: 失敗するテストを書く（読み込み・失敗・不正な ID）**

```tsx
// apps/mobile/src/app/(user)/shop/[shopId]/index.test.tsx
import { toShopId } from '@meshimap/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';

import { useSession } from '@/features/auth/use-session';
import { addFavorite, fetchFavoriteShopIds, removeFavorite } from '@/features/favorites/api';
import { fetchShopReviews } from '@/features/reviews/api';
import { fetchShopDetail } from '@/features/shops/api';
import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildReview, buildReviewList } from '@/test-support/review-fixtures';
import { buildShopDetail } from '@/test-support/shop-fixtures';

import ShopDetailScreen from './index';

jest.mock('@/features/shops/api', () => ({ fetchShopDetail: jest.fn() }));
jest.mock('@/features/reviews/api', () => ({ fetchShopReviews: jest.fn() }));
jest.mock('@/features/favorites/api', () => ({
  addFavorite: jest.fn(),
  fetchFavoriteShopIds: jest.fn(),
  removeFavorite: jest.fn(),
}));
jest.mock('@/features/auth/use-session', () => ({ useSession: jest.fn() }));
// useNow は setInterval で進む。詳細画面の営業状況が実時刻で揺れるとテストが日替わりで落ちる
jest.mock('@/hooks/use-now', () => ({ useNow: () => new Date('2026-09-15T12:00:00+09:00') }));
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ shopId: 'shop-001' })),
}));

const fetchShopDetailMock = jest.mocked(fetchShopDetail);
const fetchShopReviewsMock = jest.mocked(fetchShopReviews);
const fetchFavoriteShopIdsMock = jest.mocked(fetchFavoriteShopIds);
const addFavoriteMock = jest.mocked(addFavorite);
const removeFavoriteMock = jest.mocked(removeFavorite);
const useLocalSearchParamsMock = jest.mocked(useLocalSearchParams);
const useSessionMock = jest.mocked(useSession);

async function renderShopDetail(): Promise<void> {
  const queryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  }
  await render(<ShopDetailScreen />, { wrapper: Wrapper });
}

/** 本文が出そろうまで待つ。各テストの冒頭で同じ待ち方をそろえる */
async function renderLoadedShopDetail(): Promise<void> {
  await renderShopDetail();
  await waitFor(() => {
    expect(screen.getByTestId('shop-detail-summary')).toBeOnTheScreen();
  });
}

describe('ShopDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useLocalSearchParamsMock.mockReturnValue({ shopId: 'shop-001' });
    useSessionMock.mockReturnValue({ userId: null, isAuthenticated: false });
    fetchShopDetailMock.mockResolvedValue(buildShopDetail());
    fetchShopReviewsMock.mockResolvedValue({ reviews: [], nextCursor: null, totalCount: 0 });
    fetchFavoriteShopIdsMock.mockResolvedValue([]);
    addFavoriteMock.mockResolvedValue(undefined);
    removeFavoriteMock.mockResolvedValue(undefined);
  });

  it('取得中はスケルトンを出す', async () => {
    // 解決しない Promise を返して読み込み中のまま止める
    fetchShopDetailMock.mockReturnValue(new Promise(() => undefined));

    await renderShopDetail();

    expect(screen.getByTestId('shop-detail-loading')).toBeOnTheScreen();
  });

  it('取得に失敗したら再試行できる', async () => {
    fetchShopDetailMock.mockRejectedValue(new Error('network'));

    await renderShopDetail();
    await waitFor(() => {
      expect(screen.getByTestId('shop-detail-error')).toBeOnTheScreen();
    });
    await fireEvent.press(screen.getByTestId('shop-detail-error-retry-button'));

    await waitFor(() => {
      expect(fetchShopDetailMock).toHaveBeenCalledTimes(2);
    });
  });

  it('URL の shopId が不正なら取得しに行かない', async () => {
    useLocalSearchParamsMock.mockReturnValue({ shopId: '../../etc/passwd' });

    await renderShopDetail();

    expect(screen.getByTestId('shop-detail-invalid')).toBeOnTheScreen();
    expect(fetchShopDetailMock).not.toHaveBeenCalled();
  });

  it('shopId をそのまま取得関数へ渡す', async () => {
    await renderLoadedShopDetail();

    expect(fetchShopDetailMock).toHaveBeenCalledWith(toShopId('shop-001'));
  });
});
```

Run: `npm test -w @meshimap/mobile -- "shop/\[shopId\]"`
Expected: FAIL（`Cannot find module './index'`）

- [ ] **Step 2: 失敗するテストを書く（本文の区画）**

同じファイルの `describe` に続けて書く。

```tsx
it('店名・ジャンル・エリアを出す', async () => {
  await renderLoadedShopDetail();

  expect(screen.getByTestId('shop-detail-genre')).toHaveTextContent('焼き鳥');
  expect(screen.getByTestId('shop-detail-area')).toHaveTextContent('渋谷');
});

it('営業状況を出す', async () => {
  await renderLoadedShopDetail();

  expect(screen.getByTestId('shop-detail-open-status')).toBeOnTheScreen();
});

it('紹介文が空なら紹介区画を出さない', async () => {
  fetchShopDetailMock.mockResolvedValue(buildShopDetail({ description: '' }));

  await renderLoadedShopDetail();

  expect(screen.queryByTestId('shop-detail-description')).toBeNull();
});

it('評価分布を出す', async () => {
  await renderLoadedShopDetail();

  expect(screen.getByTestId('shop-detail-rating-chart')).toBeOnTheScreen();
});

it('メニューがあれば区画を出す', async () => {
  await renderLoadedShopDetail();

  expect(screen.getByTestId('shop-detail-menu')).toBeOnTheScreen();
  expect(screen.getByText('おまかせ 10 本コース')).toBeOnTheScreen();
});

it('メニューが 0 件なら区画ごと出さない', async () => {
  // 見出しだけ出て中身が空の区画は「メニューを載せていない店」より壊れて見える
  fetchShopDetailMock.mockResolvedValue(buildShopDetail({ menuItems: [] }));

  await renderLoadedShopDetail();

  expect(screen.queryByTestId('shop-detail-menu')).toBeNull();
});

it('写真が 0 枚なら区画ごと出さない', async () => {
  fetchShopDetailMock.mockResolvedValue(buildShopDetail({ photoUrls: [] }));

  await renderLoadedShopDetail();

  expect(screen.queryByTestId('shop-detail-photos')).toBeNull();
});

it('営業時間と店舗情報を出す', async () => {
  await renderLoadedShopDetail();

  expect(screen.getByTestId('shop-detail-hours-table')).toBeOnTheScreen();
  expect(screen.getByTestId('shop-detail-info-address')).toHaveTextContent(
    '東京都渋谷区渋谷 1-1-1',
  );
});
```

Run: `npm test -w @meshimap/mobile -- "shop/\[shopId\]"`
Expected: FAIL（同上）

- [ ] **Step 3: 失敗するテストを書く（写真ビューア・スクロール）**

```tsx
it('写真を押すと全画面ビューアが開く', async () => {
  await renderLoadedShopDetail();

  expect(screen.queryByTestId('shop-detail-viewer')).toBeNull();

  await fireEvent.press(screen.getByTestId('shop-detail-gallery-photo-1'));

  expect(screen.getByTestId('shop-detail-viewer')).toBeOnTheScreen();
  // 押した 2 枚目から開く
  expect(screen.getByTestId('shop-detail-viewer-counter')).toHaveTextContent('2 / 2');
});

it('全画面ビューアを閉じられる', async () => {
  await renderLoadedShopDetail();
  await fireEvent.press(screen.getByTestId('shop-detail-gallery-photo-0'));
  await fireEvent.press(screen.getByTestId('shop-detail-viewer-close'));

  expect(screen.queryByTestId('shop-detail-viewer')).toBeNull();
});

it('スクロールしても落ちず固定ヘッダーが残る', async () => {
  await renderLoadedShopDetail();

  await fireEvent.scroll(screen.getByTestId('shop-detail-scroll'), {
    nativeEvent: { contentOffset: { y: 240 } },
  });

  expect(screen.getByTestId('shop-detail-header-bar')).toBeOnTheScreen();
});

it('固定ヘッダーの戻るで前の画面へ戻る', async () => {
  await renderLoadedShopDetail();

  await fireEvent.press(screen.getByTestId('shop-detail-header-bar-back'));

  expect(router.back).toHaveBeenCalledTimes(1);
});
```

Run: `npm test -w @meshimap/mobile -- "shop/\[shopId\]"`
Expected: FAIL（同上）

- [ ] **Step 4: 失敗するテストを書く（行動導線・レビュー・お気に入り）**

```tsx
it('予約画面へ遷移できる', async () => {
  await renderLoadedShopDetail();

  await fireEvent.press(screen.getByTestId('shop-detail-reserve'));

  expect(router.push).toHaveBeenCalledWith({
    pathname: '/shop/[shopId]/reserve',
    params: { shopId: 'shop-001' },
  });
});

it('レビュー投稿画面へ遷移できる', async () => {
  await renderLoadedShopDetail();

  await fireEvent.press(screen.getByTestId('shop-detail-write-review'));

  expect(router.push).toHaveBeenCalledWith({
    pathname: '/review/new',
    params: { shopId: 'shop-001' },
  });
});

it('レビューが 0 件なら空状態を出す', async () => {
  await renderLoadedShopDetail();

  expect(screen.getByTestId('shop-detail-reviews-empty')).toBeOnTheScreen();
});

it('レビューを並べて総件数を出す', async () => {
  fetchShopReviewsMock.mockResolvedValue({
    reviews: buildReviewList(3),
    nextCursor: null,
    totalCount: 42,
  });

  await renderLoadedShopDetail();
  await waitFor(() => {
    expect(screen.getByTestId('shop-detail-reviews-count')).toHaveTextContent('42 件のレビュー');
  });
});

it('自分のレビューの編集から編集画面へ遷移できる', async () => {
  useSessionMock.mockReturnValue({ userId: toUserId('user-001'), isAuthenticated: true });
  fetchShopReviewsMock.mockResolvedValue({
    reviews: [buildReview({ id: 'review-001', userId: 'user-001' })],
    nextCursor: null,
    totalCount: 1,
  });

  await renderLoadedShopDetail();
  await waitFor(() => {
    expect(screen.getByTestId('shop-detail-reviews-card-review-001-edit')).toBeOnTheScreen();
  });
  await fireEvent.press(screen.getByTestId('shop-detail-reviews-card-review-001-edit'));

  expect(router.push).toHaveBeenCalledWith({
    pathname: '/review/[reviewId]/edit',
    params: { reviewId: 'review-001' },
  });
});

it('お気に入りを押すと登録 API を呼ぶ', async () => {
  await renderLoadedShopDetail();

  await fireEvent.press(screen.getByTestId('shop-detail-favorite'));

  await waitFor(() => {
    expect(addFavoriteMock).toHaveBeenCalledWith(toShopId('shop-001'));
  });
});

it('登録済みのお気に入りを押すと解除 API を呼ぶ', async () => {
  fetchFavoriteShopIdsMock.mockResolvedValue([toShopId('shop-001')]);

  await renderLoadedShopDetail();
  await waitFor(() => {
    expect(fetchFavoriteShopIdsMock).toHaveBeenCalled();
  });
  await fireEvent.press(screen.getByTestId('shop-detail-favorite'));

  await waitFor(() => {
    expect(removeFavoriteMock).toHaveBeenCalledWith(toShopId('shop-001'));
  });
});

it('お気に入りの切り替えに失敗したら理由を出す', async () => {
  addFavoriteMock.mockRejectedValue(new Error('network'));

  await renderLoadedShopDetail();
  await fireEvent.press(screen.getByTestId('shop-detail-favorite'));

  await waitFor(() => {
    expect(screen.getByTestId('shop-detail-favorite-error')).toHaveTextContent(
      'お気に入りを更新できませんでした',
    );
  });
});
```

テスト冒頭の import に `toUserId` を足す（`import { toShopId, toUserId } from '@meshimap/core';`）。

Run: `npm test -w @meshimap/mobile -- "shop/\[shopId\]"`
Expected: FAIL（同上）

- [ ] **Step 5: 画面を実装する（外枠と状態分岐）**

```tsx
// apps/mobile/src/app/(user)/shop/[shopId]/index.tsx
import { identifierSchema, toShopId } from '@meshimap/core';
import type { ReviewId, ShopId } from '@meshimap/core';
import { router, useLocalSearchParams } from 'expo-router';
import { CalendarCheck, SquarePen } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import { RatingDistributionChart } from '@/components/chart/rating-distribution-chart';
import { ReviewListSection } from '@/components/review/review-list-section';
import { BusinessHoursTable } from '@/components/shop/business-hours-table';
import { FavoriteButton } from '@/components/shop/favorite-button';
import { OpenStatusBadge } from '@/components/shop/open-status-badge';
import { ShopHeaderBar } from '@/components/shop/shop-header-bar';
import { ShopHeroHeader } from '@/components/shop/shop-hero-header';
import { ShopInfoList } from '@/components/shop/shop-info-list';
import { ShopMenuList } from '@/components/shop/shop-menu-list';
import { ShopPhotoGallery } from '@/components/shop/shop-photo-gallery';
import { ShopPhotoViewer } from '@/components/shop/shop-photo-viewer';
import { ShopSection } from '@/components/shop/shop-section';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { COLORS, SPACING } from '@/constants/theme';
import { useSession } from '@/features/auth/use-session';
import { useFavoriteIds } from '@/features/favorites/use-favorite-ids';
import { useToggleFavorite } from '@/features/favorites/use-toggle-favorite';
import { useShopReviews } from '@/features/reviews/use-shop-reviews';
import { useShopDetail } from '@/features/shops/use-shop-detail';
import { useNow } from '@/hooks/use-now';
import { readSingleQueryValue } from '@/lib/query-params';

const INVALID_SHOP_TITLE = '店舗が見つかりません';
const INVALID_SHOP_DESCRIPTION = 'URL が正しくありません。前の画面に戻ってやり直してください';
const ERROR_TITLE = '店舗情報を読み込めませんでした';
const ERROR_DESCRIPTION = '通信状況を確かめて、もう一度お試しください';
const RESERVE_LABEL = '予約する';
const WRITE_REVIEW_LABEL = 'レビューを書く';
const DESCRIPTION_SECTION_TITLE = 'この店について';
const RATING_SECTION_TITLE = '評価';
const MENU_SECTION_TITLE = 'メニュー';
const PHOTOS_SECTION_TITLE = '写真';
const HOURS_SECTION_TITLE = '営業時間';
const INFO_SECTION_TITLE = '店舗情報';
const REVIEWS_SECTION_TITLE = 'レビュー';
const GENRE_AREA_SEPARATOR = '・';

/** 一覧と同じ 16px 刻み。最下部は指がかぶらないよう多めに空ける */
const BOTTOM_PADDING_PX = SPACING.xxl;

/** 読み込み中に置く箱の高さ（px）。ヒーローと要約のぶん */
const SKELETON_HERO_HEIGHT_PX = 280;
const SKELETON_BODY_HEIGHT_PX = 96;

/**
 * onScroll に渡すハンドラの引数型。
 * RN の `ScrollEvent`（`NativeSyntheticEvent<NativeScrollEvent>`）を丸ごと要求すると
 * テストから `fireEvent.scroll` で組み立てられない。
 * 関数の引数は反変に判定されるので、必要な一部だけを要求するこの形でも
 * `onScroll?: ((event: ScrollEvent) => void) | undefined` に代入できる。
 */
interface ShopScrollEvent {
  readonly nativeEvent: { readonly contentOffset: { readonly y: number } };
}

export default function ShopDetailScreen() {
  // フックは早期 return より前に必ず呼ぶ
  const params = useLocalSearchParams();
  const parsedShopId = identifierSchema.safeParse(readSingleQueryValue(params.shopId));

  if (!parsedShopId.success) {
    return (
      <ErrorState
        description={INVALID_SHOP_DESCRIPTION}
        onRetry={() => {
          router.back();
        }}
        testID="shop-detail-invalid"
        title={INVALID_SHOP_TITLE}
      />
    );
  }

  return <ShopDetailBody shopId={toShopId(parsedShopId.data)} />;
}
```

- [ ] **Step 6: 画面を実装する（本体）**

```tsx
// apps/mobile/src/app/(user)/shop/[shopId]/index.tsx に続けて書く
interface ShopDetailBodyProps {
  readonly shopId: ShopId;
}

function goToReserve(shopId: ShopId): void {
  // テンプレート文字列のパスは型付きルート生成後に Href へ解決できないことがあるため
  // pathname + params の形で渡す
  router.push({ pathname: '/shop/[shopId]/reserve', params: { shopId } });
}

function goToWriteReview(shopId: ShopId): void {
  router.push({ pathname: '/review/new', params: { shopId } });
}

function goToEditReview(reviewId: ReviewId): void {
  router.push({ pathname: '/review/[reviewId]/edit', params: { reviewId } });
}

function ShopDetailBody({ shopId }: ShopDetailBodyProps) {
  // 放置していても営業状況が切り替わるよう、進む時計を使う
  const now = useNow();
  const detail = useShopDetail(shopId, now);
  const reviews = useShopReviews(shopId);
  const favoriteIds = useFavoriteIds();
  const toggleFavorite = useToggleFavorite();
  const session = useSession();

  const scrollY = useSharedValue(0);
  // null = 閉じている。開いた写真の添字をそのまま持つ
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  if (detail.status === 'loading') {
    return (
      <View className="flex-1 gap-md bg-neutral-50" testID="shop-detail-loading">
        <Skeleton height={SKELETON_HERO_HEIGHT_PX} />
        <View className="gap-sm px-md">
          <Skeleton height={SKELETON_BODY_HEIGHT_PX} />
          <Skeleton height={SKELETON_BODY_HEIGHT_PX} />
        </View>
      </View>
    );
  }

  if (detail.status === 'error' || detail.shop === null) {
    return (
      <ErrorState
        description={ERROR_DESCRIPTION}
        onRetry={detail.refetch}
        testID="shop-detail-error"
        title={ERROR_TITLE}
      />
    );
  }

  const { shop } = detail;

  return (
    <View className="flex-1 bg-neutral-50">
      <ScrollView
        contentContainerStyle={{ paddingBottom: BOTTOM_PADDING_PX }}
        onScroll={(event: ShopScrollEvent) => {
          // useAnimatedScrollHandler はモックが NOOP_FACTORY でテストから駆動できないため、
          // JS 側のハンドラで SharedValue を書く
          scrollY.value = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={SCROLL_EVENT_THROTTLE_MS}
        testID="shop-detail-scroll"
      >
        <ShopHeroHeader
          photoUrl={shop.coverPhotoUrl}
          scrollY={scrollY}
          testID="shop-detail-hero"
          title={shop.name}
        />

        <View className="gap-sm bg-white p-md" testID="shop-detail-summary">
          <View className="flex-row items-center justify-between gap-sm">
            <Text className="font-body text-sm text-neutral-600">
              <Text testID="shop-detail-genre">{shop.genreName}</Text>
              {GENRE_AREA_SEPARATOR}
              <Text testID="shop-detail-area">{shop.areaName}</Text>
            </Text>
            <FavoriteButton
              isFavorite={favoriteIds.isFavorite(shop.id)}
              isPending={toggleFavorite.isPending}
              onToggle={toggleFavorite.toggle}
              shopId={shop.id}
              testID="shop-detail-favorite"
            />
          </View>

          {detail.openStatus === null ? null : (
            <View className="flex-row">
              <OpenStatusBadge
                closesInMinutes={detail.closesInMinutes}
                status={detail.openStatus}
                testID="shop-detail-open-status"
              />
            </View>
          )}

          {toggleFavorite.errorMessage === null ? null : (
            <Text
              accessibilityRole="alert"
              className="font-body text-sm"
              style={{ color: COLORS.red[700] }}
              testID="shop-detail-favorite-error"
            >
              {toggleFavorite.errorMessage}
            </Text>
          )}

          <View className="flex-row gap-sm">
            <View className="flex-1">
              <Button
                label={RESERVE_LABEL}
                leadingIcon={<CalendarCheck color={COLORS.white} size={ACTION_ICON_PIXEL_SIZE} />}
                onPress={() => {
                  goToReserve(shop.id);
                }}
                testID="shop-detail-reserve"
                variant="primary"
              />
            </View>
            <View className="flex-1">
              <Button
                label={WRITE_REVIEW_LABEL}
                leadingIcon={
                  <SquarePen color={COLORS.neutral[800]} size={ACTION_ICON_PIXEL_SIZE} />
                }
                onPress={() => {
                  goToWriteReview(shop.id);
                }}
                testID="shop-detail-write-review"
                variant="outline"
              />
            </View>
          </View>
        </View>

        {shop.description === '' ? null : (
          <ShopSection testID="shop-detail-description" title={DESCRIPTION_SECTION_TITLE}>
            <Text className="font-body text-base leading-relaxed text-neutral-800">
              {shop.description}
            </Text>
          </ShopSection>
        )}

        <ShopSection testID="shop-detail-rating" title={RATING_SECTION_TITLE}>
          <RatingDistributionChart
            average={shop.ratingAverage}
            distribution={shop.ratingDistribution}
            testID="shop-detail-rating-chart"
          />
        </ShopSection>

        {shop.menuItems.length === 0 ? null : (
          <ShopSection testID="shop-detail-menu" title={MENU_SECTION_TITLE}>
            <ShopMenuList items={shop.menuItems} testID="shop-detail-menu-list" />
          </ShopSection>
        )}

        {shop.photoUrls.length === 0 ? null : (
          <ShopSection testID="shop-detail-photos" title={PHOTOS_SECTION_TITLE}>
            <ShopPhotoGallery
              onPressPhoto={setViewerIndex}
              photoUrls={shop.photoUrls}
              testID="shop-detail-gallery"
            />
          </ShopSection>
        )}

        <ShopSection testID="shop-detail-hours" title={HOURS_SECTION_TITLE}>
          <BusinessHoursTable
            closures={shop.closures}
            hours={shop.hours}
            now={now}
            testID="shop-detail-hours-table"
          />
        </ShopSection>

        <ShopSection testID="shop-detail-info-section" title={INFO_SECTION_TITLE}>
          <ShopInfoList shop={shop} testID="shop-detail-info" />
        </ShopSection>

        <ShopSection testID="shop-detail-reviews-section" title={REVIEWS_SECTION_TITLE}>
          <ReviewListSection
            currentUserId={session.userId}
            hasMore={reviews.hasMore}
            isLoadingMore={reviews.isLoadingMore}
            onLoadMore={reviews.loadMore}
            onPressEdit={goToEditReview}
            onRetry={reviews.refetch}
            reviews={reviews.reviews}
            status={reviews.status}
            testID="shop-detail-reviews"
            totalCount={reviews.totalCount}
          />
        </ShopSection>
      </ScrollView>

      <ShopHeaderBar
        onBack={() => {
          router.back();
        }}
        scrollY={scrollY}
        testID="shop-detail-header-bar"
        title={shop.name}
      />

      <ShopPhotoViewer
        initialIndex={viewerIndex}
        onClose={() => {
          setViewerIndex(null);
        }}
        photoUrls={shop.photoUrls}
        testID="shop-detail-viewer"
      />
    </View>
  );
}
```

ファイル冒頭の定数に次の 2 つを足す。

```tsx
/** 行動導線ボタンのアイコン寸法（px）。Icon プリミティブの md と同値 */
const ACTION_ICON_PIXEL_SIZE = 20;

/**
 * スクロールイベントの間引き間隔（ms）。
 * ヒーローの縮小に使うだけなので 16ms（毎フレーム）は要らない。
 * 32ms でも見た目の追従は崩れず、JS スレッドの負荷が半分になる。
 */
const SCROLL_EVENT_THROTTLE_MS = 32;
```

区画と中身の `testID` は必ずずらす（`shop-detail-info-section` と `shop-detail-info`）。
`ShopSection` も `ShopInfoList` も根に `testID` を付けた `View` を出すので、同じ値にすると
`getByTestId` が「複数見つかった」で落ちる。住所は `ShopInfoList` の子なので
`shop-detail-info-address` で一意に取れる。

`FavoriteButton` の `onToggle` に `toggleFavorite.toggle` をそのまま渡せるのは、
`toggle: (shopId: ShopId) => void` と `onToggle: (shopId: ShopId) => void` が同じ形だから。
ラムダで包むと毎回新しい関数になり、`FavoriteButton` を将来 `memo` 化したときに効かなくなる。

Run: `npm test -w @meshimap/mobile -- "shop/\[shopId\]"`
Expected: PASS（24 件 = Step 1 の 4 件 + Step 2 の 8 件 + Step 3 の 4 件 + Step 4 の 8 件）

- [ ] **Step 7: わざと壊してテストが落ちることを確認する**

`detail.status === 'error' || detail.shop === null` の右辺（`detail.shop === null`）を消し、
`fetchShopDetail` が `null` 相当を返す経路で `shop.name` が例外になることを確認する
（`buildShopDetail` は必ず値を返すので、この確認は `fetchShopDetailMock.mockResolvedValue(null as never)`
を一時的に足して行い、確認後にテストごと戻す）。
次に `shop.menuItems.length === 0 ? null :` を外し、「メニューが 0 件なら区画ごと出さない」が
**FAIL** することを確認する。
次に `onScroll` のハンドラを削り、「スクロールしても落ちず固定ヘッダーが残る」は通るが
ヒーローが縮まなくなることを手元の実機/シミュレータで確認する（テストでは検出できない差分なので、
`shop-hero-header.test.tsx` 側の `SharedValue` 駆動テストが回帰の担保になる）。
最後に `ShopPhotoGallery` の `onPressPhoto={setViewerIndex}` を `onPressPhoto={() => setViewerIndex(0)}`
に変え、「写真を押すと全画面ビューアが開く」の `2 / 2` の検証が **FAIL** することを確認してから戻す。

- [ ] **Step 8: コミットする**

```bash
git add "apps/mobile/src/app/(user)/shop/[shopId]/index.tsx" "apps/mobile/src/app/(user)/shop/[shopId]/index.test.tsx"
git commit -m "feat(mobile): 店舗詳細画面を追加する"
```

---

### Task 6-37: Phase 6 の画面が Metro の blockList 担保下に入っていることを確認し、フェーズ全体を検証する

**Files:**

- Modify: `apps/mobile/src/lib/metro-config.test.ts`
- Modify: `apps/mobile/jest.config.js`

**Interfaces:**

- Consumes: 本フェーズで作った全ファイル
- Produces: Route Group / 動的セグメントを含む `src/app` 配下まで blockList の担保が届いていることを固定したテスト / `src/app/**` をカバレッジ対象に含めた 100% 閾値

**画面テストは移動しない（実ファイルで確認した事実）**

「`expo-router` が `src/app/**/*.test.tsx` をルートとして拾ってしまうので画面テストを `src/app` の外へ出す」
という対処は **このリポジトリでは不要**である。Phase 0 で作った `apps/mobile/metro.config.js` が既に塞いでいる。

```js
const TEST_FILE_PATTERN = /\.(test|spec)\.[jt]sx?$/;

config.resolver.blockList = [...config.resolver.blockList, TEST_FILE_PATTERN];
```

`node_modules/expo-router/_ctx.ios.js` の `require.context` 正規表現が `+api` / `+html` / `+middleware`
しか除外しないのは事実だが、その正規表現が評価される前にファイルが消えている。
Metro の実ソースを辿ると経路は次のとおり。

| #   | 場所                                                                                                | 起きること                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `metro/src/node-haste/DependencyGraph/createFileMap.js` の `getIgnorePattern`                       | `config.resolver.blockList` の各要素を括弧で包んで 1 本の正規表現に連結し、`metro-file-map` の `ignorePattern` として渡す      |
| 2   | `metro-file-map/src/index.js` の `ignoreForCrawl`（339〜360 行付近）                                | `ignorePattern.test(filePath)` に当たったパスはクロール対象から外れ、file map に載らない                                       |
| 3   | `metro-file-map/src/crawlers/node/index.js` の `find`（`entries.forEach` 内の `if (ignore(file))`） | 判定は**ディレクトリにも適用**される。当たったディレクトリは配下ごと辿られない                                                 |
| 4   | `metro-file-map/src/lib/TreeFS.js` の `matchFiles`（213 行〜）                                      | `require.context` のファイル列挙は file map の中だけを走査し、`filter`（expo-router の正規表現）は**その中から**選ぶだけである |
| 5   | `metro/src/node-haste/DependencyGraph` の `matchFilesWithContext`                                   | 4 をそのまま呼ぶ                                                                                                               |

つまり blockList で外したファイルは `require.context` の**候補にすら上がらない**。
Jest は Metro を経由しないのでテストの実行には影響しない。
この担保は `apps/mobile/src/lib/metro-config.test.ts` の 4 本が守っている。

| 既存テスト                                            | 守っているもの                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/app 配下にテストファイルが存在する`              | 検査対象が 0 件になって下の 2 本が自明に通るのを防ぐ                                  |
| `src/app 配下のテストファイルは全て除外される`        | 共置きしたテストが本番バンドルへ混入しない                                            |
| `src/app 配下の画面ファイルは 1 つも除外されない`     | blockList が行き過ぎて画面を巻き込まない                                              |
| `blockList の正規表現は flags が揃っていて連結できる` | Metro の連結時 `Cannot combine blockList patterns` で `expo start` だけが死ぬのを防ぐ |

よって **このリポジトリの方針は「テストは実装の隣に共置きする」で、`src/app/` 配下もその例外にしない**。
Task 6-31 / 6-33 / 6-34 / 6-36 が作った `src/app/**/*.test.tsx` はそのまま置く。

**このタスクで足りないもの**

3 本目「画面ファイルは 1 つも除外されない」は、**検査対象に Route Group と動的セグメントが
1 つも入っていなければ自明に通る**。Phase 6 より前の `src/app` は `_dev/` と `_layout.tsx` と
`index.tsx` しか無く、括弧付き・角括弧付きのパスが存在しなかった。
Phase 6 で `(user)` / `(tabs)` / `[shopId]` が初めて入るので、ここで前提テストを足して固定する。

これが空論でない理由は、blockList のパターンを「実在パスをそのまま正規表現に書く」作り方で
足したときに何が起きるかを見れば分かる（`node -e` で実測した結果）。

```
/src\/app\/(user)\/(tabs)\/legacy\.tsx/ に対して
  '/x/src/app/(user)/(tabs)/legacy.tsx'  → false  ← 外したい本人に当たらない
  '/x/src/app/user/tabs/legacy.tsx'      → true   ← 無関係なパスに当たる

/src\/app\/shop\/[shopId]\/legacy\.tsx/ に対して
  '/x/src/app/shop/[shopId]/legacy.tsx'  → false
  '/x/src/app/shop/s/legacy.tsx'         → true   ← [shopId] が文字クラスに化けている
```

`(user)` はキャプチャグループ、`[shopId]` は文字クラスとして解釈されるため、
**狙った画面は外れないまま、無関係な画面だけが静かに消える**。
`metro-config` の `exclusionList()` は**文字列**で渡した場合のみ
`[-[]{}()*+?.\^$|]` をエスケープする（`metro-config/src/defaults/exclusionList.js` の `escapeRegExp`）。
正規表現で渡すと `/` を path.sep に置換するだけでエスケープしないので、この事故は正規表現で足したときに起きる。

なお、このタスクで足す 3 本は現状の blockList では最初から緑になる（担保そのものは Phase 0 で入っている）。
赤を先に作れないので、Step 5 の意図的破壊で「空振りしていないこと」を示す。

- [ ] **Step 1: 今の担保が効いていることを確認する**

Run: `npm test -w @meshimap/mobile -- metro-config`
Expected: PASS（4 件。`Test Suites: 1 passed`）

- [ ] **Step 2: Phase 6 で増えた `src/app` 配下が検査対象に入っていることを一覧で見る**

`metro.config.js` を直接読み込み、`src/app` 配下の全エントリ（ファイルとディレクトリ）を
blockList に掛けて印字する。テストを書く前に、目で見て対象が増えていることを確かめる。

```bash
cd apps/mobile
node -e "
const { readdirSync } = require('node:fs');
const { join, relative, resolve } = require('node:path');
const blockList = require('./metro.config.js').resolver.blockList;
const appDir = resolve('src', 'app');
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    return entry.isDirectory() ? [entryPath, ...walk(entryPath)] : [entryPath];
  });
for (const entryPath of walk(appDir)) {
  const hit = blockList.findIndex((pattern) => pattern.test(entryPath));
  console.log((hit === -1 ? 'keep   ' : 'block#' + hit + ' '), relative(appDir, entryPath));
}
"
```

Expected: 次の 3 つがすべて満たされること。

- `(user)` / `(user)/(tabs)` / `(user)/shop/[shopId]` の**ディレクトリ行が `keep`** である
- `(user)/(tabs)/map.tsx` / `search.tsx` / `saved.tsx` / `(user)/review/new.tsx` /
  `(user)/shop/[shopId]/index.tsx` が `keep` である
- 同じ場所の `*.test.tsx` がすべて `block#2`（`#2` が `TEST_FILE_PATTERN`）である

参考: Phase 6 着手前の同じコマンドの出力は次のとおりで、括弧付きのパスが 1 つも無い。

```
keep    _dev
block#2  _dev/catalog.test.tsx
keep    _dev/catalog.tsx
keep    _layout.tsx
keep    index.tsx
```

- [ ] **Step 3: `metro-config.test.ts` に 3 本足す**

`apps/mobile/src/lib/metro-config.test.ts` の `SOURCE_FILE_SUFFIX` の下に定数を 2 つ、
`collectSourceFiles` の下にヘルパーを 1 つ足す。

```ts
/** `(user)` のような Route Group セグメント。パス区切りに挟まれた括弧付きの 1 階層を表す */
const ROUTE_GROUP_SEGMENT = /[/\\]\([^/\\]+\)[/\\]/;

/** `[shopId]` のような動的セグメント */
const DYNAMIC_SEGMENT = /[/\\]\[[^/\\]+\][/\\]/;
```

```ts
/**
 * ディレクトリを再帰的に辿り、ディレクトリの絶対パスだけを返す。
 *
 * Metro の node crawler は blockList の判定をディレクトリにも掛け、当たったディレクトリは
 * 配下ごと辿らない（metro-file-map/src/crawlers/node/index.js の `find` にある
 * `if (ignore(file)) return;` は `entry.isDirectory()` の判定より前にある）。
 * ファイル単位の検査だけでは、`(user)` ごと消えた場合に「除外された画面ファイル」が
 * 0 件のまま通ってしまうため、ディレクトリも別に集める。
 */
function collectDirectories(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }
    const entryPath = join(directory, entry.name);
    return [entryPath, ...collectDirectories(entryPath)];
  });
}
```

`describe('Metro の blockList', ...)` の中、既存の 4 本目の下に次の 3 本を足す。

```ts
/**
 * Route Group（`(user)`）と動的セグメント（`[shopId]`）はディレクトリ名に正規表現のメタ文字を含む。
 * blockList のパターンを「実在パスをそのまま正規表現に書く」作り方で足すと、
 * `(user)` はキャプチャグループ、`[shopId]` は文字クラスとして解釈され、
 * 狙った画面は外れないまま無関係な画面だけが静かに消える。
 * 上の「画面ファイルは 1 つも除外されない」がその事故を捕まえるには、
 * そもそも括弧付き・角括弧付きのパスが検査対象に入っている必要がある。
 * Phase 6 より前の src/app には 1 つも無かったので、前提そのものをここで固定する。
 */
it('src/app 配下に Route Group と動的セグメントを含む画面ファイルが存在する', () => {
  const routeGroupFiles = implementationFiles.filter((filePath) =>
    ROUTE_GROUP_SEGMENT.test(filePath),
  );
  const dynamicSegmentFiles = implementationFiles.filter((filePath) =>
    DYNAMIC_SEGMENT.test(filePath),
  );

  expect(routeGroupFiles.length).toBeGreaterThan(0);
  expect(dynamicSegmentFiles.length).toBeGreaterThan(0);
});

/**
 * `(test)` や `(spec)` という名前の Route Group を将来作っても TEST_FILE_PATTERN には当たらない。
 * 同パターンは `.test.` / `.spec.` と前後のドットまで含む綴りを要求するためである。
 * 実ファイルの有無に左右されずに境界を固定したいので、架空のパスで検査する。
 */
it('括弧を含むディレクトリ名の画面ファイルは除外されない', () => {
  const samplePaths = [
    join(APP_DIR, '(test)', 'index.tsx'),
    join(APP_DIR, '(spec)', 'index.tsx'),
    join(APP_DIR, '(user)', '(tabs)', 'map.tsx'),
    join(APP_DIR, '(user)', 'shop', '[shopId]', 'index.tsx'),
  ];

  expect(samplePaths.filter(isBlockedByMetro)).toEqual([]);
});

/**
 * ディレクトリが 1 つでも blockList に当たると、その配下の画面が丸ごと file map から消え、
 * expo-router の require.context がルートを 1 本も見つけられなくなる。
 * ファイル単位の検査は `$` 終端のパターンがディレクトリだけに当たった場合を見逃すので、別に張る。
 */
it('blockList は src/app 配下のディレクトリを 1 つも除外しない', () => {
  const blockedDirectories = collectDirectories(APP_DIR).filter(isBlockedByMetro);

  expect(blockedDirectories).toEqual([]);
});
```

- [ ] **Step 4: 7 本すべて通ることを確認する**

Run: `npm test -w @meshimap/mobile -- metro-config`
Expected: PASS（7 件 = 既存 4 件 + 追加 3 件）

- [ ] **Step 5: わざと壊して、足した 3 本が空振りでないことを確認する**

`apps/mobile/metro.config.js` を 1 つずつ書き換え、毎回 `npm test -w @meshimap/mobile -- metro-config`
を回して落ちるテストを突き合わせる。**確認できたら必ず元に戻す**（次の破壊を入れる前に戻す）。

| #   | 壊し方                                                                                                    | 期待する結果                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A   | `config.resolver.blockList = [...config.resolver.blockList, TEST_FILE_PATTERN];` の行をコメントアウトする | 6 passed / **1 failed**。落ちるのは「テストファイルは全て除外される」のみ                                                        |
| B1  | 末尾に `/src\/app\/(user)\/(tabs)\/map\.tsx$/` を足す（括弧をエスケープしない）                           | **7 passed / 0 failed**。括弧がグループに化けて実パスに当たらず、何も起きないことの実演                                          |
| B2  | 末尾に `/src\/app\/\(user\)\/\(tabs\)\/map\.tsx$/` を足す（括弧をエスケープする）                         | 5 passed / **2 failed**。「画面ファイルは 1 つも除外されない」と「括弧を含むディレクトリ名の画面ファイルは除外されない」が落ちる |
| C   | 末尾に `/src\/app\/\(user\)$/` を足す（ディレクトリだけに当たる）                                         | 6 passed / **1 failed**。落ちるのは「ディレクトリを 1 つも除外しない」のみ。ファイル単位の 3 本目は通ってしまう                  |
| D   | 末尾に `/\.bak$/i` を足す（flags だけ違う）                                                               | 6 passed / **1 failed**。落ちるのは「flags が揃っていて連結できる」のみ                                                          |

B1 と B2 の差が、このタスクで前提テストを足す理由そのものである。
B1 は「書いたのに効いていない」状態で、テストも `expo start` も何も言わない。
C は「ファイル単位のテストだけでは足りない」ことの証明で、ここでディレクトリ用の 1 本が意味を持つ。

A の期待値の内訳（A を入れると blockList は Expo の既定 2 本だけになる）:

- 「テストファイルが存在する」は fs を見るだけなので通る
- 「テストファイルは全て除外される」は落ちる。Expo の既定 1 本目は `/__tests__/` 配下しか外さず、
  `src/app/(user)/(tabs)/map.test.tsx` は `__tests__` ディレクトリに入っていない
- 「画面ファイルは 1 つも除外されない」「ディレクトリを 1 つも除外しない」「括弧を含む〜」は通る
- 「flags が揃っている」は既定 2 本とも flags が空なので通る

- [ ] **Step 6: 画面をカバレッジ対象に入れる**

`apps/mobile/jest.config.js` の `collectCoverageFrom` から `'!src/app/**'` を外す。
コメントも現状に合わせて書き換える。

```js
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}'],
  // packages/core・packages/geo の vitest.config.ts と同じ思想で 100% を要求する。
  // Phase 6 で画面が入ったため src/app/ の除外を外した。
  // 閾値を下げる方向の変更は行わない（下げる余地を作ると、埋め戻す機会は二度と来ない）。
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
```

Run: `npm test -w @meshimap/mobile -- --coverage`
Expected: PASS（`All files` の 4 指標がすべて 100%）

100% に届かない行が出た場合、閾値を下げるのではなくテストを足して埋める。
埋めにくい行の典型と対処は次の 3 つ。

| 埋まらない箇所                       | 原因                         | 対処                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_layout.tsx` の `SplashScreen` 周り | 実機でしか通らない副作用     | 分岐をフックへ切り出し、フック単体をテストする                                                                                                                                                                                                                                       |
| `Platform.OS === 'ios'` の片側       | Jest では常に `'ios'` になる | `preset: 'jest-expo'` は単一プロジェクトなので `--selectProjects` は使えない（`jest-expo/jest-preset.js` に `projects` が無い。`projects` を持つのは `jest-expo/universal`）。分岐を画面に書かず、`Platform.select` の結果を `src/constants/` の定数へ切り出してその定数をテストする |
| `catch` 節                           | 例外を起こす経路が無い       | モックを `mockRejectedValue` にして通す                                                                                                                                                                                                                                              |

- [ ] **Step 7: 型と lint を通す**

Run:

```bash
npm run typecheck -w @meshimap/mobile
npm run lint -w @meshimap/mobile
npm run format:check
```

Expected: 3 つとも終了コード 0。

`verbatimModuleSyntax` が有効なので、型だけを使う import はすべて
`import type { ... }` でなければ落ちる。`exactOptionalPropertyTypes` が有効なので、
省略可能な props は `?: T | undefined` と書いていなければ、`undefined` を渡す側で落ちる。

- [ ] **Step 8: 3 状態（読み込み / 空 / 失敗）の網羅を確認する**

各画面が 3 状態を持ち、それぞれにテストがあることを表で突き合わせる。
テストは画面と共置きなので、`src/app` を 1 回見れば実装側とテスト側の両方が引っかかる。

```bash
cd apps/mobile
grep -rn "map-loading\|map-empty\|map-error" src/app
grep -rn "search-skeleton\|search-empty\|search-error\|search-idle" src/app
grep -rn "saved-loading\|saved-empty\|saved-error" src/app
grep -rn "shop-detail-loading\|shop-detail-error\|shop-detail-invalid" src/app
grep -rn "reviews-loading\|reviews-empty\|reviews-error" src/components/review
grep -rn "review-new-invalid\|review-submit-error" src/app
```

| 画面                      | 読み込み                         | 空                                                               | 失敗                                                              |
| ------------------------- | -------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| 地図 `(tabs)/map`         | `map-loading`                    | `map-empty`                                                      | `map-error`                                                       |
| 検索 `(tabs)/search`      | `search-skeleton`                | `search-empty`（未入力は `search-idle`）                         | `search-error`                                                    |
| 保存 `(tabs)/saved`       | `saved-loading`                  | `saved-empty`                                                    | `saved-error`                                                     |
| 店舗詳細 `shop/[shopId]`  | `shop-detail-loading`            | 該当なし（詳細は空にならない。不正 ID は `shop-detail-invalid`） | `shop-detail-error`                                               |
| 詳細内レビュー            | `reviews-loading`                | `reviews-empty`                                                  | `reviews-error`                                                   |
| レビュー投稿 `review/new` | 送信中は `Button` の `isLoading` | 該当なし（入力画面）                                             | 不正 ID は `review-new-invalid`、送信失敗は `review-submit-error` |

Expected: 表の testID が、各行に対応する grep の出力で実装側とテスト側の両方に現れる。

詳細内レビューの 3 状態は `ReviewListSection` が持つので、検査するのは
`src/components/review/review-list-section.test.tsx` 側（`testID="reviews"` を渡している）。
画面側は `testID="shop-detail-reviews"` を渡すだけで、`shop-detail-reviews-loading` のような
文字列はソースにもテストにも現れない（実行時に組み立てられる）。

- [ ] **Step 9: react-native-maps のモックが効いていることを確認する**

Run:

```bash
cd apps/mobile
grep -rn "react-native-maps" jest-setup.ts src/test-support "src/app/(user)/(tabs)/map.test.tsx"
npm test -w @meshimap/mobile -- map
```

Expected:

- `src/test-support/react-native-maps-mock.tsx` が存在し、`jest.mock('react-native-maps', ...)` から参照されている
- 地図画面のテストが `mapViewCalls` の中身（`onRegionChangeComplete` に渡した region）で
  検証しており、実際の `MapView`（ネイティブモジュール）を読み込んでいない
- テスト実行中に `Invariant Violation: requireNativeComponent: "AIRMap" was not found` が出ない

- [ ] **Step 10: 実機 / シミュレータで手で確かめる**

自動テストでは検出できない項目だけを、開発ビルドで確認する。
起動時に `expo-router` がルートを 1 本も取りこぼしていないこと（タブと詳細が開けること）も、
ここで初めて実地に確認できる。

```bash
npm run mobile
```

- [ ] 位置情報を「許可しない」で起動し、東京駅が初期位置になり、`location-fallback-notice` が出る
- [ ] 地図をドラッグすると「このエリアを再検索」が出て、押すと件数が変わる
- [ ] ピンチで縮小するとクラスタに統合され、クラスタを押すと寄る
- [ ] 単独マーカーを押すとボトムシートが half まで上がる
- [ ] ボトムシートを 3 段（peek / half / full）動かせる
- [ ] 店舗詳細でスクロールするとヒーローが縮み、固定ヘッダーの店名が現れる
- [ ] 写真サムネイルを押すと全画面になり、横スワイプで枚数表示が変わる
- [ ] Android の戻るキーで全画面ビューアだけが閉じる（詳細画面には戻らない）
- [ ] ハートを押した瞬間に色が変わる（通信の完了を待たない）
- [ ] 機内モードにしてハートを押すと色が元に戻り、理由が出る
- [ ] レビュー投稿で写真を選び、投稿後に一覧の先頭へ現れる
- [ ] 起動時のログに `describe is not defined` が出ない（共置きしたテストが混入していない証拠）

- [ ] **Step 11: コミットする**

```bash
git add apps/mobile/jest.config.js apps/mobile/src/lib/metro-config.test.ts
git commit -m "test(mobile): Route Group を含む src/app が blockList 担保下にあることを固定し、カバレッジ対象に入れる"
```

---

## Phase 6 完了条件

- [ ] Task 6-1 〜 6-37 のチェックボックスがすべて埋まっている
- [ ] `npm test -w @meshimap/mobile` が PASS（1 件も skip が無い）
- [ ] `npm test -w @meshimap/mobile -- --coverage` が statements / branches / functions / lines すべて 100%
- [ ] `npm run typecheck -w @meshimap/mobile` が終了コード 0
- [ ] `npm run lint -w @meshimap/mobile` が終了コード 0
- [ ] `npm run format:check` が終了コード 0
- [ ] `npm test -w @meshimap/mobile -- metro-config` が PASS（7 件）
- [ ] `src/app/` 配下のテストは画面と共置きのまま、`metro.config.js` の blockList で全て除外されている
- [ ] Route Group `(user)` / `(tabs)` と動的セグメント `[shopId]` のディレクトリ・画面ファイルが 1 つも除外されていない
- [ ] 地図 / 検索 / 保存 / 店舗詳細の 4 画面で、読み込み・空・失敗の 3 状態にテストがある
- [ ] 位置情報を拒否しても落ちず、代替の初期位置で地図が出る
- [ ] お気に入りの楽観更新が、失敗時に押す前の状態へ戻る（`use-toggle-favorite.test.tsx`）
- [ ] 「このエリアを再検索」が、しきい値未満の移動では出ない（`use-search-this-area.test.ts`）
- [ ] 地図の領域変更 → bbox → クラスタリングの連鎖にテストがある（`map-region` / `shop-cluster` / `use-nearby-shops`）
- [ ] `react-native-maps` を実体ではなく `src/test-support/react-native-maps-mock.tsx` で差し替えている
- [ ] Task 6-37 Step 10 の手動確認 12 項目がすべて済んでいる

---

## 未確認事項

計画時点で裏取りしきれなかった点をすべて挙げる。実装着手時にここから潰す。

### 1. 他フェーズの契約に関する仮定（Phase 3 / 4 / 5 と突き合わせること）

| #    | 仮定                                                                                       | 影響                                                           |
| ---- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 1-1  | `@/lib/api-client` の `apiFetch(path, { method, searchParams, body })` という形            | 全 API 呼び出し                                                |
| 1-2  | `apiFetch` が `FormData` の body を素通しし、`Content-Type: application/json` を強制しない | `uploadReviewPhoto` が壊れる                                   |
| 1-3  | `ShopSummary.openStatus` をサーバが算出して返す                                            | 一覧の営業バッジ                                               |
| 1-4  | `openNow` フィルタをサーバ側で絞る                                                         | 検索結果の件数                                                 |
| 1-5  | `GET /shops/search` が `{ shops, nextCursor, totalCount }` を返す                          | 検索のページング                                               |
| 1-6  | `GET /shops/:shopId/reviews` が `{ reviews, nextCursor, totalCount }` を返す               | レビューのページング                                           |
| 1-7  | `GET /favorites/ids` が `{ shopIds }`、`GET /favorites` が `{ shops }` を返す              | お気に入り                                                     |
| 1-8  | `PUT /favorites/:shopId` / `DELETE /favorites/:shopId` で登録・解除する                    | お気に入り（ロードマップは `POST` 表記。どちらかに寄せること） |
| 1-9  | `POST /uploads/review-photos`（multipart、フィールド名 `file`）が `{ url }` を返す         | レビュー写真                                                   |
| 1-10 | `ShopDetail` に `menuItems` が含まれる                                                     | メニュー区画                                                   |
| 1-11 | Phase 5 の `useSession(): { userId: UserId \| null; isAuthenticated: boolean }`            | 自分のレビュー判定                                             |
| 1-12 | Phase 7 の `src/app/(user)/shop/[shopId]/reserve.tsx` が存在する                           | 型付きルートが通らないと予約導線がコンパイルできない           |
| 1-13 | `src/app/(user)/review/[reviewId]/edit.tsx`（ロードマップ 6-21 後半）が存在する            | 同上。本計画書では作らない                                     |

### 2. expo-router に関する未確認・要検証

| #   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2-1 | **`src/app/**/*.test.tsx` はルートにならない**。`apps/mobile/metro.config.js` の blockList（`/\.(test\|spec)\.[jt]sx?$/`）が Metro の file map から外すため、`require.context` の候補にすら上がらない。経路は `createFileMap.js` の `getIgnorePattern` → `metro-file-map` の `ignorePattern` → `TreeFS.matchFiles` で、Metro の実ソースで確認済み。`_ctx.ios.js` の正規表現が `.test.tsx` を除外しないのは事実だが、その評価より前にファイルが消えている。担保は `apps/mobile/src/lib/metro-config.test.ts`（Task 6-37 で 4 本 → 7 本）。残る未確認は **開発ビルドを起動しての実地確認だけ**で、Task 6-37 Step 10 で潰す |
| 2-2 | `router.setParams` の引数型が `Record<string, string>` を受けるかどうか（typedRoutes 生成後の型で要確認）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2-3 | `router.push('/shop/${shopId}')` のテンプレートリテラルが `Href` に解決されるか。解決できない前提で `{ pathname, params }` 形式に統一済み                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2-4 | `expo-router` の `Tabs` は `@deprecated` で `expo-router/js-tabs` を指すが、57.0.21 にそのパスは存在しない。タブレイアウトは Phase 5 の担当なので本計画書では触れていない                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2-5 | `apps/mobile/expo-env.d.ts` と `apps/mobile/.expo/types/` が未生成。`tsconfig.json` の `include` に書かれているが実体が無い。`npx expo customize tsconfig.json` 相当の生成が要る可能性がある                                                                                                                                                                                                                                                                                                                                                                                                                             |

### 3. ライブラリの挙動で未検証のもの

| #   | 内容                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3-1 | `react-native-svg` の要素に付けた `testID` が jest-expo で描画ツリーに出るか。`RectProps.testID` は `string`（`\| undefined` が無い）ため、`exactOptionalPropertyTypes` 下で `string \| undefined` を渡すと落ちる。チャートは `testID` を SVG のルートにだけ付ける設計にして回避している |
| 3-2 | `BottomSheetFlatList` の `ref` 型が、公式モックの素の `FlatList` と互換かどうか。`ref` を使う実装にはしていない                                                                                                                                                                          |
| 3-3 | `zodResolver(reviewFormSchema)` と `useForm<ReviewFormFields>` の型互換。`.d.ts` から成立すると読んだが、実際にコンパイルしての確認は未実施                                                                                                                                              |
| 3-4 | `expo-image-picker` が Android 13+ / iOS 14+ で `requestMediaLibraryPermissionsAsync` を必須としない可能性。呼んでも害は無いので呼ぶ設計にしている                                                                                                                                       |
| 3-5 | `expo-image` の `accessibilityLabel?: string`（`\| undefined` が無い）。`string \| undefined` を渡すと `exactOptionalPropertyTypes` で落ちるため、`Image` には `accessibilityLabel` を渡さず親の `Pressable` に付ける設計にしている                                                      |
| 3-6 | NativeWind 4.2.7 のスラッシュ不透明度記法（`bg-neutral-900/90`）が効くか。効かない前提で、半透明はすべて `style` の `rgba(...)` で書いている                                                                                                                                             |
| 3-7 | `Dimensions.get('window').width` と `useWindowDimensions()` の値が jest-expo で一致するか（`shop-photo-viewer.test.tsx` がこの一致を前提にしている）                                                                                                                                     |
| 3-8 | Google Maps の Android API キー。`app.json` に直書きせず、環境変数 / EAS Secrets から注入する必要がある。本計画書では設定手順まで踏み込んでいない                                                                                                                                        |

### 4. `@meshimap/core` の barrel に無い定数

`NEXT_DAY_PREFIX` / `BUSINESS_HOURS_SEPARATOR` / `BUSINESS_HOURS_JOINER` / `REGULAR_HOLIDAY_LABEL` は
`packages/core/src/constants.ts` に定義されているが `packages/core/src/index.ts` から re-export されていない。
本計画書はこれらを **import せず**、モバイル側の `src/constants/shop.ts` に独自の表示用定数を置く設計にしている。
core 側の値と食い違ったときに気づけないので、Phase 2 の担当者と「表示文言はどちらが持つか」を決めること。

### 5. 確認済みで、未確認事項ではないもの（誤解を防ぐための明示）

次の 2 点は実ファイルを読んで裏取り済みなので、実装時に疑わなくてよい。

- `@meshimap/core` / `@meshimap/geo` のバレルに、本計画書が import する名前がすべて存在する
  （`packages/core/src/index.ts` と `packages/geo/src/index.ts` を機械的に突き合わせて確認済み）
- `lucide-react-native` に `Heart` / `HeartOff` / `MessageSquare` / `SquarePen` / `CalendarCheck` /
  `ChevronLeft` / `ImageOff` / `MapPin` / `Phone` / `X` / `TriangleAlert` が存在する。
  逆に `Frown` と `Trash2` は**存在しない**ので使わない
