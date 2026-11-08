import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';
import { JsonRpcError } from '../transport/stdio-json-rpc';

const KIRO_LOGIN = 'kiro-cli login';
const KIRO_SIGN_IN = `${signInWith(KIRO_LOGIN)} Or set KIRO_API_KEY to a key from app.kiro.dev.`;
// ACP's `auth_required`, which Kiro answers every request after `initialize` with while signed out.
const AUTH_REQUIRED = -32000;

/** Kiro CLI's `kiro-cli acp`. Its extra methods are read from what it advertises. */
export const kiroAcp: AcpProviderHooks = {
  provider: 'kiro',
  label: 'Kiro CLI',
  defaultBinary: 'kiro-cli',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['acp'], env }),
  loginCommand: KIRO_LOGIN,
  // Kiro reads its saved login first, then KIRO_API_KEY.
  inheritEnv: ['KIRO_API_KEY'],
  // `initialize` lists `kiro-login` signed in or out, and that method only
  // tells a person to run `kiro-cli login`. Kiro 3.1.0 refuses a read-only
  // `session/list` with `auth_required` while it holds no login or key.
  checkSignIn: async ({ handshake, request }) => {
    await handshake();
    try {
      await request('session/list', {});
    } catch (error) {
      if (error instanceof JsonRpcError && error.code === AUTH_REQUIRED)
        return readiness('unauthenticated', KIRO_SIGN_IN);
      throw error;
    }
    return readiness('authenticated', 'Signed in to Kiro.');
  },
  // Kiro's modes are agent configurations, not permission levels, so none is
  // set: the runtime mode is enforced on its permission requests.
  mcpServerOf: (toolCall) => /^mcp__(.+?)__/.exec(toolCall.title ?? '')?.[1],
};

export function createKiroAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kiroAcp, options);
}
