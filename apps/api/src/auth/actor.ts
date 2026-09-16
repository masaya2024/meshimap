import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER, toUserId } from '@meshimap/core';
import type { Role, UserId } from '@meshimap/core';

declare const actorBrand: unique symbol;

/**
 * 操作主体の共通形。
 * `[actorBrand]` は宣言だけで実体がないため、このモジュールの外では作れない。
 * ロールの区別は role フィールド（リテラル型）で行うので、型ガードで as なしに絞り込める。
 */
type BrandedActor<TRole extends string, TUserId> = {
  readonly role: TRole;
  readonly userId: TUserId;
  readonly [actorBrand]: true;
};

/** 未認証を表すロール値。@meshimap/core の Role には含めない（DB に保存されないため） */
export const ROLE_ANONYMOUS = 'anonymous';

/** 一般利用者。検索・レビュー・お気に入り・予約・通報ができる（設計書 4 章） */
export type UserActor = BrandedActor<typeof ROLE_USER, UserId>;

/** 店舗管理者。自店舗の編集・予約承認・レビュー返信ができる */
export type OwnerActor = BrandedActor<typeof ROLE_OWNER, UserId>;

/** システム管理者。審査・通報対応・ユーザー停止・マスタ管理ができる */
export type AdminActor = BrandedActor<typeof ROLE_ADMIN, UserId>;

/** 未認証の閲覧者。userId を持たないので、所有者スコープの操作には型として渡せない */
export type AnonymousActor = BrandedActor<typeof ROLE_ANONYMOUS, null>;

/** 認証済みの操作主体。書き込み系のリポジトリ関数はこのいずれかを要求する */
export type Actor = UserActor | OwnerActor | AdminActor;

/** 未認証を含む閲覧主体。公開データの読み取りだけに使う */
export type Viewer = Actor | AnonymousActor;

/**
 * ブランド型の唯一の生成点。
 * `actorBrand` は declare 専用でランタイムの値が無く、オブジェクトリテラルとして書けないため
 * ここでだけ as を使う。packages/core/src/identifier.ts と同じ「検証済みの値にだけ as を当てる」方針。
 * リテラルへ直接 as を当てないのは、規約（consistent-type-assertions）が
 * `const x: T = { ... }` を書けない場合に限って値経由の as を許すため。
 */
function brandActor<TRole extends string, TUserId>(
  role: TRole,
  userId: TUserId,
): BrandedActor<TRole, TUserId> {
  const unbranded = { role, userId };
  return unbranded as BrandedActor<TRole, TUserId>;
}

/**
 * Actor の唯一の生成点。
 * 呼んでよいのは `src/auth/load-actor.ts` とテストだけで、これは Task 4-3 の検査で機械的に強制する。
 * 設計書 3.2 の「コンストラクタを外部に公開しない」を、TypeScript に friend 修飾子がないため
 * 「import 元を検査するテスト」で代替している。
 */
export function toActor(userId: string, role: Role): Actor {
  // 識別子としての検証は @meshimap/core に委ねる。ここで独自の検証を書かない
  const brandedUserId = toUserId(userId);
  switch (role) {
    case ROLE_USER:
      return Object.freeze(brandActor(ROLE_USER, brandedUserId));
    case ROLE_OWNER:
      return Object.freeze(brandActor(ROLE_OWNER, brandedUserId));
    case ROLE_ADMIN:
      return Object.freeze(brandActor(ROLE_ADMIN, brandedUserId));
  }
}

/**
 * 未認証を表す唯一の値。
 * Actor と違い userId が null なので、所有者スコープの関数へは型として渡せない。
 */
export const ANONYMOUS_VIEWER: AnonymousActor = Object.freeze(brandActor(ROLE_ANONYMOUS, null));

export function isUserActor(viewer: Viewer): viewer is UserActor {
  return viewer.role === ROLE_USER;
}

export function isOwnerActor(viewer: Viewer): viewer is OwnerActor {
  return viewer.role === ROLE_OWNER;
}

export function isAdminActor(viewer: Viewer): viewer is AdminActor {
  return viewer.role === ROLE_ADMIN;
}

export function isAuthenticatedActor(viewer: Viewer): viewer is Actor {
  return viewer.role !== ROLE_ANONYMOUS;
}
