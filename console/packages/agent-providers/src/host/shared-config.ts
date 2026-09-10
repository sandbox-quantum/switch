import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { prepareCodexSessionHome } from '../codex/home';
import { prepareGeminiHome } from '../gemini/home';
import { roomConnectionSchema } from './room-inbox';
import { startSchema } from './server';

export const sharedConfigSchema = z.strictObject({
  session: sessionSchema,
  start: startSchema,
  roomConnection: roomConnectionSchema.optional(),
  execution: z
    .strictObject({
      credentialsPath: z.string().min(1),
      inheritEnv: z.array(z.string()),
      mcpRuntime: z.string().min(1),
      codexConfig: z.string(),
      skill: z.string(),
      context: z.string(),
    })
    .optional(),
});
export type SharedHostConfig = z.infer<typeof sharedConfigSchema>;

export async function prepareSharedConfig(root: string, config: SharedHostConfig) {
  if (config.session.provider !== config.start.provider)
    throw new Error('Shared SDK host provider mismatch.');
  let agentApiUrl = process.env.SWITCH_API_ENDPOINT;
  let token = process.env.SWITCH_API_TOKEN;
  const input = structuredClone(config.start.input);
  if (config.execution) {
    const execution = config.execution;
    const credentials = z
      .object({
        env: z.object({
          SWITCH_API_ENDPOINT: z.string().min(1),
          SWITCH_API_TOKEN: z.string().min(1),
          SWITCH_AGENT_ID: z.string().min(1),
        }),
      })
      .parse(JSON.parse(await readFile(execution.credentialsPath, 'utf8'))).env;
    if (credentials.SWITCH_AGENT_ID !== config.session.agentId)
      throw new Error('The execution host credentials belong to a different agent.');
    agentApiUrl = credentials.SWITCH_API_ENDPOINT;
    token = credentials.SWITCH_API_TOKEN;
    const inherited: Record<string, string> = {};
    for (const key of execution.inheritEnv)
      if (process.env[key] !== undefined) inherited[key] = process.env[key]!;
    const switchEnv = {
      ...credentials,
      SWITCH_CONNECTION_ID: config.roomConnection?.connectionId ?? '',
      SWITCH_CHANNEL_DISABLE_POLL: '1',
    };
    if (!switchEnv.SWITCH_CONNECTION_ID)
      throw new Error('Shared SDK execution requires a persistent room connection.');
    input.env = { ...inherited, ...input.env, ...switchEnv };
    input.mcpServers.switch = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', execution.mcpRuntime],
      env: switchEnv,
    };
    if (config.start.provider === 'codex')
      input.env.CODEX_HOME = await prepareCodexSessionHome({
        root: join(root, 'provider-home'),
        sessionId: config.session.sessionId,
        sourceHome: input.env.CODEX_HOME || join(homedir(), '.codex'),
        config: execution.codexConfig,
        skill: execution.skill,
      });
    if (config.start.provider === 'gemini')
      input.env.GEMINI_CLI_HOME = await prepareGeminiHome({
        root: join(root, 'provider-home'),
        sessionId: config.session.sessionId,
        sourceHome: join(input.env.GEMINI_CLI_HOME || homedir(), '.gemini'),
        context: execution.context,
        mcpServerNames: Object.keys(input.mcpServers),
      });
    if (config.start.provider === 'cursor') input.systemContext = execution.context;
  }
  if (!agentApiUrl || !token)
    throw new Error('Shared SDK host requires execution-host Switch credentials.');
  return { agentApiUrl, token, input };
}
