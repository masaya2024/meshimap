# Phase 3: D1 スキーマ + マイグレーション + シード Implementation Plan

> **エージェント作業者へ** — このドキュメントは上から順に実行するための手順書です。
> 各ステップのチェックボックスを埋めながら進めてください。
> コードは省略せず全文を載せてあります。**貼り付けてから読み直す**のではなく、
> 貼り付ける前に「このカラムはなぜ NOT NULL なのか」を 1 行ずつ確認してください。
> 迷ったら `docs/superpowers/specs/2026-09-15-meshimap-design.md` §6 と
> `docs/CODING_GUIDELINES.md` に戻ります。

---

## ゴール

設計書 §12 の Phase 3 到達点は「**データが引ける**」。これを次の 5 点で定義する。

1. 設計書 §6 の **全 25 テーブル**（Better Auth 4 + アプリ 21）が Drizzle スキーマとして定義され、
   `drizzle-kit generate` で生成したマイグレーションがローカル D1 に適用できる。
2. NOT NULL / 外部キー / CHECK / 複合 PK / UNIQUE が **実際に D1 上で効いている**ことを
   自動テストで証明できる（「制約を書いた」ではなく「制約が違反を弾いた」まで確認する）。
3. 設計書のインデックス方針（`shops(geohash)` / `shops(lat,lng)` / `shops(genre_id,status)` /
   `shops(area_id,status)` / `reviews(shop_id, created_at DESC)` / `reservations(shop_id, reserved_at)`）が
   マイグレーション SQL に現れている。
4. FTS5 仮想テーブル `shops_fts` が存在し、`shops` への INSERT / UPDATE / DELETE が
   トリガで同期され、日本語のキーワードで MATCH できる。
5. 東京都内 12 エリアに **店舗 60 件**の決定論的シードが入り、設計書 §3.1 の 3 段構え
   （geohash 前方一致 → 境界ボックス → Haversine）が **段ごとに件数が正しく絞られていく**ことを
   テストで示せる。

**このフェーズで作らないもの**（Phase 4 以降の担当）

| 作らないもの                               | 担当フェーズ          | 理由                                                       |
| ------------------------------------------ | --------------------- | ---------------------------------------------------------- |
| Hono のルート / ミドルウェア               | Phase 4               | HTTP は DB の責務ではない                                  |
| `OwnerActor` / `AdminActor` ブランド型     | Phase 4               | 設計書 §3.2 の権限主体。認証ミドルウェアとセット           |
| リポジトリ層（`src/repositories/`）        | Phase 4               | 権限主体を引数に取る関数群。Phase 3 は素の DB アクセスのみ |
| `packages/core` のロール定数・Zod スキーマ | Phase 2（並行作業中） | **絶対に触らない**。§グローバル制約を参照                  |
| 予約枠の排他制御（Durable Objects）        | Phase 7               | スキーマだけ用意する                                       |

---

## アーキテクチャ

### スキーマのファイル分割と依存方向

`src/db/schema.ts` 1 枚にすると 25 テーブル・約 900 行になり、差分レビューが不可能になる。
責務ごとに 9 ファイルへ分割する。

**分割の基準は「外部キーの向き」**。SQLite の外部キーは Drizzle 上で
`.references(() => otherTable.column)` と書くが、これはモジュールのトップレベルで
`otherTable` を参照するため、**循環 import になると実行時に `undefined` になって落ちる**。
そこで「参照される側が必ず先」になる一方向の依存だけを許す。

```
                       auth.ts          （user / session / account / verification）
                          │              Better Auth が管理するテーブル。何も参照しない
                          ▼
                      master.ts          （profiles / genres / areas）
                          │              profiles → user.id、areas → areas.id（自己参照）
                          ▼
                       shop.ts           （shops）
                          │              shops → user.id / genres.id / areas.id
        ┌──────────┬──────┴──────┬────────────┬────────────┐
        ▼          ▼             ▼            ▼            ▼
 shop-detail.ts  menu.ts     review.ts  reservation.ts collection.ts
 shop_hours      menu_categories reviews   reservations  favorites
 shop_closures   menu_items   review_photos              lists
 shop_photos     seat_settings review_replies            list_items
        └──────────┴──────┬──────┴────────────┴────────────┘
                          ▼
                      admin.ts           （reports / shop_applications / notifications / audit_logs）
                          │              user / shops を参照する。最下流
                          ▼
                      index.ts           （全テーブルの再エクスポート。誰からも参照されない）
```

**このグラフに後ろ向きの辺は 1 本もない。** 実装時のルールは 1 つだけ:

> あるファイルが import してよいのは、上の図で**自分より上にあるファイルだけ**。
> `shop.ts` が `review.ts` を import したくなったら、それは設計が間違っている。

唯一の例外が `areas.parent_id → areas.id` の**自己参照**。同一ファイル内かつ
関数の遅延評価（`() => areas.id`）なので循環にならないが、TypeScript の型推論が
無限再帰するため `AnySQLiteColumn` の明示的な戻り値型注釈が必要になる（Task 3-3 で詳述）。

### 3 段構え地理空間検索のデータ配置

設計書 §3.1 の 3 段を、どのレイヤが担うかを先に固定する。

| 段  | 処理                                                   | 実行場所             | 使うインデックス    | Phase 3 の成果物                 |
| --- | ------------------------------------------------------ | -------------------- | ------------------- | -------------------------------- |
| 1   | geohash プレフィックス一致（中心セル + 8 近傍）        | D1（SQL）            | `idx_shops_geohash` | `shops.geohash` カラムと索引     |
| 2   | 境界ボックスで再フィルタ（`lat`/`lng` の範囲比較のみ） | D1（SQL）            | `idx_shops_lat_lng` | `shops.lat` / `shops.lng` と索引 |
| 3   | Haversine で厳密距離 → 半径判定 → 距離順ソート         | Worker（TypeScript） | なし                | `findNearbyShops()`              |

段 1・2 は **1 本の SQL** にまとめる（往復を増やさないため）。
段 3 は `@meshimap/geo` の `distanceMeters()` を候補件数ぶんだけ回す。

設計書は「SQL 内の三角関数に依存する設計は避ける」と明記している
（[workerd#1245](https://github.com/cloudflare/workerd/issues/1245)）。
したがって **SQL に `sin` / `cos` / `acos` / `radians` を一切書かない**。
これは Task 3-13 のテストで機械的に検査する。

---

## 技術スタック（実測値）

**記憶で書かず、すべて `node_modules` を読んで確認した値**。
確認コマンドは `node -p "require('<repo>/node_modules/<pkg>/package.json').version"`。

| パッケージ                  | 実測バージョン         | Phase 3 での役割                                                            |
| --------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| `drizzle-orm`               | **0.45.2**             | スキーマ定義（`drizzle-orm/sqlite-core`）と D1 ドライバ（`drizzle-orm/d1`） |
| `drizzle-kit`               | **0.31.10**            | `drizzle-kit generate` によるマイグレーション SQL 生成                      |
| `wrangler`                  | **4.131.2**            | `wrangler d1 migrations apply --local` / `wrangler d1 execute`              |
| `miniflare`                 | **5.20260911.1-alpha** | Vitest から Node 内で本物の D1（SQLite）を起動する                          |
| `vitest`                    | **5.0.0**              | テストランナー                                                              |
| `typescript`                | **6.0.3**              | `tsc --noEmit` による型検査                                                 |
| `@cloudflare/workers-types` | **5.20260915.1**       | `D1Database` 型                                                             |
| `better-auth`               | **1.7.5**              | 認証テーブルの定義元（スキーマは手書きで合わせる）                          |
| `zod`                       | **4.6.5**              | Phase 3 では未使用（Phase 4 で使う）                                        |
| `tsx`                       | **4.23.13**            | シード生成スクリプトの実行（`node_modules/.bin/tsx`）                       |
| `@meshimap/geo`             | ワークスペース内       | `encodeGeohash` / `distanceMeters` / `boundingBox` / `cellsForRadius`       |

**インストールされていないもの**（実測で確認済み。これらを前提にしない）

- `better-sqlite3` — 入っていない。D1 のローカル実体には **miniflare を使う**
- `@cloudflare/vitest-pool-workers` — 入っていない。通常の Vitest プールで miniflare を直接起動する
- `vite-node` — 入っていない

---

## グローバル制約

作業者は以下を**例外なく**守ること。

1. **`packages/core` / `packages/geo` / `apps/mobile` を編集しない。** 読むだけ。
   特に `packages/core` は Phase 2 の担当者が**並行作業中**。ファイルを 1 つでも作ると衝突する。
2. **ロール定数・バリデーション定数を `packages/core` に置かない。**
   Phase 3 で必要な値は `apps/api/src/db/constants.ts` に置き、
   「Phase 4 以降で `@meshimap/core` に寄せる」旨のコメントを必ず添える。
3. **`any` と `as` を書かない。** ブランド型生成時のみ `as` を許可するが、Phase 3 では出番がない。
4. **`console.log` を書かない。** シード生成スクリプトの標準出力は
   `process.stdout.write()` を使う（CLI としての出力であり、デバッグログではないため）。
5. **マジックナンバー・マジックストリングを書かない。**
   `'published'` も `5` も `constants.ts` の定数を参照する。
6. **コメントは日本語**で、「何を」ではなく「**なぜ**」を書く。
7. **DB のテーブル名・カラム名は snake_case**、Drizzle のプロパティ名は camelCase。
   両者がずれるのは意図的（`emailVerified` ⇔ `email_verified`）。
8. **TDD を守る。** テストを書く → **実行して失敗を見る** → 最小実装 → 緑。
   さらに各タスクの最後に「**わざと壊してテストが落ちることを確認する**」ステップがある。
   これを飛ばすと「テストが何も検証していなかった」に気づけない。
9. **`git` コマンドを実行しない。** コミットは親エージェントが行う。
   各タスク末尾の「コミット」ステップは、変更が完了した旨を報告するだけでよい。

### すべてのコマンドの前置き

Node 22 を使う。**毎回**先頭に付けること（シェルの状態は引き継がれない）。

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
```

`npm run` 経由ではなく `node node_modules/.bin/<cli>` を直接叩く場面がある。
これはワークスペースのバイナリ解決を確実にするため。

---

## 実測で確定した事実（このフェーズの前提）

計画を書く前に実際に動かして確認した。**推測ではない。** 実装中に疑わしくなったら再現できる。

| #   | 事実                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 確認方法                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `sqliteTable` の第 3 引数は**配列を返す**関数。オブジェクトを返す形は `@deprecated`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `node_modules/drizzle-orm/sqlite-core/table.d.ts`                                                                                                       |
| F2  | SQLite の index builder に `.desc()` は**ない**。降順索引は ``sql`${col} desc` `` で書く                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `node_modules/drizzle-orm/sqlite-core/indexes.d.ts`（`IndexColumn = SQLiteColumn \| SQL`）                                                              |
| F3  | `primaryKey({ columns: [...] })` のオブジェクト形が現行。可変長引数形は `@deprecated`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `node_modules/drizzle-orm/sqlite-core/primary-keys.d.ts`                                                                                                |
| F4  | `text(name, { enum: [...] })` は SQL 上**ただの `text`**。CHECK は生成されない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `drizzle-kit generate` の出力を目視                                                                                                                     |
| F5  | DB レベルで値を縛るには `check(name, sql)` を自分で書く必要がある                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 同上。`CONSTRAINT "ck_..." CHECK(...)` が出力された                                                                                                     |
| F6  | `driver: 'd1-http'` の `drizzle.config.ts` は**認証情報なしでも `generate` が通る**（`push` は通らない）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `node node_modules/.bin/drizzle-kit generate --name=init` を実行                                                                                        |
| F7  | 生成 SQL の文の区切りは `--> statement-breakpoint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 生成された `migrations/0000_*.sql`                                                                                                                      |
| F8  | `wrangler d1 migrations apply <db> --local` は**手書きの生 SQL マイグレーションもそのまま適用する**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | FTS5 の CREATE VIRTUAL TABLE を含む `.sql` を置いて実行                                                                                                 |
| F9  | ローカル D1 の実体は `apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 適用後に `find .wrangler -name '*.sqlite'`                                                                                                              |
| F10 | D1 で FK 違反は `FOREIGN KEY constraint failed: SQLITE_CONSTRAINT`、CHECK 違反は `CHECK constraint failed: <制約名>: SQLITE_CONSTRAINT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 意図的に違反する INSERT を実行                                                                                                                          |
| F11 | FTS5 の `unicode61` トークナイザは**日本語で使い物にならない**（空白で切るため）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 日本語行を入れて MATCH → 0 件                                                                                                                           |
| F12 | FTS5 の `trigram` トークナイザは D1 で**動く**。ただし MATCH の語は **3 文字以上**必要                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `'焼鳥'`（2 文字）→ 0 件 / `'炭火焼'` → ヒット                                                                                                          |
| F13 | Miniflare 5 は `new Miniflare(convertV4MiniflareOptions({...}))` の形で起動する。V4 形式の素のオブジェクトを渡すと `ERR_VALIDATION`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `node_modules/miniflare/dist/src/index.d.ts` に `convertV4MiniflareOptions` の宣言あり                                                                  |
| F14 | `D1Database.exec()` は**単一行の SQL しか受け付けない**。改行を空白に潰す必要がある                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 改行入りで実行 → 失敗、`.replaceAll('\n',' ')` で成功                                                                                                   |
| F15 | `@meshimap/geo` は拡張子なしの相対 import を使っているため、素の `node` / `node --experimental-strip-types` では解決できない。**`tsx` を使う**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `ERR_MODULE_NOT_FOUND: .../packages/geo/src/constants` → `tsx` では成功                                                                                 |
| F16 | D1 では `sqlite_version()` が `not authorized to use function` で拒否される                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `wrangler d1 execute --local --command "select sqlite_version()"`                                                                                       |
| F17 | **`check()` の中で `` sql`${値}` `` と書くと DDL に `?` が出力され壊れた SQL になる**。実測: `CHECK("profiles"."role" IN (?, ?, ?))`。定数は `sql.raw()` で**リテラルとして埋め込む**必要がある                                                                                                                                                                                                                                                                                                                                                                                                                                      | `drizzle-kit generate` の出力を両方の書き方で比較                                                                                                       |
| F18 | `sql.raw()` を使うと `CHECK("profiles"."role" IN ('user', 'owner', 'admin'))` と正しく出力され、D1 に適用すると `CHECK constraint failed: ck_profiles_role` で違反を弾く                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 生成 → `wrangler d1 migrations apply --local` → 違反 INSERT                                                                                             |
| F19 | `areas.parent_id → areas.id` の自己参照 FK は `.references((): AnySQLiteColumn => areas.id, { onDelete: 'set null' })` で正しく生成される                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 生成 SQL に `FOREIGN KEY (`parent_id`) REFERENCES `areas`(`id`) ... ON DELETE set null` を確認                                                          |
| F20 | 降順索引は ``index('..').on(sql`${table.col} desc`)`` で `CREATE INDEX ... ("created_at" desc)` になる                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 同上                                                                                                                                                    |
| F21 | ローカル D1 は `database_id` がプレースホルダのままでも動く。Cloudflare へのログインは不要                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `database_id: "PLACEHOLDER_SET_BY_WRANGLER_D1_CREATE"` のまま `migrations apply --local` が成功                                                         |
| F22 | D1 は**既定で `PRAGMA foreign_keys = 1`**。`PRAGMA foreign_keys` を問い合わせて `{"foreign_keys":1}` を確認。違反時のメッセージは `D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)`。`ON DELETE cascade` も実際に子行が消える                                                                                                                                                                                                                                                                                                                                                    | miniflare 上で親を DELETE して子の件数が 0 になることを確認                                                                                             |
| F23 | SQLite は `PRIMARY KEY` だけでは NULL を許す（歴史的仕様）。ただし Drizzle の `.primaryKey()` は `text PRIMARY KEY NOT NULL` を生成するため実害はない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 生成 SQL と miniflare での INSERT で確認                                                                                                                |
| F24 | `tsx` は実行位置の `package.json` に `"type": "module"` がないと CJS 扱いになり、トップレベル await が `Top-level await is currently not supported with the "cjs" output format` で落ちる。`apps/api/package.json` は `"type": "module"` なので問題ない                                                                                                                                                                                                                                                                                                                                                                              | 型なしディレクトリで再現 → `apps/api` では成功                                                                                                          |
| F25 | SQLite の GLOB で「許可文字だけからなる」を表すには `col NOT GLOB '*[^a-z0-9-]*'` と書く。`col GLOB '[a-z0-9-]*'` は**先頭 1 文字しか見ない**ので誤り（`'ra men'` が通ってしまう）。空文字も通るため `col <> ''` との AND が要る                                                                                                                                                                                                                                                                                                                                                                                                     | D1 上で 8 パターンを評価して真理値を確認                                                                                                                |
| F26 | CHECK 式が NULL に評価される行は**違反とみなされない**（SQLite の仕様）。`length(bio) <= 500` を NULL 可の列にそのまま書いてよい                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `bio = NULL` の INSERT が通ることを確認                                                                                                                 |
| F27 | SQLite の `length()` は TEXT では**文字数**を返す（`length('あいう')` = 3）。BLOB ではバイト数（= 9）。文字数上限をそのまま書ける                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | D1 上で評価                                                                                                                                             |
| F28 | `matchesGlob(col, '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')` で `YYYY-MM-DD` 書式を DB で強制できる（`'2026-9-15'` は拒否される）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | D1 上で CHECK を張って INSERT                                                                                                                           |
| F29 | **`geohash GLOB 'xn76f*'` は索引を使うが `geohash LIKE 'xn76f%'` はフルスキャンになる**。SQLite の LIKE 最適化は既定の `case_sensitive_like=OFF` では効かないため。**Drizzle の `like()` を geohash 検索に使ってはいけない**。なお `GLOB ?` はバインド値が前方一致パターンなら索引を使う（実装は範囲比較を採用。理由は `packages/geo/README.md`）                                                                                                                                                                                                                                                                                    | `EXPLAIN QUERY PLAN` を両方で比較。GLOB → `SEARCH shops USING INDEX idx_shops_geohash`、LIKE → `SCAN shops`                                             |
| F30 | `GLOB ?`（バインドパラメータ）でも索引が効く。9 セルを `OR` で並べると `MULTI-INDEX OR` になり 9 本とも索引検索になる                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 同上                                                                                                                                                    |
| F31 | `WHERE status = ? AND (geohash GLOB ? OR ...)` は `(geohash)` 単独索引だと status 側の索引に流れてしまう。**`(status, geohash)` の複合索引**を足すと 9 本とも `SEARCH ... (status=? AND geohash>? AND geohash<?)` になる                                                                                                                                                                                                                                                                                                                                                                                                             | 300 行投入 + `ANALYZE` 後に `EXPLAIN QUERY PLAN`                                                                                                        |
| F32 | 段 1（geohash）と段 2（bbox）を 1 本の SQL にまとめると、プランナはデータ分布に応じて `idx_shops_status_geohash` と `idx_shops_lat_lng` のどちらかを選ぶ。**どちらを選んでも索引検索であり全表走査にはならない**。テストでは「特定の索引名」ではなく「`SCAN shops` が出ないこと」を検証する                                                                                                                                                                                                                                                                                                                                          | 同上                                                                                                                                                    |
| F33 | `uniqueIndex(name).on(col).where(sql)` は drizzle-kit 0.31.10 で `CREATE UNIQUE INDEX ... WHERE "t"."is_cover";` として正しく出力される（部分ユニーク索引が使える）                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `drizzle-kit generate` の出力を確認                                                                                                                     |
| F34 | 部分ユニーク索引に違反したときのエラーは `UNIQUE constraint failed: shop_photos.shop_id`（索引名ではなく列名が出る）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | miniflare の D1 で INSERT を実行                                                                                                                        |
| F35 | `mode: 'boolean'` の列を `sql` の中でそのまま真偽値として使える（`CHECK((t.is_closed AND ...) OR (NOT t.is_closed AND ...))`）。列のみの補間なのでバインドパラメータが混入しない                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `drizzle-kit generate` + D1 で 12 ケース検証                                                                                                            |
| F36 | D1 は `CHECK` の失敗を `CHECK constraint failed: <制約名>` として返すので、テストで制約名まで検証できる                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 同上                                                                                                                                                    |
| F37 | `foreignKey({ columns: [a, b], foreignColumns: [X.a, X.b] })` で複合外部キーを張れる。参照先には `uniqueIndex` が必須で、無いと INSERT 時に `foreign key mismatch - "menu_items" referencing "menu_categories"` になる（DDL 適用時にはエラーにならない）                                                                                                                                                                                                                                                                                                                                                                             | miniflare の D1 でユニーク索引を外して INSERT                                                                                                           |
| F38 | 複合外部キーは片方が NULL なら成立する（SQLite の既定は MATCH SIMPLE）。`category_id IS NULL` の未分類メニューを登録できる                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 同上                                                                                                                                                    |
| F39 | drizzle-kit 0.31.10 は SQLite の外部キーに `CONSTRAINT <名前>` を出力しない。`foreignKey({ name })` を書いても DDL には出ないので、テストは `FOREIGN KEY constraint failed` で検証する                                                                                                                                                                                                                                                                                                                                                                                                                                               | 生成された DDL を確認                                                                                                                                   |
| F40 | `shops → menu_categories → menu_items` と `shops → menu_items` の 2 経路の CASCADE が同時に成立しても SQLite は問題なく削除する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | miniflare の D1 で店舗削除                                                                                                                              |
| F41 | SQLite は昇順索引を逆向きに走査できるため、`ORDER BY created_at DESC` に対して `(shop_id, created_at)` でも `(shop_id, created_at DESC)` でも実行計画は同じ（どちらも `USE TEMP B-TREE` が出ない）。索引を**消した**ときだけ `SCAN r \| USE TEMP B-TREE FOR ORDER BY` になる                                                                                                                                                                                                                                                                                                                                                         | miniflare の D1 で 3 パターンの `EXPLAIN QUERY PLAN` を比較                                                                                             |
| F42 | `reviews(shop_id, created_at desc)` の索引があれば `WHERE shop_id = ? ORDER BY created_at DESC` は `SEARCH reviews USING INDEX ...` になり一時 B-Tree は出ない                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 同上                                                                                                                                                    |
| F43 | `primaryKey({ columns: [a, b] })` は複合主キー句 PRIMARY KEY(a, b) を生成し、違反時のメッセージは `UNIQUE constraint failed: <table>.<a>, <table>.<b>`（**定義した列順がそのまま出る**）                                                                                                                                                                                                                                                                                                                                                                                                                                             | miniflare の D1 で `favorites` / `list_items` に二重 INSERT                                                                                             |
| F44 | SQLite のユニーク索引は NULL を重複とみなさない。`uniqueIndex` を張った列に NULL は何行でも入る（`lists.share_token` の未共有リスト、`reports.reporter_id` の匿名通報）                                                                                                                                                                                                                                                                                                                                                                                                                                                              | miniflare の D1 で NULL 行を 2 件 INSERT                                                                                                                |
| F45 | **`ON DELETE set null` が起こす UPDATE にも CHECK 制約が効く**。`(handled_by IS NULL) = (handled_at IS NULL)` のような双方向の等式を置くと、対応済み通報がある管理者を削除した時点で `DELETE` が `CHECK constraint failed` で失敗する。含意 2 本（`handled_by IS NULL OR handled_at IS NOT NULL` と `status IN (...) OR handled_at IS NOT NULL`）に分けると通る                                                                                                                                                                                                                                                                      | miniflare の D1 で管理者 `DELETE` を両方の定義で実行                                                                                                    |
| F46 | CHECK 制約は UPDATE にも効く。`status` だけを `resolved` に変える UPDATE は `ck_reports_closed_requires_time` で弾かれる                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 同上                                                                                                                                                    |
| F47 | D1（miniflare / 本番とも SQLite）は JSON1 拡張を持ち、`json_valid()` `json_type()` `json_extract()` を CHECK と SELECT の両方で使える                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | miniflare の D1 で壊れた JSON を INSERT し、正しい配列から `json_extract(documents, '$[0].kind')` を取得                                                |
| F48 | `text(..., { mode: 'json' }).default([])` は DDL に `DEFAULT '[]'` という**文字列リテラル**として焼き込まれる                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `drizzle-kit generate` の出力と実際の SELECT 値を確認                                                                                                   |
| F49 | `index(...)` に `.where(...)` を付けた部分索引は `WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC` で確かに選ばれ、`read_at` 条件のないクエリでは通常索引が選ばれる                                                                                                                                                                                                                                                                                                                                                                                                                                                   | miniflare の D1 で 2 パターンの `EXPLAIN QUERY PLAN`                                                                                                    |
| F50 | 索引の先頭が式（`created_at desc` だけの索引）でも `ORDER BY created_at DESC LIMIT 50` は `SCAN audit_logs USING INDEX idx_audit_logs_created` になり、一時 B-Tree は出ない                                                                                                                                                                                                                                                                                                                                                                                                                                                          | miniflare の D1 で `EXPLAIN QUERY PLAN`                                                                                                                 |
| F51 | D1 は FTS5 を持ち、`unicode61` / `porter` / `trigram` のトークナイザがすべて使える                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | miniflare の D1 で `CREATE VIRTUAL TABLE … USING fts5(…)` を 4 パターン実行                                                                             |
| F52 | `tokenize='trigram'` は **3 文字以上**の検索語しかヒットしない。`ラーメン`(4) `渋谷区`(3) `こうじ`(3) は当たるが `寿司`(2) `豚骨`(2) `渋谷`(2) はゼロ件。英字は大小を区別しない                                                                                                                                                                                                                                                                                                                                                                                                                                                      | miniflare の D1 で 9 パターンの `MATCH`                                                                                                                 |
| F53 | `unicode61`（既定）は日本語を分割しない。`濃厚な豚骨ラーメンが看板メニュー` は丸ごと 1 トークンになり、`ラーメン` でも `豚骨` でもヒットしない（全文完全一致だけ当たる）                                                                                                                                                                                                                                                                                                                                                                                                                                                             | ローカル D1 で `unicode61` の仮想テーブルに同じ文字列を入れて比較                                                                                       |
| F54 | `wrangler d1 migrations apply --local` は `CREATE TRIGGER … BEGIN … ; … ; END;` を**1 文として正しく扱う**（本体の `;` で分割されない）。非対話環境では確認プロンプトに自動で yes が入る                                                                                                                                                                                                                                                                                                                                                                                                                                             | 専用の使い捨てプロジェクトで実際に適用し、`sqlite_master` にトリガー 3 本を確認                                                                         |
| F55 | 検索語を二重引用符で包まずに `MATCH` へ渡すと例外になる。`道玄坂1-2-3` → `no such column: 2`、`(` → `fts5: syntax error`、`O'Brien` → `fts5: syntax error`。包めばすべてただの語句として扱われ、`*` も `OR` もリテラルになる                                                                                                                                                                                                                                                                                                                                                                                                         | miniflare の D1 で 11 パターンの `MATCH`                                                                                                                |
| F56 | `content='shops'` の外部コンテンツ表では影テーブルが `_config` `_data` `_docsize` `_idx` の 4 つだけになり、`_content` は作られない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `sqlite_master` を一覧                                                                                                                                  |
| F57 | 外部コンテンツ表の削除は `INSERT INTO shops_fts(shops_fts, rowid, …) VALUES('delete', …)` で行う。`INSERT INTO shops_fts(shops_fts) VALUES('integrity-check')` で本体との食い違いを検出できる                                                                                                                                                                                                                                                                                                                                                                                                                                        | miniflare の D1 で UPDATE / DELETE 後に実行                                                                                                             |
| F58 | `drizzle-kit generate --custom --name=X` は空の SQL ファイルとスナップショットを同時に作るため、手書き SQL を混ぜても次回以降の採番が壊れない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 使い捨てプロジェクトで `--custom` 実行後に `_journal.json` と `meta/` を確認                                                                            |
| F59 | D1 では `sqlite_version()` と `pragma_compile_options` が `SQLITE_AUTH` で拒否される。SQLite のバージョンや機能を実行時に問い合わせることはできない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | miniflare の D1 で実行                                                                                                                                  |
| F60 | `D1Database.exec()` は改行を含む SQL を受け付けないが、改行を空白へ潰すより先に行頭コメントを消さないと `--` 以降が全部コメントになり `SQL code did not contain a statement` で落ちる。`0001_shops_fts.sql` のようにコメント付きの手書き SQL で必ず踏む                                                                                                                                                                                                                                                                                                                                                                              | 25 テーブル全部を入れた使い捨てプロジェクトで `applyMigrations` 相当を実行して再現、行頭コメント除去で解消                                              |
| F61 | `wrangler d1 migrations apply --local` は `0000_init.sql`（80 文）と `0001_shops_fts.sql`（5 文）を順に適用でき、FTS5 の仮想テーブルとトリガー 3 本も通る                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 25 テーブルの使い捨てプロジェクトで実行、`_journal` の 2 件が両方 ✅                                                                                    |
| F62 | シードを `wrangler d1 execute --local --file` で 2 回流しても件数が変わらない（shops 60 / reviews 109 / shops_fts 60 / rating_avg の総和 179.49 が一致）。先頭の `DELETE FROM` 群と `PRAGMA defer_foreign_keys` で冪等になる                                                                                                                                                                                                                                                                                                                                                                                                         | 同じ D1 に 2 回投入して集計を比較                                                                                                                       |
| F63 | `shops` に INSERT すると `shops_fts` にトリガー経由で 60 行が入り、`INSERT INTO shops_fts(shops_fts) VALUES('integrity-check')` が成功する（索引と本体が一致している）                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 60 店舗投入後に実行                                                                                                                                     |
| F64 | 投入した 60 店舗に対し、渋谷駅からの 3 段階検索は下表のとおりの件数を返す。5000m だけ段 2（矩形）と段 3（厳密）が 28 → 25 と食い違い、Haversine の必要性が数字で出る                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | miniflare の D1 + `packages/geo` で 6 半径ぶん実測                                                                                                      |
| F65 | `status = 'published' AND (geohash GLOB 'xn76f*' OR geohash GLOB 'xn76g*')` は `MULTI-INDEX OR` で 2 本とも `idx_shops_status_geohash` を使う。`lat`/`lng` の BETWEEN を足しても同じ索引のまま絞り込みだけが増える                                                                                                                                                                                                                                                                                                                                                                                                                   | `EXPLAIN QUERY PLAN` を 60 店舗入りの D1 で実行                                                                                                         |
| F66 | **2026-09-15 に訂正（旧記述は誤り）。** `GLOB ?` はバインド値が前方一致パターンなら索引を使い、範囲比較とまったく同じプランになる（旧記述はバインドせずに測っていた）。それでも**実装では範囲比較 `geohash >= ? AND geohash < ?` を使う**。理由は速度ではなく、**プランが実行時のバインド値に左右されないこと**。`GLOB ?` は先頭ワイルドカードや NULL を渡されると `SCAN` へ落ちるが、範囲比較は値に関係なく必ず索引を使う。`'{'`（0x7B）は base32 の最大文字 `'z'`（0x7A）の次なので、`prefix` 〜 `prefix + '{'` がちょうど前方一致の範囲になる                                                                                     | 10 パターンを実測（`packages/geo/README.md` に表がある）。契約テストは `apps/api/src/db/schema/shop.test.ts`                                            |
| F67 | D1 の `SQLITE_MAX_COMPOUND_SELECT` は **5**。6 項以上の `UNION` / `UNION ALL` は `too many terms in compound SELECT` で失敗する。9 セルを UNION で並べる実装は取れない                                                                                                                                                                                                                                                                                                                                                                                                                                                               | miniflare の D1 で 2〜12 項の `UNION ALL` を実行し、6 項で失敗することを確認                                                                            |
| F68 | 1 本の SQL に geohash の OR と `lat`/`lng` の BETWEEN を両方書くと、プランナは `idx_shops_lat_lng` 1 本を選び geohash 条件は後置フィルタになる。**段 1 だけを SQL に出し、段 2（矩形）は TS 側でやる**と geohash 索引が主役になる                                                                                                                                                                                                                                                                                                                                                                                                    | 30,060 行で「OR + BETWEEN」「OR のみ」を比較                                                                                                            |
| F69 | `ANALYZE` を打つ前は 9 セルの OR が `idx_shops_status_rating` の 1 本走査に落ちるが、打つと `MULTI-INDEX OR` で 9 本すべてが `idx_shops_status_geohash` を使う。統計は `sqlite_stat1` に入り、シードを流し直しても残る                                                                                                                                                                                                                                                                                                                                                                                                               | 60 行のシード投入後と 30,060 行の両方で ANALYZE 前後の `EXPLAIN QUERY PLAN` を比較                                                                      |
| F70 | `migrations/` を丸ごと消して `drizzle-kit generate --name=init` をやり直すと、`0000_init.sql` は 1 バイトも変わらない（`diff` で確認）。ただし `meta/_journal.json` の `when` は実行時刻なので毎回変わる。**再現性を確かめる対象は .sql だけ**                                                                                                                                                                                                                                                                                                                                                                                       | 25 テーブルの使い捨てプロジェクトで再生成して `diff`                                                                                                    |
| F71 | スキーマに変更が無い状態で `drizzle-kit generate` を打つと `No schema changes, nothing to migrate 😴` と出てファイルを作らない。空のマイグレーションが増えることはない                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 同上                                                                                                                                                    |
| F72 | `drizzle-kit check` はスナップショットとマイグレーションの整合性を検査し、問題なければ `Everything's fine 🐶🔥` と出す。drizzle-kit 0.31.10 のサブコマンド一覧に存在する                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `npx drizzle-kit --help` と実行結果                                                                                                                     |
| F73 | miniflare の D1 は workerd への loopback HTTP なので、`exec()` 1 回が TCP 接続 1 本になる。1 文ずつ流すと 1 回のテスト実行で 1300 本超の接続が立ち、テストを並列に走らせると macOS の一時ポート（`net.inet.ip.portrange` は 49152-65535 の 16384 個、TIME_WAIT は `net.inet.tcp.msl` 15 秒 × 2 = 30 秒）が尽きて `connect EADDRNOTAVAIL 127.0.0.1:xxxxx` で `beforeAll` ごと落ちる。**Stryker の command ランナーは終了コードしか見ないため、この失敗が「その変異を殺した」と記録され、ミューテーションスコアが偽の 100% になる。** `exec()` は受け取った文字列を改行で割って 1 行 1 文として実行するので、改行で繋いで 1 往復で流す | 4 並列の `npx vitest run` を同時に走らせて全滅を再現。1 往復にまとめたら 12 並列でも 0 件になり、スイートも 22 秒から 3.7 秒になった（2026-09-15 実測） |

---

## ファイル構成

`Create` = 新規作成 / `Modify` = 既存を編集 / `Generate` = コマンドの生成物（手書きしない）。

| パス                                           | 区分     | 内容                                                                             |
| ---------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `apps/api/package.json`                        | Modify   | devDependencies に `miniflare` / `tsx` / `vitest`、scripts に `db:seed:generate` |
| `apps/api/drizzle.config.ts`                   | Modify   | `schema` を `./src/db/schema/index.ts` へ                                        |
| `apps/api/vitest.config.ts`                    | Create   | Node 環境。`src/**/*.test.ts`                                                    |
| `apps/api/src/db/constants.ts`                 | Create   | role / status / 数値範囲などの定数                                               |
| `apps/api/src/db/sql-helpers.ts`               | Create   | CHECK 制約の式を組み立てるヘルパ（値をリテラルとして埋め込む）                   |
| `apps/api/src/db/schema/auth.ts`               | Create   | `user` `session` `account` `verification`                                        |
| `apps/api/src/db/schema/master.ts`             | Create   | `profiles` `genres` `areas`                                                      |
| `apps/api/src/db/schema/shop.ts`               | Create   | `shops`                                                                          |
| `apps/api/src/db/schema/shop-detail.ts`        | Create   | `shop_hours` `shop_closures` `shop_photos`                                       |
| `apps/api/src/db/schema/menu.ts`               | Create   | `menu_categories` `menu_items` `seat_settings`                                   |
| `apps/api/src/db/schema/review.ts`             | Create   | `reviews` `review_photos` `review_replies`                                       |
| `apps/api/src/db/schema/reservation.ts`        | Create   | `reservations`                                                                   |
| `apps/api/src/db/schema/collection.ts`         | Create   | `favorites` `lists` `list_items`                                                 |
| `apps/api/src/db/schema/admin.ts`              | Create   | `reports` `shop_applications` `notifications` `audit_logs`                       |
| `apps/api/src/db/schema/index.ts`              | Create   | 全テーブルの再エクスポート                                                       |
| `apps/api/src/db/client.ts`                    | Create   | `createDatabase(d1)` と `Database` 型                                            |
| `apps/api/src/db/testing/local-d1.ts`          | Create   | miniflare で D1 を起動しマイグレーションを適用するテストヘルパ                   |
| `apps/api/src/db/queries/nearby-shops.ts`      | Create   | 3 段構えの半径検索                                                               |
| `apps/api/src/db/queries/search-shops.ts`      | Create   | FTS5 キーワード検索                                                              |
| `apps/api/scripts/generate-seed.ts`            | Create   | 決定論的にシード SQL を生成する CLI                                              |
| `apps/api/migrations/0000_init.sql`            | Generate | `drizzle-kit generate` の出力                                                    |
| `apps/api/migrations/0001_shops_fts.sql`       | Create   | FTS5 仮想テーブルと同期トリガ（手書き）                                          |
| `apps/api/seeds/seed.sql`                      | Generate | `generate-seed.ts` の出力                                                        |
| `apps/api/src/db/schema/master.test.ts`        | Create   | profiles / genres / areas の制約テスト                                           |
| `apps/api/src/db/schema/shop.test.ts`          | Create   | shops の制約・索引テスト                                                         |
| `apps/api/src/db/schema/shop-detail.test.ts`   | Create   | shop_hours / shop_closures / shop_photos                                         |
| `apps/api/src/db/schema/menu.test.ts`          | Create   | menu_* / seat_settings                                                           |
| `apps/api/src/db/schema/review.test.ts`        | Create   | reviews / review_photos / review_replies                                         |
| `apps/api/src/db/schema/reservation.test.ts`   | Create   | reservations                                                                     |
| `apps/api/src/db/schema/collection.test.ts`    | Create   | favorites / lists / list_items                                                   |
| `apps/api/src/db/schema/admin.test.ts`         | Create   | reports / shop_applications / notifications / audit_logs                         |
| `apps/api/src/db/queries/search-shops.test.ts` | Create   | FTS5 の同期とヒット件数                                                          |
| `apps/api/src/db/queries/nearby-shops.test.ts` | Create   | 3 段構えの段別件数                                                               |
| `apps/api/src/db/seed.test.ts`                 | Create   | シード投入後の件数・整合性                                                       |
| `.gitignore`                                   | Modify   | `.wrangler/` を追加                                                              |

---

## タスク一覧

| #    | タスク                                                     | 主な成果物                                          |
| ---- | ---------------------------------------------------------- | --------------------------------------------------- |
| 3-0  | 基盤整備（依存追加 / 設定ファイル / ローカル D1 の作成）   | `vitest.config.ts` `drizzle.config.ts` `.gitignore` |
| 3-1  | `db/constants.ts` — enum 相当の値と数値範囲                | `constants.ts`                                      |
| 3-2  | `db/schema/auth.ts` — Better Auth の 4 テーブル            | `auth.ts`                                           |
| 3-3  | `db/schema/master.ts` — profiles / genres / areas          | `master.ts`                                         |
| 3-4  | `db/schema/shop.ts` — shops と地理空間索引                 | `shop.ts`                                           |
| 3-5  | `db/schema/shop-detail.ts` — 営業時間 / 臨時休業 / 写真    | `shop-detail.ts`                                    |
| 3-6  | `db/schema/menu.ts` — メニュー / 席設定                    | `menu.ts`                                           |
| 3-7  | `db/schema/review.ts` — レビュー / 写真 / 返信             | `review.ts`                                         |
| 3-8  | `db/schema/reservation.ts` + `collection.ts`               | `reservation.ts` `collection.ts`                    |
| 3-9  | `db/schema/admin.ts` — 通報 / 申請 / 通知 / 監査ログ       | `admin.ts`                                          |
| 3-10 | `schema/index.ts` + `client.ts` + 初回マイグレーション生成 | `migrations/0000_init.sql`                          |
| 3-11 | FTS5 仮想テーブルと同期トリガ（手書きマイグレーション）    | `migrations/0001_shops_fts.sql`                     |
| 3-12 | シード生成（東京 12 エリア・店舗 60 件）                   | `scripts/generate-seed.ts` `seeds/seed.sql`         |
| 3-13 | 3 段構え地理空間検索の実装と検証                           | `queries/nearby-shops.ts`                           |
| 3-14 | 品質ゲート（型検査 / 全テスト / マイグレーション再現性）   | —                                                   |

全 **15 タスク**。

---

### Task 3-0: 基盤整備（依存追加・設定ファイル・ローカル D1 の作成）

スキーマを 1 行も書く前に、「書いたものを即座に検証できる」環境を作る。
ここを飛ばすと、Task 3-2 以降で「テストが書けないので目視で確認」になる。

**Files:**

- Modify: `/Users/hattori/Downloads/alee/apps/api/package.json`
- Modify: `/Users/hattori/Downloads/alee/apps/api/drizzle.config.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/vitest.config.ts`
- Modify: `/Users/hattori/Downloads/alee/.gitignore`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/testing/local-d1.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/testing/local-d1.test.ts`

**Interfaces:**

```ts
// Consumes（外部から取り込むもの）
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'; // miniflare 5.20260911.1-alpha
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'; // drizzle-orm 0.45.2

// Produces（このタスクが提供するもの）
export type LocalD1 = {
  readonly d1: D1Database;
  readonly dispose: () => Promise<void>;
};
export function createLocalD1(): Promise<LocalD1>;
export function applyMigrations(d1: D1Database): Promise<number>; // 戻り値は実行した SQL 文の数
```

- [ ] **Step 1: `apps/api/package.json` に devDependencies を追加する**

  `vitest` / `typescript` はルートの devDependencies に既にある（ルート `package.json` で確認済み）。
  Phase 3 で新たに必要なのは `miniflare` と `tsx` の 2 つだけ。
  **バージョンは `node_modules` に実際に入っている値をそのまま指定する**（別エージェントが
  並行作業中のため、メジャーを動かす指定をしてはいけない）。

  `devDependencies` を次のように書き換える。

  ```json
  "devDependencies": {
    "wrangler": "^4.131.2",
    "drizzle-kit": "^0.31.10",
    "@cloudflare/workers-types": "^5.20260915.1",
    "miniflare": "5.20260911.1-alpha",
    "tsx": "^4.23.13"
  }
  ```

  `miniflare` だけキャレット（`^`）を付けないのは、alpha 版はパッチ更新で
  API が変わりうるため（`convertV4MiniflareOptions` の有無に依存している）。

- [ ] **Step 2: `apps/api/package.json` の scripts にシード生成コマンドを追加する**

  既存の `db:seed:local` は `./seeds/seed.sql` を読む。その `seed.sql` を作る側を足す。

  ```json
  "db:seed:generate": "tsx ./scripts/generate-seed.ts > ./seeds/seed.sql",
  "db:reset:local": "rm -rf .wrangler/state/v3/d1 && npm run db:migrate:local && npm run db:seed:local"
  ```

  `db:reset:local` を用意する理由: シードは INSERT の羅列で冪等ではないため、
  作り直すときは DB ごと消すのが最も確実で速い。

- [ ] **Step 3: 依存をインストールする**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  npm install
  ```

  `miniflare@5.20260911.1-alpha` と `tsx@4.23.13` は既にツリーへ入っているため、
  この `install` は `package-lock.json` に依存宣言を書き足すだけで、実体のダウンロードは起きない。
  もし他のパッケージのバージョンが動いたら **その場で中断し、親エージェントへ報告する**。

- [ ] **Step 4: `.gitignore` に `.wrangler/` を追加する**

  現状の `.gitignore` に `.wrangler/` がない。ローカル D1 の SQLite 実体
  （数 MB になる）がコミットされてしまう。`# テスト成果物` セクションの直前に追記する。

  ```gitignore
  # Cloudflare のローカル状態（D1 の SQLite 実体・KV・R2 のエミュレーション）
  .wrangler/
  ```

- [ ] **Step 5: `drizzle.config.ts` の `schema` をディレクトリ分割に合わせる**

  現状は `schema: './src/db/schema.ts'` を指しているが、Task 3-2 以降で
  `src/db/schema/` ディレクトリに分割する。ファイル全文を次に置き換える。

  ```ts
  import { defineConfig } from 'drizzle-kit';

  export default defineConfig({
    // schema/index.ts が全テーブルを再エクスポートしているため、ここ 1 つを指せば全部拾える。
    // ワイルドカード './src/db/schema/*.ts' でも動くが、index.ts 経由にすると
    // 「index に書き忘れたテーブルはマイグレーションにも出ない」という形で漏れに気づける。
    schema: './src/db/schema/index.ts',
    out: './migrations',
    dialect: 'sqlite',
    // D1 に対しては 'd1-http' を指定する。generate は資格情報なしで通る（push には必要）。
    driver: 'd1-http',
  });
  ```

- [ ] **Step 6: `apps/api/vitest.config.ts` を作る**

  `packages/geo/vitest.config.ts` と同じ形にそろえる。ただしカバレッジ閾値 100% は付けない。
  DB スキーマはコードというよりデータ定義であり、行カバレッジが品質の指標にならないため。

  ```ts
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: {
      globals: true,
      environment: 'node',
      include: ['src/**/*.test.ts'],
      // miniflare の起動とマイグレーション適用に時間がかかるため既定の 5s では足りない
      testTimeout: 30_000,
      hookTimeout: 60_000,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.test.ts', 'src/db/schema/**', 'src/db/testing/**'],
      },
    },
  });
  ```

- [ ] **Step 7: 失敗するテストを書く（`src/db/testing/local-d1.test.ts`）**

  まだ `local-d1.ts` も `migrations/` も存在しないので、このテストは必ず落ちる。

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { applyMigrations, createLocalD1, type LocalD1 } from './local-d1';

  describe('createLocalD1', () => {
    let local: LocalD1;

    beforeAll(async () => {
      local = await createLocalD1();
    });

    afterAll(async () => {
      await local.dispose();
    });

    it('miniflare 上で D1 が起動し、単純なクエリが実行できる', async () => {
      const result = await local.d1.prepare('SELECT 1 AS one').first<{ one: number }>();
      expect(result?.one).toBe(1);
    });

    it('applyMigrations は migrations/ の SQL を 1 文以上適用する', async () => {
      const executedStatementCount = await applyMigrations(local.d1);
      expect(executedStatementCount).toBeGreaterThan(0);
    });
  });
  ```

- [ ] **Step 8: テストが失敗することを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/testing/local-d1.test.ts
  ```

  `Failed to resolve import "./local-d1"` で落ちる。**この出力を目で見てから次へ進む。**

- [ ] **Step 9: `src/db/testing/local-d1.ts` を実装する**

  ```ts
  import { readdirSync, readFileSync } from 'node:fs';
  import { dirname, join } from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

  /** wrangler.jsonc の compatibility_date と一致させる。ずれると D1 の挙動が変わりうる */
  const COMPATIBILITY_DATE = '2026-09-01';

  /** drizzle-kit が生成する SQL の文区切り。手書きマイグレーションでも同じ区切りを使う */
  const STATEMENT_SEPARATOR = '--> statement-breakpoint';

  /** 行頭コメント（`--` で始まる行）。1 行に潰す前に落とさないと後続の SQL ごと飲み込まれる */
  const LINE_COMMENT_PATTERN = /^\s*--/;

  /** テスト用の D1 バインディング名。wrangler.jsonc の binding と同じにしておく */
  const D1_BINDING_NAME = 'DB';

  /** miniflare を起動するためだけの最小 Worker。fetch は使わないが modules 形式には必須 */
  const DUMMY_WORKER_SCRIPT = 'export default { fetch() { return new Response("ok"); } };';

  const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

  /** src/db/testing/ から apps/api/migrations/ までの相対位置 */
  const MIGRATIONS_DIR = join(CURRENT_DIR, '..', '..', '..', 'migrations');

  export type LocalD1 = {
    readonly d1: D1Database;
    readonly dispose: () => Promise<void>;
  };

  /**
   * miniflare 上にインメモリの D1 を 1 つ起動する。
   * better-sqlite3 は未導入であり、また「本物の D1（workerd の SQLite）で検証する」ことに
   * 意味があるため、SQLite を直接叩くのではなく miniflare を使う。
   */
  export async function createLocalD1(): Promise<LocalD1> {
    // miniflare 5 は v5 形式のオプションを要求する。V4 形式の素のオブジェクトを渡すと
    // ERR_VALIDATION になるため、公式の変換関数を必ず通す。
    const miniflare = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: DUMMY_WORKER_SCRIPT,
        compatibilityDate: COMPATIBILITY_DATE,
        d1Databases: { [D1_BINDING_NAME]: ':memory:' },
      }),
    );

    const d1 = await miniflare.getD1Database(D1_BINDING_NAME);

    return {
      d1,
      dispose: async () => {
        await miniflare.dispose();
      },
    };
  }

  /**
   * migrations/ 配下の .sql をファイル名順に全部流し込み、実行した文の数を返す。
   * wrangler の d1_migrations テーブルは作らない（テストでは常にまっさらから作るため不要）。
   */
  /**
   * 文の配列を D1 へ **1 往復で** 流し込み、流した文の数を返す。
   * `exec()` は受け取った文字列を改行で割って 1 行 1 文として実行するので、
   * 1 行へ潰した文を改行で繋ぐだけでよい。1 文ずつ呼んではいけない理由は F73。
   */
  async function execAtOnce(d1: D1Database, statements: readonly string[]): Promise<number> {
    await d1.exec(statements.join('\n'));

    return statements.length;
  }

  export async function applyMigrations(d1: D1Database): Promise<number> {
    const statements = readdirSync(MIGRATIONS_DIR)
      .filter((fileName) => fileName.endsWith('.sql'))
      .sort()
      .flatMap((fileName) =>
        readFileSync(join(MIGRATIONS_DIR, fileName), 'utf8')
          .split(STATEMENT_SEPARATOR)
          // D1 の exec() は複数行の SQL を受け付けない（改行があると構文解析に失敗する）。
          // SQL の意味は改行の有無で変わらないため、空白へ潰して 1 行にしてから渡す。
          // ただし改行を消す前に行頭コメントを落とすこと。`-- 説明` が残ったまま 1 行になると
          // 行末までがコメント扱いになり、本体の CREATE 文ごと消えて
          // 「SQL code did not contain a statement」で落ちる（F60）。
          .map((rawStatement) =>
            rawStatement
              .split('\n')
              .filter((line) => !LINE_COMMENT_PATTERN.test(line))
              .join(' ')
              .trim(),
          )
          .filter((statement) => statement.length > 0),
      );

    return execAtOnce(d1, statements);
  }
  ```

  **`exec()` を 1 文ずつ呼んではいけない（F73）。** ここを素直にループで書くと
  マイグレーション 80 文＋シード 1247 文で 1 回のテスト実行が 1300 往復になる。
  単体では「遅い」で済むが、テストを並列に走らせた瞬間に macOS の一時ポートが尽きて
  `connect EADDRNOTAVAIL` で `beforeAll` ごと落ちる。**この形で書くこと。**

- [ ] **Step 10: 空のマイグレーションディレクトリを作り、テストを通す**

  `migrations/` がまだ存在しないと `readdirSync` が `ENOENT` で落ちる。
  Task 3-10 で本物の SQL が生成されるまでの暫定として、ディレクトリだけ作る。

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  mkdir -p /Users/hattori/Downloads/alee/apps/api/migrations
  ```

  この状態では `applyMigrations` は 0 を返すため、Step 7 の 2 つ目のテスト
  （`toBeGreaterThan(0)`）は**まだ落ちたままで正しい**。
  1 つ目（`SELECT 1`）が通ることだけ確認する。

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/testing/local-d1.test.ts
  ```

  期待: `1 passed | 1 failed`。2 つ目は Task 3-10 で緑になる。
  **落ちているテストの内容が「文が 0 件だった」であることを出力で確認する。**
  別の理由（miniflare の起動失敗など）で落ちていたら、そちらを先に直す。

- [ ] **Step 11: `wrangler` でローカル D1 が作れることを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && CI=1 node ../../node_modules/.bin/wrangler d1 migrations apply meshimap-db --local
  ```

  `migrations/` が空なので `No migrations to apply!` と出れば成功。
  **Cloudflare へのログインは不要**で、`wrangler.jsonc` の `database_id` が
  `PLACEHOLDER_SET_BY_WRANGLER_D1_CREATE` のままでもローカル実行は通る（実測済み）。

  ローカル D1 の実体が置かれる場所:

  ```
  apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite
  ```

  `<hash>` は `database_id` から決まる値で、現在のプレースホルダでは
  `75e5d9509b4f64cf73987941476579c6060c86ab0a0ac242a829491e84841838` になる。
  実際の値を知りたいときは次で調べる（本番 ID を設定すると変わる）。

  ```bash
  find /Users/hattori/Downloads/alee/apps/api/.wrangler -name '*.sqlite'
  ```

- [ ] **Step 12: わざと壊して、テストヘルパが本当に D1 を起動していることを確認する**

  `local-d1.ts` の `convertV4MiniflareOptions(...)` の呼び出しを外し、
  `new Miniflare({ modules: true, script: DUMMY_WORKER_SCRIPT, ... })` に一時的に変える。

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/testing/local-d1.test.ts
  ```

  `MiniflareCoreError [ERR_VALIDATION]: workers: undefined ... expected array` で落ちることを確認する。
  これで「テストがモックではなく本物の miniflare を起動している」ことが証明できた。**確認したら元に戻す。**

- [ ] **Step 13: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

  `vitest.config.ts` は `tsconfig.json` の `include`（`src/**/*.ts`）に入っていないため
  型検査の対象外になる。これは意図どおり（Vite の設定ファイルは実行時に別で解決される）。

- [ ] **Step 14: コミット**

  `chore(api): Phase 3 の基盤（miniflare テストヘルパ / vitest 設定 / drizzle 設定）を整える`
  として親エージェントへ報告する。**自分で `git` を実行しない。**

---

### Task 3-1: `db/constants.ts` — enum 相当の値と数値範囲

設計書は status の具体値を決めていない。ここで確定させ、**文字列リテラルをスキーマに直書きしない**
土台を作る。CODING_GUIDELINES の「マジックストリング禁止」に直接効く。

**Files:**

- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/constants.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/constants.test.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/sql-helpers.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/sql-helpers.test.ts`

**Interfaces:**

```ts
// Produces
export const ROLES: readonly ['user', 'owner', 'admin'];
export type Role = (typeof ROLES)[number];
export const PROFILE_STATUSES: readonly ['active', 'suspended', 'deleted'];
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];
export const SHOP_STATUSES: readonly ['draft', 'pending', 'published', 'suspended', 'closed'];
export type ShopStatus = (typeof SHOP_STATUSES)[number];
export const RESERVATION_STATUSES:
  readonly ['pending', 'confirmed', 'rejected', 'cancelled', 'completed', 'no_show'];
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export const REVIEW_STATUSES: readonly ['published', 'hidden', 'deleted'];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REPORT_STATUSES: readonly ['open', 'in_review', 'resolved', 'rejected'];
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REPORT_TARGET_TYPES: readonly ['shop', 'review', 'user'];
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];
export const APPLICATION_STATUSES: readonly ['pending', 'approved', 'rejected', 'returned'];
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export const NOTIFICATION_TYPES: readonly [...];
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
```

- [ ] **Step 1: 失敗するテストを書く（`src/db/constants.test.ts`）**

  ここでのテストの目的は「値が正しいか」ではなく「**値がぶれていないか**」。
  status の文字列は API レスポンスとモバイル側の分岐に現れるため、
  うっかり `'canceled'`（l が 1 つ）に変えたら壊れる。それを検知する回帰テストにする。

  ```ts
  import { describe, expect, it } from 'vitest';
  import {
    APPLICATION_STATUSES,
    NOTIFICATION_TYPES,
    PROFILE_STATUSES,
    REPORT_STATUSES,
    REPORT_TARGET_TYPES,
    RESERVATION_STATUSES,
    REVIEW_STATUSES,
    ROLES,
    SHOP_STATUSES,
  } from './constants';

  describe('列挙値', () => {
    it('ROLES は設計書 §4 の 3 ロールと完全一致する', () => {
      expect(ROLES).toEqual(['user', 'owner', 'admin']);
    });

    it('PROFILE_STATUSES は active / suspended / deleted の 3 種', () => {
      expect(PROFILE_STATUSES).toEqual(['active', 'suspended', 'deleted']);
    });

    it('SHOP_STATUSES は下書きから閉店までの 5 種', () => {
      expect(SHOP_STATUSES).toEqual(['draft', 'pending', 'published', 'suspended', 'closed']);
    });

    it('RESERVATION_STATUSES は承認フローと来店結果を表す 6 種', () => {
      expect(RESERVATION_STATUSES).toEqual([
        'pending',
        'confirmed',
        'rejected',
        'cancelled',
        'completed',
        'no_show',
      ]);
    });

    it('REVIEW_STATUSES は published / hidden / deleted の 3 種', () => {
      expect(REVIEW_STATUSES).toEqual(['published', 'hidden', 'deleted']);
    });

    it('REPORT_STATUSES は通報キューの 4 状態', () => {
      expect(REPORT_STATUSES).toEqual(['open', 'in_review', 'resolved', 'rejected']);
    });

    it('REPORT_TARGET_TYPES は設計書 5.1 の通報対象 3 種', () => {
      expect(REPORT_TARGET_TYPES).toEqual(['shop', 'review', 'user']);
    });

    it('APPLICATION_STATUSES は差し戻し（returned）を含む 4 種', () => {
      expect(APPLICATION_STATUSES).toEqual(['pending', 'approved', 'rejected', 'returned']);
    });

    it('NOTIFICATION_TYPES に重複がない', () => {
      expect(new Set(NOTIFICATION_TYPES).size).toBe(NOTIFICATION_TYPES.length);
    });
  });

  describe('列挙値の形式', () => {
    const ALL_ENUMS = [
      ROLES,
      PROFILE_STATUSES,
      SHOP_STATUSES,
      RESERVATION_STATUSES,
      REVIEW_STATUSES,
      REPORT_STATUSES,
      REPORT_TARGET_TYPES,
      APPLICATION_STATUSES,
      NOTIFICATION_TYPES,
    ];

    it('すべて小文字スネークケースである（SQL に直に入るため表記ゆれを禁止する）', () => {
      for (const values of ALL_ENUMS) {
        for (const value of values) {
          expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
        }
      }
    });

    it('どの列挙も空でなく、要素が重複していない', () => {
      for (const values of ALL_ENUMS) {
        expect(values.length).toBeGreaterThan(0);
        expect(new Set(values).size).toBe(values.length);
      }
    });
  });
  ```

- [ ] **Step 2: テストが失敗することを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/constants.test.ts
  ```

  `Failed to resolve import "./constants"` で落ちる。

- [ ] **Step 3: `src/db/constants.ts` の前半（列挙値）を書く**

  ```ts
  /**
   * D1 スキーマが参照する定数。
   *
   * ここに置いている理由:
   * ロール定義とドメイン定数は本来 `@meshimap/core` の責務だが（設計書 §7）、
   * core を import すると D1 のマイグレーション生成が core のビルドに依存し、
   * 「core が壊れるとマイグレーションも生成できない」結合を生むため api 側に閉じて持つ。
   *
   * Phase 4 で core からの再エクスポート化を検討したが**見送った**（同じ理由）。
   * 値は core と手で同期し、ずれは `constants-parity.test.ts` が検出する
   * （`RATING_MIN` などを core と 1 対 1 で突き合わせている）。
   */

  // ───────────────────────── ロール（設計書 §4）─────────────────────────

  /** 利用者。検索・レビュー・予約・通報ができる */
  export const ROLE_USER = 'user';
  /** 店舗管理者。自店舗の編集と予約承認ができる */
  export const ROLE_OWNER = 'owner';
  /** システム管理者。審査・通報対応・マスタ管理ができる */
  export const ROLE_ADMIN = 'admin';

  /** 1 アカウント 1 ロール。user → owner の昇格のみ実装する（設計書 §4） */
  export const ROLES = [ROLE_USER, ROLE_OWNER, ROLE_ADMIN] as const;
  export type Role = (typeof ROLES)[number];

  // ───────────────────── プロフィールの状態 ─────────────────────

  /** 通常利用できる */
  export const PROFILE_STATUS_ACTIVE = 'active';
  /** 管理者が停止した。ログインは通るが投稿系の操作を拒否する */
  export const PROFILE_STATUS_SUSPENDED = 'suspended';
  /** 退会済み。表示名を伏せるが、投稿の親子関係を壊さないよう行は残す */
  export const PROFILE_STATUS_DELETED = 'deleted';

  export const PROFILE_STATUSES = [
    PROFILE_STATUS_ACTIVE,
    PROFILE_STATUS_SUSPENDED,
    PROFILE_STATUS_DELETED,
  ] as const;
  export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

  // ───────────────────────── 店舗の公開状態 ─────────────────────────

  /** オーナーが編集中。一般利用者には見えない */
  export const SHOP_STATUS_DRAFT = 'draft';
  /** 申請済みで管理者の審査待ち */
  export const SHOP_STATUS_PENDING = 'pending';
  /** 公開中。検索・地図に出るのはこれだけ */
  export const SHOP_STATUS_PUBLISHED = 'published';
  /** 管理者が強制非公開にした（通報対応など） */
  export const SHOP_STATUS_SUSPENDED = 'suspended';
  /** 閉店。履歴としては残すが検索には出さない */
  export const SHOP_STATUS_CLOSED = 'closed';

  export const SHOP_STATUSES = [
    SHOP_STATUS_DRAFT,
    SHOP_STATUS_PENDING,
    SHOP_STATUS_PUBLISHED,
    SHOP_STATUS_SUSPENDED,
    SHOP_STATUS_CLOSED,
  ] as const;
  export type ShopStatus = (typeof SHOP_STATUSES)[number];

  // ───────────────────────── 予約の状態 ─────────────────────────

  /** 利用者が申し込み、店舗の承認待ち */
  export const RESERVATION_STATUS_PENDING = 'pending';
  /** 店舗が承認した */
  export const RESERVATION_STATUS_CONFIRMED = 'confirmed';
  /** 店舗が拒否した */
  export const RESERVATION_STATUS_REJECTED = 'rejected';
  /** 利用者が取り消した */
  export const RESERVATION_STATUS_CANCELLED = 'cancelled';
  /** 来店が完了した */
  export const RESERVATION_STATUS_COMPLETED = 'completed';
  /** 無断キャンセル。completed と区別して集計するため別値にする */
  export const RESERVATION_STATUS_NO_SHOW = 'no_show';

  export const RESERVATION_STATUSES = [
    RESERVATION_STATUS_PENDING,
    RESERVATION_STATUS_CONFIRMED,
    RESERVATION_STATUS_REJECTED,
    RESERVATION_STATUS_CANCELLED,
    RESERVATION_STATUS_COMPLETED,
    RESERVATION_STATUS_NO_SHOW,
  ] as const;
  export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

  /** 席を実際に占有する状態。空き枠計算（Phase 7）はこの 2 つだけを数える */
  export const RESERVATION_STATUSES_OCCUPYING_SEAT = [
    RESERVATION_STATUS_PENDING,
    RESERVATION_STATUS_CONFIRMED,
  ] as const;

  // ───────────────────────── レビューの状態 ─────────────────────────

  /** 公開中。評価集計の対象はこれだけ */
  export const REVIEW_STATUS_PUBLISHED = 'published';
  /** 管理者が非表示にした。集計から外すが行は残す */
  export const REVIEW_STATUS_HIDDEN = 'hidden';
  /** 投稿者が削除した */
  export const REVIEW_STATUS_DELETED = 'deleted';

  export const REVIEW_STATUSES = [
    REVIEW_STATUS_PUBLISHED,
    REVIEW_STATUS_HIDDEN,
    REVIEW_STATUS_DELETED,
  ] as const;
  export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

  // ───────────────────────── 通報 ─────────────────────────

  /** 未対応 */
  export const REPORT_STATUS_OPEN = 'open';
  /** 管理者が確認中 */
  export const REPORT_STATUS_IN_REVIEW = 'in_review';
  /** 対処した（非表示・警告など） */
  export const REPORT_STATUS_RESOLVED = 'resolved';
  /** 問題なしとして却下した */
  export const REPORT_STATUS_REJECTED = 'rejected';

  export const REPORT_STATUSES = [
    REPORT_STATUS_OPEN,
    REPORT_STATUS_IN_REVIEW,
    REPORT_STATUS_RESOLVED,
    REPORT_STATUS_REJECTED,
  ] as const;
  export type ReportStatus = (typeof REPORT_STATUSES)[number];

  /** 通報対象。設計書 5.1 の `report/[targetType]/[targetId]` と一致させる */
  export const REPORT_TARGET_TYPE_SHOP = 'shop';
  export const REPORT_TARGET_TYPE_REVIEW = 'review';
  export const REPORT_TARGET_TYPE_USER = 'user';

  export const REPORT_TARGET_TYPES = [
    REPORT_TARGET_TYPE_SHOP,
    REPORT_TARGET_TYPE_REVIEW,
    REPORT_TARGET_TYPE_USER,
  ] as const;
  export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

  // ───────────────────────── 店舗申請 ─────────────────────────

  /** 審査待ち */
  export const APPLICATION_STATUS_PENDING = 'pending';
  /** 承認。ここで申請者のロールが user → owner へ昇格する */
  export const APPLICATION_STATUS_APPROVED = 'approved';
  /** 却下。再申請はできない */
  export const APPLICATION_STATUS_REJECTED = 'rejected';
  /** 差し戻し。理由を添えて再提出させる（設計書 5.1 `onboarding/status.tsx`） */
  export const APPLICATION_STATUS_RETURNED = 'returned';

  export const APPLICATION_STATUSES = [
    APPLICATION_STATUS_PENDING,
    APPLICATION_STATUS_APPROVED,
    APPLICATION_STATUS_REJECTED,
    APPLICATION_STATUS_RETURNED,
  ] as const;
  export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

  // ───────────────────────── 通知 ─────────────────────────

  export const NOTIFICATION_TYPE_RESERVATION_REQUESTED = 'reservation_requested';
  export const NOTIFICATION_TYPE_RESERVATION_CONFIRMED = 'reservation_confirmed';
  export const NOTIFICATION_TYPE_RESERVATION_REJECTED = 'reservation_rejected';
  export const NOTIFICATION_TYPE_RESERVATION_CANCELLED = 'reservation_cancelled';
  export const NOTIFICATION_TYPE_REVIEW_POSTED = 'review_posted';
  export const NOTIFICATION_TYPE_REVIEW_REPLIED = 'review_replied';
  export const NOTIFICATION_TYPE_APPLICATION_APPROVED = 'application_approved';
  export const NOTIFICATION_TYPE_APPLICATION_REJECTED = 'application_rejected';
  export const NOTIFICATION_TYPE_APPLICATION_RETURNED = 'application_returned';
  export const NOTIFICATION_TYPE_ANNOUNCEMENT = 'announcement';

  export const NOTIFICATION_TYPES = [
    NOTIFICATION_TYPE_RESERVATION_REQUESTED,
    NOTIFICATION_TYPE_RESERVATION_CONFIRMED,
    NOTIFICATION_TYPE_RESERVATION_REJECTED,
    NOTIFICATION_TYPE_RESERVATION_CANCELLED,
    NOTIFICATION_TYPE_REVIEW_POSTED,
    NOTIFICATION_TYPE_REVIEW_REPLIED,
    NOTIFICATION_TYPE_APPLICATION_APPROVED,
    NOTIFICATION_TYPE_APPLICATION_REJECTED,
    NOTIFICATION_TYPE_APPLICATION_RETURNED,
    NOTIFICATION_TYPE_ANNOUNCEMENT,
  ] as const;
  export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
  ```

- [ ] **Step 4: `src/db/constants.ts` の後半（数値範囲と長さ）を書く**

  同じファイルに追記する。ここは **CHECK 制約の右辺**にそのまま埋め込まれる値。
  `@meshimap/core` 側にも同名の定数があるため、値を手で同期する必要がある
  （Phase 2 計画書の引き継ぎ表に明記されている）。

  ```ts
  // ──────────────────── 数値範囲（CHECK 制約に埋め込む）────────────────────
  //
  // 注意: ここの値は `@meshimap/core` の同名定数と **手で同期** する。
  // core を import しないのは、D1 のマイグレーション生成が core のビルドに依存すると
  // 「core が壊れているとマイグレーションが生成できない」という結合を生むため。
  // 値がずれた場合は Task 3-14 の突き合わせで検出する。

  /** 評価の下限（星 1） */
  export const RATING_MIN = 1;
  /** 評価の上限（星 5） */
  export const RATING_MAX = 5;

  /** 平均評価の下限。レビュー 0 件のときは 0 を入れるため RATING_MIN より小さい */
  export const RATING_AVG_MIN = 0;
  /** 平均評価の上限 */
  export const RATING_AVG_MAX = 5;

  /** 曜日。0 = 日曜（JavaScript の Date#getDay と合わせる） */
  export const DAY_OF_WEEK_MIN = 0;
  /** 曜日。6 = 土曜 */
  export const DAY_OF_WEEK_MAX = 6;

  /** 1 日の分数。日跨ぎ営業はこれを超える値で表す（設計書 §6） */
  export const MINUTES_PER_DAY = 1440;
  /** 営業時間の下限（00:00） */
  export const MINUTE_OF_DAY_MIN = 0;
  /** 営業時間の上限（翌 23:59）。1440 + 1439 = 2879 */
  export const MINUTE_OF_DAY_MAX = 2879;

  /** 予約人数の下限 */
  export const PARTY_SIZE_MIN = 1;
  /** 予約人数の上限。これを超える団体は電話で受ける想定 */
  export const PARTY_SIZE_MAX = 20;

  /** 予算（円）の下限 */
  export const BUDGET_YEN_MIN = 0;
  /** 予算（円）の上限。100 万円を超える入力は誤りとみなす */
  export const BUDGET_YEN_MAX = 1_000_000;

  /** 予約枠の長さ（分）の下限 */
  export const SLOT_MINUTES_MIN = 15;
  /** 予約枠の長さ（分）の上限 */
  export const SLOT_MINUTES_MAX = 240;

  /** 席数の下限 */
  export const SEAT_CAPACITY_MIN = 1;
  /** 席数の上限 */
  export const SEAT_CAPACITY_MAX = 500;

  /** 同時受付枠数の下限 */
  export const MAX_PARALLEL_MIN = 1;
  /** 同時受付枠数の上限 */
  export const MAX_PARALLEL_MAX = 100;

  /** 緯度の下限 */
  export const LATITUDE_MIN = -90;
  /** 緯度の上限 */
  export const LATITUDE_MAX = 90;
  /** 経度の下限 */
  export const LONGITUDE_MIN = -180;
  /** 経度の上限 */
  export const LONGITUDE_MAX = 180;

  /**
   * `shops.geohash` に格納する precision。
   * 設計書 §3.1 より precision 7 は約 152m 四方。徒歩圏（〜1km）の検索で
   * 候補が数十件に収まる粒度。検索時はこれを半径に応じて前方から切り詰めて使う。
   */
  export const SHOP_GEOHASH_PRECISION = 7;

  /** 並び順の下限。負値は許さない */
  export const SORT_ORDER_MIN = 0;

  /** 価格（円）の下限 */
  export const PRICE_YEN_MIN = 0;
  /** 価格（円）の上限 */
  export const PRICE_YEN_MAX = 1_000_000;

  /** 閲覧数などのカウンタの下限 */
  export const COUNT_MIN = 0;

  // ──────────────────── 文字列長（CHECK 制約に埋め込む）────────────────────

  /** 店名 */
  export const SHOP_NAME_MAX_LENGTH = 100;
  /** 店名（かな） */
  export const SHOP_NAME_KANA_MAX_LENGTH = 200;
  /** 住所 */
  export const SHOP_ADDRESS_MAX_LENGTH = 200;
  /** 店舗説明 */
  export const SHOP_DESCRIPTION_MAX_LENGTH = 2000;
  /** レビュー本文 */
  export const REVIEW_BODY_MAX_LENGTH = 2000;
  /** 予約時の要望 */
  export const RESERVATION_NOTE_MAX_LENGTH = 500;
  /** 主キーなどの識別子。ULID / UUID / スラッグをまとめて収める長さ */
  export const IDENTIFIER_MAX_LENGTH = 64;

  /**
   * R2 オブジェクトキーの上限。`<種別>/<id>/<uuid>.<ext>`（規約 §1.2）が収まる長さ。
   * shop_photos / review_photos / menu_items の 3 箇所で使うのでここに置く。
   */
  export const R2_KEY_MAX_LENGTH = 200;
  /** R2 オブジェクトキーに使える文字。`/` `.` `-` と小文字英数字のみ */
  export const R2_KEY_ALLOWED_CHARACTERS = 'a-z0-9/._-';

  // ──────────────────── 書式（GLOB パターン）────────────────────

  /**
   * `YYYY-MM-DD`（JST の暦日）を表す GLOB パターン。
   * shop_closures.date と reviews.visited_on の両方で使うのでここに置く。
   * 月日の妥当性（2 月 31 日など）までは見ない。それは Zod 側の責務（Phase 4）。
   */
  export const ISO_DATE_GLOB_PATTERN = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
  ```

- [ ] **Step 5: 失敗するテストを書く（`src/db/sql-helpers.test.ts`）**

  ここが Phase 3 で**最も踏みやすい落とし穴**。Drizzle の `` sql`...` `` は
  `${値}` をバインドパラメータにする。ところが CHECK 制約は DDL の一部なので
  パラメータを使えず、`drizzle-kit generate` はそのまま `?` を SQL に出力してしまう。

  ```sql
  -- こう書くと（sql`${column} IN (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`）
  CONSTRAINT "ck_profiles_role" CHECK("profiles"."role" IN (?, ?, ?))   -- ← 壊れている
  ```

  したがってヘルパの契約は「**パラメータを 1 つも作らない**」こと。それをテストで固定する。

  ```ts
  import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
  import { describe, expect, it } from 'vitest';
  import {
    atLeast,
    atMostColumn,
    betweenInclusive,
    consistsOf,
    inValues,
    isBooleanInteger,
    lengthAtMost,
    lengthIs,
    matchesGlob,
  } from './sql-helpers';
  import { sql } from 'drizzle-orm';

  const dialect = new SQLiteSyncDialect();

  describe('inValues', () => {
    it('許可リストをシングルクォート付きのリテラルとして展開する', () => {
      const query = dialect.sqlToQuery(inValues(sql`role`, ['user', 'owner', 'admin']));
      expect(query.sql).toBe("role IN ('user', 'owner', 'admin')");
    });

    it('バインドパラメータを 1 つも作らない（CHECK 制約では ? が使えないため）', () => {
      const query = dialect.sqlToQuery(inValues(sql`role`, ['user', 'owner', 'admin']));
      expect(query.params).toEqual([]);
    });

    it('値にシングルクォートが含まれても SQL を壊さない', () => {
      const query = dialect.sqlToQuery(inValues(sql`name`, ["o'brien"]));
      expect(query.sql).toBe("name IN ('o''brien')");
    });
  });

  describe('betweenInclusive', () => {
    it('数値をリテラルとして展開する', () => {
      const query = dialect.sqlToQuery(betweenInclusive(sql`rating`, 1, 5));
      expect(query.sql).toBe('rating BETWEEN 1 AND 5');
      expect(query.params).toEqual([]);
    });

    it('境界が同じ値でも成立する（1 点だけ許す制約を書けること）', () => {
      const query = dialect.sqlToQuery(betweenInclusive(sql`n`, 7, 7));
      expect(query.sql).toBe('n BETWEEN 7 AND 7');
    });

    it('NaN を渡したら例外を投げる（壊れた DDL を生成させない）', () => {
      expect(() => betweenInclusive(sql`n`, Number.NaN, 5)).toThrow(/埋め込めない数値/);
    });

    it('Infinity を渡したら例外を投げる', () => {
      expect(() => betweenInclusive(sql`n`, 0, Number.POSITIVE_INFINITY)).toThrow(
        /埋め込めない数値/,
      );
    });
  });

  describe('lengthAtMost', () => {
    it('length() による上限比較を組み立てる', () => {
      const query = dialect.sqlToQuery(lengthAtMost(sql`body`, 2000));
      expect(query.sql).toBe('length(body) <= 2000');
      expect(query.params).toEqual([]);
    });
  });

  describe('atLeast', () => {
    it('下限比較を組み立てる', () => {
      const query = dialect.sqlToQuery(atLeast(sql`view_count`, 0));
      expect(query.sql).toBe('view_count >= 0');
      expect(query.params).toEqual([]);
    });
  });

  describe('lengthIs', () => {
    it('文字数の完全一致を組み立てる', () => {
      const query = dialect.sqlToQuery(lengthIs(sql`geohash`, 7));
      expect(query.sql).toBe('length(geohash) = 7');
      expect(query.params).toEqual([]);
    });
  });

  describe('atMostColumn', () => {
    it('列どうしの大小関係を組み立てる（予算の min <= max など）', () => {
      const query = dialect.sqlToQuery(atMostColumn(sql`budget_min`, sql`budget_max`));
      expect(query.sql).toBe('budget_min <= budget_max');
      expect(query.params).toEqual([]);
    });
  });

  describe('isBooleanInteger', () => {
    it('真偽値の列を 0 と 1 だけに縛る', () => {
      const query = dialect.sqlToQuery(isBooleanInteger(sql`is_cover`));
      expect(query.sql).toBe('is_cover IN (0, 1)');
      expect(query.params).toEqual([]);
    });
  });

  describe('matchesGlob', () => {
    it('GLOB パターンをリテラルとして展開する', () => {
      const query = dialect.sqlToQuery(
        matchesGlob(sql`date`, '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      );
      expect(query.sql).toBe("date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'");
      expect(query.params).toEqual([]);
    });
  });

  describe('consistsOf', () => {
    it('「許可文字だけからなる非空文字列」を否定形の GLOB で表す', () => {
      const query = dialect.sqlToQuery(consistsOf(sql`slug`, 'a-z0-9-'));
      // GLOB '[a-z0-9-]*' は先頭 1 文字しか見ないため誤り。否定形で「許可外の文字を 1 つも含まない」と書く
      expect(query.sql).toBe("slug <> '' AND slug NOT GLOB '*[^a-z0-9-]*'");
      expect(query.params).toEqual([]);
    });
  });
  ```

- [ ] **Step 6: `src/db/sql-helpers.ts` を実装する**

  ```ts
  import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

  /**
   * CHECK 制約の式を組み立てるヘルパ。
   *
   * なぜ必要か:
   * Drizzle の `` sql`${値}` `` は値をバインドパラメータにするが、CHECK 制約は DDL の一部であり
   * パラメータを使えない。そのまま書くと `CHECK(role IN (?, ?, ?))` という壊れた SQL が生成される。
   * ここでは `sql.raw()` で値をリテラルとして埋め込む。
   *
   * 埋め込む値は必ず `constants.ts` の定数（開発者が書いた固定値）であり、
   * ユーザー入力は 1 つも通らない。それでも取り違えに備えてクォートのエスケープと
   * 数値の有限性チェックを入れてある。
   */

  /** SQL の文字列リテラルへ変換する。シングルクォートは SQL の規則どおり 2 個重ねて逃がす */
  function toSqlStringLiteral(value: string): SQL {
    return sql.raw(`'${value.replaceAll("'", "''")}'`);
  }

  /** SQL の数値リテラルへ変換する。NaN / Infinity は DDL として無意味なので早期に落とす */
  function toSqlNumberLiteral(value: number): SQL {
    if (!Number.isFinite(value)) {
      throw new Error(`CHECK 制約に埋め込めない数値です: ${String(value)}`);
    }
    return sql.raw(String(value));
  }

  /** SQLite における真偽値の表現。`mode: 'boolean'` の列はこの 2 値しか取らない */
  const BOOLEAN_FALSE_INTEGER = 0;
  const BOOLEAN_TRUE_INTEGER = 1;

  /** `column IN ('a', 'b', 'c')` — 列挙値を DB レベルで縛る */
  export function inValues(column: SQLWrapper, allowedValues: readonly string[]): SQL {
    const literals = allowedValues.map((value) => toSqlStringLiteral(value));
    return sql`${column} IN (${sql.join(literals, sql`, `)})`;
  }

  /** `column BETWEEN min AND max` — 上下限を両端込みで縛る */
  export function betweenInclusive(column: SQLWrapper, minValue: number, maxValue: number): SQL {
    return sql`${column} BETWEEN ${toSqlNumberLiteral(minValue)} AND ${toSqlNumberLiteral(maxValue)}`;
  }

  /** `length(column) <= max` — 文字列長の上限。SQLite の length() は文字数を返す */
  export function lengthAtMost(column: SQLWrapper, maxLength: number): SQL {
    return sql`length(${column}) <= ${toSqlNumberLiteral(maxLength)}`;
  }

  /** `length(column) = n` — 文字数が固定の列（geohash の precision など） */
  export function lengthIs(column: SQLWrapper, exactLength: number): SQL {
    return sql`length(${column}) = ${toSqlNumberLiteral(exactLength)}`;
  }

  /** `column >= min` — カウンタなどの下限 */
  export function atLeast(column: SQLWrapper, minValue: number): SQL {
    return sql`${column} >= ${toSqlNumberLiteral(minValue)}`;
  }

  /**
   * `left <= right` — 列どうしの大小関係。予算の min <= max などに使う。
   * どちらかが NULL なら式全体が NULL になり、CHECK は通る（片側だけ指定された予算を許すため都合がよい）。
   */
  export function atMostColumn(left: SQLWrapper, right: SQLWrapper): SQL {
    return sql`${left} <= ${right}`;
  }

  /**
   * `column IN (0, 1)` — 真偽値の列。
   *
   * SQLite に BOOLEAN 型はなく、Drizzle の `mode: 'boolean'` も実体は INTEGER でしかない。
   * シードやマイグレーションの生 SQL から `2` や `-1` を書き込めてしまうため DB 側で縛る。
   */
  export function isBooleanInteger(column: SQLWrapper): SQL {
    return sql`${column} IN (${toSqlNumberLiteral(BOOLEAN_FALSE_INTEGER)}, ${toSqlNumberLiteral(BOOLEAN_TRUE_INTEGER)})`;
  }

  /** `column GLOB 'pattern'` — 書式を GLOB で縛る。日付の `YYYY-MM-DD` など */
  export function matchesGlob(column: SQLWrapper, pattern: string): SQL {
    return sql`${column} GLOB ${toSqlStringLiteral(pattern)}`;
  }

  /**
   * 「許可された文字だけからなる非空文字列」に縛る。
   *
   * `` col GLOB '[a-z0-9-]*' `` と書きたくなるが、GLOB の `[...]` は **1 文字**にしか対応せず
   * 続く `*` が残り全部を無条件に飲み込むため、`'ra men'` のような値が通ってしまう。
   * 「許可外の文字を 1 つでも含む」の否定で書くのが正しい。
   * さらに GLOB は空文字にマッチしないため、`<> ''` を明示的に AND する。
   */
  export function consistsOf(column: SQLWrapper, allowedCharacterClass: string): SQL {
    const forbiddenPattern = `*[^${allowedCharacterClass}]*`;
    return sql`${column} <> '' AND ${column} NOT GLOB ${toSqlStringLiteral(forbiddenPattern)}`;
  }
  ```

- [ ] **Step 7: テストが通ることを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/constants.test.ts src/db/sql-helpers.test.ts
  ```

  `constants.test.ts` の 11 件と `sql-helpers.test.ts` の 15 件、合わせて 26 件が緑になる。

- [ ] **Step 8: わざと壊してテストが検知することを確認する**

  次の 2 つを 1 つずつ試し、**それぞれ落ちることを目で見る**。

  1. `RESERVATION_STATUS_CANCELLED = 'cancelled'` を `'canceled'`（l が 1 つ）に変える
     → 「予約の 6 状態」のテストが落ちる
  2. `NOTIFICATION_TYPE_ANNOUNCEMENT = 'announcement'` を `'Announcement'` に変える
     → 「すべて小文字スネークケース」のテストが落ちる

  3. `sql-helpers.ts` の `toSqlStringLiteral` を `sql.raw(...)` から
     `` sql`${value}` `` に戻す
     → 「バインドパラメータを 1 つも作らない」のテストが
     `expected [ 'user', 'owner', 'admin' ] to deeply equal []` で落ちる

  3 つとも確認したら**元に戻す**。とくに 1 は実際に起こりうる打ち間違い
  （米綴りと英綴りの揺れ）、3 は Phase 3 で最も踏みやすい落とし穴であり、
  この回帰テストの存在意義そのもの。

- [ ] **Step 9: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

- [ ] **Step 10: コミット**

  `feat(api): D1 スキーマ用の列挙値・数値範囲定数と CHECK 式ヘルパを追加` として親エージェントへ報告する。

---

### Task 3-2: `db/schema/auth.ts` — Better Auth の 4 テーブル

設計書 §6 の「認証（Better Auth が管理）」の 4 テーブル。**Better Auth が期待する形に厳密に合わせる**。

**重要な方針**: このファイルのテーブルには **CHECK 制約を一切付けない**。
Better Auth は自前で INSERT/UPDATE を発行するため、こちらが勝手に値を縛ると
ライブラリ更新時に認証が丸ごと壊れる。制約はアプリ固有の `profiles` 以降で掛ける。

カラム名・型は `node_modules/@better-auth/core/dist/db/get-tables.mjs`（フィールド定義）と
`node_modules/@better-auth/drizzle-adapter/dist/generate-drizzle-schema-*.mjs`（SQLite への型対応）
を読んで確認した。型対応は次のとおり。

| Better Auth の型 | Drizzle（SQLite）                          |
| ---------------- | ------------------------------------------ |
| `string`         | `text('col')`                              |
| `boolean`        | `integer('col', { mode: 'boolean' })`      |
| `number`         | `integer('col')`                           |
| `date`           | `integer('col', { mode: 'timestamp_ms' })` |
| `json`           | `text('col', { mode: 'json' })`            |
| `id`             | `text('id').primaryKey()`                  |

**Files:**

- Modify: `/Users/hattori/Downloads/alee/apps/api/src/db/testing/local-d1.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/auth.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/auth.test.ts`

**Interfaces:**

```ts
// Consumes
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Produces
export const user: SQLiteTableWithColumns<{ name: 'user'; ... }>;
export const session: SQLiteTableWithColumns<{ name: 'session'; ... }>;
export const account: SQLiteTableWithColumns<{ name: 'account'; ... }>;
export const verification: SQLiteTableWithColumns<{ name: 'verification'; ... }>;
export const CREATED_AT_DEFAULT: SQL;   // 他のスキーマファイルからも使う既定値式

// local-d1.ts に追加
export function createMigratedD1(): Promise<LocalD1>;
```

- [ ] **Step 1: `local-d1.ts` に `createMigratedD1()` を追加する**

  これ以降の 8 つのスキーマテストが全部「D1 を起動 → マイグレーション適用」で始まる。
  2 行の重複を 8 回書くことになるので、今のうちに 1 つにまとめる。

  ```ts
  /**
   * 起動してマイグレーションまで済ませた D1 を返す。
   * スキーマのテストは全部この状態から始まるためまとめてある。
   */
  export async function createMigratedD1(): Promise<LocalD1> {
    const local = await createLocalD1();
    await applyMigrations(local.d1);
    return local;
  }
  ```

- [ ] **Step 2: 失敗するテストを書く（`src/db/schema/auth.test.ts`）**

  スキーマのテストは「Drizzle のオブジェクトの形」ではなく「**D1 に作られたテーブルの振る舞い**」を見る。
  したがって Drizzle を経由せず `d1.prepare()` で素の SQL を投げる。
  これにより「Drizzle が弾いたのか DB が弾いたのか分からない」という曖昧さがなくなる。

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

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
        .bind('usr_ok_1', '山田太郎', 'ok1@example.com', 0, 1_757_900_000_000, 1_757_900_000_000)
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
      expect(row?.created_at).toBeGreaterThanOrEqual(beforeMs - 1_000);
      expect(row?.created_at).toBeLessThanOrEqual(afterMs + 1_000);
      expect(row?.updated_at).toBeGreaterThanOrEqual(beforeMs - 1_000);
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
          .bind('ses_ng_1', 1_757_900_000_000, 'token_ng_1', 'usr_does_not_exist')
          .run(),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    });

    it('token は一意である', async () => {
      await local.d1
        .prepare('INSERT INTO session (id, expires_at, token, user_id) VALUES (?, ?, ?, ?)')
        .bind('ses_dup_a', 1_757_900_000_000, 'token_dup', 'usr_sess_owner')
        .run();

      await expect(
        local.d1
          .prepare('INSERT INTO session (id, expires_at, token, user_id) VALUES (?, ?, ?, ?)')
          .bind('ses_dup_b', 1_757_900_000_000, 'token_dup', 'usr_sess_owner')
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
        .bind('ses_cascade', 1_757_900_000_000, 'token_cascade', 'usr_cascade')
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
        .bind('vrf_1', 'verify@example.com', 'code_123', 1_757_900_000_000)
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
          .bind('vrf_ng', 'code_ng', 1_757_900_000_000)
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
  ```

- [ ] **Step 3: テストが失敗することを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/auth.test.ts
  ```

  `Failed to resolve import "../testing/local-d1"` ではなく、
  `no such table: user` で落ちることを確認する（`createMigratedD1` は動くが中身が空のため）。

- [ ] **Step 4: `src/db/schema/auth.ts` を書く**

  ```ts
  import { sql } from 'drizzle-orm';
  import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

  /**
   * Better Auth が管理する認証テーブル群。
   *
   * 方針:
   * カラム名・型は Better Auth 1.7.5 の定義（`@better-auth/core` の getAuthTables と
   * `@better-auth/drizzle-adapter` の SQLite 型対応）に厳密に合わせる。
   * **CHECK 制約を付けない**のは、Better Auth が自前で INSERT/UPDATE を発行するため、
   * こちらが値を縛るとライブラリ更新時に認証が丸ごと壊れるから。
   * アプリ固有の制約は profiles 以降のテーブルで掛ける。
   */

  /**
   * 作成日時・更新日時の既定値。
   * Better Auth の drizzle-adapter が生成するのと同じ式にそろえてある。
   * `unixepoch('subsecond')` は小数秒を含む秒を返すため、1000 倍してミリ秒にする。
   */
  export const CREATED_AT_DEFAULT = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

  export const user = sqliteTable('user', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // Better Auth がサインイン時に email で引くため一意制約が必須
    email: text('email').notNull().unique(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  });

  export const session = sqliteTable(
    'session',
    {
      id: text('id').primaryKey(),
      expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
      // Cookie に載る値。毎リクエストここで引くため一意制約と索引が要る
      token: text('token').notNull().unique(),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
      updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
      ipAddress: text('ip_address'),
      userAgent: text('user_agent'),
      userId: text('user_id')
        .notNull()
        // 退会時にセッションを残すと「消えたユーザーのトークンが生きている」状態になる
        .references(() => user.id, { onDelete: 'cascade' }),
    },
    (table) => [index('idx_session_user_id').on(table.userId)],
  );

  export const account = sqliteTable(
    'account',
    {
      id: text('id').primaryKey(),
      // プロバイダ側のユーザー識別子。メール認証では email がそのまま入る
      accountId: text('account_id').notNull(),
      // 'credential'（メール+パスワード）や 'google' などの識別子
      providerId: text('provider_id').notNull(),
      userId: text('user_id')
        .notNull()
        .references(() => user.id, { onDelete: 'cascade' }),
      accessToken: text('access_token'),
      refreshToken: text('refresh_token'),
      idToken: text('id_token'),
      accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
      refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
      scope: text('scope'),
      // メール+パスワード認証のハッシュ。OAuth のときは NULL
      password: text('password'),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
      updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
    },
    (table) => [
      index('idx_account_user_id').on(table.userId),
      // (provider_id, account_id) を一意にしたくなるが、Better Auth は一意を前提にしていない。
      // 一意制約を足すとアカウント連携の経路で予期せぬ失敗が起きるため索引のみに留める。
      index('idx_account_provider').on(table.providerId, table.accountId),
    ],
  );

  export const verification = sqliteTable(
    'verification',
    {
      id: text('id').primaryKey(),
      // メールアドレスやトークンの持ち主を表す文字列。ここで検索する
      identifier: text('identifier').notNull(),
      value: text('value').notNull(),
      expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
      updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
    },
    (table) => [index('idx_verification_identifier').on(table.identifier)],
  );
  ```

- [ ] **Step 5: 暫定の `schema/index.ts` を作る**

  `drizzle.config.ts` が `./src/db/schema/index.ts` を見るため、この時点で作っておく。
  Task 3-10 で最終形に整える。

  ```ts
  export * from './auth';
  ```

- [ ] **Step 6: マイグレーションを生成する**

  スキーマが固まるまでは、毎回作り直して常に 1 枚の `0000_init.sql` に保つ。
  スキーマ定義タスク（3-2 〜 3-9）の間だけの運用で、Task 3-11 以降は追記していく。

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  rm -rf migrations/meta migrations/0000_init.sql
  node ../../node_modules/.bin/drizzle-kit generate --name=init
  ```

  標準出力に `4 tables` と表示されること、`migrations/0000_init.sql` に
  `` CREATE TABLE `user` `` と `UNIQUE` が含まれることを目で確認する。

  ```bash
  grep -c 'CREATE TABLE' migrations/0000_init.sql   # → 4
  grep 'unique' migrations/0000_init.sql
  ```

- [ ] **Step 7: テストが通ることを確認する**

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/auth.test.ts
  ```

  12 件すべて緑になる。

- [ ] **Step 8: わざと壊してテストが検知することを確認する**

  1 つずつ試し、**それぞれ落ちる出力を目で見てから戻す**。
  各操作のあとに Step 6 のマイグレーション再生成が必要（スキーマを変えたので）。

  1. `user.email` の `.notNull()` を外す
     → 「email が NULL の行は拒否する」が
     `promise resolved instead of rejecting` で落ちる
  2. `user.email` の `.unique()` を外す
     → 「同じ email を 2 回登録できない」が落ちる
  3. `session.userId` の `.references(...)` を丸ごと外す
     → 「存在しない user_id のセッションは作れない」が落ちる
  4. `session.userId` の `{ onDelete: 'cascade' }` を `{ onDelete: 'no action' }` に変える
     → 「ユーザーを削除するとセッションも消える」が
     `expected 1 to be 0` で落ちる（正確には親の DELETE 自体が FK 違反になる）
  5. `index('idx_session_user_id')` の行を消す
     → 「Better Auth が引く列に索引が張られている」が落ちる

  **5 つすべて確認したら元に戻し、マイグレーションを再生成してテストが緑に戻ることを確認する。**

- [ ] **Step 9: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

- [ ] **Step 10: コミット**

  `feat(api): Better Auth の認証テーブルを Drizzle スキーマとして定義` として報告する。

---

### Task 3-3: `db/schema/master.ts` — profiles / genres / areas

アプリ側の最上流。`shops` が `genres` / `areas` / `user` を参照するため、shops より先に作る。

**Files:**

- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/master.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/master.test.ts`
- Modify: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/index.ts`

**Interfaces:**

```ts
// Consumes
import { PROFILE_STATUSES, ROLES, IDENTIFIER_MAX_LENGTH, SORT_ORDER_MIN } from '../constants';
import { atLeast, inValues, lengthAtMost } from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';

// Produces
export const profiles; // user_id(PK→user.id) / role / display_name / avatar_key / bio / status / created_at
export const genres; // id(PK) / name / slug(UNIQUE) / icon_key / sort_order
export const areas; // id(PK) / name / parent_id(→areas.id 自己参照) / prefecture
```

- [ ] **Step 1: 失敗するテストを書く（`src/db/schema/master.test.ts`）**

  ```ts
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
  ```

- [ ] **Step 2: テストが失敗することを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/master.test.ts
  ```

  `no such table: profiles` で落ちる。

- [ ] **Step 3: `src/db/schema/master.ts` を書く**

  ```ts
  import {
    type AnySQLiteColumn,
    check,
    index,
    integer,
    sqliteTable,
    text,
  } from 'drizzle-orm/sqlite-core';
  import {
    IDENTIFIER_MAX_LENGTH,
    PROFILE_STATUS_ACTIVE,
    PROFILE_STATUSES,
    ROLE_USER,
    ROLES,
    SORT_ORDER_MIN,
  } from '../constants';
  import { atLeast, consistsOf, inValues, lengthAtMost } from '../sql-helpers';
  import { CREATED_AT_DEFAULT, user } from './auth';

  /** 表示名の上限。長すぎるとレビュー一覧のレイアウトが崩れる */
  const DISPLAY_NAME_MAX_LENGTH = 50;
  /** 自己紹介文の上限 */
  const BIO_MAX_LENGTH = 500;
  /** ジャンル名・エリア名の上限 */
  const MASTER_NAME_MAX_LENGTH = 50;
  /** 都道府県名の上限（「神奈川県」など最長 4 文字だが余裕を持たせる） */
  const PREFECTURE_MAX_LENGTH = 20;
  /** slug に使える文字。URL とフィルタのクエリ文字列にそのまま出るため小文字英数字とハイフンのみ */
  const SLUG_ALLOWED_CHARACTERS = 'a-z0-9-';

  /**
   * アプリ側のユーザー情報。Better Auth の `user` は認証に必要な項目しか持たないため、
   * ロールや表示名はこちらに分けている。
   * 主キーを user_id にして 1 対 1 を DB レベルで保証する。
   */
  export const profiles = sqliteTable(
    'profiles',
    {
      userId: text('user_id')
        .primaryKey()
        .references(() => user.id, { onDelete: 'cascade' }),
      // 設計書 §4 より 1 アカウント 1 ロール。既定は利用者
      role: text('role', { enum: ROLES }).notNull().default(ROLE_USER),
      displayName: text('display_name').notNull(),
      // R2 のオブジェクトキー（`avatars/<user_id>/<uuid>.webp`）。未設定なら NULL
      avatarKey: text('avatar_key'),
      bio: text('bio'),
      status: text('status', { enum: PROFILE_STATUSES }).notNull().default(PROFILE_STATUS_ACTIVE),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
    },
    (table) => [
      // 管理画面のユーザー一覧をロールで絞り込む
      index('idx_profiles_role').on(table.role),
      // text(..., { enum }) は型の話でしかなく SQL には出ないため、DB 側でも縛る
      check('ck_profiles_role', inValues(table.role, ROLES)),
      check('ck_profiles_status', inValues(table.status, PROFILE_STATUSES)),
      check(
        'ck_profiles_display_name_length',
        lengthAtMost(table.displayName, DISPLAY_NAME_MAX_LENGTH),
      ),
      check('ck_profiles_bio_length', lengthAtMost(table.bio, BIO_MAX_LENGTH)),
    ],
  );

  /**
   * 料理ジャンルのマスタ。管理者が CRUD する（設計書 5.1 `masters/genres.tsx`）。
   */
  export const genres = sqliteTable(
    'genres',
    {
      id: text('id').primaryKey(),
      name: text('name').notNull(),
      // URL とフィルタのクエリに出るため、小文字英数字とハイフンのみに限定する
      slug: text('slug').notNull().unique(),
      // R2 ではなくバンドル同梱のアイコン名（`genre-icons/ramen.svg`）
      iconKey: text('icon_key'),
      sortOrder: integer('sort_order').notNull().default(SORT_ORDER_MIN),
    },
    (table) => [
      // ジャンル一覧は常に sort_order 順で出す
      index('idx_genres_sort_order').on(table.sortOrder),
      check('ck_genres_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_genres_name_length', lengthAtMost(table.name, MASTER_NAME_MAX_LENGTH)),
      check('ck_genres_slug_format', consistsOf(table.slug, SLUG_ALLOWED_CHARACTERS)),
      check('ck_genres_sort_order', atLeast(table.sortOrder, SORT_ORDER_MIN)),
    ],
  );

  /**
   * エリアのマスタ。2 階層（区 → 街）で使う。
   * parent_id は自己参照。TypeScript の型推論が無限再帰するため
   * `AnySQLiteColumn` の戻り値型注釈を明示する必要がある。
   */
  export const areas = sqliteTable(
    'areas',
    {
      id: text('id').primaryKey(),
      name: text('name').notNull(),
      // 親を消しても子（街）を残せるように set null。子ごと消すと店舗が宙に浮く
      parentId: text('parent_id').references((): AnySQLiteColumn => areas.id, {
        onDelete: 'set null',
      }),
      prefecture: text('prefecture').notNull(),
    },
    (table) => [
      // 親エリアから子エリアを引く（エリア絞り込みの階層展開）
      index('idx_areas_parent_id').on(table.parentId),
      check('ck_areas_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_areas_name_length', lengthAtMost(table.name, MASTER_NAME_MAX_LENGTH)),
      check('ck_areas_prefecture_length', lengthAtMost(table.prefecture, PREFECTURE_MAX_LENGTH)),
    ],
  );
  ```

  `ck_profiles_bio_length` に `lengthAtMost` を使っているが、`bio` は NULL 可。
  SQLite では `length(NULL) <= 500` が **NULL** に評価され、CHECK は NULL を
  「違反ではない」として通す。したがって NULL 可の列にそのまま書いてよい。

- [ ] **Step 4: `schema/index.ts` に追記する**

  ```ts
  export * from './auth';
  export * from './master';
  ```

- [ ] **Step 5: マイグレーションを再生成する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  rm -rf migrations/meta migrations/0000_init.sql
  node ../../node_modules/.bin/drizzle-kit generate --name=init
  ```

  出力に `7 tables` と出る。生成 SQL に CHECK が**リテラルとして**入っていることを必ず確認する。

  ```bash
  grep -n 'ck_profiles_role' migrations/0000_init.sql
  # 期待: CONSTRAINT "ck_profiles_role" CHECK("profiles"."role" IN ('user', 'owner', 'admin'))
  ```

  ここに `?` が出ていたら Task 3-1 の `sql.raw` が効いていない。**先に直す。**

- [ ] **Step 6: テストが通ることを確認する**

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/master.test.ts
  ```

  17 件すべて緑になる。

- [ ] **Step 7: わざと壊してテストが検知することを確認する**

  1 つずつ試し、そのたびに Step 5 のマイグレーション再生成を挟む。

  1. `check('ck_profiles_role', ...)` の行を消す
     → 「定義にない role は CHECK で拒否する」が落ちる。
     **`text('role', { enum: ROLES })` だけでは DB は何も守らない**ことの実証になる
  2. `areas.parentId` の `{ onDelete: 'set null' }` を `{ onDelete: 'cascade' }` に変える
     → 「親エリアを削除すると子の parent_id は NULL になる」が
     `expected undefined to be null` で落ちる（子ごと消えて行が無くなるため）
  3. `genres.slug` の `.unique()` を外す
     → 「slug は一意である」が落ちる
  4. `check('ck_genres_sort_order', atLeast(table.sortOrder, SORT_ORDER_MIN))` を
     `atLeast(table.sortOrder, -100)` に変える
     → 「負の sort_order は CHECK で拒否する」が落ちる
     4b. `consistsOf(table.slug, SLUG_ALLOWED_CHARACTERS)` を
     `matchesGlob(table.slug, '[a-z0-9-]*')` に変える
     → 「slug の途中に空白が混じっても拒否する」だけが落ちる。
     **GLOB の `[...]` が 1 文字しか見ないこと**を身体で確認するための一手
  5. `index('idx_areas_parent_id')` を消す
     → 「マスタの検索に使う索引が張られている」が落ちる

  **5 つすべて確認したら元に戻し、再生成してテストが緑に戻ることを確認する。**

- [ ] **Step 8: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

  `areas.parentId` で `TS7022: 'areas' implicitly has type 'any' because it does not have a type
annotation and is referenced directly or indirectly in its own initializer` が出たら、
  `(): AnySQLiteColumn =>` の戻り値型注釈が抜けている。

- [ ] **Step 9: コミット**

  `feat(api): profiles / genres / areas のスキーマを定義` として報告する。

---

### Task 3-4: `db/schema/shop.ts` — shops と地理空間索引

Phase 3 の中心。設計書 §3.1 の 3 段構えが成立するかどうかは、このテーブルの
カラムと索引で決まる。**`geohash` は `LIKE` ではなく `GLOB` で引く**という前提を
ここで索引ごと固定する。

**Files:**

- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/shop.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/shop.test.ts`
- Modify: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/index.ts`

**Interfaces:**

```ts
// Consumes
import {
  BUDGET_YEN_MAX,
  BUDGET_YEN_MIN,
  COUNT_MIN,
  IDENTIFIER_MAX_LENGTH,
  LATITUDE_MAX,
  LATITUDE_MIN,
  LONGITUDE_MAX,
  LONGITUDE_MIN,
  RATING_AVG_MAX,
  RATING_AVG_MIN,
  SHOP_ADDRESS_MAX_LENGTH,
  SHOP_DESCRIPTION_MAX_LENGTH,
  SHOP_GEOHASH_PRECISION,
  SHOP_NAME_KANA_MAX_LENGTH,
  SHOP_NAME_MAX_LENGTH,
  SHOP_STATUS_DRAFT,
  SHOP_STATUSES,
} from '../constants';
import {
  atLeast,
  atMostColumn,
  betweenInclusive,
  consistsOf,
  inValues,
  lengthAtMost,
  lengthIs,
  matchesGlob,
} from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';
import { areas, genres } from './master';

// Produces
export const shops;
export const GEOHASH_ALPHABET_CHARACTER_CLASS: string; // 'geohash' の許可文字クラス
```

- [ ] **Step 1: 失敗するテストを書く（`src/db/schema/shop.test.ts`）— 制約編**

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

  let local: LocalD1;

  const OWNER_ID = 'usr_shop_owner';
  const GENRE_ID = 'gnr_ramen';
  const AREA_ID = 'area_shibuya';

  /** 渋谷駅の座標と、その precision 7 の geohash（packages/geo の encodeGeohash で算出した値） */
  const SHIBUYA = { lat: 35.658034, lng: 139.701636, geohash: 'xn76fgr' } as const;

  type ShopOverrides = Readonly<Record<string, string | number | null>>;

  /** 正常な shops 行をベースに、一部だけ差し替えて INSERT する */
  async function insertShop(overrides: ShopOverrides): Promise<void> {
    const row: Record<string, string | number | null> = {
      id: 'shp_base',
      owner_id: OWNER_ID,
      name: '渋谷らーめん',
      genre_id: GENRE_ID,
      area_id: AREA_ID,
      address: '東京都渋谷区道玄坂1-1-1',
      lat: SHIBUYA.lat,
      lng: SHIBUYA.lng,
      geohash: SHIBUYA.geohash,
      postal_code: '150-0043',
      ...overrides,
    };
    const columnNames = Object.keys(row);
    const placeholders = columnNames.map(() => '?').join(', ');
    await local.d1
      .prepare(`INSERT INTO shops (${columnNames.join(', ')}) VALUES (${placeholders})`)
      .bind(...Object.values(row))
      .run();
  }

  beforeAll(async () => {
    local = await createMigratedD1();
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind(OWNER_ID, 'オーナー', 'shopowner@example.com')
      .run();
    await local.d1
      .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
      .bind(GENRE_ID, 'ラーメン', 'ramen')
      .run();
    await local.d1
      .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
      .bind(AREA_ID, '渋谷', '東京都')
      .run();
  });

  afterAll(async () => {
    await local.dispose();
  });

  describe('shops の既定値', () => {
    it('status / rating_avg / rating_count / view_count は省略できる', async () => {
      await insertShop({ id: 'shp_default' });

      const row = await local.d1
        .prepare('SELECT status, rating_avg, rating_count, view_count FROM shops WHERE id = ?')
        .bind('shp_default')
        .first<{
          status: string;
          rating_avg: number;
          rating_count: number;
          view_count: number;
        }>();

      // 新規作成直後は下書き。オーナーが公開申請するまで検索に出さない
      expect(row?.status).toBe('draft');
      expect(row?.rating_avg).toBe(0);
      expect(row?.rating_count).toBe(0);
      expect(row?.view_count).toBe(0);
    });
  });

  describe('shops の外部キー', () => {
    it('存在しない genre_id は拒否する', async () => {
      await expect(insertShop({ id: 'shp_ng_genre', genre_id: 'gnr_missing' })).rejects.toThrow(
        /FOREIGN KEY constraint failed/,
      );
    });

    it('存在しない area_id は拒否する', async () => {
      await expect(insertShop({ id: 'shp_ng_area', area_id: 'area_missing' })).rejects.toThrow(
        /FOREIGN KEY constraint failed/,
      );
    });

    it('使われているジャンルは削除できない（ON DELETE restrict）', async () => {
      await insertShop({ id: 'shp_genre_lock' });
      await expect(
        local.d1.prepare('DELETE FROM genres WHERE id = ?').bind(GENRE_ID).run(),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    });

    it('owner_id は NULL を許す（申請前・オーナー付け替え中の店舗があるため）', async () => {
      await insertShop({ id: 'shp_no_owner', owner_id: null });

      const row = await local.d1
        .prepare('SELECT owner_id FROM shops WHERE id = ?')
        .bind('shp_no_owner')
        .first<{ owner_id: string | null }>();

      expect(row?.owner_id).toBeNull();
    });

    it('オーナーを削除しても店舗は残り、owner_id だけ NULL になる', async () => {
      await local.d1
        .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
        .bind('usr_temp_owner', '一時', 'tempowner@example.com')
        .run();
      await insertShop({ id: 'shp_orphaned', owner_id: 'usr_temp_owner' });

      await local.d1.prepare('DELETE FROM user WHERE id = ?').bind('usr_temp_owner').run();

      const row = await local.d1
        .prepare('SELECT owner_id FROM shops WHERE id = ?')
        .bind('shp_orphaned')
        .first<{ owner_id: string | null }>();

      // 店舗ごと消すとレビューや予約の履歴まで失われる。オーナーだけ外して管理者が付け替える
      expect(row).not.toBeNull();
      expect(row?.owner_id).toBeNull();
    });
  });

  describe('shops の CHECK 制約', () => {
    it('定義にない status は拒否する', async () => {
      await expect(insertShop({ id: 'shp_ng_status', status: 'open' })).rejects.toThrow(
        /CHECK constraint failed: ck_shops_status/,
      );
    });

    it('緯度が 90 を超えたら拒否する', async () => {
      await expect(insertShop({ id: 'shp_ng_lat', lat: 90.000001 })).rejects.toThrow(
        /CHECK constraint failed: ck_shops_lat/,
      );
    });

    it('緯度ちょうど 90 / -90 は受け付ける（境界値）', async () => {
      await insertShop({ id: 'shp_lat_max', lat: 90, geohash: 'upbpbpb' });
      await insertShop({ id: 'shp_lat_min', lat: -90, geohash: 'h000000' });
    });

    it('経度が -180 を下回ったら拒否する', async () => {
      await expect(insertShop({ id: 'shp_ng_lng', lng: -180.000001 })).rejects.toThrow(
        /CHECK constraint failed: ck_shops_lng/,
      );
    });

    it('geohash の長さが precision 7 でなければ拒否する', async () => {
      await expect(insertShop({ id: 'shp_ng_gh6', geohash: 'xn76fg' })).rejects.toThrow(
        /CHECK constraint failed: ck_shops_geohash_length/,
      );
      await expect(insertShop({ id: 'shp_ng_gh8', geohash: 'xn76fgrb' })).rejects.toThrow(
        /CHECK constraint failed: ck_shops_geohash_length/,
      );
    });

    it('geohash に base32 外の文字（a / i / l / o）があれば拒否する', async () => {
      for (const [index, invalidGeohash] of [
        'xn76fga',
        'xn76fgi',
        'xn76fgl',
        'xn76fgo',
      ].entries()) {
        await expect(
          insertShop({ id: `shp_ng_alpha_${String(index)}`, geohash: invalidGeohash }),
        ).rejects.toThrow(/CHECK constraint failed: ck_shops_geohash_alphabet/);
      }
    });

    it('郵便番号は NNN-NNNN 形式でなければ拒否する', async () => {
      await expect(insertShop({ id: 'shp_ng_zip', postal_code: '1500043' })).rejects.toThrow(
        /CHECK constraint failed: ck_shops_postal_code_format/,
      );
    });

    it('郵便番号は NULL を許す（未入力の下書きがあるため）', async () => {
      await insertShop({ id: 'shp_no_zip', postal_code: null });
    });

    it('予算の min が max を上回ったら拒否する', async () => {
      await expect(
        insertShop({ id: 'shp_ng_budget', budget_lunch_min: 3000, budget_lunch_max: 1000 }),
      ).rejects.toThrow(/CHECK constraint failed: ck_shops_budget_lunch_order/);
    });

    it('予算は片側だけの指定を許す（「1000 円〜」の表示に使う）', async () => {
      await insertShop({ id: 'shp_budget_min_only', budget_lunch_min: 1000 });
      await insertShop({ id: 'shp_budget_max_only', budget_dinner_max: 8000 });
    });

    it('予算が上限（100 万円）を超えたら拒否する', async () => {
      await expect(
        insertShop({ id: 'shp_ng_budget_max', budget_dinner_max: 1_000_001 }),
      ).rejects.toThrow(/CHECK constraint failed: ck_shops_budget_dinner_range/);
    });

    it('rating_avg が 5 を超えたら拒否する', async () => {
      await expect(insertShop({ id: 'shp_ng_rating', rating_avg: 5.1 })).rejects.toThrow(
        /CHECK constraint failed: ck_shops_rating_avg/,
      );
    });

    it('rating_count が負なら拒否する', async () => {
      await expect(insertShop({ id: 'shp_ng_count', rating_count: -1 })).rejects.toThrow(
        /CHECK constraint failed: ck_shops_rating_count/,
      );
    });

    it('店名が 100 文字を超えたら拒否する', async () => {
      await expect(insertShop({ id: 'shp_ng_name', name: 'あ'.repeat(101) })).rejects.toThrow(
        /CHECK constraint failed: ck_shops_name_length/,
      );
    });

    it('店名ちょうど 100 文字は受け付ける（境界値）', async () => {
      await insertShop({ id: 'shp_name_100', name: 'あ'.repeat(100) });
    });
  });
  ```

- [ ] **Step 2: 失敗するテストを書く（同じファイル）— 索引編**

  設計書のインデックス方針が「書いてあるだけ」にならないよう、
  **索引が存在すること**と**クエリプランナが実際に使うこと**の両方を検証する。

  ```ts
  describe('shops の索引', () => {
    it('設計書 §6 のインデックス方針どおりの索引が張られている', async () => {
      const rows = await local.d1
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'shops'")
        .all<{ name: string }>();
      const indexNames = rows.results.map((row) => row.name);

      expect(indexNames).toContain('idx_shops_geohash');
      expect(indexNames).toContain('idx_shops_status_geohash');
      expect(indexNames).toContain('idx_shops_lat_lng');
      expect(indexNames).toContain('idx_shops_genre_status');
      expect(indexNames).toContain('idx_shops_area_status');
      expect(indexNames).toContain('idx_shops_owner_id');
    });

    it('geohash の前方一致は GLOB なら索引を使う', async () => {
      const plan = await local.d1
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM shops WHERE geohash GLOB 'xn76f*'")
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).toContain('idx_shops_geohash');
      expect(detail).not.toContain('SCAN shops');
    });

    it('geohash の前方一致に LIKE を使うと索引が効かない（GLOB を使う根拠）', async () => {
      const plan = await local.d1
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM shops WHERE geohash LIKE 'xn76f%'")
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      // SQLite の LIKE 最適化は case_sensitive_like が OFF（既定）だと働かない。
      // この事実が変わったら 3 段構えの前提を見直す必要があるため、回帰テストとして固定する
      expect(detail).toContain('SCAN shops');
    });

    it('status + geohash の複合条件は複合索引を使う', async () => {
      const plan = await local.d1
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM shops WHERE status = 'published' AND geohash GLOB 'xn76f*'",
        )
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).toContain('idx_shops_status_geohash');
      expect(detail).not.toContain('SCAN shops');
    });

    it('境界ボックスの範囲比較は lat/lng の索引を使う', async () => {
      const plan = await local.d1
        .prepare(
          'EXPLAIN QUERY PLAN SELECT id FROM shops WHERE lat BETWEEN 35.6 AND 35.7 AND lng BETWEEN 139.6 AND 139.8',
        )
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).toContain('idx_shops_lat_lng');
      expect(detail).not.toContain('SCAN shops');
    });

    it('ジャンル + 公開状態の絞り込みは複合索引を使う', async () => {
      const plan = await local.d1
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM shops WHERE genre_id = 'gnr_ramen' AND status = 'published'",
        )
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).toContain('idx_shops_genre_status');
    });
  });
  ```

- [ ] **Step 3: テストが失敗することを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/shop.test.ts
  ```

  `no such table: shops` で落ちる。

- [ ] **Step 4: `src/db/schema/shop.ts` を書く**

  ```ts
  import { sql } from 'drizzle-orm';
  import { check, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
  import {
    BUDGET_YEN_MAX,
    BUDGET_YEN_MIN,
    COUNT_MIN,
    IDENTIFIER_MAX_LENGTH,
    LATITUDE_MAX,
    LATITUDE_MIN,
    LONGITUDE_MAX,
    LONGITUDE_MIN,
    RATING_AVG_MAX,
    RATING_AVG_MIN,
    SHOP_ADDRESS_MAX_LENGTH,
    SHOP_DESCRIPTION_MAX_LENGTH,
    SHOP_GEOHASH_PRECISION,
    SHOP_NAME_KANA_MAX_LENGTH,
    SHOP_NAME_MAX_LENGTH,
    SHOP_STATUS_DRAFT,
    SHOP_STATUSES,
  } from '../constants';
  import {
    atLeast,
    atMostColumn,
    betweenInclusive,
    consistsOf,
    inValues,
    lengthAtMost,
    lengthIs,
    matchesGlob,
  } from '../sql-helpers';
  import { CREATED_AT_DEFAULT, user } from './auth';
  import { areas, genres } from './master';

  /**
   * geohash の base32 で使える文字。`a` `i` `l` `o` を含まない（見間違い防止のため除外された文字）。
   * GLOB の文字クラスとして使うので、範囲表記（`0-9`）と個別文字を並べた形にしてある。
   */
  export const GEOHASH_ALPHABET_CHARACTER_CLASS = '0-9bcdefghjkmnpqrstuvwxyz';

  /** 日本の郵便番号（NNN-NNNN）を表す GLOB パターン */
  const POSTAL_CODE_GLOB_PATTERN = '[0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]';

  /** 電話番号の上限。ハイフン込みの国内番号で十分収まる */
  const PHONE_MAX_LENGTH = 20;
  /** URL の上限 */
  const WEBSITE_MAX_LENGTH = 500;
  /** 初期値のカウンタ・評価 */
  const INITIAL_COUNT = 0;
  const INITIAL_RATING_AVG = 0;

  /**
   * 店舗。アプリの中心テーブル。
   *
   * 地理空間検索（設計書 §3.1）のために、緯度経度に加えて geohash（precision 7）を冗長に持つ。
   * D1 には R*Tree も三角関数もないため、
   *   段 1: geohash の前方一致（GLOB。索引が効く）
   *   段 2: lat / lng の範囲比較（索引が効く）
   *   段 3: Worker 上の Haversine
   * の 3 段で絞る。段 1・2 に必要な索引をこのテーブルで定義する。
   */
  export const shops = sqliteTable(
    'shops',
    {
      id: text('id').primaryKey(),
      // 申請前やオーナー付け替え中は NULL。ユーザーを消しても店舗は残す
      ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
      name: text('name').notNull(),
      // 五十音順ソートと読み仮名検索のため。任意入力
      nameKana: text('name_kana'),
      // マスタが消えて店舗が宙に浮かないよう restrict。削除したいなら先に店舗を移す
      genreId: text('genre_id')
        .notNull()
        .references(() => genres.id, { onDelete: 'restrict' }),
      areaId: text('area_id')
        .notNull()
        .references(() => areas.id, { onDelete: 'restrict' }),
      description: text('description'),
      postalCode: text('postal_code'),
      address: text('address').notNull(),
      // 地図のピンと段 2 の境界ボックス判定に使う
      lat: real('lat').notNull(),
      lng: real('lng').notNull(),
      // 段 1 の前方一致に使う。precision 7 ≒ 152m 四方（設計書 §3.1）
      geohash: text('geohash').notNull(),
      phone: text('phone'),
      website: text('website'),
      budgetLunchMin: integer('budget_lunch_min'),
      budgetLunchMax: integer('budget_lunch_max'),
      budgetDinnerMin: integer('budget_dinner_min'),
      budgetDinnerMax: integer('budget_dinner_max'),
      status: text('status', { enum: SHOP_STATUSES }).notNull().default(SHOP_STATUS_DRAFT),
      // レビューの集計結果を非正規化して持つ。一覧のソートで毎回 JOIN したくないため
      ratingAvg: real('rating_avg').notNull().default(INITIAL_RATING_AVG),
      ratingCount: integer('rating_count').notNull().default(INITIAL_COUNT),
      viewCount: integer('view_count').notNull().default(INITIAL_COUNT),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
      // $onUpdateFn は Drizzle 経由の UPDATE でのみ働く。生 SQL で更新する場合は明示的に入れる
      updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT)
        .$onUpdateFn(() => new Date()),
    },
    (table) => [
      // ── 索引（設計書 §6 のインデックス方針）──
      // 段 1。公開・非公開を問わない管理画面用
      index('idx_shops_geohash').on(table.geohash),
      // 段 1。利用者向けの検索は必ず status = 'published' が付くため複合で持つ。
      // これがないとプランナが status 側の索引を選び、geohash の絞り込みが効かない
      index('idx_shops_status_geohash').on(table.status, table.geohash),
      // 段 2
      index('idx_shops_lat_lng').on(table.lat, table.lng),
      // 一覧の絞り込み
      index('idx_shops_genre_status').on(table.genreId, table.status),
      index('idx_shops_area_status').on(table.areaId, table.status),
      // オーナーの管理画面「自分の店舗」
      index('idx_shops_owner_id').on(table.ownerId),
      // 評価順ランキング。SQLite の索引列に .desc() はないので SQL 片で書く
      index('idx_shops_status_rating').on(table.status, sql`${table.ratingAvg} desc`),

      // ── CHECK 制約 ──
      check('ck_shops_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_shops_status', inValues(table.status, SHOP_STATUSES)),
      check('ck_shops_name_length', lengthAtMost(table.name, SHOP_NAME_MAX_LENGTH)),
      check('ck_shops_name_kana_length', lengthAtMost(table.nameKana, SHOP_NAME_KANA_MAX_LENGTH)),
      check(
        'ck_shops_description_length',
        lengthAtMost(table.description, SHOP_DESCRIPTION_MAX_LENGTH),
      ),
      check('ck_shops_address_length', lengthAtMost(table.address, SHOP_ADDRESS_MAX_LENGTH)),
      check('ck_shops_phone_length', lengthAtMost(table.phone, PHONE_MAX_LENGTH)),
      check('ck_shops_website_length', lengthAtMost(table.website, WEBSITE_MAX_LENGTH)),
      check('ck_shops_postal_code_format', matchesGlob(table.postalCode, POSTAL_CODE_GLOB_PATTERN)),
      check('ck_shops_lat', betweenInclusive(table.lat, LATITUDE_MIN, LATITUDE_MAX)),
      check('ck_shops_lng', betweenInclusive(table.lng, LONGITUDE_MIN, LONGITUDE_MAX)),
      // 長さと文字種を分けて縛る。どちらが壊れたかエラー名で分かるようにするため
      check('ck_shops_geohash_length', lengthIs(table.geohash, SHOP_GEOHASH_PRECISION)),
      check(
        'ck_shops_geohash_alphabet',
        consistsOf(table.geohash, GEOHASH_ALPHABET_CHARACTER_CLASS),
      ),
      check(
        'ck_shops_budget_lunch_range',
        sql`${betweenInclusive(table.budgetLunchMin, BUDGET_YEN_MIN, BUDGET_YEN_MAX)} AND ${betweenInclusive(table.budgetLunchMax, BUDGET_YEN_MIN, BUDGET_YEN_MAX)}`,
      ),
      check(
        'ck_shops_budget_dinner_range',
        sql`${betweenInclusive(table.budgetDinnerMin, BUDGET_YEN_MIN, BUDGET_YEN_MAX)} AND ${betweenInclusive(table.budgetDinnerMax, BUDGET_YEN_MIN, BUDGET_YEN_MAX)}`,
      ),
      // 片側だけの指定（「1000 円〜」）を許すため、NULL なら式全体が NULL になって CHECK を通る
      check(
        'ck_shops_budget_lunch_order',
        atMostColumn(table.budgetLunchMin, table.budgetLunchMax),
      ),
      check(
        'ck_shops_budget_dinner_order',
        atMostColumn(table.budgetDinnerMin, table.budgetDinnerMax),
      ),
      check(
        'ck_shops_rating_avg',
        betweenInclusive(table.ratingAvg, RATING_AVG_MIN, RATING_AVG_MAX),
      ),
      check('ck_shops_rating_count', atLeast(table.ratingCount, COUNT_MIN)),
      check('ck_shops_view_count', atLeast(table.viewCount, COUNT_MIN)),
    ],
  );
  ```

- [ ] **Step 5: `schema/index.ts` に追記してマイグレーションを再生成する**

  ```ts
  export * from './auth';
  export * from './master';
  export * from './shop';
  ```

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  rm -rf migrations/meta migrations/0000_init.sql
  node ../../node_modules/.bin/drizzle-kit generate --name=init
  grep -n 'ck_shops_geohash_alphabet' migrations/0000_init.sql
  ```

  期待する出力（`?` が 1 つも無いこと）:

  ```
  CONSTRAINT "ck_shops_geohash_alphabet" CHECK("shops"."geohash" <> '' AND "shops"."geohash" NOT GLOB '*[^0-9bcdefghjkmnpqrstuvwxyz]*')
  ```

- [ ] **Step 6: テストが通ることを確認する**

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/shop.test.ts
  ```

  制約 19 件 + 索引 6 件 = 25 件すべて緑になる。

- [ ] **Step 7: わざと壊してテストが検知することを確認する**

  1 つずつ試し、そのたびにマイグレーションを再生成する。

  1. `index('idx_shops_geohash')` を消す
     → 「geohash の前方一致は GLOB なら索引を使う」が
     `expected 'SCAN shops' to contain 'idx_shops_geohash'` で落ちる。
     **索引を消すとテストが落ちる**ことをここで確認しておくのが重要
  2. `index('idx_shops_status_geohash')` を消す
     → 「status + geohash の複合条件は複合索引を使う」が落ちる
  3. `index('idx_shops_lat_lng')` を消す
     → 「境界ボックスの範囲比較は lat/lng の索引を使う」が落ちる
  4. `check('ck_shops_geohash_length', ...)` を消す
     → 「geohash の長さが precision 7 でなければ拒否する」が落ちる
  5. `genreId` の `{ onDelete: 'restrict' }` を `{ onDelete: 'cascade' }` に変える
     → 「使われているジャンルは削除できない」が落ちる。
     同時に**ジャンルを消すと店舗が全部消える**という事故が実演される
  6. `ownerId` の `{ onDelete: 'set null' }` を `{ onDelete: 'cascade' }` に変える
     → 「オーナーを削除しても店舗は残り、owner_id だけ NULL になる」が
     `expected null to not be null` で落ちる
  7. `lat` の `betweenInclusive(..., LATITUDE_MIN, LATITUDE_MAX)` を
     `betweenInclusive(..., -180, 180)` に変える
     → 「緯度が 90 を超えたら拒否する」が落ちる

  **7 つすべて確認したら元に戻し、再生成してテストが緑に戻ることを確認する。**

- [ ] **Step 8: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

- [ ] **Step 9: コミット**

  `feat(api): shops テーブルと地理空間検索用の索引を定義` として報告する。

---

### Task 3-5: `db/schema/shop-detail.ts` — 営業時間・臨時休業・写真

設計書 §6 の `shop_hours` / `shop_closures` / `shop_photos`。
営業時間は**分単位の整数**で持ち、日跨ぎは `close_minute > 1440` で表す
（`26:00` = `1560`）。文字列の `"25:30"` を保存しないのは、比較とソートを
SQL 側で素直に書けるようにするため。

**Files:**

- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/shop-detail.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/shop-detail.test.ts`
- Modify: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/index.ts`

**Interfaces:**

```ts
// Consumes
import {
  DAY_OF_WEEK_MAX,
  DAY_OF_WEEK_MIN,
  IDENTIFIER_MAX_LENGTH,
  ISO_DATE_GLOB_PATTERN,
  MINUTE_OF_DAY_MAX,
  MINUTE_OF_DAY_MIN,
  R2_KEY_ALLOWED_CHARACTERS,
  R2_KEY_MAX_LENGTH,
  SORT_ORDER_MIN,
} from '../constants';
import {
  atLeast,
  betweenInclusive,
  consistsOf,
  isBooleanInteger,
  lengthAtMost,
  matchesGlob,
} from '../sql-helpers';
import { shops } from './shop';

// Produces
export const shopHours; // id / shop_id / day_of_week / open_minute / close_minute / is_closed
export const shopClosures; // id / shop_id / date / reason
export const shopPhotos; // id / shop_id / r2_key / caption / sort_order / is_cover
```

- [ ] **Step 1: 失敗するテストを書く（`src/db/schema/shop-detail.test.ts`）— `shop_hours`**

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

  let local: LocalD1;

  const SHOP_ID = 'shp_detail';
  const OTHER_SHOP_ID = 'shp_detail_other';

  /** 曜日番号。0 = 日曜（設計書 §6 の day_of_week は 0-6） */
  const MONDAY = 1;
  const TUESDAY = 2;
  const WEDNESDAY = 3;

  /** 分単位の時刻。11:00 = 660、14:00 = 840、18:00 = 1080、25:30 = 1530 */
  const MINUTE_11_00 = 660;
  const MINUTE_14_00 = 840;
  const MINUTE_18_00 = 1080;
  const MINUTE_25_30 = 1530;

  type InsertParams = readonly (string | number | null)[];

  async function insertHours(values: InsertParams): Promise<void> {
    await local.d1
      .prepare(
        'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute, is_closed) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(...values)
      .run();
  }

  beforeAll(async () => {
    local = await createMigratedD1();
    await local.d1
      .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
      .bind('gnr_detail', 'ラーメン', 'ramen-detail')
      .run();
    await local.d1
      .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
      .bind('area_detail', '渋谷', '東京都')
      .run();
    for (const shopId of [SHOP_ID, OTHER_SHOP_ID]) {
      await local.d1
        .prepare(
          'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          shopId,
          '詳細テスト店',
          'gnr_detail',
          'area_detail',
          '東京都渋谷区',
          35.658034,
          139.701636,
          'xn76fgr',
        )
        .run();
    }
  });

  afterAll(async () => {
    await local.dispose();
  });

  describe('shop_hours', () => {
    it('通常の営業時間を保存できる', async () => {
      await insertHours(['sh_normal', SHOP_ID, MONDAY, MINUTE_11_00, MINUTE_14_00, 0]);
    });

    it('日跨ぎ営業（18:00-25:30）を close_minute > 1440 で表せる', async () => {
      // 文字列の "25:30" ではなく分の整数で持つので、比較もソートも SQL でそのまま書ける
      await insertHours(['sh_overnight', SHOP_ID, MONDAY, MINUTE_18_00, MINUTE_25_30, 0]);
    });

    it('同じ曜日に複数行を置ける（中休みのある店の昼営業・夜営業）', async () => {
      const row = await local.d1
        .prepare(
          'SELECT count(*) AS slot_count FROM shop_hours WHERE shop_id = ? AND day_of_week = ?',
        )
        .bind(SHOP_ID, MONDAY)
        .first<{ slot_count: number }>();

      expect(row?.slot_count).toBe(2);
    });

    it('定休日は is_closed = 1 かつ時刻 NULL で保存する', async () => {
      await insertHours(['sh_closed', SHOP_ID, TUESDAY, null, null, 1]);
    });

    it('定休日なのに時刻が入っていたら拒否する', async () => {
      await expect(
        insertHours(['sh_ng_closed', SHOP_ID, WEDNESDAY, MINUTE_11_00, MINUTE_14_00, 1]),
      ).rejects.toThrow(/CHECK constraint failed: ck_shop_hours_closed_coherence/);
    });

    it('営業日なのに時刻が NULL なら拒否する', async () => {
      await expect(insertHours(['sh_ng_open', SHOP_ID, WEDNESDAY, null, null, 0])).rejects.toThrow(
        /CHECK constraint failed: ck_shop_hours_closed_coherence/,
      );
    });

    it('曜日が 7 なら拒否する', async () => {
      await expect(
        insertHours(['sh_ng_dow', SHOP_ID, 7, MINUTE_11_00, MINUTE_14_00, 0]),
      ).rejects.toThrow(/CHECK constraint failed: ck_shop_hours_day_of_week/);
    });

    it('曜日 0（日曜）は受け付ける（境界値）', async () => {
      await insertHours(['sh_sunday', SHOP_ID, 0, MINUTE_11_00, MINUTE_14_00, 0]);
    });

    it('close_minute 2879（翌 47:59）は受け付ける（境界値）', async () => {
      await insertHours(['sh_late_max', SHOP_ID, 4, MINUTE_18_00, 2879, 0]);
    });

    it('close_minute 2880 は拒否する（2 日分を超える営業は表現しない）', async () => {
      await expect(insertHours(['sh_ng_late', SHOP_ID, 4, MINUTE_18_00, 2880, 0])).rejects.toThrow(
        /CHECK constraint failed: ck_shop_hours_close_minute/,
      );
    });

    it('開店時刻が閉店時刻以上なら拒否する', async () => {
      await expect(
        insertHours(['sh_ng_order', SHOP_ID, 5, MINUTE_14_00, MINUTE_11_00, 0]),
      ).rejects.toThrow(/CHECK constraint failed: ck_shop_hours_open_before_close/);
    });

    it('is_closed に 0 / 1 以外を入れたら拒否する', async () => {
      await expect(insertHours(['sh_ng_bool', SHOP_ID, 5, null, null, 2])).rejects.toThrow(
        /CHECK constraint failed: ck_shop_hours_is_closed/,
      );
    });

    it('is_closed を省略すると営業日（0）になる', async () => {
      await local.d1
        .prepare(
          'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute) VALUES (?, ?, ?, ?, ?)',
        )
        .bind('sh_default', SHOP_ID, 6, MINUTE_11_00, MINUTE_14_00)
        .run();

      const row = await local.d1
        .prepare('SELECT is_closed FROM shop_hours WHERE id = ?')
        .bind('sh_default')
        .first<{ is_closed: number }>();

      expect(row?.is_closed).toBe(0);
    });

    it('店舗 + 曜日の絞り込みは索引を使う', async () => {
      const plan = await local.d1
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM shop_hours WHERE shop_id = 'shp_detail' AND day_of_week = 1",
        )
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).toContain('idx_shop_hours_shop_day');
      expect(detail).not.toContain('SCAN shop_hours');
    });
  });
  ```

- [ ] **Step 2: 失敗するテストを書く（同じファイル）— `shop_closures` と `shop_photos`**

  ```ts
  describe('shop_closures', () => {
    it('臨時休業日を保存できる', async () => {
      await local.d1
        .prepare('INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)')
        .bind('cls_newyear', SHOP_ID, '2026-01-01', '元日')
        .run();
    });

    it('同じ店の同じ日を二重に登録できない', async () => {
      await expect(
        local.d1
          .prepare('INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)')
          .bind('cls_dup', SHOP_ID, '2026-01-01', '重複')
          .run(),
      ).rejects.toThrow(/UNIQUE constraint failed: shop_closures\.shop_id, shop_closures\.date/);
    });

    it('別の店なら同じ日を登録できる', async () => {
      await local.d1
        .prepare('INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)')
        .bind('cls_other', OTHER_SHOP_ID, '2026-01-01', '元日')
        .run();
    });

    it('日付が YYYY-MM-DD 形式でなければ拒否する', async () => {
      await expect(
        local.d1
          .prepare('INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)')
          .bind('cls_ng', SHOP_ID, '20260101', null)
          .run(),
      ).rejects.toThrow(/CHECK constraint failed: ck_shop_closures_date_format/);
    });

    it('理由なしの休業日を登録できる', async () => {
      await local.d1
        .prepare('INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)')
        .bind('cls_no_reason', SHOP_ID, '2026-01-02', null)
        .run();
    });
  });

  describe('shop_photos', () => {
    async function insertPhoto(values: InsertParams): Promise<void> {
      await local.d1
        .prepare(
          'INSERT INTO shop_photos (id, shop_id, r2_key, caption, sort_order, is_cover) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(...values)
        .run();
    }

    it('カバー写真と通常写真を保存できる', async () => {
      await insertPhoto(['pht_cover', SHOP_ID, 'shop-photos/shp_detail/a1b2.webp', '外観', 0, 1]);
      await insertPhoto(['pht_second', SHOP_ID, 'shop-photos/shp_detail/c3d4.webp', '内観', 1, 0]);
      await insertPhoto(['pht_third', SHOP_ID, 'shop-photos/shp_detail/e5f6.webp', null, 2, 0]);
    });

    it('1 店舗にカバー写真は 1 枚しか置けない（部分ユニーク索引）', async () => {
      await expect(
        insertPhoto(['pht_ng_cover', SHOP_ID, 'shop-photos/shp_detail/g7h8.webp', null, 3, 1]),
      ).rejects.toThrow(/UNIQUE constraint failed: shop_photos\.shop_id/);
    });

    it('別の店ならカバー写真を持てる（部分索引が店舗単位で効いている）', async () => {
      await insertPhoto([
        'pht_other_cover',
        OTHER_SHOP_ID,
        'shop-photos/shp_other/i9j0.webp',
        null,
        0,
        1,
      ]);
    });

    it('同じ R2 キーを 2 行で使えない', async () => {
      await expect(
        insertPhoto(['pht_dup_key', OTHER_SHOP_ID, 'shop-photos/shp_detail/a1b2.webp', null, 1, 0]),
      ).rejects.toThrow(/UNIQUE constraint failed: shop_photos\.r2_key/);
    });

    it('R2 キーに大文字が混ざったら拒否する', async () => {
      await expect(
        insertPhoto(['pht_ng_upper', OTHER_SHOP_ID, 'shop-photos/shp_other/ABC.webp', null, 2, 0]),
      ).rejects.toThrow(/CHECK constraint failed: ck_shop_photos_r2_key/);
    });

    it('R2 キーに空白が混ざったら拒否する', async () => {
      await expect(
        insertPhoto(['pht_ng_space', OTHER_SHOP_ID, 'shop-photos/shp_other/a b.webp', null, 3, 0]),
      ).rejects.toThrow(/CHECK constraint failed: ck_shop_photos_r2_key/);
    });

    it('sort_order が負なら拒否する', async () => {
      await expect(
        insertPhoto(['pht_ng_sort', OTHER_SHOP_ID, 'shop-photos/shp_other/k1l2.webp', null, -1, 0]),
      ).rejects.toThrow(/CHECK constraint failed: ck_shop_photos_sort_order/);
    });

    it('存在しない shop_id は拒否する', async () => {
      await expect(
        insertPhoto(['pht_ng_shop', 'shp_missing', 'shop-photos/missing/m3n4.webp', null, 0, 0]),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  describe('店舗削除時の連鎖', () => {
    it('店舗を消すと営業時間・休業日・写真もまとめて消える', async () => {
      await local.d1.prepare('DELETE FROM shops WHERE id = ?').bind(SHOP_ID).run();

      for (const tableName of ['shop_hours', 'shop_closures', 'shop_photos'] as const) {
        const row = await local.d1
          .prepare(`SELECT count(*) AS remaining FROM ${tableName} WHERE shop_id = ?`)
          .bind(SHOP_ID)
          .first<{ remaining: number }>();

        // 店舗の付属データは単独では意味を持たないため CASCADE。孤児行を残さない
        expect(row?.remaining).toBe(0);
      }
    });
  });
  ```

- [ ] **Step 3: テストが失敗することを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/shop-detail.test.ts
  ```

  `no such table: shop_hours` で落ちる。

- [ ] **Step 4: `src/db/schema/shop-detail.ts` を書く**

  ```ts
  import { sql } from 'drizzle-orm';
  import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
  import {
    DAY_OF_WEEK_MAX,
    DAY_OF_WEEK_MIN,
    IDENTIFIER_MAX_LENGTH,
    ISO_DATE_GLOB_PATTERN,
    MINUTE_OF_DAY_MAX,
    MINUTE_OF_DAY_MIN,
    R2_KEY_ALLOWED_CHARACTERS,
    R2_KEY_MAX_LENGTH,
    SORT_ORDER_MIN,
  } from '../constants';
  import {
    atLeast,
    betweenInclusive,
    consistsOf,
    isBooleanInteger,
    lengthAtMost,
    matchesGlob,
  } from '../sql-helpers';
  import { shops } from './shop';

  /** 休業理由の上限。「年末年始」「設備点検」程度を想定 */
  const CLOSURE_REASON_MAX_LENGTH = 100;
  /** 写真キャプションの上限 */
  const PHOTO_CAPTION_MAX_LENGTH = 200;
  /** 並び順の既定値 */
  const DEFAULT_SORT_ORDER = 0;

  /**
   * 曜日ごとの営業時間。
   *
   * 時刻は「その日の 00:00 からの経過分」で持つ。日跨ぎ営業は 1440 を足した値で表す
   * （25:30 閉店 = 1530）。文字列の "25:30" を保存すると比較のたびに分解が必要になるため。
   *
   * 中休みのある店は同じ曜日に 2 行（昼・夜）を持つ。したがって (shop_id, day_of_week) は
   * **ユニークにしない**。
   */
  export const shopHours = sqliteTable(
    'shop_hours',
    {
      id: text('id').primaryKey(),
      shopId: text('shop_id')
        .notNull()
        .references(() => shops.id, { onDelete: 'cascade' }),
      // 0 = 日曜。JavaScript の Date#getDay() と揃えてある
      dayOfWeek: integer('day_of_week').notNull(),
      // 定休日（is_closed = 1）のときは NULL
      openMinute: integer('open_minute'),
      closeMinute: integer('close_minute'),
      isClosed: integer('is_closed', { mode: 'boolean' }).notNull().default(false),
    },
    (table) => [
      // 「この店の月曜の営業時間」を引く唯一のアクセスパターン
      index('idx_shop_hours_shop_day').on(table.shopId, table.dayOfWeek),

      check('ck_shop_hours_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check(
        'ck_shop_hours_day_of_week',
        betweenInclusive(table.dayOfWeek, DAY_OF_WEEK_MIN, DAY_OF_WEEK_MAX),
      ),
      check(
        'ck_shop_hours_open_minute',
        betweenInclusive(table.openMinute, MINUTE_OF_DAY_MIN, MINUTE_OF_DAY_MAX),
      ),
      check(
        'ck_shop_hours_close_minute',
        betweenInclusive(table.closeMinute, MINUTE_OF_DAY_MIN, MINUTE_OF_DAY_MAX),
      ),
      check('ck_shop_hours_is_closed', isBooleanInteger(table.isClosed)),
      // 開店 = 閉店（営業時間 0 分）も無意味なので等号は含めない
      check('ck_shop_hours_open_before_close', sql`${table.openMinute} < ${table.closeMinute}`),
      /*
       * 「定休日なのに時刻が入っている」「営業日なのに時刻が NULL」という
       * 矛盾した行を DB レベルで止める。
       * 数値リテラルを書かずに済むよう、is_closed をそのまま真偽値として評価している。
       */
      check(
        'ck_shop_hours_closed_coherence',
        sql`(${table.isClosed} AND ${table.openMinute} IS NULL AND ${table.closeMinute} IS NULL) OR (NOT ${table.isClosed} AND ${table.openMinute} IS NOT NULL AND ${table.closeMinute} IS NOT NULL)`,
      ),
    ],
  );

  /**
   * 臨時休業日。曜日ベースの `shop_hours` では表せない「この日だけ休み」を持つ。
   * 営業判定は shop_hours を見たあとにこのテーブルで打ち消す（設計書 §6）。
   */
  export const shopClosures = sqliteTable(
    'shop_closures',
    {
      id: text('id').primaryKey(),
      shopId: text('shop_id')
        .notNull()
        .references(() => shops.id, { onDelete: 'cascade' }),
      // `YYYY-MM-DD`（JST での暦日）。時刻を持たないので TEXT で持つ
      date: text('date').notNull(),
      reason: text('reason'),
    },
    (table) => [
      // 同じ日を二重登録させない。索引としても「この店のこの日は休みか」に直接効く
      uniqueIndex('uq_shop_closures_shop_date').on(table.shopId, table.date),

      check('ck_shop_closures_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_shop_closures_date_format', matchesGlob(table.date, ISO_DATE_GLOB_PATTERN)),
      check(
        'ck_shop_closures_reason_length',
        lengthAtMost(table.reason, CLOSURE_REASON_MAX_LENGTH),
      ),
    ],
  );

  /**
   * 店舗写真。実体は R2 に置き、ここにはキーだけを持つ（設計書 §6）。
   * キーの形式は `shop-photos/<shop_id>/<uuid>.<ext>`（規約 §1.2）。
   */
  export const shopPhotos = sqliteTable(
    'shop_photos',
    {
      id: text('id').primaryKey(),
      shopId: text('shop_id')
        .notNull()
        .references(() => shops.id, { onDelete: 'cascade' }),
      r2Key: text('r2_key').notNull(),
      caption: text('caption'),
      sortOrder: integer('sort_order').notNull().default(DEFAULT_SORT_ORDER),
      isCover: integer('is_cover', { mode: 'boolean' }).notNull().default(false),
    },
    (table) => [
      // ギャラリーの表示順
      index('idx_shop_photos_shop_sort').on(table.shopId, table.sortOrder),
      // 同じ R2 オブジェクトを 2 行から参照させない。削除時に実体を消してよいか判断できなくなるため
      uniqueIndex('uq_shop_photos_r2_key').on(table.r2Key),
      /*
       * カバー写真は 1 店舗 1 枚。部分ユニーク索引（is_cover が真の行だけを対象）で保証する。
       * 単なる (shop_id, is_cover) のユニークだと「非カバー写真も 1 枚まで」になってしまう。
       */
      uniqueIndex('uq_shop_photos_cover')
        .on(table.shopId)
        .where(sql`${table.isCover}`),

      check('ck_shop_photos_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_shop_photos_r2_key_length', lengthAtMost(table.r2Key, R2_KEY_MAX_LENGTH)),
      check('ck_shop_photos_r2_key', consistsOf(table.r2Key, R2_KEY_ALLOWED_CHARACTERS)),
      check('ck_shop_photos_caption_length', lengthAtMost(table.caption, PHOTO_CAPTION_MAX_LENGTH)),
      check('ck_shop_photos_sort_order', atLeast(table.sortOrder, SORT_ORDER_MIN)),
      check('ck_shop_photos_is_cover', isBooleanInteger(table.isCover)),
    ],
  );
  ```

- [ ] **Step 5: `schema/index.ts` に追記してマイグレーションを再生成する**

  ```ts
  export * from './auth';
  export * from './master';
  export * from './shop';
  export * from './shop-detail';
  ```

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  rm -rf migrations/meta migrations/0000_init.sql
  node ../../node_modules/.bin/drizzle-kit generate --name=init
  grep -n 'uq_shop_photos_cover' migrations/0000_init.sql
  ```

  期待する出力（部分索引の `WHERE` が出ていること）:

  ```
  CREATE UNIQUE INDEX `uq_shop_photos_cover` ON `shop_photos` (`shop_id`) WHERE "shop_photos"."is_cover";
  ```

- [ ] **Step 6: テストが通ることを確認する**

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/shop-detail.test.ts
  ```

  `shop_hours` 14 件 + `shop_closures` 5 件 + `shop_photos` 8 件 + 連鎖削除 1 件 = 28 件が緑になる。

- [ ] **Step 7: わざと壊してテストが検知することを確認する**

  1. `ck_shop_hours_closed_coherence` を消す
     → 「定休日なのに時刻が入っていたら拒否する」「営業日なのに時刻が NULL なら拒否する」が落ちる
  2. `uniqueIndex('uq_shop_photos_cover').on(table.shopId).where(...)` から `.where(...)` を外す
     → 「別の店ならカバー写真を持てる」は通るが、
     「カバー写真と通常写真を保存できる」が 2 枚目の非カバー写真で
     `UNIQUE constraint failed: shop_photos.shop_id` になって落ちる。
     **部分索引の `WHERE` が意味を持っている**ことがここで分かる
  3. `uniqueIndex('uq_shop_closures_shop_date')` を `index(...)` に変える
     → 「同じ店の同じ日を二重に登録できない」が落ちる
  4. `shopId` の `{ onDelete: 'cascade' }` を `{ onDelete: 'restrict' }` に変える
     → 「店舗を消すと営業時間・休業日・写真もまとめて消える」が
     `FOREIGN KEY constraint failed` で落ちる
  5. `betweenInclusive(table.closeMinute, MINUTE_OF_DAY_MIN, MINUTE_OF_DAY_MAX)` の上限を
     `MINUTES_PER_DAY`（1440）に変える
     → 「日跨ぎ営業（18:00-25:30）を close_minute > 1440 で表せる」が落ちる。
     **日跨ぎを潰す変更が即座に検知される**
  6. `consistsOf(table.r2Key, R2_KEY_ALLOWED_CHARACTERS)` を消す
     → 「R2 キーに大文字が混ざったら拒否する」「R2 キーに空白が混ざったら拒否する」が落ちる

  **6 つすべて確認したら元に戻し、再生成してテストが緑に戻ることを確認する。**

- [ ] **Step 8: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

- [ ] **Step 9: コミット**

  `feat(api): 営業時間・臨時休業・店舗写真のテーブルを定義` として報告する。

---

### Task 3-6: `db/schema/menu.ts` — メニューと席設定

設計書 §6 の `menu_categories` / `menu_items` / `seat_settings`。

ここでの肝は「**A 店のメニューが B 店のカテゴリにぶら下がる**」事故を DB で止めること。
`menu_items.category_id` を単純に `menu_categories.id` へ張るだけでは防げないので、
`(shop_id, category_id)` の**複合外部キー**を `menu_categories(shop_id, id)` に張る。

**Files:**

- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/menu.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/menu.test.ts`
- Modify: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/index.ts`

**Interfaces:**

```ts
// Consumes
import {
  IDENTIFIER_MAX_LENGTH,
  MAX_PARALLEL_MAX,
  MAX_PARALLEL_MIN,
  PRICE_YEN_MAX,
  PRICE_YEN_MIN,
  R2_KEY_ALLOWED_CHARACTERS,
  R2_KEY_MAX_LENGTH,
  SEAT_CAPACITY_MAX,
  SEAT_CAPACITY_MIN,
  SLOT_MINUTES_MAX,
  SLOT_MINUTES_MIN,
  SORT_ORDER_MIN,
} from '../constants';
import {
  atLeast,
  betweenInclusive,
  consistsOf,
  isBooleanInteger,
  lengthAtMost,
} from '../sql-helpers';
import { shops } from './shop';

// Produces
export const menuCategories; // id / shop_id / name / sort_order
export const menuItems; // id / shop_id / category_id / name / price / description / r2_key / is_recommended
export const seatSettings; // shop_id(PK) / capacity / slot_minutes / max_parallel / accepts_reservation
```

- [ ] **Step 1: 失敗するテストを書く（`src/db/schema/menu.test.ts`）**

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

  let local: LocalD1;

  const SHOP_ID = 'shp_menu';
  const OTHER_SHOP_ID = 'shp_menu_other';
  const CATEGORY_ID = 'mct_ramen';
  const OTHER_CATEGORY_ID = 'mct_other_side';

  /** 醤油ラーメンの価格（円）。テストで使う代表値 */
  const PRICE_SHOYU_YEN = 900;

  beforeAll(async () => {
    local = await createMigratedD1();
    await local.d1
      .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
      .bind('gnr_menu', 'ラーメン', 'ramen-menu')
      .run();
    await local.d1
      .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
      .bind('area_menu', '渋谷', '東京都')
      .run();
    for (const shopId of [SHOP_ID, OTHER_SHOP_ID]) {
      await local.d1
        .prepare(
          'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          shopId,
          'メニューテスト店',
          'gnr_menu',
          'area_menu',
          '東京都渋谷区',
          35.658034,
          139.701636,
          'xn76fgr',
        )
        .run();
    }
    await local.d1
      .prepare('INSERT INTO menu_categories (id, shop_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind(CATEGORY_ID, SHOP_ID, 'ラーメン', 0)
      .run();
    await local.d1
      .prepare('INSERT INTO menu_categories (id, shop_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind(OTHER_CATEGORY_ID, OTHER_SHOP_ID, 'サイドメニュー', 0)
      .run();
  });

  afterAll(async () => {
    await local.dispose();
  });

  type InsertParams = readonly (string | number | null)[];

  async function insertItem(values: InsertParams): Promise<void> {
    await local.d1
      .prepare(
        'INSERT INTO menu_items (id, shop_id, category_id, name, price, description, r2_key, is_recommended) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(...values)
      .run();
  }

  describe('menu_items と menu_categories の整合', () => {
    it('自分の店のカテゴリにメニューを登録できる', async () => {
      await insertItem([
        'mit_shoyu',
        SHOP_ID,
        CATEGORY_ID,
        '醤油ラーメン',
        PRICE_SHOYU_YEN,
        'あっさり',
        'menu-items/mit_shoyu/a1b2.webp',
        1,
      ]);
    });

    it('カテゴリ未設定（NULL）のメニューを登録できる', async () => {
      // 複合外部キーは片方が NULL なら成立する（SQLite の MATCH SIMPLE 既定）。
      // 「まだ分類していない品」を登録できるのはこの性質のおかげ
      await insertItem(['mit_secret', SHOP_ID, null, '裏メニュー', 1200, null, null, 0]);
    });

    it('他店のカテゴリにメニューをぶら下げられない', async () => {
      await expect(
        insertItem(['mit_ng_cross', SHOP_ID, OTHER_CATEGORY_ID, '混線', 800, null, null, 0]),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    });

    it('存在しないカテゴリは拒否する', async () => {
      await expect(
        insertItem(['mit_ng_missing', SHOP_ID, 'mct_missing', '無い', 800, null, null, 0]),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    });

    it('カテゴリを消すと、そのカテゴリのメニューも消える（未分類の品は残る）', async () => {
      await local.d1.prepare('DELETE FROM menu_categories WHERE id = ?').bind(CATEGORY_ID).run();

      const rows = await local.d1
        .prepare('SELECT id FROM menu_items WHERE shop_id = ? ORDER BY id')
        .bind(SHOP_ID)
        .all<{ id: string }>();

      expect(rows.results.map((row) => row.id)).toEqual(['mit_secret']);
    });
  });

  describe('menu_items の CHECK 制約', () => {
    it('価格 0 円（サービス品）は受け付ける（境界値）', async () => {
      await local.d1
        .prepare('INSERT INTO menu_categories (id, shop_id, name, sort_order) VALUES (?, ?, ?, ?)')
        .bind('mct_free', SHOP_ID, '無料', 1)
        .run();
      await insertItem(['mit_water', SHOP_ID, 'mct_free', 'お冷や', 0, null, null, 0]);
    });

    it('価格が負なら拒否する', async () => {
      await expect(
        insertItem(['mit_ng_price', SHOP_ID, 'mct_free', 'マイナス', -1, null, null, 0]),
      ).rejects.toThrow(/CHECK constraint failed: ck_menu_items_price/);
    });

    it('is_recommended を省略すると 0 になる', async () => {
      await local.d1
        .prepare(
          'INSERT INTO menu_items (id, shop_id, category_id, name, price) VALUES (?, ?, ?, ?, ?)',
        )
        .bind('mit_default', SHOP_ID, 'mct_free', '塩ラーメン', PRICE_SHOYU_YEN)
        .run();

      const row = await local.d1
        .prepare('SELECT is_recommended FROM menu_items WHERE id = ?')
        .bind('mit_default')
        .first<{ is_recommended: number }>();

      expect(row?.is_recommended).toBe(0);
    });

    it('R2 キーに大文字が混ざったら拒否する', async () => {
      await expect(
        insertItem([
          'mit_ng_key',
          SHOP_ID,
          'mct_free',
          '写真付き',
          800,
          null,
          'menu-items/X/A.webp',
          0,
        ]),
      ).rejects.toThrow(/CHECK constraint failed: ck_menu_items_r2_key/);
    });

    it('店舗 + おすすめの絞り込みは索引を使う', async () => {
      const plan = await local.d1
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM menu_items WHERE shop_id = 'shp_menu' AND is_recommended = 1",
        )
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).toContain('idx_menu_items_shop_recommended');
      expect(detail).not.toContain('SCAN menu_items');
    });
  });

  describe('seat_settings', () => {
    it('1 店舗 1 行しか持てない（shop_id が主キー）', async () => {
      await local.d1
        .prepare(
          'INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(SHOP_ID, 20, 90, 2, 1)
        .run();

      await expect(
        local.d1
          .prepare('INSERT INTO seat_settings (shop_id, capacity) VALUES (?, ?)')
          .bind(SHOP_ID, 10)
          .run(),
      ).rejects.toThrow(/UNIQUE constraint failed: seat_settings\.shop_id/);
    });

    it('capacity だけ指定すれば残りは既定値になる', async () => {
      await local.d1
        .prepare('INSERT INTO seat_settings (shop_id, capacity) VALUES (?, ?)')
        .bind(OTHER_SHOP_ID, 10)
        .run();

      const row = await local.d1
        .prepare(
          'SELECT slot_minutes, max_parallel, accepts_reservation FROM seat_settings WHERE shop_id = ?',
        )
        .bind(OTHER_SHOP_ID)
        .first<{ slot_minutes: number; max_parallel: number; accepts_reservation: number }>();

      // 予約は既定で受け付けない。オーナーが明示的に有効化するまで予約導線を出さない
      expect(row?.slot_minutes).toBe(90);
      expect(row?.max_parallel).toBe(1);
      expect(row?.accepts_reservation).toBe(0);
    });

    it('capacity 0 は拒否する', async () => {
      await expect(
        local.d1
          .prepare('INSERT INTO seat_settings (shop_id, capacity) VALUES (?, ?)')
          .bind('shp_menu_zero', 0)
          .run(),
      ).rejects.toThrow(/CHECK constraint failed: ck_seat_settings_capacity/);
    });

    it('slot_minutes が 15 未満なら拒否する', async () => {
      await expect(
        local.d1
          .prepare('INSERT INTO seat_settings (shop_id, capacity, slot_minutes) VALUES (?, ?, ?)')
          .bind('shp_menu_slot', 10, 14)
          .run(),
      ).rejects.toThrow(/CHECK constraint failed: ck_seat_settings_slot_minutes/);
    });
  });

  describe('店舗削除時の連鎖', () => {
    it('店舗を消すとカテゴリ・メニュー・席設定がすべて消える', async () => {
      await local.d1.prepare('DELETE FROM shops WHERE id = ?').bind(SHOP_ID).run();

      for (const tableName of ['menu_categories', 'menu_items', 'seat_settings'] as const) {
        const row = await local.d1
          .prepare(`SELECT count(*) AS remaining FROM ${tableName} WHERE shop_id = ?`)
          .bind(SHOP_ID)
          .first<{ remaining: number }>();

        // shops → menu_categories → menu_items と shops → menu_items の 2 経路の CASCADE が
        // 同時に走るが、SQLite はどちらでも問題なく削除する
        expect(row?.remaining).toBe(0);
      }
    });
  });
  ```

- [ ] **Step 2: テストが失敗することを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/menu.test.ts
  ```

  `no such table: menu_categories` で落ちる。

- [ ] **Step 3: `src/db/schema/menu.ts` を書く**

  ```ts
  import {
    check,
    foreignKey,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
  } from 'drizzle-orm/sqlite-core';
  import {
    IDENTIFIER_MAX_LENGTH,
    MAX_PARALLEL_MAX,
    MAX_PARALLEL_MIN,
    PRICE_YEN_MAX,
    PRICE_YEN_MIN,
    R2_KEY_ALLOWED_CHARACTERS,
    R2_KEY_MAX_LENGTH,
    SEAT_CAPACITY_MAX,
    SEAT_CAPACITY_MIN,
    SLOT_MINUTES_MAX,
    SLOT_MINUTES_MIN,
    SORT_ORDER_MIN,
  } from '../constants';
  import {
    atLeast,
    betweenInclusive,
    consistsOf,
    isBooleanInteger,
    lengthAtMost,
  } from '../sql-helpers';
  import { shops } from './shop';

  /** カテゴリ名の上限（「ラーメン」「サイドメニュー」程度） */
  const MENU_CATEGORY_NAME_MAX_LENGTH = 50;
  /** メニュー名の上限 */
  const MENU_ITEM_NAME_MAX_LENGTH = 100;
  /** メニュー説明の上限 */
  const MENU_ITEM_DESCRIPTION_MAX_LENGTH = 500;
  /** 並び順の既定値 */
  const DEFAULT_SORT_ORDER = 0;
  /** 予約 1 枠の既定の長さ（分）。一般的なディナーの滞在時間 */
  const DEFAULT_SLOT_MINUTES = 90;
  /** 同時に受け付ける予約枠数の既定値。まずは 1 組ずつから始める */
  const DEFAULT_MAX_PARALLEL = 1;

  /**
   * メニューのカテゴリ。「ラーメン」「トッピング」など。
   *
   * `(shop_id, id)` にユニーク索引を張っているのは、`menu_items` から
   * 複合外部キーで参照するため（SQLite は参照先がユニークであることを要求する）。
   */
  export const menuCategories = sqliteTable(
    'menu_categories',
    {
      id: text('id').primaryKey(),
      shopId: text('shop_id')
        .notNull()
        .references(() => shops.id, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      sortOrder: integer('sort_order').notNull().default(DEFAULT_SORT_ORDER),
    },
    (table) => [
      index('idx_menu_categories_shop_sort').on(table.shopId, table.sortOrder),
      // menu_items の複合外部キーの参照先。索引としても意味がある
      uniqueIndex('uq_menu_categories_shop_id').on(table.shopId, table.id),

      check('ck_menu_categories_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check(
        'ck_menu_categories_name_length',
        lengthAtMost(table.name, MENU_CATEGORY_NAME_MAX_LENGTH),
      ),
      check('ck_menu_categories_sort_order', atLeast(table.sortOrder, SORT_ORDER_MIN)),
    ],
  );

  /**
   * メニュー項目。
   *
   * `category_id` は NULL 可（まだ分類していない品）。
   * ただしカテゴリを指定する場合は**同じ店舗のカテゴリ**でなければならない。
   * これを `(shop_id, category_id)` → `menu_categories(shop_id, id)` の複合外部キーで縛る。
   * 片方が NULL なら制約は成立する（SQLite の既定は MATCH SIMPLE）ので、
   * 未分類の品はそのまま登録できる。
   */
  export const menuItems = sqliteTable(
    'menu_items',
    {
      id: text('id').primaryKey(),
      shopId: text('shop_id')
        .notNull()
        .references(() => shops.id, { onDelete: 'cascade' }),
      categoryId: text('category_id'),
      name: text('name').notNull(),
      // 円。税込表示価格
      price: integer('price').notNull(),
      description: text('description'),
      r2Key: text('r2_key'),
      isRecommended: integer('is_recommended', { mode: 'boolean' }).notNull().default(false),
    },
    (table) => [
      index('idx_menu_items_shop_category').on(table.shopId, table.categoryId),
      // 店舗詳細の「おすすめ」セクション
      index('idx_menu_items_shop_recommended').on(table.shopId, table.isRecommended),

      /*
       * 他店のカテゴリにぶら下がるのを防ぐ複合外部キー。
       * カテゴリを消したらその配下の品も消す（未分類の品は category_id が NULL なので残る）。
       * 注: drizzle-kit は SQLite の外部キーに名前を出力しないため、
       *     違反時のエラーは `FOREIGN KEY constraint failed` になる。
       */
      foreignKey({
        columns: [table.shopId, table.categoryId],
        foreignColumns: [menuCategories.shopId, menuCategories.id],
      }).onDelete('cascade'),

      check('ck_menu_items_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_menu_items_name_length', lengthAtMost(table.name, MENU_ITEM_NAME_MAX_LENGTH)),
      check(
        'ck_menu_items_description_length',
        lengthAtMost(table.description, MENU_ITEM_DESCRIPTION_MAX_LENGTH),
      ),
      check('ck_menu_items_price', betweenInclusive(table.price, PRICE_YEN_MIN, PRICE_YEN_MAX)),
      check('ck_menu_items_r2_key_length', lengthAtMost(table.r2Key, R2_KEY_MAX_LENGTH)),
      check('ck_menu_items_r2_key', consistsOf(table.r2Key, R2_KEY_ALLOWED_CHARACTERS)),
      check('ck_menu_items_is_recommended', isBooleanInteger(table.isRecommended)),
    ],
  );

  /**
   * 席と予約の設定。1 店舗 1 行なので shop_id をそのまま主キーにする。
   * Phase 7 の予約枠計算（`slot_minutes` 刻みで `max_parallel` 組まで）の入力になる。
   */
  export const seatSettings = sqliteTable(
    'seat_settings',
    {
      shopId: text('shop_id')
        .primaryKey()
        .references(() => shops.id, { onDelete: 'cascade' }),
      // 総席数
      capacity: integer('capacity').notNull(),
      slotMinutes: integer('slot_minutes').notNull().default(DEFAULT_SLOT_MINUTES),
      maxParallel: integer('max_parallel').notNull().default(DEFAULT_MAX_PARALLEL),
      // 既定は false。オーナーが明示的に有効化するまで予約導線を出さない
      acceptsReservation: integer('accepts_reservation', { mode: 'boolean' })
        .notNull()
        .default(false),
    },
    (table) => [
      check(
        'ck_seat_settings_capacity',
        betweenInclusive(table.capacity, SEAT_CAPACITY_MIN, SEAT_CAPACITY_MAX),
      ),
      check(
        'ck_seat_settings_slot_minutes',
        betweenInclusive(table.slotMinutes, SLOT_MINUTES_MIN, SLOT_MINUTES_MAX),
      ),
      check(
        'ck_seat_settings_max_parallel',
        betweenInclusive(table.maxParallel, MAX_PARALLEL_MIN, MAX_PARALLEL_MAX),
      ),
      check('ck_seat_settings_accepts_reservation', isBooleanInteger(table.acceptsReservation)),
    ],
  );
  ```

- [ ] **Step 4: `schema/index.ts` に追記してマイグレーションを再生成する**

  ```ts
  export * from './auth';
  export * from './master';
  export * from './shop';
  export * from './shop-detail';
  export * from './menu';
  ```

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  rm -rf migrations/meta migrations/0000_init.sql
  node ../../node_modules/.bin/drizzle-kit generate --name=init
  grep -n 'REFERENCES `menu_categories`' migrations/0000_init.sql
  ```

  期待する出力:

  ```
  FOREIGN KEY (`shop_id`,`category_id`) REFERENCES `menu_categories`(`shop_id`,`id`) ON UPDATE no action ON DELETE cascade
  ```

- [ ] **Step 5: テストが通ることを確認する**

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/menu.test.ts
  ```

  整合 5 件 + CHECK 5 件 + seat_settings 4 件 + 連鎖削除 1 件 = 15 件が緑になる。

- [ ] **Step 6: わざと壊してテストが検知することを確認する**

  1. 複合外部キー `foreignKey({ columns: [table.shopId, table.categoryId], ... })` を消し、
     代わりに `categoryId: text('category_id').references(() => menuCategories.id)` にする
     → 「他店のカテゴリにメニューをぶら下げられない」が落ちる。
     **単純な外部キーでは他店混線を防げない**ことが実演される
  2. `uniqueIndex('uq_menu_categories_shop_id')` を消す
     → `drizzle-kit generate` もマイグレーション適用も通ってしまうが、
     最初の `INSERT INTO menu_items` で
     `foreign key mismatch - "menu_items" referencing "menu_categories"` が出て
     「自分の店のカテゴリにメニューを登録できる」が落ちる。
     **参照先のユニーク索引が無いと複合外部キーは実行時に初めて壊れる**ことが分かる
  3. `.onDelete('cascade')` を外す（既定の `no action` になる）
     → 「カテゴリを消すと、そのカテゴリのメニューも消える」が
     `FOREIGN KEY constraint failed` で落ちる
  4. `seatSettings.shopId` の `.primaryKey()` を外して `.notNull()` にする
     → 「1 店舗 1 行しか持てない」が落ちる
  5. `acceptsReservation` の `.default(false)` を `.default(true)` に変える
     → 「capacity だけ指定すれば残りは既定値になる」が落ちる。
     **予約を既定で有効にしてしまう変更**が検知される
  6. `betweenInclusive(table.price, PRICE_YEN_MIN, PRICE_YEN_MAX)` を
     `atLeast(table.price, PRICE_YEN_MIN)` に変えたうえで `PRICE_YEN_MIN` を `-1` にする
     → 「価格が負なら拒否する」が落ちる

  **6 つすべて確認したら元に戻し、再生成してテストが緑に戻ることを確認する。**

- [ ] **Step 7: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

- [ ] **Step 8: コミット**

  `feat(api): メニューと席設定のテーブルを定義` として報告する。

---

### Task 3-7: `db/schema/review.ts` — レビュー・写真・オーナー返信

設計書 §6 の `reviews` / `review_photos` / `review_replies`。

ここでの肝は 2 つ。

1. **1 ユーザー 1 店舗 1 レビュー**を `(shop_id, user_id)` のユニーク索引で保証する
2. **他店のオーナーが返信になりすます**のを複合外部キーで止める
   （`review_replies(review_id, shop_id)` → `reviews(id, shop_id)`）

**Files:**

- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/review.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/review.test.ts`
- Modify: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/index.ts`

**Interfaces:**

```ts
// Consumes
import {
  BUDGET_YEN_MAX,
  BUDGET_YEN_MIN,
  IDENTIFIER_MAX_LENGTH,
  ISO_DATE_GLOB_PATTERN,
  R2_KEY_ALLOWED_CHARACTERS,
  R2_KEY_MAX_LENGTH,
  RATING_MAX,
  RATING_MIN,
  REVIEW_BODY_MAX_LENGTH,
  REVIEW_STATUS_PUBLISHED,
  REVIEW_STATUSES,
  SORT_ORDER_MIN,
} from '../constants';
import {
  atLeast,
  betweenInclusive,
  consistsOf,
  inValues,
  lengthAtMost,
  matchesGlob,
} from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';
import { shops } from './shop';

// Produces
export const reviews; // id / shop_id / user_id / rating / body / visited_on / budget / status / created_at
export const reviewPhotos; // id / review_id / r2_key / sort_order
export const reviewReplies; // review_id(PK) / shop_id / body / created_at
```

- [ ] **Step 1: 失敗するテストを書く（`src/db/schema/review.test.ts`）— `reviews`**

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

  let local: LocalD1;

  const SHOP_ID = 'shp_review';
  const OTHER_SHOP_ID = 'shp_review_other';
  const USER_ID = 'usr_reviewer';
  const OTHER_USER_ID = 'usr_reviewer_other';

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
    for (const shopId of [SHOP_ID, OTHER_SHOP_ID]) {
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
          35.658034,
          139.701636,
          'xn76fgr',
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
        insertReview([
          'rev_ng_zero',
          OTHER_SHOP_ID,
          'usr_missing',
          0,
          'x',
          null,
          null,
          'published',
        ]),
      ).rejects.toThrow(/CHECK constraint failed: ck_reviews_rating/);
    });

    it('評価 6 は拒否する', async () => {
      await expect(
        insertReview(['rev_ng_six', OTHER_SHOP_ID, 'usr_missing', 6, 'x', null, null, 'published']),
      ).rejects.toThrow(/CHECK constraint failed: ck_reviews_rating/);
    });

    it('定義にない status は拒否する', async () => {
      await expect(
        insertReview(['rev_ng_status', OTHER_SHOP_ID, 'usr_missing', 3, 'x', null, null, 'banned']),
      ).rejects.toThrow(/CHECK constraint failed: ck_reviews_status/);
    });

    it('訪問日が YYYY-MM-DD 形式でなければ拒否する', async () => {
      await expect(
        insertReview([
          'rev_ng_date',
          OTHER_SHOP_ID,
          'usr_missing',
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
  ```

- [ ] **Step 2: 失敗するテストを書く（同じファイル）— `review_replies` と `review_photos`**

  ```ts
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
        .prepare(
          'INSERT INTO review_photos (id, review_id, r2_key, sort_order) VALUES (?, ?, ?, ?)',
        )
        .bind('rph_1', 'rev_first', 'review-photos/rev_first/a1b2.webp', 0)
        .run();
      await local.d1
        .prepare(
          'INSERT INTO review_photos (id, review_id, r2_key, sort_order) VALUES (?, ?, ?, ?)',
        )
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
  ```

- [ ] **Step 3: テストが失敗することを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/review.test.ts
  ```

  `no such table: reviews` で落ちる。

- [ ] **Step 4: `src/db/schema/review.ts` を書く**

  ```ts
  import { sql } from 'drizzle-orm';
  import {
    check,
    foreignKey,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
  } from 'drizzle-orm/sqlite-core';
  import {
    BUDGET_YEN_MAX,
    BUDGET_YEN_MIN,
    IDENTIFIER_MAX_LENGTH,
    ISO_DATE_GLOB_PATTERN,
    R2_KEY_ALLOWED_CHARACTERS,
    R2_KEY_MAX_LENGTH,
    RATING_MAX,
    RATING_MIN,
    REVIEW_BODY_MAX_LENGTH,
    REVIEW_STATUS_PUBLISHED,
    REVIEW_STATUSES,
    SORT_ORDER_MIN,
  } from '../constants';
  import {
    atLeast,
    betweenInclusive,
    consistsOf,
    inValues,
    lengthAtMost,
    matchesGlob,
  } from '../sql-helpers';
  import { CREATED_AT_DEFAULT, user } from './auth';
  import { shops } from './shop';

  /** オーナー返信の上限。レビュー本文より短くして、返信が主役にならないようにする */
  const REVIEW_REPLY_BODY_MAX_LENGTH = 1000;
  /** 並び順の既定値 */
  const DEFAULT_SORT_ORDER = 0;

  /**
   * レビュー。
   *
   * 1 ユーザーにつき 1 店舗 1 件。再訪したら編集してもらう運用にして、
   * 同一人物による評価の水増しを防ぐ（`uq_reviews_shop_user`）。
   */
  export const reviews = sqliteTable(
    'reviews',
    {
      id: text('id').primaryKey(),
      shopId: text('shop_id')
        .notNull()
        .references(() => shops.id, { onDelete: 'cascade' }),
      userId: text('user_id')
        .notNull()
        .references(() => user.id, { onDelete: 'cascade' }),
      // 1〜5 の星
      rating: integer('rating').notNull(),
      body: text('body').notNull(),
      // 訪問日（YYYY-MM-DD）。覚えていない場合があるので NULL 可
      visitedOn: text('visited_on'),
      // 実際に使った金額（円）。NULL 可
      budget: integer('budget'),
      status: text('status', { enum: REVIEW_STATUSES }).notNull().default(REVIEW_STATUS_PUBLISHED),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
    },
    (table) => [
      /*
       * 設計書 §6 のインデックス方針「reviews(shop_id, created_at DESC)」をそのまま写したもの。
       * 実測では SQLite は昇順索引を逆走査できるため desc の有無で実行計画は変わらないが、
       * 「新着順で引く列だ」という意図を残すために設計書どおり desc で定義する。
       */
      index('idx_reviews_shop_created').on(table.shopId, sql`${table.createdAt} desc`),
      // 利用者向けは status = 'published' が必ず付くので複合でも持つ
      index('idx_reviews_shop_status_created').on(
        table.shopId,
        table.status,
        sql`${table.createdAt} desc`,
      ),
      // マイページの「投稿したレビュー」
      index('idx_reviews_user_created').on(table.userId, sql`${table.createdAt} desc`),
      // 1 ユーザー 1 店舗 1 レビュー
      uniqueIndex('uq_reviews_shop_user').on(table.shopId, table.userId),
      // review_replies の複合外部キーの参照先（SQLite は参照先のユニーク索引を要求する）
      uniqueIndex('uq_reviews_id_shop').on(table.id, table.shopId),

      check('ck_reviews_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_reviews_rating', betweenInclusive(table.rating, RATING_MIN, RATING_MAX)),
      check('ck_reviews_body_length', lengthAtMost(table.body, REVIEW_BODY_MAX_LENGTH)),
      check('ck_reviews_status', inValues(table.status, REVIEW_STATUSES)),
      check('ck_reviews_visited_on_format', matchesGlob(table.visitedOn, ISO_DATE_GLOB_PATTERN)),
      check('ck_reviews_budget', betweenInclusive(table.budget, BUDGET_YEN_MIN, BUDGET_YEN_MAX)),
    ],
  );

  /** レビューに添付する写真。実体は R2。 */
  export const reviewPhotos = sqliteTable(
    'review_photos',
    {
      id: text('id').primaryKey(),
      reviewId: text('review_id')
        .notNull()
        .references(() => reviews.id, { onDelete: 'cascade' }),
      r2Key: text('r2_key').notNull(),
      sortOrder: integer('sort_order').notNull().default(DEFAULT_SORT_ORDER),
    },
    (table) => [
      index('idx_review_photos_review_sort').on(table.reviewId, table.sortOrder),
      // 同じ R2 オブジェクトを 2 行から参照させない
      uniqueIndex('uq_review_photos_r2_key').on(table.r2Key),

      check('ck_review_photos_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_review_photos_r2_key_length', lengthAtMost(table.r2Key, R2_KEY_MAX_LENGTH)),
      check('ck_review_photos_r2_key', consistsOf(table.r2Key, R2_KEY_ALLOWED_CHARACTERS)),
      check('ck_review_photos_sort_order', atLeast(table.sortOrder, SORT_ORDER_MIN)),
    ],
  );

  /**
   * オーナーからの返信。1 レビューにつき 1 件なので review_id をそのまま主キーにする。
   *
   * `shop_id` を冗長に持つのは、権限チェック（「この店のオーナーか」）を
   * reviews を JOIN せずに行えるようにするため。
   * 冗長な分だけ「他店の shop_id を入れて返信を偽装する」余地が生まれるので、
   * `(review_id, shop_id)` → `reviews(id, shop_id)` の複合外部キーで封じる。
   */
  export const reviewReplies = sqliteTable(
    'review_replies',
    {
      reviewId: text('review_id').primaryKey(),
      shopId: text('shop_id')
        .notNull()
        .references(() => shops.id, { onDelete: 'cascade' }),
      body: text('body').notNull(),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
    },
    (table) => [
      // オーナー管理画面の「返信済みレビュー一覧」
      index('idx_review_replies_shop').on(table.shopId),

      foreignKey({
        columns: [table.reviewId, table.shopId],
        foreignColumns: [reviews.id, reviews.shopId],
      }).onDelete('cascade'),

      check(
        'ck_review_replies_body_length',
        lengthAtMost(table.body, REVIEW_REPLY_BODY_MAX_LENGTH),
      ),
    ],
  );
  ```

- [ ] **Step 5: `schema/index.ts` に追記してマイグレーションを再生成する**

  ```ts
  export * from './auth';
  export * from './master';
  export * from './shop';
  export * from './shop-detail';
  export * from './menu';
  export * from './review';
  ```

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  rm -rf migrations/meta migrations/0000_init.sql
  node ../../node_modules/.bin/drizzle-kit generate --name=init
  grep -n 'idx_reviews_shop_created' migrations/0000_init.sql
  ```

  期待する出力（`desc` が索引定義に入っていること）:

  ```
  CREATE INDEX `idx_reviews_shop_created` ON `reviews` (`shop_id`,"created_at" desc);
  ```

- [ ] **Step 6: テストが通ることを確認する**

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/review.test.ts
  ```

  `reviews` 13 件 + `review_replies` 3 件 + `review_photos` 3 件 + 連鎖削除 2 件 = 21 件が緑になる。

- [ ] **Step 7: わざと壊してテストが検知することを確認する**

  1. `uniqueIndex('uq_reviews_shop_user')` を `index(...)` に変える
     → 「同じユーザーが同じ店に 2 件目を投稿できない」が落ちる。
     **評価の水増しが可能になる変更**が検知される
  2. `review_replies` の複合外部キーを消し、
     `reviewId: text('review_id').primaryKey().references(() => reviews.id)` にする
     → 「他店の shop_id で返信を偽装できない」が落ちる
  3. `index('idx_reviews_shop_created')` を丸ごと消す
     → 「店舗の新着順は索引を使う」が `SCAN reviews | USE TEMP B-TREE FOR ORDER BY` になって落ちる。
     なお `` sql`${table.createdAt} desc` `` を `table.createdAt`（昇順）に変えても
     **落ちない**。SQLite は昇順索引を逆走査できるため（F41）
  4. `betweenInclusive(table.rating, RATING_MIN, RATING_MAX)` を
     `atLeast(table.rating, RATING_MIN)` に変える
     → 「評価 6 は拒否する」が落ちる
  5. `userId` の `{ onDelete: 'cascade' }` を `{ onDelete: 'restrict' }` に変える
     → 「ユーザーを消すとそのユーザーのレビューも消える」が
     `FOREIGN KEY constraint failed` で落ちる
  6. `uniqueIndex('uq_reviews_id_shop')` を消す
     → 「レビューが付いた店のオーナーは返信できる」が
     `foreign key mismatch - "review_replies" referencing "reviews"` で落ちる

  **6 つすべて確認したら元に戻し、再生成してテストが緑に戻ることを確認する。**

- [ ] **Step 8: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

- [ ] **Step 9: コミット**

  `feat(api): レビュー・レビュー写真・オーナー返信のテーブルを定義` として報告する。

---

### Task 3-8: `db/schema/reservation.ts` と `db/schema/collection.ts` — 予約・お気に入り・リスト

設計書 §6 の `reservations` / `favorites` / `lists` / `list_items`。
`favorites` と `list_items` は**複合主キー**なので、`primaryKey({ columns: [...] })` を使う。

Phase 3 の範囲は「テーブルと制約」まで。予約枠の空き計算と二重予約防止
（Durable Object `ReservationLock`）は Phase 7 で作る。
ここでは「同じ枠に 2 件入れられない」ような制約は**張らない**
（枠の定義が `seat_settings.slot_minutes` に依存し、SQL だけでは表せないため）。

**Files:**

- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/reservation.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/collection.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/reservation.test.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/collection.test.ts`
- Modify: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/index.ts`

**Interfaces:**

```ts
// reservation.ts — Consumes
import {
  IDENTIFIER_MAX_LENGTH,
  PARTY_SIZE_MAX,
  PARTY_SIZE_MIN,
  RESERVATION_NOTE_MAX_LENGTH,
  RESERVATION_STATUS_PENDING,
  RESERVATION_STATUSES,
} from '../constants';
import { betweenInclusive, inValues, lengthAtMost } from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';
import { shops } from './shop';

// reservation.ts — Produces
export const reservations; // id / shop_id / user_id / reserved_at / party_size / note / status / created_at

// collection.ts — Consumes
import { IDENTIFIER_MAX_LENGTH, SORT_ORDER_MIN } from '../constants';
import { atLeast, consistsOf, isBooleanInteger, lengthAtMost, lengthIs } from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';
import { shops } from './shop';

// collection.ts — Produces
export const favorites; // (user_id, shop_id) 複合PK / created_at
export const lists; // id / user_id / name / description / is_public / share_token
export const listItems; // (list_id, shop_id) 複合PK / note / sort_order
export const SHARE_TOKEN_LENGTH: number;
```

- [ ] **Step 1: 失敗するテストを書く（`src/db/schema/reservation.test.ts`）**

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

  let local: LocalD1;

  const SHOP_ID = 'shp_reserve';
  const USER_ID = 'usr_reserve';

  /** 2026-09-16 19:00 JST 相当のエポックミリ秒。テストの基準時刻 */
  const RESERVED_AT_MS = 1_789_500_000_000;
  /** 1 日のミリ秒 */
  const ONE_DAY_MS = 86_400_000;

  async function insertReservation(
    id: string,
    partySize: number,
    reservedAtMs = RESERVED_AT_MS,
    status: string | null = null,
  ): Promise<void> {
    if (status === null) {
      await local.d1
        .prepare(
          'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(id, SHOP_ID, USER_ID, reservedAtMs, partySize)
        .run();
      return;
    }
    await local.d1
      .prepare(
        'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(id, SHOP_ID, USER_ID, reservedAtMs, partySize, status)
      .run();
  }

  beforeAll(async () => {
    local = await createMigratedD1();
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind(USER_ID, '予約者', 'reserve@example.com')
      .run();
    await local.d1
      .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
      .bind('gnr_reserve', 'ラーメン', 'ramen-reserve')
      .run();
    await local.d1
      .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
      .bind('area_reserve', '渋谷', '東京都')
      .run();
    await local.d1
      .prepare(
        'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        SHOP_ID,
        '予約テスト店',
        'gnr_reserve',
        'area_reserve',
        '東京都渋谷区',
        35.658034,
        139.701636,
        'xn76fgr',
      )
      .run();
  });

  afterAll(async () => {
    await local.dispose();
  });

  describe('reservations', () => {
    it('予約を保存でき、status は pending から始まる', async () => {
      await local.d1
        .prepare(
          'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, note) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind('rsv_first', SHOP_ID, USER_ID, RESERVED_AT_MS, 2, '窓際希望')
        .run();

      const row = await local.d1
        .prepare('SELECT status, created_at FROM reservations WHERE id = ?')
        .bind('rsv_first')
        .first<{ status: string; created_at: number }>();

      // オーナーが承認するまでは pending。承認前に席は確保しない
      expect(row?.status).toBe('pending');
      expect(row?.created_at).toBeGreaterThan(0);
    });

    it('同じユーザーが同じ店に複数の予約を持てる（日時が違えば別の予約）', async () => {
      await insertReservation('rsv_second', 4, RESERVED_AT_MS + ONE_DAY_MS);
    });

    it('人数 1 と 20 は受け付ける（境界値）', async () => {
      await insertReservation('rsv_min', 1, RESERVED_AT_MS + ONE_DAY_MS * 2);
      await insertReservation('rsv_max', 20, RESERVED_AT_MS + ONE_DAY_MS * 3);
    });

    it('人数 0 は拒否する', async () => {
      await expect(insertReservation('rsv_ng_zero', 0)).rejects.toThrow(
        /CHECK constraint failed: ck_reservations_party_size/,
      );
    });

    it('人数 21 は拒否する（団体は電話で受ける運用）', async () => {
      await expect(insertReservation('rsv_ng_many', 21)).rejects.toThrow(
        /CHECK constraint failed: ck_reservations_party_size/,
      );
    });

    it('定義にない status は拒否する', async () => {
      await expect(insertReservation('rsv_ng_status', 2, RESERVED_AT_MS, 'done')).rejects.toThrow(
        /CHECK constraint failed: ck_reservations_status/,
      );
    });

    it('6 つの status すべてを保存できる', async () => {
      const statuses = [
        'pending',
        'confirmed',
        'rejected',
        'cancelled',
        'completed',
        'no_show',
      ] as const;
      for (const [index, status] of statuses.entries()) {
        await insertReservation(
          `rsv_status_${status}`,
          2,
          RESERVED_AT_MS + ONE_DAY_MS * (10 + index),
          status,
        );
      }

      const row = await local.d1
        .prepare("SELECT count(*) AS stored FROM reservations WHERE id LIKE 'rsv_status_%'")
        .first<{ stored: number }>();

      expect(row?.stored).toBe(statuses.length);
    });

    it('店舗の予約カレンダー（日時範囲）は索引を使う', async () => {
      const plan = await local.d1
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM reservations WHERE shop_id = 'shp_reserve' AND reserved_at BETWEEN ${String(RESERVED_AT_MS)} AND ${String(RESERVED_AT_MS + ONE_DAY_MS)}`,
        )
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      // 設計書 §6 のインデックス方針「reservations(shop_id, reserved_at)」
      expect(detail).toContain('idx_reservations_shop_reserved');
      expect(detail).not.toContain('SCAN reservations');
    });

    it('確定済みだけを日時範囲で引く場合も索引を使う', async () => {
      const plan = await local.d1
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM reservations WHERE shop_id = 'shp_reserve' AND status = 'confirmed' AND reserved_at BETWEEN ${String(RESERVED_AT_MS)} AND ${String(RESERVED_AT_MS + ONE_DAY_MS)}`,
        )
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      // Phase 7 の空席計算はこの形。席を埋めている予約だけを数える
      expect(detail).toContain('idx_reservations_shop_status_reserved');
      expect(detail).not.toContain('SCAN reservations');
    });

    it('店舗を消すと予約も消える', async () => {
      await local.d1.prepare('DELETE FROM shops WHERE id = ?').bind(SHOP_ID).run();

      const row = await local.d1
        .prepare('SELECT count(*) AS remaining FROM reservations WHERE shop_id = ?')
        .bind(SHOP_ID)
        .first<{ remaining: number }>();

      expect(row?.remaining).toBe(0);
    });
  });
  ```

- [ ] **Step 2: テストが失敗することを確認し、`src/db/schema/reservation.ts` を書く**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/reservation.test.ts
  ```

  `no such table: reservations` を確認してから実装する。

  ```ts
  import { sql } from 'drizzle-orm';
  import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
  import {
    IDENTIFIER_MAX_LENGTH,
    PARTY_SIZE_MAX,
    PARTY_SIZE_MIN,
    RESERVATION_NOTE_MAX_LENGTH,
    RESERVATION_STATUS_PENDING,
    RESERVATION_STATUSES,
  } from '../constants';
  import { betweenInclusive, inValues, lengthAtMost } from '../sql-helpers';
  import { CREATED_AT_DEFAULT, user } from './auth';
  import { shops } from './shop';

  /**
   * 予約。
   *
   * 「同じ枠に何組まで入れるか」は `seat_settings.slot_minutes` と `max_parallel` に依存し、
   * SQL の制約では表せない。二重予約の防止は Durable Object `ReservationLock`（Phase 7）の責務とし、
   * ここでは値の妥当性だけを縛る。
   */
  export const reservations = sqliteTable(
    'reservations',
    {
      id: text('id').primaryKey(),
      shopId: text('shop_id')
        .notNull()
        .references(() => shops.id, { onDelete: 'cascade' }),
      userId: text('user_id')
        .notNull()
        .references(() => user.id, { onDelete: 'cascade' }),
      // 来店日時。エポックミリ秒で持ち、表示のタイムゾーン変換はアプリ側で行う
      reservedAt: integer('reserved_at', { mode: 'timestamp_ms' }).notNull(),
      partySize: integer('party_size').notNull(),
      note: text('note'),
      status: text('status', { enum: RESERVATION_STATUSES })
        .notNull()
        .default(RESERVATION_STATUS_PENDING),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
    },
    (table) => [
      // 設計書 §6 のインデックス方針「reservations(shop_id, reserved_at)」。オーナーの予約カレンダー
      index('idx_reservations_shop_reserved').on(table.shopId, table.reservedAt),
      // Phase 7 の空席計算「この時間帯で席を埋めている予約」を引く形
      index('idx_reservations_shop_status_reserved').on(
        table.shopId,
        table.status,
        table.reservedAt,
      ),
      // マイページの「予約履歴」。直近が先頭に来るよう降順で定義する
      index('idx_reservations_user_reserved').on(table.userId, sql`${table.reservedAt} desc`),

      check('ck_reservations_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      // 21 人以上の団体は電話で受ける運用にして、席計算の複雑さを持ち込まない
      check(
        'ck_reservations_party_size',
        betweenInclusive(table.partySize, PARTY_SIZE_MIN, PARTY_SIZE_MAX),
      ),
      check('ck_reservations_status', inValues(table.status, RESERVATION_STATUSES)),
      check('ck_reservations_note_length', lengthAtMost(table.note, RESERVATION_NOTE_MAX_LENGTH)),
    ],
  );
  ```

- [ ] **Step 3: 失敗するテストを書く（`src/db/schema/collection.test.ts`）**

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

  let local: LocalD1;

  const USER_ID = 'usr_collector';
  const OTHER_USER_ID = 'usr_collector_other';
  const SHOP_ID = 'shp_collect';
  const OTHER_SHOP_ID = 'shp_collect_other';
  const LIST_ID = 'lst_wishlist';

  /** 32 文字の共有トークン。URL に載せるので小文字英数字のみ */
  const VALID_SHARE_TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

  beforeAll(async () => {
    local = await createMigratedD1();
    for (const [userId, email] of [
      [USER_ID, 'collector@example.com'],
      [OTHER_USER_ID, 'collector2@example.com'],
    ] as const) {
      await local.d1
        .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
        .bind(userId, 'コレクター', email)
        .run();
    }
    await local.d1
      .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
      .bind('gnr_collect', 'ラーメン', 'ramen-collect')
      .run();
    await local.d1
      .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
      .bind('area_collect', '渋谷', '東京都')
      .run();
    for (const shopId of [SHOP_ID, OTHER_SHOP_ID]) {
      await local.d1
        .prepare(
          'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          shopId,
          'コレクションテスト店',
          'gnr_collect',
          'area_collect',
          '東京都渋谷区',
          35.658034,
          139.701636,
          'xn76fgr',
        )
        .run();
    }
  });

  afterAll(async () => {
    await local.dispose();
  });

  describe('favorites', () => {
    it('お気に入りに登録でき、created_at が自動で入る', async () => {
      await local.d1
        .prepare('INSERT INTO favorites (user_id, shop_id) VALUES (?, ?)')
        .bind(USER_ID, SHOP_ID)
        .run();

      const row = await local.d1
        .prepare('SELECT created_at FROM favorites WHERE user_id = ? AND shop_id = ?')
        .bind(USER_ID, SHOP_ID)
        .first<{ created_at: number }>();

      expect(row?.created_at).toBeGreaterThan(0);
    });

    it('同じユーザーが同じ店を二重登録できない（複合主キー）', async () => {
      await expect(
        local.d1
          .prepare('INSERT INTO favorites (user_id, shop_id) VALUES (?, ?)')
          .bind(USER_ID, SHOP_ID)
          .run(),
      ).rejects.toThrow(/UNIQUE constraint failed: favorites\.user_id, favorites\.shop_id/);
    });

    it('別の店なら登録できる', async () => {
      await local.d1
        .prepare('INSERT INTO favorites (user_id, shop_id) VALUES (?, ?)')
        .bind(USER_ID, OTHER_SHOP_ID)
        .run();
    });

    it('別のユーザーなら同じ店を登録できる', async () => {
      await local.d1
        .prepare('INSERT INTO favorites (user_id, shop_id) VALUES (?, ?)')
        .bind(OTHER_USER_ID, SHOP_ID)
        .run();
    });

    it('お気に入り一覧（新着順）は索引を使う', async () => {
      const plan = await local.d1
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM favorites WHERE user_id = 'usr_collector' ORDER BY created_at DESC",
        )
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).toContain('idx_favorites_user_created');
      expect(detail).not.toContain('USE TEMP B-TREE');
    });
  });

  describe('lists', () => {
    it('非公開リストは share_token が NULL でよい', async () => {
      await local.d1
        .prepare('INSERT INTO lists (id, user_id, name, description) VALUES (?, ?, ?, ?)')
        .bind(LIST_ID, USER_ID, '行きたい店', '週末に回る候補')
        .run();

      const row = await local.d1
        .prepare('SELECT is_public, share_token FROM lists WHERE id = ?')
        .bind(LIST_ID)
        .first<{ is_public: number; share_token: string | null }>();

      // 既定は非公開。共有したくなったら token を発行する
      expect(row?.is_public).toBe(0);
      expect(row?.share_token).toBeNull();
    });

    it('share_token が NULL のリストは何件でも作れる（SQLite のユニーク索引は NULL を重複とみなさない）', async () => {
      await local.d1
        .prepare('INSERT INTO lists (id, user_id, name) VALUES (?, ?, ?)')
        .bind('lst_second', USER_ID, 'デート候補')
        .run();
    });

    it('共有トークン付きの公開リストを作れる', async () => {
      await local.d1
        .prepare(
          'INSERT INTO lists (id, user_id, name, is_public, share_token) VALUES (?, ?, ?, ?, ?)',
        )
        .bind('lst_public', USER_ID, '公開リスト', 1, VALID_SHARE_TOKEN)
        .run();
    });

    it('同じ共有トークンを 2 つのリストで使えない', async () => {
      await expect(
        local.d1
          .prepare(
            'INSERT INTO lists (id, user_id, name, is_public, share_token) VALUES (?, ?, ?, ?, ?)',
          )
          .bind('lst_dup', OTHER_USER_ID, '重複', 1, VALID_SHARE_TOKEN)
          .run(),
      ).rejects.toThrow(/UNIQUE constraint failed: lists\.share_token/);
    });

    it('共有トークンが 32 文字でなければ拒否する', async () => {
      await expect(
        local.d1
          .prepare('INSERT INTO lists (id, user_id, name, share_token) VALUES (?, ?, ?, ?)')
          .bind('lst_short', OTHER_USER_ID, '短い', VALID_SHARE_TOKEN.slice(0, -1))
          .run(),
      ).rejects.toThrow(/CHECK constraint failed: ck_lists_share_token_length/);
    });

    it('共有トークンに大文字が混ざったら拒否する', async () => {
      await expect(
        local.d1
          .prepare('INSERT INTO lists (id, user_id, name, share_token) VALUES (?, ?, ?, ?)')
          .bind('lst_upper', OTHER_USER_ID, '大文字', VALID_SHARE_TOKEN.toUpperCase())
          .run(),
      ).rejects.toThrow(/CHECK constraint failed: ck_lists_share_token_alphabet/);
    });
  });

  describe('list_items', () => {
    it('リストに店を追加できる', async () => {
      await local.d1
        .prepare('INSERT INTO list_items (list_id, shop_id, note, sort_order) VALUES (?, ?, ?, ?)')
        .bind(LIST_ID, SHOP_ID, '昼に行く', 0)
        .run();
    });

    it('同じリストに同じ店を二重追加できない（複合主キー）', async () => {
      await expect(
        local.d1
          .prepare(
            'INSERT INTO list_items (list_id, shop_id, note, sort_order) VALUES (?, ?, ?, ?)',
          )
          .bind(LIST_ID, SHOP_ID, '重複', 1)
          .run(),
      ).rejects.toThrow(/UNIQUE constraint failed: list_items\.list_id, list_items\.shop_id/);
    });

    it('sort_order が負なら拒否する', async () => {
      await expect(
        local.d1
          .prepare(
            'INSERT INTO list_items (list_id, shop_id, note, sort_order) VALUES (?, ?, ?, ?)',
          )
          .bind(LIST_ID, OTHER_SHOP_ID, null, -1)
          .run(),
      ).rejects.toThrow(/CHECK constraint failed: ck_list_items_sort_order/);
    });

    it('リスト内の並び順は索引を使う', async () => {
      const plan = await local.d1
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM list_items WHERE list_id = 'lst_wishlist' ORDER BY sort_order",
        )
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).toContain('idx_list_items_list_sort');
    });
  });

  describe('削除の連鎖', () => {
    it('リストを消すとリスト項目も消える', async () => {
      await local.d1.prepare('DELETE FROM lists WHERE id = ?').bind(LIST_ID).run();

      const row = await local.d1
        .prepare('SELECT count(*) AS remaining FROM list_items WHERE list_id = ?')
        .bind(LIST_ID)
        .first<{ remaining: number }>();

      expect(row?.remaining).toBe(0);
    });

    it('ユーザーを消すとお気に入りとリストも消える', async () => {
      await local.d1.prepare('DELETE FROM user WHERE id = ?').bind(USER_ID).run();

      for (const tableName of ['favorites', 'lists'] as const) {
        const row = await local.d1
          .prepare(`SELECT count(*) AS remaining FROM ${tableName} WHERE user_id = ?`)
          .bind(USER_ID)
          .first<{ remaining: number }>();

        expect(row?.remaining).toBe(0);
      }
    });
  });
  ```

- [ ] **Step 4: `src/db/schema/collection.ts` を書く**

  ```ts
  import { sql } from 'drizzle-orm';
  import {
    check,
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
    uniqueIndex,
  } from 'drizzle-orm/sqlite-core';
  import { IDENTIFIER_MAX_LENGTH, SORT_ORDER_MIN } from '../constants';
  import { atLeast, consistsOf, isBooleanInteger, lengthAtMost, lengthIs } from '../sql-helpers';
  import { CREATED_AT_DEFAULT, user } from './auth';
  import { shops } from './shop';

  /**
   * 共有リンクのトークン長。
   * 小文字英数字 36 種 × 32 文字 ≒ 165 ビットで、総当たりで当てられる長さではない。
   */
  export const SHARE_TOKEN_LENGTH = 32;
  /** 共有トークンに使える文字。URL にそのまま載るので小文字英数字のみ */
  const SHARE_TOKEN_ALLOWED_CHARACTERS = 'a-z0-9';
  /** リスト名の上限 */
  const LIST_NAME_MAX_LENGTH = 100;
  /** リスト説明の上限 */
  const LIST_DESCRIPTION_MAX_LENGTH = 1000;
  /** リスト項目のメモの上限 */
  const LIST_ITEM_NOTE_MAX_LENGTH = 500;
  /** 並び順の既定値 */
  const DEFAULT_SORT_ORDER = 0;

  /**
   * お気に入り。ユーザーと店舗の組み合わせがそのまま主キー。
   * 代理キーを置かないので「二重登録できない」が主キーだけで保証される。
   */
  export const favorites = sqliteTable(
    'favorites',
    {
      userId: text('user_id')
        .notNull()
        .references(() => user.id, { onDelete: 'cascade' }),
      shopId: text('shop_id')
        .notNull()
        .references(() => shops.id, { onDelete: 'cascade' }),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
    },
    (table) => [
      primaryKey({ columns: [table.userId, table.shopId] }),
      // マイページの「お気に入り」を新着順で出す
      index('idx_favorites_user_created').on(table.userId, sql`${table.createdAt} desc`),
      // 店舗側から「何人がお気に入りにしているか」を数える
      index('idx_favorites_shop').on(table.shopId),
    ],
  );

  /**
   * ユーザーが作る店舗リスト（「行きたい店」など）。
   *
   * `share_token` は共有リンク用の秘密の文字列。NULL なら未共有。
   * SQLite のユニーク索引は NULL を重複とみなさないので、未共有のリストは何件でも作れる。
   */
  export const lists = sqliteTable(
    'lists',
    {
      id: text('id').primaryKey(),
      userId: text('user_id')
        .notNull()
        .references(() => user.id, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      description: text('description'),
      // 既定は非公開。共有は明示的な操作に限る
      isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
      shareToken: text('share_token'),
    },
    (table) => [
      index('idx_lists_user').on(table.userId),
      // 共有リンクからの引き当てに使う。同じトークンが 2 つあると別人のリストが見えてしまう
      uniqueIndex('uq_lists_share_token').on(table.shareToken),

      check('ck_lists_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_lists_name_length', lengthAtMost(table.name, LIST_NAME_MAX_LENGTH)),
      check(
        'ck_lists_description_length',
        lengthAtMost(table.description, LIST_DESCRIPTION_MAX_LENGTH),
      ),
      check('ck_lists_is_public', isBooleanInteger(table.isPublic)),
      // 短いトークンを発行してしまう実装ミスを DB で止める
      check('ck_lists_share_token_length', lengthIs(table.shareToken, SHARE_TOKEN_LENGTH)),
      check(
        'ck_lists_share_token_alphabet',
        consistsOf(table.shareToken, SHARE_TOKEN_ALLOWED_CHARACTERS),
      ),
    ],
  );

  /** リストに入っている店舗。リストと店舗の組み合わせがそのまま主キー。 */
  export const listItems = sqliteTable(
    'list_items',
    {
      listId: text('list_id')
        .notNull()
        .references(() => lists.id, { onDelete: 'cascade' }),
      shopId: text('shop_id')
        .notNull()
        .references(() => shops.id, { onDelete: 'cascade' }),
      note: text('note'),
      sortOrder: integer('sort_order').notNull().default(DEFAULT_SORT_ORDER),
    },
    (table) => [
      primaryKey({ columns: [table.listId, table.shopId] }),
      index('idx_list_items_list_sort').on(table.listId, table.sortOrder),

      check('ck_list_items_note_length', lengthAtMost(table.note, LIST_ITEM_NOTE_MAX_LENGTH)),
      check('ck_list_items_sort_order', atLeast(table.sortOrder, SORT_ORDER_MIN)),
    ],
  );
  ```

- [ ] **Step 5: `schema/index.ts` に追記してマイグレーションを再生成する**

  ```ts
  export * from './auth';
  export * from './master';
  export * from './shop';
  export * from './shop-detail';
  export * from './menu';
  export * from './review';
  export * from './reservation';
  export * from './collection';
  ```

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  rm -rf migrations/meta migrations/0000_init.sql
  node ../../node_modules/.bin/drizzle-kit generate --name=init
  grep -n 'PRIMARY KEY(' migrations/0000_init.sql
  ```

  期待する出力:

  ```
  PRIMARY KEY(`user_id`, `shop_id`)
  PRIMARY KEY(`list_id`, `shop_id`)
  ```

- [ ] **Step 6: テストが通ることを確認する**

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/reservation.test.ts src/db/schema/collection.test.ts
  ```

  `reservation.test.ts` 9 件 + `collection.test.ts` 15 件 = 24 件が緑になる。

- [ ] **Step 7: わざと壊してテストが検知することを確認する**

  1. `favorites` の `primaryKey({ columns: [table.userId, table.shopId] })` を消す
     → 「同じユーザーが同じ店を二重登録できない（複合主キー）」が落ちる
  2. `list_items` の複合主キーの列順を `[table.shopId, table.listId]` に入れ替える
     → 二重登録のテストは通るが、エラーメッセージが
     `UNIQUE constraint failed: list_items.shop_id, list_items.list_id` に変わって落ちる。
     **主キーの列順がエラー文言に出る**ことが分かる
  3. `uniqueIndex('uq_lists_share_token')` を `index(...)` に変える
     → 「同じ共有トークンを 2 つのリストで使えない」が落ちる。
     **他人のリストが共有リンクで見えてしまう変更**が検知される
  4. `lengthIs(table.shareToken, SHARE_TOKEN_LENGTH)` を
     `lengthAtMost(table.shareToken, SHARE_TOKEN_LENGTH)` に変える
     → 「共有トークンが 32 文字でなければ拒否する」が落ちる
  5. `betweenInclusive(table.partySize, PARTY_SIZE_MIN, PARTY_SIZE_MAX)` を
     `atLeast(table.partySize, PARTY_SIZE_MIN)` に変える
     → 「人数 21 は拒否する」が落ちる
  6. `index('idx_reservations_shop_status_reserved')` を消す
     → 「確定済みだけを日時範囲で引く場合も索引を使う」が落ちる
     （`idx_reservations_shop_reserved` に流れるので `SCAN` にはならないが、
     索引名の検証で落ちる）

  **6 つすべて確認したら元に戻し、再生成してテストが緑に戻ることを確認する。**

- [ ] **Step 8: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

- [ ] **Step 9: コミット**

  `feat(api): 予約・お気に入り・リストのテーブルを定義` として報告する。

---

### Task 3-9: `db/schema/admin.ts` — 通報・店舗申請・通知・監査ログ

設計書 §6 の `reports` / `shop_applications` / `notifications` / `audit_logs`。
このファイルは他のスキーマファイルから import されない**終端**なので、
`shops` も `reviews` も自由に参照してよい（依存グラフの最下段）。

**この 4 テーブルに共通する設計判断**

| 論点                                         | 判断                                                    | 理由                                                                         |
| -------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `reports.target_id` の外部キー               | **張らない**                                            | 対象が店舗・レビュー・ユーザーと可変。SQLite に多相外部キーはない            |
| 通報者・対応者・監査ログの実行者を消したとき | `ON DELETE set null`                                    | 退会しても「通報があった事実」「誰かが処分した事実」は残す必要がある         |
| JSON 列（`documents` / `data` / `diff`）     | `text(..., { mode: 'json' })` + `json_valid()` の CHECK | D1 は JSON1 拡張を持つ。壊れた JSON が入ると `json_extract` が実行時に落ちる |
| 監査ログの `action`                          | 小文字英数字 + `_` + `.` のみ                           | `shop.suspend` のような固定語彙。表記ゆれで集計できなくなるのを DB で止める  |

**`ON DELETE set null` と CHECK 制約の衝突（実測で見つけた罠）**

`reports` に「対応者と対応日時はセットで入る」つまり
`(handled_by IS NULL) = (handled_at IS NULL)` という CHECK を置くと、
**対応した管理者アカウントを削除した瞬間に DELETE が失敗する**。
`ON DELETE set null` は親行の削除時に子行を UPDATE するが、
その UPDATE にも CHECK 制約が効くためだ（`handled_by` だけが NULL になり等式が崩れる）。

そこで制約を「双方向の等式」から「片側の含意」2 本に分ける。

- `handled_by IS NULL OR handled_at IS NOT NULL` — 対応者を書くなら日時も書く
- `status IN ('open', 'in_review') OR handled_at IS NOT NULL` — 決着済みなら日時が要る

こうすると「対応者アカウントは消えたが、いつ決着したかは残っている」状態を表現できる。
これは実測で確認した（詳細は F45）。

**Files:**

- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/admin.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/admin.test.ts`
- Modify: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/index.ts`

**Interfaces:**

```ts
// Consumes
import {
  APPLICATION_STATUS_PENDING,
  APPLICATION_STATUSES,
  IDENTIFIER_MAX_LENGTH,
  NOTIFICATION_TYPES,
  REPORT_STATUS_OPEN,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
} from '../constants';
import { consistsOf, inValues, lengthAtMost } from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';
import { shops } from './shop';

// Produces
export type ApplicationDocument = { readonly kind: string; readonly r2Key: string };
export type AuditLogDiff = Readonly<Record<string, readonly [unknown, unknown]>>;
export const reports;
export const shopApplications;
export const notifications;
export const auditLogs;
```

- [ ] **Step 1: 失敗するテストを書く（`src/db/schema/admin.test.ts` 前半 — reports）**

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

  let local: LocalD1;

  const REPORTER_ID = 'usr_reporter';
  const OTHER_REPORTER_ID = 'usr_reporter_other';
  const ADMIN_ID = 'usr_admin';
  const SHOP_ID = 'shp_reported';

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
    await local.d1
      .prepare(
        'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        SHOP_ID,
        '通報テスト店',
        'gnr_admin',
        'area_admin',
        '東京都渋谷区',
        35.658034,
        139.701636,
        'xn76fgr',
      )
      .run();
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
  ```

- [ ] **Step 2: テストの後半を書く（shop_applications / notifications / audit_logs）**

  同じ `admin.test.ts` に続けて書く。

  ```ts
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
          .bind('app_broken', REPORTER_ID, SHOP_ID, '{oops')
          .run(),
      ).rejects.toThrow(/CHECK constraint failed: ck_shop_applications_documents_json/);
    });

    it('documents が配列でなければ拒否する', async () => {
      await expect(
        local.d1
          .prepare(
            'INSERT INTO shop_applications (id, applicant_id, shop_id, documents) VALUES (?, ?, ?, ?)',
          )
          .bind('app_object', REPORTER_ID, SHOP_ID, '{"kind":"license"}')
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
        .prepare(
          'INSERT INTO notifications (id, user_id, type, title, body) VALUES (?, ?, ?, ?, ?)',
        )
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
          "EXPLAIN QUERY PLAN SELECT * FROM notifications WHERE user_id = 'usr_reporter' AND read_at IS NULL ORDER BY created_at DESC",
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
          "EXPLAIN QUERY PLAN SELECT * FROM notifications WHERE user_id = 'usr_reporter' ORDER BY created_at DESC",
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
      // 匿名 2 件 + 退会した通報者の 1 件
      expect(reportRow?.anonymous).toBe(3);
    });
  });
  ```

- [ ] **Step 3: テストが失敗することを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/admin.test.ts
  ```

  `no such table: reports` を確認する。

- [ ] **Step 4: `src/db/schema/admin.ts` の前半（reports / shop_applications）を書く**

  ```ts
  import { sql } from 'drizzle-orm';
  import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
  import {
    APPLICATION_STATUS_PENDING,
    APPLICATION_STATUSES,
    IDENTIFIER_MAX_LENGTH,
    NOTIFICATION_TYPES,
    REPORT_STATUS_OPEN,
    REPORT_STATUSES,
    REPORT_TARGET_TYPES,
  } from '../constants';
  import { consistsOf, inValues, lengthAtMost } from '../sql-helpers';
  import { CREATED_AT_DEFAULT, user } from './auth';
  import { shops } from './shop';

  /** 通報理由（定型文）の上限 */
  const REPORT_REASON_MAX_LENGTH = 100;
  /** 通報の自由記述の上限 */
  const REPORT_DETAIL_MAX_LENGTH = 1000;
  /** 差し戻し理由の上限 */
  const REVIEW_NOTE_MAX_LENGTH = 1000;
  /** 通知タイトルの上限。プッシュ通知の表示幅に合わせる */
  const NOTIFICATION_TITLE_MAX_LENGTH = 100;
  /** 通知本文の上限 */
  const NOTIFICATION_BODY_MAX_LENGTH = 500;
  /** 監査ログの `action` に使える文字。`shop.suspend` のようなドット区切りの固定語彙 */
  const AUDIT_ACTION_ALLOWED_CHARACTERS = 'a-z0-9_.';
  /** 監査ログの対象種別の上限 */
  const AUDIT_TARGET_TYPE_MAX_LENGTH = 32;

  /** 店舗申請に添付する書類 1 件。実体は R2 に置き、ここにはキーだけ持つ */
  export type ApplicationDocument = {
    /** 書類の種類（営業許可証など） */
    readonly kind: string;
    /** R2 のオブジェクトキー */
    readonly r2Key: string;
  };

  /** 監査ログの差分。列名 → [変更前, 変更後] */
  export type AuditLogDiff = Readonly<Record<string, readonly [unknown, unknown]>>;

  /**
   * 通報。
   *
   * `target_id` には店舗 ID / レビュー ID / ユーザー ID のいずれかが入る。
   * SQLite に多相外部キーはないので参照整合性は張らず、`target_type` との組で解決する。
   * 対象が消えた通報は「対象なし」として管理画面に出す（Phase 10）。
   */
  export const reports = sqliteTable(
    'reports',
    {
      id: text('id').primaryKey(),
      // 退会しても「通報があった事実」は消さない
      reporterId: text('reporter_id').references(() => user.id, { onDelete: 'set null' }),
      targetType: text('target_type', { enum: REPORT_TARGET_TYPES }).notNull(),
      targetId: text('target_id').notNull(),
      reason: text('reason').notNull(),
      detail: text('detail'),
      status: text('status', { enum: REPORT_STATUSES }).notNull().default(REPORT_STATUS_OPEN),
      handledBy: text('handled_by').references(() => user.id, { onDelete: 'set null' }),
      handledAt: integer('handled_at', { mode: 'timestamp_ms' }),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
    },
    (table) => [
      // 管理画面の未対応キュー（設計書 5.1 `(admin)/(tabs)/reports.tsx`）
      index('idx_reports_status_created').on(table.status, sql`${table.createdAt} desc`),
      // 「この店に何件の通報が来ているか」を対象側から引く
      index('idx_reports_target').on(table.targetType, table.targetId),
      index('idx_reports_reporter').on(table.reporterId),
      // 同じ人が同じ対象を連投できないようにする。
      // reporter_id が NULL（匿名通報）は SQLite のユニーク索引では重複扱いにならず、何件でも入る
      uniqueIndex('uq_reports_reporter_target').on(
        table.reporterId,
        table.targetType,
        table.targetId,
      ),

      check('ck_reports_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_reports_target_type', inValues(table.targetType, REPORT_TARGET_TYPES)),
      check('ck_reports_status', inValues(table.status, REPORT_STATUSES)),
      check('ck_reports_reason_length', lengthAtMost(table.reason, REPORT_REASON_MAX_LENGTH)),
      check('ck_reports_detail_length', lengthAtMost(table.detail, REPORT_DETAIL_MAX_LENGTH)),
      // 「対応者を書くなら日時も書く」。逆向き（日時だけある）は許す。
      // ON DELETE set null で handled_by だけが消えた行を残すため、双方向の等式にはしない
      check(
        'ck_reports_handler_requires_time',
        sql`${table.handledBy} IS NULL OR ${table.handledAt} IS NOT NULL`,
      ),
      // 決着済みなら必ず対応日時が入っている
      check(
        'ck_reports_closed_requires_time',
        sql`${table.status} IN ('open', 'in_review') OR ${table.handledAt} IS NOT NULL`,
      ),
    ],
  );

  /**
   * 店舗オーナー申請。
   *
   * `shop_id` は NOT NULL なので、申請行より先に店舗行が要る。したがって店舗は
   * 承認時ではなく**申請時**に下書き（`status = draft`・`owner_id` は NULL）として作る
   * （Phase 9 Task 9-25）。`shops.owner_id` が nullable なのはこのため。
   * 承認されると申請者のロールが `user` → `owner` に上がる（Phase 9 Task 9-5）。
   */
  export const shopApplications = sqliteTable(
    'shop_applications',
    {
      id: text('id').primaryKey(),
      applicantId: text('applicant_id')
        .notNull()
        .references(() => user.id, { onDelete: 'cascade' }),
      shopId: text('shop_id')
        .notNull()
        .references(() => shops.id, { onDelete: 'cascade' }),
      // 添付書類の配列。実体は R2、ここはキーの一覧
      documents: text('documents', { mode: 'json' })
        .$type<readonly ApplicationDocument[]>()
        .notNull()
        .default([]),
      status: text('status', { enum: APPLICATION_STATUSES })
        .notNull()
        .default(APPLICATION_STATUS_PENDING),
      reviewedBy: text('reviewed_by').references(() => user.id, { onDelete: 'set null' }),
      reviewNote: text('review_note'),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
    },
    (table) => [
      // 管理画面の審査待ちキュー
      index('idx_shop_applications_status_created').on(table.status, sql`${table.createdAt} desc`),
      index('idx_shop_applications_applicant').on(table.applicantId),
      // 同じ店に審査待ちが 2 件並ぶと、2 人のオーナーを承認してしまう事故が起きる。
      // 決着済み（approved / rejected / returned）は対象外なので再申請はできる
      uniqueIndex('uq_shop_applications_shop_pending')
        .on(table.shopId)
        .where(sql`${table.status} = 'pending'`),

      check('ck_shop_applications_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_shop_applications_status', inValues(table.status, APPLICATION_STATUSES)),
      // 壊れた JSON が入ると管理画面の json_extract が実行時に落ちる。書き込み時に止める
      check(
        'ck_shop_applications_documents_json',
        sql`json_valid(${table.documents}) AND json_type(${table.documents}) = 'array'`,
      ),
      check(
        'ck_shop_applications_review_note_length',
        lengthAtMost(table.reviewNote, REVIEW_NOTE_MAX_LENGTH),
      ),
    ],
  );
  ```

- [ ] **Step 5: `src/db/schema/admin.ts` の後半（notifications / audit_logs）を書く**

  同じファイルに続けて書く。

  ```ts
  /**
   * アプリ内通知。
   *
   * `data` には遷移先を決めるための識別子だけを入れる（例: `{"reservationId":"rsv_..."}`）。
   * 本文を再構成できるだけの情報を入れると、仕様変更のたびに過去の通知が壊れる。
   */
  export const notifications = sqliteTable(
    'notifications',
    {
      id: text('id').primaryKey(),
      userId: text('user_id')
        .notNull()
        .references(() => user.id, { onDelete: 'cascade' }),
      type: text('type', { enum: NOTIFICATION_TYPES }).notNull(),
      title: text('title').notNull(),
      body: text('body').notNull(),
      data: text('data', { mode: 'json' }).$type<Readonly<Record<string, string>>>(),
      // 未読なら NULL。既読の時刻を持つことで「いつ読んだか」も分かる
      readAt: integer('read_at', { mode: 'timestamp_ms' }),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
    },
    (table) => [
      index('idx_notifications_user_created').on(table.userId, sql`${table.createdAt} desc`),
      // 未読バッジはアプリ起動のたびに走る。全件索引より小さい部分索引を当てる
      index('idx_notifications_user_unread')
        .on(table.userId, sql`${table.createdAt} desc`)
        .where(sql`${table.readAt} IS NULL`),

      check('ck_notifications_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      check('ck_notifications_type', inValues(table.type, NOTIFICATION_TYPES)),
      check(
        'ck_notifications_title_length',
        lengthAtMost(table.title, NOTIFICATION_TITLE_MAX_LENGTH),
      ),
      check('ck_notifications_body_length', lengthAtMost(table.body, NOTIFICATION_BODY_MAX_LENGTH)),
      check('ck_notifications_data_json', sql`${table.data} IS NULL OR json_valid(${table.data})`),
    ],
  );

  /**
   * 監査ログ。「誰がいつ何をしたか」を追記専用で残す（設計書 5.1 `(admin)/audit-log.tsx`）。
   *
   * 実行者アカウントが消えても行は残す。消してしまうと処分の履歴が追えなくなる。
   */
  export const auditLogs = sqliteTable(
    'audit_logs',
    {
      id: text('id').primaryKey(),
      actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
      // `shop.suspend` のようなドット区切りの固定語彙
      action: text('action').notNull(),
      targetType: text('target_type').notNull(),
      targetId: text('target_id').notNull(),
      diff: text('diff', { mode: 'json' }).$type<AuditLogDiff>(),
      createdAt: integer('created_at', { mode: 'timestamp_ms' })
        .notNull()
        .default(CREATED_AT_DEFAULT),
    },
    (table) => [
      // 管理画面の既定表示は「全体の新着順」。索引だけで並べ替えを済ませる
      index('idx_audit_logs_created').on(sql`${table.createdAt} desc`),
      index('idx_audit_logs_actor_created').on(table.actorId, sql`${table.createdAt} desc`),
      // 「この店に何がされたか」を追う
      index('idx_audit_logs_target').on(table.targetType, table.targetId),

      check('ck_audit_logs_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
      // 大文字や空文字を弾く。表記ゆれが入ると action 別の集計ができなくなる
      check('ck_audit_logs_action', consistsOf(table.action, AUDIT_ACTION_ALLOWED_CHARACTERS)),
      check(
        'ck_audit_logs_target_type_length',
        lengthAtMost(table.targetType, AUDIT_TARGET_TYPE_MAX_LENGTH),
      ),
      check('ck_audit_logs_diff_json', sql`${table.diff} IS NULL OR json_valid(${table.diff})`),
    ],
  );
  ```

- [ ] **Step 6: `schema/index.ts` に追記してマイグレーションを再生成する**

  ```ts
  export * from './auth';
  export * from './master';
  export * from './shop';
  export * from './shop-detail';
  export * from './menu';
  export * from './review';
  export * from './reservation';
  export * from './collection';
  export * from './admin';
  ```

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  rm -rf migrations/meta migrations/0000_init.sql
  node ../../node_modules/.bin/drizzle-kit generate --name=init
  grep -n 'WHERE' migrations/0000_init.sql
  ```

  期待する出力（部分索引 3 本）:

  ```
  CREATE UNIQUE INDEX `uq_shop_photos_cover` ON `shop_photos` (`shop_id`) WHERE "shop_photos"."is_cover";
  CREATE INDEX `idx_notifications_user_unread` ON `notifications` (`user_id`,"created_at" desc) WHERE "notifications"."read_at" IS NULL;
  CREATE UNIQUE INDEX `uq_shop_applications_shop_pending` ON `shop_applications` (`shop_id`) WHERE "shop_applications"."status" = 'pending';
  ```

  `documents` の既定値が文字列として焼き込まれていることも確認する。

  ```bash
  grep -n 'documents' migrations/0000_init.sql
  ```

  ```
  `documents` text DEFAULT '[]' NOT NULL,
  ```

- [ ] **Step 7: テストが通ることを確認する**

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/admin.test.ts
  ```

  22 件が緑になる。

- [ ] **Step 8: わざと壊してテストが検知することを確認する**

  1. `ck_reports_handler_requires_time` と `ck_reports_closed_requires_time` の 2 本を
     `sql\`(${table.handledBy} IS NULL) = (${table.handledAt} IS NULL)\``1 本に戻す
→ 「対応した管理者を削除しても通報は残り、対応日時も残る」が`CHECK constraint failed` で落ちる。**`ON DELETE set null` が CHECK を踏む**ことを体で確認する
  2. `uq_shop_applications_shop_pending` から `.where(...)` を外す
     → 「前の申請が決着していれば再申請できる」が落ちる。
     差し戻し後に二度と申請できなくなる変更が検知される
  3. `ck_shop_applications_documents_json` から `AND json_type(...) = 'array'` を消す
     → 「documents が配列でなければ拒否する」が落ちる
  4. `idx_notifications_user_unread` から `.where(...)` を外す
     → 未読一覧のテストが落ちる（`idx_notifications_user_created` が選ばれる）
  5. `auditLogs.actorId` の `onDelete` を `'cascade'` に変える
     → 「実行者を削除しても監査ログは残る」が落ちる。
     **管理者が自分の処分履歴を消せてしまう**変更が検知される
  6. `uniqueIndex('uq_reports_reporter_target')` を `index(...)` に変える
     → 「同じ人が同じ対象を二重通報できない」が落ちる

  **6 つすべて確認したら元に戻し、再生成してテストが緑に戻ることを確認する。**

- [ ] **Step 9: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

  `documents` が `readonly ApplicationDocument[]`、`diff` が `AuditLogDiff | null` として
  推論されていることを確認する。

- [ ] **Step 10: コミット**

  `feat(api): 通報・店舗申請・通知・監査ログのテーブルを定義` として報告する。

---

### Task 3-10: `schema/index.ts` と `db/client.ts` — 全テーブルの集約と Drizzle クライアント

ここまでで 9 つのスキーマファイルが揃った。それを 1 か所に集め、
Worker から使う Drizzle クライアントを作る。

**`client.ts` が `Env` を受け取らない理由**

`Env`（`wrangler types` が生成する型）に依存させると、Phase 4 でバインディングを
足すたびに DB 層の型が動く。`client.ts` は `D1Database` だけを受け取り、
「どこから持ってきた D1 か」は呼び出し側（Phase 4 のミドルウェア）の責任にする。

**Files:**

- Modify: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/index.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/client.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/client.test.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/index.test.ts`

**Interfaces:**

```ts
// schema/index.ts — Produces（9 ファイルの再エクスポート）
export * from './auth';
export * from './master';
export * from './shop';
export * from './shop-detail';
export * from './menu';
export * from './review';
export * from './reservation';
export * from './collection';
export * from './admin';

// client.ts — Consumes
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

// client.ts — Produces
export type Database = DrizzleD1Database<typeof schema>;
export function createDatabase(d1: D1Database): Database;
```

- [ ] **Step 1: 失敗するテストを書く（`src/db/schema/index.test.ts`）**

  「index に書き忘れたテーブルがある」ことを機械的に検知する。
  マイグレーションに出てこないテーブルは、実装時に `no such table` で初めて気づくことになる。

  ```ts
  import { getTableName, isTable } from 'drizzle-orm';
  import { describe, expect, it } from 'vitest';
  import * as schema from './index';

  /** 設計書 §6 に挙がっている全テーブル名 */
  const EXPECTED_TABLE_NAMES = [
    // auth.ts（Better Auth）
    'user',
    'session',
    'account',
    'verification',
    // master.ts
    'profiles',
    'genres',
    'areas',
    // shop.ts
    'shops',
    // shop-detail.ts
    'shop_hours',
    'shop_closures',
    'shop_photos',
    // menu.ts
    'menu_categories',
    'menu_items',
    'seat_settings',
    // review.ts
    'reviews',
    'review_photos',
    'review_replies',
    // reservation.ts
    'reservations',
    // collection.ts
    'favorites',
    'lists',
    'list_items',
    // admin.ts
    'reports',
    'shop_applications',
    'notifications',
    'audit_logs',
  ] as const;

  function collectExportedTableNames(): readonly string[] {
    return Object.values(schema)
      .filter((exported) => isTable(exported))
      .map((table) => getTableName(table))
      .sort();
  }

  describe('schema/index.ts', () => {
    it('設計書 §6 の全テーブルを再エクスポートしている', () => {
      expect(collectExportedTableNames()).toEqual([...EXPECTED_TABLE_NAMES].sort());
    });

    it('テーブル名の重複がない', () => {
      const tableNames = collectExportedTableNames();

      expect(new Set(tableNames).size).toBe(tableNames.length);
    });

    it('テーブル数は 25 である', () => {
      // 設計書 §6 の 21 テーブル + Better Auth の 4 テーブル
      expect(collectExportedTableNames()).toHaveLength(25);
    });
  });
  ```

- [ ] **Step 2: `src/db/schema/index.ts` を完成させる**

  ```ts
  // 全スキーマファイルの再エクスポート。
  // drizzle.config.ts はこのファイルだけを見るので、ここに書き忘れたテーブルは
  // マイグレーションに出ない。index.test.ts がその漏れを検知する。
  //
  // 並び順は依存の向き（auth → master → shop → 詳細 → admin）に揃えてある。
  // ここを並べ替えても動作は変わらないが、読むときの手掛かりとして維持すること。
  export * from './auth';
  export * from './master';
  export * from './shop';
  export * from './shop-detail';
  export * from './menu';
  export * from './review';
  export * from './reservation';
  export * from './collection';
  export * from './admin';
  ```

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/index.test.ts
  ```

  3 件が緑になる。

- [ ] **Step 3: 失敗するテストを書く（`src/db/client.test.ts`）**

  ```ts
  import { eq } from 'drizzle-orm';
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { createDatabase, type Database } from './client';
  import { areas, genres } from './schema';
  import { shops } from './schema';
  import { createMigratedD1, type LocalD1 } from './testing/local-d1';

  let local: LocalD1;
  let database: Database;

  beforeAll(async () => {
    local = await createMigratedD1();
    database = createDatabase(local.d1);
  });

  afterAll(async () => {
    await local.dispose();
  });

  describe('createDatabase', () => {
    it('Drizzle 経由で INSERT と SELECT ができる', async () => {
      await database
        .insert(genres)
        .values({ id: 'gnr_client', name: 'ラーメン', slug: 'ramen-client' });
      await database
        .insert(areas)
        .values({ id: 'area_client', name: '渋谷', prefecture: '東京都' });
      await database.insert(shops).values({
        id: 'shp_client',
        name: 'クライアントテスト店',
        genreId: 'gnr_client',
        areaId: 'area_client',
        address: '東京都渋谷区',
        lat: 35.658034,
        lng: 139.701636,
        geohash: 'xn76fgr',
      });

      const rows = await database.select().from(shops).where(eq(shops.id, 'shp_client'));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('クライアントテスト店');
    });

    it('timestamp_ms の列が Date として返る', async () => {
      const rows = await database.select().from(shops).where(eq(shops.id, 'shp_client'));

      // mode: 'timestamp_ms' は Drizzle が Date へ変換する。生の数値ではない
      expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    });

    it('boolean の列が真偽値として返る', async () => {
      const rows = await database.select().from(shops).where(eq(shops.id, 'shp_client'));

      expect(typeof rows[0]?.ratingCount).toBe('number');
      expect(rows[0]?.status).toBe('draft');
    });

    it('CHECK 違反は Drizzle 経由でも例外になる', async () => {
      await expect(
        database.insert(shops).values({
          id: 'shp_client_ng',
          name: '緯度が範囲外の店',
          genreId: 'gnr_client',
          areaId: 'area_client',
          address: '東京都渋谷区',
          lat: 95,
          lng: 139.701636,
          geohash: 'xn76fgr',
        }),
      ).rejects.toThrow(/CHECK constraint failed: ck_shops_lat/);
    });

    it('batch で複数文を 1 往復にまとめられる', async () => {
      // D1 の batch は 1 トランザクション。Phase 7 の予約確定で使う
      await database.batch([
        database.insert(genres).values({ id: 'gnr_batch1', name: '寿司', slug: 'sushi-batch' }),
        database.insert(genres).values({ id: 'gnr_batch2', name: '焼肉', slug: 'yakiniku-batch' }),
      ]);

      const rows = await database.select().from(genres);

      expect(rows.length).toBeGreaterThanOrEqual(3);
    });
  });
  ```

- [ ] **Step 4: `src/db/client.ts` を書く**

  ```ts
  import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
  import * as schema from './schema';

  /**
   * このアプリの Drizzle クライアント型。
   * `schema` を型引数に渡してあるので `database.query.shops.findMany()` のような
   * リレーショナルクエリも型付きで使える。
   */
  export type Database = DrizzleD1Database<typeof schema>;

  /**
   * D1 バインディングから Drizzle クライアントを作る。
   *
   * `Env` を受け取らないのは意図的。Phase 4 でバインディングが増えても
   * この層の型が動かないようにしている。呼び出し側が `env.DB` を渡す。
   */
  export function createDatabase(d1: D1Database): Database {
    return drizzle(d1, { schema });
  }
  ```

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/client.test.ts
  ```

- [ ] **Step 5: マイグレーションを最終形で生成し直す**

  ここまで各タスクで作っては消してきたマイグレーションを、
  **1 本の `0000_init.sql` として確定させる**。

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  rm -rf migrations/meta
  rm -f migrations/*.sql
  npm run db:generate -- --name=init
  ```

  生成結果を数えて確認する。

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api
  grep -c 'CREATE TABLE' migrations/0000_init.sql
  grep -c 'CREATE INDEX\|CREATE UNIQUE INDEX' migrations/0000_init.sql
  grep -c 'CONSTRAINT' migrations/0000_init.sql
  ```

  `CREATE TABLE` が **25** 行出れば、全テーブルが拾えている。

- [ ] **Step 6: ローカル D1 に適用する**

  `wrangler` のローカル D1 は `apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/` の
  下に SQLite ファイルとして置かれる（ファイル名はデータベース ID のハッシュ）。
  適用済みマイグレーションは同じ DB の `d1_migrations` テーブルに記録される。

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  rm -rf .wrangler/state/v3/d1
  npm run db:migrate:local
  ```

  適用されたことを確認する。

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api
  npx wrangler d1 execute meshimap-db --local \
    --command="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
  npx wrangler d1 execute meshimap-db --local --command="SELECT name FROM d1_migrations"
  ```

  前者に 25 テーブル、後者に `0000_init.sql` が出る。

- [ ] **Step 7: 外部キーがローカルで有効かを確認する**

  SQLite の外部キーは既定で無効。D1 は有効にしているが、
  **確認せずに前提にしない**。

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api
  npx wrangler d1 execute meshimap-db --local --command="PRAGMA foreign_keys"
  ```

  `1` が返ることを確認する。`0` が返った場合は
  `local-d1.ts` と本番で挙動が変わるため、ここで止めて原因を突き止める。

- [ ] **Step 8: 型検査とテスト全体を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  npm run typecheck
  npm test
  ```

- [ ] **Step 9: わざと壊してテストが検知することを確認する**

  1. `schema/index.ts` から `export * from './admin';` を消す
     → `index.test.ts` の 3 件すべてが落ちる。
     **さらに `npm run db:generate` し直すと `reports` などが DDL から消える**ことも確認する
     （これが「index に書き忘れ = マイグレーションに出ない」の実体）
  2. `createDatabase` から `{ schema }` を外して `drizzle(d1)` にする
     → `client.test.ts` は通ってしまうが、`npm run typecheck` が
     `Database` 型の不一致で落ちる。**型でしか検知できない**ことを確認する
  3. `EXPECTED_TABLE_NAMES` から `'audit_logs'` を消す
     → 「設計書 §6 の全テーブルを再エクスポートしている」と「テーブル数は 25 である」が落ちる

  **3 つすべて確認したら元に戻し、再生成して緑に戻す。**

- [ ] **Step 10: コミット**

  `feat(api): スキーマを集約し Drizzle クライアントを追加` として報告する。

---

### Task 3-11: `shops_fts` — FTS5 仮想テーブルと同期トリガー

設計書 §6「全文検索は FTS5（D1 がサポート）で `shops_fts` 仮想テーブルを作り、
店名・説明を対象にする」。

Drizzle は仮想テーブルを表現できないので、**手書きの SQL マイグレーション**で作る。
`drizzle-kit generate --custom` を使うと、drizzle-kit の採番とスナップショットに
乗ったまま空の SQL ファイルを作れる。自分でファイルを置くと次の `generate` で
番号が衝突するので、必ずこのコマンドを使う。

**トークナイザに `trigram` を選ぶ理由（実測）**

`unicode61`（既定）は空白と記号でしか区切らない。日本語は分かち書きしないので
`濃厚な豚骨ラーメンが看板メニュー` が**丸ごと 1 トークン**になり、
`ラーメン` でも `豚骨` でもヒットしない（完全一致だけ当たる）。

`trigram` は 3 文字ずつの部分列を索引化するので日本語の部分一致が効く。
代わりに **2 文字以下の検索語は原理的にヒットしない**。
`寿司` `豚骨` `渋谷` はゼロ件になる。これは Phase 6 の検索 API で
「2 文字以下は FTS を使わず `name LIKE '%…%'` にフォールバックする」ことで吸収する。

| 検索語        | 文字数 | trigram                | unicode61 |
| ------------- | ------ | ---------------------- | --------- |
| `ラーメン`    | 4      | ヒット                 | ゼロ件    |
| `渋谷区`      | 3      | ヒット                 | ゼロ件    |
| `こうじ`      | 3      | ヒット                 | ゼロ件    |
| `寿司`        | 2      | **ゼロ件**             | ゼロ件    |
| `Aoi` / `aoi` | 3      | 両方ヒット（大小無視） | —         |

**外部コンテンツ表（`content='shops'`）にする理由**

`shops` の本文を FTS 側にも複製すると、同じ文字列が 2 か所に残って容量が倍になり、
更新漏れで食い違う。`content='shops'` にすると索引だけを持ち、本文は `shops` から読む。
代わりに**同期は自分でトリガーを書く必要がある**（FTS5 は外部コンテンツを自動追跡しない）。

**Files:**

- Create: `/Users/hattori/Downloads/alee/apps/api/migrations/0001_shops_fts.sql`（`--custom` で生成）
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/fts.ts`
- Create: `/Users/hattori/Downloads/alee/apps/api/src/db/fts.test.ts`
- Modify: `/Users/hattori/Downloads/alee/apps/api/src/db/constants.ts`
- Modify: `/Users/hattori/Downloads/alee/apps/api/src/db/testing/local-d1.ts`（マイグレーションを全件適用するよう確認）

**Interfaces:**

```ts
// constants.ts — 追記
/** trigram トークナイザが索引化する最小文字数。これ未満の検索語は原理的にヒットしない */
export const FTS_TRIGRAM_MIN_LENGTH = 3;

// fts.ts — Produces
export function escapeFtsToken(token: string): string;
export function buildFtsMatchQuery(rawInput: string): string | null;
export const SHOPS_FTS_TABLE_NAME = 'shops_fts';
```

- [ ] **Step 1: `local-d1.ts` が全マイグレーションを適用しているか確認する**

  Task 3-0 で作った `createMigratedD1()` は `migrations/*.sql` を
  **ファイル名順に全件**適用する実装になっているはず。ここで確認する。

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  grep -n 'readdir\|sort\|statement-breakpoint' src/db/testing/local-d1.ts
  ```

  `0000_init.sql` だけを決め打ちで読んでいたら、ここで
  「ディレクトリを読んで `.sql` を名前順に全件適用する」実装に直す。
  直さないと以降のテストで `no such table: shops_fts` になる。

- [ ] **Step 2: 空のカスタムマイグレーションを生成する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  npm run db:generate -- --custom --name=shops_fts
  ls migrations
  cat migrations/meta/_journal.json
  ```

  `migrations/0001_shops_fts.sql` が
  `-- Custom SQL migration file, put your code below! --` の 1 行だけで生成され、
  `_journal.json` に `{"idx": 1, "tag": "0001_shops_fts"}` が追加され、
  `migrations/meta/0001_snapshot.json` も作られることを確認する。
  スナップショットが作られるおかげで、次に `generate` したとき `0002_` から続く。

- [ ] **Step 3: 失敗するテストを書く（`src/db/fts.test.ts` 前半 — 仮想テーブルとトリガー）**

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { createMigratedD1, type LocalD1 } from './testing/local-d1';

  let local: LocalD1;

  const RAMEN_SHOP_ID = 'shp_fts_ramen';
  const SUSHI_SHOP_ID = 'shp_fts_sushi';
  const ITALIAN_SHOP_ID = 'shp_fts_italian';

  async function insertShop(
    shopId: string,
    name: string,
    nameKana: string,
    description: string,
    address: string,
  ): Promise<void> {
    await local.d1
      .prepare(
        'INSERT INTO shops (id, name, name_kana, description, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        shopId,
        name,
        nameKana,
        description,
        'gnr_fts',
        'area_fts',
        address,
        35.658034,
        139.701636,
        'xn76fgr',
      )
      .run();
  }

  /** FTS を引いて店舗 ID の配列を返す */
  async function searchShopIds(matchQuery: string): Promise<readonly string[]> {
    const result = await local.d1
      .prepare(
        'SELECT s.id AS id FROM shops_fts f JOIN shops s ON s.rowid = f.rowid WHERE shops_fts MATCH ? ORDER BY bm25(shops_fts)',
      )
      .bind(matchQuery)
      .all<{ id: string }>();

    return result.results.map((row) => row.id);
  }

  beforeAll(async () => {
    local = await createMigratedD1();
    await local.d1
      .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
      .bind('gnr_fts', 'ラーメン', 'ramen-fts')
      .run();
    await local.d1
      .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
      .bind('area_fts', '渋谷', '東京都')
      .run();
    await insertShop(
      RAMEN_SHOP_ID,
      '麺屋 こうじ',
      'メンヤコウジ',
      '濃厚な豚骨ラーメンが看板メニュー',
      '東京都渋谷区道玄坂1-2-3',
    );
    await insertShop(
      SUSHI_SHOP_ID,
      '寿司処 たなか',
      'スシドコロタナカ',
      '江戸前寿司のカウンター 8 席',
      '東京都渋谷区神南1-2-3',
    );
    await insertShop(
      ITALIAN_SHOP_ID,
      'Trattoria Aoi',
      'トラットリアアオイ',
      '薪窯で焼くナポリピッツァ',
      '東京都目黒区青葉台1-2-3',
    );
  });

  afterAll(async () => {
    await local.dispose();
  });

  describe('shops_fts（仮想テーブル）', () => {
    it('マイグレーション適用後に仮想テーブルとトリガーが存在する', async () => {
      const result = await local.d1
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'shops_fts%' ORDER BY name")
        .all<{ name: string }>();
      const names = result.results.map((row) => row.name);

      // FTS5 は本体 + 影テーブル（config / data / docsize / idx）を作る。
      // content='shops' なので shops_fts_content は作られない
      expect(names).toEqual([
        'shops_fts',
        'shops_fts_after_delete',
        'shops_fts_after_insert',
        'shops_fts_after_update',
        'shops_fts_config',
        'shops_fts_data',
        'shops_fts_docsize',
        'shops_fts_idx',
      ]);
    });

    it('INSERT トリガーで索引に入る', async () => {
      const row = await local.d1
        .prepare('SELECT count(*) AS indexed FROM shops_fts')
        .first<{ indexed: number }>();

      expect(row?.indexed).toBe(3);
    });

    it('店名で引ける', async () => {
      expect(await searchShopIds('"こうじ"')).toEqual([RAMEN_SHOP_ID]);
    });

    it('説明文の途中でも引ける（trigram の部分一致）', async () => {
      expect(await searchShopIds('"ラーメン"')).toEqual([RAMEN_SHOP_ID]);
    });

    it('カナ読みで引ける', async () => {
      expect(await searchShopIds('"トラットリア"')).toEqual([ITALIAN_SHOP_ID]);
    });

    it('住所で引ける（複数店がヒットする）', async () => {
      const shopIds = await searchShopIds('"渋谷区"');

      expect([...shopIds].sort()).toEqual([RAMEN_SHOP_ID, SUSHI_SHOP_ID].sort());
    });

    it('英字は大小を区別しない', async () => {
      expect(await searchShopIds('"aoi"')).toEqual([ITALIAN_SHOP_ID]);
      expect(await searchShopIds('"AOI"')).toEqual([ITALIAN_SHOP_ID]);
    });

    it('2 文字の検索語はヒットしない（trigram の仕様）', async () => {
      // Phase 6 の検索 API はこのケースを LIKE にフォールバックさせる
      expect(await searchShopIds('"寿司"')).toEqual([]);
    });

    it('UPDATE トリガーで古い語が消え、新しい語が入る', async () => {
      await local.d1
        .prepare('UPDATE shops SET description = ? WHERE id = ?')
        .bind('あっさり醤油ラーメンが看板メニュー', RAMEN_SHOP_ID)
        .run();

      expect(await searchShopIds('"あっさり"')).toEqual([RAMEN_SHOP_ID]);
      // 「濃厚な」は古い本文にしかない。トリガーの delete 側が動いていないと残る
      expect(await searchShopIds('"濃厚な"')).toEqual([]);
    });

    it('DELETE トリガーで索引から消える', async () => {
      await local.d1.prepare('DELETE FROM shops WHERE id = ?').bind(SUSHI_SHOP_ID).run();

      const row = await local.d1
        .prepare('SELECT count(*) AS indexed FROM shops_fts')
        .first<{ indexed: number }>();

      expect(row?.indexed).toBe(2);
      expect(await searchShopIds('"神南"')).toEqual([]);
    });

    it('整合性チェックが通る（本体と索引が食い違っていない）', async () => {
      // 食い違っていると SQLITE_CORRUPT_VTAB が投げられる。
      // トリガーの列順ミスをここで検知できる
      await local.d1.prepare("INSERT INTO shops_fts(shops_fts) VALUES('integrity-check')").run();
    });
  });
  ```

- [ ] **Step 4: テストが失敗することを確認し、`migrations/0001_shops_fts.sql` を書く**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/fts.test.ts
  ```

  `no such table: shops_fts` を確認してから書く。

  ```sql
  -- Custom SQL migration file, put your code below! --

  -- 店舗の全文検索インデックス（設計書 §6）。
  --
  -- content='shops' の外部コンテンツ表にしているので、本文は shops 側にしか無い。
  -- そのぶん容量が増えず食い違いも起きないが、同期は下のトリガーが全責任を持つ。
  --
  -- tokenize='trigram' は 3 文字ずつの部分列を索引化する。日本語は分かち書きしないため
  -- 既定の unicode61 では「濃厚な豚骨ラーメンが看板メニュー」が丸ごと 1 トークンになり
  -- 部分一致が効かない。代わりに 2 文字以下の検索語はヒットしない（API 側でフォールバックする）。
  CREATE VIRTUAL TABLE `shops_fts` USING fts5(
    name,
    name_kana,
    description,
    address,
    content='shops',
    content_rowid='rowid',
    tokenize='trigram'
  );
  --> statement-breakpoint
  -- 以下 3 つのトリガーが shops と shops_fts の同期を担う。
  -- 列の並びは仮想テーブルの定義順（name, name_kana, description, address）と
  -- 完全に一致させること。ずれても DDL は通り、検索結果だけが静かに壊れる。
  CREATE TRIGGER `shops_fts_after_insert` AFTER INSERT ON `shops` BEGIN
    INSERT INTO `shops_fts`(`rowid`, `name`, `name_kana`, `description`, `address`)
    VALUES (new.`rowid`, new.`name`, new.`name_kana`, new.`description`, new.`address`);
  END;
  --> statement-breakpoint
  -- 外部コンテンツ表の削除は 'delete' コマンド行を入れて行う。
  -- DELETE FROM shops_fts では消えない（本文を shops から読むため）。
  -- old の値が索引時の値と一致していないと索引が壊れるので、必ず old.* を渡す。
  CREATE TRIGGER `shops_fts_after_delete` AFTER DELETE ON `shops` BEGIN
    INSERT INTO `shops_fts`(`shops_fts`, `rowid`, `name`, `name_kana`, `description`, `address`)
    VALUES ('delete', old.`rowid`, old.`name`, old.`name_kana`, old.`description`, old.`address`);
  END;
  --> statement-breakpoint
  -- 更新は「古い行を消してから新しい行を入れる」の 2 段。
  -- delete 側を書き忘れると古い語が索引に残り続ける。
  CREATE TRIGGER `shops_fts_after_update` AFTER UPDATE ON `shops` BEGIN
    INSERT INTO `shops_fts`(`shops_fts`, `rowid`, `name`, `name_kana`, `description`, `address`)
    VALUES ('delete', old.`rowid`, old.`name`, old.`name_kana`, old.`description`, old.`address`);
    INSERT INTO `shops_fts`(`rowid`, `name`, `name_kana`, `description`, `address`)
    VALUES (new.`rowid`, new.`name`, new.`name_kana`, new.`description`, new.`address`);
  END;
  ```

  `CREATE TRIGGER` の本体には `;` が含まれるが、
  `wrangler d1 migrations apply` は `BEGIN … END;` を 1 文として正しく扱う（F54 で実測）。

- [ ] **Step 5: ローカル D1 に適用して手で引いてみる**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  rm -rf .wrangler/state/v3/d1
  npm run db:migrate:local
  npx wrangler d1 execute meshimap-db --local \
    --command="SELECT name FROM sqlite_master WHERE name LIKE 'shops_fts%' ORDER BY name"
  ```

  本体 1 + トリガー 3 + 影テーブル 4 の計 8 件が出る。

- [ ] **Step 6: テストを緑にする**

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/fts.test.ts
  ```

  11 件が通る。

- [ ] **Step 7: `src/db/fts.ts` のテストを書く（検索語のエスケープ）**

  ユーザーの入力をそのまま `MATCH` に渡すと**例外になる**。
  `道玄坂1-2-3` は `no such column: 2`、`(` は `fts5: syntax error` を投げる。
  二重引用符で包めばすべてただの語句になる。これは実測済み（F55）。

  `src/db/fts.test.ts` に続けて書く。

  ```ts
  import { buildFtsMatchQuery, escapeFtsToken } from './fts';

  describe('escapeFtsToken', () => {
    it('語を二重引用符で包む', () => {
      expect(escapeFtsToken('ラーメン')).toBe('"ラーメン"');
    });

    it('語に含まれる二重引用符は 2 つ重ねて打ち消す', () => {
      expect(escapeFtsToken('い"ち')).toBe('"い""ち"');
    });

    it('FTS5 の演算子を語として無害化する', () => {
      // 包まないと fts5 の構文解析に食われる
      expect(escapeFtsToken('OR')).toBe('"OR"');
      expect(escapeFtsToken('ラーメン*')).toBe('"ラーメン*"');
      expect(escapeFtsToken('(')).toBe('"("');
    });

    it('ハイフンを含む語を壊さない', () => {
      expect(escapeFtsToken('道玄坂1-2-3')).toBe('"道玄坂1-2-3"');
    });
  });

  describe('buildFtsMatchQuery', () => {
    it('1 語ならそのまま引用する', () => {
      expect(buildFtsMatchQuery('ラーメン')).toBe('"ラーメン"');
    });

    it('空白区切りの複数語は AND でつなぐ', () => {
      expect(buildFtsMatchQuery('ラーメン 渋谷区')).toBe('"ラーメン" AND "渋谷区"');
    });

    it('全角スペースでも区切る', () => {
      expect(buildFtsMatchQuery('ラーメン　渋谷区')).toBe('"ラーメン" AND "渋谷区"');
    });

    it('3 文字未満の語は落とす（trigram ではヒットしないため）', () => {
      expect(buildFtsMatchQuery('ラーメン 寿司')).toBe('"ラーメン"');
    });

    it('全部の語が 3 文字未満なら null を返す', () => {
      // 呼び出し側は null を見て LIKE 検索へフォールバックする
      expect(buildFtsMatchQuery('寿司 蕎麦')).toBeNull();
    });

    it('空文字と空白だけの入力は null を返す', () => {
      expect(buildFtsMatchQuery('')).toBeNull();
      expect(buildFtsMatchQuery('   ')).toBeNull();
    });

    it('演算子を含む入力でも例外にならない式を作る', async () => {
      const matchQuery = buildFtsMatchQuery('道玄坂1-2-3');

      expect(matchQuery).toBe('"道玄坂1-2-3"');
      // 実際に D1 に投げても落ちないことまで確認する
      await expect(searchShopIds(matchQuery ?? '')).resolves.toEqual([RAMEN_SHOP_ID]);
    });

    it('生成した式で実際に検索できる', async () => {
      const matchQuery = buildFtsMatchQuery('ラーメン 渋谷区');

      await expect(searchShopIds(matchQuery ?? '')).resolves.toEqual([RAMEN_SHOP_ID]);
    });
  });
  ```

- [ ] **Step 8: `src/db/constants.ts` に `FTS_TRIGRAM_MIN_LENGTH` を足し、`src/db/fts.ts` を書く**

  ```ts
  // constants.ts に追記
  /**
   * trigram トークナイザが索引化する最小文字数。
   * これ未満の検索語は原理的にヒットしないので、API 側で LIKE へフォールバックする。
   */
  export const FTS_TRIGRAM_MIN_LENGTH = 3;
  ```

  ```ts
  // src/db/fts.ts
  import { FTS_TRIGRAM_MIN_LENGTH } from './constants';

  /** FTS5 仮想テーブルの名前。生 SQL に文字列を散らかさないための定数 */
  export const SHOPS_FTS_TABLE_NAME = 'shops_fts';

  /** 語の区切りに使う文字（半角スペース・全角スペース・タブ・改行） */
  const TOKEN_SEPARATOR_PATTERN = /[\s　]+/u;

  /**
   * 検索語 1 つを FTS5 の式に埋め込める形にする。
   *
   * 二重引用符で包むと、中身は `OR` `NEAR` `*` `(` `-` を含めてすべてただの語句になる。
   * 包まないと `道玄坂1-2-3` が `no such column: 2`、`(` が `fts5: syntax error` を投げる。
   */
  export function escapeFtsToken(token: string): string {
    return `"${token.replaceAll('"', '""')}"`;
  }

  /**
   * ユーザーの入力欄の文字列から `MATCH` に渡す式を作る。
   *
   * 空白で区切って AND でつなぐ。trigram では 3 文字未満がヒットしないので落とす。
   * 使える語が 1 つも残らなければ `null` を返す。
   * 呼び出し側は `null` を見て LIKE 検索へフォールバックすること（Phase 6）。
   */
  export function buildFtsMatchQuery(rawInput: string): string | null {
    const usableTokens = rawInput
      .split(TOKEN_SEPARATOR_PATTERN)
      .filter((token) => token.length >= FTS_TRIGRAM_MIN_LENGTH)
      .map((token) => escapeFtsToken(token));

    if (usableTokens.length === 0) {
      return null;
    }

    return usableTokens.join(' AND ');
  }
  ```

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/fts.test.ts
  ```

  25 件が緑になる。

- [ ] **Step 9: わざと壊してテストが検知することを確認する**

  1. `shops_fts_after_update` から `'delete'` の行を消す
     → 「UPDATE トリガーで古い語が消え、新しい語が入る」が落ちる
     （`"濃厚な"` が 1 件残る）
  2. `shops_fts_after_delete` の列を `old.name` ではなく `new.name` …ではなく、
     `name` と `name_kana` の順を入れ替える
     → 「整合性チェックが通る」が `SQLITE_CORRUPT_VTAB` で落ちる。
     **DDL は通るのに検索結果だけが静かに壊れる**類のミスを検知できることを確認する
  3. `tokenize='trigram'` を消して既定（unicode61）に戻す
     → 「説明文の途中でも引ける」「カナ読みで引ける」「住所で引ける」が
     すべてゼロ件になって落ちる
  4. `escapeFtsToken` の引用符を外して `return token;` にする
     → 「演算子を含む入力でも例外にならない式を作る」が
     `no such column: 2` で落ちる
  5. `buildFtsMatchQuery` の `filter` を消す
     → 「3 文字未満の語は落とす」と「全部の語が 3 文字未満なら null を返す」が落ちる
  6. `content='shops'` を消して独立テーブルにする
     → `sqlite_master` の一覧に `shops_fts_content` が増えて
     「仮想テーブルとトリガーが存在する」が落ちる

  **6 つすべて確認したら元に戻し、`rm -rf .wrangler/state/v3/d1` から適用し直して緑に戻す。**

- [ ] **Step 10: コミット**

  `feat(api): shops_fts 仮想テーブルと同期トリガーを追加` として報告する。

---

### Task 3-12: シード生成（東京 12 エリア・店舗 60 件）

開発用の初期データを作る。要件は 3 つ。

1. **実在する東京のエリア**を使う（渋谷 / 新宿 / 中目黒 …）。架空の座標だと
   地図を開いたときに海の上に店が並び、表示の不具合と区別が付かない。
2. **決定的**。`Math.random()` や `Date.now()` を使わず、固定シードの疑似乱数と
   固定日付だけで作る。そうしないと「60 件中 5 件が半径 200m に入る」といった
   期待値をテストに書けない。
3. **再実行可能**。冒頭で全テーブルを `DELETE` してから入れ直す。
   `npm run db:seed:local` を何度叩いても結果が変わらない。

geohash は **必ず `@meshimap/geo` の `encodeGeohash` で計算する**。
SQL 側で計算する手段は無く、手で書くと 1 文字ずれても検索が静かに壊れる。

**Files:**

- Create: `apps/api/scripts/generate-seed.ts`
- Create: `apps/api/seeds/seed.sql`（生成物。`db:seed:local` が読むのでリポジトリに入れる）
- Create: `apps/api/src/db/seed.test.ts`
- Modify: `apps/api/tsconfig.json`（`include` に `scripts/**/*.ts` を追加）
- Modify: `apps/api/src/db/testing/local-d1.ts`（`applySeed()` を追加）

**Interfaces:**

- Consumes:
  - `coordinate(latitude: number, longitude: number): Coordinate`（`@meshimap/geo`）
  - `encodeGeohash(target: Coordinate, precision: number): string`（`@meshimap/geo`）
  - `SHOP_GEOHASH_PRECISION: 7`（`apps/api/src/db/constants.ts`）
  - `applyMigrations(d1: D1Database): Promise<number>`（Task 3-0）
- Produces:
  - `apps/api/seeds/seed.sql` — 1247 文の SQL（店舗 60 / レビュー 109）
  - `applySeed(d1: D1Database): Promise<number>` — 実行した文の数を返す

- [ ] **Step 1: `apps/api/tsconfig.json` の `include` に `scripts/` を足す**

  現在の `include` は `src/**/*.ts` だけなので、`scripts/generate-seed.ts` が
  型検査の対象から漏れる。`any` が紛れ込んでも気付けないため先に直す。

  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": {
      "types": ["@cloudflare/workers-types", "vitest/globals"],
      "noEmit": true,
      "jsx": "react-jsx",
      "jsxImportSource": "hono/jsx"
    },
    "include": ["src/**/*.ts", "scripts/**/*.ts", "worker-configuration.d.ts"]
  }
  ```

- [ ] **Step 2: 失敗するテストを書く（`src/db/seed.test.ts`）**

  ここに書く数字はすべて実測値（F62 / F64）。「だいたい 60 件」ではなく
  正確な件数を書くこと。1 件でもずれたら乱数か配置が変わったということであり、
  それはシードの決定性が壊れた合図になる。

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { applySeed, createMigratedD1, type LocalD1 } from './testing/local-d1';

  let local: LocalD1;

  /** 生成される SQL 文の総数。文が増減したら期待値も更新する */
  const EXPECTED_STATEMENT_COUNT = 1247;

  beforeAll(async () => {
    local = await createMigratedD1();
    await applySeed(local.d1);
  }, 120_000);

  afterAll(async () => {
    await local.dispose();
  });

  async function countOf(tableName: string): Promise<number> {
    const row = await local.d1
      .prepare(`SELECT count(*) AS row_count FROM \`${tableName}\``)
      .first<{ row_count: number }>();
    if (row === null) {
      throw new Error(`件数を取得できませんでした: ${tableName}`);
    }
    return row.row_count;
  }

  describe('シードの件数', () => {
    it('SQL の文数が想定どおり', async () => {
      const executedCount = await applySeed(local.d1);

      expect(executedCount).toBe(EXPECTED_STATEMENT_COUNT);
    });

    it('店舗は 60 件（12 エリア × 5 件）', async () => {
      expect(await countOf('shops')).toBe(60);
    });

    it('ジャンルとエリアは 12 件ずつ', async () => {
      expect(await countOf('genres')).toBe(12);
      expect(await countOf('areas')).toBe(12);
    });

    it('利用者は 33 人（管理者 1 + オーナー 12 + 一般 20）で、全員に profiles がある', async () => {
      expect(await countOf('user')).toBe(33);
      expect(await countOf('profiles')).toBe(33);
    });

    it('営業時間は 60 店 × 7 曜日 = 420 行で、うち 60 行が定休日', async () => {
      expect(await countOf('shop_hours')).toBe(420);

      const closed = await local.d1
        .prepare('SELECT count(*) AS row_count FROM shop_hours WHERE is_closed = 1')
        .first<{ row_count: number }>();

      expect(closed?.row_count).toBe(60);
    });

    it('写真は 120 枚で、カバーは 1 店 1 枚', async () => {
      expect(await countOf('shop_photos')).toBe(120);

      const covers = await local.d1
        .prepare('SELECT count(*) AS row_count FROM shop_photos WHERE is_cover = 1')
        .first<{ row_count: number }>();

      expect(covers?.row_count).toBe(60);
    });

    it('メニューは 120 カテゴリ / 240 品、席設定は 60 件', async () => {
      expect(await countOf('menu_categories')).toBe(120);
      expect(await countOf('menu_items')).toBe(240);
      expect(await countOf('seat_settings')).toBe(60);
    });

    it('レビューは 109 件で、うち 46 店舗が評価を持つ', async () => {
      expect(await countOf('reviews')).toBe(109);

      const rated = await local.d1
        .prepare('SELECT count(*) AS row_count FROM shops WHERE rating_count > 0')
        .first<{ row_count: number }>();

      expect(rated?.row_count).toBe(46);
    });
  });

  describe('シードの中身', () => {
    it('ジャンルは 12 種類が 5 件ずつに散っている', async () => {
      const rows = await local.d1
        .prepare('SELECT genre_id, count(*) AS row_count FROM shops GROUP BY genre_id')
        .all<{ genre_id: string; row_count: number }>();

      expect(rows.results).toHaveLength(12);
      for (const row of rows.results) {
        expect(row.row_count).toBe(5);
      }
    });

    it('全店舗が published で、geohash は 7 文字', async () => {
      const row = await local.d1
        .prepare(
          "SELECT count(*) AS row_count FROM shops WHERE status = 'published' AND length(geohash) = 7",
        )
        .first<{ row_count: number }>();

      expect(row?.row_count).toBe(60);
    });

    it('渋谷 1 号店は渋谷駅の座標そのもので、geohash は xn76fgr', async () => {
      const row = await local.d1
        .prepare(
          'SELECT name, name_kana, lat, lng, geohash, address, postal_code FROM shops WHERE id = ?',
        )
        .bind('shp_001')
        .first<{
          name: string;
          name_kana: string;
          lat: number;
          lng: number;
          geohash: string;
          address: string;
          postal_code: string;
        }>();

      expect(row).toEqual({
        name: '麺屋 みどり',
        name_kana: 'メンヤ ミドリ',
        lat: 35.658034,
        lng: 139.701636,
        geohash: 'xn76fgr',
        address: '東京都渋谷区道玄坂1-1-1',
        postal_code: '150-0001',
      });
    });

    it('name_kana が NULL の店舗は無い（FTS のカナ検索が効く）', async () => {
      const row = await local.d1
        .prepare('SELECT count(*) AS row_count FROM shops WHERE name_kana IS NULL')
        .first<{ row_count: number }>();

      expect(row?.row_count).toBe(0);
    });

    it('rating_avg はレビューから再計算した値と一致する', async () => {
      const row = await local.d1
        .prepare(
          `SELECT count(*) AS mismatch_count
             FROM shops s
            WHERE s.rating_count <> (
                    SELECT count(*) FROM reviews r
                     WHERE r.shop_id = s.id AND r.status = 'published')
               OR s.rating_avg <> coalesce((
                    SELECT round(avg(r.rating), 2) FROM reviews r
                     WHERE r.shop_id = s.id AND r.status = 'published'), 0)`,
        )
        .first<{ mismatch_count: number }>();

      expect(row?.mismatch_count).toBe(0);
    });

    it('シードを流すと shops_fts も 60 件になる（トリガーが効いている）', async () => {
      expect(await countOf('shops_fts')).toBe(60);

      const hit = await local.d1
        .prepare('SELECT count(*) AS row_count FROM shops_fts WHERE shops_fts MATCH ?')
        .bind('"メンヤ"')
        .first<{ row_count: number }>();

      expect(hit?.row_count).toBe(2);
    });

    it('2 回流しても件数が変わらない（冪等）', async () => {
      await applySeed(local.d1);

      expect(await countOf('shops')).toBe(60);
      expect(await countOf('reviews')).toBe(109);
      expect(await countOf('shops_fts')).toBe(60);
    });
  });
  ```

- [ ] **Step 3: テストが失敗することを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/seed.test.ts
  ```

  `applySeed` が無いので import で落ちる。これが Red。

- [ ] **Step 4: `scripts/generate-seed.ts` の前半（決定的乱数と SQL リテラル）を書く**

  ```ts
  import { coordinate, encodeGeohash } from '@meshimap/geo';
  import { SHOP_GEOHASH_PRECISION } from '../src/db/constants';

  /** 疑似乱数の初期シード。変えるとシードデータ全体が変わるので、変えたらテストの期待値も直す */
  const RANDOM_SEED = 20260915;

  /**
   * mulberry32。32bit の決定的な疑似乱数。
   * `Math.random` を使うと実行のたびにデータが変わり、期待値を書いたテストが書けない。
   * 暗号用途には使えないが、ここで必要なのは「毎回同じ」ことだけ。
   */
  function createRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const nextRandom = createRandom(RANDOM_SEED);

  /** 0 以上 max 未満の整数を返す */
  function randomInt(max: number): number {
    return Math.floor(nextRandom() * max);
  }

  /**
   * 配列から 1 つ選ぶ。
   * `noUncheckedIndexedAccess` が有効なので添字アクセスは `T | undefined` になる。
   * 空配列を渡した場合に黙って undefined が混ざらないよう、ここで例外にする。
   */
  function pick<T>(values: readonly T[]): T {
    const chosen = values[randomInt(values.length)];
    if (chosen === undefined) {
      throw new Error('空の配列から選ぼうとしました');
    }
    return chosen;
  }

  /** SQL の文字列リテラルにする。NULL は NULL のまま出す */
  function sqlText(value: string | null): string {
    if (value === null) {
      return 'NULL';
    }
    return `'${value.replaceAll("'", "''")}'`;
  }

  /** SQL の数値リテラルにする。NaN や Infinity が SQL に紛れ込むのを止める */
  function sqlNumber(value: number): string {
    if (!Number.isFinite(value)) {
      throw new Error(`SQL に埋め込めない数値です: ${String(value)}`);
    }
    return String(value);
  }

  /** 出力する SQL 文を貯める */
  const statements: string[] = [];

  function emit(statement: string): void {
    statements.push(statement);
  }
  ```

- [ ] **Step 5: `scripts/generate-seed.ts` の定数（エリア・ジャンル・店名・本文）を書く**

  ```ts
  type SeedArea = {
    readonly id: string;
    readonly name: string;
    readonly latitude: number;
    readonly longitude: number;
    readonly addressPrefix: string;
  };

  /** 実在する東京の 12 エリア。座標は各駅前 */
  const SEED_AREAS: readonly SeedArea[] = [
    {
      id: 'area_shibuya',
      name: '渋谷',
      latitude: 35.658034,
      longitude: 139.701636,
      addressPrefix: '東京都渋谷区道玄坂',
    },
    {
      id: 'area_shinjuku',
      name: '新宿',
      latitude: 35.689592,
      longitude: 139.700413,
      addressPrefix: '東京都新宿区西新宿',
    },
    {
      id: 'area_nakameguro',
      name: '中目黒',
      latitude: 35.644479,
      longitude: 139.699008,
      addressPrefix: '東京都目黒区上目黒',
    },
    {
      id: 'area_ebisu',
      name: '恵比寿',
      latitude: 35.64669,
      longitude: 139.710106,
      addressPrefix: '東京都渋谷区恵比寿',
    },
    {
      id: 'area_roppongi',
      name: '六本木',
      latitude: 35.662725,
      longitude: 139.73139,
      addressPrefix: '東京都港区六本木',
    },
    {
      id: 'area_marunouchi',
      name: '丸の内',
      latitude: 35.681236,
      longitude: 139.767125,
      addressPrefix: '東京都千代田区丸の内',
    },
    {
      id: 'area_ueno',
      name: '上野',
      latitude: 35.713768,
      longitude: 139.777254,
      addressPrefix: '東京都台東区上野',
    },
    {
      id: 'area_asakusa',
      name: '浅草',
      latitude: 35.710733,
      longitude: 139.798069,
      addressPrefix: '東京都台東区浅草',
    },
    {
      id: 'area_ikebukuro',
      name: '池袋',
      latitude: 35.729503,
      longitude: 139.7109,
      addressPrefix: '東京都豊島区南池袋',
    },
    {
      id: 'area_kichijoji',
      name: '吉祥寺',
      latitude: 35.70305,
      longitude: 139.57975,
      addressPrefix: '東京都武蔵野市吉祥寺本町',
    },
    {
      id: 'area_jiyugaoka',
      name: '自由が丘',
      latitude: 35.60733,
      longitude: 139.66935,
      addressPrefix: '東京都目黒区自由が丘',
    },
    {
      id: 'area_kagurazaka',
      name: '神楽坂',
      latitude: 35.70205,
      longitude: 139.73479,
      addressPrefix: '東京都新宿区神楽坂',
    },
  ];

  /** 1 エリアあたりの店舗数 */
  const SHOPS_PER_AREA = 5;

  /**
   * エリア中心からのずらし幅（度）。
   * 緯度 0.0012 度 ≒ 133m、経度 0.0015 度 ≒ 136m（東京の緯度で）。
   * 5 店が中心と四隅に散り、中心から見て 4 店が約 190m の位置に来る。
   * この配置のおかげで「半径 200m で 5 件、半径 1000m でも 5 件」という
   * 段階の切り替わりが分かりやすい期待値になる（Task 3-13 で使う）。
   */
  const SHOP_OFFSETS: readonly (readonly [number, number])[] = [
    [0, 0],
    [0.0012, 0.0015],
    [-0.0012, 0.0015],
    [0.0012, -0.0015],
    [-0.0012, -0.0015],
  ];

  type SeedGenre = { readonly id: string; readonly name: string; readonly slug: string };

  const SEED_GENRES: readonly SeedGenre[] = [
    { id: 'gnr_ramen', name: 'ラーメン', slug: 'ramen' },
    { id: 'gnr_sushi', name: '寿司', slug: 'sushi' },
    { id: 'gnr_izakaya', name: '居酒屋', slug: 'izakaya' },
    { id: 'gnr_italian', name: 'イタリアン', slug: 'italian' },
    { id: 'gnr_french', name: 'フレンチ', slug: 'french' },
    { id: 'gnr_yakiniku', name: '焼肉', slug: 'yakiniku' },
    { id: 'gnr_cafe', name: 'カフェ', slug: 'cafe' },
    { id: 'gnr_curry', name: 'カレー', slug: 'curry' },
    { id: 'gnr_soba', name: 'そば・うどん', slug: 'soba-udon' },
    { id: 'gnr_chinese', name: '中華', slug: 'chinese' },
    { id: 'gnr_yakitori', name: '焼き鳥', slug: 'yakitori' },
    { id: 'gnr_bar', name: 'バー', slug: 'bar' },
  ];

  /** 表記とカナ読みの組。`shops.name_kana` を埋めるために両方持つ */
  type NamePart = { readonly text: string; readonly kana: string };

  /** ジャンルごとの店名の前半分 */
  const SHOP_NAME_PREFIXES: Readonly<Record<string, readonly NamePart[]>> = {
    gnr_ramen: [
      { text: '麺屋', kana: 'メンヤ' },
      { text: '中華そば', kana: 'チュウカソバ' },
      { text: 'らぁ麺', kana: 'ラァメン' },
    ],
    gnr_sushi: [
      { text: '鮨', kana: 'スシ' },
      { text: '寿司処', kana: 'スシドコロ' },
      { text: '江戸前', kana: 'エドマエ' },
    ],
    gnr_izakaya: [
      { text: '酒処', kana: 'サケドコロ' },
      { text: '居酒屋', kana: 'イザカヤ' },
      { text: '呑み処', kana: 'ノミドコロ' },
    ],
    gnr_italian: [
      { text: 'トラットリア', kana: 'トラットリア' },
      { text: 'オステリア', kana: 'オステリア' },
      { text: 'リストランテ', kana: 'リストランテ' },
    ],
    gnr_french: [
      { text: 'ビストロ', kana: 'ビストロ' },
      { text: 'ブラッスリー', kana: 'ブラッスリー' },
      { text: 'メゾン', kana: 'メゾン' },
    ],
    gnr_yakiniku: [
      { text: '焼肉', kana: 'ヤキニク' },
      { text: '炭火焼肉', kana: 'スミビヤキニク' },
      { text: 'ホルモン', kana: 'ホルモン' },
    ],
    gnr_cafe: [
      { text: '珈琲', kana: 'コーヒー' },
      { text: 'カフェ', kana: 'カフェ' },
      { text: '喫茶', kana: 'キッサ' },
    ],
    gnr_curry: [
      { text: 'カレー', kana: 'カレー' },
      { text: 'スパイス', kana: 'スパイス' },
      { text: '印度料理', kana: 'インドリョウリ' },
    ],
    gnr_soba: [
      { text: '蕎麦', kana: 'ソバ' },
      { text: '手打ちそば', kana: 'テウチソバ' },
      { text: 'うどん', kana: 'ウドン' },
    ],
    gnr_chinese: [
      { text: '中華料理', kana: 'チュウカリョウリ' },
      { text: '四川', kana: 'シセン' },
      { text: '町中華', kana: 'マチチュウカ' },
    ],
    gnr_yakitori: [
      { text: '焼き鳥', kana: 'ヤキトリ' },
      { text: '鳥政', kana: 'トリマサ' },
      { text: '串焼き', kana: 'クシヤキ' },
    ],
    gnr_bar: [
      { text: 'バー', kana: 'バー' },
      { text: 'スタンド', kana: 'スタンド' },
      { text: 'ラウンジ', kana: 'ラウンジ' },
    ],
  };

  /** 店名の後ろ半分 */
  const SHOP_NAME_SUFFIXES: readonly NamePart[] = [
    { text: 'こうじ', kana: 'コウジ' },
    { text: 'たなか', kana: 'タナカ' },
    { text: 'やまと', kana: 'ヤマト' },
    { text: 'あおい', kana: 'アオイ' },
    { text: 'みどり', kana: 'ミドリ' },
    { text: 'つばき', kana: 'ツバキ' },
    { text: 'ひなた', kana: 'ヒナタ' },
    { text: 'こはる', kana: 'コハル' },
    { text: 'すみれ', kana: 'スミレ' },
    { text: 'かえで', kana: 'カエデ' },
  ];

  /** 説明文のテンプレート。`{genre}` をジャンル名で置換する */
  const DESCRIPTION_TEMPLATES: readonly string[] = [
    '素材にこだわった{genre}を、落ち着いた空間で提供しています。',
    '地元で 20 年愛される{genre}の専門店。昼夜ともに賑わいます。',
    'カウンター中心の小さな{genre}店。ひとりでも入りやすい造りです。',
    '旬の食材を使った{genre}が評判。記念日の利用も多い一軒です。',
    '深夜まで営業している{genre}店。仕事帰りの一杯にどうぞ。',
  ];

  /** レビュー本文のテンプレート */
  const REVIEW_BODY_TEMPLATES: readonly string[] = [
    'ランチで訪問しました。値段の割に満足度が高く、また来たいと思える味でした。',
    '友人と 2 人で利用。店員さんの対応が丁寧で、料理が出てくるのも早かったです。',
    '平日の夜に訪問。席の間隔が広く、落ち着いて食事ができました。',
    '看板メニューを注文。想像より量が多く、食べ応えがありました。',
    '雰囲気は良かったのですが、混雑時は少し待ちます。時間に余裕を持って。',
  ];

  /** レビューを書く利用者の人数 */
  const REVIEW_USER_COUNT = 20;
  /** 1 店舗あたりのレビュー数の上限 */
  const REVIEWS_PER_SHOP_MAX = 4;
  /** 曜日の数 */
  const DAYS_PER_WEEK = 7;
  /** 1 時間の分数 */
  const MINUTES_PER_HOUR = 60;
  /** 1 店舗あたりの写真枚数 */
  const PHOTOS_PER_SHOP = 2;
  ```

- [ ] **Step 6: 出力の前半（冪等化 → ジャンル → エリア → 利用者 → 店舗）を書く**

  ```ts
  // ─────────────────────────── 冪等化 ───────────────────────────
  // 何度流しても同じ状態になるよう、まず全部消す。
  // 削除順は「参照している側から」。`defer_foreign_keys` を立てておけば
  // 途中の順序ずれで FK 違反にならず、文の並べ替えに強くなる。
  emit('PRAGMA defer_foreign_keys = true;');
  for (const tableName of [
    'audit_logs',
    'notifications',
    'shop_applications',
    'reports',
    'list_items',
    'lists',
    'favorites',
    'reservations',
    'review_replies',
    'review_photos',
    'reviews',
    'seat_settings',
    'menu_items',
    'menu_categories',
    'shop_photos',
    'shop_closures',
    'shop_hours',
    'shops',
    'areas',
    'genres',
    'profiles',
    'session',
    'account',
    'verification',
    'user',
  ]) {
    emit(`DELETE FROM \`${tableName}\`;`);
  }

  // ─────────────────────────── ジャンル ───────────────────────────
  for (const [index, genre] of SEED_GENRES.entries()) {
    emit(
      `INSERT INTO \`genres\` (\`id\`, \`name\`, \`slug\`, \`sort_order\`) VALUES (${sqlText(genre.id)}, ${sqlText(genre.name)}, ${sqlText(genre.slug)}, ${sqlNumber(index)});`,
    );
  }

  // ─────────────────────────── エリア ───────────────────────────
  // `areas` に sort_order は無い（master.ts の定義を確認のこと）。
  // 無い列を書くと "table areas has no column named sort_order" で落ちる。
  for (const area of SEED_AREAS) {
    emit(
      `INSERT INTO \`areas\` (\`id\`, \`name\`, \`prefecture\`) VALUES (${sqlText(area.id)}, ${sqlText(area.name)}, ${sqlText('東京都')});`,
    );
  }

  // ─────────────────────────── 利用者 ───────────────────────────
  type SeedUser = {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly role: string;
  };
  const seedUsers: SeedUser[] = [];

  seedUsers.push({
    id: 'usr_admin',
    name: '運営 管理者',
    email: 'admin@meshimap.example',
    role: 'admin',
  });
  for (const [index, area] of SEED_AREAS.entries()) {
    seedUsers.push({
      id: `usr_owner_${String(index + 1).padStart(2, '0')}`,
      name: `${area.name} オーナー`,
      email: `owner${String(index + 1).padStart(2, '0')}@meshimap.example`,
      role: 'owner',
    });
  }
  for (let index = 0; index < REVIEW_USER_COUNT; index += 1) {
    seedUsers.push({
      id: `usr_member_${String(index + 1).padStart(2, '0')}`,
      name: `テスト利用者 ${String(index + 1).padStart(2, '0')}`,
      email: `member${String(index + 1).padStart(2, '0')}@meshimap.example`,
      role: 'user',
    });
  }

  // `account` は作らない。Better Auth の認証情報はハッシュを含むため、
  // 平文のシードで作ると「開発環境の既知パスワード」が生まれる。
  // ログインが要るときは Phase 5 のサインアップ API を通す。
  for (const seedUser of seedUsers) {
    emit(
      `INSERT INTO \`user\` (\`id\`, \`name\`, \`email\`, \`email_verified\`) VALUES (${sqlText(seedUser.id)}, ${sqlText(seedUser.name)}, ${sqlText(seedUser.email)}, 1);`,
    );
    emit(
      `INSERT INTO \`profiles\` (\`user_id\`, \`display_name\`, \`role\`) VALUES (${sqlText(seedUser.id)}, ${sqlText(seedUser.name)}, ${sqlText(seedUser.role)});`,
    );
  }

  // ─────────────────────────── 店舗 ───────────────────────────
  type SeedShop = {
    readonly id: string;
    readonly name: string;
    readonly genreId: string;
    readonly areaId: string;
    readonly latitude: number;
    readonly longitude: number;
    readonly geohash: string;
  };
  const seedShops: SeedShop[] = [];

  for (const [areaIndex, area] of SEED_AREAS.entries()) {
    for (let shopIndex = 0; shopIndex < SHOPS_PER_AREA; shopIndex += 1) {
      const offset = SHOP_OFFSETS[shopIndex];
      if (offset === undefined) {
        throw new Error(`ずらし幅が足りません: ${String(shopIndex)}`);
      }
      // 12 エリア × 5 店 = 60 を 12 ジャンルで割ると、ちょうど 5 件ずつに散る
      const genre = SEED_GENRES[(areaIndex * SHOPS_PER_AREA + shopIndex) % SEED_GENRES.length];
      if (genre === undefined) {
        throw new Error('ジャンルが空です');
      }
      // 座標は小数 6 桁に丸める。桁が揺れると geohash も揺れ、テストの期待値が書けない
      const latitude = Number((area.latitude + offset[0]).toFixed(6));
      const longitude = Number((area.longitude + offset[1]).toFixed(6));
      // geohash は必ずここで計算する。SQL 側に計算手段は無い
      const geohash = encodeGeohash(coordinate(latitude, longitude), SHOP_GEOHASH_PRECISION);
      const prefixes = SHOP_NAME_PREFIXES[genre.id];
      if (prefixes === undefined) {
        throw new Error(`店名の前半分が未定義です: ${genre.id}`);
      }
      const shopNumber = areaIndex * SHOPS_PER_AREA + shopIndex + 1;
      const shopId = `shp_${String(shopNumber).padStart(3, '0')}`;
      const namePrefix = pick(prefixes);
      const nameSuffix = pick(SHOP_NAME_SUFFIXES);
      const name = `${namePrefix.text} ${nameSuffix.text}`;
      const nameKana = `${namePrefix.kana} ${nameSuffix.kana}`;
      const ownerId = `usr_owner_${String(areaIndex + 1).padStart(2, '0')}`;
      const description = pick(DESCRIPTION_TEMPLATES).replaceAll('{genre}', genre.name);
      const lunchMin = 800 + randomInt(5) * 100;
      const lunchMax = lunchMin + 400 + randomInt(5) * 100;
      const dinnerMin = 2500 + randomInt(6) * 500;
      const dinnerMax = dinnerMin + 1500 + randomInt(6) * 500;

      seedShops.push({
        id: shopId,
        name,
        genreId: genre.id,
        areaId: area.id,
        latitude,
        longitude,
        geohash,
      });

      emit(
        `INSERT INTO \`shops\` (\`id\`, \`owner_id\`, \`name\`, \`name_kana\`, \`genre_id\`, \`area_id\`, \`description\`, \`postal_code\`, \`address\`, \`lat\`, \`lng\`, \`geohash\`, \`phone\`, \`budget_lunch_min\`, \`budget_lunch_max\`, \`budget_dinner_min\`, \`budget_dinner_max\`, \`status\`) VALUES (` +
          [
            sqlText(shopId),
            sqlText(ownerId),
            sqlText(name),
            sqlText(nameKana),
            sqlText(genre.id),
            sqlText(area.id),
            sqlText(description),
            // `ck_shops_postal_code_format` が NNN-NNNN を要求するので書式を守る
            sqlText(`1${String(50 + areaIndex).padStart(2, '0')}-000${String(shopIndex + 1)}`),
            sqlText(
              `${area.addressPrefix}${String(shopIndex + 1)}-${String(areaIndex + 1)}-${String(shopNumber)}`,
            ),
            sqlNumber(latitude),
            sqlNumber(longitude),
            sqlText(geohash),
            sqlText(`03-${String(1000 + shopNumber)}-${String(2000 + shopNumber)}`),
            sqlNumber(lunchMin),
            sqlNumber(lunchMax),
            sqlNumber(dinnerMin),
            sqlNumber(dinnerMax),
            sqlText('published'),
          ].join(', ') +
          ');',
      );
    }
  }
  ```

- [ ] **Step 7: 出力の後半（営業時間 → 写真 → メニュー・席 → レビュー → 集計）を書く**

  ```ts
  // ─────────────────────────── 営業時間 ───────────────────────────
  for (const seedShop of seedShops) {
    // 定休日を 1 日だけ持たせる。日曜(0)は避けて月〜土から選ぶ
    const closedDay = 1 + randomInt(DAYS_PER_WEEK - 1);
    const openHour = 11;
    const closeHour = 22 + randomInt(4);
    for (let dayOfWeek = 0; dayOfWeek < DAYS_PER_WEEK; dayOfWeek += 1) {
      const isClosed = dayOfWeek === closedDay;
      // 定休日は時刻を NULL にする。`ck_shop_hours_closed_coherence` が両立を禁じている
      emit(
        `INSERT INTO \`shop_hours\` (\`id\`, \`shop_id\`, \`day_of_week\`, \`open_minute\`, \`close_minute\`, \`is_closed\`) VALUES (` +
          [
            sqlText(`shh_${seedShop.id}_${String(dayOfWeek)}`),
            sqlText(seedShop.id),
            sqlNumber(dayOfWeek),
            isClosed ? 'NULL' : sqlNumber(openHour * MINUTES_PER_HOUR),
            isClosed ? 'NULL' : sqlNumber(closeHour * MINUTES_PER_HOUR),
            isClosed ? '1' : '0',
          ].join(', ') +
          ');',
      );
    }
  }

  // ─────────────────────────── 写真 ───────────────────────────
  // R2 のキーだけを入れる。実体のアップロードは Phase 8 で行う。
  // キーは `ck_shop_photos_r2_key_format`（小文字英数と / . _ - のみ）を満たす形にする。
  for (const seedShop of seedShops) {
    for (let photoIndex = 0; photoIndex < PHOTOS_PER_SHOP; photoIndex += 1) {
      emit(
        `INSERT INTO \`shop_photos\` (\`id\`, \`shop_id\`, \`r2_key\`, \`caption\`, \`sort_order\`, \`is_cover\`) VALUES (` +
          [
            sqlText(`shp_photo_${seedShop.id}_${String(photoIndex)}`),
            sqlText(seedShop.id),
            sqlText(`shops/${seedShop.id}/photo-${String(photoIndex)}.jpg`),
            sqlText(photoIndex === 0 ? '外観' : '看板メニュー'),
            sqlNumber(photoIndex),
            // カバーは 1 店 1 枚まで（`uq_shop_photos_cover` の部分ユニーク索引）
            photoIndex === 0 ? '1' : '0',
          ].join(', ') +
          ');',
      );
    }
  }

  // ─────────────────────────── メニュー・席 ───────────────────────────
  const MENU_CATEGORY_NAMES: readonly string[] = ['おすすめ', '一品料理'];
  const MENU_ITEM_NAMES: readonly string[] = [
    '本日のおすすめ',
    '定番セット',
    '季節の一皿',
    '自家製デザート',
  ];
  const MENU_ITEMS_PER_CATEGORY = 2;
  for (const seedShop of seedShops) {
    for (const [categoryIndex, categoryName] of MENU_CATEGORY_NAMES.entries()) {
      const categoryId = `mnc_${seedShop.id}_${String(categoryIndex)}`;
      emit(
        `INSERT INTO \`menu_categories\` (\`id\`, \`shop_id\`, \`name\`, \`sort_order\`) VALUES (${sqlText(categoryId)}, ${sqlText(seedShop.id)}, ${sqlText(categoryName)}, ${sqlNumber(categoryIndex)});`,
      );
      const itemNames = MENU_ITEM_NAMES.slice(
        categoryIndex * MENU_ITEMS_PER_CATEGORY,
        categoryIndex * MENU_ITEMS_PER_CATEGORY + MENU_ITEMS_PER_CATEGORY,
      );
      for (const [itemIndex, itemName] of itemNames.entries()) {
        const price = 800 + randomInt(12) * 100;
        // `menu_items` は (shop_id, category_id) の複合 FK を持つので、
        // 同じ店のカテゴリ以外を指すと FK 違反になる
        emit(
          `INSERT INTO \`menu_items\` (\`id\`, \`shop_id\`, \`category_id\`, \`name\`, \`price\`, \`description\`, \`is_recommended\`) VALUES (` +
            [
              sqlText(`mni_${seedShop.id}_${String(categoryIndex)}_${String(itemIndex)}`),
              sqlText(seedShop.id),
              sqlText(categoryId),
              sqlText(itemName),
              sqlNumber(price),
              sqlText(null),
              categoryIndex === 0 && itemIndex === 0 ? '1' : '0',
            ].join(', ') +
            ');',
        );
      }
    }
    emit(
      `INSERT INTO \`seat_settings\` (\`shop_id\`, \`capacity\`, \`slot_minutes\`, \`max_parallel\`, \`accepts_reservation\`) VALUES (${sqlText(seedShop.id)}, ${sqlNumber(10 + randomInt(30))}, 90, ${sqlNumber(1 + randomInt(3))}, 1);`,
    );
  }

  // ─────────────────────────── レビュー ───────────────────────────
  /** 訪問日として使う固定日。実行日時に依存させないことで決定的になる */
  const REVIEW_VISITED_DATES: readonly string[] = [
    '2026-06-14',
    '2026-07-05',
    '2026-07-21',
    '2026-08-09',
    '2026-08-30',
  ];
  let reviewCount = 0;
  for (const seedShop of seedShops) {
    const reviewsForShop = randomInt(REVIEWS_PER_SHOP_MAX + 1);
    // 同じ店に同じ人が 2 件書けない（`uq_reviews_shop_user`）ので、使った人を記録する
    const usedUserIds = new Set<string>();
    for (let reviewIndex = 0; reviewIndex < reviewsForShop; reviewIndex += 1) {
      let userId = `usr_member_${String(1 + randomInt(REVIEW_USER_COUNT)).padStart(2, '0')}`;
      while (usedUserIds.has(userId)) {
        userId = `usr_member_${String(1 + randomInt(REVIEW_USER_COUNT)).padStart(2, '0')}`;
      }
      usedUserIds.add(userId);
      reviewCount += 1;
      emit(
        `INSERT INTO \`reviews\` (\`id\`, \`shop_id\`, \`user_id\`, \`rating\`, \`body\`, \`visited_on\`, \`budget\`, \`status\`) VALUES (` +
          [
            sqlText(`rvw_${String(reviewCount).padStart(4, '0')}`),
            sqlText(seedShop.id),
            sqlText(userId),
            // 3〜5 にする。1〜2 ばかりだと平均が実運用とかけ離れる
            sqlNumber(3 + randomInt(3)),
            sqlText(pick(REVIEW_BODY_TEMPLATES)),
            sqlText(pick(REVIEW_VISITED_DATES)),
            sqlNumber(1000 + randomInt(10) * 500),
            sqlText('published'),
          ].join(', ') +
          ');',
      );
    }
  }

  // ─────────────────────────── 集計値の反映 ───────────────────────────
  // rating_avg / rating_count はレビューから計算する。
  // アプリ側の更新処理（Phase 6）と同じ式にしておき、ズレたら seed.test.ts が落ちる。
  emit(
    "UPDATE `shops` SET `rating_count` = (SELECT count(*) FROM `reviews` WHERE `reviews`.`shop_id` = `shops`.`id` AND `reviews`.`status` = 'published'), `rating_avg` = coalesce((SELECT round(avg(`rating`), 2) FROM `reviews` WHERE `reviews`.`shop_id` = `shops`.`id` AND `reviews`.`status` = 'published'), 0);",
  );

  // ─────────────────────────── 統計の更新 ───────────────────────────
  // ANALYZE を打たないと SQLite は既定の見積もりで索引を選び、9 セルの OR 条件が
  // idx_shops_status_rating の 1 本走査に落ちる。打つと MULTI-INDEX OR に変わり
  // idx_shops_status_geohash を 9 本使う計画になる（F69）。
  // sqlite_stat1 は冒頭の DELETE 対象に入っていないので、2 回目以降も統計は残る。
  emit('ANALYZE;');

  process.stdout.write(`${statements.join('\n')}\n`);
  process.stderr.write(
    `店舗 ${String(seedShops.length)} 件 / レビュー ${String(reviewCount)} 件 / SQL ${String(statements.length)} 文\n`,
  );
  ```

- [ ] **Step 8: `src/db/testing/local-d1.ts` に `applySeed()` を足す**

  マイグレーションと違い、シードは `--> statement-breakpoint` ではなく 1 行 1 文で出す。
  分け方が違うので関数も分ける。

  ```ts
  /** seeds/seed.sql の位置（src/db/testing/ からの相対） */
  const SEED_FILE_PATH = join(CURRENT_DIR, '..', '..', '..', 'seeds', 'seed.sql');

  /**
   * seeds/seed.sql を 1 行ずつ流し込み、実行した文の数を返す。
   * 生成側（scripts/generate-seed.ts）が 1 文を必ず 1 行で出す約束になっているので、
   * ここでは改行で割るだけでよい。複数行に跨る文を足したくなったら生成側を直すこと。
   */
  export async function applySeed(d1: D1Database): Promise<number> {
    const statements = readFileSync(SEED_FILE_PATH, 'utf8')
      .split('\n')
      .map((rawStatement) => rawStatement.trim())
      .filter((statement) => statement.length > 0 && !LINE_COMMENT_PATTERN.test(statement));

    // applyMigrations と同じく 1 往復で流す。1 文ずつ呼ぶと 1247 往復になる（F73）
    return execAtOnce(d1, statements);
  }
  ```

- [ ] **Step 9: シードを生成してローカル D1 に流す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  mkdir -p seeds
  npm run db:seed:generate
  ```

  標準エラーに `店舗 60 件 / レビュー 109 件 / SQL 1247 文` と出る。
  この 3 つの数字が違ったら、シードの内容が変わっている。

  ```bash
  npm run db:reset:local
  npx wrangler d1 execute meshimap-db --local --json \
    --command="SELECT (SELECT count(*) FROM shops) AS shops, (SELECT count(*) FROM reviews) AS reviews, (SELECT count(*) FROM shops_fts) AS fts"
  ```

  `{"shops": 60, "reviews": 109, "fts": 60}` になる。
  **`fts` が 0 なら Task 3-11 のトリガーが効いていない。** その場合は
  `0001_shops_fts.sql` が適用されているか（`d1_migrations` を見る）から疑う。

- [ ] **Step 10: テストを通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/seed.test.ts
  ```

  16 件が緑になる。

- [ ] **Step 11: 冪等性を手でも確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  npm run db:seed:local >/dev/null
  npm run db:seed:local >/dev/null
  npx wrangler d1 execute meshimap-db --local --json \
    --command="SELECT count(*) AS shops, (SELECT round(sum(rating_avg), 2) FROM shops) AS sum_avg FROM shops"
  ```

  2 回流しても `{"shops": 60, "sum_avg": 179.49}` のまま（F62）。
  `sum_avg` まで一致することで、「件数は同じだが中身が違う」型の壊れ方も弾ける。

- [ ] **Step 12: わざと壊してテストが検知することを確認する**

  1. `RANDOM_SEED` を `20260916` に変える
     → レビュー件数と `rating_count > 0` の店舗数が変わって落ちる。
     **決定性がテストで守られていることの確認**
  2. 冒頭の `DELETE FROM` 群を消す
     → 「2 回流しても件数が変わらない」が `UNIQUE constraint failed: shops.id` で落ちる
  3. `encodeGeohash(...)` を固定文字列 `'xn76fgr'` に置き換える
     → 「渋谷 1 号店の geohash」は通ってしまうが、Task 3-13 の半径 1000m が
     60 件になって落ちる。**シード単体では気付けない壊れ方がある**ことを体感する
  4. `SHOP_OFFSETS` の 2 つ目を `[0.02, 0.02]` にする
     → Task 3-13 の半径 200m が 5 → 4 件になって落ちる
  5. `sqlText` の `replaceAll("'", "''")` を消す
     → 今のデータにアポストロフィは無いので通ってしまう。
     テンプレートに `O'Brien` を 1 つ足してから壊し直し、構文エラーになることを見る
  6. 店舗の `status` を `'draft'` にする
     → 「全店舗が published」と Task 3-13 の全行が落ちる
  7. 末尾の `emit('ANALYZE;')` を消す
     → 件数のテストは全部通るが、Task 3-13 の
     「9 セルの OR が MULTI-INDEX OR になる」が
     `idx_shops_status_rating` を選んで落ちる（F69）

  **7 つすべて確認したら元に戻し、`npm run db:seed:generate` からやり直して緑に戻す。**

- [ ] **Step 13: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

  Step 1 で `include` に `scripts/` を足したので、`generate-seed.ts` もここで検査される。

- [ ] **Step 14: コミット**

  `feat(api): 東京 12 エリア 60 店舗の決定的シードを追加` として報告する。

---

### Task 3-13: 3 段構え地理空間検索の実装と検証

設計書 §3.1 の 3 段階を実装し、Task 3-12 で入れた 60 店舗に対して
**正しい件数を返すこと**を数字で確認する。

| 段  | 何をするか                         | どこでやるか   | 理由                                                                                     |
| --- | ---------------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| 1   | geohash の前方一致で候補を粗く絞る | **SQL**        | 索引が効く唯一の段。ここで行数を減らす                                                   |
| 2   | 緯度経度の矩形で切る               | **TypeScript** | SQL に混ぜるとプランナが `idx_shops_lat_lng` を選び、geohash 索引が使われなくなる（F68） |
| 3   | Haversine で厳密な距離を出す       | **TypeScript** | D1 の SQL に三角関数が無い                                                               |

#### 実装前に踏んではいけない罠が 3 つある

1. **`GLOB` は索引が効くかどうかがバインド値に左右される（F66）。**
   「`GLOB ?` は索引が効かない」と書いていた時期があるが**それは誤り**で、
   バインド値が前方一致パターンなら `MULTI-INDEX OR … idx_shops_status_geohash` になり、
   範囲比較とまったく同じプランを出す。
   それでも **`GLOB` ではなく範囲比較 `geohash >= ? AND geohash < ?` を使う。**
   `GLOB ?` は先頭ワイルドカード（`*n76f*`）を渡されると `SCAN shops` に落ちるのに対し、
   範囲比較は値に関係なく必ず索引の範囲検索になる。
   **選ぶ理由は速度ではなく、プランが実行時の値に依存しないこと。**
   base32 の最大文字は `z`(0x7A) なので、上限を `prefix + '{'`(0x7B) にすれば
   「prefix で始まる文字列」全体をちょうど覆える。

2. **`UNION` で 9 セルを並べる実装は D1 では動かない（F67）。**
   D1 の `SQLITE_MAX_COMPOUND_SELECT` は 5 で、6 項以上は
   `too many terms in compound SELECT` になる。`OR` で並べるしかない。

3. **矩形条件を同じ SQL に書くと geohash 索引が主役から降りる（F68）。**
   30,060 行で試すと `idx_shops_lat_lng (lat>? AND lat<?)` が選ばれ、
   geohash の OR は後置フィルタになる。結果は同じだが、
   セル数を増減させても効き方が変わらなくなり、設計の意図が消える。
   **矩形は TypeScript 側でやる。**

**Files:**

- Create: `apps/api/src/db/queries/nearby-shops.ts`
- Create: `apps/api/src/db/queries/nearby-shops.test.ts`

**Interfaces:**

- Consumes:
  - `cellsForRadius(center: Coordinate, radiusM: number): readonly Geohash[]`（`@meshimap/geo`）
  - `boundingBox(center: Coordinate, radiusM: number): BoundingBox`（`@meshimap/geo`）
  - `isWithinBounds(target: Coordinate, bounds: BoundingBox): boolean`（`@meshimap/geo`）
  - `distanceMeters(from: Coordinate, to: Coordinate): number`（`@meshimap/geo`）
  - `Database` / `createDatabase(d1: D1Database): Database`（Task 3-10）
  - `SHOP_STATUS_PUBLISHED: 'published'`（Task 3-1）
- Produces:
  - `geohashPrefixCondition(cell: string): SQL`
  - `findNearbyShops(db: Database, search: NearbyShopSearch): Promise<readonly NearbyShop[]>`
  - `type NearbyShop` / `type NearbyShopSearch`

- [ ] **Step 1: 失敗するテストを書く（`src/db/queries/nearby-shops.test.ts`）— 件数編**

  期待値はすべて実測値（F64）。半径ごとに 3 段の絞り込みがどう効くかを、
  **段ごとの件数まで**テストに書く。総件数だけだと、段 1 が壊れて全件返していても
  段 3 が拾ってくれるので気付けない。

  ```ts
  import { and, eq, or } from 'drizzle-orm';
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { boundingBox, cellsForRadius, coordinate, isWithinBounds } from '@meshimap/geo';
  import { createDatabase, type Database } from '../client';
  import { shops } from '../schema/shop';
  import { applySeed, createMigratedD1, type LocalD1 } from '../testing/local-d1';
  import { findNearbyShops, geohashPrefixCondition } from './nearby-shops';

  let local: LocalD1;
  let db: Database;

  /** 渋谷駅の座標。シードの shp_001 がちょうどこの位置にいる */
  const SHIBUYA_STATION = coordinate(35.658034, 139.701636);

  /** 件数を数えるだけのテストで使う、実質無制限の上限 */
  const NO_LIMIT = 1000;

  beforeAll(async () => {
    local = await createMigratedD1();
    await applySeed(local.d1);
    db = createDatabase(local.d1);
  }, 120_000);

  afterAll(async () => {
    await local.dispose();
  });

  /** 段 1 だけを実行して候補件数を返す */
  async function countStage1(radiusM: number): Promise<number> {
    const cells = cellsForRadius(SHIBUYA_STATION, radiusM);
    const rows = await db
      .select({ id: shops.id })
      .from(shops)
      .where(
        and(
          eq(shops.status, 'published'),
          or(...cells.map((cell) => geohashPrefixCondition(cell))),
        ),
      );

    return rows.length;
  }

  /** 段 1 → 段 2 まで実行して候補件数を返す */
  async function countStage2(radiusM: number): Promise<number> {
    const cells = cellsForRadius(SHIBUYA_STATION, radiusM);
    const bounds = boundingBox(SHIBUYA_STATION, radiusM);
    const rows = await db
      .select({ id: shops.id, latitude: shops.lat, longitude: shops.lng })
      .from(shops)
      .where(
        and(
          eq(shops.status, 'published'),
          or(...cells.map((cell) => geohashPrefixCondition(cell))),
        ),
      );

    return rows.filter((row) => isWithinBounds(coordinate(row.latitude, row.longitude), bounds))
      .length;
  }

  async function countStage3(radiusM: number): Promise<number> {
    const rows = await findNearbyShops(db, {
      center: SHIBUYA_STATION,
      radiusM,
      limit: NO_LIMIT,
      genreId: null,
    });

    return rows.length;
  }

  describe('3 段階の絞り込み（渋谷駅起点・60 店舗）', () => {
    // 半径 → [セル数, 段 1, 段 2, 段 3]
    const EXPECTATIONS: readonly (readonly [number, number, number, number, number])[] = [
      [200, 9, 5, 5, 5],
      [500, 9, 5, 5, 5],
      [1000, 9, 35, 5, 5],
      [2000, 9, 35, 15, 15],
      [3000, 9, 35, 20, 20],
      [5000, 9, 60, 28, 25],
    ];

    for (const [radiusM, cellCount, stage1, stage2, stage3] of EXPECTATIONS) {
      it(`半径 ${String(radiusM)}m: セル ${String(cellCount)} 個 → ${String(stage1)} → ${String(stage2)} → ${String(stage3)} 件`, async () => {
        expect(cellsForRadius(SHIBUYA_STATION, radiusM)).toHaveLength(cellCount);
        expect(await countStage1(radiusM)).toBe(stage1);
        expect(await countStage2(radiusM)).toBe(stage2);
        expect(await countStage3(radiusM)).toBe(stage3);
      });
    }

    it('半径 5000m では矩形と厳密判定で件数が変わる（Haversine が効いている）', async () => {
      // 28 → 25。矩形の四隅にいる 3 店が円の外に落ちる。
      // ここが同じ数になったら、段 3 が素通しになっている疑いがある
      expect(await countStage2(5000)).toBe(28);
      expect(await countStage3(5000)).toBe(25);
    });

    it('半径 1000m は段 1 で 35 件まで広がるが段 2 で 5 件に落ちる', async () => {
      // 精度 5 のセルは約 4.9km 四方なので、隣接 9 セルは半径 1km より遥かに広い。
      // 「geohash だけでは絞り切れない」ことを数字で示すケース
      expect(await countStage1(1000)).toBe(35);
      expect(await countStage2(1000)).toBe(5);
    });
  });
  ```

- [ ] **Step 2: 失敗するテストを書く（同じファイル）— 並び順・絞り込み・索引編**

  ```ts
  describe('findNearbyShops の返し方', () => {
    it('距離の昇順で返る', async () => {
      const rows = await findNearbyShops(db, {
        center: SHIBUYA_STATION,
        radiusM: 5000,
        limit: NO_LIMIT,
        genreId: null,
      });

      const distances = rows.map((row) => row.distanceM);

      expect(distances).toEqual([...distances].sort((left, right) => left - right));
    });

    it('渋谷駅直上の店が先頭で、距離は 0m', async () => {
      const rows = await findNearbyShops(db, {
        center: SHIBUYA_STATION,
        radiusM: 200,
        limit: NO_LIMIT,
        genreId: null,
      });

      expect(rows[0]?.id).toBe('shp_001');
      expect(rows[0]?.distanceM).toBe(0);
    });

    it('limit で件数を切る（切ったあとも近い順のまま）', async () => {
      const rows = await findNearbyShops(db, {
        center: SHIBUYA_STATION,
        radiusM: 5000,
        limit: 3,
        genreId: null,
      });

      expect(rows.map((row) => row.id)).toEqual(['shp_001', 'shp_002', 'shp_004']);
    });

    it('ジャンルで絞り込める', async () => {
      const ramen = await findNearbyShops(db, {
        center: SHIBUYA_STATION,
        radiusM: 5000,
        limit: NO_LIMIT,
        genreId: 'gnr_ramen',
      });
      const sushi = await findNearbyShops(db, {
        center: SHIBUYA_STATION,
        radiusM: 5000,
        limit: NO_LIMIT,
        genreId: 'gnr_sushi',
      });

      expect(ramen.map((row) => row.id)).toEqual(['shp_001', 'shp_013', 'shp_025']);
      expect(sushi.map((row) => row.id)).toEqual(['shp_002', 'shp_014']);
    });

    it('店が 1 軒も無い場所では空配列を返す（例外にしない）', async () => {
      const sapporo = coordinate(43.06417, 141.34694);

      const rows = await findNearbyShops(db, {
        center: sapporo,
        radiusM: 5000,
        limit: NO_LIMIT,
        genreId: null,
      });

      expect(rows).toEqual([]);
    });

    it('評価値も一緒に返る（一覧表示で N+1 を作らないため）', async () => {
      const rows = await findNearbyShops(db, {
        center: SHIBUYA_STATION,
        radiusM: 200,
        limit: 1,
        genreId: null,
      });

      expect(rows[0]).toMatchObject({
        id: 'shp_001',
        areaId: 'area_shibuya',
        genreId: 'gnr_ramen',
        latitude: 35.658034,
        longitude: 139.701636,
      });
      expect(typeof rows[0]?.ratingAvg).toBe('number');
      expect(typeof rows[0]?.ratingCount).toBe('number');
    });
  });

  describe('geohashPrefixCondition の境界', () => {
    /** セル直後が base32 の最大・最小文字になる geohash を手で作って確かめる */
    const EDGE_SHOPS: readonly (readonly [string, string])[] = [
      ['edge_z', 'xn76fzz'],
      ['edge_0', 'xn76f00'],
      ['edge_next', 'xn76g00'],
    ];

    beforeAll(async () => {
      for (const [id, geohash] of EDGE_SHOPS) {
        await local.d1
          .prepare(
            "INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash, status) VALUES (?, '境界テスト', 'gnr_ramen', 'area_shibuya', '東京都', 35.66, 139.70, ?, 'published')",
          )
          .bind(id, geohash)
          .run();
      }
    });

    it('セル直後が z の店も 0 の店も拾い、隣のセルは拾わない', async () => {
      const rows = await db
        .select({ id: shops.id, geohash: shops.geohash })
        .from(shops)
        .where(and(eq(shops.status, 'published'), geohashPrefixCondition('xn76f')));

      const ids = rows.map((row) => row.id);

      // xn76fzz は上限が '{' でないと範囲から落ちる
      expect(ids).toContain('edge_z');
      expect(ids).toContain('edge_0');
      // xn76g00 は隣のセル。'{' より大きいので入らない
      expect(ids).not.toContain('edge_next');
      // 取りこぼしも取りすぎも無いことを、前方一致そのもので二重に確かめる
      expect(rows.every((row) => row.geohash.startsWith('xn76f'))).toBe(true);
      expect(rows).toHaveLength(10);
    });
  });

  describe('段 1 のクエリが索引を使う', () => {
    it('9 セルの OR が MULTI-INDEX OR で 9 本とも idx_shops_status_geohash を使う', async () => {
      const cells = cellsForRadius(SHIBUYA_STATION, 1000);
      const compiled = db
        .select({ id: shops.id })
        .from(shops)
        .where(
          and(
            eq(shops.status, 'published'),
            or(...cells.map((cell) => geohashPrefixCondition(cell))),
          ),
        )
        .toSQL();

      const plan = await local.d1
        .prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
        .bind(...compiled.params)
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).toContain('MULTI-INDEX OR');
      expect(detail.match(/idx_shops_status_geohash/g)).toHaveLength(9);
      expect(detail).not.toContain('SCAN shops');
    });

    it('GLOB はバインド値が前方一致パターンなら索引を使う（範囲比較と同じプランになる）', async () => {
      // 「GLOB はバインド変数だと索引が効かない」は誤り。SQLite の LIKE 最適化は
      // パターンが実行時に前方一致だと分かれば範囲制約へ書き換える。
      // だから GLOB と範囲比較は等価で、選択理由は速度ではなく下の 2 件にある
      const plan = await local.d1
        .prepare('EXPLAIN QUERY PLAN SELECT id FROM shops WHERE status = ? AND geohash GLOB ?')
        .bind('published', 'xn76f*')
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).toContain('idx_shops_status_geohash');
      expect(detail).toContain('geohash>? AND geohash<?');
    });

    it('GLOB は先頭ワイルドカードを渡されると全表走査へ落ちる（範囲比較を選ぶ理由）', async () => {
      // 索引が効くかどうかが実行時のバインド値に左右される。
      // 範囲比較は値に関係なく必ず索引を使うので、こちらを実装に採用する
      const plan = await local.d1
        .prepare('EXPLAIN QUERY PLAN SELECT id FROM shops WHERE status = ? AND geohash GLOB ?')
        .bind('published', '*n76f*')
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).not.toContain('geohash>? AND geohash<?');
    });

    it('LIKE は索引が効かない（case_sensitive_like が既定で OFF だから）', async () => {
      const plan = await local.d1
        .prepare('EXPLAIN QUERY PLAN SELECT id FROM shops WHERE geohash LIKE ?')
        .bind('xn76f%')
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' ');

      expect(detail).toContain('SCAN shops');
    });

    it('D1 は 6 項以上の UNION を受け付けない（だから OR で並べる）', async () => {
      const sixTerms = Array.from({ length: 6 }, () => 'SELECT 1 AS v').join(' UNION ALL ');

      await expect(local.d1.prepare(sixTerms).all()).rejects.toThrow(
        /too many terms in compound SELECT/,
      );
    });
  });
  ```

- [ ] **Step 3: テストが失敗することを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/queries/nearby-shops.test.ts
  ```

  `nearby-shops.ts` が無いので import で落ちる。これが Red。

- [ ] **Step 4: `src/db/queries/nearby-shops.ts` の前半（定数と型）を書く**

  ```ts
  import { and, eq, gte, lt, or, type SQL } from 'drizzle-orm';
  import {
    boundingBox,
    cellsForRadius,
    coordinate,
    distanceMeters,
    isWithinBounds,
    type Coordinate,
  } from '@meshimap/geo';
  import type { Database } from '../client';
  import { SHOP_STATUS_PUBLISHED } from '../constants';
  import { shops } from '../schema/shop';

  /**
   * geohash の前方一致に使う上限文字。
   * base32 の最大文字は 'z'(0x7A) なので、その次の '{'(0x7B) を上限にすると
   * `prefix <= geohash < prefix + '{'` が「prefix で始まる文字列」全体をちょうど覆う。
   *
   * GLOB を使わないのは、右辺がバインド引数だと索引が効かないため（F66）。
   * 範囲比較なら索引の範囲検索そのものなので、バインドでも確実に効く。
   */
  const GEOHASH_UPPER_BOUND_CHARACTER = '{';

  export type NearbyShop = {
    readonly id: string;
    readonly name: string;
    readonly genreId: string;
    readonly areaId: string;
    readonly latitude: number;
    readonly longitude: number;
    readonly ratingAvg: number;
    readonly ratingCount: number;
    /** 検索の中心からの距離（メートル）。Haversine の生値で丸めない */
    readonly distanceM: number;
  };

  export type NearbyShopSearch = {
    readonly center: Coordinate;
    readonly radiusM: number;
    /** 返す最大件数。段 3 のあとに切るので、絞り込みの精度には影響しない */
    readonly limit: number;
    /** ジャンル絞り込み。絞らないときは null（undefined ではない） */
    readonly genreId: string | null;
  };

  /**
   * geohash が `cell` で始まる行を選ぶ条件を作る。
   * `and()` は引数が空のとき undefined を返す型なので、ここで潰しておく。
   */
  export function geohashPrefixCondition(cell: string): SQL {
    const condition = and(
      gte(shops.geohash, cell),
      lt(shops.geohash, `${cell}${GEOHASH_UPPER_BOUND_CHARACTER}`),
    );
    if (condition === undefined) {
      throw new Error('geohash の前方一致条件を作れませんでした');
    }
    return condition;
  }
  ```

- [ ] **Step 5: `src/db/queries/nearby-shops.ts` の後半（`findNearbyShops`）を書く**

  ```ts
  /**
   * 中心から半径 radiusM 以内の公開店舗を、近い順に返す。
   *
   * 段 1（SQL）: geohash の前方一致 9 セル。索引が効く唯一の段。
   * 段 2（TS）: 緯度経度の矩形。SQL に混ぜるとプランナが lat/lng 索引を選び、
   *             geohash 索引が使われなくなるので、あえてこちらでやる（F68）。
   * 段 3（TS）: Haversine。D1 の SQL には三角関数が無い。
   */
  export async function findNearbyShops(
    db: Database,
    search: NearbyShopSearch,
  ): Promise<readonly NearbyShop[]> {
    // 段 1 ─ geohash の前方一致で粗く絞る
    const cells = cellsForRadius(search.center, search.radiusM);
    const cellConditions = cells.map((cell) => geohashPrefixCondition(cell));
    const genreCondition = search.genreId === null ? undefined : eq(shops.genreId, search.genreId);

    const candidates = await db
      .select({
        id: shops.id,
        name: shops.name,
        genreId: shops.genreId,
        areaId: shops.areaId,
        latitude: shops.lat,
        longitude: shops.lng,
        ratingAvg: shops.ratingAvg,
        ratingCount: shops.ratingCount,
      })
      .from(shops)
      .where(and(eq(shops.status, SHOP_STATUS_PUBLISHED), genreCondition, or(...cellConditions)));

    // 段 2 ─ 矩形で切る
    const bounds = boundingBox(search.center, search.radiusM);

    // 段 3 ─ 厳密な距離で切り、近い順に並べ、limit で切る
    return (
      candidates
        .filter((row) => isWithinBounds(coordinate(row.latitude, row.longitude), bounds))
        .map((row) => ({
          ...row,
          distanceM: distanceMeters(search.center, coordinate(row.latitude, row.longitude)),
        }))
        .filter((row) => row.distanceM <= search.radiusM)
        // 距離が同じ店（シードには 190m の店が 4 軒ある）の順序が実行ごとに揺れないよう、
        // 第 2 キーに id を置く。ここが無いとテストが不安定になる
        .sort((left, right) => left.distanceM - right.distanceM || left.id.localeCompare(right.id))
        .slice(0, search.limit)
    );
  }
  ```

- [ ] **Step 6: テストを通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/queries/nearby-shops.test.ts
  ```

  20 件が緑になる（Step 8 で穴を塞ぐテストを足すと 25 件になる）。

  **境界テストの `describe` は件数テストより後ろに置くこと。**
  3 件の店を足すので、先に走らせると件数の期待値が崩れる。

- [ ] **Step 7: 3 段階の効き方を手で確かめる**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  npx wrangler d1 execute meshimap-db --local --json --command="
    SELECT substr(geohash, 1, 5) AS cell, count(*) AS shops
      FROM shops GROUP BY 1 ORDER BY 2 DESC, 1"
  ```

  `xn76g` 12 件、`xn76f` 8 件、以下 5 件ずつが 8 セル、という分布になる。
  渋谷（`xn76f`）と恵比寿・中目黒（`xn76g`）が同じセルに同居しているので、
  「半径 1000m の段 1 が 35 件」という数字の理由がここで読める。

- [ ] **Step 8: わざと壊してテストが検知することを確認する**

  1. `GEOHASH_UPPER_BOUND_CHARACTER` を `'z'` にする
     → **半径ごとの件数テストは 1 つも落ちない**（シードの 60 店舗には
     セル直後が `z` の geohash がいないため）。落ちるのは Step 2 の
     「境界の geohash」だけ。
     **件数テストだけでは上限文字の誤りを検知できない**ことを体感する
  2. 段 2 の `isWithinBounds` の行を消す
     → **落ちない（実測 0 件）。** 計画は「半径 1000m の段 2 が 5 → 35 件になる」と
     予想したが誤り。理由は 2 つある。(a) テスト側の `countStage2` は実装を通さず
     独立に矩形を当てているので、実装の段 2 を消しても影響しない。
     (b) `boundingBox` は円の**外接**矩形なので、段 2 が落とす行は段 3 の Haversine でも
     必ず落ちる。つまり段 2 は**返り値を変えない枝刈り**であり、
     出力を見るテストでは原理的に検知できない
     （`packages/geo/src/bounding-box.ts` の JSDoc が「円ではなく外接矩形」と明記している）
  3. 段 3 の `row.distanceM <= search.radiusM` を `<` にする
     → 落ちるのは**半径を「実在する店までの距離そのもの」に合わせた境界テスト 1 件だけ**。
     計画が書いた「半径 190 のテストを足せば 5 → 1 件になる」は誤りで、
     半径 190m は `<=` でも `<` でも 1 件になり等号の破壊を検知できない
     （190.18m の 4 店は両方とも圏外）。
     **等号を守るテストは、半径に `distanceMeters(中心, その店)` の生値を渡して書く**
  4. `.sort(...)` の第 2 キー `left.id.localeCompare(right.id)` を消す
     → 落ちるのは**同一座標の 2 軒を id 降順で INSERT したテスト**。
     計画が書いた「190m の 4 軒は同距離なので順序が不定になる」は誤りで、
     4 軒の距離は実測すると全部違う
     （`190.18482375249062` / `190.18482375432035` / `190.18627483588895` /
     `190.18627483771871`。経度差の浮動小数点表現が東西で非対称なため）。
     **距離が 1 ビットも違わないのは座標が完全に一致する場合だけ**なので、
     第 2 キーを守るテストはそういう 2 軒を作って書く
  5. `or(...cellConditions)` を `cellConditions[0]` だけにする
     → 11 件落ちる。ただし半径 5000m は 25 → **20** 件（計画の「8 件」は誤り。
     中心セル `xn76f` だけでも段 1 が 30 件残るため）
  6. `eq(shops.status, SHOP_STATUS_PUBLISHED)` を消す
     → シードは全件 published なので**件数は変わらず通ってしまう**（計画どおり）。
     渋谷駅直上に draft の店を 1 件入れる `describe` を恒久テストとして足し、
     常時検知できるようにする
  7. `geohashPrefixCondition` の上限を `` `${cell}{` `` から `` `${cell}z` `` ではなく
     **`cell` そのもの**（`lt(shops.geohash, cell)`）に変える
     → 範囲が空になるので、半径ごとの件数が全部 0 件になって落ちる。
     `GLOB` に戻す壊し方は**使わない**。GLOB でも同じプランが出るので
     `MULTI-INDEX OR` のテストは通ってしまい、壊した検証にならない（F66 の訂正）

  **7 つすべて確認したら元に戻し、テストを緑に戻す。**

  > **2026-09-15 の実測結果:** 上の 2 / 3 / 4 は計画の予想が外れた。
  > 予想どおり落ちたのは 1 / 5 / 6 / 7 だけで、2 は 1 件も落ちなかった。
  > **「壊したのに落ちない」を潰すためにテストを 5 件足した**
  > （190m の段 2→段 3、半径 200m の並び順、半径の境界＝閉区間、
  > 同一座標の並び順、draft 除外）。結果、計画どおりに書くと 20 件のところが 25 件になった。
  > 計画本文の「18 件が緑になる」という数字も古い。

- [ ] **Step 9: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

- [ ] **Step 10: コミット**

  `feat(api): geohash → 矩形 → Haversine の 3 段構え近傍検索を追加` として報告する。

---

### Task 3-14: 品質ゲート（型検査 / 全テスト / マイグレーション再現性）

Phase 3 の成果物を「次の人がまっさらな環境で再現できる」状態にして締める。
ここで落ちるものを 1 つでも残すと、Phase 4 以降の担当が
「自分の変更で壊れたのか元から壊れていたのか」を切り分けられなくなる。

**Files:**

- Modify: なし（既存ファイルの検証だけを行う。落ちたら該当タスクに戻る）

**Interfaces:**

- Consumes: Task 3-0 〜 3-13 の全成果物
- Produces: なし（検証のみ）

- [ ] **Step 1: マイグレーションとスナップショットの整合性を確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx drizzle-kit check
  ```

  `Everything's fine 🐶🔥` と出る（F72）。
  ここで警告が出るのは、手書きの `0001_shops_fts.sql` を
  `--custom` を使わずに足した場合。その場合は Task 3-11 の Step 2 からやり直す。

- [ ] **Step 2: スキーマに変更が残っていないことを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run db:generate
  ```

  `No schema changes, nothing to migrate 😴` と出る（F71）。
  ここで新しい SQL ファイルが生まれたら、**スキーマを直したのに
  マイグレーションを再生成していない**ということ。生まれたファイルを消して
  Task 3-10 の Step 5 からやり直す。

- [ ] **Step 3: マイグレーションを消して再生成し、1 バイトも変わらないことを確認する**

  **`migrations/` を消してはいけない。** 手書きの `0001_shops_fts.sql` は生成物ではないので、
  消すと退避と復元が必要になり、失敗したときに復元漏れが起きる。
  代わりに**空のディレクトリを別に用意して、そこへ生成させて比べる。**
  作業ツリーには一切触れないので、途中で止めても壊れない。

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  OUT=/tmp/meshimap-migrations-check
  rm -rf "$OUT" && mkdir -p "$OUT"

  # drizzle-kit の --out は絶対パスに './' を前置してしまい、既存スナップショットを読めなくなる。
  # 相対パスへ直してから渡すこと（2026-09-15 実測。'.//tmp/...' で ENOENT になった）。
  REL=$(python3 -c "import os;print(os.path.relpath('$OUT', os.getcwd()))")
  npx drizzle-kit generate --dialect=sqlite --schema=./src/db/schema/index.ts --out="$REL" --name=init

  diff migrations/0000_init.sql "$OUT/0000_init.sql" && echo '0000 は完全一致'
  git status --porcelain migrations   # 何も出ないこと
  ```

  `0000 は完全一致` と出て、`git status` が空になる（F70）。

  **`migrations/meta/` は `.sql` と違って毎回変わる。** 再現性を確かめる対象は `.sql` だけ。

  | ファイル                  | 変わるもの      | 理由                                        |
  | ------------------------- | --------------- | ------------------------------------------- |
  | `meta/_journal.json`      | `when`          | 生成した実行時刻                            |
  | `meta/0000_snapshot.json` | `id`            | drizzle-kit が毎回 UUID を振り直す          |
  | `meta/0001_snapshot.json` | `id` / `prevId` | 同上（`prevId` は 0000 の `id` を指すため） |

  **中身（テーブル定義）は 1 文字も変わらない。** スナップショットまで比べるなら
  `id` と `prevId` を落としてから比較する（2026-09-15 実測。この 2 つ以外は完全一致だった）。

  ```bash
  diff <(python3 -c "import json;d=json.load(open('migrations/meta/0000_snapshot.json'));d.pop('id',None);d.pop('prevId',None);print(json.dumps(d,sort_keys=True))") \
       <(python3 -c "import json;d=json.load(open('$OUT/meta/0000_snapshot.json'));d.pop('id',None);d.pop('prevId',None);print(json.dumps(d,sort_keys=True))")
  ```

- [ ] **Step 4: ローカル D1 をまっさらから作り直す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run db:reset:local
  ```

  `.wrangler/state/v3/d1` を消してから、マイグレーション 2 本とシードを流し直す。
  `0000_init.sql` が 80 文、`0001_shops_fts.sql` が 5 文で、両方 ✅ になる（F61）。

- [ ] **Step 5: テーブルと索引の数を確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  npx wrangler d1 execute meshimap-db --local --json --command="
    SELECT type, name FROM sqlite_master
     WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name"
  ```

  **2026-09-15 に実測して訂正。** 以前ここには
  「`name NOT LIKE 'shops_fts_%'` で絞って `table` 27 / `trigger` 3」と書いていたが、
  **その絞り込みでは `trigger` が 1 つも出ない。**
  トリガーの名前が `shops_fts_after_insert` / `_after_update` / `_after_delete` で、
  除外パターンにそのまま当たってしまうため。数を数えるのをやめて名前を並べる。

  期待する内容は次のとおり。

  | 種別      | 件数   | 内訳                                                                                                       |
  | --------- | ------ | ---------------------------------------------------------------------------------------------------------- |
  | `table`   | **32** | アプリの 25 + `d1_migrations` + `shops_fts` + `_cf_METADATA` + FTS5 の内部表 4 本（`shops_fts_data` など） |
  | `trigger` | **3**  | `shops_fts_after_insert` / `shops_fts_after_update` / `shops_fts_after_delete`                             |

  `_cf_METADATA` は wrangler がローカル D1 に自動で作る管理表で、
  スキーマの一部ではない。**miniflare 上のテスト（`createMigratedD1()`）には現れない**ので、
  テスト側の件数と食い違っても異常ではない。

  **アプリのテーブルが 25 本あることを直接数えるなら**、`d1_migrations` /
  `_cf_METADATA` / `shops_fts` / `shops_fts_*` を除いて数える。
  **24 本以下なら `schema/index.ts` に書き忘れたテーブルがある。**

- [ ] **Step 6: 外部キーがローカルでも有効なことを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api
  npx wrangler d1 execute meshimap-db --local --json --command="PRAGMA foreign_key_check"
  ```

  `results` が空配列になる。1 行でも出たらシードが壊れている。

- [ ] **Step 7: `apps/api` の全テストを走らせる**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm test
  ```

  Task 3-0 〜 3-13 で書いたテストファイルがすべて緑になる（20 ファイル / 414 件。2026-09-15 実測）。

  | ファイル                                  | 主な検証対象                                       |
  | ----------------------------------------- | -------------------------------------------------- |
  | `src/db/testing/local-d1.test.ts`         | miniflare 上の D1 が起動しマイグレーションが流れる |
  | `src/db/constants.test.ts`                | 列挙値と数値範囲                                   |
  | `src/db/sql-helpers.test.ts`              | CHECK 制約を組み立てる補助関数                     |
  | `src/db/schema/auth.test.ts`              | Better Auth の 4 テーブル                          |
  | `src/db/schema/master.test.ts`            | profiles / genres / areas                          |
  | `src/db/schema/shop.test.ts`              | shops の制約と地理空間索引                         |
  | `src/db/schema/shop-detail.test.ts`       | 営業時間 / 臨時休業 / 写真                         |
  | `src/db/schema/menu.test.ts`              | メニュー / 席設定                                  |
  | `src/db/schema/review.test.ts`            | レビュー / 写真 / 返信                             |
  | `src/db/schema/reservation.test.ts`       | 予約                                               |
  | `src/db/schema/collection.test.ts`        | お気に入り / リスト                                |
  | `src/db/schema/admin.test.ts`             | 通報 / 申請 / 通知 / 監査ログ                      |
  | `src/db/schema/check-constraints.test.ts` | CHECK 制約 104 個の境界値と、テスト漏れの検出      |
  | `src/db/schema/index.test.ts`             | 25 テーブルが漏れなく再エクスポートされている      |
  | `src/db/schema/design-doc-sync.test.ts`   | 設計書 §6 の表名と Drizzle 定義が一致している      |
  | `src/db/client.test.ts`                   | `createDatabase` が Drizzle を返す                 |
  | `src/db/fts.test.ts`                      | FTS5 仮想テーブル / トリガー / 検索語のエスケープ  |
  | `src/db/seed.test.ts`                     | シードの件数と冪等性                               |
  | `src/db/queries/nearby-shops.test.ts`     | 3 段構えの近傍検索                                 |
  | `src/db/queries/conditions.test.ts`       | `and()` / `or()` の `undefined` を潰す補助関数     |

- [ ] **Step 7.5: CHECK 制約にテストの漏れがないことを機械的に保証する**

  Task 3-2 〜 3-9 を素直に進めると、**CHECK 制約は 72 個あるのにテストが名指ししているのは 31 個**という状態になる（Task 3-7 完了時点の実測。Task 3-9 まで終えると CHECK は 104 個になる）。長さ上限や真偽値のような機械的な制約は書き忘れやすく、書き忘れても誰も気づけない。境界値を `<` と `<=` で書き違えても緑のまま通る。

  ここで「制約を足したらテストも足す」を人間の注意力に頼らず強制する。

  **Files:**

  - Create: `/Users/hattori/Downloads/alee/apps/api/src/db/schema/check-constraints.test.ts`

  まず**漏れを検出するメタテスト**を書く。

  ```ts
  import { readdirSync, readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { describe, expect, it } from 'vitest';

  const MIGRATION_PATH = join(__dirname, '../../../migrations/0000_init.sql');
  const SCHEMA_DIR = __dirname;
  const SELF_FILE_NAME = 'check-constraints.test.ts';

  /** マイグレーションに実際に書き出された CHECK 制約名 */
  function constraintNamesInMigration(): readonly string[] {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    // drizzle-kit は CHECK 制約を `CONSTRAINT "ck_xxx" CHECK (...)` の形で出力する
    const matches = sql.matchAll(/CONSTRAINT "(ck_[a-z0-9_]+)"/g);
    return [...new Set([...matches].map((match) => match[1] ?? ''))].sort();
  }

  /** テストファイル群のどこかに名前が現れる CHECK 制約名 */
  function constraintNamesInTests(): ReadonlySet<string> {
    const names = new Set<string>();
    for (const fileName of readdirSync(SCHEMA_DIR)) {
      // 自分自身を数えると、名前を書くだけで網羅したことになってしまう
      if (!fileName.endsWith('.test.ts') || fileName === SELF_FILE_NAME) continue;
      const source = readFileSync(join(SCHEMA_DIR, fileName), 'utf8');
      for (const match of source.matchAll(/ck_[a-z0-9_]+/g)) names.add(match[0]);
    }
    return names;
  }

  describe('CHECK 制約のテスト網羅', () => {
    it('マイグレーション上の CHECK 制約はすべてどこかのテストで名指しされている', () => {
      const tested = constraintNamesInTests();
      const untested = constraintNamesInMigration().filter((name) => !tested.has(name));
      // 差分をそのまま出す。落ちたとき「どれを書けばいいか」が一目で分かる
      expect(untested).toEqual([]);
    });
  });
  ```

  **このメタテストは「名前が出てくるか」しか見ない。** 実際に制約を検証しているかまでは保証できない。それでも「CHECK を足したのにテストを 1 行も書いていない」は確実に捕まる。ここで狙うのはそこまでで、中身の質は Step 7.7 のわざと壊す検証で担保する。

- [ ] **Step 7.6: メタテストが赤いことを確認し、漏れている CHECK を埋める**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npx vitest run src/db/schema/check-constraints.test.ts
  ```

  **落ちる。** 出力される配列が、テストを書くべき制約の一覧そのものになる。

  この一覧を埋める。**個別に `it` を 41 個書かない。** CHECK の検証はどれも「この値は通る / この値は弾かれる」の形なので、表にして `it.each` で回す。個別に書くと定型のコピペが増え、貼り違いで「別の制約を 2 回テストしている」事故が起きる。

  ```ts
  /** 1 つの CHECK 制約について、通る値と弾かれる値を 1 行で表す */
  interface ConstraintCase {
    /** CHECK 制約名。メタテストが照合するキーでもある */
    readonly name: string;
    /** 制約の付いた列に入れる、弾かれるべき値 */
    readonly rejected: string | number;
    /** 同じ列に入れる、通るべき値。境界ちょうどを置く */
    readonly accepted: string | number;
  }
  ```

  境界値の選び方は 1 つだけ守る。**`accepted` には必ず上限ちょうど・下限ちょうどを置く。** 上限が 200 文字なら 199 文字ではなく 200 文字を入れる。199 文字では `length <= 200` を `length < 200` に書き換えても落ちず、テストが境界を守っていないことになる。

  親行が要る制約は、`menu.test.ts` の `CHECK_SHOP_ID` と同じ方式で**実在する親行**を使う。存在しない FK 値を使うと、CHECK 違反と FK 違反のどちらで落ちたのかが SQLite の評価順に依存する脆いテストになる。

- [ ] **Step 7.7: 埋めたテストが本当に制約を見ていることを確認する（わざと壊す）**

  表から任意の 3 件を選び、対応する `check(...)` を `schema/*.ts` から消してマイグレーションを再生成し、**その 3 件だけが**落ちることを確認する。

  1 件も落ちないなら、その `accepted` / `rejected` が境界を跨いでいない。想定より多く落ちるなら、他のテストがその制約に依存している（親行の作り方を見直す）。確認したら戻してマイグレーションを再生成する。

- [ ] **Step 7.8: 部分索引の `WHERE` 句が消えていないことを確認する**

  部分索引は `WHERE` を外しても**ほとんどのテストが緑のまま通る**。Task 3-9 で実測した例を挙げる。

  `idx_notifications_user_unread`（`WHERE read_at IS NULL`）から `.where()` を外しても、「未読一覧が部分索引を使う」テストは**通ってしまう**。EXPLAIN QUERY PLAN が返す索引名は変わらないためだ。代わりに落ちたのは「全件一覧は通常の索引を使う」ほうだった。SQLite が全件クエリにも条件の消えた索引を選ぶようになったからで、**検知はできたが、検知した理由が意図と違う**。

  索引名の一致だけを見るテストでは、部分索引が部分索引であることを保証できない。`sqlite_master` に格納された DDL を直接見る。

  ```ts
  /** 部分索引は WHERE 句まで含めて sqlite_master に格納される */
  const PARTIAL_INDEXES = [
    { name: 'uq_shop_photos_cover', where: 'is_cover' },
    { name: 'idx_notifications_user_unread', where: 'read_at" IS NULL' },
    { name: 'uq_shop_applications_shop_pending', where: "status\" = 'pending'" },
  ] as const;

  it.each(PARTIAL_INDEXES)('$name は WHERE 付きの部分索引である', async ({ name, where }) => {
    const row = await local.d1
      .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
      .bind('index', name)
      .first<{ sql: string }>();
    // 索引そのものが無ければ null。名前の打ち間違いをここで弾く
    expect(row).not.toBeNull();
    expect(row?.sql).toContain('WHERE');
    expect(row?.sql).toContain(where);
  });
  ```

  部分索引を足したらこの表にも足す。**表に足し忘れても落ちない**ので、CHECK 制約と同じくメタテストで縛る。

  ```ts
  it('マイグレーション上の部分索引はすべて表に載っている', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    // drizzle-kit は部分索引を `CREATE [UNIQUE] INDEX `名前` ON ... WHERE ...` で出力する
    const declared = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX `([a-z0-9_]+)`[^;]*WHERE/g)].map(
      (match) => match[1] ?? '',
    );
    const listed = PARTIAL_INDEXES.map((index) => index.name);
    expect(declared.sort()).toEqual([...listed].sort());
  });
  ```

- [ ] **Step 8: 型検査を通す**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run typecheck
  ```

  `scripts/generate-seed.ts` も対象に入っていること（Task 3-12 の Step 1）。

- [ ] **Step 9: 他のワークスペースを壊していないことを確認する**

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  npm run typecheck --workspaces --if-present
  ```

  Phase 3 は `apps/api` の中だけで完結する想定だが、
  `package.json` に依存を足しているので、ここで全体を通す。
  `packages/geo` の 205 件のテストも道連れにしていないか確認する。

  ```bash
  cd /Users/hattori/Downloads/alee/packages/geo && npm test
  ```

- [ ] **Step 9.5: ミューテーションテストを走らせ、結果を疑う**

  テストが全部緑になっても「テストが何も守っていない」ことはありうる。
  Stryker でソースをわざと書き換え、どれだけのテストが気づくかを測る。

  ```bash
  export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
  cd /Users/hattori/Downloads/alee/apps/api && npm run test:mutation
  ```

  **スコアだけを見て終わりにしないこと。** 100% が出たら、まず疑う。
  2026-09-15 にこのスイートは 129/129 の Killed（スコア 100%）を出したが、
  **1 件も測れていなかった。** 経緯は次のとおり。

  1. `src/db/queries/nearby-shops.ts` の段 2（外接矩形での枝刈り）は、
     `boundingBox` が円に**外接**する矩形を返す以上、消しても出力が変わらない。
     出力ベースのテストしか無いのだから、この変異は**生き残るはずだった**。
  2. 「Killed」という結果が理屈と矛盾したので、変異を手で当ててテストを回した。
     **377 件すべて通った。** つまり Stryker の判定が間違っている。
  3. `reports/mutation/mutation.json` の `statusReason` を見ると、
     129 件すべてに `connect EADDRNOTAVAIL 127.0.0.1:xxxxx` が出ていた。
     変異ではなく**ポート枯渇**でテストが落ち、それを「殺した」と数えていた（F73）。

  **Stryker の command ランナーは終了コードしか見ない。**
  だから変異と無関係な基盤の失敗はすべて「変異を殺した」に化ける。
  スコアが高いことは、テストが良いことの証明にならない。

  結果を信用してよいかは、スコアではなく次の 2 つで判断する。

  ```bash
  cd /Users/hattori/Downloads/alee/apps/api
  # 1. 基盤の失敗が混ざっていないか（0 でなければスコアは無効）
  python3 -c "
  import json
  runs = json.load(open('reports/mutation/mutation.json'))['files']
  reasons = [m.get('statusReason') or '' for f in runs.values() for m in f['mutants']]
  print('EADDRNOTAVAIL を含む変異:', sum('EADDRNOTAVAIL' in r for r in reasons))
  print('ENOENT / ECONN を含む変異:', sum(('ENOENT' in r or 'ECONN' in r) for r in reasons))
  "
  # 2. 除外したテストの一覧（除外が増えていないか）
  grep -n 'vitestArgs' stryker.config.mjs
  ```

  **生き残った変異は 1 件ずつ理由を言えるようにする。** 選択肢は 3 つしかない。

  | 生き残りの正体                   | 取るべき手                                                          |
  | -------------------------------- | ------------------------------------------------------------------- |
  | テストの穴                       | テストを足して殺す                                                  |
  | 出力を変えない最適化             | 出力ではなく**呼び出し回数**を主張するテストを足して殺す            |
  | 型を通すためだけの到達不能コード | `// Stryker disable all` で囲み、**なぜ到達不能か**をコメントで書く |

  「除外する」は選択肢に無い。`stryker.config.mjs` の除外を増やしてよいのは
  **サンドボックス外のファイルを読むテスト**だけで、その場合もファイル単位ではなく
  そのテストを別ファイルへ切り出して**最小の範囲で**除外する。
  ファイルごと除外すると、同じファイルにある他の主張まで効かなくなり、
  そこでしか殺せない変異が静かに生き残る（実際 `SHOPS_FTS_TABLE_NAME` がこれで生き残っていた）。

  `packages/core` と `packages/geo` も同じ目で見る。
  こちらは `EADDRNOTAVAIL` が 0 件で、残る Timeout は
  `GEOHASH_BASE32` を空文字にすると encode の `while` が終わらないという本物の無限ループだった。

- [ ] **Step 10: わざと壊して品質ゲートが機能することを確認する**

  1. `src/db/schema/index.ts` から `export * from './admin';` を消す
     → Step 2 の `db:generate` が**新しいマイグレーションを作ってしまう**
     （4 テーブルの DROP）。`index.test.ts` も 25 → 21 で落ちる。
     生成されたファイルを消して戻すこと
  2. `migrations/0001_shops_fts.sql` を消す
     → Step 4 の `db:reset:local` は通るが、Step 5 が **`table` 27 / `trigger` 0** になり、
     `fts.test.ts` と `seed.test.ts` が合わせて 15 件落ちる（2026-09-15 実測）。
     減る 5 は `shops_fts` と FTS5 の内部表 4 本。**`trigger` が 3 本とも消えることに注目する。**
     同期トリガーは仮想テーブルと同じファイルで作っているので、
     「全文検索だけ止まる」ではなく「索引の更新経路ごと消える」
  3. `seeds/seed.sql` の `ANALYZE;` を消して `db:reset:local`
     → `nearby-shops.test.ts` の `MULTI-INDEX OR` だけが落ちる（F69）
  4. `drizzle.config.ts` の `out` を**作業ツリーの外**（例 `/tmp/meshimap-break4`）へ向ける
     → Step 2 の `No schema changes` が消え、25 テーブル分の新規マイグレーションが
     そちらに生まれる。**設定ファイルの取り違えが静かに通らない**ことを確認する。
     `./migrations2` のようにリポジトリ内へ向けると、戻すのに
     ディレクトリごとの削除が要る。外に出しておけば `git checkout -- drizzle.config.ts` だけで戻る

  **4 つすべて確認したら元に戻し、Step 1 から通し直して全部緑にする。**

- [ ] **Step 11: コミット**

  `chore(api): Phase 3 の品質ゲートを通す` として報告する。
  作業ツリーに `migrations2/` や `/tmp` の退避ファイルが残っていないことを、
  `git status` **ではなく** `ls` で確認する（コミットは親エージェントが行う）。

---

## Phase 3 完了チェックリスト

- [ ] `apps/api/src/db/schema/` が 9 ファイルに分かれ、依存の向きが
      `auth → master → shop → 詳細 → admin` の一方向になっている
- [ ] 設計書 §6 の 25 テーブルすべてに Drizzle 定義がある
- [ ] `schema/index.ts` が 25 テーブルを再エクスポートし、`index.test.ts` が数を守っている
- [ ] `migrations/0000_init.sql` が 25 テーブル・80 文で生成されている
- [ ] `migrations/0001_shops_fts.sql` が FTS5 仮想テーブルと同期トリガー 3 本を作る
- [ ] `npx drizzle-kit check` が `Everything's fine 🐶🔥` を返す
- [ ] `npm run db:generate` が `No schema changes` を返す
- [ ] 空のディレクトリへ再生成しても `0000_init.sql` が 1 バイトも変わらない（`migrations/` は消さない）
- [ ] `npm run db:reset:local` がまっさらな状態から通る
- [ ] `seeds/seed.sql` が 1247 文で、東京 12 エリア 60 店舗を決定的に作る
- [ ] シードを 2 回流しても件数と `rating_avg` の総和が変わらない
- [ ] `PRAGMA foreign_key_check` が空を返す
- [ ] 渋谷駅起点の 3 段階検索が
      200m→5 / 500m→5 / 1000m→5 / 2000m→15 / 3000m→20 / 5000m→25 件を返す
- [ ] 段 1 の SQL が `MULTI-INDEX OR` で `idx_shops_status_geohash` を 9 本使う
- [ ] `check-constraints.test.ts` のメタテストが緑（マイグレーション上の CHECK 制約が
      1 つ残らずテストで名指しされている。Task 3-9 完了時点で 104 個）
- [ ] 部分索引 3 本の `WHERE` 句が `sqlite_master` の DDL で検証されている
- [ ] `apps/api` の全テストが緑（20 ファイル / 414 件）
- [ ] `npm run test:mutation` が 3 ワークスペースとも閾値 85 を超え、かつ
      `statusReason` に `EADDRNOTAVAIL` を含む変異が **0 件**（1 件でもあればスコアは無効）
- [ ] 生き残った変異が 1 件ずつ「テストを足した / 回数で縛った / 到達不能と明記した」
      のいずれかで説明できる
- [ ] `npm run typecheck` が `apps/api` と全ワークスペースで通る
- [ ] `packages/core` 配下のファイルを 1 つも作っていない・触っていない

---

## 次フェーズへの引き継ぎ

| 引き継ぐもの                            | 置き場所                                  | Phase 4 以降での使われ方                                                 |
| --------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `createDatabase(d1)` / `Database` 型    | `apps/api/src/db/client.ts`               | Hono のミドルウェアで `c.set('db', createDatabase(c.env.DB))`            |
| 25 テーブルの Drizzle 定義              | `apps/api/src/db/schema/`                 | 全 API ハンドラのクエリ                                                  |
| `findNearbyShops`                       | `apps/api/src/db/queries/nearby-shops.ts` | Phase 6 の `GET /shops/nearby`                                           |
| `buildFtsMatchQuery` / `escapeFtsToken` | `apps/api/src/db/fts.ts`                  | Phase 6 の `GET /shops/search`                                           |
| `createMigratedD1()` / `applySeed()`    | `apps/api/src/db/testing/local-d1.ts`     | Phase 4 以降の API 統合テスト                                            |
| 列挙値の定数（role / status など）      | `apps/api/src/db/constants.ts`            | **Phase 4 で `packages/core` へ移す。** モバイル側と共有するのはそのとき |
| `seeds/seed.sql`                        | `apps/api/seeds/`                         | `npm run db:reset:local` で開発環境を作り直す                            |

### Phase 4 で最初にやること

1. `apps/api/src/db/constants.ts` の列挙値を `packages/core` へ移し、
   `constants.ts` からは re-export だけにする。
   **Phase 3 の時点で `packages/core` に書かないのは、別のエージェントが
   並行して同じファイルを作っているため。** 衝突を避けて後追いで統合する。
2. `wrangler.jsonc` の `d1_databases[0].database_id` を実物に差し替え、
   `npm run db:migrate:remote` を 1 回通す。
3. `ANALYZE` を本番でも打つ運用を決める。
   統計が無いと 9 セルの OR が索引を使わない（F69）。

---

## 未確認事項

計画を書く時点で裏取りできなかった点を残す。実装時に確認すること。

| #   | 未確認の内容                                                                                                                                                                                                                                                                                    | 影響                                                      | 確かめ方                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | `miniflare` と `tsx` を `apps/api` の devDependencies に足す判断（Task 3-0 Step 1）。**この計画を書いたエージェントは `npm install` を実行していない**（他のエージェントが並行作業中で lockfile を壊すため）。バージョン指定は `apps/api/package.json` に既に書かれていた値をそのまま使っている | インストール時に peer 依存の警告が出る可能性              | 実装者が Task 3-0 Step 3 で `npm install` を 1 回実行し、警告の有無を見る                                                                                                                                                                                                                       |
| U2  | `wrangler d1 migrations apply --remote` での FTS5 の可否                                                                                                                                                                                                                                        | 本番の全文検索が動かない可能性                            | Phase 4 で本番 D1 に 1 回流して `sqlite_master` を確認する。ローカル（workerd の SQLite）では動くことは確認済み（F51）                                                                                                                                                                          |
| U3  | 本番 D1 で `ANALYZE` を打つ手段と頻度                                                                                                                                                                                                                                                           | 統計が無いと近傍検索が索引を使わない（F69）               | `wrangler d1 execute --remote --command="ANALYZE"` が通るかを Phase 4 で確認する                                                                                                                                                                                                                |
| U4  | D1 の 1 リクエストあたりの SQL 文数・時間の上限にシード 1247 文が収まるか（`--local` では収まることを確認済み）                                                                                                                                                                                 | 本番へシードを流せない可能性                              | 本番にシードを流す予定は無いので影響は小さい。必要になったら分割する                                                                                                                                                                                                                            |
| U5  | `trigram` トークナイザの本番 D1 での有無                                                                                                                                                                                                                                                        | カタカナ・漢字の部分一致が効かなくなる                    | U2 と同時に確認する。効かない場合は `LIKE '%…%'` の全表走査に落とすフォールバックを Phase 6 で用意する                                                                                                                                                                                          |
| U6  | `better-auth` 1.7.5 が期待するテーブル定義と `auth.ts` の完全一致                                                                                                                                                                                                                               | サインアップ時に列不足で落ちる可能性                      | Phase 5 で Better Auth を実際に組み込んだときに判明する。`auth.ts` は Better Auth の Drizzle アダプタの想定に合わせて書いてあるが、**実際にサインアップを通すところまでは確認していない**                                                                                                       |
| U8  | `lists` に `created_at` が無い（設計書 §6 のとおり）。`favorites` は `created_at desc` で並べるのに、リスト一覧は並び順の基準を持たない                                                                                                                                                         | 「最近作ったリスト順」が出せず、`name` 順か `id` 順になる | Phase 6 でマイリスト一覧の UI を作るときに判断する。必要なら `created_at` を足して索引を `(user_id, created_at desc)` に変える。設計書の表は `created_at` を持つテーブルだけ明示的に書いており（`reservations` / `reviews` / `favorites` など）、`lists` に無いのは書き忘れではなく選択と読める |
| U7  | `packages/core` に置く予定の列挙値と `apps/api/src/db/constants.ts` の値が一致するか                                                                                                                                                                                                            | Phase 4 の統合時に差分が出る                              | 並行作業中の `packages/core` が固まった時点で突き合わせる                                                                                                                                                                                                                                       |
