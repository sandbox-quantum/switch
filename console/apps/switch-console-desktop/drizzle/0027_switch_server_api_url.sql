CREATE TABLE `__new_switch_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`gateway_url` text NOT NULL,
	`api_url` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_switch_servers`("id", "name", "gateway_url", "api_url", "created_at", "updated_at") SELECT "id", "name", "base_url", "base_url", "created_at", "updated_at" FROM `switch_servers`;
--> statement-breakpoint
DROP TABLE `switch_servers`;
--> statement-breakpoint
ALTER TABLE `__new_switch_servers` RENAME TO `switch_servers`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_switch_servers_gateway_url` ON `switch_servers` (`gateway_url`);
