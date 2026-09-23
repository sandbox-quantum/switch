import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@switch-console/shared';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureObservedLocation } from '@main/core/locations/store';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { fetchAgents, GatewayError } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import type { OnboardAgentError } from '@shared/core/agents/onboarding';
import type { RemoteAgentSummary } from '@shared/core/switch-servers/switch-servers';
import { basenameFromAnyPath } from '@shared/path-name';
import { agentEvents } from './agent-events';
import { createAgent } from './createAgent';
import { getAgents } from './getAgents';
import { providerForKnownAgentType } from './known-agent-type';
import {
  accountOwning,
  type DirAccess,
  type HostHome,
  parseHomes,
  repoDirOf,
} from './observed-agent-paths';

/**
 * Agents another account runs on a shared host, followed from this Console
 * without running anything as it (CHOO-2893).
 *
 * On a host several people share, each usually under their own account, the
 * agents one person set up live in their home directory: their credentials,
 * their SDK host, their auto-session watcher. A second person's Console cannot
 * read any of that, and must not try to run the agents as itself — the working
 * directory is not its to write, and a second watcher under another account
 * would fight the first for the agent's session lease.
 *
 * It does not need to. Both sign in to the server as its one admin account, so
 * the server already lets either read an agent's sessions and send them
 * commands. An *observed* agent is one this Console holds a row for, with its
 * identity taken from the server alone, at a location marked observed: its
 * sessions are listed, read and driven through the server, and nothing about it
 * ever touches the host.
 */

/**
 * One line per directory, in order. `[ -e ]` is false both for a path that is
 * not there and for one under a directory this account cannot search, so `ls`
 * is asked which it was; the C locale fixes the words it answers in.
 */
const DIR_ACCESS_SCRIPT = [
  'export LC_ALL=C',
  'for d in "$@"; do',
  '  if [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ]; then echo readable',
  '  elif [ -e "$d" ]; then echo denied',
  '  elif ls -d -- "$d" 2>&1 | grep -qi \'permission denied\'; then echo denied',
  '  else echo missing',
  '  fi',
  'done',
].join('\n');

async function hostContext(sshHost: string): Promise<SshExecutionContext> {
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  return new SshExecutionContext(proxy);
}

/** How this account on `sshHost` can reach each of `dirs`, in one round trip. */
export async function probeDirAccess(
  sshHost: string,
  dirs: string[]
): Promise<Map<string, DirAccess>> {
  const access = new Map<string, DirAccess>();
  if (dirs.length === 0) return access;
  const ctx = await hostContext(sshHost);
  try {
    const { stdout } = await ctx.exec('sh', ['-c', DIR_ACCESS_SCRIPT, 'dir-access', ...dirs]);
    const answers = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (answers.length !== dirs.length) {
      throw new Error(
        `expected ${dirs.length} answers about directory access on ${sshHost}, got ${answers.length}`
      );
    }
    dirs.forEach((dir, i) => {
      const answer = answers[i];
      if (answer !== 'readable' && answer !== 'denied' && answer !== 'missing') {
        throw new Error(`unexpected directory access answer "${answer}" on ${sshHost}`);
      }
      access.set(dir, answer);
    });
    return access;
  } finally {
    ctx.dispose();
  }
}

/**
 * The accounts on `sshHost` and their homes, for saying whose an observed
 * directory is. Best-effort: a host that will not say leaves the owner unnamed,
 * which is shown as "another account" rather than guessed.
 */
