# Phase 2: `packages/core` 実装計画

対象パッケージ: `packages/core`（npm 名 `@meshimap/core`）
前提フェーズ: Phase 1（`packages/geo`）完了済み
作成日: 2026-09-15

---

## 0. エージェント作業者への注記

- **上から順に 1 タスクずつ実行する。** タスク内の Step も番号どおりに進める。
- **コードブロックはそのまま貼れば動く完成形。** 抜粋・擬似コード・「適宜」は 1 つも含まれていない。書かれているコードが最終形。
- **すべての Bash コマンドの先頭で Node 22 を有効化する。**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  ```

- コマンドはリポジトリルートから `-w @meshimap/core` を付けて実行する（`cd packages/core` はしない）。
- 各タスクの最後に **「意図的に壊して検知を確認する」Step** がある。**飛ばさない。** 表の「FAIL するテスト」は本計画の作成時に実際にコードを壊して実測した結果であり、再現するはずのもの。
- 1 タスク完了ごとに `typecheck` と `test` が緑であることを確認してから次へ進む。
- 本計画は `packages/core` だけを扱う。`packages/geo`（Phase 1 完了済み）と `apps/mobile` のファイルは読むだけで変更しない。
- 本計画に載っているコードとテストは、実際に 13 ファイル・**323 テスト**を書いて `tsc --noEmit` / `vitest run --coverage` / `stryker run` まで通した実測済みのものである（カバレッジ 100%、ミューテーションスコア **100.00%**）。

---

## 1. ゴール

`@meshimap/core` を「API（Phase 4 以降）とモバイル（Phase 5 以降）が共有する、副作用ゼロのドメイン層」として完成させる。

| ゴール                                   | 完了条件                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| ドメインの語彙を型で固定する             | ロール / 各種 ID / 0 時からの分 / JST 日付 が、すべてブランド型またはリテラル union になっている         |
| 営業状態の判定を 1 箇所に集める          | `getOpenStatus` / `isCurrentlyOpen` / `minutesUntilClose` が日跨ぎ・中休み・臨時休業・定休日をすべて扱う |
| 予約の可否判定を 1 箇所に集める          | `generateSlots` と `canReserve` が席数・同時受付数・受付停止を一貫した優先順で判定する                   |
| 入力検証を API とモバイルで共有する      | Zod v4 スキーマを公開し、両側で同じ境界値・同じエラーメッセージになる                                    |
| 表示文字列をプラットフォーム非依存にする | `Intl` / `toLocaleString` / `Date` のローカル時刻メソッドを一切使わない                                  |
| 品質ゲート                               | カバレッジ 100%（lines / functions / branches / statements）、ミューテーションスコア 85% 以上            |

**非ゴール（このフェーズでやらないこと）**

- D1 のスキーマ定義・SQL・シード（Phase 3）
- Hono のルーティング・認証・エラーハンドラ（Phase 4）
- 距離計算・geohash・クラスタリング（Phase 1 の `@meshimap/geo` に実装済み。再実装しない）
- 日時の書式化のうち「年月日の表示」（画面要件が決まる Phase 5 まで保留。本フェーズは `YYYY-MM-DD` のまま扱う）

---

## 2. アーキテクチャ

`@meshimap/core` は**純粋関数と型だけ**で構成する。I/O・グローバル状態・現在時刻の暗黙参照を持たない（`new Date()` を内部で呼ばず、`now: Date` を引数で受け取る）。

### 2.1 レイヤと依存方向

```text
                       constants.ts   ← 数値・文字列定数の唯一の置き場（他に依存しない）
                            │
        ┌───────────────────┼────────────────────┬──────────────┐
        ▼                   ▼                    ▼              ▼
     role.ts          minute-of-day.ts      rating.ts       budget.ts
        │                   │
        │                   ▼
        │              jst-clock.ts
        │                   │
        │                   ▼
        │            business-hours.ts
        │              │           │
        │              ▼           ▼
        │        open-status.ts  reservation-slot.ts
        │                             │
        │                             ▼
        │                   reservation-availability.ts
        │
        ├── identifier.ts ──┐
        │                   ▼
        └────────────►  schema.ts  ◄── @meshimap/geo（LATITUDE_MIN / LATITUDE_MAX / LONGITUDE_MIN / LONGITUDE_MAX）
                            │
                            ▼
                        index.ts（公開バレル。ここだけが外部から import される）
```

**循環はゼロ。** 矢印は「上が下に import される」向き。`index.ts` は全モジュールを再輸出するだけで、どのモジュールも `index.ts` を import しない（循環防止）。

### 2.2 設計上の決定と理由

| 決定                                          | 理由                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 時刻を「0 時からの分」(`MinuteOfDay`) で持つ  | 日跨ぎ営業（翌 1:30 = 1530）を数値比較 1 回で判定できる。文字列比較や `Date` の加算を避ける                              |
| 閉店 > 1440 を日跨ぎの表現とする              | 「翌 0:00 閉店」(1440) は当日で閉まる扱い、「翌 0:01 以降」(1441〜) が日跨ぎ。境界を 1 箇所（`isOvernight`）に閉じ込める |
| JST は自前で +540 分してから `getUTC*` で読む | `getHours()` 等は実行環境の TZ で結果が変わる。Cloudflare Workers（UTC）と端末（JST）で同じ答えを出すため                |
| ID をブランド型にする                         | `shopId` を `userId` の位置に渡す事故をコンパイル時に落とす。`as` はブランド生成点だけで使う                             |
| `Intl` / `toLocaleString` を使わない          | React Native（Hermes）でロケールデータが欠ける環境があるため、桁区切りは正規表現で自前実装する                           |
| 現在時刻を引数で受け取る                      | テストが時計に依存しない。`vi.useFakeTimers()` を使わずに境界値を直接指定できる                                          |
| Zod スキーマを `core` に置く                  | API（Hono）とモバイル（フォーム）で同じ境界値・同じ日本語メッセージを共有する                                            |

---

## 3. 技術スタック（実測値）

| 項目                  | バージョン | 確認方法                                                            |
| --------------------- | ---------- | ------------------------------------------------------------------- |
| Node.js               | v22.23.2   | `node -v`                                                           |
| TypeScript            | 6.0.3      | `node -e "console.log(require('typescript/package.json').version)"` |
| Vitest                | 5.0.0      | `node -e "console.log(require('vitest/package.json').version)"`     |
| @vitest/coverage-v8   | 5.0.0      | 同上                                                                |
| Zod                   | 4.6.5      | `node -e "console.log(require('zod/package.json').version)"`        |
| @stryker-mutator/core | 10.0.0     | 同上                                                                |
| Prettier              | 3.9.6      | 同上                                                                |

`tsconfig.base.json` → `tsconfig.strict.json` から継承される主な設定（実測）:

| 設定                                     | 値                              | 実装上の意味                                                                                                                                                    |
| ---------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target` / `module` / `moduleResolution` | `ES2022` / `ESNext` / `bundler` | 拡張子なしの相対 import を書く                                                                                                                                  |
| `lib`                                    | `["ES2022"]`                    | **`toSorted` / `toReversed` / `Object.groupBy` / `Array.prototype.at`(ES2022 は可) に注意。`toSorted` は型定義が無いので使えない** → `[...array].sort()` を使う |
| `strict`                                 | `true`                          | 暗黙 any 禁止                                                                                                                                                   |
| `noUncheckedIndexedAccess`               | `true`                          | `array[0]` は `T \| undefined`。添字アクセス後は必ず `undefined` を潰す                                                                                         |
| `exactOptionalPropertyTypes`             | `true`                          | `foo?: number` に `undefined` を明示代入できない。省略可能プロパティは `number \| null \| undefined` のように書く                                               |
| `verbatimModuleSyntax`                   | `true`                          | **型だけの import は `import type` にする**（混在させると実行時 import が残る）                                                                                 |
| `noUnusedLocals` / `noUnusedParameters`  | `true`                          | 使わない import を残すとコンパイルエラー                                                                                                                        |
| `isolatedModules`                        | `true`                          | 型の再輸出は `export type { ... }` にする                                                                                                                       |

---

## 4. グローバル制約（全タスク共通）

1. **Node 22 を有効化してからコマンドを実行する。**

   ```bash
   export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
   ```

2. **コマンドはリポジトリルートから `-w @meshimap/core` で実行する。**

   | 目的                   | コマンド                                             |
   | ---------------------- | ---------------------------------------------------- |
   | 型チェック             | `npm run typecheck -w @meshimap/core`                |
   | 全テスト               | `npm run test -w @meshimap/core`                     |
   | 単一ファイルのテスト   | `npm run test -w @meshimap/core -- src/role.test.ts` |
   | カバレッジ             | `npm run test:coverage -w @meshimap/core`            |
   | ミューテーションテスト | `npm run test:mutation -w @meshimap/core`            |
   | 整形                   | `npx prettier --write "packages/core/src/**/*.ts"`   |

3. **`any` 禁止。** `unknown` + 絞り込みで書く。`isRole(value: unknown)` のように、外部から来る値は `unknown` で受ける。
4. **`as` はブランド型の生成点だけ。** 具体的には `toShopId` / `toUserId` / `toReviewId` / `toReservationId` / `toMinuteOfDay` / `toJstDate` / `toDayOfWeek` / `toRating` の `return value as X;` の 8 箇所と、`as const` のみ。それ以外で `as` を書いたらレビューで差し戻す。
5. **単位を名前に含める。** `minutes` / `Minute` / `Yen` / `MINUTES_PER_DAY` / `MILLISECONDS_PER_MINUTE` のように、数値の変数・定数・プロパティ名から単位が読めるようにする。`duration` や `size` のような単位不明の名前は使わない。
6. **コメントは日本語。** 「何をしているか」ではなく「なぜそうしたか」を書く。JSDoc（`/** */`）は公開 API と定数に付ける。
7. **マジックナンバー禁止。** 数値リテラルは `constants.ts` に定数として置く（`0` / `1` / `10` のような算術上の自明な値と、テストコード内の期待値は除く）。
8. **品質ゲート:** カバレッジ 100%（4 指標すべて）、ミューテーションスコア 85% 以上（`stryker.config.json` の `break: 85`）。
9. **命名規則:** 関数・変数は camelCase、型は PascalCase、定数は UPPER_SNAKE_CASE、ファイル名は kebab-case。
10. **ファイル配置:** すべて `packages/core/src/` 直下（サブディレクトリを作らない）。テストは実装と同じディレクトリに `*.test.ts` で置く（`vitest.config.ts` の `include: ['src/**/*.test.ts']` に合わせる）。

---

## 5. 定数・期待値の根拠

この節の値はすべて **実際に計算・実行して確認した実測値**であり、推測は含まない。実装中に期待値で迷ったら、まずこの表を見る。

### 5.1 時間の換算（`node -e` で計算）

| 定数 / 式                                               | 値        | 根拠                                                                                                                          |
| ------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `MINUTES_PER_HOUR`                                      | 60        | 定義                                                                                                                          |
| `MINUTES_PER_DAY`                                       | 1440      | `24 * 60 = 1440`                                                                                                              |
| `MINUTE_OF_DAY_MIN`                                     | 0         | 0:00                                                                                                                          |
| `MINUTE_OF_DAY_MAX`                                     | 2879      | `node -e "console.log(47*60+59)"` → `2879`（翌 23:59 まで表現できる上限）                                                     |
| `JST_OFFSET_MINUTES`                                    | 540       | `9 * 60 = 540`                                                                                                                |
| `MILLISECONDS_PER_MINUTE`                               | 60000     | `60 * 1000`                                                                                                                   |
| `MILLISECONDS_PER_DAY`                                  | 86400000  | `24 * 60 * 60 * 1000`。`MILLISECONDS_PER_MINUTE * MINUTES_PER_DAY = 60000 * 1440 = 86400000` と一致することをテストで検証する |
| `CLOSING_SOON_THRESHOLD_MINUTES`                        | 30        | 仕様（閉店 30 分前から「まもなく閉店」）                                                                                      |
| `DAYS_PER_WEEK` / `DAY_OF_WEEK_MIN` / `DAY_OF_WEEK_MAX` | 7 / 0 / 6 | `Date.prototype.getUTCDay()` と D1 の `shop_hours.day_of_week` に合わせて 0 = 日曜                                            |

### 5.2 `formatMinuteOfDay` の出力（プローブ実装に対する vitest で実測）

| 入力 | 出力         | 備考                                        |
| ---- | ------------ | ------------------------------------------- |
| 0    | `"0:00"`     | **時は 0 詰めしない**（`"00:00"` ではない） |
| 60   | `"1:00"`     |                                             |
| 690  | `"11:30"`    |                                             |
| 1080 | `"18:00"`    |                                             |
| 1439 | `"23:59"`    | 当日の最後の分                              |
| 1440 | `"翌 0:00"`  | ここから接頭辞が付く                        |
| 1530 | `"翌 1:30"`  | 分は必ず 2 桁（`padStart(2, '0')`）         |
| 1560 | `"翌 2:00"`  |                                             |
| 2879 | `"翌 23:59"` | 上限                                        |

`formatBusinessHours` の出力: `"18:00 - 翌 1:30"` / `"22:30 - 翌 2:00"` / `"11:30 - 14:00 / 17:00 - 23:00"` / `"0:00 - 翌 0:00"`（24 時間営業）/ `"定休日"`。

### 5.3 JST 変換のアンカー（TZ 非依存であることまで実測）

| 入力（UTC）            | `toJstClock` の結果                                       | 意味                           |
| ---------------------- | --------------------------------------------------------- | ------------------------------ |
| `2026-09-15T00:00:00Z` | `{ date: '2026-09-15', dayOfWeek: 2, minuteOfDay: 540 }`  | UTC 0:00 = JST 9:00            |
| `2026-09-15T13:30:00Z` | `{ date: '2026-09-15', dayOfWeek: 2, minuteOfDay: 1350 }` | JST 火曜 22:30                 |
| `2026-09-15T14:59:59Z` | `{ date: '2026-09-15', dayOfWeek: 2, minuteOfDay: 1439 }` | **秒は切り捨てる**。まだ同じ日 |
| `2026-09-15T15:00:00Z` | `{ date: '2026-09-16', dayOfWeek: 3, minuteOfDay: 0 }`    | ここで JST の日付が変わる      |

曜日の実測: `2026-09-13` → 0（日）、`2026-09-15` → 2（火）、`2026-09-19` → 6（土）。

**TZ 非依存の確認方法:** `vi.stubEnv('TZ', 'UTC')` と `vi.stubEnv('TZ', 'Asia/Tokyo')` と `vi.stubEnv('TZ', 'America/New_York')` の 3 通りで同じ結果になることをテストする。`process.env` を直接触らない（`packages/core/tsconfig.json` の `types` は `["vitest/globals"]` だけで **`@types/node` が無いため `process` は型エラーになる**。これは実測で TS2591 を踏んで確認済み）。

### 5.4 営業時間の境界値（分単位・実測）

営業時間 `火曜 22:30 - 翌 2:00`（`openMinute: 1350`, `closeMinute: 1560`, `dayOfWeek: 2`）に対する `minutesUntilClose` の実測値:

| 現在時刻（UTC）        | JST      | 結果   | 意味                                                             |
| ---------------------- | -------- | ------ | ---------------------------------------------------------------- |
| `2026-09-15T13:29:00Z` | 火 22:29 | `null` | **開店 1 分前は営業時間外**                                      |
| `2026-09-15T13:30:00Z` | 火 22:30 | `210`  | **開店ちょうどは営業中**（`1560 - 1350 = 210`）                  |
| `2026-09-15T14:59:00Z` | 火 23:59 | `121`  | 当日分として判定                                                 |
| `2026-09-15T15:00:00Z` | 水 0:00  | `120`  | **前日（火）の行を +1440 して判定**（`1560 - (0 + 1440) = 120`） |
| `2026-09-15T16:00:00Z` | 水 1:00  | `60`   | 日跨ぎ分の残り                                                   |
| `2026-09-15T17:00:00Z` | 水 2:00  | `null` | **閉店ちょうどは営業時間外**                                     |

昼夜 2 部営業（`11:30 - 14:00` = 690〜840、`17:00 - 23:00` = 1020〜1380）の実測:

| JST   | 結果   | 意味                                            |
| ----- | ------ | ----------------------------------------------- |
| 11:29 | `null` | 開店 1 分前                                     |
| 11:30 | `150`  | 開店ちょうど                                    |
| 14:00 | `null` | **昼の部の閉店ちょうど**                        |
| 15:00 | `null` | 中休みは `closed`（`regular-holiday` ではない） |
| 22:00 | `60`   | 夜の部の残り（昼の部に引きずられない）          |

`getOpenStatus` の実測: 残り 31 分 → `'open'`、残り 30 分 → `'closing-soon'`、残り 1 分 → `'closing-soon'`、営業時間のある曜日の開店前 → `'closed'`、中休み → `'closed'`、臨時休業日 → `'closed'`、その曜日に営業行が無い/定休日フラグのみ → `'regular-holiday'`。

**日跨ぎ判定の境界:** `isOvernight` は `closeMinute > 1440`。`closeMinute === 1440`（翌 0:00 閉店）は **日跨ぎではない**（当日で閉まる）。

### 5.5 予約枠の生成（実測）

`18:00 - 翌 1:30`（1080〜1530）、`slotMinutes: 90` の場合:

```text
node -e "const a=[];for(let s=1080;s+90<=1530;s+=90)a.push([s,s+90]);console.log(a)"
→ [[1080,1170],[1170,1260],[1260,1350],[1350,1440],[1440,1530]]  （5 枠）
```

端数は切り捨てる（`start + slotMinutes <= closeMinute` を満たす枠だけ作る）。営業時間と枠長が等しければ 1 枠、枠長が営業時間より長ければ 0 枠。

席設定の境界（`assertSeatSettings`）: `slotMinutes` 15〜240、`capacity` 1〜500、`maxParallel` 1〜100。**境界ちょうどは受け入れる**（15 と 240、1 と 500、1 と 100）。

### 5.6 評価の平均と丸め（`node -e` で計算）

`Math.round((totalScore / count) * 10) / 10` の実測:

| 入力                               | 平均の生値 | ×10  | `Math.round` | 最終結果                                                              | 型                                            |
| ---------------------------------- | ---------- | ---- | ------------ | --------------------------------------------------------------------- | --------------------------------------------- |
| `[4, 5, 3]`（合計 12 / 3 件）      | 4          | 40   | 40           | **`4`**                                                               | `number`。JSON でも `4`（`4.0` にはならない） |
| `[4, 5, 4, 4, 5]`（22 / 5 件）     | 4.4        | 44   | 44           | `4.4`                                                                 |                                               |
| 星 5 × 9 + 星 4 × 11（89 / 20 件） | 4.45       | 44.5 | 45           | **`4.5`**                                                             | 0.5 は切り上げ                                |
| 星 4 × 7 + 星 3 × 13（67 / 20 件） | 3.35       | 33.5 | 34           | **`3.4`**                                                             |                                               |
| `[]`（0 件）                       | —          | —    | —            | `{ average: 0, count: 0, distribution: { 1:0, 2:0, 3:0, 4:0, 5:0 } }` | 0 除算を避けるため件数 0 を先に返す           |

**「3 件 4,5,3 の平均は 4.0 か 4 か」への答え: `4`（`number` 型の 4）。** JavaScript に `4.0` という値は存在せず、`toBe(4)` で比較する。表示側で小数第 1 位を固定したい場合は Phase 5 の UI 層の責務とし、`core` では数値のまま返す。

### 5.7 予算の表示（実測）

| 入力                            | 出力                                 |
| ------------------------------- | ------------------------------------ |
| `formatYen(0)`                  | `"¥0"`                               |
| `formatYen(999)`                | `"¥999"`                             |
| `formatYen(1000)`               | `"¥1,000"`                           |
| `formatYen(12345)`              | `"¥12,345"`                          |
| `formatYen(1000000)`            | `"¥1,000,000"`                       |
| `formatBudgetRange(1000, 3000)` | `"¥1,000 〜 ¥3,000"`                 |
| `formatBudgetRange(2000, 2000)` | `"¥2,000"`（同額なら 1 つだけ）      |
| `formatBudgetRange(3000, null)` | `"¥3,000 〜"`                        |
| `formatBudgetRange(null, 3000)` | `"〜 ¥3,000"`                        |
| `formatBudgetRange(null, null)` | `"－"`（全角ダッシュ）               |
| `formatBudgetRange(0, 0)`       | `"¥0"`（`null` と `0` を混同しない） |

桁区切りは `/\B(?=(\d{3})+(?!\d))/g` による自前実装。`node -e "console.log((1000000).toLocaleString('ja-JP'))"` → `1,000,000` と一致することをテストで突き合わせる（`Intl` 自体は実装では使わない）。

### 5.8 Zod v4 のエラー形状（**v3 から変わっている。実測必須だった箇所**）

`zod@4.6.5` で実際に `safeParse` して得た `error.issues` の中身:

| ケース                                 | 実測した issue                                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `z.string().min(1).safeParse('')`      | `{ origin: 'string', code: 'too_small', minimum: 1, inclusive: true, path: [], message: 'Too small: expected string to have >=1 characters' }`                 |
| `z.number().max(90).safeParse(90.1)`   | `{ origin: 'number', code: 'too_big', maximum: 90, inclusive: true, path: [], message: 'Too big: expected number to be <=90' }`                                |
| 必須キーが無い                         | `{ expected: 'string', code: 'invalid_type', path: ['a'], message: 'Invalid input: expected string, received undefined' }` ← **`received` キーが無い**         |
| `z.number().int().safeParse(1.5)`      | `{ expected: 'int', format: 'safeint', code: 'invalid_type', ... }`                                                                                            |
| `z.number().int().safeParse(NaN)`      | `{ expected: 'number', code: 'invalid_type', received: 'NaN', ... }` ← NaN のときだけ `received` が付く                                                        |
| `z.enum([...]).safeParse('root')`      | `{ code: 'invalid_value', values: ['user','owner'], message: 'Invalid option: expected one of "user"\|"owner"' }`                                              |
| `z.string().regex(...)` 不一致         | `{ origin: 'string', code: 'invalid_format', format: 'regex', pattern: '/^[0-9]{3}-[0-9]{4}$/', ... }`                                                         |
| `z.iso.date().safeParse('2026-02-30')` | `{ origin: 'string', code: 'invalid_format', format: 'date', message: 'Invalid ISO date' }` ← **閏年を判定できる**（`2024-02-29` は成功、`2026-02-29` は失敗） |
| `.refine(fn, { error, path })`         | `{ code: 'custom', path: [...], message: <error に渡した文字列> }`                                                                                             |

**v3 との差分で特に効いた点（すべて実測で確認）**

1. **`type` は `origin` に変わった。** v3 の `{ code: 'too_small', type: 'string' }` は v4 では `{ code: 'too_small', origin: 'string' }`。
2. **エラーメッセージの指定は `message` ではなく `error`。** `.refine(fn, { error: '…', path: [...] })` と書く。
3. **`z.url()` は既定で `javascript:` を通す。** 実測: `z.url().safeParse('javascript:alert(1)')` は **成功**する。必ず `z.url({ protocol: /^https?$/ })` を使う（この実測が無ければ XSS を通すスキーマになっていた）。
4. **`.partial()` は refine 済みスキーマに使えない。** 実測: `Error: .partial() cannot be used on object schemas containing refinements`。→ 素の `z.object` を先に定義し、`extend`（create 用）と `partial`（update 用）をそこから作る。
5. **`.partial()` は内側の `.default()` を消さない。** → 既定値は `shopCreateSchema` 側の `.extend({...})` にだけ書く。
6. **文字列のチェックは全部走る。** `identifierSchema.safeParse('')` は issue が **2 件**（`too_small` と `invalid_format`）。1 件だと思って書いたテストは落ちる。
7. `z.object` は既定で未知のキーを**取り除いて通す**（`strip`）。

### 5.9 書式パターンの受理・拒否（実測）

| パターン                                     | 受理                                                                 | 拒否                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 郵便番号 `/^[0-9]{3}-[0-9]{4}$/`             | `150-0002`                                                           | `1500002` / `0150-0002` / `150-00021` / `150-0002 `（末尾空白）                              |
| 電話 `/^0[0-9]{1,4}-[0-9]{1,4}-[0-9]{3,4}$/` | `03-1234-5678` / `0120-123-456`                                      | `0312345678` / `81-03-1234-5678` / `03-1234-5678-9`                                          |
| URL `z.url({ protocol: /^https?$/ })`        | `https://example.com` / `http://example.com` / `HTTPS://example.com` | `httpx://example.com` / `xhttps://example.com` / `ftp://example.com` / `javascript:alert(1)` |

### 5.10 Stryker 10 + Vitest 5 の組み合わせ（**実測で判明した不具合**）

