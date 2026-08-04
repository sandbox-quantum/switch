import { getLocationById } from '@main/core/locations/store';
import { getPlugin } from '@main/core/providers/plugin-registry';
import {
  parseSwitchAgentCredentials,
  type SwitchAgentCredentials,
} from '@main/core/switch-rooms/switch-credentials';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import {
  AGENT_STORAGE_MIGRATION_GENERATION,
  completedAgentStorageMigrationGeneration,
  markAgentStorageMigrationComplete,
} from './agent-storage-migration-marker';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { getAgents } from './getAgents';
import { agentSettingsRelativePath, SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';
import { writeNeutralAgentSettingsFs } from './write-switch-settings';

/**
 * Migrate existing switchdash-managed agents to the current storage/definition
 * layout (CHOO-1440): every agent is a repository-defined agent with a per-agent
 * credentials file at `.switch/agents/<name>.json` and an on-disk definition,
 * both keyed by the agent's single `name`. Pre-CHOO-1440 installs kept
 * credentials in the legacy `.claude/switch-subagents/<name>.settings.json` (or
 * the shared `.claude/settings.local.json`).
 *
 * Runs once at boot, best-effort: each agent is migrated in isolation so one bad
 * directory or unreachable host never aborts the rest, and every step is
 * idempotent (re-running does nothing once an agent is in the new layout).
 * Applies to LOCAL and REMOTE agents alike — remote reads/writes go over SFTP
 * through the same provider filesystem abstraction.
 */
export async function migrateAgentStorage(): Promise<void> {
  // Once a full pass has migrated every agent, never re-run: the steady-state
  // migration re-opens each agent's workspace filesystem (an SSH/SFTP round trip
  // per remote agent) on every boot for no benefit.
  const completed = await completedAgentStorageMigrationGeneration();
  if (completed >= AGENT_STORAGE_MIGRATION_GENERATION) return;

  const agents = await getAgents();
  let migrated = 0;
  let allComplete = true;
  for (const agent of agents) {
    try {
      if (await migrateOne(agent, completed)) migrated += 1;
    } catch (error) {
      allComplete = false;
      log.warn('migrateAgentStorage: failed to migrate agent', {
        agentId: agent.id,
        error: String(error),
      });
    }
  }
  if (migrated > 0) {
    log.info('migrateAgentStorage: migrated agents to the neutral storage layout', { migrated });
  }
  // Only latch the marker when every agent reached the final layout this pass.
  // A transient failure (unreachable host, gateway down) leaves it unset so the
  // next boot retries — cheaply, since the migration now runs off the boot path.
  if (allComplete) await markAgentStorageMigrationComplete();
}

/**
 * Migrate one agent (local or remote). Returns whether anything was written.
 *
 * `completedGeneration` is the generation this install already finished, so a
 * re-run can skip agents the new generation cannot change — the check happens
 * before the workspace filesystem is opened, which for a remote agent is an SSH
 * connect and an SFTP channel.
 */
async function migrateOne(agent: Agent, completedGeneration: number): Promise<boolean> {
  // A provider may have no repo-agent behavior (e.g. Codex): it has no on-disk
  // definition and no `readLaunchEnv` hook, but its provider-neutral credentials
  // still need collapsing onto the one name-keyed key-space. So the credential
  // migration runs for every provider; its Claude-specific sources, and the
  // definition step (2), are behavior-gated.
  const behavior = getPlugin(agent.providerId).behavior.repoAgents;

  // Generation 2 only broadened step 1 to providers WITHOUT a behavior; for one
  // that has it, every step is what generation 1 already ran. Skipping here is
  // what keeps the generation bump from re-opening a workspace per Claude agent.
  if (completedGeneration >= 1 && behavior) return false;

  const location = await getLocationById(agent.locationId);
  if (!location) return false;

  const workspace = await resolveWorkspaceFsFor(location.sshHost, location.dir);
  try {
    // The agent's identity is its single `name` (CHOO-1440): the creds/definition
    // stem on disk. It is authoritative — earlier migrations, and the 0041 SQL
    // backfill, have already collapsed the former `definitionName` onto it.
    const name = agent.name;
    const description = agent.name;

    let changed = false;

    // 1. Credentials: if the name-keyed neutral file is absent, adopt whatever
    //    complete credentials already exist on disk *for this agent*, in priority
    //    order:
    //      a. a stale ID-keyed neutral file `.switch/agents/<agentId>.json` — an
    //         earlier layout keyed the neutral file by agent id, not name (this
    //         includes Codex agents added on the pre-rework id-keyed scheme);
    //      b. the legacy per-agent file (via readLaunchEnv: name-keyed neutral
    //         then `.claude/switch-subagents/<name>.settings.json`);
    //      c. the shared `.claude/settings.local.json` (legacy "main" agent).
    //    (b) and (c) are Claude-only sources, hence behavior-gated: the shared
    //    settings file is written solely by `provisionAgent`/`provisionRemoteAgent`,
    //    always as the Claude "main" agent, so for any other provider it holds a
    //    *different* agent's identity and token.
    //    The token is minted once and lives only on disk, so this is the only way
    //    to recover it — nothing can reconstruct it from the gateway.
    const idKeyedRelPath = agentSettingsRelativePath(agent.id);
    const namedRelPath = agentSettingsRelativePath(name);
    const neutral = name === agent.id ? null : await workspace.fs.read(namedRelPath);
    if (neutral === null) {
      const recovered =
        parseSwitchAgentCredentials(await workspace.fs.read(idKeyedRelPath), log) ??
        (behavior ? toCreds(await behavior.readLaunchEnv(workspace.fs, name)) : null) ??
        (behavior
          ? parseSwitchAgentCredentials(await workspace.fs.read(SWITCH_SETTINGS_RELATIVE_PATH), log)
          : null);
      if (recovered && !belongsToAgent(agent, recovered)) {
        log.warn('migrateAgentStorage: recovered credentials name a different Switch agent', {
          agentId: agent.id,
          agentName: name,
          providerId: agent.providerId,
          expectedSwitchAgentId: agent.switchAgentId,
          foundSwitchAgentId: recovered.agentId,
        });
      } else if (recovered) {
        await writeNeutralAgentSettingsFs(workspace.fs, {
          slug: name,
          apiEndpoint: recovered.apiEndpoint,
          apiToken: recovered.token,
          agentId: recovered.agentId,
        });
        changed = true;
      }
    }

    // Remove the stale ID-keyed neutral file once the name-keyed one is in place:
    // an incomplete leftover there otherwise shadows the real creds in the
    // session preflight (which scans both), and a complete one is now redundant.
    if (name !== agent.id && (await workspace.fs.read(namedRelPath)) !== null) {
      if ((await workspace.fs.read(idKeyedRelPath)) !== null) {
        await workspace.fs.delete(idKeyedRelPath);
        changed = true;
      }
    }

    // 2. Definition: ensure the provider has an on-disk definition for this agent
    //    so it runs as a named repository-defined agent. Behavior providers only —
    //    a provider without definitions (Codex) has nothing to write here.
    if (behavior && (await behavior.readDefinition(workspace.fs, name)) === null) {
      await behavior.writeDefinition(workspace.fs, { name, description });
      changed = true;
    }

    return changed;
  } finally {
    workspace.close();
  }
}

/**
 * Whether recovered credentials are this agent's own. The row's `switchAgentId`
 * is the authority on which Switch identity the agent has, so a file naming a
 * different one belongs to a different agent — adopting it would launch this
 * agent under that agent's identity and token, which looks like it worked. A row
 * with no recorded identity has nothing to contradict.
 */
function belongsToAgent(agent: Agent, creds: SwitchAgentCredentials): boolean {
  return agent.switchAgentId === null || agent.switchAgentId === creds.agentId;
}

/** Build credentials from a launch-env map, or null when any value is missing. */
function toCreds(env: Record<string, string>): SwitchAgentCredentials | null {
  const apiEndpoint = env.SWITCH_API_ENDPOINT;
  const token = env.SWITCH_API_TOKEN;
  const agentId = env.SWITCH_AGENT_ID;
  if (apiEndpoint && token && agentId) return { apiEndpoint, token, agentId };
  return null;
}
