// 予約枠に対して「いま予約を受けられるか」を判定する。理由コードを返して UI の文言を分ける。

import { PARTY_SIZE_MAX, PARTY_SIZE_MIN } from './constants';
import { assertSeatSettings } from './reservation-slot';
import type { ReservationSlot, SeatSettings } from './reservation-slot';
import type { MinuteOfDay } from './minute-of-day';

export type ExistingReservation = {
  readonly startMinute: MinuteOfDay;
  readonly partySize: number;
};

export type ReservationBlockReason =
  'not-accepting' | 'party-too-large' | 'parallel-full' | 'seats-full';

export type ReservationAvailability = {
  readonly isAvailable: boolean;
  readonly reason: ReservationBlockReason | null;
  /** 残席。満席でも 0 で頭打ちにして、負の数を UI に出さない。 */
  readonly remainingSeats: number;
};

export type ReservationRequest = {
  readonly slot: ReservationSlot;
  readonly seatSettings: SeatSettings;
  readonly existingReservations: readonly ExistingReservation[];
  readonly partySize: number;
};

export function canReserve(request: ReservationRequest): ReservationAvailability {
  assertSeatSettings(request.seatSettings);
  if (
    !Number.isInteger(request.partySize) ||
    request.partySize < PARTY_SIZE_MIN ||
    request.partySize > PARTY_SIZE_MAX
  ) {
    throw new RangeError(
      `人数は ${PARTY_SIZE_MIN} 〜 ${PARTY_SIZE_MAX} の整数である必要があります: ${request.partySize}`,
    );
  }

  const sameSlot = request.existingReservations.filter(
    (reservation) => reservation.startMinute === request.slot.startMinute,
  );
  const occupiedSeats = sameSlot.reduce((total, reservation) => total + reservation.partySize, 0);
  const remainingSeats = Math.max(0, request.seatSettings.capacity - occupiedSeats);

  // 判定順が UI の文言を決める。受付停止 → 人数超過 → 件数上限 → 残席不足
  if (!request.seatSettings.acceptsReservation) {
    return { isAvailable: false, reason: 'not-accepting', remainingSeats };
  }
  if (request.partySize > request.seatSettings.capacity) {
    return { isAvailable: false, reason: 'party-too-large', remainingSeats };
  }
  if (sameSlot.length >= request.seatSettings.maxParallel) {
    return { isAvailable: false, reason: 'parallel-full', remainingSeats };
  }
  if (request.partySize > remainingSeats) {
    return { isAvailable: false, reason: 'seats-full', remainingSeats };
  }
  return { isAvailable: true, reason: null, remainingSeats };
}
