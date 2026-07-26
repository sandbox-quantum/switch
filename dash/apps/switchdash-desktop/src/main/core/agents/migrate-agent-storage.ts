import { getLocationById } from '@main/core/locations/store';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { getAgents } from './getAgents';
import { agentSettingsRelativePath } from './switch-settings-paths';
import { updateAgent } from './updateAgent';

/**
 * Migrate existing switchdash-managed agents to the current storage/definition
 * layout (CHOO-1440): every agent is a repository-defined agent with a per-agent
 * credentials file at `.switch/agents/<name>.json`, an on-disk definition, and a
 * populated `definitionName`. Pre-CHOO-1440 installs kept credentials in the
 * legacy `.claude/switch-subagents/<name>.settings.json` (or the shared
 * `.claude/settings.local.json`) and left `definitionName` null.
 *
 * Runs once at boot, best-effort: each agent is migrated in isolation so one bad
 * directory or unreachable host never aborts the rest, and every step is
 * idempotent (re-running does nothing once an agent is in the new layout).
 * Applies to LOCAL and REMOTE agents alike — remote reads/writes go over SFTP
 * through the same provider filesystem abstraction.
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

/** Migrate one agent (local or remote); returns whether anything changed. */
async function migrateOne(agent: Agent): Promise<boolean> {
  const behavior = getPlugin(agent.providerId).behavior.repoAgents;
  if (!behavior) return false;

  const location = await getLocationById(agent.locationId);
  if (!location) return false;

  const workspace = await resolveWorkspaceFsFor(location.sshHost, location.dir);
  try {
    // Resolve the agent's REAL name — its provider definition/credentials stem,
    // NOT `agent.name` (the directory-derived display name). Prefer the row's
    // definitionName; otherwise match the on-disk agent to this row by
    // switchAgentId. If neither resolves (e.g. a legacy "main" agent whose creds
    // live only in the shared settings.local.json, with no named definition), skip
    // it — it keeps working via the legacy-path fallbacks — rather than guess a
    // wrong name (CHOO-1440).
    let name = agent.definitionName;
    let description = agent.name;
    if (!name) {
      if (!agent.switchAgentId) return false;
      const discovered = await behavior.discoverLocal(workspace.fs, workspace.homeFs);
      const match = discovered.find((d) => d.switchAgentId === agent.switchAgentId);
      if (!match) {
        log.info('migrateAgentStorage: no on-disk agent matches this row; skipping', {
          agentId: agent.id,
          switchAgentId: agent.switchAgentId,
        });
        return false;
      }
      name = match.name;
      description = match.description ?? match.name;
    }

    let changed = false;

    // 1. Credentials: if the neutral per-agent file is absent, adopt the legacy
    //    layout's credentials for this name (readLaunchEnv reads the neutral file
    //    first, then the legacy per-agent file).
    const neutral = await workspace.fs.read(agentSettingsRelativePath(name));
    if (neutral === null) {
      const env = await behavior.readLaunchEnv(workspace.fs, name);
      const apiEndpoint = env.SWITCH_API_ENDPOINT;
      const apiToken = env.SWITCH_API_TOKEN;
      const agentId = env.SWITCH_AGENT_ID;
      if (apiEndpoint && apiToken && agentId) {
        await behavior.writeCredentials(workspace.fs, {
          agentName: name,
          apiEndpoint,
          apiToken,
          agentId,
        });
        changed = true;
      }
    }

    // 2. Definition: ensure the provider has an on-disk definition for this agent
    //    so it runs as a named repository-defined agent.
    if ((await behavior.readDefinition(workspace.fs, name)) === null) {
      await behavior.writeDefinition(workspace.fs, { name, description });
      changed = true;
    }

    // 3. Row: populate definitionName so sessions launch as this named agent.
    if (agent.definitionName === null) {
      await updateAgent({ agentId: agent.id, definitionName: name });
      changed = true;
    }

    return changed;
  } finally {
    workspace.close();
  }
}
