import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ISwitchSetupFilesBehavior, PluginFs } from '@switch-console/core/agents/plugins';
import { resolveCommandPath } from '@switch-console/core/deps/runtime';
import { type ArtifactName, artifactVersion } from '@switch-console/shared';
import { providerAdapterRegistry } from '@main/core/agent-runtime/impl/provider-adapter-registry';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { agentTypeOf } from '@main/core/telemetry/agent-type';
import { startTimer } from '@main/core/telemetry/duration';
import type {
  TelemetryConnectorFailure,
  TelemetryConnectorUpdateTrigger,
} from '@main/core/telemetry/events';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { log } from '@main/lib/logger';
import { isNewerVersion } from '@main/lib/semver';
import type { AgentTypeAvailability } from '@shared/core/switch-setup/agent-type-availability';
import { createPluginFs } from '../providers/plugin-fs';
import { getPlugin, listPlugins } from '../providers/plugin-registry';
import {
  commandFailureCode,
  CONNECTOR_UNSUPPORTED_RESULT,
  type ConnectorRun,
  connectorFailed,
  type ConnectorRunResult,
  connectorSucceeded,
  connectorUnsupported,
  declaresNoConnector,
  EXEC_TIMEOUT_MS,
  FilesConnectorUnimplementedError,
  HostCliMissingError,
  marketplaceFailed,
  marketplaceMatchesSource,
  runReportedOperation,
  type SwitchSetupResult,
  type SwitchSetupStatus,
  unsupportedStatus,
} from './connector-run';
import {
  cliRulesFor,
  type InstalledPlugin,
  type SwitchSetupCliRules,
} from './switch-setup-cli-dialect';

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

/** A shell that cannot find the binary fails the spawn rather than the command. */
function isCommandNotFound(err: { code?: number | string }): boolean {
  return err.code === 'ENOENT';
}

