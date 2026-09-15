/** 認証・認可まわりで分岐に使う HTTP ステータス。数値の直書きを避けるために名前を付ける */
export const HTTP_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  tooManyRequests: 429,
} as const;
