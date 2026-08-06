import { homedir } from 'node:os';
import type { PluginFs } from '@switchdash/core/agents/plugins';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { createRemotePluginFs } from '@main/core/providers/remote-plugin-fs';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import {
  type AgentSecretStore,
  createLocalAgentSecretStore,
  createRemoteAgentSecretStore,
} from './switch-agent-secrets';

/**
 * A {@link PluginFs} rooted at an agent's working directory (local disk or a
 * remote repo dir over SFTP), plus a `close()` that releases the SFTP channel.
 * Callers MUST invoke `close()` in a `finally` — a leaked SFTP channel
 * eventually exhausts the host's MaxSessions.
 */
export type WorkspaceFs = {
  /** FS rooted at the working dir — local disk or the remote repo dir. */
  fs: PluginFs;
  /** FS for user-scoped (`~/.claude`) definitions; empty for remote agents. */
  homeFs: PluginFs;
  /**
   * The agent tokens under `$HOME` on whichever host this workspace is on.
   *
   * Separate from `homeFs` because that one is a plain {@link PluginFs} and
   * cannot set a file mode, while these files must be `0600` — and because for
   * a remote agent `homeFs` resolves nothing at all.
   */
  secrets: AgentSecretStore;
  close: () => void;
};

/**
 * A {@link PluginFs} that resolves nothing — the user (home) scope of a remote
 * agent, whose VM home dir is not mounted here. Location-scoped agent IO (what
 * switchdash authors) is unaffected.
 */
const EMPTY_PLUGIN_FS: PluginFs = {
  read: () => Promise.resolve(null),
  write: () => Promise.reject(new Error('home scope is read-only for remote agents')),
  delete: () => Promise.resolve(),
  exists: () => Promise.resolve(false),
  list: () => Promise.resolve([]),
};

/**
 * Open a {@link WorkspaceFs} for a working directory identified by run location
 * (ssh host + dir) rather than an existing agent row — used at create/onboard
 * time before a row exists. Local dirs resolve on disk; remote dirs open an
 * SFTP channel to the host.
 */
export async function resolveWorkspaceFsFor(
  sshHost: string | null,
  dir: string
): Promise<WorkspaceFs> {
  if (sshHost === null) {
    return {
      fs: createPluginFs(dir),
      homeFs: createPluginFs(homedir()),
      secrets: createLocalAgentSecretStore(),
      close: () => {},
    };
  }
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  const sshFs = new SshFileSystem(proxy, dir);
  return {
    fs: createRemotePluginFs(sshFs),
    homeFs: EMPTY_PLUGIN_FS,
    // Unlike `homeFs`, this one works for a remote agent: it runs shell commands
    // so the far side expands `$HOME`, rather than going through repo-rooted SFTP.
    secrets: createRemoteAgentSecretStore(new SshExecutionContext(proxy, { root: dir })),
    close: () => sshFs.close(),
  };
}