| 事象                                                | 実測                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testRunner: "vitest"`（既定の設定ファイルのまま）  | 変異ごとに実行されるテストが 0 件になり、スコアが **21.14%** まで落ちる（`@stryker-mutator/vitest-runner@10.0.0` が `vitest@5.0.0` と噛み合っていない） |
| `testRunner: "command"` + `coverageAnalysis: "off"` | 正常に動作し、同じコード・同じテストでスコア **100.00%**（610 変異 / 601 kill + 9 timeout / 0 survive、1 分 34 秒）                                     |

→ **Task 2-0 で `packages/core/stryker.config.json` をコマンドランナーに差し替える。** Phase 1（`packages/geo`）でも同じ不具合が出て同じ対処になっている。

---

## 6. ファイル構成

すべて `packages/core/src/` 直下に置く。

| ファイル                      | 責務                                   | import する内部モジュール                                   |
| ----------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `constants.ts`                | 数値・文字列定数の唯一の置き場         | なし                                                        |
| `role.ts`                     | ロールの定義と権限判定                 | なし                                                        |
| `identifier.ts`               | 4 種類の ID のブランド型と生成関数     | なし                                                        |
| `minute-of-day.ts`            | 「0 時からの分」型・生成・表示         | `constants`                                                 |
| `jst-clock.ts`                | JST の日付・曜日・現在時刻の分解       | `constants`, `minute-of-day`                                |
| `business-hours.ts`           | 営業時間・臨時休業の型、曜日抽出、表示 | `constants`, `jst-clock`(型), `minute-of-day`               |
| `open-status.ts`              | 営業中判定・残り時間・表示ステータス   | `constants`, `business-hours`, `jst-clock`                  |
| `reservation-slot.ts`         | 席設定の検証と予約枠の生成             | `constants`, `business-hours`, `jst-clock`, `minute-of-day` |
| `reservation-availability.ts` | 予約可否と理由コード                   | `constants`, `reservation-slot`, `minute-of-day`(型)        |
| `rating.ts`                   | 評価の型・平均・分布                   | `constants`                                                 |
| `budget.ts`                   | 金額と予算帯の表示                     | `constants`                                                 |
| `schema.ts`                   | Zod v4 の入力スキーマ                  | `constants`, `identifier`, `role`, `@meshimap/geo`          |
| `index.ts`                    | 公開バレル（再輸出のみ）               | 全モジュール                                                |

テストは同名の `*.test.ts` を同じディレクトリに置く（13 ファイル）。

**依存方向のルール:** 表の上のモジュールは下のモジュールを import しない。`index.ts` は誰からも import されない。この 2 つを守れば循環は発生しない。

---

## 7. タスク一覧と README からの差分

`docs/superpowers/plans/README.md` の Phase 2 は **11 タスク**。本計画は **13 タスク**にする。

| 本計画 | タスク                                   | README との対応                             |
| ------ | ---------------------------------------- | ------------------------------------------- |
| 2-0    | 基盤整備（定数・geo 依存・Stryker 設定） | **新規**（+1）                              |
| 2-1    | ロール定義                               | README 2-1                                  |
| 2-2    | ID ブランド型                            | README 2-2                                  |
| 2-3    | 分単位時刻 `MinuteOfDay`                 | README 2-3 を分割（+1）                     |
| 2-4    | JST クロック                             | **新規**（+1）                              |
| 2-5    | 営業時間の型と表示                       | README 2-3 の残り + README 2-6 を統合（-1） |
| 2-6    | 営業中判定と営業ステータス               | README 2-4 + 2-5 を統合（-1）               |
| 2-7    | 予約枠生成                               | README 2-7                                  |
| 2-8    | 予約可否                                 | README 2-8                                  |
| 2-9    | 評価集計                                 | README 2-9                                  |
| 2-10   | 予算帯の表示                             | README 2-10                                 |
| 2-11   | Zod スキーマ                             | README 2-11                                 |
| 2-12   | 公開 API バレルと品質ゲート              | **新規**（+1）                              |

**増減の理由（11 → 13、差し引き +2）**

- **+1 `2-0 基盤整備`**: 定数を最初に 1 ファイルへ集約しないと、後続タスクがマジックナンバーを持ち込む。あわせて `package.json` への `@meshimap/geo` 依存追加（Task 2-11 で必要）と、**壊れている Stryker 設定の差し替え**をここで済ませる。設定が壊れたままだと、途中でミューテーションテストを回したときにスコア 21% という嘘の数字が出て原因調査に時間を溶かす（実測済み）。
- **+1 `2-3` / `2-4` への分割**: README 2-3「営業時間の型」は、実際には (a) 分単位時刻の型、(b) JST の日付・曜日、(c) 営業時間の型 の 3 つを含む。(b) の JST 計算は**タイムゾーン非依存**という独立した難所（`getHours()` を使った瞬間にテストが実行環境依存になる）なので、独立タスクにして専用のテストを持たせる。
- **-1 `2-5` 統合**: README 2-3 の「営業時間の型」と README 2-6 の「表示」は同じ `business-hours.ts` の中身。別タスクにすると同じファイルを 2 回書くことになるため 1 タスクにまとめる。
- **-1 `2-6` 統合**: README 2-4「営業中判定」と 2-5「営業ステータス」は同じ `open-status.ts`。`getOpenStatus` は `minutesUntilClose` の戻り値を分岐するだけなので、分けるとテストの前提（営業時間データ）を二重に書くことになる。
- **+1 `2-12 バレルと品質ゲート`**: 公開 API の確定（`index.ts`）と、カバレッジ 100% / ミューテーション 85% のゲート通過を独立させ、「どこまで終われば Phase 2 完了か」を 1 タスクに閉じ込める。

---

## Task 2-0: 基盤整備（定数・`@meshimap/geo` 依存・Stryker 設定）

**Files:**

- Modify: `packages/core/package.json`
- Modify: `packages/core/stryker.config.json`
- Create: `packages/core/src/constants.ts`
- Test: `packages/core/src/constants.test.ts`

**Interfaces:**

- Consumes: なし（このタスクは他モジュールに依存しない）
- Produces:
  - `export const MINUTES_PER_HOUR: 60` / `MINUTES_PER_DAY: 1440` / `MINUTE_OF_DAY_MIN: 0` / `MINUTE_OF_DAY_MAX: 2879` / `HOURS_PER_DAY: 24` / `DAYS_PER_WEEK: 7` / `DAY_OF_WEEK_MIN: 0` / `DAY_OF_WEEK_MAX: 6`
  - `export const JST_OFFSET_MINUTES: 540` / `MILLISECONDS_PER_MINUTE: 60000` / `MILLISECONDS_PER_DAY: 86400000` / `CLOSING_SOON_THRESHOLD_MINUTES: 30`
  - `export const RATING_MIN: 1` / `RATING_MAX: 5` / `PARTY_SIZE_MIN: 1` / `PARTY_SIZE_MAX: 20` / `BUDGET_YEN_MIN: 0` / `BUDGET_YEN_MAX: 1000000`
  - `export const SHOP_NAME_MAX_LENGTH: 100` / `SHOP_NAME_KANA_MAX_LENGTH: 200` / `SHOP_ADDRESS_MAX_LENGTH: 200` / `SHOP_DESCRIPTION_MAX_LENGTH: 2000` / `REVIEW_BODY_MAX_LENGTH: 2000` / `RESERVATION_NOTE_MAX_LENGTH: 500`
  - `export const SLOT_MINUTES_MIN: 15` / `SLOT_MINUTES_MAX: 240` / `SEAT_CAPACITY_MIN: 1` / `SEAT_CAPACITY_MAX: 500` / `MAX_PARALLEL_MIN: 1` / `MAX_PARALLEL_MAX: 100`
  - `export const NEXT_DAY_PREFIX: '翌 '` / `BUSINESS_HOURS_SEPARATOR: ' - '` / `BUSINESS_HOURS_JOINER: ' / '` / `REGULAR_HOLIDAY_LABEL: '定休日'`

---

- [x] **Step 1: `packages/core/package.json` に `@meshimap/geo` 依存を追加する**

  Task 2-11 の `schema.ts` が `@meshimap/geo` から `LATITUDE_MIN` / `LATITUDE_MAX` / `LONGITUDE_MIN` / `LONGITUDE_MAX` を import する。ワークスペース参照の書き方は `apps/api/package.json` と `apps/mobile/package.json` に合わせて `"*"` にする。ファイル全体を次の内容にする:

  ```json
  {
    "name": "@meshimap/core",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "description": "ドメインロジックと共有スキーマ（ロール定義 / 営業時間判定 / 予約枠算出 / 評価集計 / Zod スキーマ）。API とモバイルの両方から参照する。",
    "main": "./src/index.ts",
    "types": "./src/index.ts",
    "exports": {
      ".": "./src/index.ts"
    },
    "scripts": {
      "test": "vitest run",
      "test:watch": "vitest",
      "test:coverage": "vitest run --coverage",
      "test:mutation": "stryker run",
      "typecheck": "tsc --noEmit"
    },
    "dependencies": {
      "@meshimap/geo": "*",
      "zod": "^4.6.5"
    }
  }
  ```

- [x] **Step 2: ワークスペースのリンクを張り直す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm install
  ```

  期待: `node_modules/@meshimap/geo` が `packages/geo` へのシンボリックリンクになる。次のコマンドで確認する。

  ```bash
  ls -l node_modules/@meshimap/
  ```

- [x] **Step 3: `packages/core/stryker.config.json` をコマンドランナーに差し替える**

  既定の `testRunner: "vitest"` は `@stryker-mutator/vitest-runner@10.0.0` と `vitest@5.0.0` の組み合わせで**変異ごとに 0 件しかテストを実行せず**、スコアが 21.14% まで落ちる（本計画作成時に実測）。コマンドランナーに切り替えると同じコード・同じテストで 100.00% になる。ファイル全体を次の内容にする:

  ```json
  {
    "$schema": "https://raw.githubusercontent.com/stryker-mutator/stryker-js/master/packages/api/schema/stryker-core.json",
    "packageManager": "npm",
    "testRunner": "command",
    "commandRunner": {
      "command": "npx vitest run --silent"
    },
    "reporters": ["html", "clear-text", "progress"],
    "mutate": ["src/**/*.ts", "!src/**/*.test.ts", "!src/index.ts"],
    "coverageAnalysis": "off",
    "htmlReporter": {
      "fileName": "reports/mutation/index.html"
    },
    "thresholds": {
      "high": 95,
      "low": 85,
      "break": 85
    }
  }
  ```

  `coverageAnalysis` は `"off"` にする（コマンドランナーはテスト単位のカバレッジを収集できないため、`"perTest"` のままだと実行時にエラーになる）。

- [x] **Step 4: `packages/core/src/constants.ts` を作る**

```ts
// ドメイン全体で共有する定数。マジックナンバーをコードに直接書かないための唯一の置き場。

/** 1 時間 = 60 分。 */
export const MINUTES_PER_HOUR = 60;
/** 1 日 = 1440 分。日跨ぎ営業の判定はこの値を境にする。 */
export const MINUTES_PER_DAY = 1440;
/** 0 時からの分の下限。 */
export const MINUTE_OF_DAY_MIN = 0;
/** 0 時からの分の上限。翌 23:59 = 2879 まで許容して日跨ぎ営業を表現する。 */
export const MINUTE_OF_DAY_MAX = 2879;
/** 1 日 = 24 時間。 */
export const HOURS_PER_DAY = 24;
/** 1 週 = 7 日。曜日の剰余計算に使う。 */
export const DAYS_PER_WEEK = 7;
/** 曜日の下限（0 = 日曜）。D1 の shop_hours.day_of_week と揃える。 */
export const DAY_OF_WEEK_MIN = 0;
/** 曜日の上限（6 = 土曜）。 */
export const DAY_OF_WEEK_MAX = 6;
/** JST は UTC+9。サーバ・端末のタイムゾーンに依存せず自前で加算するために持つ。 */
export const JST_OFFSET_MINUTES = 540;
/** 1 分 = 60000 ミリ秒。 */
export const MILLISECONDS_PER_MINUTE = 60_000;
/** 1 日 = 86400000 ミリ秒。日付の加減算に使う。 */
export const MILLISECONDS_PER_DAY = 86_400_000;
/** 閉店まで 30 分以内なら「まもなく閉店」と案内する。 */
export const CLOSING_SOON_THRESHOLD_MINUTES = 30;
/** 評価の下限（星 1）。 */
export const RATING_MIN = 1;
/** 評価の上限（星 5）。 */
export const RATING_MAX = 5;
/** 予約人数の下限。 */
export const PARTY_SIZE_MIN = 1;
/** 予約人数の上限。これを超える宴会は電話対応とする運用判断。 */
export const PARTY_SIZE_MAX = 20;
/** 予算の下限（0 円）。 */
export const BUDGET_YEN_MIN = 0;
/** 予算の上限（100 万円）。入力ミスを弾くための現実的な上限。 */
export const BUDGET_YEN_MAX = 1_000_000;
/** 店名の最大文字数。 */
export const SHOP_NAME_MAX_LENGTH = 100;
/** 店名カナの最大文字数。カナは表記が伸びるので店名の 2 倍を取る。 */
export const SHOP_NAME_KANA_MAX_LENGTH = 200;
/** 住所の最大文字数。 */
export const SHOP_ADDRESS_MAX_LENGTH = 200;
/** 店舗紹介文の最大文字数。 */
export const SHOP_DESCRIPTION_MAX_LENGTH = 2000;
/** レビュー本文の最大文字数。 */
export const REVIEW_BODY_MAX_LENGTH = 2000;
/** 予約メモの最大文字数。 */
export const RESERVATION_NOTE_MAX_LENGTH = 500;
/** 予約枠の最小長（分）。 */
export const SLOT_MINUTES_MIN = 15;
/** 予約枠の最大長（分）= 4 時間。 */
export const SLOT_MINUTES_MAX = 240;
/** 席数の下限。 */
export const SEAT_CAPACITY_MIN = 1;
/** 席数の上限。 */
export const SEAT_CAPACITY_MAX = 500;
/** 同一枠で受け付ける予約件数の下限。 */
export const MAX_PARALLEL_MIN = 1;
/** 同一枠で受け付ける予約件数の上限。 */
export const MAX_PARALLEL_MAX = 100;

/** 日跨ぎ時刻の接頭辞。「翌 1:30」のように表示する。 */
export const NEXT_DAY_PREFIX = '翌 ';
/** 開店時刻と閉店時刻の区切り。 */
export const BUSINESS_HOURS_SEPARATOR = ' - ';
/** 昼夜 2 部営業など、複数の営業帯をつなぐ区切り。 */
export const BUSINESS_HOURS_JOINER = ' / ';
/** 定休日の表示ラベル。 */
export const REGULAR_HOLIDAY_LABEL = '定休日';
```

- [x] **Step 5: `packages/core/src/constants.test.ts` を作る**

  定数そのもののテストは一見無意味に見えるが、(a) 単位の取り違え（分とミリ秒）を検知する、(b) 定数同士の整合（`MILLISECONDS_PER_MINUTE * MINUTES_PER_DAY === MILLISECONDS_PER_DAY`）を保証する、という 2 つの役目がある。

```ts
import { describe, expect, it } from 'vitest';
import {
  BUDGET_YEN_MAX,
  BUDGET_YEN_MIN,
  CLOSING_SOON_THRESHOLD_MINUTES,
  DAYS_PER_WEEK,
  DAY_OF_WEEK_MAX,
  DAY_OF_WEEK_MIN,
  HOURS_PER_DAY,
  JST_OFFSET_MINUTES,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_MINUTE,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  MINUTE_OF_DAY_MAX,
  MINUTE_OF_DAY_MIN,
} from './constants';

describe('時間の定数', () => {
  it('1 時間は 60 分である', () => {
    expect(MINUTES_PER_HOUR).toBe(60);
  });

  it('1 日は 1440 分である', () => {
    expect(MINUTES_PER_DAY).toBe(MINUTES_PER_HOUR * HOURS_PER_DAY);
    expect(MINUTES_PER_DAY).toBe(1440);
  });

  it('0 時からの分は 0 〜 2879（翌 23:59）の範囲である', () => {
    expect(MINUTE_OF_DAY_MIN).toBe(0);
    expect(MINUTE_OF_DAY_MAX).toBe(MINUTES_PER_DAY * 2 - 1);
    expect(MINUTE_OF_DAY_MAX).toBe(2879);
  });

  it('JST は UTC+9（540 分）である', () => {
    expect(JST_OFFSET_MINUTES).toBe(9 * MINUTES_PER_HOUR);
    expect(JST_OFFSET_MINUTES).toBe(540);
  });

  it('ミリ秒の換算定数が分・日と整合する', () => {
    expect(MILLISECONDS_PER_MINUTE).toBe(60_000);
    expect(MILLISECONDS_PER_DAY).toBe(MILLISECONDS_PER_MINUTE * MINUTES_PER_DAY);
    expect(MILLISECONDS_PER_DAY).toBe(86_400_000);
  });

  it('曜日は 0（日）〜 6（土）の 7 種類である', () => {
    expect(DAYS_PER_WEEK).toBe(7);
    expect(DAY_OF_WEEK_MIN).toBe(0);
    expect(DAY_OF_WEEK_MAX).toBe(DAYS_PER_WEEK - 1);
  });

  it('閉店間近の閾値は 30 分である', () => {
    expect(CLOSING_SOON_THRESHOLD_MINUTES).toBe(30);
  });
});

describe('ドメインの範囲定数', () => {
  it('予算は 0 円から 100 万円までを扱う', () => {
    expect(BUDGET_YEN_MIN).toBe(0);
    expect(BUDGET_YEN_MAX).toBe(1_000_000);
  });
});
```

- [x] **Step 6: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/constants.test.ts
  ```

  期待: 型エラーなし、`Tests  8 passed (8)`。

- [x] **Step 7: 意図的に壊してテストが検知することを確認する**

  1 つずつ適用し、指定のテストが FAIL することを確認したら**必ず元に戻す**。

  | #   | 変更する行（`src/constants.ts`）         | 変更後    | 期待: FAIL するテスト（実測）                                                                                                                                                                                        |
  | --- | ---------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `export const MINUTES_PER_DAY = 1440;`   | `= 1444;` | `時間の定数 > 1 日は 1440 分である`、`時間の定数 > 0 時からの分は 0 〜 2879（翌 23:59）の範囲である`、`時間の定数 > ミリ秒の換算定数が分・日と整合する`（この時点では 3 件。全モジュール実装後は 23 件が FAIL する） |
  | 2   | `export const JST_OFFSET_MINUTES = 540;` | `= 480;`  | `時間の定数 > JST は UTC+9（540 分）である`（全モジュール実装後は `toJstClock` 系も含め 33 件が FAIL する）                                                                                                          |

  戻したら再度 `npm run test -w @meshimap/core -- src/constants.test.ts` が緑になることを確認する。

---

## Task 2-1: ロール定義

**Files:**

- Create: `packages/core/src/role.ts`
- Test: `packages/core/src/role.test.ts`

**Interfaces:**

- Consumes: なし
- Produces:
  - `export const ROLE_USER: 'user'` / `ROLE_OWNER: 'owner'` / `ROLE_ADMIN: 'admin'`
  - `export const ROLES: readonly ['user', 'owner', 'admin']`
  - `export type Role = 'user' | 'owner' | 'admin'`
  - `export function isRole(value: unknown): value is Role`
  - `export function toRole(value: unknown): Role`（不正値は `RangeError`）
  - `export function canManageShop(role: Role): boolean`
  - `export function canModerate(role: Role): boolean`

---

- [x] **Step 1: `packages/core/src/role.ts` を作る**

```ts
// 利用者 / 店舗管理者 / システム管理者の 3 ロールと、その権限判定。

/** 一般利用者。店舗を探して予約・レビューする。 */
export const ROLE_USER = 'user';
/** 店舗管理者。自店舗の情報と予約を管理する。 */
export const ROLE_OWNER = 'owner';
/** システム管理者。全店舗の管理と通報対応を行う。 */
export const ROLE_ADMIN = 'admin';

/** 権限の弱い順に並べる。UI の選択肢もこの順で表示する。 */
export const ROLES = [ROLE_USER, ROLE_OWNER, ROLE_ADMIN] as const;

export type Role = (typeof ROLES)[number];

/** D1 やリクエストから来た未検証の値を Role に絞り込む。 */
export function isRole(value: unknown): value is Role {
  // 文字列以外は === で一致しないので typeof の事前判定は要らない
  return ROLES.some((role) => role === value);
}

/** Role でなければ例外にする。API 境界で不正なロールを持ち込ませないため。 */
export function toRole(value: unknown): Role {
  if (!isRole(value)) {
    throw new RangeError(`未知のロールです: ${JSON.stringify(value)}`);
  }
  return value;
}

/** 店舗情報の編集権限。admin は全店舗、owner は自店舗（所有者判定は呼び出し側の責務）。 */
export function canManageShop(role: Role): boolean {
  return role === ROLE_OWNER || role === ROLE_ADMIN;
}

/** レビューの非公開化など、モデレーション権限。 */
export function canModerate(role: Role): boolean {
  return role === ROLE_ADMIN;
}
```

`isRole` に `typeof value === 'string'` の事前判定を**入れない**理由: `ROLES.some((role) => role === value)` は文字列以外に対して必ず `false` を返すので、事前判定は結果を変えない冗長なコードになる。ミューテーションテストでは「条件を消しても結果が変わらない＝生き残る変異」として検出される（実測で確認済み）。

- [x] **Step 2: `packages/core/src/role.test.ts` を作る**

```ts
import { describe, expect, it } from 'vitest';
import {
  ROLES,
  ROLE_ADMIN,
  ROLE_OWNER,
  ROLE_USER,
  canManageShop,
  canModerate,
  isRole,
  toRole,
} from './role';

describe('ROLES', () => {
  it('利用者・店舗管理者・システム管理者の 3 種類を宣言順で持つ', () => {
    expect(ROLES).toEqual(['user', 'owner', 'admin']);
  });

  it('各ロール定数の値が設計書の文字列と一致する', () => {
    expect(ROLE_USER).toBe('user');
    expect(ROLE_OWNER).toBe('owner');
    expect(ROLE_ADMIN).toBe('admin');
  });

  it('重複したロールを含まない', () => {
    expect(new Set(ROLES).size).toBe(ROLES.length);
  });
});

describe('isRole', () => {
  it('定義済みのロール文字列を受け入れる', () => {
    expect(isRole('user')).toBe(true);
    expect(isRole('owner')).toBe(true);
    expect(isRole('admin')).toBe(true);
  });

  it('未知の文字列を拒否する', () => {
    expect(isRole('guest')).toBe(false);
  });

  it('空文字を拒否する', () => {
    expect(isRole('')).toBe(false);
  });

  it('大文字違いを拒否する', () => {
    expect(isRole('User')).toBe(false);
  });

  it('前後に空白がある値を拒否する', () => {
    expect(isRole(' user')).toBe(false);
  });

  it('文字列以外を拒否する', () => {
    expect(isRole(null)).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole(1)).toBe(false);
    expect(isRole({})).toBe(false);
    expect(isRole(['user'])).toBe(false);
  });
});

describe('toRole', () => {
  it('定義済みのロールをそのまま返す', () => {
    expect(toRole('owner')).toBe('owner');
  });

  it('未知の文字列を RangeError で拒否する', () => {
    expect(() => toRole('guest')).toThrow(new RangeError('未知のロールです: "guest"'));
  });

  it('null を RangeError で拒否する', () => {
    expect(() => toRole(null)).toThrow(new RangeError('未知のロールです: null'));
  });
});

describe('canManageShop', () => {
  it('店舗管理者とシステム管理者に許可する', () => {
    expect(canManageShop(ROLE_OWNER)).toBe(true);
    expect(canManageShop(ROLE_ADMIN)).toBe(true);
  });

  it('一般利用者には許可しない', () => {
    expect(canManageShop(ROLE_USER)).toBe(false);
  });
});

describe('canModerate', () => {
  it('システム管理者だけに許可する', () => {
    expect(canModerate(ROLE_ADMIN)).toBe(true);
  });

  it('店舗管理者と一般利用者には許可しない', () => {
    expect(canModerate(ROLE_OWNER)).toBe(false);
    expect(canModerate(ROLE_USER)).toBe(false);
  });
});
```

- [x] **Step 3: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/role.test.ts
  ```

  期待: `Tests  16 passed (16)`。

- [x] **Step 4: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/role.ts`）                                          | 変更後                                | 期待: FAIL するテスト（実測）                                                                                                                                                                                                                |
  | --- | -------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `export const ROLES = [ROLE_USER, ROLE_OWNER, ROLE_ADMIN] as const;` | `= [ROLE_USER, ROLE_OWNER] as const;` | `ROLES > 利用者・店舗管理者・システム管理者の 3 種類を宣言順で持つ`、`isRole > 定義済みのロール文字列を受け入れる`（計 2 件。バレル実装後は `@meshimap/core の公開 API > ロールごとに店舗管理とモデレーションの権限が決まる` も加わり 3 件） |
  | 2   | `return role === ROLE_OWNER \|\| role === ROLE_ADMIN;`               | `return role === ROLE_ADMIN;`         | `canManageShop > 店舗管理者とシステム管理者に許可する`                                                                                                                                                                                       |

---

## Task 2-2: ID ブランド型

**Files:**

- Create: `packages/core/src/identifier.ts`
- Test: `packages/core/src/identifier.test.ts`

**Interfaces:**

- Consumes: なし
- Produces:
  - `export type ShopId = string & { readonly [shopIdBrand]: true }`（`UserId` / `ReviewId` / `ReservationId` も同形）
  - `export const IDENTIFIER_MAX_LENGTH: 64`
  - `export const IDENTIFIER_PATTERN: RegExp`（`/^[A-Za-z0-9_-]+$/`）
  - `export function toShopId(value: string): ShopId`（不正値は `RangeError`）
  - `export function toUserId(value: string): UserId` / `toReviewId(value: string): ReviewId` / `toReservationId(value: string): ReservationId`

---

- [x] **Step 1: `packages/core/src/identifier.ts` を作る**

```ts
// 各テーブルの ID をブランド型で区別する。shop_id を user_id の位置に渡す事故をコンパイル時に防ぐ。

declare const shopIdBrand: unique symbol;
declare const userIdBrand: unique symbol;
declare const reviewIdBrand: unique symbol;
declare const reservationIdBrand: unique symbol;

export type ShopId = string & { readonly [shopIdBrand]: true };
export type UserId = string & { readonly [userIdBrand]: true };
export type ReviewId = string & { readonly [reviewIdBrand]: true };
export type ReservationId = string & { readonly [reservationIdBrand]: true };

/** ID の最大長。D1 の TEXT 列に入る現実的な上限。 */
export const IDENTIFIER_MAX_LENGTH = 64;

/** URL とファイル名に安全な文字だけを許可し、SQL やパスの事故を防ぐ。 */
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 4 つの ID で共通の検証。ラベルだけ差し替えてメッセージを具体的にする。 */
function assertIdentifier(label: string, value: string): void {
  if (value.length === 0 || value.length > IDENTIFIER_MAX_LENGTH) {
    throw new RangeError(
      `${label} の長さは 1 〜 ${IDENTIFIER_MAX_LENGTH} 文字である必要があります: "${value}"`,
    );
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new RangeError(`${label} に使用できない文字が含まれています: "${value}"`);
  }
}

export function toShopId(value: string): ShopId {
  assertIdentifier('店舗 ID', value);
  // ブランド型の生成点。ここ以外で as は使わない
  return value as ShopId;
}

export function toUserId(value: string): UserId {
  assertIdentifier('ユーザー ID', value);
  return value as UserId;
}

export function toReviewId(value: string): ReviewId {
  assertIdentifier('レビュー ID', value);
  return value as ReviewId;
}

export function toReservationId(value: string): ReservationId {
  assertIdentifier('予約 ID', value);
  return value as ReservationId;
}
```

`declare const xBrand: unique symbol;` は**型空間だけの宣言**で、実行時のコードを 1 バイトも生成しない。`as` を使ってよいのは各 `toXxxId` の `return value as XxxId;` だけ。

- [x] **Step 2: `packages/core/src/identifier.test.ts` を作る**

```ts
import { describe, expect, it } from 'vitest';
import {
  IDENTIFIER_MAX_LENGTH,
  toReservationId,
  toReviewId,
  toShopId,
  toUserId,
} from './identifier';

describe('IDENTIFIER_MAX_LENGTH', () => {
  it('ID の最大長は 64 文字である', () => {
    expect(IDENTIFIER_MAX_LENGTH).toBe(64);
  });
});

describe('toShopId', () => {
  it('英数字・ハイフン・アンダースコアの ID をそのまま返す', () => {
    expect(toShopId('shop_1-A')).toBe('shop_1-A');
  });

  it('1 文字の ID を受け入れる', () => {
    expect(toShopId('a')).toBe('a');
  });

  it('上限ちょうど 64 文字を受け入れる', () => {
    const value = 'a'.repeat(IDENTIFIER_MAX_LENGTH);
    expect(toShopId(value)).toBe(value);
  });

  it('空文字を拒否する', () => {
    expect(() => toShopId('')).toThrow(
      new RangeError('店舗 ID の長さは 1 〜 64 文字である必要があります: ""'),
    );
  });

  it('上限を 1 文字超えた値を拒否する', () => {
    const value = 'a'.repeat(IDENTIFIER_MAX_LENGTH + 1);
    expect(() => toShopId(value)).toThrow(
      new RangeError(`店舗 ID の長さは 1 〜 64 文字である必要があります: "${value}"`),
    );
  });

  it('日本語を含む値を拒否する', () => {
    expect(() => toShopId('店1')).toThrow(
      new RangeError('店舗 ID に使用できない文字が含まれています: "店1"'),
    );
  });

  it('空白を含む値を拒否する', () => {
    expect(() => toShopId('shop 1')).toThrow(
      new RangeError('店舗 ID に使用できない文字が含まれています: "shop 1"'),
    );
  });

  it('SQL のワイルドカードを含む値を拒否する', () => {
    expect(() => toShopId("shop';--")).toThrow(
      new RangeError('店舗 ID に使用できない文字が含まれています: "shop\';--"'),
    );
  });
});

