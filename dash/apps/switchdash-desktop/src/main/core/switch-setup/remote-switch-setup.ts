import { resolveCommandPath } from '@switchdash/core/deps/runtime';
import semver from 'semver';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { log } from '@main/lib/logger';
import { getPlugin, listPlugins } from '../providers/plugin-registry';
import { cliRulesFor, type SwitchSetupCliRules } from './switch-setup-cli-dialect';
import type { SwitchSetupResult, SwitchSetupStatus } from './switch-setup-service';
import { marketplaceMatchesSource } from './switch-setup-service';

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

function isNewerVersion(installed: string, latest: string): boolean {
  const a = semver.coerce(installed);
  const b = semver.coerce(latest);
  if (a === null || b === null) return false;
  return semver.gt(b, a);
}

/**
 * Remote counterpart of SwitchSetupService: drives an agent type's
 * plugin-marketplace CLI (`<bin> plugin install/update/...`) on an SSH host to
 * manage its Switch connector plugin. Versions come from the CLI's own JSON
 * output (not on-disk manifests) so no SFTP round-trips are needed.
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
    return { descriptor, bin, ref, rules: cliRulesFor(descriptor.dialect) };
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
   * Advertised version from CLI output alone — no SFTP round-trip to read
   * manifests. Null means "unknown", which callers must not read as up to date;
   * a dialect that does not report versions for uninstalled plugins always
   * returns null here.
   */
  private async advertisedVersion(
    bin: string,
    marketplaceName: string,
    pluginName: string,
    rules: SwitchSetupCliRules
  ): Promise<string | null> {
    const { stdout } = await this.run(bin, ['plugin', 'marketplace', 'list', '--json']);
    const fromMarketplace = rules
      .parseAdvertisedVersions(parseJsonLoose(stdout), marketplaceName)
      .get(pluginName);
    if (fromMarketplace) return fromMarketplace;
    const { stdout: pluginStdout } = await this.run(bin, ['plugin', 'list', '--json']);
    return (
      rules.parseAdvertisedVersions(parseJsonLoose(pluginStdout), marketplaceName).get(pluginName) ??
      null
    );
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
      log.warn('remote-switch-setup: marketplace refresh failed', { agentId, err });
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
      return { success: false, message: `Could not add marketplace: ${String(err)}` };
    }
    const res = await this.run(bin, rules.installArgs(ref, descriptor.scope));
    return res.code === 0
      ? { success: true }
      : { success: false, message: res.stderr.trim() || 'Install failed.' };
  }

  async update(agentId: string): Promise<SwitchSetupResult> {
    const resolved = await this.resolve(agentId);
    if (!resolved)
      return { success: false, message: 'Switch setup is not supported for this agent.' };
    const { descriptor, bin, ref, rules } = resolved;
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
