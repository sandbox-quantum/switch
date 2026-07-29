import type { SwitchSetupCliDialect } from '@switchdash/core/agents/plugins';

/**
 * One installed plugin, normalised across CLI dialects.
 *
 * `ref` is the `<plugin>@<marketplace>` identifier used to address the plugin in
 * install/remove commands. `manifestPath` is a directory that should contain the
 * plugin manifest, when the CLI reports one worth reading.
 */
export type InstalledPlugin = {
  ref: string;
  version: string | null;
  manifestPath: string | null;
};

/** One registered marketplace, normalised across CLI dialects. */
export type RegisteredMarketplace = {
  name: string;
  /** The source it was registered from (a repo slug or a local path). */
  source: string | null;
  /** Local root of the marketplace checkout, where its manifest lives. */
  root: string | null;
};

/**
 * The surface differences between plugin-marketplace CLIs.
 *
 * Both dialects share the same model, so the driver stays generic; everything
 * that genuinely differs — verbs, flags, and the JSON each command emits — is
 * named here. Parsers are total: unparseable or unexpected output yields an
 * empty list rather than throwing, because these feed status reads that must
 * degrade to "not installed" rather than crash the settings page.
 */
export type SwitchSetupCliRules = {
  /** Directory holding a plugin's manifest, relative to the plugin root. */
  pluginManifestDir: string;
  /** Directory holding a marketplace's manifest, relative to its root. */
  marketplaceManifestDir: string;
  installArgs(ref: string, scope: string): string[];
  uninstallArgs(ref: string, scope: string): string[];
  /**
   * Args to update an installed plugin in place, or null when the CLI has no
   * such verb — the driver then falls back to uninstall-then-install.
   */
  updateArgs(ref: string, scope: string): string[] | null;
  /** Args to refresh a marketplace snapshot. */
  marketplaceRefreshArgs(marketplaceName: string): string[];
  /**
   * Shape-readers over already-parsed CLI JSON. Callers own extraction — the
   * local driver can `JSON.parse` directly, while the remote one must first
   * strip login-shell banner noise — so the dialect only owns the shape.
   */
  parsePluginList(parsed: unknown): InstalledPlugin[];
  parseMarketplaceList(parsed: unknown): RegisteredMarketplace[];
  /**
   * Versions the marketplace advertises, read from the CLI's own listing rather
   * than from on-disk manifests (the remote driver has no cheap filesystem
   * access). Keyed by plugin name. An empty map means "unknown", which callers
   * must treat as "no update detected" rather than "up to date".
   */
  parseAdvertisedVersions(parsed: unknown, marketplaceName: string): Map<string, string>;
};

const claudeCode: SwitchSetupCliRules = {
  pluginManifestDir: '.claude-plugin',
  marketplaceManifestDir: '.claude-plugin',
  installArgs: (ref, scope) => ['plugin', 'install', ref, '-s', scope],
  uninstallArgs: (ref, scope) => ['plugin', 'uninstall', ref, '-s', scope],
  updateArgs: (ref, scope) => ['plugin', 'update', ref, '-s', scope],
  marketplaceRefreshArgs: (name) => ['plugin', 'marketplace', 'update', name],

  parsePluginList(parsed) {
    const list: unknown = Array.isArray(parsed)
      ? parsed
      : ((parsed as { installed?: unknown } | null)?.installed ?? []);
    if (!Array.isArray(list)) return [];
    return list.flatMap((raw) => {
      const e = raw as { id?: string; version?: string; installPath?: string };
      if (typeof e.id !== 'string') return [];
      return [{ ref: e.id, version: e.version ?? null, manifestPath: e.installPath ?? null }];
    });
  },

  parseMarketplaceList(parsed) {
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((raw) => {
      const e = raw as { name?: string; repo?: string; path?: string; installLocation?: string };
      if (typeof e.name !== 'string') return [];
      return [{ name: e.name, source: e.repo ?? e.path ?? null, root: e.installLocation ?? null }];
    });
  },

  parseAdvertisedVersions(parsed, marketplaceName) {
    if (!Array.isArray(parsed)) return new Map();
    const market = (
      parsed as Array<{ name?: string; plugins?: Array<{ name?: string; version?: string }> }>
    ).find((m) => m.name === marketplaceName);
    const versions = new Map<string, string>();
    for (const p of market?.plugins ?? []) {
      if (typeof p.name === 'string' && typeof p.version === 'string')
        versions.set(p.name, p.version);
    }
    return versions;
  },
};

/**
 * Codex's `plugin` subcommand. Verified against Codex CLI 0.145.0:
 * `add`/`remove` rather than `install`/`uninstall`, no scope flag, no per-plugin
 * update verb, `marketplace upgrade` rather than `update`, and both list
 * commands return an object rather than a bare array. Its plugin manifests live
 * under `.codex-plugin/`, but it reads a marketplace manifest from
 * `.claude-plugin/` — so one marketplace file serves both CLIs.
 */
const codex: SwitchSetupCliRules = {
  pluginManifestDir: '.codex-plugin',
  marketplaceManifestDir: '.claude-plugin',
  installArgs: (ref) => ['plugin', 'add', ref],
  uninstallArgs: (ref) => ['plugin', 'remove', ref],
  updateArgs: () => null,
  marketplaceRefreshArgs: (name) => ['plugin', 'marketplace', 'upgrade', name],

  parsePluginList(parsed) {
    const list = (parsed as { installed?: unknown } | null)?.installed;
    if (!Array.isArray(list)) return [];
    return list.flatMap((raw) => {
      const e = raw as { pluginId?: string; version?: string; source?: { path?: string } };
      if (typeof e.pluginId !== 'string') return [];
      // `source.path` is the marketplace source directory, which holds the
      // manifest; the entry's own `version` is authoritative either way.
      return [
        { ref: e.pluginId, version: e.version ?? null, manifestPath: e.source?.path ?? null },
      ];
    });
  },

  parseMarketplaceList(parsed) {
    const list = (parsed as { marketplaces?: unknown } | null)?.marketplaces;
    if (!Array.isArray(list)) return [];
    return list.flatMap((raw) => {
      const e = raw as { name?: string; root?: string; marketplaceSource?: { source?: string } };
      if (typeof e.name !== 'string') return [];
      return [{ name: e.name, source: e.marketplaceSource?.source ?? null, root: e.root ?? null }];
    });
  },

  /**
   * Codex reports a version only for plugins that are actually installed — the
   * `available` list carries none — so there is no advertised version to compare
   * against from CLI output alone. Callers get an empty map, i.e. "unknown", and
   * must not read that as "up to date".
   *
   * This only limits the remote driver. Locally, `advertisedVersion` reads the
   * marketplace's on-disk manifests instead, which works for both dialects.
   */
  parseAdvertisedVersions() {
    return new Map<string, string>();
  },
};

const RULES: Record<SwitchSetupCliDialect, SwitchSetupCliRules> = {
  'claude-code': claudeCode,
  codex,
};

export function cliRulesFor(dialect: SwitchSetupCliDialect): SwitchSetupCliRules {
  const rules = RULES[dialect];
  if (!rules) {
    // Unreachable via a validated descriptor, but a missing entry would
    // otherwise surface as an opaque "cannot read properties of undefined"
    // several frames away from the actual cause.
    throw new Error(
      `No plugin-CLI rules for dialect '${dialect}'. Add an entry to the dialect table.`
    );
  }
  return rules;
}
