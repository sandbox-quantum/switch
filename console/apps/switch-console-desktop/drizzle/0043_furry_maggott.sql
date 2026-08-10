CREATE TABLE `remote_host_reachability` (
	`ssh_host` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_error` text,
	`last_checked_at` text,
	`last_reachable_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
