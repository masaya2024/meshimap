import { isRole } from '@meshimap/core';
import { eq } from 'drizzle-orm';
import { PROFILE_STATUS_ACTIVE } from '../db/constants';
import { profiles } from '../db/schema';
import type { Database } from '../db/client';
import { toActor } from './actor';
import type { Actor } from './actor';

/**
 * Actor を組み立てられなかった理由を呼び出し側へ伝える。
 * 例外ではなく値で返すのは、ミドルウェア以外（テストやバッチ）から使っても
 * HTTP のステータスを勝手に決めてしまわないようにするため。
 */
export type ActorLoadResult =
  | { readonly kind: 'found'; readonly actor: Actor }
  | { readonly kind: 'no-profile' }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'invalid-role' };

/**
 * profiles から読んだ生の行。
 * role / status を `Role` / `ProfileStatus` ではなく `string` で受けるのは、
 * **DB の値が型どおりである保証がない**（CHECK 制約はマイグレーションで外れうる）ため。
 * 信じずに検査するのがこの関数の仕事。
 */
export type ProfileRow = {
  readonly role: string;
  readonly status: string;
};

/**
 * profiles の行から Actor を決める純関数。
 *
 * DB アクセスと分けてあるのは、`invalid-role` の分岐を直接検証するため。
 * `profiles.role` には ck_profiles_role という CHECK 制約があるので、
 * 通常の UPDATE では壊れた値を作れず、DB 経由だとこの分岐に到達できない。
 */
export function decideActor(userId: string, row: ProfileRow | undefined): ActorLoadResult {
  if (row === undefined) {
    return { kind: 'no-profile' };
  }
  if (row.status !== PROFILE_STATUS_ACTIVE) {
    // suspended も deleted も拒否する。admin であっても特権を与えない
    return { kind: 'suspended' };
  }
  if (!isRole(row.role)) {
    // DB に未知のロールが入っている = 壊れている。通すより落とす
    return { kind: 'invalid-role' };
  }
  return { kind: 'found', actor: toActor(userId, row.role) };
}

/**
 * Better Auth のセッションが指すユーザー ID から Actor を組み立てる。
 * role は設計書 6 章のとおり profiles テーブルにあるため、セッション検証だけでは決まらない。
 */
export async function loadActor(db: Database, userId: string): Promise<ActorLoadResult> {
  const rows = await db
    .select({ role: profiles.role, status: profiles.status })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  return decideActor(userId, rows[0]);
}
