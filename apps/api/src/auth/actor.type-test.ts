// このファイルは実行されない。tsc が「本来コンパイルエラーになるべきコード」を検査する。
// `@ts-expect-error` が付いた行が実際にはエラーにならない場合、tsc は（この行のように
// 先頭を記号で始めればディレクティブとして解釈されない）
// 「Unused '@ts-expect-error' directive」として失敗する。つまりブランド型が壊れたら typecheck が落ちる。
import { ROLE_OWNER, ROLE_USER, toUserId } from '@meshimap/core';
import { toActor } from './actor';
import type { AdminActor, Actor, AnonymousActor, OwnerActor, UserActor, Viewer } from './actor';

declare const userActor: UserActor;
declare const ownerActor: OwnerActor;
declare const adminActor: AdminActor;
declare const anonymousViewer: AnonymousActor;

// --- 代入できてはいけない組み合わせ ---

// @ts-expect-error ブランドを持たない素のオブジェクトは OwnerActor にならない
export const bareObject: OwnerActor = { role: ROLE_OWNER, userId: toUserId('usr_bob') };

// @ts-expect-error UserActor は OwnerActor に代入できない
export const userToOwner: OwnerActor = userActor;

// @ts-expect-error OwnerActor は AdminActor に代入できない
export const ownerToAdmin: AdminActor = ownerActor;

// @ts-expect-error AdminActor は OwnerActor に代入できない（admin 用の関数は別に用意する）
export const adminToOwner: OwnerActor = adminActor;

// @ts-expect-error 素の文字列は OwnerActor に代入できない
export const rawStringToOwner: OwnerActor = 'usr_bob';

// @ts-expect-error 匿名は認証済み Actor に代入できない
export const anonymousToActor: Actor = anonymousViewer;

// --- 代入できなければならない組み合わせ（ここがエラーになったら型が厳しすぎる） ---

export const userToActor: Actor = userActor;
export const ownerToActor: Actor = ownerActor;
export const adminToActor: Actor = adminActor;
export const actorToViewer: Viewer = userActor;
export const anonymousToViewer: Viewer = anonymousViewer;

// --- ファクトリの戻り値はユニオンなので、絞り込まずに OwnerActor へは渡せない ---

// @ts-expect-error toActor の戻り値は Actor（ユニオン）なので OwnerActor に直接代入できない
export const factoryToOwner: OwnerActor = toActor('usr_bob', ROLE_USER);
