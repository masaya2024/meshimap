import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import {
  ERROR_MESSAGE_FORBIDDEN,
  ERROR_MESSAGE_INTERNAL,
  ERROR_MESSAGE_INVALID_INPUT,
  ERROR_MESSAGE_NOT_FOUND,
  ERROR_MESSAGE_UNAUTHORIZED,
  forbidden,
  invalidInput,
  notFound,
  unauthorized,
} from './http-error';

describe('HTTP エラーファクトリ', () => {
  it('unauthorized は 401 の HTTPException を返す', () => {
    const error = unauthorized();
    expect(error).toBeInstanceOf(HTTPException);
    expect(error.status).toBe(401);
    expect(error.message).toBe(ERROR_MESSAGE_UNAUTHORIZED);
  });

  it('forbidden は 403 の HTTPException を返す', () => {
    const error = forbidden();
    expect(error.status).toBe(403);
    expect(error.message).toBe(ERROR_MESSAGE_FORBIDDEN);
  });

  it('notFound は 404 の HTTPException を返す', () => {
    const error = notFound();
    expect(error.status).toBe(404);
    expect(error.message).toBe(ERROR_MESSAGE_NOT_FOUND);
  });

  it('invalidInput は 422 の HTTPException を返す', () => {
    const error = invalidInput();
    expect(error.status).toBe(422);
    expect(error.message).toBe(ERROR_MESSAGE_INVALID_INPUT);
  });

  it('文言は決められた日本語そのものである', () => {
    // 上の各テストは定数どうしを比べているだけなので、文言が空文字に変わっても通ってしまう。
    // リテラルと突き合わせて初めて「文言が消えた」に気づける
    expect(ERROR_MESSAGE_UNAUTHORIZED).toBe('ログインが必要です');
    expect(ERROR_MESSAGE_FORBIDDEN).toBe('この操作を行う権限がありません');
    expect(ERROR_MESSAGE_NOT_FOUND).toBe('対象が見つかりません');
    expect(ERROR_MESSAGE_INVALID_INPUT).toBe('入力内容が正しくありません');
    expect(ERROR_MESSAGE_INTERNAL).toBe('サーバ内部でエラーが発生しました');
  });

  it('文言に内部情報を示す語が含まれていない', () => {
    // 「どのテーブルか」「どのカラムか」が分かる文言は情報漏洩になる
    const messages = [
      ERROR_MESSAGE_UNAUTHORIZED,
      ERROR_MESSAGE_FORBIDDEN,
      ERROR_MESSAGE_NOT_FOUND,
      ERROR_MESSAGE_INVALID_INPUT,
    ];
    for (const message of messages) {
      expect(message).not.toMatch(/sql|table|column|owner_id|user_id|D1/i);
    }
  });

  it('notFound の文言は「権限がない」と「存在しない」を区別しない', () => {
    // 区別する文言を返すと、リソースの存在有無が漏れる
    expect(ERROR_MESSAGE_NOT_FOUND).not.toMatch(/権限|所有|アクセス/);
  });
});
