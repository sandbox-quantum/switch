CREATE TABLE `switch_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_switch_servers_base_url` ON `switch_servers` (`base_url`);