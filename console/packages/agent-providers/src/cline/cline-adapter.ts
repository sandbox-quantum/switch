import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const CLINE_LOGIN = 'cline auth';
export const CLINE_SIGN_IN = signInWith(CLINE_LOGIN);

/** Cline CLI's `cline --acp` provider hooks. */
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
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp'],
    env,
  }),
  loginCommand: CLINE_LOGIN,
  // `initialize` lists every auth method whether or not one is in use, so it
  // cannot tell signed in from signed out, and there is no non-interactive
  // status command. `session/new` is the only reliable signal: it answers
  // normally when signed in and refuses with "Authentication required" when
  // not. A session that never sends a prompt opens just long enough to read
  // which one happened.
  checkSignIn: async ({ env, cwd, handshake, request }) => {
    if (env.CLINE_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the API key it was given.');
    }
    try {
      await handshake();
      await request('session/new', { cwd, mcpServers: [] });
      return readiness('authenticated', 'Signed in.');
    } catch (error) {
      const message = String(error);
      if (/authentication required|not logged in|login required|not authenticated/i.test(message)) {
        return readiness('unauthenticated', CLINE_SIGN_IN);
      }
      throw error;
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
  // Cline titles an MCP tool call `<server>__<tool>: <arguments>`.
  // Matched on the name before the first `:` so a `__` inside the arguments'
  // JSON cannot cause a false match.
  mcpServerOf: (toolCall) => {
    const name = toolCall.title?.split(':')[0] ?? '';
    const split = name.indexOf('__');
    return split > 0 && /^[\w.-]+$/.test(name.slice(0, split)) ? name.slice(0, split) : undefined;
  },
  // Cline delegates to a subagent with `spawn_agent`.
  itemType: (toolCall) => (toolCall.title?.startsWith('spawn_agent:') ? 'subagent' : undefined),
  promptCapabilities: { image: true },
};

export function createClineAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(clineAcp, options);
}
