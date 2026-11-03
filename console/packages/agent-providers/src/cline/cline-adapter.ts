import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acpInitialize, createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpMcpDelivery, AcpProviderHooks } from '../acp/hooks';
import type { McpServerSpec, StdioMcpServerSpec } from '../adapter';
import { readiness } from '../readiness';
import { JsonRpcError, noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

const CLINE_LOGIN = 'cline auth';
const CLINE_SIGN_IN =
  'Sign in on the execution machine with cline auth, or set CLINE_PROVIDER and CLINE_API_KEY there.';

/** A stdio server's environment: its `envVars` from the session, under its explicit `env`. */
function stdioEnv(server: StdioMcpServerSpec, env: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      (server.envVars ?? []).filter((key) => env[key] !== undefined).map((key) => [key, env[key]])
    ),
    ...server.env,
  };
}

/** The session's MCP servers in the shape Cline's own `cline_mcp_settings.json` reads. */
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
                  env: stdioEnv(server, env),
                }
              : { type: 'streamableHttp', url: server.url, headers: server.headers ?? {} },
        },
      ])
    ),
  };
}

/**
 * Writes the session's MCP servers to a settings file of their own and points
 * `CLINE_MCP_SETTINGS_PATH` at it, forcing the session onto Cline's local
 * backend so the engine that reads that file is the process this starts.
 *
 * Cline's ACP handler reads `mcpServers` off `session/new` and stores it on
 * the session, but never passes it to the engine it starts
 * (`apps/cli/src/acp/acpAgent.ts`, `ensureSessionManager` → `buildConfig` →
 * `createCliCore`): the parameter is accepted and then dropped. The only
 * mechanism that reaches a running engine is the settings file its MCP
 * manager reads from `resolveMcpSettingsPath()`
 * (`sdk/packages/shared/src/storage/paths.ts`), which that env var overrides.
 *
 * By default the CLI's engine runs in a shared background hub
 * (`sdk/packages/core/src/runtime/host/host.ts`: `backendMode` resolves to
 * `"auto"`, which prefers the hub), a separate, longer-lived process this
 * session's environment never reaches — so the settings file would be read,
 * if at all, by whichever environment started that hub, not this session's.
 * `CLINE_SESSION_BACKEND_MODE=local` makes that resolve to `"local"` instead,
 * which keeps the engine in this process.
 *
 * A session's file lives under its own temporary directory, never under
 * `~/.cline`, and is removed when the session ends. While it is in effect,
 * Cline sees only the servers this wrote — the person's own configured MCP
 * servers are not available to a Switch session.
 */
async function prepareClineMcpServers(
  servers: Record<string, McpServerSpec>,
  env: Record<string, string>
): Promise<AcpMcpDelivery> {
  const directory = await mkdtemp(join(tmpdir(), 'switch-cline-mcp-'));
  await chmod(directory, 0o700);
  const path = join(directory, 'cline_mcp_settings.json');
  await writeFile(path, JSON.stringify(clineMcpSettings(servers, env), null, 2));
  await chmod(path, 0o600);
  return {
    env: { CLINE_MCP_SETTINGS_PATH: path, CLINE_SESSION_BACKEND_MODE: 'local' },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Cline's `cline --acp`. */
export const clineAcp: AcpProviderHooks = {
  provider: 'cline',
  label: 'Cline',
  defaultBinary: 'cline',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp'], env }),
  loginCommand: CLINE_LOGIN,
  prepareMcpServers: prepareClineMcpServers,
  // `initialize` lists every auth method whether or not one is in use, so it
  // cannot tell signed in from signed out, and there is no non-interactive
  // status command. `session/new` is the only reliable signal: it answers
  // normally when signed in and refuses with "Authentication required" when
  // not. A session that never sends a prompt opens just long enough to read
  // which one happened.
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    if (env.CLINE_API_KEY?.trim())
      return readiness('authenticated', 'Signs in with the Cline API key it was given.');
    const client = new StdioJsonRpcClient({
      command: binaryPath,
      args: ['--acp'],
      env,
      cwd,
      logger: noopLogger,
      onExit: () => {},
    });
    try {
      await acpInitialize(client);
      await client.request('session/new', { cwd, mcpServers: [] });
      return readiness('authenticated', 'Signed in.');
    } catch (error) {
      if (error instanceof JsonRpcError && /authentication required/i.test(error.message))
        return readiness('unauthenticated', CLINE_SIGN_IN);
      throw error;
    } finally {
      await client.dispose();
    }
  },
  // In ACP mode Cline ignores its saved default provider/model, so without
  // CLINE_PROVIDER/CLINE_MODEL on the execution machine every session runs on
  // the `cline` provider; Console's model picker only chooses among that
  // provider's models.
  inheritEnv: ['CLINE_API_KEY', 'CLINE_PROVIDER', 'CLINE_MODEL'],
  // Cline's own modes are a plan/act workflow, not permission levels, so the
  // runtime mode is enforced on its permission requests instead, as Cursor's
  // own workflow modes are. Auto-approve defaults to off over ACP; every tool
  // call asks, and the generic adapter's runtime-mode handling answers it.
  sessionMode: () => 'act',
  // Cline titles an MCP tool call `<server>__<tool>: <arguments>` (observed
  // against 3.0.74 with the settings-file delivery above). Matched on the
  // name before the first `:` so a `__` inside the arguments' JSON cannot
  // cause a false match.
  mcpServerOf: (toolCall) => {
    const name = toolCall.title?.split(':')[0] ?? '';
    const split = name.indexOf('__');
    return split > 0 && /^[\w.-]+$/.test(name.slice(0, split)) ? name.slice(0, split) : undefined;
  },
  // Cline delegates to a subagent with `spawn_agent`, observed against 3.0.74.
  itemType: (toolCall) => (toolCall.title?.startsWith('spawn_agent:') ? 'subagent' : undefined),
};

export function createClineAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(clineAcp, options);
}
