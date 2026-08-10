import * as toml from 'smol-toml';
import type { PluginFs } from '../../runtime/fs';
import type { HookRegistration } from '../capabilities/hooks';
import { SWITCHDASH_MARKER, filterUserHooks } from './hooks';

export type { HookCommandOptions } from './hooks';

// ── JSON config helpers ────────────────────────────────────────────────────

export async function readJsonConfig(fs: PluginFs, path: string): Promise<Record<string, unknown>> {
  const content = await fs.read(path);
  if (!content) return {};
  try {
    return (JSON.parse(content) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

/**
 * Read a JSON config that is about to be modified and rewritten. Unlike
 * `readJsonConfig`, non-object content (unparseable or a non-object root) is an
 * error rather than `{}`: proceeding would rewrite the file from scratch and
 * silently discard everything else in it (e.g. the `env` block holding Switch
 * credentials in `.claude/settings.local.json`).
 */
export async function readJsonConfigForUpdate(
  fs: PluginFs,
  path: string
): Promise<Record<string, unknown>> {
  const content = await fs.read(path);
  if (!content) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`refusing to update ${path}: existing content is not valid JSON: ${error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`refusing to update ${path}: existing content is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export async function writeJsonConfig(
  fs: PluginFs,
  path: string,
  config: Record<string, unknown>
): Promise<void> {
  await fs.write(path, JSON.stringify(config, null, 2) + '\n');
}

// ── TOML config helpers ────────────────────────────────────────────────────

export async function readTomlConfig(fs: PluginFs, path: string): Promise<Record<string, unknown>> {
  const content = await fs.read(path);
  if (!content) return {};
  try {
    return (toml.parse(content) as Record<string, unknown>) ?? {};
  } catch (error) {
    throw new Error(`Failed to parse ${path}: ${String(error)}`);
  }
}

export async function writeTomlConfig(
  fs: PluginFs,
  path: string,
  config: Record<string, unknown>
): Promise<void> {
  await fs.write(path, toml.stringify(config));
}

// ── Entry builders ─────────────────────────────────────────────────────────

/**
 * Claude/Codex-style nested entry: `{ hooks: [{ type: 'command', command }] }`.
 * When `matcher` is given it is included as `{ matcher, hooks: [...] }` — Claude
 * uses it to scope tool-event hooks (e.g. PostToolUse) to specific tool names.
 */
export function buildNestedEntry(command: string, matcher?: string): Record<string, unknown> {
  const hooks = [{ type: 'command', command }];
  return matcher === undefined ? { hooks } : { matcher, hooks };
}

/** Copilot-style flat entry: `{ type: 'command', command }` */
export function buildFlatEntry(command: string): Record<string, unknown> {
  return { type: 'command', command };
}

/** Kiro-style minimal entry: `{ command }` */
export function buildMinimalEntry(command: string): Record<string, unknown> {
  return { command };
}

// ── Merge helpers ───────────────────────────────────────────────────────────

export function mergeNestedEntries(
  existing: unknown[],
  command: string,
  matcher?: string
): unknown[] {
  return [
    ...filterUserHooks(existing as Record<string, unknown>[]),
    buildNestedEntry(command, matcher),
  ];
}

export function mergeFlatEntries(existing: unknown[], command: string): unknown[] {
  return [...filterUserHooks(existing as Record<string, unknown>[]), buildFlatEntry(command)];
}

export function mergeMinimalEntries(existing: unknown[], command: string): unknown[] {
  return [...filterUserHooks(existing as Record<string, unknown>[]), buildMinimalEntry(command)];
}

// ── Generic hook config builders ────────────────────────────────────────────

type HookSpec = { hookKey: string; command: string; matcher?: string };
type FlatTomlHookConfigOptions = {
  beforeWrite?: (fs: PluginFs) => Promise<void>;
  afterWrite?: (fs: PluginFs) => Promise<string[]>;
  afterDelete?: (fs: PluginFs) => Promise<void>;
  stringifyEntry?: (entry: Record<string, unknown>) => string;
};

/**
 * Build an `IHooksBehavior` for agents that store hooks as a flat TOML array:
 *   `[[hooks]]` / `{ hooks = [{ ... }] }`
 */
export function buildFlatTomlHookConfig(
  configPath: string,
  entries: Record<string, unknown>[],
  options: FlatTomlHookConfigOptions = {}
) {
  const stringifyEntry = options.stringifyEntry ?? JSON.stringify;
  const getHookEntries = (config: Record<string, unknown>) =>
    Array.isArray(config.hooks) ? (config.hooks as Record<string, unknown>[]) : [];
  const hasSwitchConsoleHook = (config: Record<string, unknown>) =>
    getHookEntries(config).some((entry) => stringifyEntry(entry).includes(SWITCHDASH_MARKER));

  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readTomlConfig(fs, configPath);
      return hasSwitchConsoleHook(config)
        ? [{ event: 'switchdash', command: SWITCHDASH_MARKER }]
        : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[]): Promise<string[]> {
      const config = await readTomlConfig(fs, configPath);
      await options.beforeWrite?.(fs);
      const userHooks = filterUserHooks(getHookEntries(config), stringifyEntry);
      await writeTomlConfig(fs, configPath, { ...config, hooks: [...userHooks, ...entries] });
      const extraPaths = (await options.afterWrite?.(fs)) ?? [];
      return [configPath, ...extraPaths];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      const config = await readTomlConfig(fs, configPath);
      await writeTomlConfig(fs, configPath, {
        ...config,
        hooks: filterUserHooks(getHookEntries(config), stringifyEntry),
      });
      await options.afterDelete?.(fs);
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readTomlConfig(fs, configPath);
      return hasSwitchConsoleHook(config);
    },
  };
}

/**
 * Build an `IHooksBehavior` for agents that store hooks in a JSON file using
 * the nested format:
 *   `{ hooks: { <Event>: [{ hooks: [{ type: 'command', command }] }] } }`
 *
 * Pass pre-built command strings (from `makeStdinHookCommand`, etc.) in `hookSpecs`.
 */
export function buildNestedJsonHookConfig(configPath: string, hookSpecs: HookSpec[]) {
  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readJsonConfig(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      const installed = hookSpecs.some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(SWITCHDASH_MARKER));
      });
      return installed ? [{ event: 'switchdash', command: SWITCHDASH_MARKER }] : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[]): Promise<string[]> {
      const config = await readJsonConfigForUpdate(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      // Strip previously-installed Switch Console entries once per touched key, THEN
      // append every spec. Doing the strip inside the append loop would let a
      // second spec sharing a hookKey (e.g. two PostToolUse matchers) filter
      // out the first spec's just-added entry.
      for (const hookKey of new Set(hookSpecs.map((s) => s.hookKey))) {
        const existing = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        hooks[hookKey] = filterUserHooks(existing as Record<string, unknown>[]);
      }
      for (const { hookKey, command, matcher } of hookSpecs) {
        hooks[hookKey] = [...(hooks[hookKey] as unknown[]), buildNestedEntry(command, matcher)];
      }
      await writeJsonConfig(fs, configPath, { ...config, hooks });
      return [configPath];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      const config = await readJsonConfigForUpdate(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      for (const key of Object.keys(hooks)) {
        hooks[key] = filterUserHooks(hooks[key] as Record<string, unknown>[]);
      }
      await writeJsonConfig(fs, configPath, { ...config, hooks });
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readJsonConfig(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      return hookSpecs.some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(SWITCHDASH_MARKER));
      });
    },
  };
}

