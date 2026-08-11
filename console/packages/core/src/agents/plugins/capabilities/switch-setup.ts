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
 * Which plugin-marketplace CLI dialect an agent speaks.
 *
 * Both dialects share the marketplace model — register a marketplace source,
 * install a named plugin from it — but they disagree on verbs, flags and the
 * JSON shapes they emit, so the driver cannot assume one from the other:
 *
 * - `claude-code`: `plugin install|update|uninstall <ref> -s <scope>`,
 *   `plugin marketplace update`; `plugin list --json` entries carry `id` and
 *   `installPath`; manifests live under `.claude-plugin/`.
 * - `codex`: `plugin add|remove <ref>` (no scope flag, and **no per-plugin
 *   update verb** — updating is remove-then-add), `plugin marketplace upgrade`;
 *   `plugin list --json` returns `{ installed, available }` whose entries carry
 *   `pluginId` and `source.path`; manifests live under `.codex-plugin/`.
 */
export const SWITCH_SETUP_CLI_DIALECTS = ['claude-code', 'codex'] as const;
export type SwitchSetupCliDialect = (typeof SWITCH_SETUP_CLI_DIALECTS)[number];

/**
 * Describes how an agent type installs and manages its Switch connector plugin.
 *
 * kind: 'cli'  — the agent exposes a plugin marketplace CLI. The main-process
 *                switch-setup service drives that CLI from these descriptor
 *                fields, using the verb/parse rules for the declared `dialect`.
 * kind: 'none' — the agent has no Switch connector setup; the UI surfaces nothing.
 *
 * The descriptor is purely declarative — one generic driver serves every agent
 * that shares the marketplace model, with `dialect` naming the surface
 * differences rather than forking the code path. The optional
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
      /** Install scope flag for `-s`. Ignored by dialects that have no scope. */
      scope: z.enum(['user', 'project', 'local']).default('user'),
      /** Which CLI dialect this agent's `plugin` subcommand speaks. */
      dialect: z.enum(SWITCH_SETUP_CLI_DIALECTS).default('claude-code'),
    }),
    z.object({ kind: z.literal('none') }),
  ])
);

export type SwitchSetupDescriptor = (typeof switchSetupCapability)['_descriptor'];
