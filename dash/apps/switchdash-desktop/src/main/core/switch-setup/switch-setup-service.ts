import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCommandPath } from '@switchdash/core/deps/runtime';
import semver from 'semver';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { log } from '@main/lib/logger';
import { getPlugin, listPlugins } from '../providers/plugin-registry';

/** Status of an agent type's Switch connector plugin. */
export type SwitchSetupStatus = {
  agentId: string;
  /** False when the agent type declares no Switch setup (kind: 'none'). */
  supported: boolean;
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /**
   * Set when a checkForUpdates marketplace refresh failed: the returned
   * versions come from the stale local cache, not the source. Always null on
   * plain getStatus reads.
   */
  refreshError: string | null;
};

/** Marketplace entry shape from `plugin marketplace list --json`. */
export type MarketplaceListEntry = {
  name?: string;
  source?: string;
  repo?: string;
  path?: string;
  installLocation?: string;
};

/** Whether a registered marketplace entry points at the expected source (repo or path). */
export function marketplaceMatchesSource(entry: MarketplaceListEntry, source: string): boolean {
  return entry.repo === source || entry.path === source;
}

/** Outcome of a mutating operation, mirroring the providers controller shape. */
export type SwitchSetupResult = { success: boolean; message?: string };

const EXEC_TIMEOUT_MS = 120_000;

type RunResult = { code: number; stdout: string; stderr: string };

function unsupported(agentId: string): SwitchSetupStatus {
  return {
    agentId,
    supported: false,
    installed: false,
    installedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    refreshError: null,
  };
}

function isNewerVersion(installed: string, latest: string): boolean {
  const a = semver.coerce(installed);
  const b = semver.coerce(latest);
  if (a === null || b === null) return false;
  return semver.gt(b, a);
}

/**
 * Drives an agent's plugin-marketplace CLI (the Claude-Code model:
 * `<bin> plugin install/update/uninstall`, `<bin> plugin marketplace add/update/list`)
 * to manage that agent's Switch connector plugin. Status reads are local and fast;
 * the marketplace refresh used for update detection runs only on checkForUpdates.
 */
class SwitchSetupService {
  private readonly ctx = new LocalExecutionContext();

  /** Returns the `cli` descriptor + agent binary, or null when unsupported/unresolvable. */
  private async resolve(agentId: string) {
    const plugin = getPlugin(agentId);
    const descriptor = plugin.capabilities.switchSetup;
    if (descriptor.kind !== 'cli') return null;
    const binaryName = plugin.capabilities.hostDependency.binaryNames[0];
    if (!binaryName) return null;
    const bin = (await resolveCommandPath(binaryName, this.ctx)) ?? binaryName;
    const ref = `${descriptor.pluginName}@${descriptor.marketplaceName}`;
    return { descriptor, bin, ref };
  }

  /** Run a CLI command, capturing output and exit code without throwing. */
  private async run(bin: string, args: string[]): Promise<RunResult> {
    try {
      const { stdout, stderr } = await this.ctx.exec(bin, args, { timeout: EXEC_TIMEOUT_MS });
      return { code: 0, stdout, stderr };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
    }
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /** Find the installed plugin entry from `plugin list --json` (array or {installed}). */
  private async findInstalled(bin: string, ref: string) {
    const { stdout } = await this.run(bin, ['plugin', 'list', '--json']);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }
    const list: Array<{ id?: string; version?: string; installPath?: string }> = Array.isArray(
      parsed
    )
      ? parsed
      : (((parsed as { installed?: unknown[] })?.installed ?? []) as never[]);
    return list.find((p) => p.id === ref) ?? null;
  }

  /** Read the true installed version from the install dir's plugin.json (robust). */
  private async installedVersion(
    entry: { version?: string; installPath?: string } | null
  ): Promise<string | null> {
    if (!entry) return null;
    if (entry.installPath) {
      const manifest = await this.readJson<{ version?: string }>(
        join(entry.installPath, '.claude-plugin', 'plugin.json')
      );
      if (manifest?.version) return manifest.version;
    }
    return entry.version ?? null;
  }

  /** Read the marketplace-advertised plugin version from the local marketplace cache. */
  private async advertisedVersion(
    bin: string,
    marketplaceName: string,
    pluginName: string
  ): Promise<string | null> {
    const { stdout } = await this.run(bin, ['plugin', 'marketplace', 'list', '--json']);
    let markets: Array<{ name?: string; installLocation?: string }>;
    try {
      markets = JSON.parse(stdout);
    } catch {
      return null;
    }
    const market = markets.find((m) => m.name === marketplaceName);
    if (!market?.installLocation) return null;
    const manifest = await this.readJson<{ plugins?: Array<{ name?: string; source?: string }> }>(
      join(market.installLocation, '.claude-plugin', 'marketplace.json')
    );
    const entry = manifest?.plugins?.find((p) => p.name === pluginName);
    if (!entry?.source) return null;
    const pluginManifest = await this.readJson<{ version?: string }>(
      join(market.installLocation, entry.source, '.claude-plugin', 'plugin.json')
    );
    return pluginManifest?.version ?? null;
  }

