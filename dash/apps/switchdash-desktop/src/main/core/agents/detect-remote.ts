import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { FileSystemError, FileSystemErrorCodes } from '@main/core/fs/types';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { log } from '@main/lib/logger';
import type { SwitchAgentConfig } from '@shared/switch-agents';
import { parseSwitchAgentSettings } from './detect';
import { SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';

/**
 * Detect whether `remoteRepoDir` on `sshHost` is configured as a Switch agent by
 * reading its `.claude/settings.local.json` over SSH and parsing the `SWITCH_*`
 * env block. Mirrors {@link detectSwitchAgent} for remote agents, whose working
 * directory and config live entirely on the host (no local copy).
 *
 * Reads over SFTP (the same clean channel {@link writeRemoteSwitchSettings} writes
 * on) rather than `cat` through a login shell: a shell would prepend the host's
 * MOTD/banner to stdout, corrupting the JSON and making a real agent look
 * unconfigured.
 *
 * Returns `null` when the file is genuinely absent or lacks a usable
 * `SWITCH_AGENT_ID` / `SWITCH_API_ENDPOINT`. A read failure that is NOT
 * "no such file" (dead connection, permission problem) propagates instead —
 * a broken probe must not present a configured agent as unconfigured.
 */
export async function detectSwitchAgentRemote(
  sshHost: string,
  remoteRepoDir: string
): Promise<SwitchAgentConfig | null> {
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  const fs = new SshFileSystem(proxy, remoteRepoDir);

  let raw: string;
  try {
    ({ content: raw } = await fs.read(SWITCH_SETTINGS_RELATIVE_PATH));
  } catch (error) {
    if (error instanceof FileSystemError && error.code === FileSystemErrorCodes.NOT_FOUND) {
      log.info('switch-agents: no remote Switch settings file', {
        sshHost,
        remoteRepoDir,
        error: error.message,
      });
      return null;
    }
    throw error;
  } finally {
    fs.close();
  }

  return parseSwitchAgentSettings(raw, remoteRepoDir);
}
