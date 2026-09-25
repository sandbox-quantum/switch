import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { buildSharedHostConfig } from './build-shared-config';
import { WorkerObsoleteError } from './exit-codes';
import {
  ensureHostedRepository,
  githubLaunchEnvironment,
  githubRedactions,
  prepareGitHubCli,
  readGitHubCredential,
  renewGitHubCredential,
  validateGitHubCredential,
} from './hosted-github';
import { redactHostedText } from './hosted-log';
import { fetchHostedProvider, hostedRequest, materializeHostedProvider } from './hosted-provider';
import { checkProviderReadiness } from './provider-readiness';
import { sharedConfigSchema, type SharedHostConfig } from './shared-config';
import type { superviseSharedHost } from './supervisor';
import { WATCH_FLAGS_FILE } from './watch-flags';
import { writeWorkerCapability } from './worker-capability';

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), 'must be an absolute path');
const identifier = z.string().min(1).max(200);

export const hostedDeploymentSpecSchema = z
  .strictObject({
    version: z.literal(1),
    /** The launch revision this deployment was issued for. */
    revision: z.number().int().positive(),
    session: z.strictObject({ sessionId: identifier, agentId: identifier }),
    provider: z.strictObject({
      kind: z.enum(['claude', 'codex', 'opencode', 'cursor', 'antigravity']),
      credential: z.strictObject({
        kind: z.enum(['api-key', 'setup-token', 'auth-json']),
        refresh: z.literal(true).optional(),
        path: absolutePath,
      }),
      binaryPath: absolutePath,
      model: z
        .strictObject({
          id: z.string().min(1),
          options: z.record(z.string(), z.string()).optional(),
        })
        .optional(),
      context: z.string(),
      definition: z
        .strictObject({
          name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
          content: z.string().min(1).max(65536),
        })
        .optional(),
    }),
    github: z
      .strictObject({
        credentialPath: absolutePath,
        repository: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/)
          .optional(),
        refresh: z.literal(true).optional(),
      })
      .optional(),
    workspacePath: absolutePath,
    /** Whether the watcher may start a session for an addressed room message. */
    watch: z.boolean(),
    runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'full-access']),
    switchCredentialsPath: absolutePath,
    workerCapabilityPath: absolutePath,
  })
  .refine((spec) => !spec.github?.refresh || spec.github.repository !== undefined, {
    message: 'GitHub credential renewal requires a selected repository.',
  });
export type HostedDeploymentSpec = z.infer<typeof hostedDeploymentSpecSchema>;

const hostedDeploymentPlanSchema = z.strictObject({
  version: z.literal(1),
  spec: hostedDeploymentSpecSchema,
  config: sharedConfigSchema,
});
type HostedDeploymentPlan = z.infer<typeof hostedDeploymentPlanSchema>;

const INHERITED_ENV = ['PATH', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM'] as const;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const PLAN_FILE = 'hosted-deployment.json';
const CONFIG_FILE = 'config.json';

function credentialVariable(provider: HostedDeploymentSpec['provider']): string {
  if (provider.kind === 'claude')
    return provider.credential.kind === 'api-key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
  if (provider.kind === 'codex' && provider.credential.kind === 'api-key') return 'OPENAI_API_KEY';
  if (provider.kind === 'cursor') return 'CURSOR_API_KEY';
  return 'SWITCH_HOSTED_AUTH_JSON';
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function readJson(path: string, failure: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(failure);
  }
}

async function resolveCredentialFile(
  path: string,
  stateRoot: string,
  workspaceRoot: string,
  label: string
): Promise<string> {
  if (isWithin(stateRoot, resolve(path)) || isWithin(workspaceRoot, resolve(path)))
    throw new Error(
      `${label} credential file must be mounted outside the state and workspace directories.`
    );
  let resolved: string;
  try {
    resolved = await realpath(path);
    const details = await stat(resolved);
    if (!details.isFile() || details.size > MAX_CREDENTIAL_BYTES) throw new Error();
  } catch {
    throw new Error(`${label} credential file is missing or invalid.`);
  }
  if (isWithin(stateRoot, resolved) || isWithin(workspaceRoot, resolved))
    throw new Error(
      `${label} credential file must be mounted outside the state and workspace directories.`
    );
  return resolved;
}

async function readWorkerCapability(path: string): Promise<string> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    if (!/^[\x21-\x7e]{16,4096}$/.test(value)) throw new Error();
    return value;
  } catch {
    throw new Error('Worker capability file is missing or invalid.');
  }
}

