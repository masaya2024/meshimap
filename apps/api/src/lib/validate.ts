import { validator } from 'hono/validator';
import type { ZodType } from 'zod';
import { invalidInput } from './http-error';

/**
 * JSON ボディを Zod で検証する Hono バリデータ。
 * `@hono/zod-validator` は未インストールなので `hono/validator` の上に自前で載せる。
 *
 * エラーの詳細（どのフィールドが不正か）は返さない。返すとスキーマの構造が漏れる。
 * ここで throw した HTTPException は app.onError が拾う（実測確認済み）。
 *
 * 型引数を省略しているのは意図的。部分指定すると VF の推論が止まり、
 * hc<AppType> の戻りが unknown 化する（詳細は Task 4-11 の「確定事項 2」）。
 */
export function jsonBody<TSchema extends ZodType>(schema: TSchema) {
  return validator('json', (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw invalidInput();
    }
    return parsed.data;
  });
}
