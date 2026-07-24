import z from 'zod';
import { definePluginCapability } from '../../../lib/plugins/capability';
import type { PluginFs } from '../../runtime/fs';

/**
 * Provider-owned teardown of the Switch credentials this agent type wrote at
 * provision time — the inverse of the credential-writing side of setup.
 *
 * A provider only needs to implement this when it stores its Switch credentials
 * somewhere other than the default `.claude/settings.local.json` env block (which
 * the generic teardown already handles for every agent that follows the
 * Claude-Code layout). Implement it to remove whatever/wherever this agent type
 * persisted its `SWITCH_*` credentials, so deleting the agent leaves no orphaned
 * secrets. `fs` is rooted at the agent's working directory and works identically
 * for a local dir or a remote SSH host, so one implementation covers both.
 */
export type ISwitchSetupBehavior = {
  removeCredentials(fs: PluginFs): Promise<void>;
};

/**
 * Describes how an agent type installs and manages its Switch connector plugin.
 *
 * kind: 'cli'  — the agent exposes a Claude-Code-style plugin marketplace CLI
 *                (`<agent> plugin install/update/uninstall`, `<agent> plugin
 *                marketplace add/update/list`). The main-process switch-setup
 *                service drives that CLI from these descriptor fields.
 * kind: 'none' — the agent has no Switch connector setup; the UI surfaces nothing.
 *
 * The descriptor is purely declarative — the generic CLI driver handles plugin
 * install/update for every agent that shares the marketplace model. The optional
 * {@link ISwitchSetupBehavior} is only for the one thing that can be genuinely
 * provider-specific: where credentials live on disk, so they can be torn down on
 * delete. Providers using the default `.claude` layout omit it.
 */
export const switchSetupCapability = definePluginCapability<ISwitchSetupBehavior>()(
  'switch-setup',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('cli'),
      /** Plugin name as published, e.g. 'switch-connector'. */
      pluginName: z.string(),
      /** Marketplace name the plugin is published under, e.g. 'switch-plugins'. */
      marketplaceName: z.string(),
      /** Source passed to `marketplace add`: a GitHub `owner/repo` or a path. */
      marketplaceSource: z.string(),
      /** Install scope flag for `-s`. */
      scope: z.enum(['user', 'project', 'local']).default('user'),
    }),
    z.object({ kind: z.literal('none') }),
  ])
);

export type SwitchSetupDescriptor = (typeof switchSetupCapability)['_descriptor'];