function machineIdentity(): { instanceId: string; bootId: string } {
  const instanceId = process.env.SWITCH_HOST_INSTANCE_ID;
  const bootId = process.env.SWITCH_HOST_BOOT_ID;
  if (!instanceId || !bootId)
    throw new Error(
      'A hosted worker requires SWITCH_HOST_INSTANCE_ID and SWITCH_HOST_BOOT_ID from its launcher.'
    );
  return { instanceId, bootId };
}

async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  await rename(temporary, path);
}

async function readProviderCredential(path: string): Promise<string> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    if (!value || Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES || /[\0\r\n]/.test(value))
      throw new Error();
    return value;
  } catch {
    throw new Error('Provider credential file is missing or invalid.');
  }
}

async function validateSwitchCredentials(
  path: string,
  agentId: string
): Promise<{ token: string }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Switch credential file is missing or invalid.');
  }
  if (!value || typeof value !== 'object' || !('env' in value)) {
    throw new Error('Switch credential file is missing or invalid.');
  }
  const env = value.env;
  if (
    !env ||
    typeof env !== 'object' ||
    !('SWITCH_API_ENDPOINT' in env) ||
    typeof env.SWITCH_API_ENDPOINT !== 'string' ||
    !env.SWITCH_API_ENDPOINT ||
    !('SWITCH_API_TOKEN' in env) ||
    typeof env.SWITCH_API_TOKEN !== 'string' ||
    !env.SWITCH_API_TOKEN ||
    !('SWITCH_AGENT_ID' in env) ||
    typeof env.SWITCH_AGENT_ID !== 'string' ||
    !env.SWITCH_AGENT_ID
  )
    throw new Error('Switch credential file is missing or invalid.');
  try {
    const endpoint = new URL(env.SWITCH_API_ENDPOINT);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error();
  } catch {
    throw new Error('Switch credential file contains an invalid endpoint.');
  }
  if (env.SWITCH_AGENT_ID !== agentId)
    throw new Error('Switch credential file belongs to a different agent.');
  return { token: env.SWITCH_API_TOKEN };
}

async function writeNewJson(path: string, value: unknown): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    await unlink(temporary);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

/**
 * The worker's homes. A provider's native login lives where
 * `materializeHostedProvider` writes it, so the sessions read the login the
 * worker fetched.
 */
function controlledEnvironment(
  root: string,
  provider: HostedDeploymentSpec['provider']['kind']
): Record<string, string> {
  return {
    HOME: join(root, 'home'),
    CLAUDE_CONFIG_DIR: join(root, 'provider-home', 'claude'),
    XDG_CACHE_HOME: join(root, 'xdg', 'cache'),
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
    XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'),
    TMPDIR: join(root, 'tmp'),
    ...(provider === 'codex' ? { CODEX_HOME: join(root, 'provider-home') } : {}),
    ...(provider === 'opencode' ? { XDG_DATA_HOME: join(root, 'provider-data') } : {}),
    ...(provider === 'antigravity' ? { GEMINI_HOME: join(root, 'provider-home') } : {}),
  };
}

async function createControlledDirectories(environment: Record<string, string>): Promise<void> {
  await Promise.all(
    Object.values(environment).map((path) => mkdir(path, { recursive: true, mode: 0o700 }))
  );
}

async function loadPlan(path: string): Promise<HostedDeploymentPlan> {
  try {
    return hostedDeploymentPlanSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    throw new Error('Saved hosted deployment state is missing or invalid.');
  }
}