/**
 * Build an `IHooksBehavior` for agents that store hooks in a JSON file using
 * the flat format: `{ hooks: { <Event>: [{ type: 'command', command }] } }`
 *
 * Optionally pass `extraFields` to merge at the config root (e.g. copilot `version`).
 */
export function buildFlatJsonHookConfig(
  configPath: string,
  hookSpecs: HookSpec[],
  extraRoot?: Record<string, unknown>
) {
  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readJsonConfig(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      const installed = hookSpecs.some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(SWITCHDASH_MARKER));
      });
      return installed ? [{ event: 'switchdash', command: SWITCHDASH_MARKER }] : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[]): Promise<string[]> {
      const config = await readJsonConfigForUpdate(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      for (const { hookKey, command } of hookSpecs) {
        const existing = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        hooks[hookKey] = mergeFlatEntries(existing, command);
      }
      await writeJsonConfig(fs, configPath, { ...config, ...extraRoot, hooks });
      return [configPath];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      const config = await readJsonConfigForUpdate(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      for (const key of Object.keys(hooks)) {
        hooks[key] = filterUserHooks(hooks[key] as Record<string, unknown>[]);
      }
      await writeJsonConfig(fs, configPath, { ...config, hooks });
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readJsonConfig(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      return hookSpecs.some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(SWITCHDASH_MARKER));
      });
    },
  };
}

/**
 * Build an `IHooksBehavior` for agents that store hooks as a minimal
 * `{ command }` object array under `config.hooks.<hookKey>`.
 */
export function buildMinimalJsonHookConfig(
  configPath: string,
  hookSpecs: HookSpec[],
  extraRoot?: Record<string, unknown>
) {
  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readJsonConfig(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      const installed = hookSpecs.some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(SWITCHDASH_MARKER));
      });
      return installed ? [{ event: 'switchdash', command: SWITCHDASH_MARKER }] : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[]): Promise<string[]> {
      const config = await readJsonConfigForUpdate(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      for (const { hookKey, command } of hookSpecs) {
        const existing = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        hooks[hookKey] = mergeMinimalEntries(existing, command);
      }
      await writeJsonConfig(fs, configPath, { ...config, ...extraRoot, hooks });
      return [configPath];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      const config = await readJsonConfigForUpdate(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      for (const key of Object.keys(hooks)) {
        hooks[key] = filterUserHooks(hooks[key] as Record<string, unknown>[]);
      }
      await writeJsonConfig(fs, configPath, { ...config, hooks });
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readJsonConfig(fs, configPath);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      return hookSpecs.some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(SWITCHDASH_MARKER));
      });
    },
  };
}
