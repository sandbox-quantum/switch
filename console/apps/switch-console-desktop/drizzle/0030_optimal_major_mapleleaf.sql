DROP INDEX IF EXISTS `idx_projects_path`;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_projects`(`id`, `name`, `path`, `created_at`, `updated_at`) SELECT `id`, `name`, `path`, `created_at`, `updated_at` FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_projects_path` ON `projects` (`path`);