describe('toUserId / toReviewId / toReservationId', () => {
  it('それぞれ正しい値をそのまま返す', () => {
    expect(toUserId('user_1')).toBe('user_1');
    expect(toReviewId('review_1')).toBe('review_1');
    expect(toReservationId('reservation_1')).toBe('reservation_1');
  });

  it('エラーメッセージに種別名が入る', () => {
    expect(() => toUserId('')).toThrow(
      new RangeError('ユーザー ID の長さは 1 〜 64 文字である必要があります: ""'),
    );
    expect(() => toReviewId('')).toThrow(
      new RangeError('レビュー ID の長さは 1 〜 64 文字である必要があります: ""'),
    );
    expect(() => toReservationId('')).toThrow(
      new RangeError('予約 ID の長さは 1 〜 64 文字である必要があります: ""'),
    );
  });

  it('不正文字のエラーメッセージにも種別名が入る', () => {
    expect(() => toUserId('ユーザー')).toThrow(
      new RangeError('ユーザー ID に使用できない文字が含まれています: "ユーザー"'),
    );
    expect(() => toReviewId('レビュー')).toThrow(
      new RangeError('レビュー ID に使用できない文字が含まれています: "レビュー"'),
    );
    expect(() => toReservationId('予約')).toThrow(
      new RangeError('予約 ID に使用できない文字が含まれています: "予約"'),
    );
  });
});
```

- [x] **Step 3: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/identifier.test.ts
  ```

  期待: `Tests  12 passed (12)`。

- [x] **Step 4: ブランド型が取り違えを弾くことを手で確認する**

  `packages/core/src/identifier.test.ts` の末尾に次の 3 行を**一時的に**追記して型エラーになることを確認し、確認できたら削除する（コンパイルが通らないので、このコードは絶対にコミットしない）。

  ```ts
  // 一時確認用。確認したら消す
  const shopId = toShopId('shop_1');
  const takeUserId = (value: UserId): UserId => value;
  takeUserId(shopId);
  ```

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  ```

  期待: `Argument of type 'ShopId' is not assignable to parameter of type 'UserId'.` というエラーが出る（`import type { UserId } from './identifier';` の追加も必要）。確認後、追記した行と import を削除して `npm run typecheck -w @meshimap/core` が通る状態に戻す。

- [x] **Step 5: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/identifier.ts`）                                     | 変更後                                   | 期待: FAIL するテスト（実測）                                                                                                                                                                                                                                                |
  | --- | --------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `if (value.length === 0 \|\| value.length > IDENTIFIER_MAX_LENGTH) {` | `value.length >= IDENTIFIER_MAX_LENGTH`  | `toShopId > 上限ちょうど 64 文字を受け入れる`                                                                                                                                                                                                                                |
  | 2   | `export const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;`               | `/^[A-Za-z0-9_-]+/`（末尾の `$` を外す） | `toShopId > 空白を含む値を拒否する`、`toShopId > SQL のワイルドカードを含む値を拒否する`（**`日本語を含む値を拒否する` は FAIL しない**。値が非 ASCII で始まるため先頭アンカーだけで弾けるから。末尾アンカーの検証には「前半が合法で後半が不正」な値が要る、という実測結果） |

---

## Task 2-3: 分単位時刻 `MinuteOfDay`

**Files:**

- Create: `packages/core/src/minute-of-day.ts`
- Test: `packages/core/src/minute-of-day.test.ts`

**Interfaces:**

- Consumes: `MINUTES_PER_DAY` / `MINUTES_PER_HOUR` / `MINUTE_OF_DAY_MAX` / `MINUTE_OF_DAY_MIN` / `NEXT_DAY_PREFIX`（`./constants`）
- Produces:
  - `export type MinuteOfDay = number & { readonly [minuteOfDayBrand]: true }`
  - `export function toMinuteOfDay(value: number): MinuteOfDay`
  - `export function minuteOfDay(hour: number, minute: number): MinuteOfDay`
  - `export function formatMinuteOfDay(value: MinuteOfDay): string`

---

- [x] **Step 1: `packages/core/src/minute-of-day.ts` を作る**

```ts
// 営業時間を「0 時からの分」で表す型。1080 = 18:00、1530 = 翌 01:30。
// 分の整数で持つことで、日跨ぎ営業の判定が単純な数値比較になる。

import {
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  MINUTE_OF_DAY_MAX,
  MINUTE_OF_DAY_MIN,
  NEXT_DAY_PREFIX,
} from './constants';

declare const minuteOfDayBrand: unique symbol;
export type MinuteOfDay = number & { readonly [minuteOfDayBrand]: true };

/** 生の数値を検証して MinuteOfDay にする。D1 から読んだ値の入口。 */
export function toMinuteOfDay(value: number): MinuteOfDay {
  if (!Number.isInteger(value)) {
    throw new RangeError(`0 時からの分は整数である必要があります: ${value}`);
  }
  if (value < MINUTE_OF_DAY_MIN || value > MINUTE_OF_DAY_MAX) {
    throw new RangeError(
      `0 時からの分は ${MINUTE_OF_DAY_MIN} 〜 ${MINUTE_OF_DAY_MAX} の範囲である必要があります: ${value}`,
    );
  }
  // ブランド型の生成点
  return value as MinuteOfDay;
}

/** 「時:分」から組み立てる。時は 24 以上も許し、25:30 のような翌日表記を受け付ける。 */
export function minuteOfDay(hour: number, minute: number): MinuteOfDay {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new RangeError(`時と分は整数である必要があります: ${hour}:${minute}`);
  }
  if (minute < 0 || minute >= MINUTES_PER_HOUR) {
    throw new RangeError(`分は 0 〜 ${MINUTES_PER_HOUR - 1} の範囲である必要があります: ${minute}`);
  }
  return toMinuteOfDay(hour * MINUTES_PER_HOUR + minute);
}

/** 表示用に整形する。1440 以上は「翌 」を付けて 0 時起点に戻す。 */
export function formatMinuteOfDay(value: MinuteOfDay): string {
  const dayOffset = Math.floor(value / MINUTES_PER_DAY);
  const withinDay = value - dayOffset * MINUTES_PER_DAY;
  const hour = Math.floor(withinDay / MINUTES_PER_HOUR);
  const minute = withinDay - hour * MINUTES_PER_HOUR;
  // 時は 0 詰めしない（18:00 / 9:00）。分は必ず 2 桁にする
  const time = `${hour}:${String(minute).padStart(2, '0')}`;
  return dayOffset === 0 ? time : `${NEXT_DAY_PREFIX}${time}`;
}
```

- [x] **Step 2: `packages/core/src/minute-of-day.test.ts` を作る**

```ts
import { describe, expect, it } from 'vitest';
import { formatMinuteOfDay, minuteOfDay, toMinuteOfDay } from './minute-of-day';

describe('toMinuteOfDay', () => {
  it('下限 0 を受け入れる', () => {
    expect(toMinuteOfDay(0)).toBe(0);
  });

  it('上限 2879（翌 23:59）を受け入れる', () => {
    expect(toMinuteOfDay(2879)).toBe(2879);
  });

  it('日跨ぎ境界の 1440 を受け入れる', () => {
    expect(toMinuteOfDay(1440)).toBe(1440);
  });

  it('負の値を拒否する', () => {
    expect(() => toMinuteOfDay(-1)).toThrow(
      new RangeError('0 時からの分は 0 〜 2879 の範囲である必要があります: -1'),
    );
  });

  it('上限を 1 分超えた 2880 を拒否する', () => {
    expect(() => toMinuteOfDay(2880)).toThrow(
      new RangeError('0 時からの分は 0 〜 2879 の範囲である必要があります: 2880'),
    );
  });

  it('小数を拒否する', () => {
    expect(() => toMinuteOfDay(10.5)).toThrow(
      new RangeError('0 時からの分は整数である必要があります: 10.5'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => toMinuteOfDay(Number.NaN)).toThrow(
      new RangeError('0 時からの分は整数である必要があります: NaN'),
    );
  });

  it('Infinity を拒否する', () => {
    expect(() => toMinuteOfDay(Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('0 時からの分は整数である必要があります: Infinity'),
    );
  });
});

describe('minuteOfDay', () => {
  it('0 時 0 分を 0 に変換する', () => {
    expect(minuteOfDay(0, 0)).toBe(0);
  });

  it('11 時 30 分を 690 に変換する', () => {
    expect(minuteOfDay(11, 30)).toBe(690);
  });

  it('18 時 0 分を 1080 に変換する', () => {
    expect(minuteOfDay(18, 0)).toBe(1080);
  });

  it('22 時 30 分を 1350 に変換する', () => {
    expect(minuteOfDay(22, 30)).toBe(1350);
  });

  it('23 時 59 分を 1439 に変換する', () => {
    expect(minuteOfDay(23, 59)).toBe(1439);
  });

  it('翌 1 時 30 分（25:30）を 1530 に変換する', () => {
    expect(minuteOfDay(25, 30)).toBe(1530);
  });

  it('翌 2 時 0 分（26:00）を 1560 に変換する', () => {
    expect(minuteOfDay(26, 0)).toBe(1560);
  });

  it('上限の 47 時 59 分を 2879 に変換する', () => {
    expect(minuteOfDay(47, 59)).toBe(2879);
  });

  it('48 時 0 分は範囲外として拒否する', () => {
    expect(() => minuteOfDay(48, 0)).toThrow(
      new RangeError('0 時からの分は 0 〜 2879 の範囲である必要があります: 2880'),
    );
  });

  it('分が 60 以上の値を拒否する', () => {
    expect(() => minuteOfDay(1, 60)).toThrow(
      new RangeError('分は 0 〜 59 の範囲である必要があります: 60'),
    );
  });

  it('分が負の値を拒否する', () => {
    expect(() => minuteOfDay(1, -1)).toThrow(
      new RangeError('分は 0 〜 59 の範囲である必要があります: -1'),
    );
  });

  it('時が小数の値を拒否する', () => {
    expect(() => minuteOfDay(1.5, 0)).toThrow(
      new RangeError('時と分は整数である必要があります: 1.5:0'),
    );
  });

  it('分が小数の値を拒否する', () => {
    expect(() => minuteOfDay(1, 0.5)).toThrow(
      new RangeError('時と分は整数である必要があります: 1:0.5'),
    );
  });
});

describe('formatMinuteOfDay', () => {
  it('0 分を "0:00" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(0))).toBe('0:00');
  });

  it('分は必ず 2 桁ゼロ埋めする', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(5))).toBe('0:05');
  });

  it('60 分を "1:00" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(60))).toBe('1:00');
  });

  it('690 分を "11:30" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(690))).toBe('11:30');
  });

  it('1080 分を "18:00" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(1080))).toBe('18:00');
  });

  it('1439 分（当日最後の分）を "23:59" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(1439))).toBe('23:59');
  });

  it('1440 分から翌日扱いになり "翌 0:00" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(1440))).toBe('翌 0:00');
  });

  it('1530 分を "翌 1:30" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(1530))).toBe('翌 1:30');
  });

  it('1560 分を "翌 2:00" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(1560))).toBe('翌 2:00');
  });

  it('上限 2879 分を "翌 23:59" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(2879))).toBe('翌 23:59');
  });
});
```

- [x] **Step 3: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/minute-of-day.test.ts
  ```

  期待: `Tests  31 passed (31)`。

- [x] **Step 4: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/minute-of-day.ts`）                              | 変更後                       | 期待: FAIL するテスト（実測）                                                                                                                                                                                                                                                                                                               |
  | --- | ----------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `if (value < MINUTE_OF_DAY_MIN \|\| value > MINUTE_OF_DAY_MAX) {` | `value >= MINUTE_OF_DAY_MAX` | `toMinuteOfDay > 上限 2879（翌 23:59）を受け入れる`、`minuteOfDay > 上限の 47 時 59 分を 2879 に変換する`、`formatMinuteOfDay > 上限 2879 分を "翌 23:59" と表示する`（3 件）                                                                                                                                                               |
  | 2   | `String(minute).padStart(2, '0')`                                 | `padStart(1, '0')`           | `formatMinuteOfDay` の 6 件（`分は必ず 2 桁ゼロ埋めする` / `0 分を "0:00" と表示する` / `60 分を "1:00" と表示する` / `1080 分を "18:00" と表示する` / `1440 分から翌日扱いになり "翌 0:00" と表示する` / `1560 分を "翌 2:00" と表示する`）。分が 1 桁の期待値を持つテストが全て落ちるため。計画作成時は 1 件と見積もっていたが実測は 6 件 |

---

## Task 2-4: JST クロック

**Files:**

- Create: `packages/core/src/jst-clock.ts`
- Test: `packages/core/src/jst-clock.test.ts`

**Interfaces:**

- Consumes: `DAYS_PER_WEEK` / `JST_OFFSET_MINUTES` / `MILLISECONDS_PER_DAY` / `MILLISECONDS_PER_MINUTE` / `MINUTES_PER_HOUR`（`./constants`）、`toMinuteOfDay` と `type MinuteOfDay`（`./minute-of-day`）
- Produces:
  - `export type JstDate = string & { readonly [jstDateBrand]: true }`
  - `export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6`
  - `export type JstClock = { readonly date: JstDate; readonly dayOfWeek: DayOfWeek; readonly minuteOfDay: MinuteOfDay }`
  - `export function toJstDate(value: string): JstDate`
  - `export function toDayOfWeek(value: number): DayOfWeek`
  - `export function dayOfWeekOf(date: JstDate): DayOfWeek`
  - `export function addJstDays(date: JstDate, days: number): JstDate`
  - `export function previousDayOfWeek(value: DayOfWeek): DayOfWeek`
  - `export function toJstClock(now: Date): JstClock`

---

- [x] **Step 1: `packages/core/src/jst-clock.ts` を作る**

```ts
// JST（UTC+9）での日付・曜日・時刻を、実行環境のタイムゾーンに依存せずに求める。
// Date のローカル時刻メソッド（getHours 等）は TZ 環境変数で結果が変わるため一切使わず、
// エポックミリ秒に +9 時間してから getUTC* で読む。

import {
  DAYS_PER_WEEK,
  JST_OFFSET_MINUTES,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_MINUTE,
  MINUTES_PER_HOUR,
} from './constants';
import { toMinuteOfDay } from './minute-of-day';
import type { MinuteOfDay } from './minute-of-day';

declare const jstDateBrand: unique symbol;
/** JST の暦日（YYYY-MM-DD）。タイムゾーンを持たない「日付」そのもの。 */
export type JstDate = string & { readonly [jstDateBrand]: true };

/** 0 = 日曜 〜 6 = 土曜。D1 の shop_hours.day_of_week と同じ並び。 */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type JstClock = {
  readonly date: JstDate;
  readonly dayOfWeek: DayOfWeek;
  readonly minuteOfDay: MinuteOfDay;
};

const JST_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Date を UTC のまま YYYY-MM-DD にする。年は 4 桁に 0 詰めする。 */
function formatUtcDate(value: Date): string {
  const year = String(value.getUTCFullYear()).padStart(4, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 文字列を JstDate にする。new Date は 2026-02-30 を 3/2 に繰り上げるので往復比較で弾く。 */
export function toJstDate(value: string): JstDate {
  if (!JST_DATE_PATTERN.test(value)) {
    throw new RangeError(`日付は YYYY-MM-DD 形式である必要があります: "${value}"`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || formatUtcDate(parsed) !== value) {
    throw new RangeError(`存在しない日付です: "${value}"`);
  }
  // ブランド型の生成点
  return value as JstDate;
}

export function toDayOfWeek(value: number): DayOfWeek {
  if (!Number.isInteger(value) || value < 0 || value >= DAYS_PER_WEEK) {
    throw new RangeError(`曜日は 0 〜 ${DAYS_PER_WEEK - 1} の整数である必要があります: ${value}`);
  }
  // ブランド型ではなくリテラル union への絞り込み。検証済みなのでここだけ as を使う
  return value as DayOfWeek;
}

export function dayOfWeekOf(date: JstDate): DayOfWeek {
  return toDayOfWeek(new Date(`${date}T00:00:00Z`).getUTCDay());
}

/** 日付の加減算。UTC 深夜起点で計算するので夏時間の影響を受けない。 */
export function addJstDays(date: JstDate, days: number): JstDate {
  if (!Number.isInteger(days)) {
    throw new RangeError(`日数は整数である必要があります: ${days}`);
  }
  const moved = new Date(new Date(`${date}T00:00:00Z`).getTime() + days * MILLISECONDS_PER_DAY);
  return toJstDate(formatUtcDate(moved));
}

/** 前日の曜日。日跨ぎ営業の判定で「前日の営業時間」を引くために使う。 */
export function previousDayOfWeek(value: DayOfWeek): DayOfWeek {
  return toDayOfWeek((value + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK);
}

/** 現在時刻（UTC 基準の Date）を JST の日付・曜日・分に変換する。 */
export function toJstClock(now: Date): JstClock {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('現在時刻に Invalid Date は渡せません');
  }
  // +9 時間ずらしてから getUTC* で読むと、実行環境の TZ に左右されない
  const shifted = new Date(now.getTime() + JST_OFFSET_MINUTES * MILLISECONDS_PER_MINUTE);
  return {
    date: toJstDate(formatUtcDate(shifted)),
    dayOfWeek: toDayOfWeek(shifted.getUTCDay()),
    minuteOfDay: toMinuteOfDay(shifted.getUTCHours() * MINUTES_PER_HOUR + shifted.getUTCMinutes()),
  };
}
```

**`getHours()` / `getDate()` / `getDay()` などローカル時刻メソッドは 1 つも使わない。** 使った瞬間にテストが実行環境の TZ に依存する。エポックミリ秒に +540 分してから `getUTC*` で読む方式なら、UTC の Cloudflare Workers でも JST の端末でも同じ答えになる。

- [x] **Step 2: `packages/core/src/jst-clock.test.ts` を作る**

  TZ 非依存であることを**テストで固定する**。`process.env.TZ` は使わない（`packages/core/tsconfig.json` の `types` は `["vitest/globals"]` だけなので `process` は `TS2591: Cannot find name 'process'` になる。実測済み）。代わりに `vi.stubEnv('TZ', ...)` を使い、`try/finally` で必ず戻す。

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  addJstDays,
  dayOfWeekOf,
  previousDayOfWeek,
  toDayOfWeek,
  toJstClock,
  toJstDate,
} from './jst-clock';

describe('toJstDate', () => {
  it('YYYY-MM-DD 形式の実在する日付を受け入れる', () => {
    expect(toJstDate('2026-09-15')).toBe('2026-09-15');
  });

  it('閏年の 2 月 29 日を受け入れる', () => {
    expect(toJstDate('2024-02-29')).toBe('2024-02-29');
  });

  it('桁数が足りない形式を拒否する', () => {
    expect(() => toJstDate('2026-9-15')).toThrow(
      new RangeError('日付は YYYY-MM-DD 形式である必要があります: "2026-9-15"'),
    );
  });

  it('区切り文字が違う形式を拒否する', () => {
    expect(() => toJstDate('2026/09/15')).toThrow(
      new RangeError('日付は YYYY-MM-DD 形式である必要があります: "2026/09/15"'),
    );
  });

  it('時刻付きの ISO 文字列を拒否する', () => {
    expect(() => toJstDate('2026-09-15T00:00:00Z')).toThrow(
      new RangeError('日付は YYYY-MM-DD 形式である必要があります: "2026-09-15T00:00:00Z"'),
    );
  });

  it('存在しない 2 月 30 日を拒否する（Date の自動繰り上がりを検知する）', () => {
    expect(() => toJstDate('2026-02-30')).toThrow(
      new RangeError('存在しない日付です: "2026-02-30"'),
    );
  });

  it('平年の 2 月 29 日を拒否する', () => {
    expect(() => toJstDate('2026-02-29')).toThrow(
      new RangeError('存在しない日付です: "2026-02-29"'),
    );
  });

  it('9 月 31 日を拒否する', () => {
    expect(() => toJstDate('2026-09-31')).toThrow(
      new RangeError('存在しない日付です: "2026-09-31"'),
    );
  });

  it('13 月を拒否する', () => {
    expect(() => toJstDate('2026-13-01')).toThrow(
      new RangeError('存在しない日付です: "2026-13-01"'),
    );
  });

  it('0 月を拒否する', () => {
    expect(() => toJstDate('2026-00-10')).toThrow(
      new RangeError('存在しない日付です: "2026-00-10"'),
    );
  });
});

describe('toDayOfWeek', () => {
  it('下限 0（日曜）を受け入れる', () => {
    expect(toDayOfWeek(0)).toBe(0);
  });

  it('上限 6（土曜）を受け入れる', () => {
    expect(toDayOfWeek(6)).toBe(6);
  });

  it('7 を拒否する', () => {
    expect(() => toDayOfWeek(7)).toThrow(
      new RangeError('曜日は 0 〜 6 の整数である必要があります: 7'),
    );
  });

  it('負の値を拒否する', () => {
    expect(() => toDayOfWeek(-1)).toThrow(
      new RangeError('曜日は 0 〜 6 の整数である必要があります: -1'),
    );
  });

  it('小数を拒否する', () => {
    expect(() => toDayOfWeek(1.5)).toThrow(
      new RangeError('曜日は 0 〜 6 の整数である必要があります: 1.5'),
    );
  });
});

describe('dayOfWeekOf', () => {
  it('2026-09-13 は日曜（0）である', () => {
    expect(dayOfWeekOf(toJstDate('2026-09-13'))).toBe(0);
  });

  it('2026-09-15 は火曜（2）である', () => {
    expect(dayOfWeekOf(toJstDate('2026-09-15'))).toBe(2);
  });

  it('2026-09-19 は土曜（6）である', () => {
    expect(dayOfWeekOf(toJstDate('2026-09-19'))).toBe(6);
  });
});

describe('addJstDays', () => {
  it('前日へ戻せる', () => {
    expect(addJstDays(toJstDate('2026-09-15'), -1)).toBe('2026-09-14');
  });

  it('月初から前日へ戻ると前月末になる', () => {
    expect(addJstDays(toJstDate('2026-10-01'), -1)).toBe('2026-09-30');
  });

  it('平年の 3 月 1 日から前日へ戻ると 2 月 28 日になる', () => {
    expect(addJstDays(toJstDate('2026-03-01'), -1)).toBe('2026-02-28');
  });

  it('閏年の 3 月 1 日から前日へ戻ると 2 月 29 日になる', () => {
    expect(addJstDays(toJstDate('2024-03-01'), -1)).toBe('2024-02-29');
  });

  it('年始から前日へ戻ると前年末になる', () => {
    expect(addJstDays(toJstDate('2026-01-01'), -1)).toBe('2025-12-31');
  });

  it('年末から翌日へ進むと翌年始になる', () => {
    expect(addJstDays(toJstDate('2026-12-31'), 1)).toBe('2027-01-01');
  });

  it('0 日移動は同じ日付を返す', () => {
    expect(addJstDays(toJstDate('2026-09-15'), 0)).toBe('2026-09-15');
  });

  it('小数の日数を拒否する', () => {
    expect(() => addJstDays(toJstDate('2026-09-15'), 0.5)).toThrow(
      new RangeError('日数は整数である必要があります: 0.5'),
    );
  });
});

describe('previousDayOfWeek', () => {
  it('火曜（2）の前日は月曜（1）である', () => {
    expect(previousDayOfWeek(2)).toBe(1);
  });

  it('日曜（0）の前日は土曜（6）へ巻き戻る', () => {
    expect(previousDayOfWeek(0)).toBe(6);
  });
});

