import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { DAYS_PER_WEEK, MINUTES_PER_HOUR } from '@meshimap/core';
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

// ─────────────────────────── 定数 ───────────────────────────

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
/** 1 店舗あたりの写真枚数 */
const PHOTOS_PER_SHOP = 2;

/** 冒頭で空にするテーブル。参照している側から並べる */
const DELETE_TARGET_TABLES: readonly string[] = [
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
];

/** 店の予算。ランチは 800 円から、ディナーは 2500 円から段階的に振る */
const LUNCH_BUDGET_BASE_YEN = 800;
const LUNCH_BUDGET_STEP_YEN = 100;
const LUNCH_BUDGET_STEP_COUNT = 5;
const LUNCH_BUDGET_SPREAD_YEN = 400;
const DINNER_BUDGET_BASE_YEN = 2500;
const DINNER_BUDGET_STEP_YEN = 500;
const DINNER_BUDGET_STEP_COUNT = 6;
const DINNER_BUDGET_SPREAD_YEN = 1500;

/** 座標を丸める小数桁数。桁が揺れると geohash も揺れ、テストの期待値が書けない */
const COORDINATE_DECIMAL_DIGITS = 6;

/** 通し番号の桁数。id の見た目を揃えるためだけの値 */
const SHOP_NUMBER_DIGITS = 3;
const USER_NUMBER_DIGITS = 2;
const REVIEW_NUMBER_DIGITS = 4;

/** 郵便番号の先頭 3 桁は「1」+ 50 からの連番。150-xxxx 〜 161-xxxx に収まる */
const POSTAL_CODE_AREA_BASE = 50;
/** 電話番号の下 4 桁に足す下駄。店舗ごとに重複しない番号を作るためだけの値 */
const PHONE_LOCAL_BASE = 1000;
const PHONE_SUBSCRIBER_BASE = 2000;

/** 開店時刻（時）。全店共通 */
const OPEN_HOUR = 11;
/** 閉店時刻（時）の下限と、そこから足す幅 */
const CLOSE_HOUR_BASE = 22;
const CLOSE_HOUR_SPREAD = 4;

const MENU_CATEGORY_NAMES: readonly string[] = ['おすすめ', '一品料理'];
const MENU_ITEM_NAMES: readonly string[] = [
  '本日のおすすめ',
  '定番セット',
  '季節の一皿',
  '自家製デザート',
];
const MENU_ITEMS_PER_CATEGORY = 2;
/** メニュー価格。800 円から 100 円刻みで 12 段階 */
const MENU_PRICE_BASE_YEN = 800;
const MENU_PRICE_STEP_YEN = 100;
const MENU_PRICE_STEP_COUNT = 12;

/** 席設定。10 席から 30 段階、予約枠は 90 分、同時受付は 1〜3 枠 */
const SEAT_CAPACITY_BASE = 10;
const SEAT_CAPACITY_SPREAD = 30;
const SEAT_SLOT_MINUTES = 90;
const MAX_PARALLEL_BASE = 1;
const MAX_PARALLEL_SPREAD = 3;

/** 訪問日として使う固定日。実行日時に依存させないことで決定的になる */
const REVIEW_VISITED_DATES: readonly string[] = [
  '2026-06-14',
  '2026-07-05',
  '2026-07-21',
  '2026-08-09',
  '2026-08-30',
];

/** 評価は 3〜5 にする。1〜2 ばかりだと平均が実運用とかけ離れる */
const REVIEW_RATING_BASE = 3;
const REVIEW_RATING_SPREAD = 3;
/** レビューの予算。1000 円から 500 円刻みで 10 段階 */
const REVIEW_BUDGET_BASE_YEN = 1000;
const REVIEW_BUDGET_STEP_YEN = 500;
const REVIEW_BUDGET_STEP_COUNT = 10;

