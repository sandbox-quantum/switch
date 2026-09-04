import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ISwitchSetupFilesBehavior, PluginFs } from '@switch-console/core/agents/plugins';
import { resolveCommandPath } from '@switch-console/core/deps/runtime';
import { type ArtifactName, artifactVersion } from '@switch-console/shared';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { agentTypeOf } from '@main/core/telemetry/agent-type';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { log } from '@main/lib/logger';
import { isNewerVersion } from '@main/lib/semver';
import { isValidProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AgentTypeAvailability } from '@shared/core/switch-setup/agent-type-availability';
import { createPluginFs } from '../providers/plugin-fs';
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

/**
 * The version stamped into a file-based connector install, and the one it is
 * compared against.
 *
 * The connector's own artifact version, not the app's: it is versioned in its
 * own directory and listed in the registry beside the marketplace connectors,
 * so reporting the app's version here would put a number on the card that
 * matches nothing the connector declares. Keying "update available" on it also
 * means an app release that does not touch the connector no longer offers an
 * update that would rewrite the same bytes.
 */
function connectorVersion(artifact: string): string {
  return artifactVersion(artifact as ArtifactName);
}

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

  /**
   * The `files` connector behavior for an agent whose connector Switch Console
   * writes itself, or null for any other agent.
   */
  private resolveFiles(agentId: string) {
    const plugin = getPlugin(agentId);
    if (plugin.capabilities.switchSetup.kind !== 'files') return null;
    const files = plugin.behavior.switchSetup?.files;
    if (!files) {
      // A declared descriptor with no behavior cannot install anything, and
      // reporting "not installed" forever would send the user to a button that
      // silently does nothing.
      throw new Error(
        `Agent '${agentId}' declares a file-based Switch connector but implements no behavior for it.`
      );
    }
    return {
      files,
      homeFs: createPluginFs(homedir()),
      version: connectorVersion(plugin.capabilities.switchSetup.artifact),
    };
  }

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

  /**
   * Status of a file-based connector. There is no catalog to consult: the
   * connector ships inside the app, so the version its own directory declares
   * is the latest there is, and an install stamped with an older one is what
   * "update available" means here.
   */
  private async filesStatus(agentId: string): Promise<SwitchSetupStatus> {
    const resolved = this.resolveFiles(agentId);
    if (!resolved) return unsupported(agentId);
    const installedVersion = await resolved.files.installedVersion(resolved.homeFs);
    const latestVersion = resolved.version;
    return {
      agentId,
      supported: true,
      installed: installedVersion !== null,
      installedVersion,
      latestVersion,
      updateAvailable: installedVersion !== null && isNewerVersion(installedVersion, latestVersion),
      refreshError: null,
    };
  }

  /** Fast, local status read — no network/catalog refresh. */
  async getStatus(agentId: string): Promise<SwitchSetupStatus> {
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'files') {
      return this.filesStatus(agentId);
    }
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
      .filter((plugin) => plugin.capabilities.switchSetup.kind !== 'none')
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
    // A file-based connector ships inside the app, so there is no catalog to
    // refresh and the plain status read is already current.
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'files') {
      return this.filesStatus(agentId);
    }
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

  /** Install, update and uninstall for a file-based connector. */
  private async runFiles(
    agentId: string,
    action: (
      files: ISwitchSetupFilesBehavior,
      homeFs: PluginFs,
      version: string
    ) => Promise<unknown>
  ): Promise<SwitchSetupResult> {
    const resolved = this.resolveFiles(agentId);
    if (!resolved)
      return { success: false, message: 'Switch setup is not supported for this agent.' };
    try {
      await action(resolved.files, resolved.homeFs, resolved.version);
      return { success: true };
    } catch (err) {
      log.error('switch-setup: file-based connector operation failed', { agentId, err });
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async install(agentId: string): Promise<SwitchSetupResult> {
    const { result, attempted } = await this.runInstall(agentId);
    // An agent type with no connector to install did not fail to install one.
    if (attempted) {
      trackEvent('connector_installed', {
        agent_type: isValidProviderId(agentId) ? agentId : 'unknown',
        target: 'local',
        outcome: result.success ? 'success' : 'failure',
      });
    }
    return result;
  }

  private async runInstall(
    agentId: string
  ): Promise<{ result: SwitchSetupResult; attempted: boolean }> {
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'files') {
      // `runFiles` resolves the behavior outside its own try, and that throws
      // for a connector that declares files and implements none. An install the
      // user asked for must come back as a failed result either way — a
      // rejection here would skip the report and reach the UI as a stack.
      try {
        const result = await this.runFiles(agentId, (files, fs, version) =>
          files.install(fs, { version })
        );
        return { result, attempted: true };
      } catch (err) {
        return {
          result: { success: false, message: installFailureMessage(String(err)) },
          attempted: true,
        };
      }
    }
    const resolved = await this.resolve(agentId);
    if (!resolved)
      return {
        result: { success: false, message: 'Switch setup is not supported for this agent.' },
        attempted: false,
      };
    const { descriptor, bin, ref, rules } = resolved;
    try {
      await this.ensureMarketplace(
        bin,
        descriptor.marketplaceName,
        descriptor.marketplaceSource,
        rules
      );
    } catch (err) {
      return {
        result: { success: false, message: installFailureMessage(String(err)) },
        attempted: true,
      };
    }
    const res = await this.run(bin, rules.installArgs(ref, descriptor.scope));
    return {
      result:
        res.code === 0
          ? { success: true }
          : { success: false, message: installFailureMessage(res.stderr.trim()) },
      attempted: true,
    };
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
  /**
   * Update the connector, reporting the outcome.
   *
   * The "not supported" answer is not an attempt and is not reported — the same
   * distinction `install` draws with its `attempted` flag, without which every
   * agent that has no connector would look like a failing update.
   */
  async update(agentId: string): Promise<SwitchSetupResult> {
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'none') {
      return { success: false, message: 'Switch setup is not supported for this agent.' };
    }
    const { result, wasReinstall } = await this.runUpdate(agentId);
    trackEvent('connector_updated', {
      agent_type: agentTypeOf(agentId),
      target: 'local',
      outcome: result.success ? 'success' : 'failure',
      was_reinstall: wasReinstall,
    });
    return result;
  }

  /**
   * The update itself. `wasReinstall` says whether the host had a single update
   * verb or the connector had to be removed and put back — Codex has no update
   * verb, so for it every update is the second kind, with a window in between
   * where nothing is installed.
   */
  private async runUpdate(
    agentId: string
  ): Promise<{ result: SwitchSetupResult; wasReinstall: boolean }> {
    // Installing a file-based connector overwrites in place, so update is the
    // same operation — there is no removed-but-not-reinstalled window.
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'files') {
      const result = await this.runFiles(agentId, (files, fs, version) =>
        files.install(fs, { version })
      );
      // Overwritten in place: neither a verb update nor a remove-and-replace.
      return { result, wasReinstall: false };
    }
    const resolved = await this.resolve(agentId);
    if (!resolved) {
      return {
        result: { success: false, message: 'Switch setup is not supported for this agent.' },
        wasReinstall: false,
      };
    }
    const { descriptor, bin, ref, rules } = resolved;

    try {
      await this.ensureMarketplace(
        bin,
        descriptor.marketplaceName,
        descriptor.marketplaceSource,
        rules
      );
    } catch (err) {
      return {
        result: { success: false, message: `Could not add marketplace: ${String(err)}` },
        wasReinstall: false,
      };
    }

    const updateArgs = rules.updateArgs(ref, descriptor.scope);
    if (updateArgs) {
      const res = await this.run(bin, updateArgs);
      return {
        result:
          res.code === 0
            ? { success: true }
            : { success: false, message: res.stderr.trim() || 'Update failed.' },
        wasReinstall: false,
      };
    }

    const removed = await this.run(bin, rules.uninstallArgs(ref, descriptor.scope));
    if (removed.code !== 0) {
      return {
        result: {
          success: false,
          message: removed.stderr.trim() || 'Update failed: could not remove the installed plugin.',
        },
        wasReinstall: true,
      };
    }
    const added = await this.run(bin, rules.installArgs(ref, descriptor.scope));
    return {
      result:
        added.code === 0
          ? { success: true }
          : {
              success: false,
              message:
                added.stderr.trim() ||
                'Update failed: the plugin was removed but could not be reinstalled. Install it again from Settings → Agents.',
            },
      wasReinstall: true,
    };
  }

  async uninstall(agentId: string): Promise<SwitchSetupResult> {
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'none') {
      return { success: false, message: 'Switch setup is not supported for this agent.' };
    }
    const result = await this.runUninstall(agentId);
    trackEvent('connector_uninstalled', {
      agent_type: agentTypeOf(agentId),
      target: 'local',
      outcome: result.success ? 'success' : 'failure',
    });
    return result;
  }

  private async runUninstall(agentId: string): Promise<SwitchSetupResult> {
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'files') {
      return this.runFiles(agentId, (files, fs) => files.uninstall(fs));
    }
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