describe('toJstClock', () => {
  it('UTC 00:00 は JST 09:00 になる', () => {
    expect(toJstClock(new Date('2026-09-15T00:00:00Z'))).toEqual({
      date: '2026-09-15',
      dayOfWeek: 2,
      minuteOfDay: 540,
    });
  });

  it('UTC 14:59:59 はまだ JST の同日 23:59 である', () => {
    expect(toJstClock(new Date('2026-09-15T14:59:59Z'))).toEqual({
      date: '2026-09-15',
      dayOfWeek: 2,
      minuteOfDay: 1439,
    });
  });

  it('UTC 15:00 で JST の日付が翌日 00:00 へ変わる', () => {
    expect(toJstClock(new Date('2026-09-15T15:00:00Z'))).toEqual({
      date: '2026-09-16',
      dayOfWeek: 3,
      minuteOfDay: 0,
    });
  });

  it('秒は切り捨てて分までを返す', () => {
    expect(toJstClock(new Date('2026-09-15T00:00:59Z')).minuteOfDay).toBe(540);
  });

  it('Invalid Date を拒否する', () => {
    expect(() => toJstClock(new Date('不正な日付'))).toThrow(
      new RangeError('現在時刻に Invalid Date は渡せません'),
    );
  });

  it('実行環境のタイムゾーンに依存しない（TZ を差し替えても同じ結果）', () => {
    // TZ を差し替えると Date の各種ローカル時刻メソッドの戻り値は変わる。
    // それでも結果が変わらないことで getUTC* だけで計算していることを保証する。
    const now = new Date('2026-09-15T15:00:00Z');
    const expected = { date: '2026-09-16', dayOfWeek: 3, minuteOfDay: 0 };
    try {
      for (const timeZone of ['Asia/Tokyo', 'UTC', 'America/New_York', 'Pacific/Kiritimati']) {
        vi.stubEnv('TZ', timeZone);
        expect(toJstClock(now)).toEqual(expected);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('toJstDate（前後の余分な文字）', () => {
  it('先頭に余分な文字が付いた日付を拒否する', () => {
    expect(() => toJstDate('x2026-09-15')).toThrow(
      new RangeError('日付は YYYY-MM-DD 形式である必要があります: "x2026-09-15"'),
    );
  });

  it('末尾に余分な文字が付いた日付を拒否する', () => {
    expect(() => toJstDate('2026-09-15x')).toThrow(
      new RangeError('日付は YYYY-MM-DD 形式である必要があります: "2026-09-15x"'),
    );
  });

  it('4 桁未満の年も 0 詰めして往復できる', () => {
    // 年を 0 詰めしないと往復比較が壊れる（"999-12-31" !== "0999-12-31"）
    expect(toJstDate('0999-12-31')).toBe('0999-12-31');
    expect(addJstDays(toJstDate('1000-01-01'), -1)).toBe('0999-12-31');
  });
});
```

- [x] **Step 3: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/jst-clock.test.ts
  ```

  期待: `Tests  37 passed (37)`。

- [x] **Step 4: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/jst-clock.ts`）                                                          | 変更後                                                    | 期待: FAIL するテスト（実測）                                                                                                                                                                                                                                                                                                                                     |
  | --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `const shifted = new Date(now.getTime() + JST_OFFSET_MINUTES * MILLISECONDS_PER_MINUTE);` | `now.getTime() - JST_OFFSET_MINUTES * ...`                | `toJstClock > UTC 00:00 は JST 09:00 になる`、`toJstClock > UTC 14:59:59 はまだ JST の同日 23:59 である`、`toJstClock > UTC 15:00 で JST の日付が翌日 00:00 へ変わる`、`toJstClock > 秒は切り捨てて分までを返す`、`toJstClock > 実行環境のタイムゾーンに依存しない（TZ を差し替えても同じ結果）`（`jst-clock.test.ts` 単体では 5 件。全モジュール実装後は 36 件） |
  | 2   | `if (Number.isNaN(parsed.getTime()) \|\| formatUtcDate(parsed) !== value) {`              | `if (Number.isNaN(parsed.getTime())) {`（往復検証を外す） | `toJstDate > 存在しない 2 月 30 日を拒否する（Date の自動繰り上がりを検知する）`、`toJstDate > 平年の 2 月 29 日を拒否する`、`toJstDate > 9 月 31 日を拒否する`（3 件）                                                                                                                                                                                           |

---

## Task 2-5: 営業時間の型と表示

**Files:**

- Create: `packages/core/src/business-hours.ts`
- Test: `packages/core/src/business-hours.test.ts`

**Interfaces:**

- Consumes: `BUSINESS_HOURS_JOINER` / `BUSINESS_HOURS_SEPARATOR` / `MINUTES_PER_DAY` / `REGULAR_HOLIDAY_LABEL`（`./constants`）、`type DayOfWeek` と `type JstDate`（`./jst-clock`）、`formatMinuteOfDay` と `type MinuteOfDay`（`./minute-of-day`）
- Produces:
  - `export type BusinessHours = { readonly dayOfWeek: DayOfWeek; readonly openMinute: MinuteOfDay; readonly closeMinute: MinuteOfDay; readonly isClosed: boolean }`
  - `export type ShopClosure = { readonly date: JstDate; readonly reason: string }`
  - `export function isOvernight(hours: BusinessHours): boolean`
  - `export function businessHoursOn(hours: readonly BusinessHours[], dayOfWeek: DayOfWeek): readonly BusinessHours[]`
  - `export function formatBusinessHours(hours: readonly BusinessHours[]): string`

---

- [x] **Step 1: `packages/core/src/business-hours.ts` を作る**

```ts
// 曜日ごとの営業時間と臨時休業日の型。D1 の shop_hours / shop_closures に対応する。

import {
  BUSINESS_HOURS_JOINER,
  BUSINESS_HOURS_SEPARATOR,
  MINUTES_PER_DAY,
  REGULAR_HOLIDAY_LABEL,
} from './constants';
import type { DayOfWeek, JstDate } from './jst-clock';
import { formatMinuteOfDay } from './minute-of-day';
import type { MinuteOfDay } from './minute-of-day';

export type BusinessHours = {
  readonly dayOfWeek: DayOfWeek;
  readonly openMinute: MinuteOfDay;
  /** 閉店。1440 を超える値は翌日にまたがることを意味する（1530 = 翌 01:30）。 */
  readonly closeMinute: MinuteOfDay;
  /** 定休日フラグ。行を消さずに残すことで「定休日」と「未登録」を区別する。 */
  readonly isClosed: boolean;
};

export type ShopClosure = {
  readonly date: JstDate;
  readonly reason: string;
};

/** 日跨ぎ営業か。閉店ちょうど 1440（翌 0:00）は当日で閉まる扱いにする。 */
export function isOvernight(hours: BusinessHours): boolean {
  return hours.closeMinute > MINUTES_PER_DAY;
}

/** 指定曜日の営業中の行だけを返す。定休日フラグの行はここで落とす。 */
export function businessHoursOn(
  hours: readonly BusinessHours[],
  dayOfWeek: DayOfWeek,
): readonly BusinessHours[] {
  return hours.filter((entry) => entry.dayOfWeek === dayOfWeek && !entry.isClosed);
}

/** 1 曜日分の営業時間を表示用に整形する。昼夜 2 部は " / " でつなぐ。 */
export function formatBusinessHours(hours: readonly BusinessHours[]): string {
  const dayOfWeeks = new Set(hours.map((entry) => entry.dayOfWeek));
  if (dayOfWeeks.size > 1) {
    throw new RangeError('formatBusinessHours には同一曜日の営業時間だけを渡してください');
  }
  const openEntries = hours.filter((entry) => !entry.isClosed);
  if (openEntries.length === 0) {
    return REGULAR_HOLIDAY_LABEL;
  }
  // 引数の配列を破壊しないよう複製してから並べ替える（lib は ES2022 なので toSorted は使えない）
  return [...openEntries]
    .sort((left, right) => left.openMinute - right.openMinute)
    .map(
      (entry) =>
        `${formatMinuteOfDay(entry.openMinute)}${BUSINESS_HOURS_SEPARATOR}${formatMinuteOfDay(entry.closeMinute)}`,
    )
    .join(BUSINESS_HOURS_JOINER);
}
```

**`toSorted` は使えない。** `tsconfig.base.json` の `lib` は `["ES2022"]` なので `Array.prototype.toSorted`（ES2023）の型定義が存在せず、`Property 'toSorted' does not exist on type 'BusinessHours[]'` になる。引数配列を壊さないために `[...openEntries].sort(...)` と書く。`toReversed` / `Object.groupBy` も同じ理由で使えない。

- [x] **Step 2: `packages/core/src/business-hours.test.ts` を作る**

```ts
import { describe, expect, it } from 'vitest';
import { businessHoursOn, formatBusinessHours, isOvernight } from './business-hours';
import type { BusinessHours } from './business-hours';
import type { DayOfWeek } from './jst-clock';
import { toMinuteOfDay } from './minute-of-day';

function hours(
  dayOfWeek: DayOfWeek,
  openMinute: number,
  closeMinute: number,
  isClosed = false,
): BusinessHours {
  return {
    dayOfWeek,
    openMinute: toMinuteOfDay(openMinute),
    closeMinute: toMinuteOfDay(closeMinute),
    isClosed,
  };
}

describe('isOvernight', () => {
  it('閉店が 1440 を超えていれば日跨ぎと判定する', () => {
    expect(isOvernight(hours(2, 1080, 1530))).toBe(true);
  });

  it('閉店ちょうど 1440（翌 0:00）は日跨ぎではない', () => {
    expect(isOvernight(hours(2, 1080, 1440))).toBe(false);
  });

  it('当日中に閉まる営業時間は日跨ぎではない', () => {
    expect(isOvernight(hours(2, 1020, 1380))).toBe(false);
  });
});

describe('businessHoursOn', () => {
  const week: readonly BusinessHours[] = [
    hours(2, 690, 840),
    hours(2, 1020, 1380),
    hours(3, 0, 0, true),
    hours(4, 1080, 1530),
  ];

  it('指定した曜日の行だけを返す', () => {
    expect(businessHoursOn(week, 4)).toEqual([hours(4, 1080, 1530)]);
  });

  it('同じ曜日に複数の営業帯があればすべて返す', () => {
    expect(businessHoursOn(week, 2)).toHaveLength(2);
  });

  it('定休日フラグが立った行は除外する', () => {
    expect(businessHoursOn(week, 3)).toEqual([]);
  });

  it('行が無い曜日は空配列を返す', () => {
    expect(businessHoursOn(week, 0)).toEqual([]);
  });

  it('元の配列を書き換えない', () => {
    const before = [...week];
    businessHoursOn(week, 2);
    expect(week).toEqual(before);
  });
});

describe('formatBusinessHours', () => {
  it('日跨ぎ営業を "18:00 - 翌 1:30" と表示する', () => {
    expect(formatBusinessHours([hours(2, 1080, 1530)])).toBe('18:00 - 翌 1:30');
  });

  it('深夜 2 時閉店を "22:30 - 翌 2:00" と表示する', () => {
    expect(formatBusinessHours([hours(2, 1350, 1560)])).toBe('22:30 - 翌 2:00');
  });

  it('昼夜 2 部営業をスラッシュ区切りで表示する', () => {
    expect(formatBusinessHours([hours(2, 690, 840), hours(2, 1020, 1380)])).toBe(
      '11:30 - 14:00 / 17:00 - 23:00',
    );
  });

  it('入力順が逆でも開店時刻の昇順に並べ替えて表示する', () => {
    expect(formatBusinessHours([hours(2, 1020, 1380), hours(2, 690, 840)])).toBe(
      '11:30 - 14:00 / 17:00 - 23:00',
    );
  });

  it('元の配列を並べ替えない', () => {
    const input = [hours(2, 1020, 1380), hours(2, 690, 840)];
    formatBusinessHours(input);
    expect(input[0]?.openMinute).toBe(1020);
  });

  it('定休日フラグだけの曜日を "定休日" と表示する', () => {
    expect(formatBusinessHours([hours(3, 0, 0, true)])).toBe('定休日');
  });

  it('行が 1 つも無い曜日を "定休日" と表示する', () => {
    expect(formatBusinessHours([])).toBe('定休日');
  });

  it('24 時間営業を "0:00 - 翌 0:00" と表示する', () => {
    expect(formatBusinessHours([hours(2, 0, 1440)])).toBe('0:00 - 翌 0:00');
  });

  it('複数曜日を混ぜて渡すと拒否する', () => {
    expect(() => formatBusinessHours([hours(1, 600, 1200), hours(2, 600, 1200)])).toThrow(
      new RangeError('formatBusinessHours には同一曜日の営業時間だけを渡してください'),
    );
  });
});
```

- [x] **Step 3: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/business-hours.test.ts
  ```

  期待: `Tests  17 passed (17)`。

- [x] **Step 4: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/business-hours.ts`）                        | 変更後                                       | 期待: FAIL するテスト（実測）                                                                                                                       |
  | --- | ------------------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `return hours.closeMinute > MINUTES_PER_DAY;`                | `>= MINUTES_PER_DAY`                         | `isOvernight > 閉店ちょうど 1440（翌 0:00）は日跨ぎではない`                                                                                        |
  | 2   | `.sort((left, right) => left.openMinute - right.openMinute)` | `right.openMinute - left.openMinute`（降順） | `formatBusinessHours > 昼夜 2 部営業をスラッシュ区切りで表示する`、`formatBusinessHours > 入力順が逆でも開店時刻の昇順に並べ替えて表示する`（2 件） |

---

## Task 2-6: 営業中判定と営業ステータス

**Files:**

- Create: `packages/core/src/open-status.ts`
- Test: `packages/core/src/open-status.test.ts`

**Interfaces:**

- Consumes: `CLOSING_SOON_THRESHOLD_MINUTES` / `MINUTES_PER_DAY`（`./constants`）、`businessHoursOn` と `type BusinessHours` / `type ShopClosure`（`./business-hours`）、`addJstDays` / `previousDayOfWeek` / `toJstClock` / `type JstDate`（`./jst-clock`）
- Produces:
  - `export type OpenStatus = 'open' | 'closing-soon' | 'closed' | 'regular-holiday'`
  - `export function minutesUntilClose(hours: readonly BusinessHours[], closures: readonly ShopClosure[], now: Date): number | null`
  - `export function isCurrentlyOpen(hours: readonly BusinessHours[], closures: readonly ShopClosure[], now: Date): boolean`
  - `export function getOpenStatus(hours: readonly BusinessHours[], closures: readonly ShopClosure[], now: Date): OpenStatus`

---

- [x] **Step 1: `packages/core/src/open-status.ts` を作る**

```ts
// 「いま営業中か」の判定。当日分と、前日から続く日跨ぎ分の両方を見る必要がある。

import { CLOSING_SOON_THRESHOLD_MINUTES, MINUTES_PER_DAY } from './constants';
import { businessHoursOn } from './business-hours';
import type { BusinessHours, ShopClosure } from './business-hours';
import { addJstDays, previousDayOfWeek, toJstClock } from './jst-clock';
import type { JstDate } from './jst-clock';

export type OpenStatus = 'open' | 'closing-soon' | 'closed' | 'regular-holiday';

function hasClosure(closures: readonly ShopClosure[], date: JstDate): boolean {
  return closures.some((closure) => closure.date === date);
}

/** 閉店までの残り分。営業時間外なら null。昼夜 2 部では短い方（いまいる部）を返す。 */
export function minutesUntilClose(
  hours: readonly BusinessHours[],
  closures: readonly ShopClosure[],
  now: Date,
): number | null {
  const clock = toJstClock(now);
  let shortest: number | null = null;

  // 当日分。開店ちょうどは営業中、閉店ちょうどは営業時間外
  if (!hasClosure(closures, clock.date)) {
    for (const entry of businessHoursOn(hours, clock.dayOfWeek)) {
      if (clock.minuteOfDay >= entry.openMinute && clock.minuteOfDay < entry.closeMinute) {
        const remaining = entry.closeMinute - clock.minuteOfDay;
        // 比較演算子で書くと <= に変えても結果が同じ等価変異が残るため Math.min を使う
        shortest = shortest === null ? remaining : Math.min(shortest, remaining);
      }
    }
  }

  // 前日から続く日跨ぎ分。臨時休業の判定も前日の日付で行う
  if (!hasClosure(closures, addJstDays(clock.date, -1))) {
    // shifted は必ず 1440 以上なので、閉店が 1440 以下の当日で閉まる行は自然に外れる。
    // isOvernight での事前判定は結果を変えないため置かない
    const shifted = clock.minuteOfDay + MINUTES_PER_DAY;
    for (const entry of businessHoursOn(hours, previousDayOfWeek(clock.dayOfWeek))) {
      if (shifted >= entry.openMinute && shifted < entry.closeMinute) {
        const remaining = entry.closeMinute - shifted;
        // 比較演算子で書くと <= に変えても結果が同じ等価変異が残るため Math.min を使う
        shortest = shortest === null ? remaining : Math.min(shortest, remaining);
      }
    }
  }

  return shortest;
}

export function isCurrentlyOpen(
  hours: readonly BusinessHours[],
  closures: readonly ShopClosure[],
  now: Date,
): boolean {
  return minutesUntilClose(hours, closures, now) !== null;
}

/** 表示用のステータス。中休みは closed、営業日が無い曜日は regular-holiday と区別する。 */
export function getOpenStatus(
  hours: readonly BusinessHours[],
  closures: readonly ShopClosure[],
  now: Date,
): OpenStatus {
  const remaining = minutesUntilClose(hours, closures, now);
  if (remaining !== null) {
    return remaining <= CLOSING_SOON_THRESHOLD_MINUTES ? 'closing-soon' : 'open';
  }
  const clock = toJstClock(now);
  // 臨時休業は「今日はやっていない」であって定休日ではない
  if (hasClosure(closures, clock.date)) {
    return 'closed';
  }
  return businessHoursOn(hours, clock.dayOfWeek).length === 0 ? 'regular-holiday' : 'closed';
}
```

判定の要点（すべて実測で固定した仕様）:

- **開店ちょうどは営業中、閉店ちょうどは営業時間外**（`>= openMinute && < closeMinute`）。
- **前日から続く分**は、現在の分に +1440 してから前日の行と比較する。`shifted` は必ず 1440 以上になるので、当日中に閉まる行（`closeMinute <= 1440`）は条件から自然に外れる。`isOvernight` による事前判定は結果を変えない冗長な条件なので**置かない**（ミューテーションテストで等価変異として生き残ることを実測済み）。
- **臨時休業は日付で判定する。** 日跨ぎ分は「前日の日付」で臨時休業を見る（前日が臨時休業なら、その夜から続く営業も無い）。
- 最短の残り時間を選ぶのに `if (remaining < shortest)` と書くと `<=` に変えても結果が同じ**等価変異**が残るため、`Math.min` を使う（実測で残った変異を潰した形）。
- `getOpenStatus` の優先順: 営業中なら残り 30 分以下で `closing-soon`、それ以外は `open`。営業時間外のときは、当日が臨時休業なら `closed`、その曜日に営業行が無ければ `regular-holiday`、行はあるが時間外（開店前・中休み）なら `closed`。

- [x] **Step 2: `packages/core/src/open-status.test.ts` を作る**

```ts
import { describe, expect, it } from 'vitest';
import type { BusinessHours, ShopClosure } from './business-hours';
import { getOpenStatus, isCurrentlyOpen, minutesUntilClose } from './open-status';
import type { DayOfWeek } from './jst-clock';
import { toJstDate } from './jst-clock';
import { toMinuteOfDay } from './minute-of-day';

function hours(
  dayOfWeek: DayOfWeek,
  openMinute: number,
  closeMinute: number,
  isClosed = false,
): BusinessHours {
  return {
    dayOfWeek,
    openMinute: toMinuteOfDay(openMinute),
    closeMinute: toMinuteOfDay(closeMinute),
    isClosed,
  };
}

function closure(date: string): ShopClosure {
  return { date: toJstDate(date), reason: '臨時休業' };
}

/** 火曜 22:30 開店 → 翌 2:00 閉店、水曜は定休。日跨ぎの代表例。 */
const OVERNIGHT_HOURS: readonly BusinessHours[] = [hours(2, 1350, 1560), hours(3, 0, 0, true)];

/** 火曜の昼 11:30-14:00 と夜 17:00-23:00 の 2 部営業。 */
const TWO_PART_HOURS: readonly BusinessHours[] = [hours(2, 690, 840), hours(2, 1020, 1380)];

const NO_CLOSURES: readonly ShopClosure[] = [];

describe('minutesUntilClose（日跨ぎ営業）', () => {
  it('開店 1 分前は営業時間外として null を返す', () => {
    expect(minutesUntilClose(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T13:29:00Z'))).toBe(
      null,
    );
  });

  it('開店ちょうどは営業中で閉店まで 210 分を返す', () => {
    expect(minutesUntilClose(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T13:30:00Z'))).toBe(
      210,
    );
  });

  it('日付が変わる直前（JST 23:59）は 121 分を返す', () => {
    expect(minutesUntilClose(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T14:59:00Z'))).toBe(
      121,
    );
  });

  it('日付を跨いだ直後（JST 翌 0:00）は前日の営業として 120 分を返す', () => {
    expect(minutesUntilClose(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T15:00:00Z'))).toBe(
      120,
    );
  });

  it('日跨ぎの深夜 1:00 は前日の営業として 60 分を返す', () => {
    expect(minutesUntilClose(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T16:00:00Z'))).toBe(
      60,
    );
  });

  it('閉店ちょうど（JST 翌 2:00）は営業時間外として null を返す', () => {
    expect(minutesUntilClose(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T17:00:00Z'))).toBe(
      null,
    );
  });

  it('当日の臨時休業は当日分の営業を打ち消す', () => {
    expect(
      minutesUntilClose(OVERNIGHT_HOURS, [closure('2026-09-15')], new Date('2026-09-15T14:00:00Z')),
    ).toBe(null);
  });

  it('前日の臨時休業は日跨ぎ分の営業も打ち消す', () => {
    expect(
      minutesUntilClose(OVERNIGHT_HOURS, [closure('2026-09-15')], new Date('2026-09-15T16:00:00Z')),
    ).toBe(null);
  });

  it('関係ない日の臨時休業は営業に影響しない', () => {
    expect(
      minutesUntilClose(OVERNIGHT_HOURS, [closure('2026-09-20')], new Date('2026-09-15T16:00:00Z')),
    ).toBe(60);
  });
});

describe('minutesUntilClose（昼夜 2 部営業）', () => {
  it('昼の部の開店 1 分前は null を返す', () => {
    expect(minutesUntilClose(TWO_PART_HOURS, NO_CLOSURES, new Date('2026-09-15T02:29:00Z'))).toBe(
      null,
    );
  });

  it('昼の部の開店ちょうどは 150 分を返す', () => {
    expect(minutesUntilClose(TWO_PART_HOURS, NO_CLOSURES, new Date('2026-09-15T02:30:00Z'))).toBe(
      150,
    );
  });

  it('中休みは営業時間外として null を返す', () => {
    expect(minutesUntilClose(TWO_PART_HOURS, NO_CLOSURES, new Date('2026-09-15T07:00:00Z'))).toBe(
      null,
    );
  });

  it('夜の部では夜の閉店までの分を返す（昼の部に引きずられない）', () => {
    expect(minutesUntilClose(TWO_PART_HOURS, NO_CLOSURES, new Date('2026-09-15T13:30:00Z'))).toBe(
      30,
    );
  });

  it('営業時間の無い曜日は null を返す', () => {
    expect(minutesUntilClose(TWO_PART_HOURS, NO_CLOSURES, new Date('2026-09-16T03:00:00Z'))).toBe(
      null,
    );
  });
});

describe('minutesUntilClose（24 時間営業）', () => {
  const allDay: readonly BusinessHours[] = [0, 1, 2, 3, 4, 5, 6].map((day) =>
    hours(day as DayOfWeek, 0, 1440),
  );

  it('0:00 ちょうどは残り 1440 分を返す', () => {
    expect(minutesUntilClose(allDay, NO_CLOSURES, new Date('2026-09-14T15:00:00Z'))).toBe(1440);
  });

  it('23:59 は残り 1 分を返す', () => {
    expect(minutesUntilClose(allDay, NO_CLOSURES, new Date('2026-09-15T14:59:00Z'))).toBe(1);
  });
});

describe('isCurrentlyOpen', () => {
  it('営業中は true を返す', () => {
    expect(isCurrentlyOpen(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T16:00:00Z'))).toBe(
      true,
    );
  });

  it('開店ちょうどは true を返す', () => {
    expect(isCurrentlyOpen(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T13:30:00Z'))).toBe(
      true,
    );
  });

  it('閉店ちょうどは false を返す', () => {
    expect(isCurrentlyOpen(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T17:00:00Z'))).toBe(
      false,
    );
  });

  it('臨時休業日は false を返す', () => {
    expect(
      isCurrentlyOpen(OVERNIGHT_HOURS, [closure('2026-09-15')], new Date('2026-09-15T14:00:00Z')),
    ).toBe(false);
  });
});

describe('getOpenStatus', () => {
  it('閉店まで 31 分以上あれば open を返す', () => {
    expect(getOpenStatus(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T16:29:00Z'))).toBe(
      'open',
    );
  });

  it('閉店ちょうど 30 分前は closing-soon を返す', () => {
    expect(getOpenStatus(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T16:30:00Z'))).toBe(
      'closing-soon',
    );
  });

  it('閉店 1 分前も closing-soon を返す', () => {
    expect(getOpenStatus(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T16:59:00Z'))).toBe(
      'closing-soon',
    );
  });

  it('開店ちょうどは open を返す', () => {
    expect(getOpenStatus(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T13:30:00Z'))).toBe(
      'open',
    );
  });

  it('営業時間のある曜日の開店前は closed を返す', () => {
    expect(getOpenStatus(TWO_PART_HOURS, NO_CLOSURES, new Date('2026-09-15T02:29:00Z'))).toBe(
      'closed',
    );
  });

  it('中休みは closed を返す（定休日ではない）', () => {
    expect(getOpenStatus(TWO_PART_HOURS, NO_CLOSURES, new Date('2026-09-15T07:00:00Z'))).toBe(
      'closed',
    );
  });

  it('定休日フラグの曜日は regular-holiday を返す', () => {
    expect(getOpenStatus(OVERNIGHT_HOURS, NO_CLOSURES, new Date('2026-09-15T17:00:00Z'))).toBe(
      'regular-holiday',
    );
  });

  it('営業時間の行が無い曜日も regular-holiday を返す', () => {
    expect(getOpenStatus(TWO_PART_HOURS, NO_CLOSURES, new Date('2026-09-16T03:00:00Z'))).toBe(
      'regular-holiday',
    );
  });

  it('臨時休業日は定休日ではなく closed を返す', () => {
    expect(
      getOpenStatus(OVERNIGHT_HOURS, [closure('2026-09-15')], new Date('2026-09-15T14:00:00Z')),
    ).toBe('closed');
  });

  it('臨時休業で日跨ぎ分が消えた場合はその日の定休判定に従う', () => {
    expect(
      getOpenStatus(OVERNIGHT_HOURS, [closure('2026-09-15')], new Date('2026-09-15T16:00:00Z')),
    ).toBe('regular-holiday');
  });

  it('24 時間営業は閉店 1 分前に closing-soon になる', () => {
    const allDay: readonly BusinessHours[] = [0, 1, 2, 3, 4, 5, 6].map((day) =>
      hours(day as DayOfWeek, 0, 1440),
    );
    expect(getOpenStatus(allDay, NO_CLOSURES, new Date('2026-09-15T14:59:00Z'))).toBe(
      'closing-soon',
    );
  });
});

describe('minutesUntilClose（境界と重複した営業帯）', () => {
  it('昼の部の閉店ちょうど（14:00）は null を返す', () => {
    expect(minutesUntilClose(TWO_PART_HOURS, NO_CLOSURES, new Date('2026-09-15T05:00:00Z'))).toBe(
      null,
    );
  });

  it('営業帯が重なっていたら短い方の残り時間を返す（短い行が先）', () => {
    const overlapped = [hours(2, 720, 840), hours(2, 660, 900)];
    expect(minutesUntilClose(overlapped, NO_CLOSURES, new Date('2026-09-15T04:00:00Z'))).toBe(60);
  });

  it('営業帯が重なっていたら短い方の残り時間を返す（長い行が先）', () => {
    const overlapped = [hours(2, 660, 900), hours(2, 720, 840)];
    expect(minutesUntilClose(overlapped, NO_CLOSURES, new Date('2026-09-15T04:00:00Z'))).toBe(60);
  });

  it('日跨ぎの営業帯が重なっていたら短い方を返す（短い行が先）', () => {
    const overlapped = [hours(2, 1380, 1560), hours(2, 1320, 1620)];
    expect(minutesUntilClose(overlapped, NO_CLOSURES, new Date('2026-09-15T16:00:00Z'))).toBe(60);
  });

  it('日跨ぎの営業帯が重なっていたら短い方を返す（長い行が先）', () => {
    const overlapped = [hours(2, 1320, 1620), hours(2, 1380, 1560)];
    expect(minutesUntilClose(overlapped, NO_CLOSURES, new Date('2026-09-15T16:00:00Z'))).toBe(60);
  });

  it('日付が変わってから開く行（翌 1:00 開店）は開店ちょうどで営業中になる', () => {
    // 火曜の行として openMinute 1500（翌 1:00）を登録した深夜営業の店
    const afterMidnight = [hours(2, 1500, 1620)];
    expect(minutesUntilClose(afterMidnight, NO_CLOSURES, new Date('2026-09-15T16:00:00Z'))).toBe(
      120,
    );
  });
});

describe('getOpenStatus（臨時休業と定休日の優先順）', () => {
  it('定休日に臨時休業が重なったら regular-holiday ではなく closed を返す', () => {
    // 2026-09-16 は水曜（定休）。そこに臨時休業を登録した場合は closed を優先する
    expect(
      getOpenStatus(OVERNIGHT_HOURS, [closure('2026-09-16')], new Date('2026-09-16T03:00:00Z')),
    ).toBe('closed');
  });
});

describe('前日の営業時間が当日の判定に混ざらないこと', () => {
  /** 月曜と火曜がどちらも 11:00 - 14:00。日跨ぎではないので前日分は無視される。 */
  const weekdayLunch: readonly BusinessHours[] = [hours(1, 660, 840), hours(2, 660, 840)];

  it('前日にも営業時間があっても当日の閉店までの分数を返す', () => {
    // 2026-09-15T03:00:00Z = 火曜 12:00 JST
    expect(minutesUntilClose(weekdayLunch, [], new Date('2026-09-15T03:00:00Z'))).toBe(120);
  });

  it('前日の営業時間だけでは営業中にならない', () => {
    // 2026-09-15T08:00:00Z = 火曜 17:00 JST。当日の 14:00 閉店後
    expect(isCurrentlyOpen(weekdayLunch, [], new Date('2026-09-15T08:00:00Z'))).toBe(false);
  });
});

describe('日付が変わってから開く前日の行', () => {
  /** 月曜の欄が「翌 1:00 - 翌 3:00」。火曜の 0:30 はまだ開店前。 */
  const lateNight: readonly BusinessHours[] = [hours(1, 1500, 1620)];

  it('開店前（火曜 0:30）は営業時間外', () => {
    // 2026-09-14T15:30:00Z = 火曜 0:30 JST
    expect(minutesUntilClose(lateNight, [], new Date('2026-09-14T15:30:00Z'))).toBeNull();
  });

  it('開店後（火曜 1:30）は閉店までの分数を返す', () => {
    // 2026-09-14T16:30:00Z = 火曜 1:30 JST
    expect(minutesUntilClose(lateNight, [], new Date('2026-09-14T16:30:00Z'))).toBe(90);
  });
});
```

- [x] **Step 3: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/open-status.test.ts
  ```

  期待: `Tests  42 passed (42)`。

- [x] **Step 4: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/open-status.ts`）                                                      | 変更後                                       | 期待: FAIL するテスト（実測）                                                                                                                                                 |
  | --- | --------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `if (clock.minuteOfDay >= entry.openMinute && clock.minuteOfDay < entry.closeMinute) {` | `clock.minuteOfDay <= entry.closeMinute`     | `minutesUntilClose（境界と重複した営業帯） > 昼の部の閉店ちょうど（14:00）は null を返す`                                                                                     |
  | 2   | `return remaining <= CLOSING_SOON_THRESHOLD_MINUTES ? 'closing-soon' : 'open';`         | `remaining < CLOSING_SOON_THRESHOLD_MINUTES` | `getOpenStatus > 閉店ちょうど 30 分前は closing-soon を返す`（バレル実装後は `@meshimap/core の公開 API > 日跨ぎ営業の残り時間からステータスを判定できる` も FAIL して 2 件） |
  | 3   | `if (shifted >= entry.openMinute && shifted < entry.closeMinute) {`                     | `if (true && shifted < entry.closeMinute) {` | `日付が変わってから開く前日の行 > 開店前（火曜 0:30）は営業時間外`                                                                                                            |

---

## Task 2-7: 予約枠生成

**Files:**

- Create: `packages/core/src/reservation-slot.ts`
- Test: `packages/core/src/reservation-slot.test.ts`

**Interfaces:**

- Consumes: `MAX_PARALLEL_MAX` / `MAX_PARALLEL_MIN` / `SEAT_CAPACITY_MAX` / `SEAT_CAPACITY_MIN` / `SLOT_MINUTES_MAX` / `SLOT_MINUTES_MIN`（`./constants`）、`businessHoursOn` と `type BusinessHours`（`./business-hours`）、`dayOfWeekOf` と `type JstDate`（`./jst-clock`）、`toMinuteOfDay` と `type MinuteOfDay`（`./minute-of-day`）
- Produces:
  - `export type SeatSettings = { readonly capacity: number; readonly slotMinutes: number; readonly maxParallel: number; readonly acceptsReservation: boolean }`
  - `export type ReservationSlot = { readonly startMinute: MinuteOfDay; readonly endMinute: MinuteOfDay }`
  - `export function assertSeatSettings(seatSettings: SeatSettings): void`
  - `export function generateSlots(hours: readonly BusinessHours[], seatSettings: SeatSettings, date: JstDate): readonly ReservationSlot[]`

---

- [x] **Step 1: `packages/core/src/reservation-slot.ts` を作る**

```ts
// 営業時間から予約枠を切り出す。D1 の seat_settings（capacity / slot_minutes / max_parallel）に対応。

import {
  MAX_PARALLEL_MAX,
  MAX_PARALLEL_MIN,
  SEAT_CAPACITY_MAX,
  SEAT_CAPACITY_MIN,
  SLOT_MINUTES_MAX,
  SLOT_MINUTES_MIN,
} from './constants';
import { businessHoursOn } from './business-hours';
import type { BusinessHours } from './business-hours';
import { dayOfWeekOf } from './jst-clock';
import type { JstDate } from './jst-clock';
import { toMinuteOfDay } from './minute-of-day';
import type { MinuteOfDay } from './minute-of-day';

export type SeatSettings = {
  readonly capacity: number;
  readonly slotMinutes: number;
  /** 同一枠で受け付ける予約「件数」の上限。席数とは別枠の制限。 */
  readonly maxParallel: number;
  readonly acceptsReservation: boolean;
};

export type ReservationSlot = {
  readonly startMinute: MinuteOfDay;
  readonly endMinute: MinuteOfDay;
};

/** 席設定の検証。枠生成と予約可否の両方から呼ぶので独立した関数にする。 */
export function assertSeatSettings(seatSettings: SeatSettings): void {
  if (
    !Number.isInteger(seatSettings.slotMinutes) ||
    seatSettings.slotMinutes < SLOT_MINUTES_MIN ||
    seatSettings.slotMinutes > SLOT_MINUTES_MAX
  ) {
    throw new RangeError(
      `予約枠の長さは ${SLOT_MINUTES_MIN} 〜 ${SLOT_MINUTES_MAX} 分の整数である必要があります: ${seatSettings.slotMinutes}`,
    );
  }
  if (
    !Number.isInteger(seatSettings.capacity) ||
    seatSettings.capacity < SEAT_CAPACITY_MIN ||
    seatSettings.capacity > SEAT_CAPACITY_MAX
  ) {
    throw new RangeError(
      `席数は ${SEAT_CAPACITY_MIN} 〜 ${SEAT_CAPACITY_MAX} の整数である必要があります: ${seatSettings.capacity}`,
    );
  }
  if (
    !Number.isInteger(seatSettings.maxParallel) ||
    seatSettings.maxParallel < MAX_PARALLEL_MIN ||
    seatSettings.maxParallel > MAX_PARALLEL_MAX
  ) {
    throw new RangeError(
      `同時受付数は ${MAX_PARALLEL_MIN} 〜 ${MAX_PARALLEL_MAX} の整数である必要があります: ${seatSettings.maxParallel}`,
    );
  }
}

/**
 * 指定日の予約枠を開店時刻から順に切り出す。閉店をまたぐ端数は捨てる。
 * acceptsReservation は「枠が存在するか」とは別の話なので、ここでは見ない（canReserve の責務）。
 */
export function generateSlots(
  hours: readonly BusinessHours[],
  seatSettings: SeatSettings,
  date: JstDate,
): readonly ReservationSlot[] {
  assertSeatSettings(seatSettings);
  const slots: ReservationSlot[] = [];
  for (const entry of businessHoursOn(hours, dayOfWeekOf(date))) {
    // start は加算していくので MinuteOfDay ではなく number として持つ
    for (
      let start: number = entry.openMinute;
      start + seatSettings.slotMinutes <= entry.closeMinute;
      start += seatSettings.slotMinutes
    ) {
      slots.push({
        startMinute: toMinuteOfDay(start),
        endMinute: toMinuteOfDay(start + seatSettings.slotMinutes),
      });
    }
  }
  // 昼夜 2 部が逆順で登録されていても開始時刻の昇順で返す
  return [...slots].sort((left, right) => left.startMinute - right.startMinute);
}
```

`let start: number = entry.openMinute;` と**型注釈を明示する**理由: 注釈が無いと `start` が `MinuteOfDay` に推論され、`start += seatSettings.slotMinutes` が `Type 'number' is not assignable to type 'MinuteOfDay'` になる。ループ中は素の `number` として扱い、枠を作る瞬間に `toMinuteOfDay` で検証して戻す。

`acceptsReservation` を**ここで見ない**理由: 「枠が存在するか」と「いま受け付けているか」は別の関心事で、受付停止中でも枠の一覧（満席表示）は出したい。受付可否は `canReserve`（Task 2-8）の責務。

- [x] **Step 2: `packages/core/src/reservation-slot.test.ts` を作る**

```ts
import { describe, expect, it } from 'vitest';
import type { BusinessHours } from './business-hours';
import type { DayOfWeek } from './jst-clock';
import { toJstDate } from './jst-clock';
import { toMinuteOfDay } from './minute-of-day';
import { assertSeatSettings, generateSlots } from './reservation-slot';
import type { ReservationSlot, SeatSettings } from './reservation-slot';

function hours(
  dayOfWeek: DayOfWeek,
  openMinute: number,
  closeMinute: number,
  isClosed = false,
): BusinessHours {
  return {
    dayOfWeek,
    openMinute: toMinuteOfDay(openMinute),
    closeMinute: toMinuteOfDay(closeMinute),
    isClosed,
  };
}

function seatSettings(overrides: Partial<SeatSettings> = {}): SeatSettings {
  return {
    capacity: 10,
    slotMinutes: 90,
    maxParallel: 3,
    acceptsReservation: true,
    ...overrides,
  };
}

/** 検証を読みやすくするため [開始, 終了] の組に落とす。 */
function toPairs(slots: readonly ReservationSlot[]): readonly (readonly [number, number])[] {
  return slots.map((slot) => [slot.startMinute, slot.endMinute] as const);
}

/** 2026-09-15 は火曜（dayOfWeek = 2）。 */
const TUESDAY = toJstDate('2026-09-15');

describe('assertSeatSettings', () => {
  it('既定の設定を受け入れる', () => {
    expect(() => assertSeatSettings(seatSettings())).not.toThrow();
  });

  it('枠の長さが下限 15 分未満なら拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ slotMinutes: 14 }))).toThrow(
      new RangeError('予約枠の長さは 15 〜 240 分の整数である必要があります: 14'),
    );
  });

  it('枠の長さが上限 240 分を超えたら拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ slotMinutes: 241 }))).toThrow(
      new RangeError('予約枠の長さは 15 〜 240 分の整数である必要があります: 241'),
    );
  });

  it('枠の長さの小数を拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ slotMinutes: 30.5 }))).toThrow(
      new RangeError('予約枠の長さは 15 〜 240 分の整数である必要があります: 30.5'),
    );
  });

  it('席数 0 を拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ capacity: 0 }))).toThrow(
      new RangeError('席数は 1 〜 500 の整数である必要があります: 0'),
    );
  });

  it('席数が上限 500 を超えたら拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ capacity: 501 }))).toThrow(
      new RangeError('席数は 1 〜 500 の整数である必要があります: 501'),
    );
  });

  it('同時受付数 0 を拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ maxParallel: 0 }))).toThrow(
      new RangeError('同時受付数は 1 〜 100 の整数である必要があります: 0'),
    );
  });

  it('同時受付数が上限 100 を超えたら拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ maxParallel: 101 }))).toThrow(
      new RangeError('同時受付数は 1 〜 100 の整数である必要があります: 101'),
    );
  });
});

describe('generateSlots', () => {
  it('営業時間を割り切れる場合は最後の枠が閉店ちょうどで終わる', () => {
    expect(toPairs(generateSlots([hours(2, 1080, 1530)], seatSettings(), TUESDAY))).toEqual([
      [1080, 1170],
      [1170, 1260],
      [1260, 1350],
      [1350, 1440],
      [1440, 1530],
    ]);
  });

  it('割り切れない端数は切り捨てる（閉店をはみ出す枠を作らない）', () => {
    expect(toPairs(generateSlots([hours(2, 1080, 1500)], seatSettings(), TUESDAY))).toEqual([
      [1080, 1170],
      [1170, 1260],
      [1260, 1350],
      [1350, 1440],
    ]);
  });

  it('生成した枠がすべて営業時間内に収まる', () => {
    const slots = generateSlots([hours(2, 1080, 1500)], seatSettings(), TUESDAY);
    for (const slot of slots) {
      expect(slot.startMinute).toBeGreaterThanOrEqual(1080);
      expect(slot.endMinute).toBeLessThanOrEqual(1500);
    }
  });

  it('昼夜 2 部営業では両方の営業帯から枠を作り開始時刻の昇順で返す', () => {
    const twoPart = [hours(2, 1020, 1380), hours(2, 690, 840)];
    expect(toPairs(generateSlots(twoPart, seatSettings({ slotMinutes: 60 }), TUESDAY))).toEqual([
      [690, 750],
      [750, 810],
      [1020, 1080],
      [1080, 1140],
      [1140, 1200],
      [1200, 1260],
      [1260, 1320],
      [1320, 1380],
    ]);
  });

  it('定休日フラグの曜日は空配列を返す', () => {
    expect(generateSlots([hours(2, 0, 0, true)], seatSettings(), TUESDAY)).toEqual([]);
  });

  it('その曜日の営業時間が無ければ空配列を返す', () => {
    expect(generateSlots([hours(1, 600, 1200)], seatSettings(), TUESDAY)).toEqual([]);
  });

  it('枠の長さが営業時間より長ければ空配列を返す', () => {
    expect(
      generateSlots([hours(2, 600, 660)], seatSettings({ slotMinutes: 120 }), TUESDAY),
    ).toEqual([]);
  });

  it('営業時間と枠の長さが同じなら枠は 1 つだけできる', () => {
    expect(
      toPairs(generateSlots([hours(2, 600, 660)], seatSettings({ slotMinutes: 60 }), TUESDAY)),
    ).toEqual([[600, 660]]);
  });

  it('受付停止中でも枠自体は生成する（受付可否は canReserve の責務）', () => {
    expect(
      generateSlots([hours(2, 1080, 1530)], seatSettings({ acceptsReservation: false }), TUESDAY),
    ).toHaveLength(5);
  });

  it('席設定が不正なら枠を作る前に拒否する', () => {
    expect(() =>
      generateSlots([hours(2, 1080, 1530)], seatSettings({ slotMinutes: 0 }), TUESDAY),
    ).toThrow(new RangeError('予約枠の長さは 15 〜 240 分の整数である必要があります: 0'));
  });

  it('元の営業時間配列を並べ替えない', () => {
    const input = [hours(2, 1020, 1380), hours(2, 690, 840)];
    generateSlots(input, seatSettings({ slotMinutes: 60 }), TUESDAY);
    expect(input[0]?.openMinute).toBe(1020);
  });
});

describe('assertSeatSettings（境界ちょうどは受け入れる）', () => {
  it('枠の長さは下限 15 分と上限 240 分を受け入れる', () => {
    expect(() => assertSeatSettings(seatSettings({ slotMinutes: 15 }))).not.toThrow();
    expect(() => assertSeatSettings(seatSettings({ slotMinutes: 240 }))).not.toThrow();
  });

  it('席数は下限 1 と上限 500 を受け入れる', () => {
    expect(() => assertSeatSettings(seatSettings({ capacity: 1 }))).not.toThrow();
    expect(() => assertSeatSettings(seatSettings({ capacity: 500 }))).not.toThrow();
  });

  it('同時受付数は下限 1 と上限 100 を受け入れる', () => {
    expect(() => assertSeatSettings(seatSettings({ maxParallel: 1 }))).not.toThrow();
    expect(() => assertSeatSettings(seatSettings({ maxParallel: 100 }))).not.toThrow();
  });
});
```

- [x] **Step 3: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/reservation-slot.test.ts
  ```

  期待: `Tests  22 passed (22)`。

- [x] **Step 4: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/reservation-slot.ts`）                  | 変更後                     | 期待: FAIL するテスト（実測）                                                                                                                                                                                                                                                                                                                 |
  | --- | -------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `start + seatSettings.slotMinutes <= entry.closeMinute;` | `< entry.closeMinute;`     | `generateSlots > 営業時間を割り切れる場合は最後の枠が閉店ちょうどで終わる`、`generateSlots > 昼夜 2 部営業では両方の営業帯から枠を作り開始時刻の昇順で返す`、`generateSlots > 営業時間と枠の長さが同じなら枠は 1 つだけできる`、`generateSlots > 受付停止中でも枠自体は生成する（受付可否は canReserve の責務）`（4 件。バレル実装後は 5 件） |
  | 2   | `seatSettings.slotMinutes < SLOT_MINUTES_MIN \|\|`       | `<= SLOT_MINUTES_MIN \|\|` | `assertSeatSettings（境界ちょうどは受け入れる） > 枠の長さは下限 15 分と上限 240 分を受け入れる`                                                                                                                                                                                                                                              |

---

## Task 2-8: 予約可否

**Files:**

- Create: `packages/core/src/reservation-availability.ts`
- Test: `packages/core/src/reservation-availability.test.ts`

**Interfaces:**

- Consumes: `PARTY_SIZE_MAX` / `PARTY_SIZE_MIN`（`./constants`）、`assertSeatSettings` と `type ReservationSlot` / `type SeatSettings`（`./reservation-slot`）、`type MinuteOfDay`（`./minute-of-day`）
- Produces:
  - `export type ExistingReservation = { readonly startMinute: MinuteOfDay; readonly partySize: number }`
  - `export type ReservationBlockReason = 'not-accepting' | 'party-too-large' | 'parallel-full' | 'seats-full'`
  - `export type ReservationAvailability = { readonly isAvailable: boolean; readonly reason: ReservationBlockReason | null; readonly remainingSeats: number }`
  - `export type ReservationRequest = { readonly slot: ReservationSlot; readonly seatSettings: SeatSettings; readonly existingReservations: readonly ExistingReservation[]; readonly partySize: number }`
  - `export function canReserve(request: ReservationRequest): ReservationAvailability`

---

- [x] **Step 1: `packages/core/src/reservation-availability.ts` を作る**

```ts
// 予約枠に対して「いま予約を受けられるか」を判定する。理由コードを返して UI の文言を分ける。

import { PARTY_SIZE_MAX, PARTY_SIZE_MIN } from './constants';
import { assertSeatSettings } from './reservation-slot';
import type { ReservationSlot, SeatSettings } from './reservation-slot';
import type { MinuteOfDay } from './minute-of-day';

export type ExistingReservation = {
  readonly startMinute: MinuteOfDay;
  readonly partySize: number;
};

export type ReservationBlockReason =
  'not-accepting' | 'party-too-large' | 'parallel-full' | 'seats-full';

export type ReservationAvailability = {
  readonly isAvailable: boolean;
  readonly reason: ReservationBlockReason | null;
  /** 残席。満席でも 0 で頭打ちにして、負の数を UI に出さない。 */
  readonly remainingSeats: number;
};

export type ReservationRequest = {
  readonly slot: ReservationSlot;
  readonly seatSettings: SeatSettings;
  readonly existingReservations: readonly ExistingReservation[];
  readonly partySize: number;
};

export function canReserve(request: ReservationRequest): ReservationAvailability {
  assertSeatSettings(request.seatSettings);
  if (
    !Number.isInteger(request.partySize) ||
    request.partySize < PARTY_SIZE_MIN ||
    request.partySize > PARTY_SIZE_MAX
  ) {
    throw new RangeError(
      `人数は ${PARTY_SIZE_MIN} 〜 ${PARTY_SIZE_MAX} の整数である必要があります: ${request.partySize}`,
    );
  }

  const sameSlot = request.existingReservations.filter(
    (reservation) => reservation.startMinute === request.slot.startMinute,
  );
  const occupiedSeats = sameSlot.reduce((total, reservation) => total + reservation.partySize, 0);
  const remainingSeats = Math.max(0, request.seatSettings.capacity - occupiedSeats);

  // 判定順が UI の文言を決める。受付停止 → 人数超過 → 件数上限 → 残席不足
  if (!request.seatSettings.acceptsReservation) {
    return { isAvailable: false, reason: 'not-accepting', remainingSeats };
  }
  if (request.partySize > request.seatSettings.capacity) {
    return { isAvailable: false, reason: 'party-too-large', remainingSeats };
  }
  if (sameSlot.length >= request.seatSettings.maxParallel) {
    return { isAvailable: false, reason: 'parallel-full', remainingSeats };
  }
  if (request.partySize > remainingSeats) {
    return { isAvailable: false, reason: 'seats-full', remainingSeats };
  }
  return { isAvailable: true, reason: null, remainingSeats };
}
```

**判定順が UI の文言を決める**ので、順番自体が仕様である: 受付停止（`not-accepting`）→ 人数が席数を超過（`party-too-large`）→ 同時受付件数の上限（`parallel-full`）→ 残席不足（`seats-full`）。この順序はテストで固定する。

- [x] **Step 2: `packages/core/src/reservation-availability.test.ts` を作る**

```ts
import { describe, expect, it } from 'vitest';
import { toMinuteOfDay } from './minute-of-day';
import { canReserve } from './reservation-availability';
import type { ExistingReservation } from './reservation-availability';
import type { ReservationSlot, SeatSettings } from './reservation-slot';

const SLOT: ReservationSlot = {
  startMinute: toMinuteOfDay(1080),
  endMinute: toMinuteOfDay(1170),
};

function seatSettings(overrides: Partial<SeatSettings> = {}): SeatSettings {
  return {
    capacity: 10,
    slotMinutes: 90,
    maxParallel: 3,
    acceptsReservation: true,
    ...overrides,
  };
}

function reservation(startMinute: number, partySize: number): ExistingReservation {
  return { startMinute: toMinuteOfDay(startMinute), partySize };
}

describe('canReserve', () => {
  it('予約が 1 件も無ければ空席は席数どおりで予約できる', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [],
        partySize: 2,
      }),
    ).toEqual({ isAvailable: true, reason: null, remainingSeats: 10 });
  });

  it('残席ちょうどの人数を受け入れる', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1080, 9)],
        partySize: 1,
      }),
    ).toEqual({ isAvailable: true, reason: null, remainingSeats: 1 });
  });

  it('残席を 1 名超えると seats-full で拒否する', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1080, 9)],
        partySize: 2,
      }),
    ).toEqual({ isAvailable: false, reason: 'seats-full', remainingSeats: 1 });
  });

  it('満席なら残席 0 で seats-full を返す', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1080, 6), reservation(1080, 4)],
        partySize: 1,
      }),
    ).toEqual({ isAvailable: false, reason: 'seats-full', remainingSeats: 0 });
  });

  it('同時受付数に達していれば残席があっても parallel-full で拒否する', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1080, 1), reservation(1080, 1), reservation(1080, 1)],
        partySize: 1,
      }),
    ).toEqual({
      isAvailable: false,
      reason: 'parallel-full',
      remainingSeats: 7,
    });
  });

  it('別の枠の予約は残席にも同時受付数にも影響しない', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1170, 5), reservation(1170, 5), reservation(1170, 5)],
        partySize: 1,
      }),
    ).toEqual({ isAvailable: true, reason: null, remainingSeats: 10 });
  });

  it('席数ちょうどの人数は受け入れる', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [],
        partySize: 10,
      }),
    ).toEqual({ isAvailable: true, reason: null, remainingSeats: 10 });
  });

  it('席数を超える人数は party-too-large で拒否する', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [],
        partySize: 11,
      }),
    ).toEqual({
      isAvailable: false,
      reason: 'party-too-large',
      remainingSeats: 10,
    });
  });

  it('受付停止中は他の条件より先に not-accepting を返す', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings({ acceptsReservation: false }),
        existingReservations: [reservation(1080, 10)],
        partySize: 20,
      }),
    ).toEqual({
      isAvailable: false,
      reason: 'not-accepting',
      remainingSeats: 0,
    });
  });

  it('定員超過は同時受付数より先に判定する', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1080, 1), reservation(1080, 1), reservation(1080, 1)],
        partySize: 11,
      }),
    ).toEqual({
      isAvailable: false,
      reason: 'party-too-large',
      remainingSeats: 7,
    });
  });

  it('予約が席数を超えていても残席は 0 で下げ止まる', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings({ capacity: 5, maxParallel: 10 }),
        existingReservations: [reservation(1080, 4), reservation(1080, 4)],
        partySize: 1,
      }),
    ).toEqual({ isAvailable: false, reason: 'seats-full', remainingSeats: 0 });
  });

  it('人数が下限 1 名未満なら拒否する', () => {
    expect(() =>
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [],
        partySize: 0,
      }),
    ).toThrow(new RangeError('人数は 1 〜 20 の整数である必要があります: 0'));
  });

  it('人数が上限 20 名を超えたら拒否する', () => {
    expect(() =>
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings({ capacity: 100 }),
        existingReservations: [],
        partySize: 21,
      }),
    ).toThrow(new RangeError('人数は 1 〜 20 の整数である必要があります: 21'));
  });

  it('人数の小数を拒否する', () => {
    expect(() =>
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [],
        partySize: 2.5,
      }),
    ).toThrow(new RangeError('人数は 1 〜 20 の整数である必要があります: 2.5'));
  });

  it('席設定が不正なら人数判定より先に拒否する', () => {
    expect(() =>
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings({ maxParallel: 0 }),
        existingReservations: [],
        partySize: 0,
      }),
    ).toThrow(new RangeError('同時受付数は 1 〜 100 の整数である必要があります: 0'));
  });
});
```

- [x] **Step 3: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/reservation-availability.test.ts
  ```

  期待: `Tests  15 passed (15)`。

