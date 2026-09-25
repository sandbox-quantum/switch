import { getAgents } from '@main/core/agents/getAgents';
import { log } from '@main/lib/logger';
import { agentAvatarUrlForName } from '@shared/core/agents/agent-avatar';
import type { AgentIconBackfill, SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { fetchAgents, GatewayError, updateAgentIcon } from './gateway-client';

/**
 * Give the signed-in user's existing agents the bot avatar their name generates
 * (CHOO-2171).
 *
 * Agents registered before icons existed have none, and the Switch server's own
 * fallback for those is the lettered avatar the bridges have always drawn. This
 * writes the bot in, so an agent this app manages looks the same in the app as
 * it does in Slack — and an agent belonging to an install that has not updated
 * keeps the letters, which is the intended way to tell the two apart.
 *
 * Only agents this install manages are touched, and only those with no icon at
 * all — a chosen icon is never overwritten.
 *
 * Managed-by-this-app is the line rather than owned-by-this-user, and the
 * difference matters: an agent registered before Switch tracked ownership has
 * no owner, so an owner check silently skips exactly the oldest agents — the
 * ones this exists for. Whether the write is permitted is then the gateway's
 * call, and a refusal is taken as "not yours" rather than argued with.
 *
 * **The outcome is reported rather than logged and forgotten.** The app draws a
 * name-derived bot for any agent the server has no icon for, so a failed write
 * leaves the app looking correct while the chat platforms — which ask the
 * server — still show the lettered avatar. Nothing on screen would say why, so
 * the caller is handed what happened and tells the user.
 */
export function backfillAgentIcons(server: SwitchServer): Promise<AgentIconBackfill> {
  const settled = completed.get(server.id);
  if (settled !== undefined) return Promise.resolve(settled);

  const running = inFlight.get(server.id);
  if (running) return running;

  const run = writeMissingIcons(server)
    .then((outcome) => {
      completed.set(server.id, outcome);
      return outcome;
    })
    .finally(() => inFlight.delete(server.id));

  inFlight.set(server.id, run);
  return run;
}

/** Servers already done this run, and what happened to each. Kept so opening
 * the agents page repeatedly does not re-ask the gateway; a server that threw
 * is deliberately absent, so the next refresh tries again. */
const completed = new Map<string, AgentIconBackfill>();
const inFlight = new Map<string, Promise<AgentIconBackfill>>();

async function writeMissingIcons(server: SwitchServer): Promise<AgentIconBackfill> {
  const [agents, local] = await Promise.all([fetchAgents(server), getAgents()]);
  // `GET /agents` lists the whole server, most of which is nothing to do with
  // this computer.
  const managed = new Set(
    local
      .filter((agent) => agent.serverId === server.id && agent.switchAgentId !== null)
      .map((agent) => agent.switchAgentId as string)
  );
  const missing = agents.filter((agent) => agent.iconUrl === null && managed.has(agent.id));
  if (missing.length === 0) return { kind: 'written', written: 0 };

  let written = 0;
  const failures: string[] = [];
  let notFound = 0;
  for (const agent of missing) {
    try {
      await updateAgentIcon(server, agent.id, agentAvatarUrlForName(agent.name));
      written += 1;
    } catch (cause) {
      // A refusal means the agent is not this user's to change — expected on a
      // shared machine, and not a failure to report.
      if (cause instanceof GatewayError && cause.status === 403) {
        log.debug('agent icon backfill: not ours to change', { agent: agent.name });
        continue;
      }
      // Anything else must not cost the remaining agents their icons, so it is
      // collected rather than thrown.
      failures.push(agent.name);
      if (cause instanceof GatewayError && cause.status === 404) notFound += 1;
      log.debug('agent icon backfill: one agent failed', { agent: agent.name, cause });
    }
  }

  // Every single write 404ing is a server without the icon endpoint at all,
  // not a set of missing agents — the agents came from that same server one
  // request earlier. Worth separating: one is "upgrade the server", the other
  // is "these particular agents went away".
  if (written === 0 && notFound > 0 && notFound === missing.length) {
    log.warn('agent icon backfill: this server has no agent-icon endpoint', {
      event: 'agent_icon_backfill',
      serverId: server.id,
      agents: missing.length,
    });
    return { kind: 'unsupported' };
  }

  if (failures.length > 0) {
    log.warn('agent icon backfill: some agents kept the lettered avatar', {
      event: 'agent_icon_backfill',
      serverId: server.id,
      written,
      failed: failures.length,
      failedAgents: failures,
    });
    return { kind: 'partial', written, failed: failures.length };
  }

  log.info('agent icon backfill: done', {
    event: 'agent_icon_backfill',
    serverId: server.id,
    written,
  });
  return { kind: 'written', written };
}
