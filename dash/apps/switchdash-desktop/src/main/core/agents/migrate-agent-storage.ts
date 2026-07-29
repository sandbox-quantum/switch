import { getLocationById } from '@main/core/locations/store';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { parseSwitchAgentCredentials } from '@main/core/switch-rooms/switch-credentials';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import {
  isAgentStorageMigrationComplete,
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
  if (await isAgentStorageMigrationComplete()) return;

  const agents = await getAgents();
  let migrated = 0;
  let allComplete = true;
  for (const agent of agents) {
    try {
      const result = await migrateOne(agent);
      if (result.changed) migrated += 1;
      if (!result.complete) allComplete = false;
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

interface MigrateResult {
  /** Whether this pass wrote anything for the agent. */
  changed: boolean;
  /** Whether the agent is now fully in the new layout (nothing left to retry). */
  complete: boolean;
}

/** Migrate one agent (local or remote). */
async function migrateOne(agent: Agent): Promise<MigrateResult> {
  // A provider may have no repo-agent behavior (e.g. Codex): it has no on-disk
  // definition and no `writeCredentials`/`readLaunchEnv` hooks, but its
  // provider-neutral credentials still need collapsing onto the one name-keyed
  // key-space. So the credential migration runs for every provider; only the
  // definition step (2) is behavior-gated.
  const behavior = getPlugin(agent.providerId).behavior.repoAgents;

  const location = await getLocationById(agent.locationId);
  if (!location) return { changed: false, complete: true };

  const workspace = await resolveWorkspaceFsFor(location.sshHost, location.dir);
  try {
    // The agent's identity is its single `name` (CHOO-1440): the creds/definition
    // stem on disk. It is authoritative — earlier migrations, and the 0041 SQL
    // backfill, have already collapsed the former `definitionName` onto it.
    const name = agent.name;
    const description = agent.name;

    let changed = false;

    // 1. Credentials: if the name-keyed neutral file is absent, adopt whatever
    //    complete credentials already exist on disk, in priority order:
    //      a. a stale ID-keyed neutral file `.switch/agents/<agentId>.json` — an
    //         earlier layout keyed the neutral file by agent id, not name (this
    //         includes Codex agents added on the pre-rework id-keyed scheme);
    //      b. the legacy per-agent file (via readLaunchEnv: name-keyed neutral
    //         then `.claude/switch-subagents/<name>.settings.json`) — behavior
    //         providers only;
    //      c. the shared `.claude/settings.local.json` (legacy "main" agent).
    //    The token is minted once and lives only on disk, so this is the only way
    //    to recover it — nothing can reconstruct it from the gateway.
    const idKeyedRelPath = agentSettingsRelativePath(agent.id);
    const namedRelPath = agentSettingsRelativePath(name);
    const neutral = name === agent.id ? null : await workspace.fs.read(namedRelPath);
    if (neutral === null) {
      const creds =
        parseSwitchAgentCredentials((await workspace.fs.read(idKeyedRelPath)) ?? '', log) ??
        (behavior ? toCreds(await behavior.readLaunchEnv(workspace.fs, name)) : null) ??
        parseSwitchAgentCredentials(
          (await workspace.fs.read(SWITCH_SETTINGS_RELATIVE_PATH)) ?? '',
          log
        );
      if (creds) {
        await writeNeutralAgentSettingsFs(workspace.fs, {
          slug: name,
          apiEndpoint: creds.apiEndpoint,
          apiToken: creds.token,
          agentId: creds.agentId,
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

    return { changed, complete: true };
  } finally {
    workspace.close();
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
