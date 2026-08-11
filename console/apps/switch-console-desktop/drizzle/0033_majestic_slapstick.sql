DROP TABLE `project_settings`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
/*
 SQLite does not support "Dropping foreign key" out of the box, we do not generate automatic migration for that, so it has to be done manually
 Please refer to: https://www.techonthenet.com/sqlite/tables/alter_table.php
                  https://www.sqlite.org/lang_altertable.html

 Due to that we don't generate migration automatically and it has to be done manually
*/--> statement-breakpoint
DROP INDEX IF EXISTS `idx_agents_project_id`;--> statement-breakpoint
/*
 SQLite does not support "Set not null to column" out of the box, we do not generate automatic migration for that, so it has to be done manually
 Please refer to: https://www.techonthenet.com/sqlite/tables/alter_table.php
                  https://www.sqlite.org/lang_altertable.html
                  https://stackoverflow.com/questions/2083543/modify-a-columns-type-in-sqlite3

 Due to that we don't generate migration automatically and it has to be done manually
*/--> statement-breakpoint
CREATE INDEX `idx_agents_location_id` ON `agents` (`location_id`);--> statement-breakpoint
/*
 The generated `ALTER TABLE agents DROP COLUMN project_id/connection/
 remote_config_json` statements cannot run — SQLite refuses to drop a column
 named in a foreign-key clause. The 0034 custom migration recreates `agents`
 without those columns (and enforces NOT NULL on location_id) instead.
*/
SELECT 1;