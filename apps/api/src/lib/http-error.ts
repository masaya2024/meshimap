import { HTTPException } from 'hono/http-exception';

/**
 * クライアントへ返す文言はすべてここで固定する。
 * 例外のメッセージをそのまま返すと、SQL やテーブル名が漏れる経路ができる。
 */
export const ERROR_MESSAGE_UNAUTHORIZED = 'ログインが必要です';
export const ERROR_MESSAGE_FORBIDDEN = 'この操作を行う権限がありません';
export const ERROR_MESSAGE_NOT_FOUND = '対象が見つかりません';
export const ERROR_MESSAGE_INVALID_INPUT = '入力内容が正しくありません';
export const ERROR_MESSAGE_INTERNAL = 'サーバ内部でエラーが発生しました';

/** 未認証。リソースの存在に依存しないので情報は漏れない */
export function unauthorized(): HTTPException {
  return new HTTPException(401, { message: ERROR_MESSAGE_UNAUTHORIZED });
}

/**
 * ロールだけで拒否できる場合に使う。
 * リソース ID を見る前に返すため、どんな ID でも同じ応答になり存在有無が漏れない。
 */
export function forbidden(): HTTPException {
  return new HTTPException(403, { message: ERROR_MESSAGE_FORBIDDEN });
}

/**
 * 「存在しない」と「所有者でないので触れない」の両方でこれを返す。
 * 区別して返すと「その ID のリソースは存在する」ことが漏れる。
 */
export function notFound(): HTTPException {
  return new HTTPException(404, { message: ERROR_MESSAGE_NOT_FOUND });
}

/** バリデーション失敗。どのフィールドが悪いかは返さない（スキーマ構造が漏れるため） */
export function invalidInput(): HTTPException {
  return new HTTPException(422, { message: ERROR_MESSAGE_INVALID_INPUT });
}
