import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acpInitialize, createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpLaunch, AcpLaunchInput, AcpProviderHooks } from '../acp/hooks';
import { stdioMcpServerEnv } from '../acp/mcp';
import type { McpServerSpec } from '../adapter';
import { readiness, signInWith } from '../readiness';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

const CLINE_LOGIN = 'cline auth';
const CLINE_SIGN_IN = `${signInWith(CLINE_LOGIN)} Over ACP, Cline reads only its own account sign-ins (Cline, ClinePass, ChatGPT); for a provider's API key, set CLINE_PROVIDER and CLINE_API_KEY on that machine.`;

/** The session's MCP servers in Cline's `cline_mcp_settings.json` shape. */
export function clineMcpSettings(
  servers: Record<string, McpServerSpec>,
  env: Record<string, string>
): { mcpServers: Record<string, { transport: Record<string, unknown> }> } {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, server]) => [
        name,
        {
          transport:
            server.transport === 'stdio'
              ? {
                  type: 'stdio',
                  command: server.command,
                  args: server.args,
                  env: stdioMcpServerEnv(server, env),
                }
              : { type: 'streamableHttp', url: server.url, headers: server.headers ?? {} },
        },
      ])
    ),
  };
}

/**
 * Runs `cline --acp` with the session's MCP servers in a settings file of its
 * own. Cline 3.0 ignores ACP's `mcpServers`, and reads its servers from
 * `CLINE_MCP_SETTINGS_PATH`; the local backend keeps the session in this
 * process, where a shared hub daemon would keep the first launch's settings.
 * The person's own `~/.cline` is never written.
 */
export async function clineLaunch({
  binaryPath,
  env,
  mcpServers,
}: AcpLaunchInput): Promise<AcpLaunch> {
  const directory = await mkdtemp(join(tmpdir(), 'switch-cline-'));
  const settings = join(directory, 'cline_mcp_settings.json');
  await writeFile(settings, JSON.stringify(clineMcpSettings(mcpServers, env), null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  return {
    command: binaryPath,
    args: ['--acp', '--auto-approve', 'false'],
    env: { ...env, CLINE_SESSION_BACKEND_MODE: 'local', CLINE_MCP_SETTINGS_PATH: settings },
    mcpServersInLaunch: true,
    release: () => rm(directory, { recursive: true, force: true }),
  };
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
  loginCommand: CLINE_LOGIN,
  inheritEnv: ['CLINE_API_KEY', 'CLINE_PROVIDER', 'CLINE_MODEL', 'CLINE_DIR', 'CLINE_DATA_DIR'],
  // `initialize` reads the same signed in or out, and `authenticate` would
  // sign in. `session/new` is refused when Cline holds no sign-in, and
  // otherwise only opens a session in this process, which nothing prompts.
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    if (env.CLINE_API_KEY?.trim())
      return readiness(
        'authenticated',
        `Signs in with the API key it was given, on ${env.CLINE_PROVIDER?.trim() || 'Cline'}.`
      );
    const {
      mcpServersInLaunch: _,
      release,
      ...launch
    } = await clineLaunch({
      binaryPath,
      cwd,
      env,
      mcpServers: {},
    });
    const client = new StdioJsonRpcClient({
      ...launch,
      cwd,
      logger: noopLogger,
      onExit: () => void release?.(),
    });
    try {
      await acpInitialize(client);
      await client.request('session/new', { cwd, mcpServers: [] });
      return readiness('authenticated', 'Signed in to Cline.');
    } catch (error) {
      if (/authentication required/i.test(String(error)))
        return readiness('unauthenticated', CLINE_SIGN_IN);
      throw error;
    } finally {
      await client.dispose();
    }
  },
  // Cline's Plan and Act modes are workflows, not permission levels, so the
  // runtime mode is enforced on its permission requests. Cline has no review
  // of its own over ACP, so auto mode asks the way approval-required does.
  sessionMode: () => 'act',
  // Cline titles an MCP tool call `<server>__<tool>: <arguments>`.
  mcpServerOf: (toolCall) => {
    const name = toolCall.title?.split(':', 1)[0] ?? '';
    const split = name.indexOf('__');
    return split > 0 && /^[\w.-]+$/.test(name) ? name.slice(0, split) : undefined;
  },
  itemType: (toolCall) => (toolCall.title?.startsWith('spawn_agent:') ? 'subagent' : undefined),
};

export function createClineAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(clineAcp, options);
}
