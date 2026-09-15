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
