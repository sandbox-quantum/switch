import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCommandPath } from '@switch-console/core/deps/runtime';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { log } from '@main/lib/logger';
import { isNewerVersion } from '@main/lib/semver';
import type { AgentTypeAvailability } from '@shared/core/switch-setup/agent-type-availability';
import { getPlugin, listPlugins } from '../providers/plugin-registry';
import {
  cliRulesFor,
  type InstalledPlugin,
  type RegisteredMarketplace,
  type SwitchSetupCliRules,
} from './switch-setup-cli-dialect';

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

/** Whether a registered marketplace entry points at the expected source. */
export function marketplaceMatchesSource(entry: RegisteredMarketplace, source: string): boolean {
  return entry.source === source;
}

/** Outcome of a mutating operation, mirroring the providers controller shape. */
export type SwitchSetupResult = { success: boolean; message?: string };

const EXEC_TIMEOUT_MS = 120_000;

/** A CLI failure with no stderr still needs to say something. */
function installFailureMessage(raw: string): string {
  return raw || 'Install failed.';
}

type RunResult = { code: number; stdout: string; stderr: string };

/** Parse CLI JSON, yielding null rather than throwing on unparseable output. */
function parseJsonOrNull(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

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

/**
 * Drives an agent's plugin-marketplace CLI (`<bin> plugin ...`,
 * `<bin> plugin marketplace ...`) to manage that agent's Switch connector
 * plugin. The verbs, flags and JSON shapes differ per host, so everything
 * host-specific comes from the dialect in `switch-setup-cli-dialect.ts` and this
 * driver stays generic across Claude Code and Codex. Status reads are local and
 * fast; the marketplace refresh used for update detection runs only on
 * checkForUpdates.
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
    return { descriptor, bin, ref, rules: cliRulesFor(descriptor.dialect) };
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

  /** Find the installed plugin entry from `plugin list --json`. */
  private async findInstalled(
    bin: string,
    ref: string,
    rules: SwitchSetupCliRules
  ): Promise<InstalledPlugin | null> {
    const { stdout } = await this.run(bin, ['plugin', 'list', '--json']);
    return rules.parsePluginList(parseJsonOrNull(stdout)).find((p) => p.ref === ref) ?? null;
  }

  /** Read the true installed version from the plugin manifest, falling back to the CLI's. */
  private async installedVersion(
    entry: InstalledPlugin | null,
    rules: SwitchSetupCliRules
  ): Promise<string | null> {
    if (!entry) return null;
    if (entry.manifestPath) {
      const manifest = await this.readJson<{ version?: string }>(
        join(entry.manifestPath, rules.pluginManifestDir, 'plugin.json')
      );
      if (manifest?.version) return manifest.version;
    }
    return entry.version ?? null;
  }

  /** Read the marketplace-advertised plugin version from the local marketplace cache. */
  private async advertisedVersion(
    bin: string,
    marketplaceName: string,
    pluginName: string,
    rules: SwitchSetupCliRules
  ): Promise<string | null> {
    const { stdout } = await this.run(bin, ['plugin', 'marketplace', 'list', '--json']);
    const market = rules
      .parseMarketplaceList(parseJsonOrNull(stdout))
      .find((m) => m.name === marketplaceName && m.root !== null);
    if (!market?.root) return null;
    const manifest = await this.readJson<{ plugins?: Array<{ name?: string; source?: string }> }>(
      join(market.root, rules.marketplaceManifestDir, 'marketplace.json')
    );
    const entry = manifest?.plugins?.find((p) => p.name === pluginName);
    if (!entry?.source) return null;
    const pluginManifest = await this.readJson<{ version?: string }>(
      join(market.root, entry.source, rules.pluginManifestDir, 'plugin.json')
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
    marketplaceSource: string,
    rules: SwitchSetupCliRules
  ): Promise<void> {
    const { stdout } = await this.run(bin, ['plugin', 'marketplace', 'list', '--json']);
    // An unreadable listing yields no entries; the add below is idempotent, so
    // attempting it is safer than treating an unparseable listing as fatal.
    const existing = rules
      .parseMarketplaceList(parseJsonOrNull(stdout))
      .find((m) => m.name === marketplaceName);
    if (existing) {
      if (marketplaceMatchesSource(existing, marketplaceSource)) return;
      log.warn('switch-setup: re-pointing marketplace to current source', {
        marketplaceName,
        from: existing.source,
        to: marketplaceSource,
      });
      const removed = await this.run(bin, ['plugin', 'marketplace', 'remove', marketplaceName]);
      if (removed.code !== 0) {
        throw new Error(
          removed.stderr.trim() || `Failed to remove stale marketplace ${marketplaceName}`
        );
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
    const { descriptor, bin, rules } = resolved;

    const entry = await this.findInstalled(bin, resolved.ref, rules);
    const installedVersion = await this.installedVersion(entry, rules);
    const latestVersion = await this.advertisedVersion(
      bin,
      descriptor.marketplaceName,
      descriptor.pluginName,
      rules
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
  /**
   * Agent types that can actually be onboarded on this machine — those whose
   * Switch connector plugin is installed.
   */
  async listAgentTypeAvailability(): Promise<AgentTypeAvailability[]> {
    const types = listPlugins()
      .filter((plugin) => plugin.capabilities.switchSetup.kind === 'cli')
      .map((plugin) => plugin.metadata.id);

    const availability: AgentTypeAvailability[] = [];
    for (const agentId of types) {
      const status = await this.getStatus(agentId);
      availability.push(
        status.installed
          ? { agentId, available: true, blockedReason: null }
          : {
              agentId,
              available: false,
              blockedReason: 'Its Switch connector is not installed on this computer.',
            }
      );
    }
    return availability;
  }

  /**
   * Refresh the marketplace catalog, then recompute status (the network step).
   * A failed refresh does not throw — the returned status carries the cached
   * versions with `refreshError` set so the UI can disclose the staleness.
   */
  async checkForUpdates(agentId: string): Promise<SwitchSetupStatus> {
    const resolved = await this.resolve(agentId);
    if (!resolved) return unsupported(agentId);
    const { descriptor, bin, rules } = resolved;
    let refreshError: string | null = null;
    try {
      await this.ensureMarketplace(
        bin,
        descriptor.marketplaceName,
        descriptor.marketplaceSource,
        rules
      );
      const res = await this.run(bin, rules.marketplaceRefreshArgs(descriptor.marketplaceName));
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
    const { descriptor, bin, ref, rules } = resolved;
    try {
      await this.ensureMarketplace(
        bin,
        descriptor.marketplaceName,
        descriptor.marketplaceSource,
        rules
      );
    } catch (err) {
      return { success: false, message: installFailureMessage(String(err)) };
    }
    const res = await this.run(bin, rules.installArgs(ref, descriptor.scope));
    return res.code === 0
      ? { success: true }
      : { success: false, message: installFailureMessage(res.stderr.trim()) };
  }

  /**
   * Update the installed plugin. Dialects without a per-plugin update verb
   * (Codex) are updated by uninstalling and reinstalling; a failed reinstall is
   * reported as such rather than as a plain update failure, because it leaves
   * the agent with no connector rather than with the previous version.
   *
   * The marketplace is repaired first, exactly as `install` does. The re-add
   * resolves against whatever marketplace is registered, so a stale source would
   * otherwise fail it — after the uninstall has already succeeded.
   */
  async update(agentId: string): Promise<SwitchSetupResult> {
    const resolved = await this.resolve(agentId);
    if (!resolved)
      return { success: false, message: 'Switch setup is not supported for this agent.' };
    const { descriptor, bin, ref, rules } = resolved;

    try {
      await this.ensureMarketplace(
        bin,
        descriptor.marketplaceName,
        descriptor.marketplaceSource,
        rules
      );
    } catch (err) {
      return { success: false, message: `Could not add marketplace: ${String(err)}` };
    }

    const updateArgs = rules.updateArgs(ref, descriptor.scope);
    if (updateArgs) {
      const res = await this.run(bin, updateArgs);
      return res.code === 0
        ? { success: true }
        : { success: false, message: res.stderr.trim() || 'Update failed.' };
    }

    const removed = await this.run(bin, rules.uninstallArgs(ref, descriptor.scope));
    if (removed.code !== 0) {
      return {
        success: false,
        message: removed.stderr.trim() || 'Update failed: could not remove the installed plugin.',
      };
    }
    const added = await this.run(bin, rules.installArgs(ref, descriptor.scope));
    return added.code === 0
      ? { success: true }
      : {
          success: false,
          message:
            added.stderr.trim() ||
            'Update failed: the plugin was removed but could not be reinstalled. Install it again from Settings → Agents.',
        };
  }

  async uninstall(agentId: string): Promise<SwitchSetupResult> {
    const resolved = await this.resolve(agentId);
    if (!resolved)
      return { success: false, message: 'Switch setup is not supported for this agent.' };
    const { descriptor, bin, ref, rules } = resolved;
    const res = await this.run(bin, rules.uninstallArgs(ref, descriptor.scope));
    return res.code === 0
      ? { success: true }
      : { success: false, message: res.stderr.trim() || 'Uninstall failed.' };
  }
}

export const switchSetupService = new SwitchSetupService();
