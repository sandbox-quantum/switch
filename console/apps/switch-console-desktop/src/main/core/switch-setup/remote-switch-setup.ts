import type { ISwitchSetupFilesBehavior, PluginFs } from '@switch-console/core/agents/plugins';
import { resolveCommandPath } from '@switch-console/core/deps/runtime';
import { type ArtifactName, artifactVersion } from '@switch-console/shared';
import { createRemoteHomePluginFs } from '@main/core/agent-runtime/impl/remote-home-plugin-fs';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { agentTypeOf } from '@main/core/telemetry/agent-type';
import { startTimer } from '@main/core/telemetry/duration';
import type {
  TelemetryConnectorFailure,
  TelemetryConnectorUpdateTrigger,
} from '@main/core/telemetry/events';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { log } from '@main/lib/logger';
import { isNewerVersion } from '@main/lib/semver';
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

/** POSIX shells use 127 for "command not found". */
const COMMAND_NOT_FOUND = 127;

/**
 * The version stamped into a file-based connector install — the connector's own
 * artifact version, on a remote host exactly as locally, so the two report the
 * same number for the same connector.
 *
 * Takes the artifact rather than the agent id, matching the local helper of the
 * same name: two functions that share a name, both taking a `string`, and
 * disagreeing about which string is how a call site copied between the drivers
 * compiles and silently versions the wrong thing.
 */
function connectorVersion(artifact: string): string {
  return artifactVersion(artifact as ArtifactName);
}

/**
 * Join path segments for the remote host, which is POSIX regardless of what
 * Switch Console is running on. `node:path`'s `join` would emit backslashes on a
 * Windows desktop and the `cat` would fail on the host.
 */
function posixJoin(...segments: string[]): string {
  return segments
    .map((segment, index) =>
      index === 0 ? segment.replace(/\/+$/, '') : segment.replace(/^\/+|\/+$/g, '')
    )
    .filter((segment) => segment.length > 0)
    .join('/');
}

/**
 * Parse JSON from remote CLI stdout that may be wrapped in login-shell noise
 * (MOTD, profile banners, tunnel warnings, trailing prompt text). The remote
 * shell profile can emit such text around the command output; version probes
 * tolerate it via regex, but JSON.parse does not — so slice from the first
 * bracket to the last matching one before parsing. Returns null on failure.
 */
function parseJsonLoose(stdout: string): unknown {
  // Fast path: already-clean JSON.
  try {
    return JSON.parse(stdout);
  } catch {
    // Fall through to noise-tolerant parsing.
  }
  const end = Math.max(stdout.lastIndexOf(']'), stdout.lastIndexOf('}'));
  if (end === -1) return null;
  // Try each opening bracket as a candidate start (to the last closing bracket).
  // This tolerates leading banner lines even when a banner itself contains
  // brackets, since only a real JSON start parses cleanly.
  for (let i = 0; i <= end; i++) {
    const c = stdout[i];
    if (c !== '[' && c !== '{') continue;
    try {
      return JSON.parse(stdout.slice(i, end + 1));
    } catch {
      // Not this start; keep looking.
    }
  }
  return null;
}

/**
 * Remote counterpart of SwitchSetupService: drives an agent type's
 * plugin-marketplace CLI (`<bin> plugin ...`) on an SSH host to manage its
 * Switch connector plugin, taking the host's verbs, flags and JSON shapes from
 * the same dialect table the local driver uses.
 *
 * Advertised versions come from the CLI's JSON where the dialect reports them,
 * and otherwise from the marketplace's on-disk manifests — the same two files
 * the local driver reads, fetched with `cat` over the exec channel already
 * open. This used to stop at the CLI output, so Codex — whose marketplace
 * listing carries no plugin versions — could never report an available update
 * on a remote host, even though the manifests were sitting there.
 */
export class RemoteSwitchSetupService {
  constructor(private readonly ctx: SshExecutionContext) {}

  /**
   * The `files` connector behavior for an agent whose connector Switch Console
   * writes itself. Mirrors the local driver: callers reach it only under a
   * `kind === 'files'` test, a plugin that declares files and implements none is
   * the one expected failure, and no filesystem is built here — on this side
   * that matters more, because building one can fail on a dead SSH channel and
   * that is not a fault in the plugin.
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

  /** The filesystem a file-based connector is written to on this host. */
  private homeFs(): PluginFs {
    return createRemoteHomePluginFs(this.ctx);
  }