async function loadConfig(path: string): Promise<SharedHostConfig> {
  try {
    return sharedConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    throw new Error('Saved hosted launch configuration is invalid.');
  }
}

export async function readHostedDeploymentSpec(path: string): Promise<HostedDeploymentSpec> {
  const value = await readJson(path, 'Hosted deployment specification is missing or invalid.');
  const result = hostedDeploymentSpecSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join('.') || 'root';
    throw new Error(
      `Hosted deployment specification is invalid at ${field}: ${issue?.message ?? 'invalid value'}.`
    );
  }
  return result.data;
}

export interface PreparedHostedDeployment {
  root: string;
  configPath: string;
  config: SharedHostConfig;
  providerEnvironment: NodeJS.ProcessEnv;
  logRedactions: string[];
}

/**
 * Write the deployment's agent definition into the workspace. A definition
 * already there must match unless the deployment moved to a newer revision,
 * which replaces it.
 */
async function writeDefinition(spec: HostedDeploymentSpec, replace: boolean): Promise<void> {
  if (!spec.provider.definition) return;
  const directory = join(spec.workspacePath, '.claude', 'agents');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!isWithin(await realpath(spec.workspacePath), await realpath(directory)))
    throw new Error('Cloud agent definition directory must stay inside the workspace.');
  const path = join(directory, `${spec.provider.definition.name}.md`);
  if (replace) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(spec.provider.definition.content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    return;
  }
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(spec.provider.definition.content);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (
      !isWithin(await realpath(spec.workspacePath), await realpath(path)) ||
      (await readFile(path, 'utf8')) !== spec.provider.definition.content
    )
      throw new Error('The saved cloud agent definition differs from the deployment.');
  }
}

