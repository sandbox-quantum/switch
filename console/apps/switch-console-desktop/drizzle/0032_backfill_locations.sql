/*
 Backfill locations from projects + agents (CHOO-1426). Each project row maps
 to one location, reusing the project id: a local project contributes
 (ssh_host = '', dir = path); a remote project (path IS NULL) takes host + dir
 from its remote agent's remote_config_json. ON CONFLICT dedupes the edge case
 of two projects resolving to the same (host, dir); agents are then re-pointed
 by computed (host, dir) so agents of a deduped project land on the surviving
 location. project_settings rows follow their project into location_settings.
*/
INSERT INTO `locations` (`id`, `name`, `ssh_host`, `dir`, `created_at`, `updated_at`)
SELECT
	`p`.`id`,
	`p`.`name`,
	COALESCE(
		(SELECT json_extract(`a`.`remote_config_json`, '$.sshHost')
		 FROM `agents` `a`
		 WHERE `a`.`project_id` = `p`.`id` AND `a`.`connection` = 'remote'
		 LIMIT 1),
		''
	),
	COALESCE(
		(SELECT json_extract(`a`.`remote_config_json`, '$.remoteRepoDir')
		 FROM `agents` `a`
		 WHERE `a`.`project_id` = `p`.`id` AND `a`.`connection` = 'remote'
		 LIMIT 1),
		`p`.`path`,
		''
	),
	`p`.`created_at`,
	`p`.`updated_at`
FROM `projects` `p`
WHERE true
ON CONFLICT (`ssh_host`, `dir`) DO NOTHING;--> statement-breakpoint
UPDATE `agents` SET `location_id` = (
	SELECT `l`.`id` FROM `locations` `l`
	WHERE `l`.`ssh_host` = CASE
			WHEN `agents`.`connection` = 'remote'
			THEN COALESCE(json_extract(`agents`.`remote_config_json`, '$.sshHost'), '')
			ELSE ''
		END
		AND `l`.`dir` = CASE
			WHEN `agents`.`connection` = 'remote'
			THEN COALESCE(json_extract(`agents`.`remote_config_json`, '$.remoteRepoDir'), '')
			ELSE COALESCE((SELECT `p`.`path` FROM `projects` `p` WHERE `p`.`id` = `agents`.`project_id`), '')
		END
);--> statement-breakpoint
UPDATE `agents` SET `location_id` = `project_id` WHERE `location_id` IS NULL;--> statement-breakpoint
INSERT INTO `location_settings` (`location_id`, `base_settings_json`, `shareable_settings_json`, `legacy_config_migrated_at`, `created_at`, `updated_at`)
SELECT `ps`.`project_id`, `ps`.`base_project_settings_json`, `ps`.`shareable_project_settings_json`, `ps`.`legacy_config_migrated_at`, `ps`.`created_at`, `ps`.`updated_at`
FROM `project_settings` `ps`
WHERE `ps`.`project_id` IN (SELECT `id` FROM `locations`)
ON CONFLICT (`location_id`) DO NOTHING;