- [x] **Step 4: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/reservation-availability.ts`）                                      | 変更後                                             | 期待: FAIL するテスト（実測）                                                  |
  | --- | ------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------ |
  | 1   | `if (sameSlot.length >= request.seatSettings.maxParallel) {`                         | `> request.seatSettings.maxParallel`               | `canReserve > 同時受付数に達していれば残席があっても parallel-full で拒否する` |
  | 2   | `const remainingSeats = Math.max(0, request.seatSettings.capacity - occupiedSeats);` | `= request.seatSettings.capacity - occupiedSeats;` | `canReserve > 予約が席数を超えていても残席は 0 で下げ止まる`                   |

---

## Task 2-9: 評価集計

**Files:**

- Create: `packages/core/src/rating.ts`
- Test: `packages/core/src/rating.test.ts`

**Interfaces:**

- Consumes: `RATING_MAX` / `RATING_MIN`（`./constants`）
- Produces:
  - `export type Rating = 1 | 2 | 3 | 4 | 5`
  - `export type RatingDistribution = { readonly [K in Rating]: number }`
  - `export type RatingSummary = { readonly average: number; readonly count: number; readonly distribution: RatingDistribution }`
  - `export function toRating(value: number): Rating`
  - `export function summarizeRatings(ratings: readonly Rating[]): RatingSummary`

---

- [x] **Step 1: `packages/core/src/rating.ts` を作る**

```ts
// レビュー評価の集計。D1 の reviews.rating（1〜5）を星の分布と平均にまとめる。

import { RATING_MAX, RATING_MIN } from './constants';

export type Rating = 1 | 2 | 3 | 4 | 5;

/** 星ごとの件数。棒グラフ表示にそのまま使える形にする。 */
export type RatingDistribution = { readonly [K in Rating]: number };

export type RatingSummary = {
  readonly average: number;
  readonly count: number;
  readonly distribution: RatingDistribution;
};

export function toRating(value: number): Rating {
  if (!Number.isInteger(value) || value < RATING_MIN || value > RATING_MAX) {
    throw new RangeError(
      `評価は ${RATING_MIN} 〜 ${RATING_MAX} の整数である必要があります: ${value}`,
    );
  }
  // 検証済みのリテラル union への絞り込み
  return value as Rating;
}

/** 平均は小数第 1 位に丸める。D1 の rating_avg にもこの値を保存する。 */
export function summarizeRatings(ratings: readonly Rating[]): RatingSummary {
  const distribution: Record<Rating, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let totalScore = 0;
  for (const rating of ratings) {
    distribution[rating] += 1;
    totalScore += rating;
  }
  // 0 件で 0 除算にならないよう、集計後に件数を見る
  if (ratings.length === 0) {
    return { average: 0, count: 0, distribution };
  }
  return {
    average: Math.round((totalScore / ratings.length) * 10) / 10,
    count: ratings.length,
    distribution,
  };
}
```

平均は `Math.round((totalScore / ratings.length) * 10) / 10` で小数第 1 位に丸める。**3 件 `[4, 5, 3]` の平均は `4`（`number` 型）** であり `4.0` という値は JavaScript に存在しない。テストは `toBe(4)` で比較する。表示で小数第 1 位を固定したい場合は UI 層（Phase 5）の責務。

- [x] **Step 2: `packages/core/src/rating.test.ts` を作る**

```ts
import { describe, expect, it } from 'vitest';
import { summarizeRatings, toRating } from './rating';
import type { Rating } from './rating';

/** 同じ評価を count 件並べた配列を作る。 */
function repeat(rating: Rating, count: number): readonly Rating[] {
  return Array.from({ length: count }, () => rating);
}

describe('toRating', () => {
  it('下限 1 を受け入れる', () => {
    expect(toRating(1)).toBe(1);
  });

  it('上限 5 を受け入れる', () => {
    expect(toRating(5)).toBe(5);
  });

  it('0 を拒否する', () => {
    expect(() => toRating(0)).toThrow(
      new RangeError('評価は 1 〜 5 の整数である必要があります: 0'),
    );
  });

  it('6 を拒否する', () => {
    expect(() => toRating(6)).toThrow(
      new RangeError('評価は 1 〜 5 の整数である必要があります: 6'),
    );
  });

  it('小数を拒否する', () => {
    expect(() => toRating(4.5)).toThrow(
      new RangeError('評価は 1 〜 5 の整数である必要があります: 4.5'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => toRating(Number.NaN)).toThrow(
      new RangeError('評価は 1 〜 5 の整数である必要があります: NaN'),
    );
  });
});

describe('summarizeRatings', () => {
  it('0 件なら平均 0・件数 0・分布はすべて 0 を返す', () => {
    expect(summarizeRatings([])).toEqual({
      average: 0,
      count: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    });
  });

  it('1 件ならその評価がそのまま平均になる', () => {
    expect(summarizeRatings([toRating(3)])).toEqual({
      average: 3,
      count: 1,
      distribution: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 },
    });
  });

  it('平均が割り切れる場合は小数を付けない数値を返す', () => {
    expect(summarizeRatings([4, 5, 3].map(toRating)).average).toBe(4);
  });

  it('小数第 2 位以下は四捨五入して小数第 1 位に丸める', () => {
    expect(summarizeRatings([4, 5, 4, 4, 5].map(toRating)).average).toBe(4.4);
  });

  it('4.45 は 4.5 に切り上がる', () => {
    const ratings = [...repeat(5, 9), ...repeat(4, 11)];
    expect(ratings).toHaveLength(20);
    expect(summarizeRatings(ratings).average).toBe(4.5);
  });

  it('3.35 は 3.4 に切り上がる（Math.round は 0.5 を切り上げる）', () => {
    const ratings = [...repeat(4, 7), ...repeat(3, 13)];
    expect(ratings).toHaveLength(20);
    expect(summarizeRatings(ratings).average).toBe(3.4);
  });

  it('評価ごとの件数を分布として数える', () => {
    expect(summarizeRatings([5, 4, 4, 3, 5, 5, 1].map(toRating))).toEqual({
      average: 3.9,
      count: 7,
      distribution: { 1: 1, 2: 0, 3: 1, 4: 2, 5: 3 },
    });
  });

  it('件数は入力の長さと一致する', () => {
    expect(summarizeRatings(repeat(2, 123)).count).toBe(123);
  });

  it('分布の合計は件数と一致する', () => {
    const summary = summarizeRatings([1, 2, 3, 4, 5, 5, 5].map(toRating));
    const total = Object.values(summary.distribution).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(summary.count);
  });

  it('呼び出しごとに独立した分布オブジェクトを返す', () => {
    const first = summarizeRatings([toRating(1)]);
    const second = summarizeRatings([toRating(5)]);
    expect(first.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 });
    expect(second.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 });
  });

  it('元の配列を書き換えない', () => {
    const ratings = [5, 1, 3].map(toRating);
    summarizeRatings(ratings);
    expect(ratings).toEqual([5, 1, 3]);
  });
});
```

- [x] **Step 3: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/rating.test.ts
  ```

  期待: `Tests  17 passed (17)`。

