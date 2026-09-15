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