/** Parse CLI JSON, yielding null rather than throwing on unparseable output. */
function parseJsonOrNull(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
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
   * writes itself.
   *
   * Every caller reaches this under a `kind === 'files'` test, so a descriptor of
   * any other kind is a programming error rather than an outcome. A declared
   * descriptor with no behavior is the one expected failure, and it gets its own
   * error class: reporting "not installed" forever would send the user to a
   * button that silently does nothing.
   *
   * Deliberately builds no filesystem. Creating one can fail for reasons that
   * have nothing to do with the plugin, and keeping it out leaves exactly one
   * thing this can throw.
   */
  private resolveFiles(agentId: string): { files: ISwitchSetupFilesBehavior; version: string } {
    const plugin = getPlugin(agentId);
    const descriptor = plugin.capabilities.switchSetup;
    if (descriptor.kind !== 'files') {
      throw new Error(`Agent '${agentId}' has no file-based Switch connector.`);
    }
    const files = plugin.behavior.switchSetup?.files;
    if (!files) throw new FilesConnectorUnimplementedError(agentId);
    return { files, version: connectorVersion(descriptor.artifact) };
  }

  /** The filesystem a file-based connector is written to on this computer. */
  private homeFs(): PluginFs {
    return createPluginFs(homedir());
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
  private async run(bin: string, args: string[]): Promise<ConnectorRunResult> {
    try {
      const { stdout, stderr } = await this.ctx.exec(bin, args, { timeout: EXEC_TIMEOUT_MS });
      return { code: 0, stdout, stderr, notFound: false };
    } catch (err: unknown) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        message?: string;
      };
      return {
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? '',
        notFound: isCommandNotFound(e),
      };
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
    const listed = await this.run(bin, ['plugin', 'marketplace', 'list', '--json']);
    // No binary means no marketplace to repair and no plugin to install; every
    // command after this one would fail the same way. Said here so the caller
    // does not have to read it off whichever verb happened to run first.
    if (listed.notFound) throw new HostCliMissingError(bin);
    // An unreadable listing yields no entries; the add below is idempotent, so
    // attempting it is safer than treating an unparseable listing as fatal.
    const existing = rules
      .parseMarketplaceList(parseJsonOrNull(listed.stdout))
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
    const { files, version: latestVersion } = this.resolveFiles(agentId);
    const installedVersion = await files.installedVersion(this.homeFs());
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
    if (!resolved) return unsupportedStatus(agentId);
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

  /** Local provider availability, including Console-managed SDK sessions. */
  async listAgentTypeAvailability(): Promise<AgentTypeAvailability[]> {
    const types = listPlugins()
      .filter(
        (plugin) =>
          plugin.capabilities.switchSetup.kind !== 'none' ||
          ['antigravity', 'cursor'].includes(plugin.metadata.id)
      )
      .map((plugin) => plugin.metadata.id);

    const availability: AgentTypeAvailability[] = [];
    for (const agentId of types) {
      if (process.platform === 'win32' || !providerAdapterRegistry.supports(agentId)) {
        availability.push({
          agentId,
          available: false,
          blockedReason:
            process.platform === 'win32'
              ? 'SDK sessions require a POSIX SSH execution host.'
              : 'This provider has no SDK session adapter.',
        });
        continue;
      }

      if (agentId === 'antigravity' || agentId === 'cursor') {
        const cursor = agentId === 'cursor';
        const installed = await resolveCommandPath(cursor ? 'agent' : 'antigravity-acp', this.ctx);
        availability.push({
          agentId,
          available: Boolean(installed),
          blockedReason: installed
            ? null
            : cursor
              ? 'Install Cursor CLI on this computer to use ACP sessions.'
              : 'Install Antigravity ACP on this computer to use SDK sessions.',
        });
        continue;
      }
      // One plugin whose status cannot be read must not empty the list: this
      // fans out over every agent type, and the picker showing nothing at all
      // is a worse answer than one row saying why it is unavailable.
      let status: SwitchSetupStatus;
      try {
        status = await this.getStatus(agentId);
      } catch (err) {
        log.error('switch-setup: could not read connector status', { agentId, err });
        availability.push({
          agentId,
          available: false,
          blockedReason: `Its Switch connector status could not be read: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        continue;
      }
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
    if (!resolved) return unsupportedStatus(agentId);
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

  /**
   * Install, update and uninstall for a file-based connector.
   *
   * `failure` is the caller's, because the two sides of the operation are
   * different walls: a write that could not land and a removal that could not
   * are as distinct here as `install_command_failed` and
   * `uninstall_command_failed` are on the marketplace path.
   *
   * Only a plugin that declares files and implements none is caught as
   * `files_unimplemented`. Anything else resolving throws is a fault somewhere
   * other than the plugin, and saying "this connector ships no behavior" about it
   * would be a claim about the app derived from, say, a dead SSH channel. Those
   * propagate to the entry point, which reports them as `error`.
   */
  private async runFiles(
    agentId: string,
    failure: TelemetryConnectorFailure,
    action: (
      files: ISwitchSetupFilesBehavior,
      homeFs: PluginFs,
      version: string
    ) => Promise<unknown>
  ): Promise<ConnectorRun> {
    let resolved: { files: ISwitchSetupFilesBehavior; version: string };
    try {
      resolved = this.resolveFiles(agentId);
    } catch (err) {
      if (!(err instanceof FilesConnectorUnimplementedError)) throw err;
      log.error('switch-setup: file-based connector declares no behavior', { agentId, err });
      return connectorFailed(err.message, 'files_unimplemented');
    }
    try {
      await action(resolved.files, this.homeFs(), resolved.version);
      return connectorSucceeded();
    } catch (err) {
      log.error('switch-setup: file-based connector operation failed', { agentId, err });
      return connectorFailed(err instanceof Error ? err.message : String(err), failure);
    }
  }

  /**
   * Install the connector, reporting the outcome.
   *
   * Everything past the `declaresNoConnector` guard is an attempt a person made
   * and is reported, `unsupported` included: a `cli` descriptor whose binary
   * cannot be resolved is a real failure of the thing the user asked for.
   */
  async install(agentId: string): Promise<SwitchSetupResult> {
    if (declaresNoConnector(agentId)) return CONNECTOR_UNSUPPORTED_RESULT;
    const elapsed = startTimer();
    const run = await runReportedOperation('switch-setup', agentId, () => this.runInstall(agentId));
    trackEvent('connector_installed', {
      agent_type: agentTypeOf(agentId),
      target: 'local',
      outcome: run.result.success ? 'success' : 'failure',
      failure_reason: run.failure,
      duration_ms: elapsed(),
    });
    return run.result;
  }

  private async runInstall(agentId: string): Promise<ConnectorRun> {
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'files') {
      return this.runFiles(agentId, 'files_write_failed', (files, fs, version) =>
        files.install(fs, { version })
      );
    }
    const resolved = await this.resolve(agentId);
    if (!resolved) return connectorUnsupported();
    const { descriptor, bin, ref, rules } = resolved;
    try {
      await this.ensureMarketplace(
        bin,
        descriptor.marketplaceName,
        descriptor.marketplaceSource,
        rules
      );
    } catch (err) {
      return marketplaceFailed(err, installFailureMessage(String(err)));
    }
    const res = await this.run(bin, rules.installArgs(ref, descriptor.scope));
    return res.code === 0
      ? connectorSucceeded()
      : connectorFailed(
          installFailureMessage(res.stderr.trim()),
          commandFailureCode(res, 'install_command_failed')
        );
  }

  /**
   * Update the connector, reporting the outcome.
   *
   * Dialects without a per-plugin update verb (Codex) are updated by
   * uninstalling and reinstalling; a failed reinstall is reported as such rather
   * than as a plain update failure, because it leaves the agent with no
   * connector rather than with the previous version.
   *
   * The marketplace is repaired first, exactly as `install` does. The re-add
   * resolves against whatever marketplace is registered, so a stale source would
   * otherwise fail it — after the uninstall has already succeeded.
   *
   * `trigger` is required rather than defaulted: the once-per-install catch-up
   * reaches this through the same door as the Update button, and a default would
   * quietly file it as whichever of the two the default happened to be.
   */
  async update(
    agentId: string,
    trigger: TelemetryConnectorUpdateTrigger
  ): Promise<SwitchSetupResult> {
    if (declaresNoConnector(agentId)) return CONNECTOR_UNSUPPORTED_RESULT;
    const elapsed = startTimer();
    const { run, wasReinstall } = await this.runUpdateReported(agentId);
    trackEvent('connector_updated', {
      agent_type: agentTypeOf(agentId),
      target: 'local',
      outcome: run.result.success ? 'success' : 'failure',
      was_reinstall: wasReinstall,
      trigger,
      failure_reason: run.failure,
      duration_ms: elapsed(),
    });
    return run.result;
  }

  /**
   * `runUpdate` with the guarantee the other two entry points get from
   * `runReportedOperation`: it always comes back as a result rather than
   * rejecting.
   *
   * `wasReinstall` is false when it throws. Everything that can throw here runs
   * before the remove-then-add — resolving the binary, building a filesystem —
   * so a throw means nothing was removed, which is exactly what the flag says.
   */
  private async runUpdateReported(
    agentId: string
  ): Promise<{ run: ConnectorRun; wasReinstall: boolean }> {
    let wasReinstall = false;
    const run = await runReportedOperation('switch-setup', agentId, async () => {
      const outcome = await this.runUpdate(agentId);
      wasReinstall = outcome.wasReinstall;
      return outcome.run;
    });
    return { run, wasReinstall };
  }

  /**
   * The update itself. `wasReinstall` says whether the host had a single update
   * verb or the connector had to be removed and put back — Codex has no update
   * verb, so for it every update is the second kind, with a window in between
   * where nothing is installed.
   */
  private async runUpdate(agentId: string): Promise<{ run: ConnectorRun; wasReinstall: boolean }> {
    // Installing a file-based connector overwrites in place, so update is the
    // same operation — there is no removed-but-not-reinstalled window.
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'files') {
      const run = await this.runFiles(agentId, 'files_write_failed', (files, fs, version) =>
        files.install(fs, { version })
      );
      // Overwritten in place: neither a verb update nor a remove-and-replace.
      return { run, wasReinstall: false };
    }
    const resolved = await this.resolve(agentId);
    if (!resolved) return { run: connectorUnsupported(), wasReinstall: false };
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
        run: marketplaceFailed(err, `Could not add marketplace: ${String(err)}`),
        wasReinstall: false,
      };
    }

    const updateArgs = rules.updateArgs(ref, descriptor.scope);
    if (updateArgs) {
      const res = await this.run(bin, updateArgs);
      return {
        run:
          res.code === 0
            ? connectorSucceeded()
            : connectorFailed(
                res.stderr.trim() || 'Update failed.',
                commandFailureCode(res, 'update_command_failed')
              ),
        wasReinstall: false,
      };
    }

    const removed = await this.run(bin, rules.uninstallArgs(ref, descriptor.scope));
    if (removed.code !== 0) {
      return {
        run: connectorFailed(
          removed.stderr.trim() || 'Update failed: could not remove the installed plugin.',
          commandFailureCode(removed, 'uninstall_command_failed')
        ),
        wasReinstall: true,
      };
    }
    const added = await this.run(bin, rules.installArgs(ref, descriptor.scope));
    return {
      run:
        added.code === 0
          ? connectorSucceeded()
          : connectorFailed(
              added.stderr.trim() ||
                'Update failed: the plugin was removed but could not be reinstalled. Install it again from Settings → Agents.',
              commandFailureCode(added, 'install_command_failed')
            ),
      wasReinstall: true,
    };
  }

  async uninstall(agentId: string): Promise<SwitchSetupResult> {
    if (declaresNoConnector(agentId)) return CONNECTOR_UNSUPPORTED_RESULT;
    const elapsed = startTimer();
    const run = await runReportedOperation('switch-setup', agentId, () =>
      this.runUninstall(agentId)
    );
    trackEvent('connector_uninstalled', {
      agent_type: agentTypeOf(agentId),
      target: 'local',
      outcome: run.result.success ? 'success' : 'failure',
      failure_reason: run.failure,
      duration_ms: elapsed(),
    });
    return run.result;
  }

  private async runUninstall(agentId: string): Promise<ConnectorRun> {
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'files') {
      return this.runFiles(agentId, 'files_remove_failed', (files, fs) => files.uninstall(fs));
    }
    const resolved = await this.resolve(agentId);
    if (!resolved) return connectorUnsupported();
    const { descriptor, bin, ref, rules } = resolved;
    const res = await this.run(bin, rules.uninstallArgs(ref, descriptor.scope));
    return res.code === 0
      ? connectorSucceeded()
      : connectorFailed(
          res.stderr.trim() || 'Uninstall failed.',
          commandFailureCode(res, 'uninstall_command_failed')
        );
  }
}

export const switchSetupService = new SwitchSetupService();
