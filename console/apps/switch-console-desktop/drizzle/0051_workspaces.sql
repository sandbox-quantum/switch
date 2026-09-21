-- Workspaces: what the window is scoped to, one level below a server.
--
-- Each existing server gets exactly one workspace, and that workspace REUSES
-- THE SERVER'S ID. That is what makes the upgrade invisible: every server id
-- already persisted elsewhere — agents.server_id, the active-server kv value,
-- and the opaque navigation snapshots under `view-state:` — stays valid when
-- read as a workspace id, so nothing has to be rewritten or reconciled. New
-- workspaces discovered from a gateway get fresh ids.
--
-- tenant_id stays NULL for these rows: the server reported no tenancy, so the
-- workspace IS the whole server. A later reconcile fills it in if that changes.
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`tenant_id` text,
	`slug` text,
	`role` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `switch_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workspaces_server_id` ON `workspaces` (`server_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspaces_server_tenant` ON `workspaces` (`server_id`,`tenant_id`);--> statement-breakpoint
INSERT INTO `workspaces` (`id`, `server_id`, `name`, `tenant_id`, `slug`, `role`)
	SELECT `id`, `id`, `name`, NULL, NULL, NULL FROM `switch_servers`;
--> statement-breakpoint
-- Re-point agents at workspaces via the SQLite table-recreation dance rather
-- than DROP COLUMN: `server_id` carries a foreign key, and SQLite refuses to
-- drop a column named in one. Runs with foreign_keys=OFF inside the migration
-- transaction, so dropping and renaming does not disturb the sessions FK, which
-- tracks the table name. The workspace id equals the old server id, so the
-- carry-over is a straight copy.
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`provider_id` text NOT NULL,
	`switch_agent_id` text,
	`api_endpoint` text,
	`workspace_id` text,
	`status` text,
	`auto_approve` integer DEFAULT false NOT NULL,
	`owner_name` text,
	`provider_config` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_agents` (`id`, `location_id`, `name`, `provider_id`, `switch_agent_id`, `api_endpoint`, `workspace_id`, `status`, `auto_approve`, `owner_name`, `provider_config`, `created_at`, `updated_at`)
	SELECT `id`, `location_id`, `name`, `provider_id`, `switch_agent_id`, `api_endpoint`, `server_id`, `status`, `auto_approve`, `owner_name`, `provider_config`, `created_at`, `updated_at` FROM `agents`;
--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
CREATE INDEX `idx_agents_location_id` ON `agents` (`location_id`);--> statement-breakpoint
CREATE INDEX `idx_agents_workspace_id` ON `agents` (`workspace_id`);--> statement-breakpoint
INSERT INTO `kv` (`key`, `value`)
	SELECT 'activeWorkspaceId', `value` FROM `kv` WHERE `key` = 'activeSwitchServerId';
--> statement-breakpoint
DELETE FROM `kv` WHERE `key` = 'activeSwitchServerId';
