CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_account_user_id` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_account_provider` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `idx_session_user_id` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_verification_identifier` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `areas` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`prefecture` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `areas`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_areas_id_length" CHECK(length("areas"."id") <= 64),
	CONSTRAINT "ck_areas_name_length" CHECK(length("areas"."name") <= 50),
	CONSTRAINT "ck_areas_prefecture_length" CHECK(length("areas"."prefecture") <= 20)
);
--> statement-breakpoint
CREATE INDEX `idx_areas_parent_id` ON `areas` (`parent_id`);--> statement-breakpoint
CREATE TABLE `genres` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`icon_key` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ck_genres_id_length" CHECK(length("genres"."id") <= 64),
	CONSTRAINT "ck_genres_name_length" CHECK(length("genres"."name") <= 50),
	CONSTRAINT "ck_genres_slug_format" CHECK("genres"."slug" <> '' AND "genres"."slug" NOT GLOB '*[^a-z0-9-]*'),
	CONSTRAINT "ck_genres_sort_order" CHECK("genres"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `genres_slug_unique` ON `genres` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_genres_sort_order` ON `genres` (`sort_order`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`display_name` text NOT NULL,
	`avatar_key` text,
	`bio` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_profiles_role" CHECK("profiles"."role" IN ('user', 'owner', 'admin')),
	CONSTRAINT "ck_profiles_status" CHECK("profiles"."status" IN ('active', 'suspended', 'deleted')),
	CONSTRAINT "ck_profiles_display_name_length" CHECK(length("profiles"."display_name") <= 50),
	CONSTRAINT "ck_profiles_bio_length" CHECK(length("profiles"."bio") <= 500)
);
--> statement-breakpoint
CREATE INDEX `idx_profiles_role` ON `profiles` (`role`);--> statement-breakpoint
CREATE TABLE `shops` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`name` text NOT NULL,
	`name_kana` text,
	`genre_id` text NOT NULL,
	`area_id` text NOT NULL,
	`description` text,
	`postal_code` text,
	`address` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`geohash` text NOT NULL,
	`phone` text,
	`website` text,
	`budget_lunch_min` integer,
	`budget_lunch_max` integer,
	`budget_dinner_min` integer,
	`budget_dinner_max` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`rating_avg` real DEFAULT 0 NOT NULL,
	`rating_count` integer DEFAULT 0 NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`genre_id`) REFERENCES `genres`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`area_id`) REFERENCES `areas`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_shops_id_length" CHECK(length("shops"."id") <= 64),
	CONSTRAINT "ck_shops_status" CHECK("shops"."status" IN ('draft', 'pending', 'published', 'suspended', 'closed')),
	CONSTRAINT "ck_shops_name_length" CHECK(length("shops"."name") <= 100),
	CONSTRAINT "ck_shops_name_kana_length" CHECK(length("shops"."name_kana") <= 200),
	CONSTRAINT "ck_shops_description_length" CHECK(length("shops"."description") <= 2000),
	CONSTRAINT "ck_shops_address_length" CHECK(length("shops"."address") <= 200),
	CONSTRAINT "ck_shops_phone_length" CHECK(length("shops"."phone") <= 20),
	CONSTRAINT "ck_shops_website_length" CHECK(length("shops"."website") <= 500),
	CONSTRAINT "ck_shops_postal_code_format" CHECK("shops"."postal_code" GLOB '[0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]'),
	CONSTRAINT "ck_shops_lat" CHECK("shops"."lat" BETWEEN -90 AND 90),
	CONSTRAINT "ck_shops_lng" CHECK("shops"."lng" BETWEEN -180 AND 180),
	CONSTRAINT "ck_shops_geohash_length" CHECK(length("shops"."geohash") = 7),
	CONSTRAINT "ck_shops_geohash_alphabet" CHECK("shops"."geohash" <> '' AND "shops"."geohash" NOT GLOB '*[^0-9bcdefghjkmnpqrstuvwxyz]*'),
	CONSTRAINT "ck_shops_budget_lunch_range" CHECK("shops"."budget_lunch_min" BETWEEN 0 AND 1000000 AND "shops"."budget_lunch_max" BETWEEN 0 AND 1000000),
	CONSTRAINT "ck_shops_budget_dinner_range" CHECK("shops"."budget_dinner_min" BETWEEN 0 AND 1000000 AND "shops"."budget_dinner_max" BETWEEN 0 AND 1000000),
	CONSTRAINT "ck_shops_budget_lunch_order" CHECK("shops"."budget_lunch_min" <= "shops"."budget_lunch_max"),
	CONSTRAINT "ck_shops_budget_dinner_order" CHECK("shops"."budget_dinner_min" <= "shops"."budget_dinner_max"),
	CONSTRAINT "ck_shops_rating_avg" CHECK("shops"."rating_avg" BETWEEN 0 AND 5),
	CONSTRAINT "ck_shops_rating_count" CHECK("shops"."rating_count" >= 0),
	CONSTRAINT "ck_shops_view_count" CHECK("shops"."view_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_shops_geohash` ON `shops` (`geohash`);--> statement-breakpoint
CREATE INDEX `idx_shops_status_geohash` ON `shops` (`status`,`geohash`);--> statement-breakpoint
CREATE INDEX `idx_shops_lat_lng` ON `shops` (`lat`,`lng`);--> statement-breakpoint
CREATE INDEX `idx_shops_genre_status` ON `shops` (`genre_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_shops_area_status` ON `shops` (`area_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_shops_owner_id` ON `shops` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_shops_status_rating` ON `shops` (`status`,"rating_avg" desc);