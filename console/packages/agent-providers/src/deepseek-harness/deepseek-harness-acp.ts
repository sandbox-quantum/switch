import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpLaunch, AcpLaunchInput, AcpProviderHooks } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import type { ItemType } from '../events';
import { execProvider } from '../provider-process';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

export const DSH_LOGIN = 'dsh web';
const KEY = 'DEEPSEEK_API_KEY';
const ACCOUNT_RECORD = 'deepseek-account-platform/default';
const SIGN_IN = `${signInWith(DSH_LOGIN)} Save a DeepSeek API key under its Models settings, or set ${KEY}.`;

function userHome(env: Record<string, string>): string {
  const home = process.platform === 'win32' ? env.USERPROFILE : env.HOME;
  return home?.trim() || homedir();
}

/** Where DeepSeek Harness keeps its profiles, sessions and credentials, as it resolves it. */
export function dshHome(env: Record<string, string>, cwd: string): string {
  const configured = env.DSH_HOME?.trim();
  if (!configured) return join(userHome(env), '.dsh');
  if (configured === '~') return userHome(env);
  if (/^~[/\\]/.test(configured)) return join(userHome(env), configured.slice(2));
  return resolve(cwd, configured);
}

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type DshCredentials =
  | { usable: true; apiKey: boolean; account: boolean }
  | { usable: false; reason: string };

/**
 * What `$DSH_HOME/.credentials.yaml` holds for signing in: a `refs.DEEPSEEK_API_KEY`,
 * and the record a DeepSeek account sign-in stores. A file the harness would
 * refuse to load (malformed YAML, a duplicate key, an empty or mistyped value)
 * is reported as such, since the harness then does not start at all.
 */
export function parseDshCredentials(text: string): DshCredentials {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) return { usable: false, reason: 'it is not valid YAML' };
  const data: unknown = document.toJS() ?? {};
  if (!isMapping(data)) return { usable: false, reason: 'it is not a mapping' };
  const refs = data.refs ?? {};
  const records = data.records ?? {};
  if (!isMapping(refs) || !isMapping(records))
    return { usable: false, reason: 'its refs or records are not mappings' };
  if (Object.values(refs).some((value) => typeof value !== 'string' || !value))
    return { usable: false, reason: 'a saved key is empty or not text' };
  return { usable: true, apiKey: KEY in refs, account: ACCOUNT_RECORD in records };
}

/** Whether a dotenv file sets a non-empty `DEEPSEEK_API_KEY`. */
export function dotenvHasKey(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const match = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=(.*)$/.exec(line);
    const value = match?.[1]?.replace(/\s+#.*$/, '').trim();
    return value !== undefined && value !== '' && value !== '""' && value !== "''";
  });
}

/**
 * Looks where the harness looks for the key its ACP profile's default route
 * (`deepseek-official`) signs in with, in its own order: the saved
 * credentials, the environment, the project's `.env`, then the harness home's
 * `.env`. The key itself is never read out, and is checked by the first turn.
 */
export async function checkDshSignIn(input: {
  cwd: string;
  env: Record<string, string>;
}): Promise<ProviderReadiness> {
  const home = dshHome(input.env, input.cwd);
  const file = join(home, '.credentials.yaml');
  const saved = await optionalFile(file);
  const credentials = saved === null ? null : parseDshCredentials(saved);
  if (credentials && !credentials.usable)
    return readiness(
      'unknown',
      `DeepSeek Harness will not load its saved credentials (${file}): ${credentials.reason}. Fix or remove the file.`
    );
  // The harness refuses a credentials file anyone else can read.
  if (credentials && process.platform !== 'win32' && ((await stat(file)).mode & 0o044) !== 0)
    return readiness(
      'unknown',
      `DeepSeek Harness will not load its saved credentials (${file}) while others can read it. Run chmod 600 on it.`
    );
  const found = credentials?.apiKey
    ? 'its saved credentials'
    : input.env[KEY]?.trim()
      ? KEY
      : dotenvHasKey((await optionalFile(join(input.cwd, '.env'))) ?? '')
        ? "the project's .env"
        : dotenvHasKey((await optionalFile(join(home, '.env'))) ?? '')
          ? "the harness home's .env"
          : null;
  if (found)
    return readiness(
      'authenticated',
      `Signs in with the DeepSeek API key in ${found}; the first turn checks it.`
    );
  if (credentials?.account)
    return readiness(
      'unknown',
      `Signed in to a DeepSeek account, but there is no DeepSeek API key, which the ACP profile's default model needs. Choose one of the account's models, or: ${SIGN_IN}`
    );
  return readiness('unauthenticated', `DeepSeek Harness has no DeepSeek API key. ${SIGN_IN}`);
}

/**
 * A dsh plugin on its documented `tools/pre-execute` gate. Every tool but
 * the few that only read or keep the agent's own notes asks first, through the
 * harness's own approval service and so as an ACP permission request, which
 * the runtime mode then decides; that includes `workflow`, `web_fetch`,
 * `web_search`, MCP tools and any tool it does not know. Without it dsh asks
 * only to widen its sandbox, and a command that writes no file would run
 * unasked. It provides `switchAskGate`, which the ACP bridge is made to wait
 * for, so a gate that does not load stops dsh's startup rather than letting it
 * run ungated.
 */
