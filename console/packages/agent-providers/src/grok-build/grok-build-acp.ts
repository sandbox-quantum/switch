import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpSessionModes } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import { readiness, signInWith } from '../readiness';

export const GROK_BUILD_LOGIN = 'grok login';

const MODE_PREFERENCES: Record<RuntimeMode, readonly string[]> = {
  'full-access': ['always-approve', 'default'],
  'auto-accept-edits': ['accept-edits', 'auto', 'default'],
  auto: ['auto', 'accept-edits', 'default'],
  'approval-required': ['ask', 'default'],
};

export function grokBuildSessionMode(
  runtimeMode: RuntimeMode,
  modes: AcpSessionModes | undefined
): string | undefined {
  if (!modes?.availableModes.length) return undefined;
  const preferences = MODE_PREFERENCES[runtimeMode];
  return preferences.find((id) => modes.availableModes.some((mode) => mode.id === id));
}

/** Grok Build's ACP stdio server. */
export const grokBuildAcp: AcpProviderHooks = {
  provider: 'grok-build',
  label: 'Grok Build',
  defaultBinary: 'grok',
  capabilities: {
    modelSwitchInSession: false,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['agent', 'stdio'],
    env,
  }),
  loginCommand: GROK_BUILD_LOGIN,
  inheritEnv: ['XAI_API_KEY'],
  sessionMode: grokBuildSessionMode,
  checkSignIn: async ({ handshake, env }) => {
    if (env.XAI_API_KEY?.trim())
      return readiness('authenticated', 'Signs in with the xAI API key it was given.');

    try {
      const result = await handshake();
      const authMethods = result.authMethods ?? [];
      if (authMethods.some((method) => method.id === 'cached_token'))
        return readiness('authenticated', 'Signed in to Grok Build.');
      if (authMethods.length) return readiness('unauthenticated', signInWith(GROK_BUILD_LOGIN));
      return readiness('unknown', signInWith(GROK_BUILD_LOGIN));
    } catch (error) {
      if (
        /sign.?in|auth required|authentication required|unauthenticated|not logged in/i.test(
          String(error)
        )
      )
        return readiness('unauthenticated', signInWith(GROK_BUILD_LOGIN));
      return readiness('unknown', 'Could not verify Grok Build authentication.');
    }
  },
};

export function createGrokBuildAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(grokBuildAcp, options);
}