- [x] **Step 4: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/rating.ts`）                                   | 変更後                                              | 期待: FAIL するテスト（実測）                                                                                                                                                                                                                                        |
  | --- | --------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `average: Math.round((totalScore / ratings.length) * 10) / 10,` | `average: Math.round(totalScore / ratings.length),` | `summarizeRatings > 小数第 2 位以下は四捨五入して小数第 1 位に丸める`、`summarizeRatings > 4.45 は 4.5 に切り上がる`、`summarizeRatings > 3.35 は 3.4 に切り上がる（Math.round は 0.5 を切り上げる）`、`summarizeRatings > 評価ごとの件数を分布として数える`（4 件） |
  | 2   | `distribution[rating] += 1;`                                    | `distribution[rating] = 1;`                         | `summarizeRatings > 評価ごとの件数を分布として数える`、`summarizeRatings > 分布の合計は件数と一致する`（2 件）                                                                                                                                                       |

---

## Task 2-10: 予算帯の表示

**Files:**

- Create: `packages/core/src/budget.ts`
- Test: `packages/core/src/budget.test.ts`

**Interfaces:**

- Consumes: `BUDGET_YEN_MAX` / `BUDGET_YEN_MIN`（`./constants`）
- Produces:
  - `export const BUDGET_UNSET_LABEL: '－'`
  - `export function formatYen(value: number): string`
  - `export function formatBudgetRange(minYen: number | null, maxYen: number | null): string`

---

- [x] **Step 1: `packages/core/src/budget.ts` を作る**

```ts
// 予算帯の表示。Intl / toLocaleString は React Native（Hermes）で挙動が揺れるので使わない。

import { BUDGET_YEN_MAX, BUDGET_YEN_MIN } from './constants';

const CURRENCY_PREFIX = '¥';
/** 予算が未登録のときの表示。全角ダッシュで桁区切りと紛れないようにする。 */
export const BUDGET_UNSET_LABEL = '－';
const BUDGET_RANGE_SEPARATOR = ' 〜 ';
const BUDGET_FROM_SUFFIX = ' 〜';
const BUDGET_UP_TO_PREFIX = '〜 ';
/** 3 桁ごとの区切り位置（数字が続く境界）にマッチする。 */
const THOUSANDS_SEPARATOR_PATTERN = /\B(?=(\d{3})+(?!\d))/g;

export function formatYen(value: number): string {
  if (!Number.isInteger(value) || value < BUDGET_YEN_MIN || value > BUDGET_YEN_MAX) {
    throw new RangeError(
      `予算は ${BUDGET_YEN_MIN} 〜 ${BUDGET_YEN_MAX} 円の整数である必要があります: ${value}`,
    );
  }
  return `${CURRENCY_PREFIX}${String(value).replace(THOUSANDS_SEPARATOR_PATTERN, ',')}`;
}

/** 下限・上限のどちらが欠けても読める表示にする。 */
export function formatBudgetRange(minYen: number | null, maxYen: number | null): string {
  if (minYen === null) {
    return maxYen === null ? BUDGET_UNSET_LABEL : `${BUDGET_UP_TO_PREFIX}${formatYen(maxYen)}`;
  }
  if (maxYen === null) {
    return `${formatYen(minYen)}${BUDGET_FROM_SUFFIX}`;
  }
  if (minYen > maxYen) {
    throw new RangeError(`予算の下限は上限以下である必要があります: ${minYen} > ${maxYen}`);
  }
  // 下限と上限が同じなら 1 つだけ出す
  return minYen === maxYen
    ? formatYen(minYen)
    : `${formatYen(minYen)}${BUDGET_RANGE_SEPARATOR}${formatYen(maxYen)}`;
}
```

**`Intl` / `toLocaleString` は使わない。** React Native（Hermes）ではロケールデータが省かれたビルドがあり、端末によって `"1,000"` にならないことがある。桁区切りは `/\B(?=(\d{3})+(?!\d))/g` で自前に実装し、`toLocaleString('ja-JP')` との一致は**テスト側でだけ**突き合わせる（Node のロケールは安定しているため、テストの期待値生成には使える）。

- [x] **Step 2: `packages/core/src/budget.test.ts` を作る**

```ts
import { describe, expect, it } from 'vitest';
import { BUDGET_UNSET_LABEL, formatBudgetRange, formatYen } from './budget';

describe('formatYen', () => {
  it('0 円を "¥0" と表示する', () => {
    expect(formatYen(0)).toBe('¥0');
  });

  it('3 桁までは区切り記号を入れない', () => {
    expect(formatYen(999)).toBe('¥999');
  });

  it('4 桁から 3 桁ごとにカンマを入れる', () => {
    expect(formatYen(1000)).toBe('¥1,000');
  });

  it('5 桁を正しく区切る', () => {
    expect(formatYen(12345)).toBe('¥12,345');
  });

  it('上限 100 万円を正しく区切る', () => {
    expect(formatYen(1_000_000)).toBe('¥1,000,000');
  });

  it('上限を 1 円超えたら拒否する', () => {
    expect(() => formatYen(1_000_001)).toThrow(
      new RangeError('予算は 0 〜 1000000 円の整数である必要があります: 1000001'),
    );
  });

  it('負の値を拒否する', () => {
    expect(() => formatYen(-1)).toThrow(
      new RangeError('予算は 0 〜 1000000 円の整数である必要があります: -1'),
    );
  });

  it('小数を拒否する', () => {
    expect(() => formatYen(1000.5)).toThrow(
      new RangeError('予算は 0 〜 1000000 円の整数である必要があります: 1000.5'),
    );
  });

  it('端末のロケール実装に依存せず ja-JP の桁区切りと一致する', () => {
    for (const value of [0, 1, 999, 1000, 1500, 12345, 100000, 1000000]) {
      expect(formatYen(value)).toBe(`¥${value.toLocaleString('ja-JP')}`);
    }
  });
});

describe('formatBudgetRange', () => {
  it('下限と上限が揃っていれば範囲として表示する', () => {
    expect(formatBudgetRange(1000, 3000)).toBe('¥1,000 〜 ¥3,000');
  });

  it('下限と上限が同額なら 1 つだけ表示する', () => {
    expect(formatBudgetRange(2000, 2000)).toBe('¥2,000');
  });

  it('上限が未設定なら下限に「〜」を後置する', () => {
    expect(formatBudgetRange(1000, null)).toBe('¥1,000 〜');
  });

  it('下限が未設定なら上限に「〜」を前置する', () => {
    expect(formatBudgetRange(null, 3000)).toBe('〜 ¥3,000');
  });

  it('どちらも未設定なら未設定ラベルを返す', () => {
    expect(formatBudgetRange(null, null)).toBe(BUDGET_UNSET_LABEL);
    expect(BUDGET_UNSET_LABEL).toBe('－');
  });

  it('0 円同士は "¥0" と表示する（null と 0 を混同しない）', () => {
    expect(formatBudgetRange(0, 0)).toBe('¥0');
  });

  it('下限 0 円の範囲を表示できる', () => {
    expect(formatBudgetRange(0, 999)).toBe('¥0 〜 ¥999');
  });

  it('下限が上限より大きい場合は拒否する', () => {
    expect(() => formatBudgetRange(3000, 1000)).toThrow(
      new RangeError('予算の下限は上限以下である必要があります: 3000 > 1000'),
    );
  });

  it('範囲外の下限は formatYen の検証で拒否される', () => {
    expect(() => formatBudgetRange(-1, 1000)).toThrow(
      new RangeError('予算は 0 〜 1000000 円の整数である必要があります: -1'),
    );
  });

  it('範囲外の上限は formatYen の検証で拒否される', () => {
    expect(() => formatBudgetRange(null, 1_000_001)).toThrow(
      new RangeError('予算は 0 〜 1000000 円の整数である必要があります: 1000001'),
    );
  });
});
```

- [x] **Step 3: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/budget.test.ts
  ```

  期待: `Tests  19 passed (19)`。

- [x] **Step 4: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/budget.ts`）                                                             | 変更後                    | 期待: FAIL するテスト（実測）                                                                                                                                                                                                                      |
  | --- | ----------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `if (minYen > maxYen) {`                                                                  | `if (minYen >= maxYen) {` | `formatBudgetRange > 下限と上限が同額なら 1 つだけ表示する`、`formatBudgetRange > 0 円同士は "¥0" と表示する（null と 0 を混同しない）`（2 件）                                                                                                    |
  | 2   | `if (!Number.isInteger(value) \|\| value < BUDGET_YEN_MIN \|\| value > BUDGET_YEN_MAX) {` | `value <= BUDGET_YEN_MIN` | `formatYen > 0 円を "¥0" と表示する`、`formatYen > 端末のロケール実装に依存せず ja-JP の桁区切りと一致する`、`formatBudgetRange > 0 円同士は "¥0" と表示する（null と 0 を混同しない）`、`formatBudgetRange > 下限 0 円の範囲を表示できる`（4 件） |

---

## Task 2-11: Zod スキーマ

**Files:**

- Create: `packages/core/src/schema.ts`
- Test: `packages/core/src/schema.test.ts`

**Interfaces:**

- Consumes: `LATITUDE_MAX` / `LATITUDE_MIN` / `LONGITUDE_MAX` / `LONGITUDE_MIN`（`@meshimap/geo`）、`z`（`zod`）、各種上限定数（`./constants`）、`IDENTIFIER_MAX_LENGTH` / `IDENTIFIER_PATTERN`（`./identifier`）、`ROLES`（`./role`）
- Produces:
  - `export const roleSchema` / `identifierSchema` / `latitudeSchema` / `longitudeSchema` / `ratingSchema` / `minuteOfDaySchema` / `dayOfWeekSchema` / `budgetYenSchema` / `webUrlSchema` / `businessHoursSchema` / `shopCreateSchema` / `shopUpdateSchema` / `reviewCreateSchema` / `reservationCreateSchema`
  - `export type ShopCreateInput` / `ShopUpdateInput` / `ReviewCreateInput` / `ReservationCreateInput`

---

- [x] **Step 1: `packages/core/src/schema.ts` を作る**

```ts
// API とモバイルで共有する入力スキーマ。Zod v4 を使う（v3 とはエラー形状も API も異なる）。

import { LATITUDE_MAX, LATITUDE_MIN, LONGITUDE_MAX, LONGITUDE_MIN } from '@meshimap/geo';
import { z } from 'zod';
import {
  BUDGET_YEN_MAX,
  BUDGET_YEN_MIN,
  DAY_OF_WEEK_MAX,
  DAY_OF_WEEK_MIN,
  MINUTES_PER_DAY,
  MINUTE_OF_DAY_MAX,
  MINUTE_OF_DAY_MIN,
  PARTY_SIZE_MAX,
  PARTY_SIZE_MIN,
  RATING_MAX,
  RATING_MIN,
  RESERVATION_NOTE_MAX_LENGTH,
  REVIEW_BODY_MAX_LENGTH,
  SHOP_ADDRESS_MAX_LENGTH,
  SHOP_DESCRIPTION_MAX_LENGTH,
  SHOP_NAME_KANA_MAX_LENGTH,
  SHOP_NAME_MAX_LENGTH,
} from './constants';
import { IDENTIFIER_MAX_LENGTH, IDENTIFIER_PATTERN } from './identifier';
import { ROLES } from './role';

/** 郵便番号（ハイフンあり 7 桁）。D1 には入力された表記のまま保存する。 */
const POSTAL_CODE_PATTERN = /^[0-9]{3}-[0-9]{4}$/;
/** 固定電話・フリーダイヤルを含む国内の市外局番形式。 */
const PHONE_PATTERN = /^0[0-9]{1,4}-[0-9]{1,4}-[0-9]{3,4}$/;
/** javascript: など危険なスキームを弾くため http/https だけを許可する。 */
const WEB_URL_PROTOCOL_PATTERN = /^https?$/;

export const roleSchema = z.enum(ROLES);

export const identifierSchema = z
  .string()
  .min(1)
  .max(IDENTIFIER_MAX_LENGTH)
  .regex(IDENTIFIER_PATTERN);

export const latitudeSchema = z.number().min(LATITUDE_MIN).max(LATITUDE_MAX);
export const longitudeSchema = z.number().min(LONGITUDE_MIN).max(LONGITUDE_MAX);
export const ratingSchema = z.number().int().min(RATING_MIN).max(RATING_MAX);
export const minuteOfDaySchema = z.number().int().min(MINUTE_OF_DAY_MIN).max(MINUTE_OF_DAY_MAX);
export const dayOfWeekSchema = z.number().int().min(DAY_OF_WEEK_MIN).max(DAY_OF_WEEK_MAX);
export const budgetYenSchema = z.number().int().min(BUDGET_YEN_MIN).max(BUDGET_YEN_MAX).nullable();
export const webUrlSchema = z.url({ protocol: WEB_URL_PROTOCOL_PATTERN });

const BUSINESS_HOURS_ORDER_MESSAGE = '閉店時刻は開店時刻より後である必要があります';
const BUSINESS_HOURS_SPAN_MESSAGE = '営業時間は 24 時間以内である必要があります';
const BUDGET_ORDER_MESSAGE = '予算の下限は上限以下である必要があります';
const SHOP_UPDATE_EMPTY_MESSAGE = '更新する項目を 1 つ以上指定してください';

export const businessHoursSchema = z
  .object({
    dayOfWeek: dayOfWeekSchema,
    openMinute: minuteOfDaySchema,
    closeMinute: minuteOfDaySchema,
    isClosed: z.boolean(),
  })
  .refine((value) => value.isClosed || value.openMinute < value.closeMinute, {
    error: BUSINESS_HOURS_ORDER_MESSAGE,
    path: ['closeMinute'],
  })
  .refine((value) => value.isClosed || value.closeMinute - value.openMinute <= MINUTES_PER_DAY, {
    error: BUSINESS_HOURS_SPAN_MESSAGE,
    path: ['closeMinute'],
  });

/** 店舗フィールドの素の定義。create は default 付きに差し替え、update は partial 化して使う。 */
const shopFieldsSchema = z.object({
  name: z.string().trim().min(1).max(SHOP_NAME_MAX_LENGTH),
  nameKana: z.string().trim().max(SHOP_NAME_KANA_MAX_LENGTH),
  genreId: identifierSchema,
  areaId: identifierSchema,
  description: z.string().trim().max(SHOP_DESCRIPTION_MAX_LENGTH),
  postalCode: z.string().regex(POSTAL_CODE_PATTERN),
  address: z.string().trim().min(1).max(SHOP_ADDRESS_MAX_LENGTH),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  phone: z.string().regex(PHONE_PATTERN).nullable(),
  website: webUrlSchema.nullable(),
  budgetLunchMinYen: budgetYenSchema,
  budgetLunchMaxYen: budgetYenSchema,
  budgetDinnerMinYen: budgetYenSchema,
  budgetDinnerMaxYen: budgetYenSchema,
});

type BudgetPair = {
  readonly minYen?: number | null | undefined;
  readonly maxYen?: number | null | undefined;
};

/** どちらかが未指定なら順序を検証できないので通す。両方あるときだけ min <= max を要求する。 */
function isBudgetPairOrdered(pair: BudgetPair): boolean {
  const { minYen, maxYen } = pair;
  // null と undefined の両方を一度に弾く。数値でなければ順序は判定しない
  if (typeof minYen !== 'number' || typeof maxYen !== 'number') {
    return true;
  }
  return minYen <= maxYen;
}

type ShopBudgetFields = {
  readonly budgetLunchMinYen?: number | null | undefined;
  readonly budgetLunchMaxYen?: number | null | undefined;
  readonly budgetDinnerMinYen?: number | null | undefined;
  readonly budgetDinnerMaxYen?: number | null | undefined;
};

function isLunchBudgetOrdered(value: ShopBudgetFields): boolean {
  return isBudgetPairOrdered({
    minYen: value.budgetLunchMinYen,
    maxYen: value.budgetLunchMaxYen,
  });
}

function isDinnerBudgetOrdered(value: ShopBudgetFields): boolean {
  return isBudgetPairOrdered({
    minYen: value.budgetDinnerMinYen,
    maxYen: value.budgetDinnerMaxYen,
  });
}

export const shopCreateSchema = shopFieldsSchema
  .extend({
    nameKana: z.string().trim().max(SHOP_NAME_KANA_MAX_LENGTH).default(''),
    description: z.string().trim().max(SHOP_DESCRIPTION_MAX_LENGTH).default(''),
    phone: z.string().regex(PHONE_PATTERN).nullable().default(null),
    website: webUrlSchema.nullable().default(null),
    budgetLunchMinYen: budgetYenSchema.default(null),
    budgetLunchMaxYen: budgetYenSchema.default(null),
    budgetDinnerMinYen: budgetYenSchema.default(null),
    budgetDinnerMaxYen: budgetYenSchema.default(null),
  })
  .refine(isLunchBudgetOrdered, {
    error: BUDGET_ORDER_MESSAGE,
    path: ['budgetLunchMaxYen'],
  })
  .refine(isDinnerBudgetOrdered, {
    error: BUDGET_ORDER_MESSAGE,
    path: ['budgetDinnerMaxYen'],
  });

export const shopUpdateSchema = shopFieldsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    error: SHOP_UPDATE_EMPTY_MESSAGE,
  })
  .refine(isLunchBudgetOrdered, {
    error: BUDGET_ORDER_MESSAGE,
    path: ['budgetLunchMaxYen'],
  })
  .refine(isDinnerBudgetOrdered, {
    error: BUDGET_ORDER_MESSAGE,
    path: ['budgetDinnerMaxYen'],
  });

export const reviewCreateSchema = z.object({
  shopId: identifierSchema,
  rating: ratingSchema,
  body: z.string().trim().min(1).max(REVIEW_BODY_MAX_LENGTH),
  visitedOn: z.iso.date(),
  budgetYen: budgetYenSchema.default(null),
});

export const reservationCreateSchema = z.object({
  shopId: identifierSchema,
  date: z.iso.date(),
  startMinute: minuteOfDaySchema,
  partySize: z.number().int().min(PARTY_SIZE_MIN).max(PARTY_SIZE_MAX),
  note: z.string().trim().max(RESERVATION_NOTE_MAX_LENGTH).default(''),
});

export type ShopCreateInput = z.infer<typeof shopCreateSchema>;
export type ShopUpdateInput = z.infer<typeof shopUpdateSchema>;
export type ReviewCreateInput = z.infer<typeof reviewCreateSchema>;
export type ReservationCreateInput = z.infer<typeof reservationCreateSchema>;
```

Zod v4 で**必ず守る点**（v3 の書き方だと動かない。すべて実測済み）:

1. エラーメッセージは `.refine(fn, { error: '…', path: [...] })` の **`error`** に書く（v3 の `message` ではない）。
2. `z.url()` は既定で `javascript:alert(1)` を**通す**。`z.url({ protocol: /^https?$/ })` を使う。
3. `.partial()` は refine 済みスキーマに使えない（`Error: .partial() cannot be used on object schemas containing refinements`）。素の `z.object`（`shopFieldsSchema`）を先に定義し、`extend`（create）と `partial`（update）をそこから派生させる。
4. `.partial()` は内側の `.default()` を消さないので、既定値は `shopCreateSchema` 側の `.extend({...})` にだけ書く。
5. 予算の順序チェックは `typeof x !== 'number'` で `null` と `undefined` を一度に弾く。`x === undefined || x === null || …` と 4 つ並べると、`null` 側の条件が**等価変異**（外しても `null <= 3000` が `true` になるため結果が変わらない）としてミューテーションテストで生き残る（実測で確認し、この形に直した）。

- [x] **Step 2: `packages/core/src/schema.test.ts` を作る**

```ts
import { describe, expect, it } from 'vitest';
import {
  businessHoursSchema,
  identifierSchema,
  ratingSchema,
  reservationCreateSchema,
  reviewCreateSchema,
  roleSchema,
  shopCreateSchema,
  shopUpdateSchema,
  webUrlSchema,
} from './schema';

/** 必須項目だけを埋めた店舗入力。任意項目の既定値をテストするために使う。 */
const MINIMAL_SHOP = {
  name: ' 麺屋 テスト ',
  genreId: 'ramen',
  areaId: 'shibuya',
  postalCode: '150-0002',
  address: '東京都渋谷区渋谷1-1-1',
  latitude: 35.6595,
  longitude: 139.7005,
} as const;

/** 失敗した検証から issue の code と path だけを取り出す。 */
function issuesOf(result: { success: boolean; error?: { issues: readonly unknown[] } }): readonly {
  code: string;
  path: readonly PropertyKey[];
}[] {
  const issues = result.error?.issues ?? [];
  return issues.map((issue) => {
    const typed = issue as { code: string; path: readonly PropertyKey[] };
    return { code: typed.code, path: typed.path };
  });
}

describe('roleSchema', () => {
  it('定義済みのロールを受け入れる', () => {
    expect(roleSchema.parse('owner')).toBe('owner');
  });

  it('未知のロールを invalid_value で拒否する', () => {
    const result = roleSchema.safeParse('guest');
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual([{ code: 'invalid_value', path: [] }]);
  });
});

describe('identifierSchema', () => {
  it('英数字とハイフン・アンダースコアを受け入れる', () => {
    expect(identifierSchema.parse('shop_1-A')).toBe('shop_1-A');
  });

  it('日本語を invalid_format で拒否する', () => {
    const result = identifierSchema.safeParse('店1');
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual([{ code: 'invalid_format', path: [] }]);
  });

  it('空文字は長さと書式の両方で拒否する', () => {
    const result = identifierSchema.safeParse('');
    expect(result.success).toBe(false);
    // Zod v4 は文字列チェックをすべて評価するため issue は 2 件になる
    expect(issuesOf(result)).toEqual([
      { code: 'too_small', path: [] },
      { code: 'invalid_format', path: [] },
    ]);
  });

  it('65 文字を too_big で拒否する', () => {
    const result = identifierSchema.safeParse('a'.repeat(65));
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual([{ code: 'too_big', path: [] }]);
  });
});

describe('ratingSchema', () => {
  it('下限 1 と上限 5 を受け入れる', () => {
    expect(ratingSchema.parse(1)).toBe(1);
    expect(ratingSchema.parse(5)).toBe(5);
  });

  it('0 を too_small で拒否する', () => {
    expect(issuesOf(ratingSchema.safeParse(0))).toEqual([{ code: 'too_small', path: [] }]);
  });

  it('6 を too_big で拒否する', () => {
    expect(issuesOf(ratingSchema.safeParse(6))).toEqual([{ code: 'too_big', path: [] }]);
  });

  it('小数を invalid_type で拒否する', () => {
    expect(issuesOf(ratingSchema.safeParse(4.5))).toEqual([{ code: 'invalid_type', path: [] }]);
  });

  it('NaN を invalid_type で拒否する', () => {
    expect(issuesOf(ratingSchema.safeParse(Number.NaN))).toEqual([
      { code: 'invalid_type', path: [] },
    ]);
  });
});

describe('businessHoursSchema', () => {
  it('日跨ぎ営業（閉店 1560）を受け入れる', () => {
    expect(
      businessHoursSchema.parse({
        dayOfWeek: 2,
        openMinute: 1350,
        closeMinute: 1560,
        isClosed: false,
      }),
    ).toEqual({
      dayOfWeek: 2,
      openMinute: 1350,
      closeMinute: 1560,
      isClosed: false,
    });
  });

  it('開店と閉店が同時刻なら closeMinute のエラーにする', () => {
    const result = businessHoursSchema.safeParse({
      dayOfWeek: 2,
      openMinute: 1080,
      closeMinute: 1080,
      isClosed: false,
    });
    expect(issuesOf(result)).toEqual([{ code: 'custom', path: ['closeMinute'] }]);
  });

  it('24 時間ちょうどの営業を受け入れる', () => {
    expect(
      businessHoursSchema.safeParse({
        dayOfWeek: 1,
        openMinute: 0,
        closeMinute: 1440,
        isClosed: false,
      }).success,
    ).toBe(true);
  });

  it('24 時間を 1 分超える営業を拒否する', () => {
    const result = businessHoursSchema.safeParse({
      dayOfWeek: 1,
      openMinute: 0,
      closeMinute: 1441,
      isClosed: false,
    });
    expect(issuesOf(result)).toEqual([{ code: 'custom', path: ['closeMinute'] }]);
  });

  it('定休日の行は開店・閉店の順序を検証しない', () => {
    expect(
      businessHoursSchema.safeParse({
        dayOfWeek: 3,
        openMinute: 0,
        closeMinute: 0,
        isClosed: true,
      }).success,
    ).toBe(true);
  });

  it('曜日 7 を too_big で拒否する', () => {
    const result = businessHoursSchema.safeParse({
      dayOfWeek: 7,
      openMinute: 0,
      closeMinute: 600,
      isClosed: false,
    });
    expect(issuesOf(result)).toEqual([{ code: 'too_big', path: ['dayOfWeek'] }]);
  });

  it('閉店 2880 を too_big で拒否する', () => {
    const result = businessHoursSchema.safeParse({
      dayOfWeek: 1,
      openMinute: 1440,
      closeMinute: 2880,
      isClosed: false,
    });
    expect(issuesOf(result)).toEqual([{ code: 'too_big', path: ['closeMinute'] }]);
  });
});

describe('shopCreateSchema', () => {
  it('必須項目だけで通り、任意項目には既定値が入る', () => {
    expect(shopCreateSchema.parse(MINIMAL_SHOP)).toEqual({
      name: '麺屋 テスト',
      nameKana: '',
      genreId: 'ramen',
      areaId: 'shibuya',
      description: '',
      postalCode: '150-0002',
      address: '東京都渋谷区渋谷1-1-1',
      latitude: 35.6595,
      longitude: 139.7005,
      phone: null,
      website: null,
      budgetLunchMinYen: null,
      budgetLunchMaxYen: null,
      budgetDinnerMinYen: null,
      budgetDinnerMaxYen: null,
    });
  });

  it('前後の空白を取り除いてから文字数を数える', () => {
    expect(issuesOf(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, name: '   ' }))).toEqual([
      { code: 'too_small', path: ['name'] },
    ]);
  });

  it('店名 100 文字を受け入れ 101 文字を拒否する', () => {
    expect(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, name: 'あ'.repeat(100) }).success).toBe(
      true,
    );
    expect(
      issuesOf(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, name: 'あ'.repeat(101) })),
    ).toEqual([{ code: 'too_big', path: ['name'] }]);
  });

  it('緯度 90 を受け入れ 90.1 を拒否する', () => {
    expect(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, latitude: 90 }).success).toBe(true);
    expect(issuesOf(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, latitude: 90.1 }))).toEqual([
      { code: 'too_big', path: ['latitude'] },
    ]);
  });

  it('経度 -180 を受け入れ -180.1 を拒否する', () => {
    expect(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, longitude: -180 }).success).toBe(true);
    expect(issuesOf(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, longitude: -180.1 }))).toEqual([
      { code: 'too_small', path: ['longitude'] },
    ]);
  });

  it('必須項目が欠けたら invalid_type で拒否する', () => {
    expect(issuesOf(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, address: undefined }))).toEqual([
      { code: 'invalid_type', path: ['address'] },
    ]);
  });

  it('郵便番号のハイフン無しを拒否する', () => {
    expect(
      issuesOf(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, postalCode: '1500002' })),
    ).toEqual([{ code: 'invalid_format', path: ['postalCode'] }]);
  });

  it('市外局番形式の電話番号を受け入れる', () => {
    expect(shopCreateSchema.parse({ ...MINIMAL_SHOP, phone: '03-1234-5678' }).phone).toBe(
      '03-1234-5678',
    );
  });

  it('区切りの無い電話番号を拒否する', () => {
    expect(
      issuesOf(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, phone: '090123456789' })),
    ).toEqual([{ code: 'invalid_format', path: ['phone'] }]);
  });

  it('https の URL を受け入れる', () => {
    expect(
      shopCreateSchema.parse({
        ...MINIMAL_SHOP,
        website: 'https://example.com',
      }).website,
    ).toBe('https://example.com');
  });

  it('javascript スキームの URL を拒否する', () => {
    expect(
      issuesOf(
        shopCreateSchema.safeParse({
          ...MINIMAL_SHOP,
          website: 'javascript:alert(1)',
        }),
      ),
    ).toEqual([{ code: 'invalid_format', path: ['website'] }]);
  });

  it('ftp スキームの URL を拒否する', () => {
    expect(
      issuesOf(
        shopCreateSchema.safeParse({
          ...MINIMAL_SHOP,
          website: 'ftp://example.com',
        }),
      ),
    ).toEqual([{ code: 'invalid_format', path: ['website'] }]);
  });

  it('予算の下限が上限を超えたら上限側のパスでエラーにする', () => {
    expect(
      issuesOf(
        shopCreateSchema.safeParse({
          ...MINIMAL_SHOP,
          budgetDinnerMinYen: 3000,
          budgetDinnerMaxYen: 1000,
        }),
      ),
    ).toEqual([{ code: 'custom', path: ['budgetDinnerMaxYen'] }]);
  });

  it('ランチとディナーの両方が逆順なら 2 件のエラーを返す', () => {
    expect(
      issuesOf(
        shopCreateSchema.safeParse({
          ...MINIMAL_SHOP,
          budgetLunchMinYen: 2000,
          budgetLunchMaxYen: 1000,
          budgetDinnerMinYen: 9000,
          budgetDinnerMaxYen: 1000,
        }),
      ),
    ).toEqual([
      { code: 'custom', path: ['budgetLunchMaxYen'] },
      { code: 'custom', path: ['budgetDinnerMaxYen'] },
    ]);
  });

  it('予算の片方だけ未設定なら順序を検証しない', () => {
    expect(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, budgetDinnerMinYen: 3000 }).success).toBe(
      true,
    );
  });

  it('未知のキーは取り除いて通す', () => {
    const parsed = shopCreateSchema.parse({ ...MINIMAL_SHOP, extraKey: 1 });
    expect(Object.hasOwn(parsed, 'extraKey')).toBe(false);
  });
});

