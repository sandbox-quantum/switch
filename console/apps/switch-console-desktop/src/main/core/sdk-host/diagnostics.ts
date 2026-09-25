import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { resolveSharedHostBundlePath } from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { redactSecrets } from '@main/lib/file-logger';
import { listHostSessions } from './host-sessions';
import { inspectWatchers } from './watcher-inspection';

const watcherSchema = z.object({
  running: z.boolean(),
  enabled: z.boolean(),
  failure: z.string().nullable(),
  pid: z.number().int().positive().nullable(),
  supervisorPid: z.number().int().positive().nullable(),
  buildHash: z.string().nullable(),
  /**
   * Set while the watcher is standing down because another client took this
   * agent's connection. It is still enabled and deliberately not running, which
   * is otherwise indistinguishable from having crashed.
   */
  takenOver: z.object({ at: z.string(), reason: z.string() }).nullable(),
});

async function agentHost(agentId: string) {
  const agent = await getAgentById(agentId);
  if (!agent?.workspaceId || !agent.switchAgentId)
    throw new Error('The agent is not linked to Switch.');
  const location = await getAgentLocation(agent);
  const ctx = location.sshHost
    ? (await connectRemoteAgent(agent)).ctx
    : new LocalExecutionContext();
  return { agent, location, ctx };
}

export async function sharedAgentDiagnostics(agentId: string) {
  const { agent, location, ctx } = await agentHost(agentId);
  const [host, bundle, remote] = await Promise.all([
    ctx.exec('node', ['-e', inspectWatchers, agent.switchAgentId!, 'status']),
    readFile(resolveSharedHostBundlePath()),
    listHostSessions(agentId).then(
      (sessions) => ({ sessions, error: null }),
      (error: unknown) => ({ sessions: null, error: redactSecrets(String(error)) })
    ),
  ]);
  return {
    workingDir: location.dir,
    transport: location.sshHost ? ('ssh' as const) : ('local' as const),
    availableBuildHash: createHash('sha256').update(bundle).digest('hex'),
    watchers: watcherSchema
      .array()
      .parse(JSON.parse(host.stdout))
      .map((watcher) => ({
        ...watcher,
        failure: watcher.failure ? redactSecrets(watcher.failure) : null,
        takenOver: watcher.takenOver
          ? { ...watcher.takenOver, reason: redactSecrets(watcher.takenOver.reason) }
          : null,
      })),
    sessions: remote.sessions?.filter((session) => session.agentId === agent.switchAgentId) ?? null,
    sessionError: remote.error,
  };
}

export async function sharedAgentLogs(agentId: string): Promise<string> {
  const { agent, ctx } = await agentHost(agentId);
  const result = await ctx.exec('node', ['-e', inspectWatchers, agent.switchAgentId!, 'logs']);
  return redactSecrets(z.string().parse(JSON.parse(result.stdout)));
}

/**
 * The watcher's state as its files on the host record it: why a sidecar that
 * cannot be reached stopped, or that it stood down for another client.
 */
export async function remoteWatcherStatus(agentId: string) {
  const { agent, ctx } = await agentHost(agentId);
  const host = await ctx.exec('node', ['-e', inspectWatchers, agent.switchAgentId!, 'status']);
  return watcherSchema.array().parse(JSON.parse(host.stdout))[0] ?? null;
}
