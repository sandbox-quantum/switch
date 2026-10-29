import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSignInInput } from '../acp/hooks';
import type { AcpInitializeResult, AcpToolCall } from '../acp/protocol';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

export const DROID_LOGIN = 'droid';

/**
 * Checks whether Factory Droid authentication tokens or configuration exists
 * on disk in ~/.factory.
 */
export async function hasFactoryAuth(env: Record<string, string>): Promise<boolean> {
  const home = env.USERPROFILE || env.HOME || homedir();
  if (!home) return false;
  const factoryDir = join(home, '.factory');
  for (const file of ['auth.json', 'config.json', 'settings.json', 'tokens.json']) {
    try {
      const content = await readFile(join(factoryDir, file), 'utf8');
      if (content.trim()) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Parses authentication state from the environment, initialize handshake,
 * and local auth state.
 */
export function parseDroidAuth(
  env: Record<string, string>,
  init: AcpInitializeResult,
  hasAuthOnDisk: boolean
): ProviderReadiness {
  if (env.FACTORY_API_KEY?.trim()) {
    return readiness('authenticated', 'Signs in with the Factory API key it was given.');
  }
  if (hasAuthOnDisk || !init.authMethods?.length) {
    return readiness('authenticated', 'Signed in to Factory Droid.');
  }
  return readiness('unauthenticated', signInWith(DROID_LOGIN));
}

/**
 * Factory Droid's ACP implementation using `droid exec --output-format acp`.
 */
export const droidAcp: AcpProviderHooks = {
  provider: 'droid',
  label: 'Factory Droid',
  defaultBinary: 'droid',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['exec', '--output-format', 'acp'],
    env,
  }),
  loginCommand: DROID_LOGIN,
  inheritEnv: ['FACTORY_API_KEY'],
  checkSignIn: async ({ handshake, env }: AcpSignInInput) => {
    if (env.FACTORY_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the Factory API key it was given.');
    }
    try {
      const init = await handshake();
      const hasAuthOnDisk = await hasFactoryAuth(env);
      return parseDroidAuth(env, init, hasAuthOnDisk);
    } catch (error) {
      if (
        /not logged in|not authenticated|login required|authentication required|not signed in|unauthenticated/i.test(
          String(error)
        )
      ) {
        return readiness('unauthenticated', signInWith(DROID_LOGIN));
      }
      throw error;
    }
  },
  promptCapabilities: { image: true },
  mcpServerOf: (toolCall: AcpToolCall) => {
    const meta = toolCall._meta as Record<string, unknown> | undefined;
    const metaServer = (meta?.mcp as Record<string, unknown> | undefined)?.server ?? meta?.server;
    if (typeof metaServer === 'string' && metaServer) return metaServer;
    const raw = toolCall.rawInput as Record<string, unknown> | undefined;
    const rawServer = raw?.providerIdentifier ?? raw?.server;
    if (typeof rawServer === 'string' && rawServer) return rawServer;
    return undefined;
  },
};

export function createDroidAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(droidAcp, options);
}
