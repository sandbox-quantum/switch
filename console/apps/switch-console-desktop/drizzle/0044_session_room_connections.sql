/*
 Move each session's Switch room connection out of the `switchRoomConnections`
 JSON blob in `app_settings` and into a table keyed by session.

 The blob referenced nothing, so nothing ever cleaned it up: entries outlived the
 sessions they described, and the boot sweep re-armed a poller for every one of
 them. A connection whose Switch server had since been destroyed then hammered a
 dead endpoint for the lifetime of the app. Keying the row on `session_id` with
 ON DELETE CASCADE makes that state unrepresentable — the row goes when the
 session does, and sessions already cascade from `agents`.

 Live connections are carried over; leaked ones are dropped. A connection is
 live iff its session still exists (an agent's removal already cascaded its
 sessions away, so this one condition covers both). The blob is deleted
 afterwards: the table is the only home now, and leaving it would let a future
 reader resurrect exactly the rows this migration filtered out.
*/
CREATE TABLE `session_room_connections` (
	`session_id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`room_name` text,
	`switch_agent_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `session_room_connections` (`session_id`, `room_id`, `room_name`, `switch_agent_id`)
SELECT
	`entry`.`key`,
	json_extract(`entry`.`value`, '$.roomId'),
	json_extract(`entry`.`value`, '$.roomName'),
	json_extract(`entry`.`value`, '$.agentId')
FROM `app_settings`, json_each(`app_settings`.`value`) AS `entry`
WHERE `app_settings`.`key` = 'switchRoomConnections'
	AND json_valid(`app_settings`.`value`)
	AND json_extract(`entry`.`value`, '$.roomId') IS NOT NULL
	AND `entry`.`key` IN (SELECT `id` FROM `sessions`);
--> statement-breakpoint
DELETE FROM `app_settings` WHERE `key` = 'switchRoomConnections';
