/*
 Destructive reshape: project -> agent -> session -> message (CHOO-886).
 The old worktree `sessions` grouping, `conversations`, `terminals`, and
 `workspaces` tables are removed; the agent run (old `conversation`) becomes the
 `session`. Affected tables are dropped and recreated rather than ALTER'd, since
 SQLite cannot drop the old foreign-key columns in place. Dev databases are
 wiped, so no data is preserved.
*/
DROP TABLE `messages`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
DROP TABLE `terminals`;--> statement-breakpoint
DROP TABLE `workspaces`;--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`provider_id` text NOT NULL,
	`switch_agent_id` text,
	`api_endpoint` text,
	`status` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`title` text NOT NULL,
	`config` text,
	`shell_id` text DEFAULT 'system' NOT NULL,
	`status` text,
	`agent_session_id` text,
	`agent_status` text,
	`agent_status_seen` integer DEFAULT 1,
	`is_initial_session` integer,
	`is_pinned` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`last_interacted_at` text,
	`status_changed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`content` text NOT NULL,
	`sender` text NOT NULL,
	`timestamp` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`metadata` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agents_project_id` ON `agents` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_agent_id` ON `sessions` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_session_id` ON `messages` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_timestamp` ON `messages` (`timestamp`);--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `workspace_provider`;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `repository_workspace_id`;