  private async resolve(agentId: string) {
    const plugin = getPlugin(agentId);
    const descriptor = plugin.capabilities.switchSetup;
    if (descriptor.kind !== 'cli') return null;
    const binaryName = plugin.capabilities.hostDependency.binaryNames[0];
    if (!binaryName) return null;
    const bin = (await resolveCommandPath(binaryName, this.ctx)) ?? binaryName;
    const ref = `${descriptor.pluginName}@${descriptor.marketplaceName}`;
    return {
      descriptor,
      bin,
      ref,
      marketplaceSource: descriptor.marketplaceSource,
      rules: cliRulesFor(descriptor.dialect),
    };
  }

  private async run(bin: string, args: string[]): Promise<ConnectorRunResult> {
    try {
      const { stdout, stderr } = await this.ctx.exec(bin, args, { timeout: EXEC_TIMEOUT_MS });
      return { code: 0, stdout, stderr, notFound: false };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      const code = e.code ?? 1;
      const result = {
        code,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? '',
        notFound: code === COMMAND_NOT_FOUND,
      };
      // A shell reports 127 when the binary is not on PATH. For "is this agent
      // type's connector installed?" that is the answer, not a fault: a host
      // without Codex is a normal host. Warning about it filled the log with
      // failures every time a plan was checked, which trains people to ignore
      // the warnings that do matter.
      if (result.code === COMMAND_NOT_FOUND) {
        log.info('[remote-switch-setup] command not present on host', {
          cmd: `${bin} ${args.join(' ')}`,
        });
        return result;
      }
      log.warn('[remote-switch-setup] command failed', {
        cmd: `${bin} ${args.join(' ')}`,
        code: result.code,
        stderr: result.stderr.slice(0, 1000),
      });
      return result;
    }
  }

  private async findInstalled(bin: string, ref: string, rules: SwitchSetupCliRules) {
    const { stdout } = await this.run(bin, ['plugin', 'list', '--json']);
    return rules.parsePluginList(parseJsonLoose(stdout)).find((p) => p.ref === ref) ?? null;
  }

  /**
   * Read the true installed version from the plugin manifest on the host,
   * falling back to the CLI's.
   *
   * The same two sources the local driver reads, in the same order, and for the
   * same reason: the CLI reports the version it recorded when it installed the
   * plugin, which is not updated in place, so the manifest is the accurate one.
   * This feeds `updateAvailable`, so a driver preferring the CLI's number offers
   * updates the other would not.
   */
  private async installedVersion(
    entry: InstalledPlugin | null,
    rules: SwitchSetupCliRules
  ): Promise<string | null> {
    if (!entry) return null;
    if (entry.manifestPath) {
      const manifest = await this.readRemoteJson<{ version?: string }>(
        posixJoin(entry.manifestPath, rules.pluginManifestDir, 'plugin.json')
      );
      if (manifest?.version) return manifest.version;
    }
    return entry.version ?? null;
  }

  /**
   * The version the marketplace advertises, or null when it genuinely cannot be
   * determined — which callers must not read as "up to date".
   *
   * Preferred source is the CLI's own JSON, which costs nothing extra. Codex
   * does not report versions there, so fall back to the marketplace manifests
   * on the host: the same path the local driver takes, and dialect-agnostic
   * because each dialect names its own manifest directories.
   */
  private async advertisedVersion(
    bin: string,
    marketplaceName: string,
    pluginName: string,
    rules: SwitchSetupCliRules
  ): Promise<string | null> {
    const { stdout } = await this.run(bin, ['plugin', 'marketplace', 'list', '--json']);
    const parsed = parseJsonLoose(stdout);

    const fromCli = rules.parseAdvertisedVersions(parsed, marketplaceName).get(pluginName);
    if (fromCli) return fromCli;

    const market = rules
      .parseMarketplaceList(parsed)
      .find((m) => m.name === marketplaceName && m.root !== null);
    if (!market?.root) return null;

    const manifest = await this.readRemoteJson<{
      plugins?: Array<{ name?: string; source?: string }>;
    }>(posixJoin(market.root, rules.marketplaceManifestDir, 'marketplace.json'));
    const entry = manifest?.plugins?.find((p) => p.name === pluginName);
    if (!entry?.source) return null;

    const pluginManifest = await this.readRemoteJson<{ version?: string }>(
      posixJoin(market.root, entry.source, rules.pluginManifestDir, 'plugin.json')
    );
    return pluginManifest?.version ?? null;
  }

