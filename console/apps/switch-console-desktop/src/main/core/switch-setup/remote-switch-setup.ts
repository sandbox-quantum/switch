import { resolveCommandPath } from '@switch-console/core/deps/runtime';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { log } from '@main/lib/logger';
import { isNewerVersion } from '@main/lib/semver';
import { getPlugin, listPlugins } from '../providers/plugin-registry';
import { cliRulesFor, type SwitchSetupCliRules } from './switch-setup-cli-dialect';
import type { SwitchSetupResult, SwitchSetupStatus } from './switch-setup-service';
import { marketplaceMatchesSource } from './switch-setup-service';

const EXEC_TIMEOUT_MS = 120_000;

/** POSIX shells use 127 for "command not found". */
const COMMAND_NOT_FOUND = 127;

type RunResult = { code: number; stdout: string; stderr: string };

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

  private async run(bin: string, args: string[]): Promise<RunResult> {
    try {
      const { stdout, stderr } = await this.ctx.exec(bin, args, { timeout: EXEC_TIMEOUT_MS });
      return { code: 0, stdout, stderr };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      const result = {
        code: e.code ?? 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? '',
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
    const { stdout } = await this.run(bin, ['plugin', 'marketplace', 'list', '--json']);
    const existing = rules
      .parseMarketplaceList(parseJsonLoose(stdout))
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

  async getStatus(agentId: string): Promise<SwitchSetupStatus> {
    const resolved = await this.resolve(agentId);
    if (!resolved) return unsupported(agentId);
    const { descriptor, bin, ref, rules } = resolved;

    const entry = await this.findInstalled(bin, ref, rules);
    const installedVersion = entry?.version ?? null;
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
    const resolved = await this.resolve(agentId);
    if (!resolved) return unsupported(agentId);
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

  async install(agentId: string): Promise<SwitchSetupResult> {
    const resolved = await this.resolve(agentId);
    if (!resolved)
      return { success: false, message: 'Switch setup is not supported for this agent.' };
    const { descriptor, bin, ref, marketplaceSource, rules } = resolved;
    try {
      await this.ensureMarketplace(bin, descriptor.marketplaceName, marketplaceSource, rules);
    } catch (err) {
      return { success: false, message: `Could not add marketplace: ${String(err)}` };
    }
    const res = await this.run(bin, rules.installArgs(ref, descriptor.scope));
    return res.code === 0
      ? { success: true }
      : { success: false, message: res.stderr.trim() || 'Install failed.' };
  }

  /**
   * The marketplace is repaired first, exactly as `install` does: the re-add
   * below resolves against whatever marketplace is registered, so a stale source
   * would otherwise fail it after the uninstall has already succeeded.
   */
  async update(agentId: string): Promise<SwitchSetupResult> {
    const resolved = await this.resolve(agentId);
    if (!resolved)
      return { success: false, message: 'Switch setup is not supported for this agent.' };
    const { descriptor, bin, ref, marketplaceSource, rules } = resolved;

    try {
      await this.ensureMarketplace(bin, descriptor.marketplaceName, marketplaceSource, rules);
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

    // No per-plugin update verb (Codex): remove then re-add. A failed re-add
    // leaves the host with no connector, so say that rather than 'Update failed'.
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
            'Update failed: the plugin was removed but could not be reinstalled. Install it again for this host.',
        };
  }

  /** Status of every Switch-supported agent type's connector plugin on this host. */
  async listAgentTypeStatuses(): Promise<SwitchSetupStatus[]> {
    const statuses: SwitchSetupStatus[] = [];
    for (const plugin of listPlugins()) {
      if (plugin.capabilities.switchSetup.kind !== 'cli') continue;
      statuses.push(await this.getStatus(plugin.metadata.id));
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
