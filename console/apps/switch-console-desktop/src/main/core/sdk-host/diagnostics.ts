import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sessionSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { resolveSharedHostBundlePath } from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { locationWhereAgentRuns } from '@main/core/agents/observed-guard';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { fetchSdkSessions } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { redactSecrets } from '@main/lib/file-logger';
import { inspectWatchers } from './watcher-inspection';

const watcherSchema = z.object({
  running: z.boolean(),
  enabled: z.boolean(),
  failure: z.string().nullable(),
  pid: z.number().int().positive().nullable(),
  supervisorPid: z.number().int().positive().nullable(),
  buildHash: z.string().nullable(),
});

async function agentHost(agentId: string) {
  const agent = await getAgentById(agentId);
  if (!agent?.serverId || !agent.switchAgentId)
    throw new Error('The agent is not linked to Switch.');
  // An observed agent's host and watcher are under its owner's account
  // (CHOO-2893); looking in this account's would report nothing, as if it
  // were not running.
  const location = await locationWhereAgentRuns(agent);
  const ctx = location.sshHost
    ? (await connectRemoteAgent(agent)).ctx
    : new LocalExecutionContext();
  return { agent, location, ctx };
}

export async function sharedAgentDiagnostics(agentId: string) {
  const { agent, location, ctx } = await agentHost(agentId);
  const server = await getServer(agent.serverId!);
  if (!server) throw new Error('The agent’s Switch server is missing.');
  const [host, bundle, remote] = await Promise.all([
    ctx.exec('node', ['-e', inspectWatchers, agent.switchAgentId!, 'status']),
    readFile(resolveSharedHostBundlePath()),
    fetchSdkSessions(server).then(
      (sessions) => ({ sessions: sessionSchema.array().parse(sessions), error: null }),
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