export async function prepareHostedDeployment(
  stateDirectory: string,
  spec: HostedDeploymentSpec
): Promise<PreparedHostedDeployment> {
  if (process.platform === 'win32')
    throw new Error('Hosted SDK bootstrap requires a POSIX execution environment.');
  if (!isAbsolute(stateDirectory))
    throw new Error('Hosted SDK state directory must be an absolute path.');
  if (resolve(stateDirectory) === resolve('/'))
    throw new Error('Hosted SDK state directory cannot be the filesystem root.');
  const machine = machineIdentity();
  try {
    const existing = await stat(stateDirectory);
    if (!existing.isDirectory()) throw new Error('not-directory');
    if (process.getuid && existing.uid !== process.getuid()) throw new Error('wrong-owner');
    if ((existing.mode & 0o077) !== 0) throw new Error('not-private');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Hosted SDK state directory must be a private directory owned by this user.');
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  }
  const root = await realpath(stateDirectory);
  let binaryPath: string;
  try {
    binaryPath = await realpath(spec.provider.binaryPath);
    if (!(await stat(binaryPath)).isFile()) throw new Error();
    await access(binaryPath, constants.X_OK);
  } catch {
    throw new Error('Claude executable is missing or is not executable.');
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(spec.workspacePath);
    if (!(await stat(workspaceRoot)).isDirectory()) throw new Error();
  } catch {
    throw new Error('Hosted workspace is missing or is not a directory.');
  }
  if (isWithin(root, workspaceRoot) || isWithin(workspaceRoot, root))
    throw new Error('Hosted state and workspace directories must not overlap.');
  const switchCredentialsPath = await resolveCredentialFile(
    spec.switchCredentialsPath,
    root,
    workspaceRoot,
    'Switch'
  );
  const workerCapability = await readWorkerCapability(
    await resolveCredentialFile(spec.workerCapabilityPath, root, workspaceRoot, 'Worker capability')
  );
  const githubCredentialPath = spec.github
    ? await resolveCredentialFile(spec.github.credentialPath, root, workspaceRoot, 'GitHub')
    : undefined;
  const providerCredential = spec.provider.credential.refresh
    ? null
    : await readProviderCredential(
        await resolveCredentialFile(spec.provider.credential.path, root, workspaceRoot, 'Provider')
      );
  const switchCredentials = await validateSwitchCredentials(
    switchCredentialsPath,
    spec.session.agentId
  );
  const githubCredential = githubCredentialPath
    ? spec.github?.refresh
      ? await renewGitHubCredential(switchCredentialsPath, spec.github.repository)
      : await readGitHubCredential(githubCredentialPath)
    : undefined;
  if (githubCredential) await validateGitHubCredential(githubCredential, spec.github?.repository);
  const controlled = controlledEnvironment(root, spec.provider.kind);
  await createControlledDirectories(controlled);
  const environment = {
    ...controlled,
    ...(githubCredential ? githubLaunchEnvironment() : {}),
    ...(spec.github?.refresh
      ? {
          SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS: switchCredentialsPath,
          SWITCH_HOSTED_GITHUB_REPOSITORY: spec.github.repository!,
          PATH: `${await prepareGitHubCli(root)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        }
      : {}),
  };
  const variable = credentialVariable(spec.provider);
  const candidate = hostedDeploymentPlanSchema.parse(
    JSON.parse(
      JSON.stringify({
        version: 1,
        spec,
        config: buildSharedHostConfig({
          session: {
            sessionId: spec.session.sessionId,
            agentId: spec.session.agentId,
            provider: spec.provider.kind,
          },
          launch: {
            cwd: workspaceRoot,
            runtimeMode: spec.runtimeMode,
            env: environment,
            model: spec.provider.model,
          },
          capabilities: { approvals: true, userInput: true },
          execution: {
            credentialsPath: switchCredentialsPath,
            inheritEnv: [
              ...INHERITED_ENV,
              variable,
              ...(githubCredential && !spec.github?.refresh ? ['GH_TOKEN'] : []),
            ],
            binaryPath,
            codexConfig: '',
            skill: '',
            context: spec.provider.context,
            agentDefinition: spec.provider.definition
              ? {
                  name: spec.provider.definition.name,
                  path: `.claude/agents/${spec.provider.definition.name}.md`,
                }
              : undefined,
          },
          ids: {
            hostId: randomUUID(),
            epoch: randomUUID(),
            connectionId: randomUUID(),
          },
        }),
      })
    )
  );
  const planPath = join(root, PLAN_FILE);
  let plan: HostedDeploymentPlan;
  try {
    plan = await loadPlan(planPath);
  } catch (error) {
    try {
      await stat(planPath);
      throw error;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (await writeNewJson(planPath, candidate)) {
      await syncDirectory(root);
      plan = candidate;
    } else {
      plan = await loadPlan(planPath);
    }
  }
  if (!plan.config.roomConnection)
    throw new Error('Saved hosted deployment state is missing its room connection.');
  const expectedConfig = structuredClone(candidate.config);
  expectedConfig.session.hostId = plan.config.session.hostId;
  expectedConfig.session.epoch = plan.config.session.epoch;
  expectedConfig.roomConnection!.connectionId = plan.config.roomConnection.connectionId;
  const configPath = join(root, CONFIG_FILE);
  if (spec.revision < plan.spec.revision)
    throw new Error(
      `Hosted deployment revision ${spec.revision} is older than the saved revision ${plan.spec.revision}.`
    );
  if (spec.revision > plan.spec.revision) {
    // The plan is the commit point: a crash before it is replaced repeats this revision.
    const revised = { version: 1 as const, spec, config: expectedConfig };
    await writeDefinition(spec, true);
    await replaceJson(configPath, revised.config);
    await replaceJson(planPath, revised);
    await syncDirectory(root);
    plan = revised;
  }
  if (!sameValue(plan.spec, spec))
    throw new Error(
      'Hosted deployment specification differs from the saved state; review the saved assignment before starting a different deployment.'
    );
  if (!sameValue(plan.config, expectedConfig))
    throw new Error(
      'Saved hosted deployment configuration does not match its deployment specification.'
    );
  try {
    const saved = await loadConfig(configPath);
    if (!sameValue(saved, plan.config))
      throw new Error('Saved hosted launch configuration differs from the deployment plan.');
  } catch (error) {
    try {
      await stat(configPath);
      throw error;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (await writeNewJson(configPath, plan.config)) await syncDirectory(root);
    else if (!sameValue(await loadConfig(configPath), plan.config))
      throw new Error('Saved hosted launch configuration differs from the deployment plan.');
  }
  const providerEnvironment: NodeJS.ProcessEnv = { ...environment };
  await replaceJson(join(root, WATCH_FLAGS_FILE), { enabled: true, spawn: spec.watch });
  await writeWorkerCapability(root, workerCapability);
  await syncDirectory(root);
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined && providerEnvironment[key] === undefined)
      providerEnvironment[key] = value;
  }
  if (providerCredential !== null) providerEnvironment[variable] = providerCredential;
  if (githubCredential && !spec.github?.refresh) providerEnvironment.GH_TOKEN = githubCredential;
  providerEnvironment.SWITCH_HOSTED_BOOTSTRAP = '1';
  providerEnvironment.SWITCH_HOST_INSTANCE_ID = machine.instanceId;
  providerEnvironment.SWITCH_HOST_BOOT_ID = machine.bootId;
  return {
    root,
    configPath,
    config: plan.config,
    providerEnvironment,
    logRedactions: [
      ...(providerCredential === null ? [] : [providerCredential]),
      switchCredentials.token,
      workerCapability,
      ...(githubCredential ? githubRedactions(githubCredential) : []),
    ],
  };
}

export interface HostedBootstrapDependencies {
  supervise: typeof superviseSharedHost;
}

export async function runHostedBootstrap(
  input: {
    stateDirectory: string;
    specPath: string;
    sharedDaemonEntrypoint: string;
    signal: AbortSignal;
  },
  dependencies: HostedBootstrapDependencies
): Promise<void> {
  const spec = await readHostedDeploymentSpec(input.specPath);
  const prepared = await prepareHostedDeployment(input.stateDirectory, spec);
  try {
    const credential = await fetchHostedProvider(prepared.config);
    if (credential.status === 'connected') prepared.logRedactions.push(credential.credential);
    const env = Object.fromEntries(
      Object.entries(prepared.providerEnvironment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    );
    await materializeHostedProvider(prepared.root, env, credential, spec.provider.binaryPath);
    const readiness = await checkProviderReadiness({
      provider: spec.provider.kind,
      binaryPath: spec.provider.binaryPath,
      cwd: spec.workspacePath,
      env,
    });
    if (credential.status !== 'connected')
      throw new Error('Reconnect the provider before starting the worker.');
    if (readiness.status === 'unknown') throw new Error(readiness.message);
    await hostedRequest(prepared.config, '/provider-status', {
      authenticated: readiness.status === 'authenticated',
      revision: credential.revision,
    });
    if (readiness.status !== 'authenticated')
      throw new Error(
        'The provider rejected the saved sign-in. Sign in again and reconnect the provider in Switch Console.'
      );
    Object.assign(prepared.providerEnvironment, env);
    if (spec.github?.refresh && spec.github.repository)
      await ensureHostedRepository(
        spec.workspacePath,
        spec.github.repository,
        prepared.providerEnvironment
      );
    await writeDefinition(spec, false);
    await dependencies.supervise({
      root: prepared.root,
      executable: process.execPath,
      args: [input.sharedDaemonEntrypoint, prepared.root, prepared.configPath, '--watch-worker'],
      env: prepared.providerEnvironment,
      signal: input.signal,
      build: input.sharedDaemonEntrypoint,
      links: null,
      logRedactions: prepared.logRedactions,
    });
  } catch (error) {
    if (error instanceof WorkerObsoleteError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactHostedText(message, prepared.logRedactions));
  }
}