// ─────────────────────────── 冪等化 ───────────────────────────
// 何度流しても同じ状態になるよう、まず全部消す。
// 削除順は「参照している側から」。この順序が正しさの根拠であり、並べ替えてはいけない。
//
// 下の PRAGMA は保険にならない。D1 の `exec()` は 1 文ずつ autocommit で走らせるので、
// `defer_foreign_keys` は直後のコミットで 0 に戻る（別の文で読み直すと 0、実測）。
// 同じ接続で `PRAGMA foreign_keys` は 1 なので、FK は素通しではなく効いている。
// それでも残すのは `wrangler d1 execute --file=` 経路がファイル全体を 1 つの
// トランザクションで流す可能性があるため。そちらは未実測なので、効くとは書かない。
emit('PRAGMA defer_foreign_keys = true;');
for (const tableName of DELETE_TARGET_TABLES) {
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
    id: `usr_owner_${String(index + 1).padStart(USER_NUMBER_DIGITS, '0')}`,
    name: `${area.name} オーナー`,
    email: `owner${String(index + 1).padStart(USER_NUMBER_DIGITS, '0')}@meshimap.example`,
    role: 'owner',
  });
}
for (let index = 0; index < REVIEW_USER_COUNT; index += 1) {
  seedUsers.push({
    id: `usr_member_${String(index + 1).padStart(USER_NUMBER_DIGITS, '0')}`,
    name: `テスト利用者 ${String(index + 1).padStart(USER_NUMBER_DIGITS, '0')}`,
    email: `member${String(index + 1).padStart(USER_NUMBER_DIGITS, '0')}@meshimap.example`,
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
    const latitude = Number((area.latitude + offset[0]).toFixed(COORDINATE_DECIMAL_DIGITS));
    const longitude = Number((area.longitude + offset[1]).toFixed(COORDINATE_DECIMAL_DIGITS));
    // geohash は必ずここで計算する。SQL 側に計算手段は無い
    const geohash = encodeGeohash(coordinate(latitude, longitude), SHOP_GEOHASH_PRECISION);
    const prefixes = SHOP_NAME_PREFIXES[genre.id];
    if (prefixes === undefined) {
      throw new Error(`店名の前半分が未定義です: ${genre.id}`);
    }
    const shopNumber = areaIndex * SHOPS_PER_AREA + shopIndex + 1;
    const shopId = `shp_${String(shopNumber).padStart(SHOP_NUMBER_DIGITS, '0')}`;
    const namePrefix = pick(prefixes);
    const nameSuffix = pick(SHOP_NAME_SUFFIXES);
    const name = `${namePrefix.text} ${nameSuffix.text}`;
    const nameKana = `${namePrefix.kana} ${nameSuffix.kana}`;
    const ownerId = `usr_owner_${String(areaIndex + 1).padStart(USER_NUMBER_DIGITS, '0')}`;
    const description = pick(DESCRIPTION_TEMPLATES).replaceAll('{genre}', genre.name);
    const lunchMin =
      LUNCH_BUDGET_BASE_YEN + randomInt(LUNCH_BUDGET_STEP_COUNT) * LUNCH_BUDGET_STEP_YEN;
    const lunchMax =
      lunchMin +
      LUNCH_BUDGET_SPREAD_YEN +
      randomInt(LUNCH_BUDGET_STEP_COUNT) * LUNCH_BUDGET_STEP_YEN;
    const dinnerMin =
      DINNER_BUDGET_BASE_YEN + randomInt(DINNER_BUDGET_STEP_COUNT) * DINNER_BUDGET_STEP_YEN;
    const dinnerMax =
      dinnerMin +
      DINNER_BUDGET_SPREAD_YEN +
      randomInt(DINNER_BUDGET_STEP_COUNT) * DINNER_BUDGET_STEP_YEN;

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
          sqlText(
            `1${String(POSTAL_CODE_AREA_BASE + areaIndex).padStart(2, '0')}-000${String(shopIndex + 1)}`,
          ),
          sqlText(
            `${area.addressPrefix}${String(shopIndex + 1)}-${String(areaIndex + 1)}-${String(shopNumber)}`,
          ),
          sqlNumber(latitude),
          sqlNumber(longitude),
          sqlText(geohash),
          sqlText(
            `03-${String(PHONE_LOCAL_BASE + shopNumber)}-${String(PHONE_SUBSCRIBER_BASE + shopNumber)}`,
          ),
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

// ─────────────────────────── 営業時間 ───────────────────────────
for (const seedShop of seedShops) {
  // 定休日を 1 日だけ持たせる。日曜(0)は避けて月〜土から選ぶ
  const closedDay = 1 + randomInt(DAYS_PER_WEEK - 1);
  const openHour = OPEN_HOUR;
  const closeHour = CLOSE_HOUR_BASE + randomInt(CLOSE_HOUR_SPREAD);
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
      const price = MENU_PRICE_BASE_YEN + randomInt(MENU_PRICE_STEP_COUNT) * MENU_PRICE_STEP_YEN;
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
    `INSERT INTO \`seat_settings\` (\`shop_id\`, \`capacity\`, \`slot_minutes\`, \`max_parallel\`, \`accepts_reservation\`) VALUES (${sqlText(seedShop.id)}, ${sqlNumber(SEAT_CAPACITY_BASE + randomInt(SEAT_CAPACITY_SPREAD))}, ${sqlNumber(SEAT_SLOT_MINUTES)}, ${sqlNumber(MAX_PARALLEL_BASE + randomInt(MAX_PARALLEL_SPREAD))}, 1);`,
  );
}

// ─────────────────────────── レビュー ───────────────────────────
let reviewCount = 0;
for (const seedShop of seedShops) {
  const reviewsForShop = randomInt(REVIEWS_PER_SHOP_MAX + 1);
  // 同じ店に同じ人が 2 件書けない（`uq_reviews_shop_user`）ので、使った人を記録する
  const usedUserIds = new Set<string>();
  for (let reviewIndex = 0; reviewIndex < reviewsForShop; reviewIndex += 1) {
    let userId = `usr_member_${String(1 + randomInt(REVIEW_USER_COUNT)).padStart(USER_NUMBER_DIGITS, '0')}`;
    while (usedUserIds.has(userId)) {
      userId = `usr_member_${String(1 + randomInt(REVIEW_USER_COUNT)).padStart(USER_NUMBER_DIGITS, '0')}`;
    }
    usedUserIds.add(userId);
    reviewCount += 1;
    emit(
      `INSERT INTO \`reviews\` (\`id\`, \`shop_id\`, \`user_id\`, \`rating\`, \`body\`, \`visited_on\`, \`budget\`, \`status\`) VALUES (` +
        [
          sqlText(`rvw_${String(reviewCount).padStart(REVIEW_NUMBER_DIGITS, '0')}`),
          sqlText(seedShop.id),
          sqlText(userId),
          sqlNumber(REVIEW_RATING_BASE + randomInt(REVIEW_RATING_SPREAD)),
          sqlText(pick(REVIEW_BODY_TEMPLATES)),
          sqlText(pick(REVIEW_VISITED_DATES)),
          sqlNumber(
            REVIEW_BUDGET_BASE_YEN + randomInt(REVIEW_BUDGET_STEP_COUNT) * REVIEW_BUDGET_STEP_YEN,
          ),
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

// ─────────────────────────── 出力 ───────────────────────────

/**
 * `seeds/seed.sql` の中身そのもの。1 行 1 文で、末尾に改行が 1 つ付く。
 *
 * 1 文を必ず 1 行に収めるのは `applySeed()`（src/db/testing/local-d1.ts）が
 * 改行で文を割るため。複数行に跨る文を足すと読み込み側が壊れる。
 */
export const seedSql = `${statements.join('\n')}\n`;

/**
 * このファイルが `tsx scripts/generate-seed.ts` として直接起動されたか。
 *
 * `seedSql` を import するテストがあるので、import されただけで
 * 標準出力へ 1000 行以上を吐かないよう切り分ける。
 */
const isRunAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isRunAsScript) {
  process.stdout.write(seedSql);
  process.stderr.write(
    `店舗 ${String(seedShops.length)} 件 / レビュー ${String(reviewCount)} 件 / SQL ${String(statements.length)} 文\n`,
  );
}
