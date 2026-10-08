import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  HOSTED_GITHUB_CLI_ENV,
  HOSTED_GITHUB_CREDENTIALS_ENV,
  prepareGitHubCli,
} from './hosted-github';
import {
  hostedCredentialSchema,
  type HostedCredential,
  materializeHostedProvider,
} from './hosted-provider';
import {
  hostedSkillsDirectory,
  hostedSkillsSchema,
  installHostedSkills,
  supportsHostedSkills,
} from './hosted-skills';
import { PLACEMENTS_FILE } from './placements';
import { sharedConfigSchema, type SharedHostConfig } from './shared-config';

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), 'must be an absolute path');
const PLAN_FILE = 'hosted-deployment.json';
const CONFIG_FILE = 'config.json';
const STATE_VERSION_FILE = 'state-version.json';
const MIGRATED_STATE_VERSION = 1;

async function readJson(path: string, failure: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(failure);
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

/**
 * An agent's homes. A provider's native login lives where
 * `materializeHostedProvider` writes it, so the sessions read the login the
 * controller handed over.
 */
export function controlledEnvironment(
  root: string,
  provider: SharedHostConfig['start']['provider']
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

/**
 * What an agents controller writes into an agent's root for its unit: the
 * connections the owner granted the agent, where it works, and what the
 * provider is given to read. Nothing is cloned: the workspace starts empty.
 */
export const hostedWorkspaceSchema = z.strictObject({
  /** Granted connection slugs; `github` sets up git's credential helper and the `gh` wrapper. */
  connections: z.array(z.string().min(1)),
  workspacePath: absolutePath,
  skills: z.union([z.tuple([]), hostedSkillsSchema]),
  instructions: z.string(),
});
export type HostedWorkspace = z.infer<typeof hostedWorkspaceSchema>;

/** Beside the agent root's `watcher/` state; read by `prepareHostedAgent`. */
export const HOSTED_WORKSPACE_FILE = 'workspace.json';
/** The systemd credential names an agent unit loads: Switch credentials, and its provider sign-in. */
export const UNIT_AGENT_CREDENTIAL = 'agent';
export const UNIT_PROVIDER_CREDENTIAL = 'provider';
const MAX_UNIT_FILE_BYTES = 64 * 1024;
/** Watcher state a worker volume kept in the agent root, which the unit's watcher keeps in `watcher/`. */
const LEGACY_WATCHER_STATE = ['assignments.jsonl', PLACEMENTS_FILE];

async function readUnitFile(path: string, failure: string): Promise<unknown> {
  try {
    if ((await stat(path)).size > MAX_UNIT_FILE_BYTES) throw new Error();
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(failure);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * A worker volume's agent root, brought to the unit's layout: the watcher
 * state the worker kept in the agent root seeds `watcher/` once, so rooms
 * stay with their sessions. A root whose worker never finished its own
 * layout migration is refused rather than migrated.
 */
async function migrateWorkerRoot(root: string, config: SharedHostConfig): Promise<void> {
  const planPath = join(root, PLAN_FILE);
  if (!(await exists(planPath))) return;
  const agentId = config.session.agentId;
  const saved = z
    .object({ spec: z.object({ session: z.object({ agentId: z.string() }) }) })
    .safeParse(await readJson(planPath, `${planPath} is not JSON.`));
  if (!saved.success || saved.data.spec.session.agentId !== agentId)
    throw new Error(`${planPath} does not belong to agent ${agentId}.`);
  const versionPath = join(root, STATE_VERSION_FILE);
  const version = (await exists(versionPath))
    ? z
        .object({ version: z.number() })
        .safeParse(await readJson(versionPath, `${versionPath} is not JSON.`))
    : null;
  if (!version?.success || version.data.version !== MIGRATED_STATE_VERSION)
    throw new Error(
      `${root} holds a worker volume's agent whose layout migration never finished (${versionPath} is not version ${MIGRATED_STATE_VERSION}); an agent unit cannot migrate it.`
    );
  const watcherRoot = join(root, 'watcher');
  for (const name of LEGACY_WATCHER_STATE) if (await exists(join(watcherRoot, name))) return;
  for (const name of LEGACY_WATCHER_STATE)
    try {
      await copyFile(join(root, name), join(watcherRoot, name), constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

/**
 * What an agent unit's watcher (`shared-host-daemon --unit`) sets on itself
 * for its session hosts to inherit when its agent was granted GitHub, so
 * `git` and `gh` in a session get installation tokens through the unit's
 * Switch credentials (`hostedGitHubEnvironment`). Empty without the grant.
 */
export async function hostedUnitGitHubEnvironment(
  agentRoot: string,
  config: SharedHostConfig
): Promise<Record<string, string>> {
  const root = await realpath(agentRoot);
  const workspacePath = join(root, HOSTED_WORKSPACE_FILE);
  const parsed = hostedWorkspaceSchema.safeParse(
    await readUnitFile(workspacePath, `${workspacePath} is missing or is not JSON.`)
  );
  if (!parsed.success)
    throw new Error(
      `${workspacePath} is invalid: ${parsed.error.issues[0]?.message ?? 'invalid value'}.`
    );
  if (!parsed.data.connections.includes('github')) return {};
  if (!config.execution) throw new Error('An agent unit names no Switch credentials.');
  return {
    [HOSTED_GITHUB_CREDENTIALS_ENV]: config.execution.credentialsPath,
    [HOSTED_GITHUB_CLI_ENV]: join(root, 'bin'),
  };
}

/**
 * Prepares an agent's root before its unit's watcher starts, as the agent's
 * user (`shared-host-daemon --prepare <agentRoot>`): migrates a worker
 * volume's layout, writes the provider sign-in the controller handed over
 * into the provider's home, makes the (empty) workspace directory when it is
 * missing, writes the `gh` wrapper when GitHub is granted, and makes the
 * installed connection skills the granted ones.
 *
 * Reads `watcher/config.json` and `workspace.json` from the agent root, and
 * the credentials `agent` and `provider` from `credentialsDirectory`.
 */
export async function prepareHostedAgent(input: {
  agentRoot: string;
  credentialsDirectory: string;
}): Promise<void> {
  if (!isAbsolute(input.agentRoot)) throw new Error('The agent root must be an absolute path.');
  if (!isAbsolute(input.credentialsDirectory))
    throw new Error('The credentials directory must be an absolute path.');
  const root = await realpath(input.agentRoot);
  const configPath = join(root, 'watcher', CONFIG_FILE);
  const parsedConfig = sharedConfigSchema.safeParse(
    await readUnitFile(configPath, `${configPath} is missing or is not JSON.`)
  );
  if (!parsedConfig.success) throw new Error(`${configPath} is not a valid launch configuration.`);
  const config = parsedConfig.data;
  const agentId = config.session.agentId;
  const provider = config.start.provider;
  const credentialsPath = join(input.credentialsDirectory, UNIT_AGENT_CREDENTIAL);
  if (config.execution?.credentialsPath !== credentialsPath)
    throw new Error(
      `${configPath} reads its Switch credentials from somewhere other than this unit's ${credentialsPath}.`
    );
  if (!config.execution.binaryPath) throw new Error(`${configPath} names no provider executable.`);
  await validateSwitchCredentials(credentialsPath, agentId);

  await migrateWorkerRoot(root, config);

  const providerPath = join(input.credentialsDirectory, UNIT_PROVIDER_CREDENTIAL);
  const parsedCredential = hostedCredentialSchema.safeParse(
    await readUnitFile(
      providerPath,
      'The provider sign-in handed to this agent is missing or invalid.'
    )
  );
  if (!parsedCredential.success)
    throw new Error('The provider sign-in handed to this agent is missing or invalid.');
  const credential: HostedCredential = parsedCredential.data;
  if (credential.status === 'revoked')
    throw new Error('The provider was disconnected. Reconnect it in Switch to start this agent.');
  if (credential.provider !== provider)
    throw new Error(
      `The provider sign-in handed to this agent is for ${credential.provider}, not ${provider}.`
    );
  const environment = controlledEnvironment(root, provider);
  await createControlledDirectories(environment);
  await materializeHostedProvider(root, environment, credential, config.execution.binaryPath);

  const workspacePath = join(root, HOSTED_WORKSPACE_FILE);
  const parsedWorkspace = hostedWorkspaceSchema.safeParse(
    await readUnitFile(workspacePath, `${workspacePath} is missing or is not JSON.`)
  );
  if (!parsedWorkspace.success)
    throw new Error(
      `${workspacePath} is invalid: ${parsedWorkspace.error.issues[0]?.message ?? 'invalid value'}.`
    );
  const workspace = parsedWorkspace.data;
  await mkdir(workspace.workspacePath, { recursive: true, mode: 0o700 });
  if (workspace.connections.includes('github')) await prepareGitHubCli(root);
  if (supportsHostedSkills(provider))
    await installHostedSkills(hostedSkillsDirectory(provider, environment), workspace.skills);
  else if (workspace.skills.length > 0)
    throw new Error('This provider has no skills directory to install connection skills into.');
}
