import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  connectHost,
  prepareGeminiHome,
  type HostConnection,
  type HostStartRequest,
} from '@switch-console/agent-providers';
import type { ClientCommand } from '@switch-console/shared/session-v1';
import { getAgentById } from '@main/core/agents/getAgentById';
import { resolveDatabasePath } from '@main/db/path';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { prepareCodexSessionHome } from '../agent-runtime/impl/codex-session-home';
import {
  fetchSdkSessions,
  fetchSdkSnapshot,
  fetchSdkEvents,
  fetchSdkCommandStatus,
  submitSdkCommand,
} from '../switch-servers/gateway-client';
import { getServer } from '../switch-servers/servers-store';

let connecting: Promise<HostConnection> | null = null;
function host(): Promise<HostConnection> {
  if (!connecting) {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM'])
      if (process.env[key]) env[key] = process.env[key]!;
    env.ELECTRON_RUN_AS_NODE = '1';
    const entrypoint = createRequire(import.meta.url).resolve(
      '@switch-console/agent-providers/host-daemon'
    );
    connecting = connectHost(
      `${resolveDatabasePath()}.sdk-host`,
      process.execPath,
      entrypoint,
      env
    ).catch((error: unknown) => {
      connecting = null;
      throw error;
    });
  }
  return connecting;
}
async function runHost<T>(operation: (connection: HostConnection) => Promise<T>): Promise<T> {
  try {
    return await operation(await host());
  } catch (error) {
    connecting = null;
    throw error;
  }
}
async function sharedServer(serverId: string) {
  const server = await getServer(serverId);
  if (!server) throw new Error('Switch server not found.');
  return server;
}
export const sdkHostController = createRPCController({
  serverForAgent: async (agentId: string) => {
    const agent = await getAgentById(agentId);
    if (!agent?.serverId) throw new Error('This agent has no Switch server.');
    return agent.serverId;
  },
  sharedList: async (serverId: string) => fetchSdkSessions(await sharedServer(serverId)),
  sharedSnapshot: async (serverId: string, sessionId: string) =>
    fetchSdkSnapshot(await sharedServer(serverId), sessionId),
  sharedEvents: async (serverId: string, sessionId: string, after: number) =>
    fetchSdkEvents(await sharedServer(serverId), sessionId, after),
  sharedSubmit: async (serverId: string, command: ClientCommand) =>
    submitSdkCommand(await sharedServer(serverId), command),
  sharedCommandStatus: async (serverId: string, sessionId: string, commandId: string) =>
    fetchSdkCommandStatus(await sharedServer(serverId), sessionId, commandId),
  list: async () => runHost((connection) => connection.list()),
  start: async (input: { provider: HostStartRequest['provider']; cwd: string }) => {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM'])
      if (process.env[key]) env[key] = process.env[key]!;
    const sessionId = crypto.randomUUID();
    if (input.provider === 'gemini')
      env.GEMINI_CLI_HOME = await prepareGeminiHome({
        root: `${resolveDatabasePath()}.sdk-provider-homes`,
        sessionId,
        sourceHome: join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini'),
        context: '',
        mcpServerNames: [],
      });
    if (input.provider === 'codex')
      env.CODEX_HOME = await prepareCodexSessionHome({
        root: `${resolveDatabasePath()}.sdk-provider-homes`,
        sessionId,
        sourceHome: process.env.CODEX_HOME || join(homedir(), '.codex'),
        config: '',
        skill: '',
      });
    return runHost((connection) =>
      connection.start({
        provider: input.provider,
        input: {
          sessionId,
          cwd: input.cwd,
          env,
          mcpServers: {},
          runtimeMode: 'approval-required',
        },
      })
    );
  },
  snapshot: async (sessionId: string) =>
    runHost((connection) => connection.snapshot(sessionId, null)),
  events: async (sessionId: string, after: number) =>
    runHost((connection) =>
      connection.request(`/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`)
    ),
  submit: async (command: ClientCommand) => runHost((connection) => connection.submit(command)),
  commandStatus: async (sessionId: string, commandId: string) =>
    runHost((connection) => connection.commandStatus(sessionId, commandId)),
});
