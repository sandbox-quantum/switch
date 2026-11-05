import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpInitializeResult } from '../acp/protocol';
import { readiness, signInWith } from '../readiness';

const CACHED_TOKEN = 'cached_token';
const XAI_API_KEY = 'xai.api_key';
const GROK_LOGIN = 'grok.com';
const OIDC_LOGIN = 'oidc';

export const GROK_BUILD_LOGIN = 'grok login';

function authMethod(initialize: AcpInitializeResult): string | undefined {
  const defaultMethod = initialize.meta?.defaultAuthMethodId;
  if (typeof defaultMethod === 'string' && defaultMethod) return defaultMethod;

  const methods = initialize.authMethods ?? [];
  return (
    methods.find((method) => method.id === CACHED_TOKEN)?.id ??
    methods.find((method) => method.id === XAI_API_KEY)?.id ??
    methods.find((method) => method.id === GROK_LOGIN || method.id === OIDC_LOGIN)?.id
  );
}

function checkGrokBuildSignIn(initialize: AcpInitializeResult) {
  const methods = initialize.authMethods ?? [];
  if (methods.some((method) => method.id === CACHED_TOKEN || method.id === XAI_API_KEY))
    return readiness('authenticated', 'Signed in to Grok Build.');
  if (methods.some((method) => method.id === GROK_LOGIN || method.id === OIDC_LOGIN))
    return readiness('unauthenticated', signInWith(GROK_BUILD_LOGIN));
  return readiness(
    'unknown',
    'Grok Build did not report an authentication method. Check its installation and sign-in.'
  );
}

/** Grok Build's `grok acp`, using the generic ACP runtime. */
export const grokBuildAcp: AcpProviderHooks = {
  provider: 'grok-build',
  label: 'Grok Build',
  defaultBinary: 'grok',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['acp'], env }),
  loginCommand: GROK_BUILD_LOGIN,
  checkSignIn: async ({ handshake }) => checkGrokBuildSignIn(await handshake()),
  authMethodId: (_env, initialize) => authMethod(initialize),
};

export function createGrokBuildAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(grokBuildAcp, options);
}
