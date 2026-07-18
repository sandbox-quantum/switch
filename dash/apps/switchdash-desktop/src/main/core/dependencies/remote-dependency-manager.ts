import type { Platform } from '@switchdash/core/deps';
import { HostDependencyManager } from '@switchdash/core/deps/runtime';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { log } from '@main/lib/logger';
import { agentUpdateService } from './agent-update-service';
import { CORE_DEPENDENCIES } from './core-dependencies';
import { DEPENDENCIES } from './registry';
import { createSshInstallCommandRunner } from './ssh-install-runner';

/** Core host tools + agent CLIs — the full set surfaced on a remote host page. */
export const REMOTE_DEPENDENCIES = [...CORE_DEPENDENCIES, ...DEPENDENCIES];
export const remoteDependencyDescriptor = (id: string) =>
  REMOTE_DEPENDENCIES.find((d) => d.id === id);

/**
 * Detect the remote OS so the manager picks the right per-platform install
 * commands. Falls back to 'linux' (the common remote case) if `uname` is
 * unavailable.
 */
async function detectRemotePlatform(ctx: SshExecutionContext): Promise<Platform> {
  try {
    const { stdout } = await ctx.exec('uname', ['-s']);
    const kernel = stdout.trim().toLowerCase();
    if (kernel.includes('darwin')) return 'macos';
    if (kernel.includes('linux')) return 'linux';
    return 'linux';
  } catch (error) {
    log.warn('[SshDependencyManager] uname failed, assuming linux', {
      error: String((error as Error)?.message ?? error),
    });
    return 'linux';
  }
}

const managerCache = new Map<string, Promise<HostDependencyManager>>();

async function buildRemoteDependencyManager(sshHost: string): Promise<HostDependencyManager> {
  const connectionId = sshConnectionIdForHost(sshHost);
  const proxy = await ensureSshConnected(connectionId, sshHost);
  const ctx = new SshExecutionContext(proxy);
  const platform = await detectRemotePlatform(ctx);

  const manager = new HostDependencyManager(ctx, {
    runInstallCommand: createSshInstallCommandRunner(proxy),
    // Remote hosts use auto-detection only; per-host install overrides are a
    // local-only feature today, so no selection is persisted for remote hosts.
    getSelection: () => Promise.resolve(null),
    connectionId,
    platform,
    logger: log,
    dependencies: REMOTE_DEPENDENCIES,
    getDependencyDescriptor: remoteDependencyDescriptor,
  });
  agentUpdateService.attach(manager, connectionId);
  return manager;
}

/**
 * Returns the dependency manager for an onboarded remote host, keyed by its SSH
 * alias. Cached so repeated probe/install calls reuse one manager (and one
 * pooled SSH connection) per host.
 */
export function getRemoteDependencyManager(sshHost: string): Promise<HostDependencyManager> {
  const existing = managerCache.get(sshHost);
  if (existing) return existing;
  const created = buildRemoteDependencyManager(sshHost).catch((error) => {
    managerCache.delete(sshHost);
    throw error;
  });
  managerCache.set(sshHost, created);
  return created;
}
