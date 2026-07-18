/*
 Enforce NOT NULL on agents.location_id via the SQLite table-recreation dance
 (drizzle-kit cannot generate "set not null"; the 0033 snapshot already
 records the column as NOT NULL, this brings the actual DDL in line). Runs
 with foreign_keys=OFF inside the migration transaction, so dropping and
 renaming does not disturb the sessions FK, which tracks the table name.
*/
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`provider_id` text NOT NULL,
	`switch_agent_id` text,
	`api_endpoint` text,
	`server_id` text,
	`status` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`server_id`) REFERENCES `switch_servers`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_agents` (`id`, `location_id`, `name`, `provider_id`, `switch_agent_id`, `api_endpoint`, `server_id`, `status`, `created_at`, `updated_at`)
SELECT `id`, `location_id`, `name`, `provider_id`, `switch_agent_id`, `api_endpoint`, `server_id`, `status`, `created_at`, `updated_at` FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
CREATE INDEX `idx_agents_location_id` ON `agents` (`location_id`);--> statement-breakpoint
CREATE INDEX `idx_agents_server_id` ON `agents` (`server_id`);
