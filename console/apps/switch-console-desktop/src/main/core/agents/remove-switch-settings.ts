import type { PluginFs } from '@switch-console/core/agents/plugins';
import { SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';
import { removeSwitchSettings } from './write-switch-settings';

/**
 * Tear down the Switch credentials an agent wrote at provision time: strip the
 * `SWITCH_*` env block and Switch allow-rules from `.claude/settings.local.json`,
 * deleting the file if it was ours alone and leaving it untouched if it was
 * never a provisioned Switch agent. `fs` is rooted at the agent's working
 * directory and works byte-identically for a local directory and a remote SSH
 * host, so one call covers both.
 */
export async function removeSwitchCredentials(fs: PluginFs): Promise<void> {
  const existing = await fs.read(SWITCH_SETTINGS_RELATIVE_PATH);
  const result = removeSwitchSettings(existing);
  if (result.kind === 'skip') return;
  if (result.kind === 'delete') {
    await fs.delete(SWITCH_SETTINGS_RELATIVE_PATH);
    return;
  }
  await fs.write(SWITCH_SETTINGS_RELATIVE_PATH, result.content);
}