describe('shopUpdateSchema', () => {
  it('1 項目だけの部分更新を受け入れる', () => {
    expect(shopUpdateSchema.parse({ name: '新名称' })).toEqual({
      name: '新名称',
    });
  });

  it('空オブジェクトを拒否する', () => {
    expect(issuesOf(shopUpdateSchema.safeParse({}))).toEqual([{ code: 'custom', path: [] }]);
  });

  it('部分更新では未指定の項目に既定値を入れない', () => {
    expect(Object.hasOwn(shopUpdateSchema.parse({ name: '新名称' }), 'description')).toBe(false);
  });

  it('予算の順序は部分更新でも検証する', () => {
    expect(
      issuesOf(
        shopUpdateSchema.safeParse({
          budgetDinnerMinYen: 5000,
          budgetDinnerMaxYen: 100,
        }),
      ),
    ).toEqual([{ code: 'custom', path: ['budgetDinnerMaxYen'] }]);
  });

  it('片方だけの予算更新は順序を検証しない', () => {
    expect(shopUpdateSchema.safeParse({ budgetDinnerMinYen: 5000 }).success).toBe(true);
  });

  it('null を明示して任意項目を消せる', () => {
    expect(shopUpdateSchema.parse({ website: null })).toEqual({
      website: null,
    });
  });

  it('値の検証は作成時と同じ基準で行う', () => {
    expect(issuesOf(shopUpdateSchema.safeParse({ latitude: 90.1 }))).toEqual([
      { code: 'too_big', path: ['latitude'] },
    ]);
  });
});

describe('reviewCreateSchema', () => {
  it('必須項目だけで通り予算は null になる', () => {
    expect(
      reviewCreateSchema.parse({
        shopId: 'shop_1',
        rating: 5,
        body: ' おいしい ',
        visitedOn: '2026-09-15',
      }),
    ).toEqual({
      shopId: 'shop_1',
      rating: 5,
      body: 'おいしい',
      visitedOn: '2026-09-15',
      budgetYen: null,
    });
  });

  it('空白だけの本文を拒否する', () => {
    expect(
      issuesOf(
        reviewCreateSchema.safeParse({
          shopId: 'shop_1',
          rating: 3,
          body: '   ',
          visitedOn: '2026-09-15',
        }),
      ),
    ).toEqual([{ code: 'too_small', path: ['body'] }]);
  });

  it('存在しない日付を拒否する', () => {
    expect(
      issuesOf(
        reviewCreateSchema.safeParse({
          shopId: 'shop_1',
          rating: 3,
          body: 'x',
          visitedOn: '2026-02-30',
        }),
      ),
    ).toEqual([{ code: 'invalid_format', path: ['visitedOn'] }]);
  });

  it('閏年の 2 月 29 日を受け入れる', () => {
    expect(
      reviewCreateSchema.safeParse({
        shopId: 'shop_1',
        rating: 3,
        body: 'x',
        visitedOn: '2024-02-29',
      }).success,
    ).toBe(true);
  });

  it('平年の 2 月 29 日を拒否する', () => {
    expect(
      reviewCreateSchema.safeParse({
        shopId: 'shop_1',
        rating: 3,
        body: 'x',
        visitedOn: '2026-02-29',
      }).success,
    ).toBe(false);
  });
});

describe('reservationCreateSchema', () => {
  it('必須項目だけで通りメモは空文字になる', () => {
    expect(
      reservationCreateSchema.parse({
        shopId: 'shop_1',
        date: '2026-09-15',
        startMinute: 1080,
        partySize: 4,
      }),
    ).toEqual({
      shopId: 'shop_1',
      date: '2026-09-15',
      startMinute: 1080,
      partySize: 4,
      note: '',
    });
  });

  it('人数 0 を拒否する', () => {
    expect(
      issuesOf(
        reservationCreateSchema.safeParse({
          shopId: 'shop_1',
          date: '2026-09-15',
          startMinute: 1080,
          partySize: 0,
        }),
      ),
    ).toEqual([{ code: 'too_small', path: ['partySize'] }]);
  });

  it('人数 21 を拒否する', () => {
    expect(
      issuesOf(
        reservationCreateSchema.safeParse({
          shopId: 'shop_1',
          date: '2026-09-15',
          startMinute: 1080,
          partySize: 21,
        }),
      ),
    ).toEqual([{ code: 'too_big', path: ['partySize'] }]);
  });

  it('開始時刻 2880 を拒否する', () => {
    expect(
      issuesOf(
        reservationCreateSchema.safeParse({
          shopId: 'shop_1',
          date: '2026-09-15',
          startMinute: 2880,
          partySize: 2,
        }),
      ),
    ).toEqual([{ code: 'too_big', path: ['startMinute'] }]);
  });
});

/** 失敗した検証からメッセージだけを取り出す。 */
function messagesOf(result: {
  success: boolean;
  error?: { issues: readonly unknown[] };
}): readonly string[] {
  const issues = result.error?.issues ?? [];
  return issues.map((issue) => (issue as { message: string }).message);
}

describe('検証エラーのメッセージ', () => {
  it('閉店時刻の逆転は日本語のメッセージで返す', () => {
    const result = businessHoursSchema.safeParse({
      dayOfWeek: 2,
      openMinute: 1080,
      closeMinute: 1080,
      isClosed: false,
    });
    expect(messagesOf(result)).toEqual(['閉店時刻は開店時刻より後である必要があります']);
  });

  it('24 時間超えは日本語のメッセージで返す', () => {
    const result = businessHoursSchema.safeParse({
      dayOfWeek: 1,
      openMinute: 0,
      closeMinute: 1441,
      isClosed: false,
    });
    expect(messagesOf(result)).toEqual(['営業時間は 24 時間以内である必要があります']);
  });

  it('予算の逆転は日本語のメッセージで返す', () => {
    const result = shopCreateSchema.safeParse({
      ...MINIMAL_SHOP,
      budgetDinnerMinYen: 3000,
      budgetDinnerMaxYen: 1000,
    });
    expect(messagesOf(result)).toEqual(['予算の下限は上限以下である必要があります']);
  });

  it('空の部分更新は日本語のメッセージで返す', () => {
    expect(messagesOf(shopUpdateSchema.safeParse({}))).toEqual([
      '更新する項目を 1 つ以上指定してください',
    ]);
  });
});

describe('書式パターンの前後一致', () => {
  it('郵便番号は前に文字が付いたら拒否する', () => {
    expect(
      issuesOf(
        shopCreateSchema.safeParse({
          ...MINIMAL_SHOP,
          postalCode: '0150-0002',
        }),
      ),
    ).toEqual([{ code: 'invalid_format', path: ['postalCode'] }]);
  });

  it('郵便番号は後ろに文字が付いたら拒否する', () => {
    expect(
      issuesOf(
        shopCreateSchema.safeParse({
          ...MINIMAL_SHOP,
          postalCode: '150-00021',
        }),
      ),
    ).toEqual([{ code: 'invalid_format', path: ['postalCode'] }]);
  });

  it('電話番号は 4 桁の市外局番（フリーダイヤル）を受け入れる', () => {
    expect(shopCreateSchema.parse({ ...MINIMAL_SHOP, phone: '0120-123-456' }).phone).toBe(
      '0120-123-456',
    );
  });

  it('電話番号は前に文字が付いたら拒否する', () => {
    expect(
      issuesOf(
        shopCreateSchema.safeParse({
          ...MINIMAL_SHOP,
          phone: '81-03-1234-5678',
        }),
      ),
    ).toEqual([{ code: 'invalid_format', path: ['phone'] }]);
  });

  it('電話番号は後ろに文字が付いたら拒否する', () => {
    expect(
      issuesOf(
        shopCreateSchema.safeParse({
          ...MINIMAL_SHOP,
          phone: '03-1234-5678-9',
        }),
      ),
    ).toEqual([{ code: 'invalid_format', path: ['phone'] }]);
  });

  it('http の URL も受け入れる', () => {
    expect(webUrlSchema.parse('http://example.com')).toBe('http://example.com');
  });

  it('大文字のスキームも受け入れる', () => {
    expect(webUrlSchema.safeParse('HTTPS://example.com').success).toBe(true);
  });

  it('http で始まるだけの未知スキームは拒否する', () => {
    expect(issuesOf(webUrlSchema.safeParse('httpx://example.com'))).toEqual([
      { code: 'invalid_format', path: [] },
    ]);
  });

  it('https で終わるだけの未知スキームは拒否する', () => {
    expect(issuesOf(webUrlSchema.safeParse('xhttps://example.com'))).toEqual([
      { code: 'invalid_format', path: [] },
    ]);
  });
});

describe('文字列の前後空白と長さ', () => {
  it('店名カナは前後の空白を落として保存する', () => {
    expect(
      shopCreateSchema.parse({ ...MINIMAL_SHOP, nameKana: '  メンヤ テスト  ' }).nameKana,
    ).toBe('メンヤ テスト');
  });

  it('紹介文は前後の空白を落として保存する', () => {
    expect(
      shopCreateSchema.parse({
        ...MINIMAL_SHOP,
        description: '  醤油ラーメン  ',
      }).description,
    ).toBe('醤油ラーメン');
  });

  it('住所は前後の空白を落として保存する', () => {
    expect(
      shopCreateSchema.parse({
        ...MINIMAL_SHOP,
        address: '  東京都渋谷区渋谷1-1-1  ',
      }).address,
    ).toBe('東京都渋谷区渋谷1-1-1');
  });

  it('空白だけの住所を拒否する', () => {
    expect(issuesOf(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, address: '   ' }))).toEqual([
      { code: 'too_small', path: ['address'] },
    ]);
  });

  it('住所 200 文字を受け入れ 201 文字を拒否する', () => {
    expect(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, address: 'あ'.repeat(200) }).success).toBe(
      true,
    );
    expect(
      issuesOf(
        shopCreateSchema.safeParse({
          ...MINIMAL_SHOP,
          address: 'あ'.repeat(201),
        }),
      ),
    ).toEqual([{ code: 'too_big', path: ['address'] }]);
  });

  it('店名カナ 200 文字を受け入れ 201 文字を拒否する', () => {
    expect(shopUpdateSchema.safeParse({ nameKana: 'ア'.repeat(200) }).success).toBe(true);
    expect(issuesOf(shopUpdateSchema.safeParse({ nameKana: 'ア'.repeat(201) }))).toEqual([
      { code: 'too_big', path: ['nameKana'] },
    ]);
  });

  it('紹介文 2000 文字を受け入れ 2001 文字を拒否する', () => {
    expect(shopUpdateSchema.safeParse({ description: 'あ'.repeat(2000) }).success).toBe(true);
    expect(issuesOf(shopUpdateSchema.safeParse({ description: 'あ'.repeat(2001) }))).toEqual([
      { code: 'too_big', path: ['description'] },
    ]);
  });

  it('予約メモは前後の空白を落として保存する', () => {
    expect(
      reservationCreateSchema.parse({
        shopId: 'shop_1',
        date: '2026-09-15',
        startMinute: 1080,
        partySize: 2,
        note: '  ベビーカーあり  ',
      }).note,
    ).toBe('ベビーカーあり');
  });
});

describe('予算の順序チェック（片側だけの指定）', () => {
  it('作成時にランチの下限だけを指定できる', () => {
    expect(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, budgetLunchMinYen: 3000 }).success).toBe(
      true,
    );
  });

  it('作成時にランチの上限だけを指定できる', () => {
    expect(shopCreateSchema.safeParse({ ...MINIMAL_SHOP, budgetLunchMaxYen: 3000 }).success).toBe(
      true,
    );
  });

  it('作成時に下限と上限が同額でも通る', () => {
    expect(
      shopCreateSchema.safeParse({
        ...MINIMAL_SHOP,
        budgetLunchMinYen: 2000,
        budgetLunchMaxYen: 2000,
      }).success,
    ).toBe(true);
  });

  it('部分更新でランチの下限だけを指定できる', () => {
    expect(shopUpdateSchema.safeParse({ budgetLunchMinYen: 5000 }).success).toBe(true);
  });

  it('部分更新でランチの上限だけを指定できる', () => {
    expect(shopUpdateSchema.safeParse({ budgetLunchMaxYen: 5000 }).success).toBe(true);
  });

  it('部分更新でディナーの上限だけを指定できる', () => {
    expect(shopUpdateSchema.safeParse({ budgetDinnerMaxYen: 5000 }).success).toBe(true);
  });

  it('部分更新でもランチの逆転は上限側のパスでエラーにする', () => {
    const result = shopUpdateSchema.safeParse({
      budgetLunchMinYen: 5000,
      budgetLunchMaxYen: 100,
    });
    expect(issuesOf(result)).toEqual([{ code: 'custom', path: ['budgetLunchMaxYen'] }]);
    expect(messagesOf(result)).toEqual(['予算の下限は上限以下である必要があります']);
  });
});

describe('部分更新でも前後の空白を落とすこと', () => {
  it('店名カナの前後の空白を落とす', () => {
    expect(shopUpdateSchema.parse({ nameKana: '  メンヤ テスト  ' }).nameKana).toBe(
      'メンヤ テスト',
    );
  });

  it('紹介文の前後の空白を落とす', () => {
    expect(shopUpdateSchema.parse({ description: '  醤油ラーメン  ' }).description).toBe(
      '醤油ラーメン',
    );
  });

  it('店名の前後の空白を落とす', () => {
    expect(shopUpdateSchema.parse({ name: '  麺屋 テスト  ' }).name).toBe('麺屋 テスト');
  });

  it('住所の前後の空白を落とす', () => {
    expect(shopUpdateSchema.parse({ address: '  東京都渋谷区渋谷1-1-1  ' }).address).toBe(
      '東京都渋谷区渋谷1-1-1',
    );
  });
});
```

- [x] **Step 3: 型チェックとテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core -- src/schema.test.ts
  ```

  期待: `Tests  82 passed (82)`。

  `Cannot read properties of undefined (reading 'toString')` のようなエラーが出たら、`@meshimap/geo` のリンクが張られていない（Task 2-0 Step 2 の `npm install` を飛ばした）可能性が高い。`LATITUDE_MAX` などが `undefined` のまま `.max(undefined)` に渡ると Zod のロケール処理が落ちる、という実測済みの症状。

