import { DEEPLINK_SCHEME } from '@main/app/deeplinks';
import {
  type AgentSidecarParams,
  ensureAgentSidecar,
  readAgentSidecarLog,
  readAgentSidecarStatus,
  restartAgentSidecar,
  stopAgentSidecar,
} from '@main/core/agent-runtime/impl/ensure-agent-sidecar';
import { getRemoteAgentLocation } from '@main/core/agents/agent-location';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { reapStaleSidecarsForAgent } from '@main/core/agents/reap-stale-sidecars';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { toSwitchSpecialization } from '@shared/core/agents/agent-provider-config';
import type { Agent } from '@shared/core/agents/agents';
import { type AgentSidecarStatus, sidecarStatusChannel } from '@shared/events/sidecarEvents';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { SIDECAR_VERSION } from '../../../sidecar/sidecar-version';
import { verdictFor } from './verdict';

const LOG_TAIL_LINES = 100;

async function requireRemoteAgent(
  agentId: string
): Promise<{ agent: Agent; sshHost: string; repoDir: string; credsSlug: string }> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`sidecar: unknown agent ${agentId}`);
  const location = await getRemoteAgentLocation(agent);
  if (!location) throw new Error(`sidecar: agent ${agentId} is not at a remote location`);
  return {
    agent,
    sshHost: location.sshHost,
    repoDir: location.dir,
    credsSlug: agent.name ?? agent.id,
  };
}

/** Build the shared sidecar params from a connected remote agent. */
async function paramsForAgent(agent: Agent): Promise<AgentSidecarParams> {
  const conn = await connectRemoteAgent(agent);
  return {
    providerId: agent.providerId,
    repoDir: conn.remoteRepoDir,
    deeplinkScheme: DEEPLINK_SCHEME,
    autoApprove: agent.autoApprove,
    credsSlug: agent.name ?? agent.id,
    agentName: agent.name ?? null,
    specialization: toSwitchSpecialization(agent.providerConfig),
    ctx: conn.ctx,
    connectionId: conn.connectionId,
    host: conn.host,
  };
}

/**
 * Read status for an agent, assemble the full UI shape, and broadcast it so any
 * open page updates live. Shared by the read path and by every mutation, which
 * re-read and re-emit once they finish.
 */
async function readAndBroadcast(agentId: string): Promise<AgentSidecarStatus> {
  const { agent, sshHost, repoDir, credsSlug } = await requireRemoteAgent(agentId);
  const { status, clientHash } = await readAgentSidecarStatus(await paramsForAgent(agent));
  const full: AgentSidecarStatus = {
    agentId,
    running: status.running,
    verdict: verdictFor(status, clientHash, SIDECAR_VERSION),
    clientHash,
    clientVersion: SIDECAR_VERSION,
    deployedHash: status.hash,
    deployedVersion: status.version,
    epoch: status.epoch,
    pid: status.pid,
    liveSessions: status.liveSessions,
    repoDir,
    sshHost,
    credsSlug,
  };
  events.emit(sidecarStatusChannel, full);
  return full;
}

export const sidecarController = createRPCController({
  /** Read-only status for one agent's sidecar. Never launches one. */
  getStatus: (agentId: string): Promise<AgentSidecarStatus> => readAndBroadcast(agentId),

  /**
   * Deploy the client's bundle if the running sidecar is a different, replaceable
   * build (idle). Honours the defer policy — a busy sidecar is left running — so
   * this is the "polite Update" action. Returns the refreshed status.
   */
  upgrade: async (agentId: string): Promise<AgentSidecarStatus> => {
    const { agent } = await requireRemoteAgent(agentId);
    const params = await paramsForAgent(agent);
    await ensureAgentSidecar(params);
    await reapStaleSidecarsForAgent(agent, params.host, params.repoDir);
    return readAndBroadcast(agentId);
  },

  /**
   * Force a fresh sidecar process (stop + relaunch), even if the current one has
   * live sessions — they survive via the endpoint file. The "restart / force
   * upgrade now" action.
   */
  restart: async (agentId: string): Promise<AgentSidecarStatus> => {
    const { agent } = await requireRemoteAgent(agentId);
    const params = await paramsForAgent(agent);
    await restartAgentSidecar(params);
    await reapStaleSidecarsForAgent(agent, params.host, params.repoDir);
    return readAndBroadcast(agentId);
  },

  /** Stop the sidecar. Sessions keep running but lose room injection until it is back. */
  stop: async (agentId: string): Promise<AgentSidecarStatus> => {
    const { agent } = await requireRemoteAgent(agentId);
    await stopAgentSidecar(await paramsForAgent(agent));
    return readAndBroadcast(agentId);
  },

  /** Tail of the sidecar log on the host, for debugging. */
  logTail: async (agentId: string): Promise<string> => {
    const { agent } = await requireRemoteAgent(agentId);
    try {
      return await readAgentSidecarLog(await paramsForAgent(agent), LOG_TAIL_LINES);
    } catch (error) {
      log.warn('sidecarController: failed to read log tail', { agentId, error: String(error) });
      return '';
    }
  },
});
