import type { PluginFs } from '@switch-console/core/agents/plugins';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';
import { removeSwitchSettings } from './write-switch-settings';

/**
 * Reverse the default `.claude/settings.local.json` provisioning: strip the
 * `SWITCH_*` env block and connector allow-rules, deleting the file if it was
 * ours alone and leaving it untouched if it was never a provisioned Switch agent.
 * Operates through `PluginFs`, so it works byte-identically for a local working
 * directory and a remote SSH host.
 */
async function removeDefaultSwitchCredentials(fs: PluginFs): Promise<void> {
  const existing = await fs.read(SWITCH_SETTINGS_RELATIVE_PATH);
  const result = removeSwitchSettings(existing);
  if (result.kind === 'skip') return;
  if (result.kind === 'delete') {
    await fs.delete(SWITCH_SETTINGS_RELATIVE_PATH);
    return;
  }
  await fs.write(SWITCH_SETTINGS_RELATIVE_PATH, result.content);
}

/**
 * Tear down the Switch credentials an agent of `providerId` wrote at provision
 * time. Providers that store their credentials somewhere other than the default
 * `.claude` layout own that teardown via `behavior.switchSetup.removeCredentials`;
 * every other provider falls through to the default reverse-merge. `fs` is rooted
 * at the agent's working directory (local or remote), so one call covers both.
 */
export async function removeSwitchCredentials(providerId: string, fs: PluginFs): Promise<void> {
  const behavior = getPlugin(providerId).behavior.switchSetup;
  if (behavior) {
    await behavior.removeCredentials(fs);
    return;
  }
  await removeDefaultSwitchCredentials(fs);
}
