import { describe, expect, it } from 'vitest';
import { toMinuteOfDay } from './minute-of-day';
import { canReserve } from './reservation-availability';
import type { ExistingReservation } from './reservation-availability';
import type { ReservationSlot, SeatSettings } from './reservation-slot';

const SLOT: ReservationSlot = {
  startMinute: toMinuteOfDay(1080),
  endMinute: toMinuteOfDay(1170),
};

function seatSettings(overrides: Partial<SeatSettings> = {}): SeatSettings {
  return {
    capacity: 10,
    slotMinutes: 90,
    maxParallel: 3,
    acceptsReservation: true,
    ...overrides,
  };
}

function reservation(startMinute: number, partySize: number): ExistingReservation {
  return { startMinute: toMinuteOfDay(startMinute), partySize };
}

describe('canReserve', () => {
  it('予約が 1 件も無ければ空席は席数どおりで予約できる', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [],
        partySize: 2,
      }),
    ).toEqual({ isAvailable: true, reason: null, remainingSeats: 10 });
  });

  it('残席ちょうどの人数を受け入れる', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1080, 9)],
        partySize: 1,
      }),
    ).toEqual({ isAvailable: true, reason: null, remainingSeats: 1 });
  });

  it('残席を 1 名超えると seats-full で拒否する', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1080, 9)],
        partySize: 2,
      }),
    ).toEqual({ isAvailable: false, reason: 'seats-full', remainingSeats: 1 });
  });

  it('満席なら残席 0 で seats-full を返す', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1080, 6), reservation(1080, 4)],
        partySize: 1,
      }),
    ).toEqual({ isAvailable: false, reason: 'seats-full', remainingSeats: 0 });
  });

  it('同時受付数に達していれば残席があっても parallel-full で拒否する', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1080, 1), reservation(1080, 1), reservation(1080, 1)],
        partySize: 1,
      }),
    ).toEqual({
      isAvailable: false,
      reason: 'parallel-full',
      remainingSeats: 7,
    });
  });

  it('別の枠の予約は残席にも同時受付数にも影響しない', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1170, 5), reservation(1170, 5), reservation(1170, 5)],
        partySize: 1,
      }),
    ).toEqual({ isAvailable: true, reason: null, remainingSeats: 10 });
  });

  it('席数ちょうどの人数は受け入れる', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [],
        partySize: 10,
      }),
    ).toEqual({ isAvailable: true, reason: null, remainingSeats: 10 });
  });

  it('席数を超える人数は party-too-large で拒否する', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [],
        partySize: 11,
      }),
    ).toEqual({
      isAvailable: false,
      reason: 'party-too-large',
      remainingSeats: 10,
    });
  });

  it('受付停止中は他の条件より先に not-accepting を返す', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings({ acceptsReservation: false }),
        existingReservations: [reservation(1080, 10)],
        partySize: 20,
      }),
    ).toEqual({
      isAvailable: false,
      reason: 'not-accepting',
      remainingSeats: 0,
    });
  });

  it('定員超過は同時受付数より先に判定する', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [reservation(1080, 1), reservation(1080, 1), reservation(1080, 1)],
        partySize: 11,
      }),
    ).toEqual({
      isAvailable: false,
      reason: 'party-too-large',
      remainingSeats: 7,
    });
  });

  it('予約が席数を超えていても残席は 0 で下げ止まる', () => {
    expect(
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings({ capacity: 5, maxParallel: 10 }),
        existingReservations: [reservation(1080, 4), reservation(1080, 4)],
        partySize: 1,
      }),
    ).toEqual({ isAvailable: false, reason: 'seats-full', remainingSeats: 0 });
  });

  it('人数が下限 1 名未満なら拒否する', () => {
    expect(() =>
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [],
        partySize: 0,
      }),
    ).toThrow(new RangeError('人数は 1 〜 20 の整数である必要があります: 0'));
  });

  it('人数が上限 20 名を超えたら拒否する', () => {
    expect(() =>
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings({ capacity: 100 }),
        existingReservations: [],
        partySize: 21,
      }),
    ).toThrow(new RangeError('人数は 1 〜 20 の整数である必要があります: 21'));
  });

  it('人数の小数を拒否する', () => {
    expect(() =>
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings(),
        existingReservations: [],
        partySize: 2.5,
      }),
    ).toThrow(new RangeError('人数は 1 〜 20 の整数である必要があります: 2.5'));
  });

  it('席設定が不正なら人数判定より先に拒否する', () => {
    expect(() =>
      canReserve({
        slot: SLOT,
        seatSettings: seatSettings({ maxParallel: 0 }),
        existingReservations: [],
        partySize: 0,
      }),
    ).toThrow(new RangeError('同時受付数は 1 〜 100 の整数である必要があります: 0'));
  });
});