export const DSH_ASK_GATE = `export const name = 'switch-ask-gate';
export const inject = ['tools', 'approval'];
// The tools that run unasked: none runs a process, writes a file or reaches
// the network. Anything else asks, including a tool added later.
const UNASKED = new Set([
  'read', // reads a file
  'read_image', // reads an image file
  'glob', // lists files by pattern
  'grep', // searches files (ripgrep, reading only)
  'todo_write', // the agent's own task list
  'skill', // loads a skill's instructions
  'working_directory', // reads or enters a directory; the sandbox stays the workspace
  'job_output', // reads a background job's output
  'job_list', // lists background jobs
  'get_goal', // reads the session's goal
  'exit_plan_mode', // leaves plan mode
  'list_agents', // lists its subagents
  'send_message', // messages its own subagents
  'interrupt_agent', // stops one of its own subagents
  'subagent', // starts a subagent, whose own calls this gate refuses
  'subagent_fork', // the same, from the current conversation
]);
const SUBAGENT =
  'Switch cannot ask for approval inside a DeepSeek Harness subagent outside full access; do this in the main agent instead.';
export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decided = await next();
    if (decided.kind !== 'allow' || UNASKED.has(exec.name)) return decided;
    // A subagent's approval policy is pinned to never: say why, not "rejected".
    if (exec.agent && ctx.approval.overrideOf(exec.agent.session) === 'never')
      return { kind: 'deny', reason: SUBAGENT };
    return { kind: 'ask', reason: 'Switch asks before ' + exec.name + ' runs' };
  });
  ctx.provide('switchAskGate', { armed: true });
}
`;

/** The dsh versions the ask gate has been verified with. */
export const DSH_GATE_VERSIONS: readonly string[] = ['0.2.1-rc.5'];

const GATE_NOT_LOADED =
  "DeepSeek Harness did not load Switch's approval gate, so the session was not started; it would have run without asking. Run this agent with bypass permissions, or reinstall DeepSeek Harness";

/** Switch's own state for dsh, kept outside `$DSH_HOME` so no dsh session edits it as a workspace file. */
export function dshStateDirectory(env: Record<string, string>): string {
  return join(userHome(env), '.local', 'state', 'switch', 'deepseek-harness');
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  await chmod(directory, 0o700);
  const owner = (await stat(directory)).uid;
  if (owner !== process.getuid?.())
    throw new Error(
      `${directory} belongs to another user, so Switch will not keep DeepSeek Harness's approval gate there.`
    );
}

async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

/**
 * Settings every session gets: no background commands, since Switch stops a
 * turn with `session/cancel`, which does not stop a background job.
 */
export const DSH_SETTINGS_PATCH = '- id: tool-bash\n  config:\n    enableRunInBackground: false\n';

/**
 * The `--patch` overlays a session launches with: {@link DSH_SETTINGS_PATCH},
 * and when gated one that mounts {@link DSH_ASK_GATE} and makes the ACP bridge
 * wait for it. Rewritten on every launch, so an edited copy does not survive one.
 */
export async function dshPatches(env: Record<string, string>, gated: boolean): Promise<string[]> {
  const directory = dshStateDirectory(env);
  await privateDirectory(directory);
  const version = createHash('sha256')
    .update(DSH_ASK_GATE)
    .update(DSH_SETTINGS_PATCH)
    .digest('hex')
    .slice(0, 12);
  const settings = join(directory, `settings-${version}.patch.yml`);
  await writeAtomically(settings, DSH_SETTINGS_PATCH);
  const patches = [settings];
  if (gated) {
    const plugin = join(directory, `ask-gate-${version}.mjs`);
    const patch = join(directory, `ask-gate-${version}.patch.yml`);
    await writeAtomically(plugin, DSH_ASK_GATE);
    await writeAtomically(
      patch,
      [
        '- insert:',
        '    - id: switch-ask-gate',
        `      name: ${JSON.stringify(pathToFileURL(plugin).href)}`,
        '- id: acp',
        '  inject: [acpAppStartup, switchAskGate]',
        '',
      ].join('\n')
    );
    patches.push(patch);
  }
  for (const entry of await readdir(directory))
    if (
      /^(ask-gate|settings)-[0-9a-f]{12}\.(mjs|patch\.yml)$/.test(entry) &&
      !entry.includes(version)
    )
      await rm(join(directory, entry), { force: true });
  return patches;
}

/** The installed dsh's version, as `dsh --version` prints it. */
export async function dshVersion(binaryPath: string, input: AcpLaunchInput): Promise<string> {
  const { stdout } = await execProvider(binaryPath, ['--version'], {
    cwd: input.cwd,
    env: input.env,
    timeout: 15000,
  });
  return stdout.trim().split(/\s+/).at(-1) ?? '';
}

const contains = (parent: string, path: string) => {
  const from = relative(parent, path);
  return from === '' || (!from.startsWith('..') && !isAbsolute(from));
};

