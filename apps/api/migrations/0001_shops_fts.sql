-- Custom SQL migration file, put your code below! --

-- 店舗の全文検索インデックス（設計書 §6）。
--
-- content='shops' の外部コンテンツ表にしているので、本文は shops 側にしか無い。
-- そのぶん容量が増えず食い違いも起きないが、同期は下のトリガーが全責任を持つ。
--
-- tokenize='trigram' は 3 文字ずつの部分列を索引化する。日本語は分かち書きしないため
-- 既定の unicode61 では「濃厚な豚骨ラーメンが看板メニュー」が丸ごと 1 トークンになり
-- 部分一致が効かない。代わりに 2 文字以下の検索語はヒットしない（API 側でフォールバックする）。
CREATE VIRTUAL TABLE `shops_fts` USING fts5(
  name,
  name_kana,
  description,
  address,
  content='shops',
  content_rowid='rowid',
  tokenize='trigram'
);
--> statement-breakpoint
-- 以下 3 つのトリガーが shops と shops_fts の同期を担う。
-- 列の並びは仮想テーブルの定義順（name, name_kana, description, address）と
-- 完全に一致させること。ずれても DDL は通り、検索結果だけが静かに壊れる。
CREATE TRIGGER `shops_fts_after_insert` AFTER INSERT ON `shops` BEGIN
  INSERT INTO `shops_fts`(`rowid`, `name`, `name_kana`, `description`, `address`)
  VALUES (new.`rowid`, new.`name`, new.`name_kana`, new.`description`, new.`address`);
END;
--> statement-breakpoint
-- 外部コンテンツ表の削除は 'delete' コマンド行を入れて行う。
-- DELETE FROM shops_fts では消えない（本文を shops から読むため）。
-- old の値が索引時の値と一致していないと索引が壊れるので、必ず old.* を渡す。
CREATE TRIGGER `shops_fts_after_delete` AFTER DELETE ON `shops` BEGIN
  INSERT INTO `shops_fts`(`shops_fts`, `rowid`, `name`, `name_kana`, `description`, `address`)
  VALUES ('delete', old.`rowid`, old.`name`, old.`name_kana`, old.`description`, old.`address`);
END;
--> statement-breakpoint
-- 更新は「古い行を消してから新しい行を入れる」の 2 段。
-- delete 側を書き忘れると古い語が索引に残り続ける。
CREATE TRIGGER `shops_fts_after_update` AFTER UPDATE ON `shops` BEGIN
  INSERT INTO `shops_fts`(`shops_fts`, `rowid`, `name`, `name_kana`, `description`, `address`)
  VALUES ('delete', old.`rowid`, old.`name`, old.`name_kana`, old.`description`, old.`address`);
  INSERT INTO `shops_fts`(`rowid`, `name`, `name_kana`, `description`, `address`)
  VALUES (new.`rowid`, new.`name`, new.`name_kana`, new.`description`, new.`address`);
END;
