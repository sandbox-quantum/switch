import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpLaunch, AcpLaunchInput, AcpProviderHooks } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import type { McpServerSpec } from '../adapter';
import { execProvider } from '../provider-process';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

const CLINE_LOGIN = 'cline auth';

/**
 * The sign-ins Cline's ACP mode accepts, in the order it restores them. A key
 * saved for any other provider (`cline auth anthropic`, say) is not used over
 * ACP, so it does not count as signed in here.
 */
const ACP_SIGN_INS = [
  ['cline', 'a Cline account'],
  ['cline-pass', 'ClinePass'],
  ['openai-codex', 'a ChatGPT subscription'],
] as const;

/** Where Cline keeps its saved sign-ins, following the variables Cline itself reads. */
export function clineProviderSettingsPath(env: Record<string, string>): string {
  const explicit = env.CLINE_PROVIDER_SETTINGS_PATH?.trim();
  if (explicit) return explicit;
  const dataDir =
    env.CLINE_DATA_DIR?.trim() ||
    join(env.CLINE_DIR?.trim() || join(env.HOME || homedir(), '.cline'), 'data');
  return join(dataDir, 'settings', 'providers.json');
}

interface SavedSettings {
  apiKey?: unknown;
  auth?: { accessToken?: unknown; apiKey?: unknown };
}

const present = (value: unknown) => typeof value === 'string' && value.trim() !== '';

/** The sign-in Cline's `providers.json` holds; `text` is undefined when there is no such file. */
export function parseClineSignIn(text: string | undefined, path: string): ProviderReadiness {
  if (text === undefined) return readiness('unauthenticated', signInWith(CLINE_LOGIN));
  let providers: Record<string, { settings?: SavedSettings } | undefined>;
  try {
    providers = (JSON.parse(text) as { providers?: typeof providers }).providers ?? {};
  } catch (error) {
    return readiness(
      'unknown',
      `Could not read Cline's saved sign-in at ${path}: ${String(error)}`
    );
  }
  for (const [id, name] of ACP_SIGN_INS) {
    const settings = providers[id]?.settings;
    if (
      settings &&
      (present(settings.auth?.accessToken) ||
        present(settings.apiKey) ||
        present(settings.auth?.apiKey))
    )
      return readiness('authenticated', `Signed in to Cline with ${name}.`);
  }
  return readiness('unauthenticated', signInWith(CLINE_LOGIN));
}

/**
 * The session's MCP servers in the shape of Cline's `cline_mcp_settings.json`.
 * On Windows Cline starts a stdio server through the shell, so a command or
 * argument with a space in it (`C:\Program Files\nodejs\node.exe`) is quoted.
 */
export function clineMcpSettings(
  servers: Record<string, McpServerSpec>,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): { mcpServers: Record<string, Record<string, unknown>> } {
  const part = (value: string) =>
    platform === 'win32' && /\s/.test(value) && !value.includes('"') ? `"${value}"` : value;
  return {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, server]) => [
        name,
        server.transport === 'stdio'
          ? {
              type: 'stdio',
              command: part(server.command),
              args: server.args.map(part),
              env: {
                ...Object.fromEntries(
                  (server.envVars ?? [])
                    .filter((key) => env[key] !== undefined)
                    .map((key) => [key, env[key]])
                ),
                ...server.env,
              },
            }
          : { type: 'streamableHttp', url: server.url, headers: server.headers ?? {} },
      ])
    ),
  };
}

/**
 * `cline --acp`, with the session's MCP servers in a settings file of its own.
 * Cline's ACP mode does not use the servers sent in `session/new`; it reads
 * `CLINE_MCP_SETTINGS_PATH`. The file holds the servers' bearer tokens, so it
 * is private to this user and removed when the process exits. Pointing Cline
 * at it leaves the person's own MCP settings and sign-ins untouched.
 *
 * `cline --acp` runs its sessions in a hub daemon that outlives it, and the
 * daemon reads `CLINE_MCP_SETTINGS_PATH` once, when it starts. Every session
 * sharing one daemon would get the first session's servers, so each gets a
 * daemon of its own (`CLINE_HUB_DISCOVERY_PATH`), stopped with the session.
 */
export async function clineLaunch({
  binaryPath,
  env,
  mcpServers = {},
}: AcpLaunchInput): Promise<AcpLaunch> {
  const dir = await mkdtemp(join(tmpdir(), 'switch-cline-'));
  const settings = join(dir, 'cline_mcp_settings.json');
  const hub = join(dir, 'hub.json');
  try {
    await writeFile(settings, JSON.stringify(clineMcpSettings(mcpServers, env)), { mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const launchEnv = { ...env, CLINE_MCP_SETTINGS_PATH: settings, CLINE_HUB_DISCOVERY_PATH: hub };
  return {
    command: binaryPath,
    args: ['--acp'],
    env: launchEnv,
    cleanup: async () => {
      try {
        // Always ask: a daemon killed before it wrote its discovery file is
        // still running, and "no hub" is the answer when there is nothing to stop.
        await execProvider(binaryPath, ['hub', 'stop'], { env: launchEnv, timeout: 30_000 });
      } catch {
        // Nothing to stop, or `cline` could not be run: either way the
        // directory below still goes.
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The ACP kind of Cline's own tools, which it reports as `other`. */
const CLINE_TOOL_KINDS = new Map([
  ['run_commands', 'execute'],
  ['editor', 'edit'],
  ['apply_patch', 'edit'],
]);

/** Cline titles a tool call `<tool>` or `<tool>: <summary of its input>`. */
function clineToolName(toolCall: AcpToolCall): string {
  return toolCall.title?.split(':', 1)[0]?.trim() ?? '';
}

/** Cline names an MCP tool `<server>__<tool>`. */
export function clineMcpServerOf(toolCall: AcpToolCall): string | undefined {
  const name = clineToolName(toolCall);
  const end = name.indexOf('__');
  return end > 0 ? name.slice(0, end) : undefined;
}

/** Cline CLI's `cline --acp`. */
export const clineAcp: AcpProviderHooks = {
  provider: 'cline',
  label: 'Cline CLI',
  defaultBinary: 'cline',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: clineLaunch,
  mcpServersAtLaunch: true,
  loginCommand: CLINE_LOGIN,
  inheritEnv: ['CLINE_API_KEY', 'CLINE_DIR', 'CLINE_DATA_DIR', 'CLINE_PROVIDER_SETTINGS_PATH'],
  // Reads the sign-in Cline saved rather than asking the agent: its
  // `initialize` lists every sign-in method whether or not one is in use, and
  // `authenticate` would start a browser sign-in when none is saved.
  checkSignIn: async ({ env }) => {
    if (env.CLINE_API_KEY?.trim())
      return readiness('authenticated', 'Signs in with the Cline API key it was given.');
    const path = clineProviderSettingsPath(env);
    let text: string | undefined;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return parseClineSignIn(text, path);
  },
  // No `authMethodId`: a saved sign-in is restored by Cline itself when a
  // session starts, and without one `authenticate` would open a browser that
  // a host cannot finish. A signed-out Cline fails the session start instead.
  // Plan and act are Cline's workflows, not permission levels: Switch's
  // runtime mode is applied to its permission requests.
  sessionMode: () => 'act',
  mcpServerOf: clineMcpServerOf,
  itemType: (toolCall) => (clineToolName(toolCall) === 'spawn_agent' ? 'subagent' : undefined),
  toolKind: (toolCall) => CLINE_TOOL_KINDS.get(clineToolName(toolCall)),
};

export function createClineAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(clineAcp, options);
}
