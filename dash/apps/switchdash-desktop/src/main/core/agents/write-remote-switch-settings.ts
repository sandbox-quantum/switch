import {
  FileSystemError,
  FileSystemErrorCodes,
  type FileSystemProvider,
} from '@main/core/fs/types';
import { SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';
import { mergeSwitchSettings, type SwitchSettingsCredentials } from './write-switch-settings';

const REMOTE_SETTINGS_DIR = '.claude';

/**
 * Write the agent's `SWITCH_*` credentials into the remote working directory's
 * `.claude/settings.local.json` over SFTP, merging with any existing file. The
 * remote runtime sidecar reads its creds from this file (CHOO-1059), so this is
 * the one-time setup write that makes a remote agent able to authenticate to
 * Switch from its VM.
 *
 * `fs` is the session's remote FileSystemProvider, rooted at the agent's remote
 * repo dir. The merge is byte-identical to the local writer's.
 *
 * `apiToken` is the agent's secret — written here and never returned/logged.
 */
export async function writeRemoteSwitchSettings(
  fs: FileSystemProvider,
  creds: SwitchSettingsCredentials
): Promise<void> {
  let existingRaw: string | null = null;
  try {
    const result = await fs.read(SWITCH_SETTINGS_RELATIVE_PATH);
    existingRaw = result.content;
  } catch (error) {
    // Start fresh only when the file is genuinely absent. A transport failure
    // (dropped SSH connection, exhausted channel) must propagate — merging
    // into "nothing" would rewrite the file without its hooks block.
    if (!(error instanceof FileSystemError && error.code === FileSystemErrorCodes.NOT_FOUND)) {
      throw error;
    }
  }

  const merged = mergeSwitchSettings(existingRaw, creds);
  await fs.mkdir(REMOTE_SETTINGS_DIR, { recursive: true });
  const result = await fs.write(SWITCH_SETTINGS_RELATIVE_PATH, merged);
  if (!result.success) {
    throw new Error(`failed to write remote Switch settings: ${result.error ?? 'unknown error'}`);
  }
}
