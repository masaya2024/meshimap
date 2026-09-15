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