/**
 * How `dsh --profile acp` runs. Its permission mode is fixed when it creates a
 * conversation and kept on resume, and ACP cannot change it, so every session
 * is created in its own default, workspace-write, without background commands.
 * Unless the session runs in full access, the ask gate is mounted, with the dsh version it was verified
 * with. In full access there is no gate (a subagent pins its approval policy
 * to `never`, so a gated call there could never run), and a call beyond the
 * workspace still asks to be widened, which full access allows.
 */
export async function dshLaunch(input: AcpLaunchInput): Promise<AcpLaunch> {
  const { binaryPath, cwd, env, runtimeMode } = input;
  const launch = (args: string[]): AcpLaunch => ({
    command: binaryPath,
    args: ['--profile', 'acp', ...args],
    // A Switch session has no feedback surface, which is all its exporter sends.
    env: { ...env, DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_DISABLED: '1' },
  });
  const patched = async (gated: boolean) =>
    (await dshPatches(env, gated)).flatMap((patch) => ['--patch', patch]);
  if (runtimeMode === 'full-access') return launch(await patched(false));
  const version = await dshVersion(binaryPath, input);
  if (!DSH_GATE_VERSIONS.includes(version))
    throw new Error(
      `Switch's approval gate is verified with DeepSeek Harness ${DSH_GATE_VERSIONS.join(', ')}, not ${version || 'this version'}. Install it (npm install -g @deepseek-ai/dsh@${DSH_GATE_VERSIONS.at(-1)}), or run this agent with bypass permissions.`
    );
  // An edit auto-accepted in the workspace must not reach dsh's own settings,
  // where it could undo the gate at the next launch.
  if (
    runtimeMode === 'auto-accept-edits' &&
    [dshHome(env, cwd), dshStateDirectory(env)].some((directory) => contains(cwd, directory))
  )
    throw new Error(
      "DeepSeek Harness's own settings are inside this agent's directory, where auto-accept-edits would let it change them. Give the agent a directory that does not contain them, or turn auto-accept-edits off."
    );
  return {
    ...launch(await patched(true)),
    rejectOutputLine: (output) =>
      /startup failed/.test(output) && output.includes('switch-ask-gate')
        ? `${GATE_NOT_LOADED} ${version}.`
        : undefined,
  };
}

const COMMAND_TOOLS = new Set(['bash', 'pwsh']);
const FILE_TOOLS = new Set(['write', 'edit']);
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork']);
// Exactly `mcp__<server>__<tool>`, with no `__` inside either part; anything
// else names no server and so asks.
const MCP_TOOL = /^mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)$/;

function field(call: AcpToolCall, key: string): string | undefined {
  const value = call.rawInput?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function truncate(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length <= 160 ? single : `${single.slice(0, 159)}…`;
}

/**
 * DeepSeek Harness's `dsh --profile acp`. It reports every tool call as kind
 * `other` titled with the tool's name, so its tools are typed and titled
 * here, and it asks permission by tool call id alone.
 */
export const deepseekHarnessAcp: AcpProviderHooks = {
  provider: 'deepseek-harness',
  label: 'DeepSeek Harness',
  defaultBinary: 'dsh',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: dshLaunch,
  loginCommand: DSH_LOGIN,
  inheritEnv: [KEY, 'DEEPSEEK_BASE_URL', 'DSH_HOME'],
  unsupportedPlatforms: {
    win32:
      'DeepSeek Harness has not been verified with Switch on Windows, where its sandbox only partly confines commands.',
  },
  // `initialize` advertises no auth methods whether or not a key is set, so
  // the check reads where the key comes from instead of starting the agent.
  checkSignIn: async ({ cwd, env }) => checkDshSignIn({ cwd, env }),
  mcpServerOf: (toolCall) => MCP_TOOL.exec(toolCall.title ?? '')?.[1],
  itemType: (toolCall): ItemType | undefined => {
    const name = toolCall.title ?? '';
    if (COMMAND_TOOLS.has(name)) return 'command_execution';
    // A write retried with wider `sandbox_permissions` reaches beyond the
    // workspace, so it is not an edit auto-accept-edits may allow unasked.
    const widened = field(toolCall, 'sandbox_permissions');
    if (FILE_TOOLS.has(name))
      return !widened || widened === 'workspace-write' ? 'file_change' : 'tool_call';
    if (SUBAGENT_TOOLS.has(name)) return 'subagent';
    return undefined;
  },
  toolTitle: (toolCall) => {
    const name = toolCall.title ?? '';
    if (COMMAND_TOOLS.has(name)) {
      const command = field(toolCall, 'command');
      return command ? truncate(command) : undefined;
    }
    if (FILE_TOOLS.has(name) || name === 'read') {
      const path = field(toolCall, 'file_path');
      return path ? `${name} ${path}` : undefined;
    }
    if (SUBAGENT_TOOLS.has(name)) {
      const task = field(toolCall, 'description') ?? field(toolCall, 'prompt');
      return task ? truncate(task) : undefined;
    }
    return undefined;
  },
};

export function createDeepseekHarnessAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(deepseekHarnessAcp, options);
}
