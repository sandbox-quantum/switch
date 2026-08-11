/*
 Collapse agent identity onto `agents.name`, then delete leaked / misidentified
 sessions (CHOO-1440 follow-up).

 The authoritative identity value has been carried by `agents.definition_name`
 (the `.claude/agents/<name>` stem, the `--agent` value, the creds-file key);
 `name` was a second, sometimes-stale copy. We are collapsing to a single
 `agents.name`, so first backfill it from the authoritative `definition_name`
 wherever that is set. `definition_name` itself is dropped by the next migration.

 A session used to freeze its agent identity as a name tag in `config`
 (`agentName`, legacy `subagentName`) while its `agent_id` was written to the
 wrong agent — the location's representative agent instead of the one it actually
 ran as. Identity now resolves from `session.agent_id -> agents.name` (the
 sidebar groups by agent_id; the notification poller reads credentials from the
 joined agent row), so a session whose frozen tag disagrees with its owning
 agent's (now-authoritative) `name` points at the wrong agent and cannot be
 repaired from the tag alone. Some point at a name whose agent row no longer
 exists at all — the invisible "ghosts".

 Delete exactly those diverged rows: a tag that does NOT equal the owning agent's
 `name` (compared AFTER the backfill, so `name` already holds the proper value).
 A healthy session whose tag matches its agent's name is kept, so live
 auto-started sessions are not churned; untagged sessions are kept. The wiped
 rows recreate under the correct agent id on next launch / auto-start.
*/
UPDATE `agents` SET `name` = `definition_name` WHERE `definition_name` IS NOT NULL;--> statement-breakpoint
DELETE FROM `sessions`
WHERE COALESCE(json_extract(`config`, '$.agentName'), json_extract(`config`, '$.subagentName')) IS NOT NULL
  AND COALESCE(json_extract(`config`, '$.agentName'), json_extract(`config`, '$.subagentName'))
    IS NOT (SELECT `name` FROM `agents` WHERE `agents`.`id` = `sessions`.`agent_id`);