  /**
   * Read and parse a JSON file on the host. Null for anything that did not
   * produce parseable JSON — a missing manifest is an ordinary outcome here
   * (the marketplace may be laid out differently, or not checked out yet), and
   * the caller already treats null as "unknown" rather than as a version.
   */
  private async readRemoteJson<T>(path: string): Promise<T | null> {
    const res = await this.run('cat', [path]);
    if (res.code !== 0) return null;
    return (parseJsonLoose(res.stdout) as T | null) ?? null;
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
    // No binary on the host means no marketplace to repair and no plugin to
    // install; every command after this one would fail the same way.
    if (listed.notFound) throw new HostCliMissingError(bin);
    const existing = rules
      .parseMarketplaceList(parseJsonLoose(listed.stdout))
      .find((m) => m.name === marketplaceName);
    if (existing) {
      if (marketplaceMatchesSource(existing, marketplaceSource)) return;
      log.warn('remote-switch-setup: re-pointing marketplace to current source', {
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
   * Status of a file-based connector on this host. Its content ships inside the
   * app, so the version the connector's own directory declares is the latest
   * there is, and an install stamped with an older one is what "update
   * available" means.
   */
  private async filesStatus(agentId: string): Promise<SwitchSetupStatus> {
    const { files, version } = this.resolveFiles(agentId);
    const installedVersion = await files.installedVersion(this.homeFs());
    return {
      agentId,
      supported: true,
      installed: installedVersion !== null,
      installedVersion,
      latestVersion: version,
      updateAvailable: installedVersion !== null && isNewerVersion(installedVersion, version),
      refreshError: null,
    };
  }

  /**
   * Install, update and uninstall for a file-based connector on this host.
   * Classifies exactly as the local driver does — see the note there.
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
      log.error('remote-switch-setup: file-based connector declares no behavior', { agentId, err });
      return connectorFailed(err.message, 'files_unimplemented');
    }
    try {
      await action(resolved.files, this.homeFs(), resolved.version);
      return connectorSucceeded();
    } catch (err) {
      log.error('remote-switch-setup: file-based connector operation failed', { agentId, err });
      return connectorFailed(err instanceof Error ? err.message : String(err), failure);
    }
  }

  async getStatus(agentId: string): Promise<SwitchSetupStatus> {
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'files') {
      return this.filesStatus(agentId);
    }
    const resolved = await this.resolve(agentId);
    if (!resolved) return unsupportedStatus(agentId);
    const { descriptor, bin, ref, rules } = resolved;

    const entry = await this.findInstalled(bin, ref, rules);
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
   * Refresh the marketplace catalog, then recompute status (the network step).
   * A failed refresh does not throw — the returned status carries the cached
   * versions with `refreshError` set so the UI can disclose the staleness.
   */
  async checkForUpdates(agentId: string): Promise<SwitchSetupStatus> {
    // A file-based connector ships inside the app: nothing to refresh.
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'files') {
      return this.filesStatus(agentId);
    }
    const resolved = await this.resolve(agentId);
    if (!resolved) return unsupportedStatus(agentId);
    const { descriptor, bin, marketplaceSource, rules } = resolved;
    let refreshError: string | null = null;
    try {
      await this.ensureMarketplace(bin, descriptor.marketplaceName, marketplaceSource, rules);
      const res = await this.run(bin, rules.marketplaceRefreshArgs(descriptor.marketplaceName));
      if (res.code !== 0) {
        throw new Error(
          res.stderr.trim() || `Failed to update marketplace ${descriptor.marketplaceName}`
        );
      }
    } catch (err) {
      log.warn('remote-switch-setup: marketplace refresh failed', { agentId, err });
      refreshError = err instanceof Error ? err.message : String(err);
    }
    return { ...(await this.getStatus(agentId)), refreshError };
  }

  /**
   * Install the connector on this host, reporting the outcome. The `none` guard
   * and the reporting of `unsupported` mirror the local driver — both now come
   * from the shared leaf rather than from two copies kept in step by hand.
   */
  async install(agentId: string): Promise<SwitchSetupResult> {
    if (declaresNoConnector(agentId)) return CONNECTOR_UNSUPPORTED_RESULT;
    const elapsed = startTimer();
    const run = await runReportedOperation('remote-switch-setup', agentId, () =>
      this.runInstall(agentId)
    );
    trackEvent('connector_installed', {
      agent_type: agentTypeOf(agentId),
      target: 'remote',
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
    const { descriptor, bin, ref, marketplaceSource, rules } = resolved;
    try {
      await this.ensureMarketplace(bin, descriptor.marketplaceName, marketplaceSource, rules);
    } catch (err) {
      return marketplaceFailed(err, `Could not add marketplace: ${String(err)}`);
    }
    const res = await this.run(bin, rules.installArgs(ref, descriptor.scope));
    return res.code === 0
      ? connectorSucceeded()
      : connectorFailed(
          res.stderr.trim() || 'Install failed.',
          commandFailureCode(res, 'install_command_failed')
        );
  }

  /**
   * The marketplace is repaired first, exactly as `install` does: the re-add
   * below resolves against whatever marketplace is registered, so a stale source
   * would otherwise fail it after the uninstall has already succeeded.
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
      target: 'remote',
      outcome: run.result.success ? 'success' : 'failure',
      was_reinstall: wasReinstall,
      trigger,
      failure_reason: run.failure,
      duration_ms: elapsed(),
    });
    return run.result;
  }

  /** `runUpdate` that always comes back as a result — see the local driver. */
  private async runUpdateReported(
    agentId: string
  ): Promise<{ run: ConnectorRun; wasReinstall: boolean }> {
    let wasReinstall = false;
    const run = await runReportedOperation('remote-switch-setup', agentId, async () => {
      const outcome = await this.runUpdate(agentId);
      wasReinstall = outcome.wasReinstall;
      return outcome.run;
    });
    return { run, wasReinstall };
  }

  private async runUpdate(agentId: string): Promise<{ run: ConnectorRun; wasReinstall: boolean }> {
    // Installing overwrites in place, so update is the same operation — there
    // is no removed-but-not-reinstalled window to report on.
    if (getPlugin(agentId).capabilities.switchSetup.kind === 'files') {
      const run = await this.runFiles(agentId, 'files_write_failed', (files, fs, version) =>
        files.install(fs, { version })
      );
      return { run, wasReinstall: false };
    }
    const resolved = await this.resolve(agentId);
    if (!resolved) return { run: connectorUnsupported(), wasReinstall: false };
    const { descriptor, bin, ref, marketplaceSource, rules } = resolved;

    try {
      await this.ensureMarketplace(bin, descriptor.marketplaceName, marketplaceSource, rules);
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

    // No per-plugin update verb (Codex): remove then re-add. A failed re-add
    // leaves the host with no connector, so say that rather than 'Update failed'.
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
                'Update failed: the plugin was removed but could not be reinstalled. Install it again for this host.',
              commandFailureCode(added, 'install_command_failed')
            ),
      wasReinstall: true,
    };
  }

  /** Status of every Switch-supported agent type's connector plugin on this host. */
  async listAgentTypeStatuses(): Promise<SwitchSetupStatus[]> {
    const statuses: SwitchSetupStatus[] = [];
    for (const plugin of listPlugins()) {
      if (plugin.capabilities.switchSetup.kind === 'none') continue;
      const agentId = plugin.metadata.id;
      // One agent type whose status cannot be read must not empty the panel.
      // `refreshError` is how a status says it is not known to be current, so a
      // row that could not be read at all says so there rather than vanishing.
      try {
        statuses.push(await this.getStatus(agentId));
      } catch (err) {
        log.error('remote-switch-setup: could not read connector status', { agentId, err });
        statuses.push({
          ...unsupportedStatus(agentId),
          supported: true,
          refreshError: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return statuses;
  }
}

const serviceCache = new Map<string, Promise<RemoteSwitchSetupService>>();

async function build(sshHost: string): Promise<RemoteSwitchSetupService> {
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  return new RemoteSwitchSetupService(new SshExecutionContext(proxy));
}

/** Returns the remote Switch-setup service for a host, cached per SSH alias. */
export function getRemoteSwitchSetupService(sshHost: string): Promise<RemoteSwitchSetupService> {
  const existing = serviceCache.get(sshHost);
  if (existing) return existing;
  const created = build(sshHost).catch((error) => {
    serviceCache.delete(sshHost);
    throw error;
  });
  serviceCache.set(sshHost, created);
  return created;
}