- [x] **Step 4: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/schema.ts`）                                                                                       | 変更後                             | 期待: FAIL するテスト（実測）                                                                                                                       |
  | --- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `nameKana: z.string().trim().max(SHOP_NAME_KANA_MAX_LENGTH),`（`shopFieldsSchema` 内）                              | `.trim()` を外す                   | `部分更新でも前後の空白を落とすこと > 店名カナの前後の空白を落とす`                                                                                 |
  | 2   | `const WEB_URL_PROTOCOL_PATTERN = /^https?$/;`                                                                      | `/https?/`（前後のアンカーを外す） | `書式パターンの前後一致 > http で始まるだけの未知スキームは拒否する`、`書式パターンの前後一致 > https で終わるだけの未知スキームは拒否する`（2 件） |
  | 3   | `shopCreateSchema` の `.refine(isLunchBudgetOrdered, { error: BUDGET_ORDER_MESSAGE, path: ['budgetLunchMaxYen'] })` | `path: ['budgetLunchMinYen']`      | `shopCreateSchema > ランチとディナーの両方が逆順なら 2 件のエラーを返す`                                                                            |
  | 4   | `.refine((value) => Object.keys(value).length > 0, {`                                                               | `length >= 0`                      | `shopUpdateSchema > 空オブジェクトを拒否する`、`検証エラーのメッセージ > 空の部分更新は日本語のメッセージで返す`（2 件）                            |

---

## Task 2-12: 公開 API バレルと品質ゲート

**Files:**

- Create: `packages/core/src/index.ts`
- Create: `packages/core/README.md`
- Test: `packages/core/src/index.test.ts`

**Interfaces:**

- Consumes: 全モジュールの公開シンボル
- Produces: `@meshimap/core` の公開 API（**実行時に値を持つ export が 81 個** + 型 export）。他パッケージはこのバレル以外から import しない。

---

- [x] **Step 1: `packages/core/src/index.ts` を作る**

  `export * from './x'` は使わない（何が公開されているか読み取れず、内部実装を誤って公開しやすい）。1 つずつ名前を挙げて再輸出する。型は `verbatimModuleSyntax: true` と `isolatedModules: true` のため必ず `export type { ... }` で書く。

```ts
// @meshimap/core の公開 API。他パッケージはこのバレル以外から import しない。

export {
  BUDGET_YEN_MAX,
  BUDGET_YEN_MIN,
  CLOSING_SOON_THRESHOLD_MINUTES,
  DAYS_PER_WEEK,
  DAY_OF_WEEK_MAX,
  DAY_OF_WEEK_MIN,
  HOURS_PER_DAY,
  JST_OFFSET_MINUTES,
  MAX_PARALLEL_MAX,
  MAX_PARALLEL_MIN,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_MINUTE,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  MINUTE_OF_DAY_MAX,
  MINUTE_OF_DAY_MIN,
  PARTY_SIZE_MAX,
  PARTY_SIZE_MIN,
  RATING_MAX,
  RATING_MIN,
  RESERVATION_NOTE_MAX_LENGTH,
  REVIEW_BODY_MAX_LENGTH,
  SEAT_CAPACITY_MAX,
  SEAT_CAPACITY_MIN,
  SHOP_ADDRESS_MAX_LENGTH,
  SHOP_DESCRIPTION_MAX_LENGTH,
  SHOP_NAME_KANA_MAX_LENGTH,
  SHOP_NAME_MAX_LENGTH,
  SLOT_MINUTES_MAX,
  SLOT_MINUTES_MIN,
} from './constants';
export { BUDGET_UNSET_LABEL, formatBudgetRange, formatYen } from './budget';
export { businessHoursOn, formatBusinessHours, isOvernight } from './business-hours';
export type { BusinessHours, ShopClosure } from './business-hours';
export {
  IDENTIFIER_MAX_LENGTH,
  IDENTIFIER_PATTERN,
  toReservationId,
  toReviewId,
  toShopId,
  toUserId,
} from './identifier';
export type { ReservationId, ReviewId, ShopId, UserId } from './identifier';
export {
  addJstDays,
  dayOfWeekOf,
  previousDayOfWeek,
  toDayOfWeek,
  toJstClock,
  toJstDate,
} from './jst-clock';
export type { DayOfWeek, JstClock, JstDate } from './jst-clock';
export { formatMinuteOfDay, minuteOfDay, toMinuteOfDay } from './minute-of-day';
export type { MinuteOfDay } from './minute-of-day';
export { getOpenStatus, isCurrentlyOpen, minutesUntilClose } from './open-status';
export type { OpenStatus } from './open-status';
export { summarizeRatings, toRating } from './rating';
export type { Rating, RatingDistribution, RatingSummary } from './rating';
export { canReserve } from './reservation-availability';
export type {
  ExistingReservation,
  ReservationAvailability,
  ReservationBlockReason,
  ReservationRequest,
} from './reservation-availability';
export { assertSeatSettings, generateSlots } from './reservation-slot';
export type { ReservationSlot, SeatSettings } from './reservation-slot';
export {
  ROLES,
  ROLE_ADMIN,
  ROLE_OWNER,
  ROLE_USER,
  canManageShop,
  canModerate,
  isRole,
  toRole,
} from './role';
export type { Role } from './role';
export {
  budgetYenSchema,
  businessHoursSchema,
  dayOfWeekSchema,
  identifierSchema,
  latitudeSchema,
  longitudeSchema,
  minuteOfDaySchema,
  ratingSchema,
  reservationCreateSchema,
  reviewCreateSchema,
  roleSchema,
  shopCreateSchema,
  shopUpdateSchema,
  webUrlSchema,
} from './schema';
export type {
  ReservationCreateInput,
  ReviewCreateInput,
  ShopCreateInput,
  ShopUpdateInput,
} from './schema';
```

**`index.ts` から輸出していないもの**（意図的に内部に閉じている）: `assertIdentifier`（`identifier.ts` の私有関数）、`formatUtcDate` と `JST_DATE_PATTERN`（`jst-clock.ts`）、`hasClosure`（`open-status.ts`）、`shopFieldsSchema` / `isBudgetPairOrdered` / `POSTAL_CODE_PATTERN` / `PHONE_PATTERN` / `WEB_URL_PROTOCOL_PATTERN` とメッセージ定数（`schema.ts`）、`BUDGET_UNSET_LABEL` 以外の表示用文字列定数（`budget.ts`）、`MINUTES_PER_HOUR` を除く整形専用の接頭辞・区切り定数（`NEXT_DAY_PREFIX` / `BUSINESS_HOURS_SEPARATOR` / `BUSINESS_HOURS_JOINER` / `REGULAR_HOLIDAY_LABEL`）。表示文字列は `formatXxx` 経由でだけ使わせる。

- [x] **Step 2: `packages/core/src/index.test.ts` を作る**

  公開 API の一覧をテストで固定する（意図しない公開・意図しない削除の両方を検知する）。あわせて、モジュールをまたいだ結合シナリオを 4 本書く。

```ts
import { describe, expect, it } from 'vitest';
import * as core from './index';

/** 火曜 22:30 〜 翌 02:00 営業、水曜定休の居酒屋。 */
const IZAKAYA_HOURS = [
  {
    dayOfWeek: 2,
    openMinute: core.minuteOfDay(22, 30),
    closeMinute: core.minuteOfDay(26, 0),
    isClosed: false,
  },
  {
    dayOfWeek: 3,
    openMinute: core.minuteOfDay(0, 0),
    closeMinute: core.minuteOfDay(0, 0),
    isClosed: true,
  },
] as const;

describe('@meshimap/core の公開 API', () => {
  it('公開する関数・定数・スキーマが過不足なく揃っている', () => {
    // 意図しない公開・意図しない削除の両方を検知するためのスナップショット的テスト
    expect([...Object.keys(core)].sort()).toEqual([
      'BUDGET_UNSET_LABEL',
      'BUDGET_YEN_MAX',
      'BUDGET_YEN_MIN',
      'CLOSING_SOON_THRESHOLD_MINUTES',
      'DAYS_PER_WEEK',
      'DAY_OF_WEEK_MAX',
      'DAY_OF_WEEK_MIN',
      'HOURS_PER_DAY',
      'IDENTIFIER_MAX_LENGTH',
      'IDENTIFIER_PATTERN',
      'JST_OFFSET_MINUTES',
      'MAX_PARALLEL_MAX',
      'MAX_PARALLEL_MIN',
      'MILLISECONDS_PER_DAY',
      'MILLISECONDS_PER_MINUTE',
      'MINUTES_PER_DAY',
      'MINUTES_PER_HOUR',
      'MINUTE_OF_DAY_MAX',
      'MINUTE_OF_DAY_MIN',
      'PARTY_SIZE_MAX',
      'PARTY_SIZE_MIN',
      'RATING_MAX',
      'RATING_MIN',
      'RESERVATION_NOTE_MAX_LENGTH',
      'REVIEW_BODY_MAX_LENGTH',
      'ROLES',
      'ROLE_ADMIN',
      'ROLE_OWNER',
      'ROLE_USER',
      'SEAT_CAPACITY_MAX',
      'SEAT_CAPACITY_MIN',
      'SHOP_ADDRESS_MAX_LENGTH',
      'SHOP_DESCRIPTION_MAX_LENGTH',
      'SHOP_NAME_KANA_MAX_LENGTH',
      'SHOP_NAME_MAX_LENGTH',
      'SLOT_MINUTES_MAX',
      'SLOT_MINUTES_MIN',
      'addJstDays',
      'assertSeatSettings',
      'budgetYenSchema',
      'businessHoursOn',
      'businessHoursSchema',
      'canManageShop',
      'canModerate',
      'canReserve',
      'dayOfWeekOf',
      'dayOfWeekSchema',
      'formatBudgetRange',
      'formatBusinessHours',
      'formatMinuteOfDay',
      'formatYen',
      'generateSlots',
      'getOpenStatus',
      'identifierSchema',
      'isCurrentlyOpen',
      'isOvernight',
      'isRole',
      'latitudeSchema',
      'longitudeSchema',
      'minuteOfDay',
      'minuteOfDaySchema',
      'minutesUntilClose',
      'previousDayOfWeek',
      'ratingSchema',
      'reservationCreateSchema',
      'reviewCreateSchema',
      'roleSchema',
      'shopCreateSchema',
      'shopUpdateSchema',
      'summarizeRatings',
      'toDayOfWeek',
      'toJstClock',
      'toJstDate',
      'toMinuteOfDay',
      'toRating',
      'toReservationId',
      'toReviewId',
      'toRole',
      'toShopId',
      'toUserId',
      'webUrlSchema',
    ]);
  });

  it('店舗カードの表示に必要な値を通しで組み立てられる', () => {
    // 2026-09-15T13:30:00Z = JST 2026-09-15（火）22:30
    const now = new Date('2026-09-15T13:30:00Z');
    const clock = core.toJstClock(now);

    expect(clock).toEqual({
      date: '2026-09-15',
      dayOfWeek: 2,
      minuteOfDay: 1350,
    });
    expect(core.formatBusinessHours(core.businessHoursOn(IZAKAYA_HOURS, clock.dayOfWeek))).toBe(
      '22:30 - 翌 2:00',
    );
    expect(core.formatBusinessHours(core.businessHoursOn(IZAKAYA_HOURS, 3))).toBe('定休日');
    expect(core.getOpenStatus(IZAKAYA_HOURS, [], now)).toBe('open');
    expect(core.minutesUntilClose(IZAKAYA_HOURS, [], now)).toBe(210);
    expect(core.formatBudgetRange(3000, 5000)).toBe('¥3,000 〜 ¥5,000');
    expect(core.summarizeRatings([core.toRating(5), core.toRating(4), core.toRating(3)])).toEqual({
      average: 4,
      count: 3,
      distribution: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 },
    });
  });

  it('日跨ぎ営業の残り時間からステータスを判定できる', () => {
    // 2026-09-15T16:30:00Z = JST 2026-09-16（水）01:30。火曜の日跨ぎ分で閉店 30 分前
    const now = new Date('2026-09-15T16:30:00Z');

    expect(core.toJstClock(now)).toEqual({
      date: '2026-09-16',
      dayOfWeek: 3,
      minuteOfDay: 90,
    });
    expect(core.minutesUntilClose(IZAKAYA_HOURS, [], now)).toBe(30);
    expect(core.isCurrentlyOpen(IZAKAYA_HOURS, [], now)).toBe(true);
    expect(core.getOpenStatus(IZAKAYA_HOURS, [], now)).toBe('closing-soon');

    // 前日の臨時休業を登録すると日跨ぎ分も止まり、水曜の定休日表示に戻る
    const closures = [{ date: core.toJstDate('2026-09-15'), reason: '設備点検' }] as const;
    expect(core.minutesUntilClose(IZAKAYA_HOURS, closures, now)).toBeNull();
    expect(core.getOpenStatus(IZAKAYA_HOURS, closures, now)).toBe('regular-holiday');
  });

  it('予約枠の生成から予約可否判定までを通しで実行できる', () => {
    const seatSettings = {
      capacity: 10,
      slotMinutes: 90,
      maxParallel: 3,
      acceptsReservation: true,
    } as const;
    const hours = [
      {
        dayOfWeek: 2,
        openMinute: core.minuteOfDay(18, 0),
        closeMinute: core.minuteOfDay(25, 30),
        isClosed: false,
      },
    ] as const;

    const slots = core.generateSlots(hours, seatSettings, core.toJstDate('2026-09-15'));
    expect(slots).toEqual([
      { startMinute: 1080, endMinute: 1170 },
      { startMinute: 1170, endMinute: 1260 },
      { startMinute: 1260, endMinute: 1350 },
      { startMinute: 1350, endMinute: 1440 },
      { startMinute: 1440, endMinute: 1530 },
    ]);

    const firstSlot = slots[0];
    if (firstSlot === undefined) {
      throw new Error('予約枠が生成されていません');
    }

    expect(
      core.canReserve({
        slot: firstSlot,
        seatSettings,
        existingReservations: [{ startMinute: firstSlot.startMinute, partySize: 9 }],
        partySize: 2,
      }),
    ).toEqual({ isAvailable: false, reason: 'seats-full', remainingSeats: 1 });

    const parsed = core.reservationCreateSchema.parse({
      shopId: 'shop_izakaya',
      date: '2026-09-15',
      startMinute: firstSlot.startMinute,
      partySize: 2,
    });
    expect(parsed).toEqual({
      shopId: 'shop_izakaya',
      date: '2026-09-15',
      startMinute: 1080,
      partySize: 2,
      note: '',
    });
  });

  it('ロールごとに店舗管理とモデレーションの権限が決まる', () => {
    expect(core.ROLES.map((role) => core.canManageShop(role))).toEqual([false, true, true]);
    expect(core.ROLES.map((role) => core.canModerate(role))).toEqual([false, false, true]);
    expect(core.toRole('owner')).toBe(core.ROLE_OWNER);
  });
});
```

- [x] **Step 3: バレルのテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run test -w @meshimap/core -- src/index.test.ts
  ```

  期待: `Tests  5 passed (5)`。

  公開シンボル一覧のテストが落ちたら、**期待値の配列を書き換えて誤魔化さない**。`index.ts` の輸出を意図どおりに直すか、意図的な追加であれば配列に追記する（追記する場合は必ずアルファベット順を保つ。`[...Object.keys(core)].sort()` と比較しているため）。

- [x] **Step 4: 全テストと型チェックを通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test -w @meshimap/core
  ```

  期待: 型エラーなし、`Test Files  13 passed (13)` / `Tests  323 passed (323)`。

  内訳（実測）:

  | テストファイル                     | 件数    |
  | ---------------------------------- | ------- |
  | `constants.test.ts`                | 8       |
  | `role.test.ts`                     | 16      |
  | `identifier.test.ts`               | 12      |
  | `minute-of-day.test.ts`            | 31      |
  | `jst-clock.test.ts`                | 37      |
  | `business-hours.test.ts`           | 17      |
  | `open-status.test.ts`              | 42      |
  | `reservation-slot.test.ts`         | 22      |
  | `reservation-availability.test.ts` | 15      |
  | `rating.test.ts`                   | 17      |
  | `budget.test.ts`                   | 19      |
  | `schema.test.ts`                   | 82      |
  | `index.test.ts`                    | 5       |
  | **合計**                           | **323** |

- [x] **Step 5: カバレッジ 100% を確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run test:coverage -w @meshimap/core
  ```

  期待（実測値）:

  ```text
  Statements   : 100% ( 226/226 )
  Branches     : 100% ( 129/129 )
  Functions    : 100% ( 49/49 )
  Lines        : 100% ( 219/219 )
  ```

  `vitest.config.ts` の `thresholds` がすべて 100 なので、1 行でも未到達があればコマンドが失敗する。**閾値を下げて通すことは禁止。** 到達できない行があるなら、その行自体が不要である可能性を先に疑う。

- [x] **Step 6: 整形を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npx prettier --write "packages/core/src/**/*.ts"
  npm run format:check
  ```

  期待: `All matched files use Prettier code style!`（ルートの `.prettierrc.json` は `semi: true` / `singleQuote: true` / `printWidth: 100` / `trailingComma: "all"`）。

- [x] **Step 7: ミューテーションテストを実行する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run test:mutation -w @meshimap/core
  ```

  期待（本計画作成時の実測）: **610 変異 / killed 601 + timeout 9 / survived 0 / スコア 100.00%**、所要 1 分 34 秒。`thresholds.break: 85` を下回るとコマンドが失敗する。

  ファイル別の内訳（実測）: `budget.ts` 100.00 / `business-hours.ts` 100.00 / `constants.ts` 100.00 / `identifier.ts` 100.00 / `jst-clock.ts` 100.00 / `minute-of-day.ts` 100.00 / `open-status.ts` 100.00 / `rating.ts` 100.00 / `reservation-availability.ts` 100.00 / `reservation-slot.ts` 100.00 / `role.ts` 100.00 / `schema.ts` 100.00。

  **スコアが 21% 前後になったら**、Task 2-0 Step 3 の `stryker.config.json` の差し替えを飛ばしている。`testRunner` が `"vitest"` のままだと変異ごとにテストが 0 件実行になる（実測済みの不具合）。

- [x] **Step 8: 生き残った変異を潰す**（実測: 生存 0 件のため対処不要。下表は本計画の作成過程で実際に潰した記録）

  ```bash
  open packages/core/reports/mutation/index.html
  ```

  `Survived` を 1 件ずつ見て、次のどちらかで対処する。

  1. **テストを追加する**（原則こちら）。その変異を殺す境界値テストを書く。殺せない変異がある = その分岐の正しさを誰も検証していない、という意味。
  2. **コードを削る / 書き換える**。変異させても振る舞いが変わらない（等価変異）なら、そのコードが冗長である可能性が高い。

  本計画の実装で実際に出た生き残りと、その対処（すべて実測）:

  | 生き残った変異                                                                | 対処                                                                                                                                                                                      |
  | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `isRole` の `typeof value === 'string' &&` を消しても結果が同じ               | **コードを削った**。`ROLES.some((role) => role === value)` だけで文字列以外は落ちる                                                                                                       |
  | `minutesUntilClose` の日跨ぎ分の `isOvernight(entry) &&` を消しても結果が同じ | **コードを削った**。`shifted` は必ず 1440 以上なので条件が冗長                                                                                                                            |
  | `if (remaining < shortest)` → `<=` にしても結果が同じ                         | **`Math.min(shortest, remaining)` に書き換えた**。比較演算子を残さなければ等価変異も生まれない                                                                                            |
  | `isBudgetPairOrdered` の `minYen === null` を消しても結果が同じ               | **`typeof minYen !== 'number'` に統合した**。`null <= 3000` が `true` になるため `null` 判定だけでは差が出ない                                                                            |
  | `shifted >= entry.openMinute` → `true` が生き残る                             | **テストを追加した**（前日の行が「翌 1:00 開店」で、当日 0:30 にはまだ開いていないケース）                                                                                                |
  | 前日の営業時間を無条件に見ても結果が同じ                                      | **テストを追加した**（月・火の両方に 11:00-14:00 があり、火曜 12:00 の残り時間が 120 分になること）                                                                                       |
  | `.trim()` の除去（`z.string().trim().max(...)` → `z.string().max(...)`）      | **テストを追加した**。`shopCreateSchema` と `shopUpdateSchema` の**両方**で前後空白が落ちることを検証する（create 側は `.extend` で別インスタンスになっているため、片方だけでは殺せない） |
  | 正規表現のアンカー（`^` / `$`）の除去                                         | **テストを追加した**。「前半が合法で末尾が不正」「先頭が不正で後半が合法」の両方の値を用意する（`0150-0002` / `150-00021` / `httpx://` / `xhttps://`）                                    |
  | エラーメッセージ文字列の置換                                                  | **テストを追加した**。`issue.message` を日本語メッセージと完全一致で比較する                                                                                                              |
  | `.refine(..., { path: [...] })` のパス変更                                    | **テストを追加した**。`issue.path` を検証する                                                                                                                                             |

  **`stryker.config.json` の閾値を下げて通すことは禁止。**

- [x] **Step 9: 意図的に壊してテストが検知することを確認する**

  | #   | 変更する行（`src/index.ts`）                                                                                     | 変更後                        | 期待: FAIL するテスト（実測）                                                                                                                                              |
  | --- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1   | `export { ROLES, ROLE_ADMIN, ROLE_OWNER, ROLE_USER, canManageShop, canModerate, isRole, toRole } from './role';` | `toRole` を輸出リストから削る | `@meshimap/core の公開 API > 公開する関数・定数・スキーマが過不足なく揃っている`、`@meshimap/core の公開 API > ロールごとに店舗管理とモデレーションの権限が決まる`（2 件） |

- [x] **Step 10: `packages/core/README.md` を書く**

  ```markdown
  # @meshimap/core

  API（`apps/api`）とモバイル（`apps/mobile`）が共有するドメイン層。**副作用ゼロの純粋関数と型だけ**で構成する。

  ## 設計方針

  - **現在時刻は引数で受け取る。** 内部で `new Date()` を呼ばないので、境界値テストが時計に依存しない。
  - **JST は自前で計算する。** `getHours()` 等のローカル時刻メソッドを使わず、エポックミリ秒に +540 分してから `getUTC*` で読む。UTC で動く Cloudflare Workers と JST の端末で同じ結果になる。
  - **時刻は「0 時からの分」で持つ。** 日跨ぎ営業は `closeMinute > 1440`（翌 1:30 = 1530）で表現し、判定を数値比較に落とす。
  - **`Intl` / `toLocaleString` を使わない。** React Native（Hermes）のロケール実装差を避けるため、桁区切りは自前実装。
  - **ID はブランド型。** `shopId` を `userId` の位置に渡す事故をコンパイル時に落とす。
  - **カバレッジ 100% + ミューテーションスコア 85% 以上を必須条件にする。**

  ## 主な API

  | 分類     | 関数・型                                                                                                                |
  | -------- | ----------------------------------------------------------------------------------------------------------------------- |
  | ロール   | `Role` / `ROLES` / `isRole` / `toRole` / `canManageShop` / `canModerate`                                                |
  | ID       | `ShopId` / `UserId` / `ReviewId` / `ReservationId` / `toShopId` ほか                                                    |
  | 時刻     | `MinuteOfDay` / `minuteOfDay` / `toMinuteOfDay` / `formatMinuteOfDay`                                                   |
  | JST      | `JstDate` / `DayOfWeek` / `JstClock` / `toJstClock` / `toJstDate` / `addJstDays` / `dayOfWeekOf` / `previousDayOfWeek`  |
  | 営業時間 | `BusinessHours` / `ShopClosure` / `isOvernight` / `businessHoursOn` / `formatBusinessHours`                             |
  | 営業状態 | `OpenStatus` / `minutesUntilClose` / `isCurrentlyOpen` / `getOpenStatus`                                                |
  | 予約     | `SeatSettings` / `ReservationSlot` / `generateSlots` / `canReserve`                                                     |
  | 評価     | `Rating` / `RatingSummary` / `toRating` / `summarizeRatings`                                                            |
  | 予算     | `formatYen` / `formatBudgetRange`                                                                                       |
  | スキーマ | `shopCreateSchema` / `shopUpdateSchema` / `reviewCreateSchema` / `reservationCreateSchema` / `businessHoursSchema` ほか |

  ## 使い方

  \`\`\`ts
  import { formatBusinessHours, businessHoursOn, getOpenStatus, toJstClock } from '@meshimap/core';

  const now = new Date(); // Worker でも端末でも UTC 基準の Date をそのまま渡す
  const clock = toJstClock(now);
  const status = getOpenStatus(shop.hours, shop.closures, now); // 'open' | 'closing-soon' | 'closed' | 'regular-holiday'
  const label = formatBusinessHours(businessHoursOn(shop.hours, clock.dayOfWeek)); // "18:00 - 翌 1:30"
  \`\`\`

  ## テスト

  \`\`\`bash
  npm run test -w @meshimap/core # 単体テスト
  npm run test:coverage -w @meshimap/core # カバレッジ（閾値 100%）
  npm run test:mutation -w @meshimap/core # ミューテーションテスト（閾値 85%）
  \`\`\`

  ミューテーションテストは `stryker.config.json` でコマンドランナー（`npx vitest run --silent`）を使う。`@stryker-mutator/vitest-runner@10.0.0` は `vitest@5.0.0` と組み合わせると変異ごとにテストを実行できず、スコアが誤って 21% 程度に落ちるため。
  ```

- [x] **Step 11: 最終確認**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee
  npm run typecheck -w @meshimap/core
  npm run test:coverage -w @meshimap/core
  npm run test:mutation -w @meshimap/core
  npm run format:check
  ```

  4 つすべて成功したら Phase 2 は完了。タスク単位（1 タスク 1 コミット）でコミットする。

---

## Phase 2 完了チェックリスト

- [x] `npm run test -w @meshimap/core` が `Tests  323 passed (323)` で全件 PASS する
- [x] `npm run test:coverage -w @meshimap/core` で Statements / Branches / Functions / Lines がすべて 100%
- [x] `npm run test:mutation -w @meshimap/core` がミューテーションスコア 85% 以上（実測 100.00%）で成功する
- [x] `npm run typecheck -w @meshimap/core` がエラーなしで通る
- [x] `npm run format:check` が `packages/` 配下で通る（Phase 3〜6 の計画文書 4 件は別エージェントが執筆中のため未整形。該当エージェント完了後に `prettier --write` をかける）
- [x] `packages/core/src/` に 13 個の実装ファイルと 13 個のテストファイルがある（サブディレクトリを作っていない）
- [x] `packages/core/package.json` の `dependencies` が `@meshimap/geo` と `zod` の 2 つだけ
- [x] `packages/core/stryker.config.json` が `testRunner: "command"` + `coverageAnalysis: "off"` になっている
- [x] `any` を 1 箇所も使っていない（`grep -rn ": any\|as any\|<any>" packages/core/src` が 0 件）
- [x] `as` がブランド型生成の 8 箇所と `as const` 以外に無い
- [x] `toSorted` / `toReversed` / `Object.groupBy` を使っていない（`lib: ["ES2022"]` では型が無い）
- [x] 型だけの import がすべて `import type` になっている（`verbatimModuleSyntax`）
- [x] `Intl` / `toLocaleString` を実装コードで使っていない（テストの期待値生成でのみ使用可）
- [x] `new Date()` を実装コードで呼んでいない（現在時刻は必ず引数で受け取る）
- [x] `getHours` / `getDate` / `getDay` / `getMonth` / `getFullYear`（`getUTC*` でない版）を実装コードで呼んでいない
- [x] 各タスクの「意図的にコードを壊す」ステップをすべて実施し、表どおりに FAIL することを目視した
- [x] `packages/core/README.md` がある
- [x] `packages/geo` と `apps/mobile` のコードを 1 行も変更していない（`apps/mobile/tsconfig.json` と `assets/expo.icon/icon.json` は `format:check` を通すための prettier 整形のみ。意味の変更なし）
- [ ] コミットがタスク単位で分かれている

---

## 次フェーズへの引き継ぎ

Phase 3（D1 スキーマ / シード）と Phase 4（API 基盤）は、`@meshimap/core` の次のシンボルに依存する。名前・型・値を変える場合は、この表の行き先も必ず更新すること。

| `@meshimap/core` のシンボル                                                        | 引き継ぎ先                                                            | 使われ方                                                                               |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `MINUTE_OF_DAY_MIN` / `MINUTE_OF_DAY_MAX`（0 / 2879）                              | Phase 3-5 `db/schema/shop-detail.ts`                                  | `shop_hours.open_minute` / `close_minute` の `CHECK (… BETWEEN 0 AND 2879)`            |
| `DAY_OF_WEEK_MIN` / `DAY_OF_WEEK_MAX`（0 / 6）                                     | Phase 3-5                                                             | `shop_hours.day_of_week` の CHECK。0 = 日曜で `getUTCDay()` と一致させる               |
| `BusinessHours` / `ShopClosure`                                                    | Phase 3-5、Phase 4-9                                                  | テーブル列と 1:1。`shop_closures.date` は `YYYY-MM-DD`（`JstDate`）で保存する          |
| `isOvernight` / `MINUTES_PER_DAY`                                                  | Phase 3-5、Phase 4-12                                                 | 「翌 0:00 閉店（1440）は日跨ぎではない」という境界をスキーマのコメントにも書く         |
| `SeatSettings`（`capacity` 1〜500 / `slotMinutes` 15〜240 / `maxParallel` 1〜100） | Phase 3-6 `db/schema/menu.ts`                                         | `seat_settings` の各列の CHECK 制約の値をこの定数に合わせる                            |
| `RATING_MIN` / `RATING_MAX`（1 / 5）、`summarizeRatings`                           | Phase 3-7 `db/schema/review.ts`、Phase 4 の集計                       | `reviews.rating` の CHECK と、`shops.rating_avg` に保存する丸め済み平均（小数第 1 位） |
| `BUDGET_YEN_MIN` / `BUDGET_YEN_MAX`（0 / 1,000,000）                               | Phase 3-4 `db/schema/shop.ts`                                         | `budget_lunch_min_yen` などの CHECK                                                    |
| `SHOP_NAME_MAX_LENGTH` ほか文字数定数                                              | Phase 3-4 / 3-5 / 3-7 / 3-8                                           | TEXT 列の `CHECK (length(…) <= N)`                                                     |
| `IDENTIFIER_PATTERN` / `IDENTIFIER_MAX_LENGTH`                                     | Phase 3-3 `db/schema/master.ts`、Phase 3-12 シード                    | `genres.id` / `areas.id` を `[A-Za-z0-9_-]{1,64}` に揃える                             |
| `ShopId` / `UserId` / `ReviewId` / `ReservationId`                                 | Phase 4-8 〜 4-12 のリポジトリ層                                      | 引数の型に使い、ID の取り違えをコンパイル時に落とす                                    |
| `Role` / `ROLES` / `canManageShop` / `canModerate`                                 | Phase 3-3 `profiles.role`、Phase 4-4 Actor、Phase 4-6 ロールガード    | 権限判定は `core` の関数を呼ぶ。API 側で条件を書き直さない                             |
| `shopCreateSchema` / `shopUpdateSchema`                                            | Phase 4-10 `repositories/shop-write.ts`、Phase 4-12 `routes/shops.ts` | リクエストボディの検証。`shopUpdateSchema` は空オブジェクトを弾く                      |
| `reviewCreateSchema` / `reservationCreateSchema`                                   | Phase 4-12 以降のルート                                               | 同上                                                                                   |
| `businessHoursSchema`                                                              | Phase 4-12、Phase 3-12 シード                                         | 曜日ごとの営業時間の投入前検証                                                         |
| `getOpenStatus` / `minutesUntilClose`                                              | Phase 4-9 / 4-12 のレスポンス組み立て、Phase 5 の店舗カード           | Worker では `new Date()` を引数として渡す（`core` 内では現在時刻を取らない）           |
| `generateSlots` / `canReserve`                                                     | 予約 API（Phase 4 以降）                                              | 枠の生成と可否判定を API 側で書き直さない                                              |
| `toJstClock` / `toJstDate` / `addJstDays`                                          | Phase 4 全般                                                          | 「今日」の判定は必ず JST。UTC 15:00 で日付が変わる                                     |
| `formatBusinessHours` / `formatBudgetRange` / `formatYen`                          | Phase 5 以降のモバイル表示                                            | 表示文字列を UI 側で組み立てない                                                       |

**Phase 3 で特に注意すること**

- D1（SQLite）に `CHECK` を書くとき、値は `@meshimap/core` の定数と**手で同期**することになる。定数を変えたらマイグレーションも直す必要があるため、変更時はこの表を起点に影響範囲を洗う。
- シード生成（3-12）は `@meshimap/geo` の `encodeGeohash` と `@meshimap/core` の `businessHoursSchema` を両方使う。`packages/core` は `@meshimap/geo` に依存しているが、その逆方向の依存を作らないこと（`geo` は `core` を知らない）。

**Phase 4 で特に注意すること**

- `core` は D1 も Hono も知らない。リポジトリ層が D1 の行を `BusinessHours` などのドメイン型へ変換してから `core` の関数に渡す（変換は Phase 4 側の責務）。
- `core` の関数は例外（`RangeError`）を投げる。Phase 4-1 のエラーハンドラで、`RangeError` を 400 に対応付けるか、リポジトリ層で `safeParse` を使って弾くかを決めておくこと。
