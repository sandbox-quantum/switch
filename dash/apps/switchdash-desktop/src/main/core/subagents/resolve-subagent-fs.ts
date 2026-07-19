import { homedir } from 'node:os';
import type { PluginFs } from '@switchdash/core/agents/plugins';
import { getRemoteAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { getLocationById } from '@main/core/locations/store';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { createRemotePluginFs } from '@main/core/providers/remote-plugin-fs';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import type { Agent } from '@shared/core/agents/agents';

/**
 * A PluginFs that resolves nothing. Used for the user (home) scope of a remote
 * agent, whose VM home dir is not mounted here — location-scoped subagent IO,
 * which is what switchdash authors, is unaffected.
 */
const EMPTY_PLUGIN_FS: PluginFs = {
  read: () => Promise.resolve(null),
  write: () => Promise.reject(new Error('home scope is read-only for remote agents')),
  delete: () => Promise.resolve(),
  exists: () => Promise.resolve(false),
  list: () => Promise.resolve([]),
};

export type SubagentFsContext = {
  agent: Agent;
  /** FS rooted at the parent's working dir — local disk or the remote repo dir. */
  fs: PluginFs;
  /** FS for user-scoped (`~/.claude`) definitions; empty for remote agents. */
  homeFs: PluginFs;
  /** Release resources (the remote SFTP channel). Always call in a `finally`. */
  close: () => void;
};

/**
 * Open a {@link PluginFs} rooted at a remote agent's working dir over SFTP,
 * without needing a switchdash agent record — used at onboarding time (keyed on
 * ssh host + repo dir) as well as by {@link resolveSubagentFs}. Callers
 * MUST invoke `close()` in a `finally` to release the SFTP channel.
 */
export async function openRemoteSubagentFs(
  sshHost: string,
  remoteRepoDir: string
): Promise<{ fs: PluginFs; close: () => void }> {
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  const sshFs = new SshFileSystem(proxy, remoteRepoDir);
  return { fs: createRemotePluginFs(sshFs), close: () => sshFs.close() };
}

/**
 * Resolve the filesystem where a parent agent's subagent definitions and
 * credentials live, transparently for local and remote agents. Local agents use
 * their location dir on disk; remote agents use their SSH host's repo dir over
 * SFTP (the same connect seam remote agents use for their location IO).
 *
 * Callers MUST invoke `close()` in a `finally` — for remote agents it releases
 * the SFTP channel, which otherwise leaks and eventually exhausts the host's
 * MaxSessions.
 */
export async function resolveSubagentFs(parentAgentId: string): Promise<SubagentFsContext> {
  const agent = await getAgentById(parentAgentId);
  if (!agent) throw new Error(`No agent with id ${parentAgentId}`);

  const remoteLocation = await getRemoteAgentLocation(agent);
  if (remoteLocation) {
    const remote = await openRemoteSubagentFs(remoteLocation.sshHost, remoteLocation.dir);
    return { agent, fs: remote.fs, homeFs: EMPTY_PLUGIN_FS, close: remote.close };
  }

  const location = await getLocationById(agent.locationId);
  if (!location) {
    throw new Error(`Agent ${parentAgentId} has no location on disk.`);
  }
  return {
    agent,
    fs: createPluginFs(location.dir),
    homeFs: createPluginFs(homedir()),
    close: () => {},
  };
}
