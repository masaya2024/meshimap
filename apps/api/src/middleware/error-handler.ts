import { HTTPException } from 'hono/http-exception';
import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { AppEnv } from '../lib/app-env';
import { ERROR_MESSAGE_INTERNAL, ERROR_MESSAGE_NOT_FOUND } from '../lib/http-error';
import { logError } from '../lib/logger';

/**
 * 例外を JSON へ変換する唯一の出口。
 * HTTPException は「意図して投げたもの」なので文言をそのまま返してよい
 * （文言は src/lib/http-error.ts の固定文字列に限られる）。
 * それ以外は何が入っているか分からないので、内容を一切外へ出さない。
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: { status: err.status, message: err.message } }, err.status);
  }

  // 例外の中身（SQL、ファイルパス、スタック）はサーバ側のログにだけ残す
  logError('未処理の例外', err);
  return c.json({ error: { status: 500, message: ERROR_MESSAGE_INTERNAL } }, 500);
};

/** 未定義ルート。errorHandler の 404 と応答の形を揃える（形が違うと経路が推測できる） */
export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  c.json({ error: { status: 404, message: ERROR_MESSAGE_NOT_FOUND } }, 404);
