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

```ts
import { formatBusinessHours, businessHoursOn, getOpenStatus, toJstClock } from '@meshimap/core';

const now = new Date(); // Worker でも端末でも UTC 基準の Date をそのまま渡す
const clock = toJstClock(now);
const status = getOpenStatus(shop.hours, shop.closures, now); // 'open' | 'closing-soon' | 'closed' | 'regular-holiday'
const label = formatBusinessHours(businessHoursOn(shop.hours, clock.dayOfWeek)); // "18:00 - 翌 1:30"
```

## テスト

```bash
npm run test -w @meshimap/core # 単体テスト
npm run test:coverage -w @meshimap/core # カバレッジ（閾値 100%）
npm run test:mutation -w @meshimap/core # ミューテーションテスト（閾値 85%）
```

ミューテーションテストは `stryker.config.json` でコマンドランナー（`npx vitest run --silent`）を使う。`@stryker-mutator/vitest-runner@10.0.0` は `vitest@5.0.0` と組み合わせると変異ごとにテストを実行できず、スコアが誤って 21% 程度に落ちるため。