  /**
   * Ensure the marketplace is registered AND points at the expected source.
   * A same-named marketplace registered against a different source (e.g. a
   * pre-migration repo) is removed and re-added so update checks read the
   * current source rather than a stale one.
   */
  private async ensureMarketplace(
    bin: string,
    marketplaceName: string,
    marketplaceSource: string
  ): Promise<void> {
    const { stdout } = await this.run(bin, ['plugin', 'marketplace', 'list', '--json']);
    try {
      const markets: MarketplaceListEntry[] = JSON.parse(stdout);
      const existing = markets.find((m) => m.name === marketplaceName);
      if (existing) {
        if (marketplaceMatchesSource(existing, marketplaceSource)) return;
        log.warn('switch-setup: re-pointing marketplace to current source', {
          marketplaceName,
          from: existing.repo ?? existing.path ?? null,
          to: marketplaceSource,
        });
        const removed = await this.run(bin, ['plugin', 'marketplace', 'remove', marketplaceName]);
        if (removed.code !== 0) {
          throw new Error(
            removed.stderr.trim() || `Failed to remove stale marketplace ${marketplaceName}`
          );
        }
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        // Unparseable list output — fall through and attempt to add.
      } else {
        throw err;
      }
    }
    const res = await this.run(bin, ['plugin', 'marketplace', 'add', marketplaceSource]);
    if (res.code !== 0 && !/already|exists/i.test(res.stderr)) {
      throw new Error(res.stderr.trim() || `Failed to add marketplace ${marketplaceName}`);
    }
  }

  /** Fast, local status read — no network/catalog refresh. */
  async getStatus(agentId: string): Promise<SwitchSetupStatus> {
    const resolved = await this.resolve(agentId);
    if (!resolved) return unsupported(agentId);
    const { descriptor, bin } = resolved;

    const entry = await this.findInstalled(bin, resolved.ref);
    const installedVersion = await this.installedVersion(entry);
    const latestVersion = await this.advertisedVersion(
      bin,
      descriptor.marketplaceName,
      descriptor.pluginName
    );
    const installed = entry !== null;
    const updateAvailable =
      installed && installedVersion !== null && latestVersion !== null
        ? isNewerVersion(installedVersion, latestVersion)
        : false;

    return {
      agentId,
      supported: true,
      installed,
      installedVersion,
      latestVersion,
      updateAvailable,
      refreshError: null,
    };
  }

  /**
   * Agent types that are usable in Switch right now: Switch-supported (a `cli`
   * descriptor) AND with their connector plugin already installed. Drives the
   * onboarding agent-type picker, which only offers ready-to-use types.
   */
  async listOnboardable(): Promise<{ agentId: string }[]> {
    const onboardable: { agentId: string }[] = [];
    for (const plugin of listPlugins()) {
      if (plugin.capabilities.switchSetup.kind !== 'cli') continue;
      const status = await this.getStatus(plugin.metadata.id);
      if (status.installed) onboardable.push({ agentId: plugin.metadata.id });
    }
    return onboardable;
  }

  /**
   * Refresh the marketplace catalog, then recompute status (the network step).
   * A failed refresh does not throw — the returned status carries the cached
   * versions with `refreshError` set so the UI can disclose the staleness.
   */
  async checkForUpdates(agentId: string): Promise<SwitchSetupStatus> {
    const resolved = await this.resolve(agentId);
    if (!resolved) return unsupported(agentId);
    const { descriptor, bin } = resolved;
    let refreshError: string | null = null;
    try {
      await this.ensureMarketplace(bin, descriptor.marketplaceName, descriptor.marketplaceSource);
      const res = await this.run(bin, [
        'plugin',
        'marketplace',
        'update',
        descriptor.marketplaceName,
      ]);
      if (res.code !== 0) {
        throw new Error(
          res.stderr.trim() || `Failed to update marketplace ${descriptor.marketplaceName}`
        );
      }
    } catch (err) {
      log.warn('switch-setup: marketplace refresh failed', { agentId, err });
      refreshError = err instanceof Error ? err.message : String(err);
    }
    return { ...(await this.getStatus(agentId)), refreshError };
  }

  async install(agentId: string): Promise<SwitchSetupResult> {
    const resolved = await this.resolve(agentId);
    if (!resolved)
      return { success: false, message: 'Switch setup is not supported for this agent.' };
    const { descriptor, bin, ref } = resolved;
    try {
      await this.ensureMarketplace(bin, descriptor.marketplaceName, descriptor.marketplaceSource);
    } catch (err) {
      return { success: false, message: `Could not add marketplace: ${String(err)}` };
    }
    const res = await this.run(bin, ['plugin', 'install', ref, '-s', descriptor.scope]);
    return res.code === 0
      ? { success: true }
      : { success: false, message: res.stderr.trim() || 'Install failed.' };
  }

  async update(agentId: string): Promise<SwitchSetupResult> {
    const resolved = await this.resolve(agentId);
    if (!resolved)
      return { success: false, message: 'Switch setup is not supported for this agent.' };
    const { descriptor, bin, ref } = resolved;
    const res = await this.run(bin, ['plugin', 'update', ref, '-s', descriptor.scope]);
    return res.code === 0
      ? { success: true }
      : { success: false, message: res.stderr.trim() || 'Update failed.' };
  }

  async uninstall(agentId: string): Promise<SwitchSetupResult> {
    const resolved = await this.resolve(agentId);
    if (!resolved)
      return { success: false, message: 'Switch setup is not supported for this agent.' };
    const { descriptor, bin, ref } = resolved;
    const res = await this.run(bin, ['plugin', 'uninstall', ref, '-s', descriptor.scope]);
    return res.code === 0
      ? { success: true }
      : { success: false, message: res.stderr.trim() || 'Uninstall failed.' };
  }
}

export const switchSetupService = new SwitchSetupService();
