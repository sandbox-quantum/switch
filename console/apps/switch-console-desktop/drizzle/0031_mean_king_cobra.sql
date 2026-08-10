CREATE TABLE `location_settings` (
	`location_id` text PRIMARY KEY NOT NULL,
	`base_settings_json` text DEFAULT '{}' NOT NULL,
	`shareable_settings_json` text DEFAULT '{}' NOT NULL,
	`legacy_config_migrated_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ssh_host` text DEFAULT '' NOT NULL,
	`dir` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `location_id` text REFERENCES locations(id);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_locations_host_dir` ON `locations` (`ssh_host`,`dir`);--> statement-breakpoint
/*
 SQLite does not support "Creating foreign key on existing column" out of the box, we do not generate automatic migration for that, so it has to be done manually
 Please refer to: https://www.techonthenet.com/sqlite/tables/alter_table.php
                  https://www.sqlite.org/lang_altertable.html

 Due to that we don't generate migration automatically and it has to be done manually
*/