import { HTTP_STATUS } from './http';

/** 4xx の下限と上限。ここに収まらない値が混ざったら「クライアントエラーの集合」ではなくなる */
const CLIENT_ERROR_STATUS_MIN = 400;
const CLIENT_ERROR_STATUS_MAX = 499;

describe('HTTP_STATUS', () => {
  it('認証・認可の分岐で使う 4 つのステータスを持つ', () => {
    expect(HTTP_STATUS).toEqual({
      unauthorized: 401,
      forbidden: 403,
      conflict: 409,
      tooManyRequests: 429,
    });
  });

  it('すべてクライアントエラー（4xx）の範囲に収まる', () => {
    for (const status of Object.values(HTTP_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(CLIENT_ERROR_STATUS_MIN);
      expect(status).toBeLessThanOrEqual(CLIENT_ERROR_STATUS_MAX);
    }
  });
});
