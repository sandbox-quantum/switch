import { getLocationById } from '@main/core/locations/store';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { getPlugin } from '@main/core/providers/plugin-registry';
import {
  readSwitchAgentCredentials,
  readSwitchAgentCredentialsFromSettings,
} from '@main/core/switch-rooms/switch-credentials';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { getAgents } from './getAgents';
import { agentSettingsPath, subagentSettingsPath } from './switch-settings-paths';
import { updateAgent } from './updateAgent';

/**
 * Migrate existing switchdash-managed agents to the current storage/definition
 * layout (CHOO-1440): every agent is a repository-defined agent with a per-agent
 * credentials file at `.switch/agents/<name>.json`, an on-disk definition, and a
 * populated `definitionName`. Pre-CHOO-1440 installs kept credentials in the
 * shared `.claude/settings.local.json` (a "main" agent) or the legacy
 * `.claude/switch-subagents/<name>.settings.json`, and left `definitionName` null.
 *
 * Runs once at boot, best-effort: each agent is migrated in isolation so one bad
 * directory never aborts the rest, and every step is idempotent (re-running does
 * nothing once an agent is already in the new layout). Remote agents are skipped —
 * their on-VM layout is re-established when their sidecar is next deployed.
 */
export async function migrateAgentStorage(): Promise<void> {
  const agents = await getAgents();
  let migrated = 0;
  for (const agent of agents) {
    try {
      if (await migrateOne(agent)) migrated += 1;
    } catch (error) {
      log.warn('migrateAgentStorage: failed to migrate agent', {
        agentId: agent.id,
        error: String(error),
      });
    }
  }
  if (migrated > 0) {
    log.info('migrateAgentStorage: migrated agents to the neutral storage layout', { migrated });
  }
}

/** Migrate one agent; returns whether anything changed. */
async function migrateOne(agent: Agent): Promise<boolean> {
  const behavior = getPlugin(agent.providerId).behavior.repoAgents;
  if (!behavior) return false;

  const location = await getLocationById(agent.locationId);
  if (!location) return false;
  // Remote agents keep their layout on the VM; it is rewritten when the sidecar
  // is next deployed, so skip them here rather than opening an SFTP connection.
  if (location.sshHost !== null) return false;

  const name = agent.definitionName ?? agent.name;
  const dir = location.dir;
  const fs = createPluginFs(dir);
  let changed = false;

  // 1. Credentials: if the neutral per-agent file is absent, adopt the legacy
  //    layout's credentials (subagent file, then the shared settings.local.json).
  const neutral = await readSwitchAgentCredentialsFromSettings(agentSettingsPath(dir, name), log);
  if (!neutral) {
    const legacy =
      (await readSwitchAgentCredentialsFromSettings(subagentSettingsPath(dir, name), log)) ??
      (await readSwitchAgentCredentials(dir, log));
    if (legacy) {
      await behavior.writeCredentials(fs, {
        agentName: name,
        apiEndpoint: legacy.apiEndpoint,
        apiToken: legacy.token,
        agentId: legacy.agentId,
      });
      changed = true;
    }
  }

  // 2. Definition: ensure the provider has an on-disk definition for this agent so
  //    it runs as a named repository-defined agent.
  if ((await behavior.readDefinition(fs, name)) === null) {
    await behavior.writeDefinition(fs, { name, description: agent.name });
    changed = true;
  }

  // 3. Row: populate definitionName so sessions launch as this named agent.
  if (agent.definitionName === null) {
    await updateAgent({ agentId: agent.id, definitionName: name });
    changed = true;
  }

  return changed;
}
