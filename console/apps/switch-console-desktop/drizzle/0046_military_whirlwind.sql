/*
 Remote-host setup plans (CHOO-1809).

 Onboarding a remote host is a sequence — check and install each prerequisite in
 turn — and until now that sequence lived only in renderer state. Nothing
 survived a reload, so a failure partway through left no record of what had
 already succeeded and no way to resume.

 One row per onboarded host. `steps` holds the JSON-serialised step list; it is
 read and written whole, and validated on read rather than trusted. Purely
 additive: no existing table is touched and nothing is backfilled, because a
 host with no row simply has no plan yet.

 Numbered 0046 after main claimed 0045; regenerating it dropped this header,
 which is restored here. A dev machine that applied the original
 0045_remote_host_setup_plans already has this table.
*/
CREATE TABLE `remote_host_setup_plans` (
	`ssh_host` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`steps` text NOT NULL,
	`current_step_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
