import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

export const GROK_BUILD_LOGIN = 'grok login';

/** The auth method a signed-out 1.0.70 names in its `initialize` reply. */
const LOGIN_METHOD = 'grok.com';

/** The auth method a signed-in 1.0.70 adds for the login it has cached. */
const CACHED_METHOD = 'cached_token';

/**
 * Grok Build as an ACP provider.
 *
 * Launch is `grok agent stdio`. The 1.0.70 handshake advertises
 * `loadSession`, image and embedded-context prompts and HTTP/SSE MCP
 * servers, and a signed-out `session/new` still answers, with the model
 * list and four modes: `default`, `always-approve`, `plan` and `ask`.
 * Those modes are permission levels, so the hooks map Switch's runtime
 * modes onto them: approval-required asks (`ask`), auto-accept-edits and
 * auto take the CLI's own default, and full-access is `always-approve`.
 * `plan` is a workflow, not a permission level, and no runtime mode
 * selects it.
 *
 * Sign-in is `grok login` (browser OAuth) or an xAI API key in the
 * environment. The handshake separates the two login states: a signed-out
 * CLI names `grok.com`, a signed-in one names a cached-token method
 * instead — so the check reads the methods rather than assuming the
 * Antigravity situation, where the login method is named either way.
 * In-session model switching is not offered: `session/new` lists models
 * to start with, but the handshake's session capabilities (list, resume,
 * close) do not advertise changing one mid-session.
 */
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
  promptCapabilities: { image: true, embeddedContext: true },
  loginCommand: GROK_BUILD_LOGIN,
  authMethodId: (env) => (env.XAI_API_KEY?.trim() ? undefined : LOGIN_METHOD),
  checkSignIn: async ({ env, handshake }): Promise<ProviderReadiness> => {
    if (env.XAI_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the xAI API key it was given.');
    }
    const init = await handshake();
    const methods = (init.authMethods ?? []).map((method) => method.id);
    if (methods.includes(CACHED_METHOD)) {
      return readiness('authenticated', 'Signed in to Grok Build.');
    }
    return methods.includes(LOGIN_METHOD)
      ? readiness('unauthenticated', signInWith(GROK_BUILD_LOGIN))
      : readiness('authenticated', 'The CLI offers no sign-in method, so it is already signed in.');
  },
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'approval-required':
        return 'ask';
      case 'auto-accept-edits':
      case 'auto':
        return 'default';
      case 'full-access':
        return 'always-approve';
    }
  },
  inheritEnv: ['XAI_API_KEY'],
};

export function createGrokBuildAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(grokBuildAcp, options);
}
