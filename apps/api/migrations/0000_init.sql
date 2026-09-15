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
CREATE INDEX `idx_shops_status_rating` ON `shops` (`status`,"rating_avg" desc);--> statement-breakpoint
CREATE TABLE `shop_closures` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`date` text NOT NULL,
	`reason` text,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_shop_closures_id_length" CHECK(length("shop_closures"."id") <= 64),
	CONSTRAINT "ck_shop_closures_date_format" CHECK("shop_closures"."date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_shop_closures_reason_length" CHECK(length("shop_closures"."reason") <= 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shop_closures_shop_date` ON `shop_closures` (`shop_id`,`date`);--> statement-breakpoint
CREATE TABLE `shop_hours` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`day_of_week` integer NOT NULL,
	`open_minute` integer,
	`close_minute` integer,
	`is_closed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_shop_hours_id_length" CHECK(length("shop_hours"."id") <= 64),
	CONSTRAINT "ck_shop_hours_day_of_week" CHECK("shop_hours"."day_of_week" BETWEEN 0 AND 6),
	CONSTRAINT "ck_shop_hours_open_minute" CHECK("shop_hours"."open_minute" BETWEEN 0 AND 2879),
	CONSTRAINT "ck_shop_hours_close_minute" CHECK("shop_hours"."close_minute" BETWEEN 0 AND 2879),
	CONSTRAINT "ck_shop_hours_is_closed" CHECK("shop_hours"."is_closed" IN (0, 1)),
	CONSTRAINT "ck_shop_hours_open_before_close" CHECK("shop_hours"."open_minute" < "shop_hours"."close_minute"),
	CONSTRAINT "ck_shop_hours_closed_coherence" CHECK(("shop_hours"."is_closed" AND "shop_hours"."open_minute" IS NULL AND "shop_hours"."close_minute" IS NULL) OR (NOT "shop_hours"."is_closed" AND "shop_hours"."open_minute" IS NOT NULL AND "shop_hours"."close_minute" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_shop_hours_shop_day` ON `shop_hours` (`shop_id`,`day_of_week`);--> statement-breakpoint
CREATE TABLE `shop_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`caption` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_cover` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_shop_photos_id_length" CHECK(length("shop_photos"."id") <= 64),
	CONSTRAINT "ck_shop_photos_r2_key_length" CHECK(length("shop_photos"."r2_key") <= 200),
	CONSTRAINT "ck_shop_photos_r2_key" CHECK("shop_photos"."r2_key" <> '' AND "shop_photos"."r2_key" NOT GLOB '*[^a-z0-9/._-]*'),
	CONSTRAINT "ck_shop_photos_caption_length" CHECK(length("shop_photos"."caption") <= 200),
	CONSTRAINT "ck_shop_photos_sort_order" CHECK("shop_photos"."sort_order" >= 0),
	CONSTRAINT "ck_shop_photos_is_cover" CHECK("shop_photos"."is_cover" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_shop_photos_shop_sort` ON `shop_photos` (`shop_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shop_photos_r2_key` ON `shop_photos` (`r2_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shop_photos_cover` ON `shop_photos` (`shop_id`) WHERE "shop_photos"."is_cover";--> statement-breakpoint
CREATE TABLE `menu_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_menu_categories_id_length" CHECK(length("menu_categories"."id") <= 64),
	CONSTRAINT "ck_menu_categories_name_length" CHECK(length("menu_categories"."name") <= 50),
	CONSTRAINT "ck_menu_categories_sort_order" CHECK("menu_categories"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_menu_categories_shop_sort` ON `menu_categories` (`shop_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_menu_categories_shop_id` ON `menu_categories` (`shop_id`,`id`);--> statement-breakpoint
CREATE TABLE `menu_items` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`category_id` text,
	`name` text NOT NULL,
	`price` integer NOT NULL,
	`description` text,
	`r2_key` text,
	`is_recommended` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shop_id`,`category_id`) REFERENCES `menu_categories`(`shop_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_menu_items_id_length" CHECK(length("menu_items"."id") <= 64),
	CONSTRAINT "ck_menu_items_name_length" CHECK(length("menu_items"."name") <= 100),
	CONSTRAINT "ck_menu_items_description_length" CHECK(length("menu_items"."description") <= 500),
	CONSTRAINT "ck_menu_items_price" CHECK("menu_items"."price" BETWEEN 0 AND 1000000),
	CONSTRAINT "ck_menu_items_r2_key_length" CHECK(length("menu_items"."r2_key") <= 200),
	CONSTRAINT "ck_menu_items_r2_key" CHECK("menu_items"."r2_key" <> '' AND "menu_items"."r2_key" NOT GLOB '*[^a-z0-9/._-]*'),
	CONSTRAINT "ck_menu_items_is_recommended" CHECK("menu_items"."is_recommended" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_menu_items_shop_category` ON `menu_items` (`shop_id`,`category_id`);--> statement-breakpoint
CREATE INDEX `idx_menu_items_shop_recommended` ON `menu_items` (`shop_id`,`is_recommended`);--> statement-breakpoint
CREATE TABLE `seat_settings` (
	`shop_id` text PRIMARY KEY NOT NULL,
	`capacity` integer NOT NULL,
	`slot_minutes` integer DEFAULT 90 NOT NULL,
	`max_parallel` integer DEFAULT 1 NOT NULL,
	`accepts_reservation` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_seat_settings_capacity" CHECK("seat_settings"."capacity" BETWEEN 1 AND 500),
	CONSTRAINT "ck_seat_settings_slot_minutes" CHECK("seat_settings"."slot_minutes" BETWEEN 15 AND 240),
	CONSTRAINT "ck_seat_settings_max_parallel" CHECK("seat_settings"."max_parallel" BETWEEN 1 AND 100),
	CONSTRAINT "ck_seat_settings_accepts_reservation" CHECK("seat_settings"."accepts_reservation" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `review_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_review_photos_id_length" CHECK(length("review_photos"."id") <= 64),
	CONSTRAINT "ck_review_photos_r2_key_length" CHECK(length("review_photos"."r2_key") <= 200),
	CONSTRAINT "ck_review_photos_r2_key" CHECK("review_photos"."r2_key" <> '' AND "review_photos"."r2_key" NOT GLOB '*[^a-z0-9/._-]*'),
	CONSTRAINT "ck_review_photos_sort_order" CHECK("review_photos"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_review_photos_review_sort` ON `review_photos` (`review_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_review_photos_r2_key` ON `review_photos` (`r2_key`);--> statement-breakpoint
CREATE TABLE `review_replies` (
	`review_id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`,`shop_id`) REFERENCES `reviews`(`id`,`shop_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_review_replies_body_length" CHECK(length("review_replies"."body") <= 1000)
);
--> statement-breakpoint
CREATE INDEX `idx_review_replies_shop` ON `review_replies` (`shop_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`user_id` text NOT NULL,
	`rating` integer NOT NULL,
	`body` text NOT NULL,
	`visited_on` text,
	`budget` integer,
	`status` text DEFAULT 'published' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_reviews_id_length" CHECK(length("reviews"."id") <= 64),
	CONSTRAINT "ck_reviews_rating" CHECK("reviews"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "ck_reviews_body_length" CHECK(length("reviews"."body") <= 2000),
	CONSTRAINT "ck_reviews_status" CHECK("reviews"."status" IN ('published', 'hidden', 'deleted')),
	CONSTRAINT "ck_reviews_visited_on_format" CHECK("reviews"."visited_on" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_reviews_budget" CHECK("reviews"."budget" BETWEEN 0 AND 1000000)
);
--> statement-breakpoint
CREATE INDEX `idx_reviews_shop_created` ON `reviews` (`shop_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_reviews_shop_status_created` ON `reviews` (`shop_id`,`status`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_reviews_user_created` ON `reviews` (`user_id`,"created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reviews_shop_user` ON `reviews` (`shop_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reviews_id_shop` ON `reviews` (`id`,`shop_id`);--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reserved_at` integer NOT NULL,
	`party_size` integer NOT NULL,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_reservations_id_length" CHECK(length("reservations"."id") <= 64),
	CONSTRAINT "ck_reservations_party_size" CHECK("reservations"."party_size" BETWEEN 1 AND 20),
	CONSTRAINT "ck_reservations_status" CHECK("reservations"."status" IN ('pending', 'confirmed', 'rejected', 'cancelled', 'completed', 'no_show')),
	CONSTRAINT "ck_reservations_note_length" CHECK(length("reservations"."note") <= 500)
);
--> statement-breakpoint
CREATE INDEX `idx_reservations_shop_reserved` ON `reservations` (`shop_id`,`reserved_at`);--> statement-breakpoint
CREATE INDEX `idx_reservations_shop_status_reserved` ON `reservations` (`shop_id`,`status`,`reserved_at`);--> statement-breakpoint
CREATE INDEX `idx_reservations_user_reserved` ON `reservations` (`user_id`,"reserved_at" desc);--> statement-breakpoint
CREATE TABLE `favorites` (
	`user_id` text NOT NULL,
	`shop_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `shop_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_favorites_user_created` ON `favorites` (`user_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_favorites_shop` ON `favorites` (`shop_id`);--> statement-breakpoint
CREATE TABLE `list_items` (
	`list_id` text NOT NULL,
	`shop_id` text NOT NULL,
	`note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`list_id`, `shop_id`),
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_list_items_note_length" CHECK(length("list_items"."note") <= 500),
	CONSTRAINT "ck_list_items_sort_order" CHECK("list_items"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_list_items_list_sort` ON `list_items` (`list_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_public` integer DEFAULT false NOT NULL,
	`share_token` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_lists_id_length" CHECK(length("lists"."id") <= 64),
	CONSTRAINT "ck_lists_name_length" CHECK(length("lists"."name") <= 100),
	CONSTRAINT "ck_lists_description_length" CHECK(length("lists"."description") <= 1000),
	CONSTRAINT "ck_lists_is_public" CHECK("lists"."is_public" IN (0, 1)),
	CONSTRAINT "ck_lists_share_token_length" CHECK(length("lists"."share_token") = 32),
	CONSTRAINT "ck_lists_share_token_alphabet" CHECK("lists"."share_token" <> '' AND "lists"."share_token" NOT GLOB '*[^a-z0-9]*')
);
--> statement-breakpoint
CREATE INDEX `idx_lists_user` ON `lists` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_lists_share_token` ON `lists` (`share_token`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`diff` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_audit_logs_id_length" CHECK(length("audit_logs"."id") <= 64),
	CONSTRAINT "ck_audit_logs_action" CHECK("audit_logs"."action" <> '' AND "audit_logs"."action" NOT GLOB '*[^a-z0-9_.]*'),
	CONSTRAINT "ck_audit_logs_target_type_length" CHECK(length("audit_logs"."target_type") <= 32),
	CONSTRAINT "ck_audit_logs_diff_json" CHECK("audit_logs"."diff" IS NULL OR json_valid("audit_logs"."diff"))
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_created` ON `audit_logs` ("created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_actor_created` ON `audit_logs` (`actor_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_target` ON `audit_logs` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`data` text,
	`read_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_notifications_id_length" CHECK(length("notifications"."id") <= 64),
	CONSTRAINT "ck_notifications_type" CHECK("notifications"."type" IN ('reservation_requested', 'reservation_confirmed', 'reservation_rejected', 'reservation_cancelled', 'review_posted', 'review_replied', 'application_approved', 'application_rejected', 'application_returned', 'announcement')),
	CONSTRAINT "ck_notifications_title_length" CHECK(length("notifications"."title") <= 100),
	CONSTRAINT "ck_notifications_body_length" CHECK(length("notifications"."body") <= 500),
	CONSTRAINT "ck_notifications_data_json" CHECK("notifications"."data" IS NULL OR json_valid("notifications"."data"))
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_user_created` ON `notifications` (`user_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_notifications_user_unread` ON `notifications` (`user_id`,"created_at" desc) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`status` text DEFAULT 'open' NOT NULL,
	`handled_by` text,
	`handled_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`reporter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`handled_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_reports_id_length" CHECK(length("reports"."id") <= 64),
	CONSTRAINT "ck_reports_target_type" CHECK("reports"."target_type" IN ('shop', 'review', 'user')),
	CONSTRAINT "ck_reports_status" CHECK("reports"."status" IN ('open', 'in_review', 'resolved', 'rejected')),
	CONSTRAINT "ck_reports_reason_length" CHECK(length("reports"."reason") <= 100),
	CONSTRAINT "ck_reports_detail_length" CHECK(length("reports"."detail") <= 1000),
	CONSTRAINT "ck_reports_handler_requires_time" CHECK("reports"."handled_by" IS NULL OR "reports"."handled_at" IS NOT NULL),
	CONSTRAINT "ck_reports_closed_requires_time" CHECK("reports"."status" IN ('open', 'in_review') OR "reports"."handled_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `idx_reports_status_created` ON `reports` (`status`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_reports_target` ON `reports` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_reports_reporter` ON `reports` (`reporter_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reports_reporter_target` ON `reports` (`reporter_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `shop_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`applicant_id` text NOT NULL,
	`shop_id` text NOT NULL,
	`documents` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by` text,
	`review_note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`applicant_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_shop_applications_id_length" CHECK(length("shop_applications"."id") <= 64),
	CONSTRAINT "ck_shop_applications_status" CHECK("shop_applications"."status" IN ('pending', 'approved', 'rejected', 'returned')),
	CONSTRAINT "ck_shop_applications_documents_json" CHECK(json_valid("shop_applications"."documents") AND json_type("shop_applications"."documents") = 'array'),
	CONSTRAINT "ck_shop_applications_review_note_length" CHECK(length("shop_applications"."review_note") <= 1000)
);
--> statement-breakpoint
CREATE INDEX `idx_shop_applications_status_created` ON `shop_applications` (`status`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_shop_applications_applicant` ON `shop_applications` (`applicant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shop_applications_shop_pending` ON `shop_applications` (`shop_id`) WHERE "shop_applications"."status" = 'pending';