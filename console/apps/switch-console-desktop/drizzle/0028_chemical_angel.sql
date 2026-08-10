ALTER TABLE `agents` ADD `connection` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `remote_config_json` text;