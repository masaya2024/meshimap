import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ERROR_MESSAGE_INTERNAL,
  ERROR_MESSAGE_NOT_FOUND,
  forbidden,
  notFound,
} from '../lib/http-error';
import type { AppEnv } from '../lib/app-env';
import * as logger from '../lib/logger';
import { errorHandler, notFoundHandler } from './error-handler';

/** Error インスタンス以外を throw した場合の検証用。文言自体に意味は無い */
const THROWN_STRING = 'ただの文字列';

/** 機密が混ざった例外メッセージ。これが応答に出てはいけない */
const LEAKY_MESSAGE =
  'D1_ERROR: no such column: shops.owner_id at /var/app/src/repositories/shop-repository.ts:42';

// errorHandler / notFoundHandler は ErrorHandler<AppEnv> なので、
// 素の Hono（BlankEnv）に渡すと型が合わない。アプリ本体と同じ型引数で組み立てる
function createApp(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .onError(errorHandler)
    .notFound(notFoundHandler)
    .get('/ok', (c) => c.json({ status: 'ok' }))
    .get('/http-exception', () => {
      throw notFound();
    })
    .get('/forbidden', () => {
      throw forbidden();
    })
    .get('/boom', () => {
      throw new Error(LEAKY_MESSAGE);
    })
    .get('/throw-string', () => {
      // Error 以外が throw された場合の経路を再現する。
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- 非 Error の throw を意図的に起こす検証
      throw THROWN_STRING;
    });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorHandler', () => {
  it('正常系には介入しない', async () => {
    const res = await createApp().request('/ok');
    expect(res.status).toBe(200);
  });

  it('HTTPException のステータスと文言をそのまま返す', async () => {
    const res = await createApp().request('/http-exception');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { status: 404, message: ERROR_MESSAGE_NOT_FOUND } });
  });

  it('403 の HTTPException も同じ形で返す', async () => {
    const res = await createApp().request('/forbidden');
    expect(res.status).toBe(403);
  });

  it('未知の例外は 500 と固定文言に置き換える', async () => {
    vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    const res = await createApp().request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { status: 500, message: ERROR_MESSAGE_INTERNAL } });
  });

  it('未知の例外のメッセージを応答本文に含めない', async () => {
    vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    const res = await createApp().request('/boom');
    const body = await res.text();
    expect(body).not.toContain('D1_ERROR');
    expect(body).not.toContain('owner_id');
    expect(body).not.toContain('shop-repository.ts');
    expect(body).not.toContain(LEAKY_MESSAGE);
  });

  it('スタックトレースを応答本文に含めない', async () => {
    vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    const res = await createApp().request('/boom');
    const body = await res.text();
    expect(body).not.toMatch(/at\s|\.ts:|\.js:|stack/i);
  });

  it('Error でない値の throw は onError に渡らず再送出される（応答本文が作られない）', async () => {
    // hono 4.13.7 の #handleError は `err instanceof Error` を満たさない値を
    // errorHandler へ渡さずそのまま再送出する（node_modules/hono/dist/hono-base.js で確認）。
    // 単一ハンドラ経路では同期 try/catch の中で再送出されるため、request() は
    // 拒否された Promise ではなく同期 throw になる。だから try/catch で受ける。
    // 応答本文が一切作られないので、throw された値がクライアントへ出る経路は無い。
    const spy = vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    let thrown: unknown;
    try {
      await createApp().request('/throw-string');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(THROWN_STRING);
    expect(spy).not.toHaveBeenCalled();
  });

  it('未知の例外はサーバ側ログに残す', async () => {
    const spy = vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    await createApp().request('/boom');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('HTTPException はサーバ側ログに残さない（想定内のため）', async () => {
    const spy = vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    await createApp().request('/http-exception');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('notFoundHandler', () => {
  it('未定義のルートは errorHandler と同じ形の 404 を返す', async () => {
    const res = await createApp().request('/no-such-route');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { status: 404, message: ERROR_MESSAGE_NOT_FOUND } });
  });
});
