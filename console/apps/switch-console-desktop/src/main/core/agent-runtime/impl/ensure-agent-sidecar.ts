import type { SwitchLaunchSpecialization } from '@switch-console/core/agents/plugins';
import { generateAgentLaunchSpec } from '@main/core/agents/generate-agent-launch-spec';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { log } from '@main/lib/logger';
import {
  agentSidecarTmuxName,
  RemoteSidecarLauncher,
  type SidecarEndpoint,
  type SidecarHost,
  type SidecarRunStatus,
} from './remote-sidecar-launcher';
import { resolveSidecarBundlePath } from './resolve-sidecar-bundle';

/**
 * The parameters every sidecar operation shares: enough to identify the agent's
 * sidecar on the host and (re)generate its launch recipe.
 */
export interface AgentSidecarParams {
  providerId: string;
  /** Absolute remote repo dir; the agent's Switch creds + bundle live under it. */
  repoDir: string;
  deeplinkScheme: string;
  /** The agent's bypass-permissions setting, baked into the auto-start launch spec. */
  autoApprove: boolean;
  /** Per-agent creds slug (the agent's name) — selects the sidecar's
   * `.switch/agents/<slug>.json` identity file (CHOO-1440). */
  credsSlug: string;
  /** The agent's name — so auto-started sessions launch as it with its own
   * identity (a definitions-capable provider passes it as `--agent <name>`). */
  agentName: string | null;
  /** Per-agent model / effort / instructions folded into auto-started sessions'
   * launch profile. */
  specialization?: SwitchLaunchSpecialization;
  ctx: IExecutionContext;
  connectionId: string;
  host: SidecarHost;
}

async function buildLauncher(params: AgentSidecarParams): Promise<RemoteSidecarLauncher> {
  const launchSpec = await generateAgentLaunchSpec({
    providerId: params.providerId,
    remoteRepoDir: params.repoDir,
    deeplinkScheme: params.deeplinkScheme,
    autoApprove: params.autoApprove,
    agentName: params.agentName,
    credsSlug: params.credsSlug,
    specialization: params.specialization,
    ctx: params.ctx,
    connectionId: params.connectionId,
  });
  return new RemoteSidecarLauncher({
    host: params.host,
    bundlePath: resolveSidecarBundlePath(),
    sidecarTmuxName: agentSidecarTmuxName(params.repoDir, params.credsSlug),
    config: {
      repoDir: params.repoDir,
      deeplinkScheme: params.deeplinkScheme,
      launchSpec,
      credsSlug: params.credsSlug,
    },
    // Bound once here so every line the launcher writes names the agent it is
    // acting for. Sidecar work runs off watchers rather than an RPC call, so
    // there is no ambient scope for it to inherit.
    log: log.child({
      component: 'sidecar-launcher',
      agentSlug: params.credsSlug,
      agentName: params.agentName ?? undefined,
    }),
  });
}

/**
 * Deploy + launch (or reattach to) the one agent-scoped remote sidecar and
 * return its hook endpoint. Shared by the SSH agent runtime (which points a
 * UI-started session's hook env at the endpoint) and the auto-session setup path
 * (which just needs the sidecar — and its watcher — running). One sidecar per
 * remote repo dir, so both callers reattach to the same instance.
 */
export async function ensureAgentSidecar(params: AgentSidecarParams): Promise<SidecarEndpoint> {
  return (await buildLauncher(params)).deployAndLaunch();
}

/**
 * Return the endpoint of an agent's sidecar only if one is already running —
 * never launches one. For discovery (surfacing sessions another client started):
 * a client that merely has the agent configured should not spin up a VM sidecar
 * just to poll. When no sidecar is up there is nothing to discover, so callers
 * treat null as "no sessions this tick".
 */
export async function probeAgentSidecar(
  params: AgentSidecarParams
): Promise<SidecarEndpoint | null> {
  return (await buildLauncher(params)).probeExisting();
}

/**
 * Read-only status of an agent's sidecar for the UI (running? which build/
 * protocol/epoch/pid? how many live sessions?), plus this client's own bundle
 * hash so the caller can render the client-vs-host verdict. Never launches.
 */
export async function readAgentSidecarStatus(
  params: AgentSidecarParams
): Promise<{ status: SidecarRunStatus; clientHash: string }> {
  const launcher = await buildLauncher(params);
  const [status, clientHash] = await Promise.all([
    launcher.readStatus(),
    launcher.localBundleHash(),
  ]);
  return { status, clientHash };
}

/**
 * Stop an agent's sidecar (kills its tmux session). Sessions keep running in
 * their own panes; they simply lose room injection until a sidecar is back.
 */
export async function stopAgentSidecar(params: AgentSidecarParams): Promise<void> {
  await (await buildLauncher(params)).stop();
}

/**
 * Force a fresh sidecar process: stop the running one, then deploy + launch.
 *
 * `ensureAgentSidecar` alone reattaches to a same-build sidecar and defers an
 * upgrade while sessions are live, so it is not a restart. This is the explicit
 * "restart / force upgrade now" the UI offers — safe because sessions follow
 * the new process via the endpoint file.
 */
export async function restartAgentSidecar(params: AgentSidecarParams): Promise<SidecarEndpoint> {
  const launcher = await buildLauncher(params);
  await launcher.stop();
  return launcher.deployAndLaunch();
}

/** Best-effort tail of an agent's sidecar log, for the UI's debug view. */
export async function readAgentSidecarLog(
  params: AgentSidecarParams,
  lines: number
): Promise<string> {
  return (await buildLauncher(params)).logTail(lines);
}
