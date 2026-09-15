// 全スキーマファイルの再エクスポート。
// drizzle.config.ts はこのファイルだけを見るので、ここに書き忘れたテーブルは
// マイグレーションに出ない。index.test.ts がその漏れを検知する。
//
// 並び順は依存の向き（auth → master → shop → 詳細 → admin）に揃えてある。
// ここを並べ替えても動作は変わらないが、読むときの手掛かりとして維持すること。
export * from './auth';
export * from './master';
export * from './shop';
export * from './shop-detail';
export * from './menu';
export * from './review';
export * from './reservation';
export * from './collection';
export * from './admin';
