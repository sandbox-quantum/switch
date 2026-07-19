import { generateAgentLaunchSpec } from '@main/core/agents/generate-agent-launch-spec';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { log } from '@main/lib/logger';
import {
  agentSidecarTmuxName,
  RemoteSidecarLauncher,
  type SidecarEndpoint,
  type SidecarHost,
} from './remote-sidecar-launcher';
import { resolveSidecarBundlePath } from './resolve-sidecar-bundle';

/**
 * Deploy + launch (or reattach to) the one agent-scoped remote sidecar and
 * return its hook endpoint. Shared by the SSH agent runtime (which
 * points a UI-started session's hook env at the endpoint) and the auto-session
 * setup path (which just needs the sidecar — and its watcher — running). One
 * sidecar per remote repo dir, so both callers reattach to the same instance.
 */
export async function ensureAgentSidecar(params: {
  providerId: string;
  /** Absolute remote repo dir; the agent's Switch creds + bundle live under it. */
  repoDir: string;
  deeplinkScheme: string;
  ctx: IExecutionContext;
  connectionId: string;
  host: SidecarHost;
}): Promise<SidecarEndpoint> {
  const { providerId, repoDir, deeplinkScheme, ctx, connectionId, host } = params;
  const launchSpec = await generateAgentLaunchSpec({
    providerId,
    remoteRepoDir: repoDir,
    deeplinkScheme,
    ctx,
    connectionId,
  });
  const launcher = new RemoteSidecarLauncher({
    host,
    bundlePath: resolveSidecarBundlePath(),
    sidecarTmuxName: agentSidecarTmuxName(repoDir),
    config: { repoDir, deeplinkScheme, launchSpec },
    log,
  });
  return launcher.deployAndLaunch();
}

/**
 * Return the endpoint of an agent's sidecar only if one is already running —
 * never launches one. For discovery (surfacing sessions another client started):
 * a client that merely has the agent configured should not spin up a VM sidecar
 * just to poll. When no sidecar is up there is nothing to discover, so callers
 * treat null as "no sessions this tick".
 */
export async function probeAgentSidecar(params: {
  providerId: string;
  repoDir: string;
  deeplinkScheme: string;
  ctx: IExecutionContext;
  connectionId: string;
  host: SidecarHost;
}): Promise<SidecarEndpoint | null> {
  const { providerId, repoDir, deeplinkScheme, ctx, connectionId, host } = params;
  const launchSpec = await generateAgentLaunchSpec({
    providerId,
    remoteRepoDir: repoDir,
    deeplinkScheme,
    ctx,
    connectionId,
  });
  const launcher = new RemoteSidecarLauncher({
    host,
    bundlePath: resolveSidecarBundlePath(),
    sidecarTmuxName: agentSidecarTmuxName(repoDir),
    config: { repoDir, deeplinkScheme, launchSpec },
    log,
  });
  return launcher.probeExisting();
}
