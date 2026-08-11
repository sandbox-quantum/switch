ALTER TABLE `tasks` RENAME TO `sessions`;--> statement-breakpoint
ALTER TABLE `conversations` RENAME COLUMN `task_id` TO `session_id`;--> statement-breakpoint
ALTER TABLE `terminals` RENAME COLUMN `task_id` TO `session_id`;--> statement-breakpoint
/*
 SQLite does not support "Dropping foreign key" out of the box, we do not generate automatic migration for that, so it has to be done manually
 Please refer to: https://www.techonthenet.com/sqlite/tables/alter_table.php
                  https://www.sqlite.org/lang_altertable.html

 Due to that we don't generate migration automatically and it has to be done manually
*/--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conversations_task_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_project_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_terminals_task_id`;--> statement-breakpoint
CREATE INDEX `idx_conversations_session_id` ON `conversations` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_id` ON `sessions` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_terminals_session_id` ON `terminals` (`session_id`);--> statement-breakpoint
/*
 SQLite does not support "Creating foreign key on existing column" out of the box, we do not generate automatic migration for that, so it has to be done manually
 Please refer to: https://www.techonthenet.com/sqlite/tables/alter_table.php
                  https://www.sqlite.org/lang_altertable.html

 Due to that we don't generate migration automatically and it has to be done manually
*/