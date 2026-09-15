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
import { requireCondition } from './conditions';

/**
 * geohash の前方一致に使う上限文字。
 * base32 の最大文字は 'z'(0x7A) なので、その次の '{'(0x7B) を上限にすると
 * `prefix <= geohash < prefix + '{'` が「prefix で始まる文字列」全体をちょうど覆う。
 *
 * ここを 'z' にすると `xn76fz*` のセル末尾が範囲から落ちる。
 * 件数のテストでは検知できない（シードにその形の geohash がいない）ため、
 * nearby-shops.test.ts の「geohashPrefixCondition の境界」で直接確かめている。
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
 *
 * `GLOB ?` ではなく範囲比較にするのは速度のためではない。
 * `GLOB ?` もバインド値が前方一致パターンなら SQLite の LIKE 最適化が働き、
 * 範囲制約へ書き換わって `idx_shops_status_geohash` を使う（プランは同一）。
 * しかし先頭ワイルドカード（`*n76f*`）を渡されると最適化が外れて全表走査に落ちる。
 * つまり索引が効くかどうかが実行時の値に左右される。
 * 範囲比較なら値に関係なく必ず索引の範囲検索になるので、こちらを採る。
 *
 * `and()` の戻りが `SQL | undefined` なのは「条件なし」を表せる API だからで、
 * 条件を 2 つ渡すここでは undefined にならない。型を絞るのは requireCondition に任せる。
 */
export function geohashPrefixCondition(cell: string): SQL {
  return requireCondition(
    and(gte(shops.geohash, cell), lt(shops.geohash, `${cell}${GEOHASH_UPPER_BOUND_CHARACTER}`)),
  );
}

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

  // 段 2 ─ 矩形で切る。
  // 矩形は円を外接で覆うので、ここで落ちる行は段 3 でも必ず落ちる。
  // つまりこの段は返り値を変えず、Haversine を呼ぶ回数を減らすだけの枝刈りであり、
  // 出力を見るテストでは「消しても通ってしまう」（Step 8 の 2 番目で実測）。
  // 段 2 の効き目は nearby-shops.test.ts の countStage2 が
  // 実装とは独立に矩形を当てて件数で示している
  const bounds = boundingBox(search.center, search.radiusM);

  // 段 3 ─ 厳密な距離で切り、近い順に並べ、limit で切る
  return (
    candidates
      .filter((row) => isWithinBounds(coordinate(row.latitude, row.longitude), bounds))
      .map((row) => ({
        ...row,
        distanceM: distanceMeters(search.center, coordinate(row.latitude, row.longitude)),
      }))
      // 半径ちょうどの店は含める（閉区間）。`<` にすると境界の店が消える
      .filter((row) => row.distanceM <= search.radiusM)
      // 距離が 1 ビットも違わない店（同一座標の 2 軒など）の順序が
      // SQL の返却順に引きずられないよう、第 2 キーに id を置く。
      // 東西対称に見える 190m の 4 軒は、経度差の浮動小数点表現が非対称なため
      // 実際には全部値が違う。同値になるのは座標が完全に一致する場合だけ
      .sort((left, right) => left.distanceM - right.distanceM || left.id.localeCompare(right.id))
      .slice(0, search.limit)
  );
}
