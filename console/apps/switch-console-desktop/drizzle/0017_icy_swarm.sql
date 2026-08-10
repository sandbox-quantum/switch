DROP TABLE `project_remotes`;--> statement-breakpoint
ALTER TABLE `terminals` DROP COLUMN `ssh`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_projects_ssh_connection_id`;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`workspace_provider` text DEFAULT 'local' NOT NULL,
	`base_ref` text,
	`repository_workspace_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_projects`(`id`, `name`, `path`, `workspace_provider`, `base_ref`, `repository_workspace_id`, `created_at`, `updated_at`) SELECT `id`, `name`, `path`, `workspace_provider`, `base_ref`, `repository_workspace_id`, `created_at`, `updated_at` FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_projects_path` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `__new_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text,
	`type` text NOT NULL,
	`kind` text,
	`data` text,
	`path` text,
	`config` text,
	`branch_name` text,
	`lines_added` integer,
	`lines_deleted` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_workspaces`(`id`, `key`, `type`, `kind`, `data`, `path`, `config`, `branch_name`, `lines_added`, `lines_deleted`, `created_at`, `updated_at`) SELECT `id`, `key`, `type`, `kind`, `data`, `path`, `config`, `branch_name`, `lines_added`, `lines_deleted`, `created_at`, `updated_at` FROM `workspaces`;--> statement-breakpoint
DROP TABLE `workspaces`;--> statement-breakpoint
ALTER TABLE `__new_workspaces` RENAME TO `workspaces`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspaces_key` ON `workspaces` (`key`) WHERE "workspaces"."key" is not null;--> statement-breakpoint
DROP TABLE `ssh_connections`;
