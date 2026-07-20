import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { FileSystemError, FileSystemErrorCodes } from '@main/core/fs/types';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import type { AgentApiUrlPropagation } from '@shared/core/switch-servers/switch-servers';
import { getAgentLocation } from './agent-location';
import { SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';
import { updateAgent } from './updateAgent';
import { mapAgentRowToAgent } from './utils';
import { mergeSwitchApiEndpoint } from './write-switch-settings';

// Remote hosts are POSIX; use a forward-slash literal rather than the
// platform-dependent SWITCH_SETTINGS_RELATIVE_PATH (which emits backslashes when
// switchdash runs on Windows). Matches write-remote-switch-settings.ts.
const REMOTE_SETTINGS_PATH = '.claude/settings.local.json';

/**
 * Rewrite one local agent's `SWITCH_API_ENDPOINT`, preserving its token and
 * every other key. Returns whether the file was updated (false = not a
 * provisioned Switch agent, so nothing to do).
 */
async function propagateLocal(dir: string, apiEndpoint: string): Promise<boolean> {
  const settingsPath = path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH);

  let existingRaw: string | null = null;
  try {
    existingRaw = await nodeFs.readFile(settingsPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Absent file/dir -> unprovisioned agent. Any other read failure must
    // propagate rather than be mistaken for "no config".
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }

  const merged = mergeSwitchApiEndpoint(existingRaw, apiEndpoint);
  if (merged === null) return false;
  await nodeFs.writeFile(settingsPath, merged, 'utf8');
  return true;
}

/**
 * Rewrite one remote agent's `SWITCH_API_ENDPOINT` over SFTP, preserving its
 * token and every other key. Returns whether the file was updated.
 */
async function propagateRemote(
  sshHost: string,
  remoteRepoDir: string,
  apiEndpoint: string
): Promise<boolean> {
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  const fs = new SshFileSystem(proxy, remoteRepoDir);
  try {
    let existingRaw: string | null = null;
    try {
      ({ content: existingRaw } = await fs.read(REMOTE_SETTINGS_PATH));
    } catch (error) {
      // Absent file -> unprovisioned agent. A transport failure (dead SSH
      // connection) must propagate rather than look like "no config".
      if (!(error instanceof FileSystemError && error.code === FileSystemErrorCodes.NOT_FOUND)) {
        throw error;
      }
    }

    const merged = mergeSwitchApiEndpoint(existingRaw, apiEndpoint);
    if (merged === null) return false;
    const result = await fs.write(REMOTE_SETTINGS_PATH, merged);
    if (!result.success) {
      throw new Error(`failed to write remote Switch settings: ${result.error ?? 'unknown error'}`);
    }
    return true;
  } finally {
    fs.close();
  }
}

/** Cascade a server API-URL edit to a single member agent, mapping any failure
 * to a `failed` outcome so one bad agent never aborts the rest. */
async function propagateToAgent(
  agent: Agent,
  apiEndpoint: string
): Promise<AgentApiUrlPropagation> {
  try {
    const location = await getAgentLocation(agent);
    const sshHost = location.sshHost;
    const isRemote = sshHost !== null;
    const updated = isRemote
      ? await propagateRemote(sshHost, location.dir, apiEndpoint)
      : await propagateLocal(location.dir, apiEndpoint);

    if (updated) {
      // Keep the DB mirror in step with what is now on disk.
      await updateAgent({ agentId: agent.id, apiEndpoint });
    }
    return {
      agentId: agent.id,
      agentName: agent.name,
      location: isRemote ? 'remote' : 'local',
      outcome: updated ? 'updated' : 'not-provisioned',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('switch-agents: failed to propagate server API URL to agent', {
      agentId: agent.id,
      error: message,
    });
    return {
      agentId: agent.id,
      agentName: agent.name,
      // Location lookup itself may have thrown; report best-effort.
      location: 'local',
      outcome: 'failed',
      error: message,
    };
  }
}

/**
 * Cascade a server's new API URL to every agent linked to it, rewriting each
 * agent's on-disk `SWITCH_API_ENDPOINT` (local dir or remote SSH host) and the
 * DB mirror. Agents keep their token; unprovisioned agents are skipped, not
 * clobbered. Returns a per-agent summary — failures are reported, never
 * swallowed — so the caller can surface which agents changed and which need a
 * running session restarted to pick up the new endpoint.
 */
export async function propagateServerApiUrl(
  serverId: string,
  apiEndpoint: string
): Promise<AgentApiUrlPropagation[]> {
  const rows = await db.select().from(agents).where(eq(agents.serverId, serverId));
  const results: AgentApiUrlPropagation[] = [];
  for (const row of rows) {
    results.push(await propagateToAgent(mapAgentRowToAgent(row), apiEndpoint));
  }
  return results;
}