export async function hostHomes(sshHost: string): Promise<HostHome[]> {
  const ctx = await hostContext(sshHost);
  try {
    const { stdout } = await ctx.exec('sh', ['-c', 'getent passwd 2>/dev/null || cat /etc/passwd']);
    return parseHomes(stdout);
  } catch (error) {
    log.warn('observed-agents: could not list the accounts on the host', {
      sshHost,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    ctx.dispose();
  }
}

export type AttachObservedAgentsParams = {
  sshHost: string;
  serverId: string;
  /** The agents' ids on the server. */
  switchAgentIds: string[];
};

/**
 * Follow agents another account runs on `sshHost` from this Console, with
 * their identity taken from the server alone. Reads nothing in their working
 * directories and starts nothing on the host; their sessions are found by the
 * session reconciler, which asks the server.
 *
 * Refuses anything that is not what it claims: an agent the server does not
 * have, one whose directory the server does not name or this account can in
 * fact read — which is loaded and run the ordinary way — or one that is not on
 * this host at all.
 */
export async function attachObservedAgents(
  params: AttachObservedAgentsParams
): Promise<Result<Agent[], OnboardAgentError>> {
  const server = await getServer(params.serverId);
  if (!server) throw new Error(`No Switch server with id ${params.serverId}`);

  let summaries: RemoteAgentSummary[];
  try {
    summaries = await fetchAgents(server);
  } catch (cause) {
    if (cause instanceof GatewayError && cause.kind === 'unauthorized') {
      return err({
        type: 'switch-server-unauthenticated',
        dir: '',
        serverId: server.id,
        serverName: server.name,
      });
    }
    throw cause;
  }
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const held = new Set(
    (await getAgents())
      .filter((agent) => agent.serverId === server.id && agent.switchAgentId)
      .map((agent) => agent.switchAgentId)
  );

  const wanted: { summary: RemoteAgentSummary; dir: string }[] = [];
  for (const id of params.switchAgentIds) {
    if (held.has(id)) continue;
    const summary = byId.get(id);
    if (!summary) {
      return err({
        type: 'switch-agent-not-on-server',
        dir: '',
        serverId: server.id,
        serverName: server.name,
        agentId: id,
      });
    }
    const dir = repoDirOf(summary);
    if (!dir) {
      return err({
        type: 'error',
        message: `${server.name} does not say where ${summary.name} runs, so it cannot be followed from here.`,
      });
    }
    wanted.push({ summary, dir });
  }
  if (wanted.length === 0) {
    return err({ type: 'error', message: 'Every selected agent is already in this Console.' });
  }

  const access = await probeDirAccess(params.sshHost, [...new Set(wanted.map(({ dir }) => dir))]);
  for (const { summary, dir } of wanted) {
    const reach = access.get(dir);
    if (reach === 'readable') {
      return err({
        type: 'invalid-directory',
        dir,
        message: `This account can read ${dir}, so ${summary.name} is loaded and run the ordinary way, not followed.`,
      });
    }
    if (reach === 'missing') {
      return err({
        type: 'invalid-directory',
        dir,
        message: `${summary.name} runs in ${dir}, which is not on ${params.sshHost}.`,
      });
    }
  }

  const homes = await hostHomes(params.sshHost);
  const created: Agent[] = [];
  for (const { summary, dir } of wanted) {
    const providerId = providerForKnownAgentType(summary.knownAgentType);
    if (!providerId) {
      return err({
        type: 'error',
        message: `${summary.name} is a ${summary.knownAgentType ?? 'untyped'} agent, which this Switch Console does not know how to show.`,
      });
    }
    const location = await ensureObservedLocation({
      sshHost: params.sshHost,
      dir,
      name: basenameFromAnyPath(dir) ?? dir,
      owner: accountOwning(dir, homes),
    });
    created.push(
      await createAgent({
        id: randomUUID(),
        locationId: location.id,
        name: summary.name,
        providerId,
        switchAgentId: summary.id,
        // The server's own address: the agent's credentials file, which names
        // the endpoint it was set up with, is exactly what cannot be read.
        apiEndpoint: server.apiUrl,
        serverId: server.id,
        autoApprove: false,
        ownerName: summary.ownerName,
      })
    );
  }

  for (const agent of created) agentEvents._emit('agent:created', agent, 'unknown');
  // Lazy for the reason attach-configured-agents gives: remote-watcher loads
  // Electron's `app` at the top level.
  const { startRemoteDiscovery } = await import('./remote-watcher');
  for (const agent of created) {
    startRemoteDiscovery(agent.id).catch((error) => {
      log.warn('attachObservedAgents: failed to start session discovery', {
        agentId: agent.id,
        error: String(error),
      });
    });
  }
  return ok(created);
}
