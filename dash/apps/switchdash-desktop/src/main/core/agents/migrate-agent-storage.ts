import { getLocationById } from '@main/core/locations/store';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { parseSwitchAgentCredentials } from '@main/core/switch-rooms/switch-credentials';
import { fetchAgentDetail } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { getAgents } from './getAgents';
import { agentSettingsRelativePath, SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';
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
    // Resolve the agent's REAL name — the credentials/definition stem, NOT
    // `agent.name` (the directory-derived display name). Prefer the row's
    // definitionName; else the on-disk agent matched to this row by switchAgentId;
    // else the registered Switch name from the gateway (authoritative — the same
    // name new agents are created under). Never the directory name (CHOO-1440).
    let name = agent.definitionName;
    let description = agent.name;
    if (!name) {
      if (!agent.switchAgentId) return false;
      const discovered = await behavior.discoverLocal(workspace.fs, workspace.homeFs);
      const match = discovered.find((d) => d.switchAgentId === agent.switchAgentId);
      if (match) {
        name = match.name;
        description = match.description ?? match.name;
      } else {
        const registered = await fetchRegisteredName(agent);
        if (!registered) {
          log.info('migrateAgentStorage: could not resolve a real name for agent; skipping', {
            agentId: agent.id,
            switchAgentId: agent.switchAgentId,
          });
          return false;
        }
        name = registered.name;
        description = registered.description;
      }
    }

    let changed = false;

    // 1. Credentials: if the neutral per-agent file is absent, adopt the legacy
    //    layout's credentials — the per-agent file (via readLaunchEnv, which reads
    //    the neutral then legacy per-agent locations), else the shared
    //    `.claude/settings.local.json` (legacy "main" agent).
    const neutral = await workspace.fs.read(agentSettingsRelativePath(name));
    if (neutral === null) {
      const creds =
        toCreds(await behavior.readLaunchEnv(workspace.fs, name)) ??
        parseSwitchAgentCredentials(
          (await workspace.fs.read(SWITCH_SETTINGS_RELATIVE_PATH)) ?? '',
          log
        );
      if (creds) {
        await behavior.writeCredentials(workspace.fs, {
          agentName: name,
          apiEndpoint: creds.apiEndpoint,
          apiToken: creds.token,
          agentId: creds.agentId,
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

/** The agent's registered name + description on its Switch server, or null. */
async function fetchRegisteredName(
  agent: Agent
): Promise<{ name: string; description: string } | null> {
  if (!agent.serverId || !agent.switchAgentId) return null;
  const server = await getServer(agent.serverId);
  if (!server) return null;
  try {
    const detail = await fetchAgentDetail(server, agent.switchAgentId);
    return { name: detail.name, description: detail.description || detail.name };
  } catch (error) {
    log.warn('migrateAgentStorage: failed to fetch registered agent name', {
      agentId: agent.id,
      error: String(error),
    });
    return null;
  }
}

/** Build credentials from a launch-env map, or null when any value is missing. */
function toCreds(
  env: Record<string, string>
): { apiEndpoint: string; token: string; agentId: string } | null {
  const apiEndpoint = env.SWITCH_API_ENDPOINT;
  const token = env.SWITCH_API_TOKEN;
  const agentId = env.SWITCH_AGENT_ID;
  if (apiEndpoint && token && agentId) return { apiEndpoint, token, agentId };
  return null;
}
