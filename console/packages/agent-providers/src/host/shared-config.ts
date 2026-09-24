import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sessionSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import type { HttpMcpServerSpec } from '../adapter';
import { prepareCodexSessionHome } from '../codex/home';
import { roomConnectionSchema } from './room-inbox';
import { startSchema } from './server';

export const sharedConfigSchema = z.strictObject({
  session: sessionSchema,
  resumeOperationId: z.string().uuid().optional(),
  start: startSchema,
  roomConnection: roomConnectionSchema.optional(),
  /**
   * The room delivery this session was started to answer, and the right the
   * server issued to start it.
   *
   * Sent with the session's first claim, so the session is created already
   * holding the room instead of created empty and then binding it: between
   * those two writes the room is free, and the next delivery for it would be
   * answered by starting a second session. Absent from a session nobody
   * addressed a room message to.
   */
  grant: z.strictObject({ roomId: z.string().min(1), messageId: z.string().min(1) }).optional(),
  execution: z
    .strictObject({
      credentialsPath: z.string().min(1),
      inheritEnv: z.array(z.string()),
      shellSetup: z.string().optional(),
      binaryPath: z.string().min(1).optional(),
      /** Written by Consoles that registered an npx runtime; read by nothing. */
      mcpRuntime: z.string().min(1).optional(),
      codexConfig: z.string(),
      skill: z.string(),
      context: z.string(),
      agentDefinition: z
        .strictObject({ name: z.string().min(1), path: z.string().min(1) })
        .optional(),
    })
    .optional(),
});
export type SharedHostConfig = z.infer<typeof sharedConfigSchema>;

/**
 * What the provider is started with. Its Switch tools are `runtime`, the MCP
 * server this host serves on loopback: no Switch credential, connection or
 * session name reaches the CLI or its environment.
 */
export async function prepareSharedConfig(
  root: string,
  config: SharedHostConfig,
  runtime: HttpMcpServerSpec
) {
  if (config.session.provider !== config.start.provider)
    throw new Error('Shared SDK host provider mismatch.');
  let agentApiUrl = process.env.SWITCH_API_ENDPOINT;
  let token = process.env.SWITCH_API_TOKEN;
  const input = structuredClone(config.start.input);
  if (config.execution) {
    const execution = config.execution;
    if (execution.agentDefinition) {
      try {
        if (!(await stat(join(input.cwd, execution.agentDefinition.path))).isFile())
          throw new Error('The provider agent definition is not a file.');
        input.agentName = execution.agentDefinition.name;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const credentials = await readSharedCredentials(config);
    agentApiUrl = credentials.SWITCH_API_ENDPOINT;
    token = credentials.SWITCH_API_TOKEN;
    const inherited = await executionEnvironment(
      input.cwd,
      input.env,
      execution.shellSetup,
      execution.inheritEnv
    );
    input.env = { ...inherited, ...input.env };
    if (config.start.provider === 'codex')
      input.env.CODEX_HOME = await prepareCodexSessionHome({
        root: join(root, 'provider-home'),
        sessionId: config.session.sessionId,
        sourceHome: input.env.CODEX_HOME || join(homedir(), '.codex'),
        config: execution.codexConfig,
        skill: execution.skill,
      });
    if (config.start.provider !== 'codex') input.systemContext = execution.context;
  }
  input.mcpServers.switch = runtime;
  if (!agentApiUrl || !token)
    throw new Error('Shared SDK host requires execution-host Switch credentials.');
  return { agentApiUrl, token, input };
}

export async function readSharedCredentials(config: SharedHostConfig) {
  if (!config.execution) throw new Error('Shared execution credentials are required.');
  const credentials = z
    .object({
      env: z.object({
        SWITCH_API_ENDPOINT: z.string().min(1),
        SWITCH_API_TOKEN: z.string().min(1),
        SWITCH_AGENT_ID: z.string().min(1),
      }),
    })
    .parse(JSON.parse(await readFile(config.execution.credentialsPath, 'utf8'))).env;
  if (credentials.SWITCH_AGENT_ID !== config.session.agentId)
    throw new Error('The execution host credentials belong to a different agent.');
  return credentials;
}

export async function executionEnvironment(
  cwd: string,
  configured: Record<string, string>,
  setup: string | undefined,
  inheritEnv: string[]
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      inheritEnv.includes(key) &&
      !key.startsWith('SWITCH_') &&
      !key.startsWith('ELECTRON_')
    )
      env[key] = value;
  Object.assign(env, configured);
  if (!setup) return env;
  if (process.platform === 'win32')
    throw new Error('SDK shell setup requires a POSIX execution host.');
  const marker = randomUUID();
  const { stdout } = await promisify(execFile)(
    env.SHELL || '/bin/sh',
    [
      '-lc',
      `set -e\n${setup}\nexec "$@"`,
      'sdk-environment',
      process.execPath,
      '-e',
      `process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(process.env))`,
    ],
    { cwd, env, timeout: 30000, maxBuffer: 1024 * 1024 }
  );
  const offset = stdout.lastIndexOf(marker);
  if (offset < 0) throw new Error('Shell setup did not return the execution environment.');
  return z.record(z.string(), z.string()).parse(JSON.parse(stdout.slice(offset + marker.length)));
}
