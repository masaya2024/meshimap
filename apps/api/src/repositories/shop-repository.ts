import type { ShopCreateInput, ShopId, ShopUpdateInput, UserId } from '@meshimap/core';
import { coordinate, encodeGeohash } from '@meshimap/geo';
import { and, desc, eq, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { isAdminActor, isOwnerActor } from '../auth/actor';
import type { AdminActor, OwnerActor, Viewer } from '../auth/actor';
import type { Database } from '../db/client';
import { SHOP_GEOHASH_PRECISION, SHOP_STATUS_DRAFT, SHOP_STATUS_PUBLISHED } from '../db/constants';
import { shops } from '../db/schema';
import { SHOP_LIST_DEFAULT_LIMIT, SHOP_LIST_MAX_LIMIT } from '../lib/constants';

export type ShopRow = typeof shops.$inferSelect;

/**
 * 閲覧者ごとの可視条件を **SQL の WHERE 句として**組み立てる。
 * 取得後にアプリ側でフィルタしないこと。取り漏らしがそのまま情報漏洩になる。
 * admin は undefined を返す。drizzle は undefined を「条件なし」として扱う（本物の D1 で実測確認済み）。
 */
function visibilityCondition(viewer: Viewer): SQL | undefined {
  if (isAdminActor(viewer)) {
    return undefined;
  }
  if (isOwnerActor(viewer)) {
    // 自分の店舗は status を問わず見える。
    // owner_id が NULL の店舗は `owner_id = ?` に一致しないので、誰のものにもならない
    return or(eq(shops.status, SHOP_STATUS_PUBLISHED), eq(shops.ownerId, viewer.userId));
  }
  return eq(shops.status, SHOP_STATUS_PUBLISHED);
}

type ShopWriteValues = Partial<typeof shops.$inferInsert>;

/**
 * `ShopUpdateInput`（core の Zod スキーマ由来）を shops テーブルの列へ写す。
 * プロパティ名が一致しない（latitude→lat, budgetLunchMinYen→budgetLunchMin）ため、
 * スプレッドではなく 1 対 1 で書き下す。列を増やしたらここも足す。
 */
function toShopUpdateValues(input: ShopUpdateInput, now: Date): ShopWriteValues {
  // updatedAt は常に入るので、set() が空になって SQL が壊れることがない
  const values: ShopWriteValues = { updatedAt: now };
  if (input.name !== undefined) {
    values.name = input.name;
  }
  if (input.nameKana !== undefined) {
    values.nameKana = input.nameKana;
  }
  if (input.genreId !== undefined) {
    values.genreId = input.genreId;
  }
  if (input.areaId !== undefined) {
    values.areaId = input.areaId;
  }
  if (input.description !== undefined) {
    values.description = input.description;
  }
  if (input.postalCode !== undefined) {
    values.postalCode = input.postalCode;
  }
  if (input.address !== undefined) {
    values.address = input.address;
  }
  if (input.phone !== undefined) {
    values.phone = input.phone;
  }
  if (input.website !== undefined) {
    values.website = input.website;
  }
  if (input.budgetLunchMinYen !== undefined) {
    values.budgetLunchMin = input.budgetLunchMinYen;
  }
  if (input.budgetLunchMaxYen !== undefined) {
    values.budgetLunchMax = input.budgetLunchMaxYen;
  }
  if (input.budgetDinnerMinYen !== undefined) {
    values.budgetDinnerMin = input.budgetDinnerMinYen;
  }
  if (input.budgetDinnerMaxYen !== undefined) {
    values.budgetDinnerMax = input.budgetDinnerMaxYen;
  }
  // 片方だけで geohash を再計算すると古い値と混ざった誤ったセルになるため、両方揃ったときだけ更新する
  if (input.latitude !== undefined && input.longitude !== undefined) {
    values.lat = input.latitude;
    values.lng = input.longitude;
    values.geohash = encodeGeohash(
      coordinate(input.latitude, input.longitude),
      SHOP_GEOHASH_PRECISION,
    );
  }
  return values;
}

export async function listVisibleShops(
  db: Database,
  viewer: Viewer,
  limit: number = SHOP_LIST_DEFAULT_LIMIT,
): Promise<ShopRow[]> {
  // 上限を超える limit は Worker の CPU 時間を食い潰す。0 以下は結果が消えるので下限でも丸める
  const safeLimit = Math.min(Math.max(limit, 1), SHOP_LIST_MAX_LIMIT);
  return await db
    .select()
    .from(shops)
    .where(visibilityCondition(viewer))
    .orderBy(desc(shops.createdAt))
    .limit(safeLimit);
}

/**
 * 「存在しない」と「見る権限がない」は同じ null を返す。
 * 区別する情報をこの関数が持たないので、呼び出し側が誤って漏らすこともできない。
 */
export async function findVisibleShop(
  db: Database,
  viewer: Viewer,
  shopId: ShopId,
): Promise<ShopRow | null> {
  const rows = await db
    .select()
    .from(shops)
    .where(and(eq(shops.id, shopId), visibilityCondition(viewer)))
    .limit(1);
  return rows[0] ?? null;
}

/** admin が `POST /shops` で直接作る（唯一の呼び出し元）。作成直後は draft */
export async function createShopAsAdmin(
  db: Database,
  _actor: AdminActor,
  input: ShopCreateInput,
  ownerId: UserId,
  shopId: ShopId,
  now: Date,
): Promise<ShopRow> {
  const inserted = await db
    .insert(shops)
    .values({
      id: shopId,
      ownerId,
      name: input.name,
      nameKana: input.nameKana,
      genreId: input.genreId,
      areaId: input.areaId,
      description: input.description,
      postalCode: input.postalCode,
      address: input.address,
      lat: input.latitude,
      lng: input.longitude,
      geohash: encodeGeohash(coordinate(input.latitude, input.longitude), SHOP_GEOHASH_PRECISION),
      phone: input.phone,
      website: input.website,
      budgetLunchMin: input.budgetLunchMinYen,
      budgetLunchMax: input.budgetLunchMaxYen,
      budgetDinnerMin: input.budgetDinnerMinYen,
      budgetDinnerMax: input.budgetDinnerMaxYen,
      status: SHOP_STATUS_DRAFT,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const row = inserted[0];
  if (row === undefined) {
    // INSERT ... RETURNING が 0 件を返すのは D1 側の異常。握り潰さない
    throw new Error('店舗の作成に失敗した');
  }
  return row;
}

/**
 * 設計書 3.2 の中核。所有者チェックは `eq(shops.ownerId, actor.userId)` という
 * **クエリ条件**として表現する。アプリ側の if 文を通らないので、書き忘れる場所が存在しない。
 * 他人の店舗・存在しない店舗のどちらも 0 件 → null になる。
 */
export async function updateShopAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  input: ShopUpdateInput,
  now: Date,
): Promise<ShopRow | null> {
  const updated = await db
    .update(shops)
    .set(toShopUpdateValues(input, now))
    .where(and(eq(shops.id, shopId), eq(shops.ownerId, actor.userId)))
    .returning();
  return updated[0] ?? null;
}

/**
 * admin は所有者を問わず更新できる。
 * owner 版とユニオン型でまとめないのは、まとめると「どちらの WHERE を組むか」の分岐が
 * 関数内に入り、設計書 3.2 が避けたい「アプリの分岐による権限チェック」に戻るため。
 */
export async function updateShopAsAdmin(
  db: Database,
  _actor: AdminActor,
  shopId: ShopId,
  input: ShopUpdateInput,
  now: Date,
): Promise<ShopRow | null> {
  const updated = await db
    .update(shops)
    .set(toShopUpdateValues(input, now))
    .where(eq(shops.id, shopId))
    .returning();
  return updated[0] ?? null;
}

export async function deleteShopAsAdmin(
  db: Database,
  _actor: AdminActor,
  shopId: ShopId,
): Promise<boolean> {
  const deleted = await db.delete(shops).where(eq(shops.id, shopId)).returning({ id: shops.id });
  return deleted.length > 0;
}
