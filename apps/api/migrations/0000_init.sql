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
CREATE INDEX `idx_profiles_role` ON `profiles` (`role`);