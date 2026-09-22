import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sessionSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { prepareCodexSessionHome } from '../codex/home';
import { roomConnectionSchema } from './room-inbox';
import { startSchema } from './server';

export const sharedConfigSchema = z.strictObject({
  session: sessionSchema,
  resumeOperationId: z.string().uuid().optional(),
  start: startSchema,
  roomConnection: roomConnectionSchema.optional(),
  execution: z
    .strictObject({
      credentialsPath: z.string().min(1),
      inheritEnv: z.array(z.string()),
      shellSetup: z.string().optional(),
      binaryPath: z.string().min(1).optional(),
      mcpRuntime: z.string().min(1),
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
 * Where this host tells its runtime which session is calling.
 *
 * The path has to exist before either side has the values: it goes into the
 * spawn environment when the config is prepared, and is written from the host
 * loop once the session has claimed an epoch and bound a connection. Deriving
 * it from the session's own state directory keeps two sessions of one agent
 * out of each other's, with no shared namespace to collide in.
 */
export function sessionSelectorPath(root: string): string {
  return join(resolve(root), 'session-selector.json');
}

/**
 * Publish the selector the runtime sends on every operations call.
 *
 * Written whole or not at all, because the runtime reads it without
 * coordination: a torn file would be a parse error on a live tool call. Only
 * once the session has bound a connection, because the server refuses a
 * selector naming a session that has not — until then the runtime's connection
 * id is the right answer and the file's absence is what tells it so.
 */
export async function writeSessionSelector(
  root: string,
  selector: { session_id: string; host_id: string; epoch: string }
): Promise<void> {
  const path = sessionSelectorPath(root);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(selector), { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Drop a selector left by an earlier worker for this session.
 *
 * Its epoch is superseded the moment this one claims or recovers, and a
 * runtime reading it would have every call refused as stale. Nothing has
 * replaced it yet, so the file has to go rather than wait to be overwritten.
 */
export async function clearSessionSelector(root: string): Promise<void> {
  await rm(sessionSelectorPath(root), { force: true });
}

export async function prepareSharedConfig(root: string, config: SharedHostConfig) {
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
    const switchEnv = {
      ...credentials,
      SWITCH_CONNECTION_ID: config.roomConnection?.connectionId ?? '',
      SWITCH_SESSION_FILE: sessionSelectorPath(root),
      SWITCH_CHANNEL_DISABLE_POLL: '1',
    };
    if (!switchEnv.SWITCH_CONNECTION_ID)
      throw new Error('Shared SDK execution requires a persistent room connection.');
    input.env = { ...inherited, ...input.env, ...switchEnv };
    input.mcpServers.switch = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', execution.mcpRuntime],
      envVars: Object.keys(switchEnv),
    };
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
