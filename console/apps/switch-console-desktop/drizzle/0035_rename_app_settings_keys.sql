/*
 CHOO-1426: the app-settings sections that held default location settings were
 renamed `project` -> `location` and `localProject` -> `localLocation`. Carry an
 upgrader's persisted rows across so their defaults are not silently reset. Only
 rename when the new key isn't already present (fresh installs have neither).
*/
UPDATE OR IGNORE app_settings SET key = 'location' WHERE key = 'project';--> statement-breakpoint
UPDATE OR IGNORE app_settings SET key = 'localLocation' WHERE key = 'localProject';--> statement-breakpoint
DELETE FROM app_settings WHERE key IN ('project', 'localProject');
