import { DEEPLINK_SCHEME } from '@main/app/deeplinks';
import { readAgentSidecarLog } from '@main/core/agent-runtime/impl/ensure-agent-sidecar';
import { agentLaunchSpecialization } from '@main/core/agents/agent-launch-config';
import { getRemoteAgentLocation } from '@main/core/agents/agent-location';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgents } from '@main/core/agents/getAgents';
import { registerDiagnosticSection } from '@main/lib/file-logger';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';

const DIAGNOSTIC_TAIL_LINES = 200;

/**
 * Include remote sidecar logs in the diagnostic attachment.
 *
 * A remote agent keeps running while Switch Console is closed, so its sidecar is
 * where the failures worth reporting tend to happen — and until now that log
 * stayed on the VM, leaving a bug report about a remote agent with no record of
 * the process it was actually about.
 *
 * Pulled on demand rather than streamed continuously: a report is the only time
 * the content is needed, and holding a live tail open per agent would cost an
 * SSH channel each for output almost always discarded.
 */
export function registerSidecarDiagnostics(): void {
  registerDiagnosticSection('remote sidecar logs', collectSidecarLogs);
}

async function collectSidecarLogs(): Promise<string> {
  const agents = await getAgents();
  const remote = await filterRemote(agents);
  if (!remote.length) return '';

  const sections = await Promise.all(remote.map(collectForAgent));
  return sections.filter(Boolean).join('\n');
}

async function filterRemote(agents: Agent[]): Promise<Agent[]> {
  const checked = await Promise.all(
    agents.map(async (agent) => ((await getRemoteAgentLocation(agent)) ? agent : undefined))
  );
  return checked.filter((agent): agent is Agent => agent !== undefined);
}

async function collectForAgent(agent: Agent): Promise<string> {
  const label = `--- sidecar: ${agent.name ?? agent.id} (${agent.id}) ---`;

  try {
    const conn = await connectRemoteAgent(agent);
    const tail = await readAgentSidecarLog(
      {
        providerId: agent.providerId,
        repoDir: conn.remoteRepoDir,
        deeplinkScheme: DEEPLINK_SCHEME,
        autoApprove: agent.autoApprove,
        credsSlug: agent.name ?? agent.id,
        agentName: agent.name ?? null,
        specialization: await agentLaunchSpecialization(agent.id),
        ctx: conn.ctx,
        connectionId: conn.connectionId,
        host: conn.host,
      },
      DIAGNOSTIC_TAIL_LINES
    );

    return `${label}\n${tail.trim() || '(log empty)'}`;
  } catch (error) {
    // An unreachable host is itself worth reporting — it is frequently the
    // problem being reported — so the failure is recorded rather than dropped.
    log.warn('sidecarDiagnostics: failed to read sidecar log', {
      agentId: agent.id,
      error: String(error),
    });
    return `${label}\n(unavailable: ${String(error)})`;
  }
}
