import { describe, expect, it } from 'vitest';
import * as geo from './index';

describe('@meshimap/geo の公開 API', () => {
  it('公開する関数と定数が過不足なく揃っている', () => {
    // 意図しない公開・意図しない削除の両方を検知するためのスナップショット的テスト
    expect([...Object.keys(geo)].sort()).toEqual([
      'DEGREES_TO_RADIANS',
      'EARTH_RADIUS_M',
      'GEOHASH_BASE32',
      'GEOHASH_LENGTH_MAX',
      'GEOHASH_LENGTH_MIN',
      'LATITUDE_MAX',
      'LATITUDE_MIN',
      'LONGITUDE_MAX',
      'LONGITUDE_MIN',
      'ZOOM_MAX',
      'ZOOM_MIN',
      'boundingBox',
      'cellsForRadius',
      'clusterByGrid',
      'coordinate',
      'decodeGeohash',
      'distanceMeters',
      'encodeGeohash',
      'formatDistance',
      'isWithinBounds',
      'neighborCells',
      'precisionForRadius',
      'precisionForZoom',
      'toGeohash',
      'toLatitude',
      'toLongitude',
      'wrapLongitude',
    ]);
  });

  it('3 段階検索を通しで実行できる', () => {
    // 第 1 段: geohash セル → 第 2 段: 境界ボックス → 第 3 段: Haversine
    const center = geo.coordinate(35.689592, 139.700413);
    const radiusM = 1000;

    const shops = [
      { name: '近い店', location: geo.coordinate(35.6905, 139.7015) },
      { name: '遠い店', location: geo.coordinate(35.681236, 139.767125) },
    ];

    const cells = new Set(geo.cellsForRadius(center, radiusM));
    const precision = geo.precisionForRadius(radiusM);
    const bounds = geo.boundingBox(center, radiusM);

    const found = shops
      .filter((shop) => cells.has(geo.encodeGeohash(shop.location, precision)))
      .filter((shop) => geo.isWithinBounds(shop.location, bounds))
      .filter((shop) => geo.distanceMeters(center, shop.location) <= radiusM);

    expect(found.map((shop) => shop.name)).toEqual(['近い店']);
  });

  it('検索結果を表示用に整形できる', () => {
    const center = geo.coordinate(35.689592, 139.700413);
    const shop = geo.coordinate(35.681236, 139.767125);
    expect(geo.distanceMeters(center, shop)).toBeCloseTo(6096.4, 1);
    expect(geo.formatDistance(geo.distanceMeters(center, shop))).toBe('6.1km');
  });
});
