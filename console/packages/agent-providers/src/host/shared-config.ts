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
import {
  grantedSkills,
  readServiceGrants,
  type ServiceGrant,
  skillContext,
} from './service-access';
import type { ServiceEndpointServer } from './service-endpoint';
import { githubSessionEnvironment, writeGitHubWrapper } from './service-github';

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
      /**
       * The agent's own instructions, alone (they are also part of
       * `context`). What a running conversation is told when they change.
       * Absent from configurations written before it existed.
       */
      instructions: z.string().optional(),
      /**
       * A definition on the host's disk to run as, named by an earlier Console.
       * Sessions saved then still relaunch from it; a current Console hands the
       * definition over in `start.input` instead.
       */
      agentDefinition: z
        .strictObject({ name: z.string().min(1), path: z.string().min(1) })
        .optional(),
    })
    .optional(),
});
export type SharedHostConfig = z.infer<typeof sharedConfigSchema>;

/** The agent's services as a session starts: its grants, or why Switch could not say. */
export type SessionServices = {
  /** Empty when the grants could not be read. */
  grants: ServiceGrant[];
  /** Why the grants could not be read, or null. */
  unavailable: string | null;
};

/**
 * Where a session's helpers get its service tokens (`service-endpoint.ts`),
 * and the bundle they run from: this host's own, on this host's runtime.
 */
export type ServiceHelpers = {
  endpoint: Pick<ServiceEndpointServer, 'url' | 'token'>;
  execPath: string;
  entrypoint: string;
};

/**
 * Whether the session gets Switch's Git credential helper and `gh` wrapper:
 * for a GitHub grant, and when the grants could not be read, so that the
 * helpers refuse rather than leave git and gh to this machine's own sign-in.
 */
export function needsGitHubHelpers(services: SessionServices): boolean {
  return (
    services.unavailable !== null || services.grants.some((grant) => grant.service === 'github')
  );
}

/** What a session is told when its agent's grants could not be read as it started. */
export function servicesUnavailableNotice(reason: string): string {
  return (
    `Switch could not load the services granted to this agent when this session started (${reason}). ` +
    "Their skills and access (GitHub's, for one) are not set up in this session, so do not rely on " +
    "them, and say so when a task needs one: git and gh refuse GitHub through Switch here rather than use this machine's own sign-in. " +
    'They are loaded again when the session next starts.'
  );
}

/**
 * What the provider is started with. Its Switch tools are `runtime`, the MCP
 * server this host serves on loopback: no Switch credential, connection or
 * session name reaches the CLI or its environment. With `helpers`, an agent
 * granted GitHub gets Git's credential helper and the `gh` wrapper, which ask
 * the session's service endpoint for the token.
 */
export async function prepareSharedConfig(
  root: string,
  config: SharedHostConfig,
  runtime: HttpMcpServerSpec,
  services: SessionServices,
  helpers: ServiceHelpers | null
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
        auth: process.env.SWITCH_HOSTED_BOOTSTRAP === '1' ? 'refresh' : 'copy-once',
      });
    // The skills of the agent's grants join the context for every provider
    // but OpenCode, which loads them as files (`adapterFor`), as it does the
    // Switch skill. Added here rather than saved with the session, so a
    // resume takes the grants as they are then.
    input.systemContext = [
      execution.context,
      ...(config.start.provider === 'opencode'
        ? []
        : grantedSkills(services.grants).map(skillContext)),
      ...(services.unavailable ? [servicesUnavailableNotice(services.unavailable)] : []),
    ]
      .filter(Boolean)
      .join('\n\n');
    if (helpers && needsGitHubHelpers(services)) {
      const wrapperDirectory = join(root, 'bin');
      await writeGitHubWrapper({
        directory: wrapperDirectory,
        execPath: helpers.execPath,
        entrypoint: helpers.entrypoint,
      });
      input.env = {
        ...input.env,
        ...githubSessionEnvironment({
          env: input.env,
          execPath: helpers.execPath,
          entrypoint: helpers.entrypoint,
          wrapperDirectory,
          // A cloud deployment keeps every other credential helper out.
          isolate: process.env.SWITCH_HOSTED_BOOTSTRAP === '1',
        }),
        SWITCH_SERVICE_ENDPOINT: helpers.endpoint.url,
        SWITCH_SERVICE_TOKEN: helpers.endpoint.token,
      };
    }
  }
  input.mcpServers.switch = runtime;
  if (!agentApiUrl || !token)
    throw new Error('Shared SDK host requires execution-host Switch credentials.');
  return { agentApiUrl, token, input };
}

/**
 * The agent's service grants, read as this session starts.
 *
 * A session starts without them when Switch cannot tell it what they are: its
 * Switch tools and the rest of its work do not depend on them. It is told so
 * (`servicesUnavailableNotice`), and the log says why.
 */
export async function sessionServiceGrants(config: SharedHostConfig): Promise<SessionServices> {
  if (!config.execution) return { grants: [], unavailable: null };
  try {
    const credentials = await readSharedCredentials(config);
    const grants = await readServiceGrants({
      endpoint: credentials.SWITCH_API_ENDPOINT,
      token: credentials.SWITCH_API_TOKEN,
      agentId: credentials.SWITCH_AGENT_ID,
    });
    return { grants, unavailable: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `Session ${config.session.sessionId} starts without its agent's service grants: ${reason}`
    );
    return { grants: [], unavailable: reason };
  }
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
