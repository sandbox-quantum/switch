import { acpInitialize, createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness } from '../readiness';
import { JsonRpcError, noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

const CLINE_LOGIN = 'cline auth';
const CLINE_SIGN_IN =
  'Sign in on the execution machine with cline auth, or set CLINE_PROVIDER and CLINE_API_KEY there.';

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
};

export function createClineAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(clineAcp, options);
}
