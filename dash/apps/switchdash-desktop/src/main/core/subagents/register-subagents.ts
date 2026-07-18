import type { ISubagentsBehavior, PluginFs } from '@switchdash/core/agents/plugins';
import { getAgents } from '@main/core/agents/getAgents';
import { getLocationByHostDir } from '@main/core/locations/store';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { getPlugin } from '@main/core/providers/plugin-registry';
import {
  parseSwitchAgentCredentials,
  readSwitchAgentCredentials,
} from '@main/core/switch-rooms/switch-credentials';
import { registerSubagentsBulk } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { openRemoteSubagentFs } from './resolve-workspace';
import { applyLocalSubagentAutoSessionState } from './setSubagentAutoSession';

// Remote hosts are POSIX; use a forward-slash literal rather than path.join
// (which emits backslashes on Windows). SshFileSystem normalises separators, but
// keeping this explicit matches writeRemoteSwitchSettings.
const REMOTE_SETTINGS_PATH = '.claude/settings.local.json';

export type RegisterSubagentsParams = {
  /** The agent type the subagents belong to — selects the subagent mechanism. */
  providerId: string;
  /** The registered Switch server the parent belongs to. */
  serverId: string;
  /** The agent's working directory. Its `.claude/settings.local.json` is the
   * parent identity (its agent id + API endpoint), and credentials files are
   * written under it. */
  dir: string;
  subagents: { name: string; description: string }[];
};

/**
 * Register subagents on the gateway under an already-resolved parent identity and
 * filesystem, then write each one's credentials to
 * `.claude/switch-subagents/<name>.settings.json` (via `fs`, so this works
 * against a local dir or a remote host over SFTP) to make them launchable. The
 * secret API keys are written to disk in the main process and never returned to
 * the renderer — the result is just the registered subagent names.
 */
export async function registerSubagentsCore(params: {
  behavior: ISubagentsBehavior;
  server: SwitchServer;
  /** The parent's Switch (gateway) agent id — the child agents hang off it. */
  parentSwitchAgentId: string;
  fs: PluginFs;
  subagents: { name: string; description: string }[];
  /** Register the subagents with `auto_session` on, so a watcher auto-spawns a
   * session when one is addressed. Only pass true for local parents — subagents
   * of remote parents have no watcher (neither here nor in the VM sidecar). */
  autoSession: boolean;
}): Promise<{ registered: string[] }> {
  if (params.subagents.length === 0) return { registered: [] };

  const results = await registerSubagentsBulk(params.server, {
    parentAgentId: params.parentSwitchAgentId,
    subagents: params.subagents.map((s) => ({
      subagentName: s.name,
      description: s.description,
    })),
    autoSession: params.autoSession,
  });

  for (const result of results) {
    await params.behavior.writeSettings(params.fs, {
      subagentName: result.subagentName,
      // Subagents talk to the Switch core (agent bridge), same as the parent.
      apiEndpoint: params.server.apiUrl,
      apiToken: result.apiKey,
      agentId: result.id,
    });
  }

  return { registered: results.map((r) => r.subagentName) };
}

/**
 * Seed the local auto_session mirror + start the watcher for freshly-registered
 * subagents, so they begin watching now without an off→on toggle (CHOO-1397).
 * The mirror and watcher are keyed by the parent's LOCAL agent id, resolved from
 * the parent's directory — present in the onboarding flow because the location is
 * created before its subagents are registered. Best-effort: a failure here must
 * not fail the registration (the settings panel reconciles from the gateway).
 */
async function startAutoSessionWatchers(
  dir: string,
  parentSwitchAgentId: string,
  names: string[]
): Promise<void> {
  const location = await getLocationByHostDir(null, dir);
  const localParent = location
    ? (await getAgents(location.id)).find((a) => a.switchAgentId === parentSwitchAgentId)
    : undefined;
  if (!localParent) {
    log.warn(
      'registerSubagents: no local agent for dir; auto_session watchers start on reconcile',
      {
        dir,
        parentSwitchAgentId,
      }
    );
    return;
  }
  for (const name of names) {
    await applyLocalSubagentAutoSessionState(localParent.id, name, true).catch((error) => {
      log.warn('registerSubagents: failed to start auto_session watcher for new subagent', {
        parentAgentId: localParent.id,
        name,
        error: String(error),
      });
    });
  }
}

/**
 * Register the given subagents under the directory's parent agent on the gateway
 * and write their credentials. Used by the local onboarding flow, which knows the
 * parent only by its directory: the parent's gateway id and API endpoint are read
 * from its `.claude/settings.local.json`, and files are written to the same local
 * dir.
 */
export async function registerSubagents(
  params: RegisterSubagentsParams
): Promise<{ registered: string[] }> {
  if (params.subagents.length === 0) return { registered: [] };

  const behavior = getPlugin(params.providerId).behavior.subagents;
  if (!behavior) {
    throw new Error(`Provider ${params.providerId} does not support subagents.`);
  }

  const server = await getServer(params.serverId);
  if (!server) throw new Error(`No Switch server with id ${params.serverId}`);

  const parent = await readSwitchAgentCredentials(params.dir, log);
  if (!parent) {
    throw new Error(
      `No Switch agent configured at ${params.dir} — cannot register subagents under it.`
    );
  }

  const result = await registerSubagentsCore({
    behavior,
    server,
    parentSwitchAgentId: parent.agentId,
    fs: createPluginFs(params.dir),
    subagents: params.subagents,
    autoSession: true,
  });
  await startAutoSessionWatchers(params.dir, parent.agentId, result.registered);
  return result;
}

export type RegisterSubagentsRemoteParams = {
  /** The parent agent type — selects the subagent mechanism. */
  providerId: string;
  /** The registered Switch server the parent belongs to. */
  serverId: string;
  /** The parent's SSH host + remote working dir. */
  sshHost: string;
  remoteRepoDir: string;
  subagents: { name: string; description: string }[];
};

/**
 * Remote counterpart of {@link registerSubagents} for the onboarding flow: the
 * parent lives on an SSH host with no local dir. Its gateway id is read from the
 * remote `.claude/settings.local.json` over SFTP, and each subagent's definition
 * and credentials are written back to the same remote dir.
 */
export async function registerSubagentsRemote(
  params: RegisterSubagentsRemoteParams
): Promise<{ registered: string[] }> {
  if (params.subagents.length === 0) return { registered: [] };

  const behavior = getPlugin(params.providerId).behavior.subagents;
  if (!behavior) {
    throw new Error(`Provider ${params.providerId} does not support subagents.`);
  }

  const server = await getServer(params.serverId);
  if (!server) throw new Error(`No Switch server with id ${params.serverId}`);

  const remote = await openRemoteSubagentFs(params.sshHost, params.remoteRepoDir);
  try {
    const raw = await remote.fs.read(REMOTE_SETTINGS_PATH);
    const parent = raw ? parseSwitchAgentCredentials(raw, log) : null;
    if (!parent) {
      throw new Error(
        `No Switch agent configured at ${params.sshHost}:${params.remoteRepoDir} — cannot register subagents under it.`
      );
    }
    // Subagents of remote parents register with auto_session off: neither the
    // local watcher (no project path) nor the on-VM sidecar watches subagents,
    // so an auto_session profile would advertise a capability nothing serves.
    return await registerSubagentsCore({
      behavior,
      server,
      parentSwitchAgentId: parent.agentId,
      fs: remote.fs,
      subagents: params.subagents,
      autoSession: false,
    });
  } finally {
    remote.close();
  }
}
