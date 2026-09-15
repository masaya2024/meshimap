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
