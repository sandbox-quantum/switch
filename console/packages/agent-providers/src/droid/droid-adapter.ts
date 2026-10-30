import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const DROID_LOGIN = 'droid login';

export function droidHome(env: Record<string, string>): string {
  return env.FACTORY_HOME || join(homedir(), '.factory');
}

export function droidSignedIn(env: Record<string, string>): boolean {
  if (env.FACTORY_API_KEY?.trim()) return true;
  const keyring = join(droidHome(env), 'auth.v2.keyring');
  try {
    return existsSync(keyring) && statSync(keyring).size > 0;
  } catch {
    return false;
  }
}

/** Factory Droid's `droid exec --output-format acp` provider runtime hooks. */
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
  promptCapabilities: { image: true },
  checkSignIn: async ({ handshake, env }) => {
    if (env.FACTORY_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the Factory API key it was given.');
    }
    if (droidSignedIn(env)) {
      return readiness('authenticated', 'Signed in.');
    }
    try {
      const init = await handshake();
      if (init.authMethods?.length) {
        return readiness('unauthenticated', signInWith(DROID_LOGIN));
      }
      return readiness('authenticated', 'Signed in.');
    } catch (error) {
      if (/sign in|auth required|unauthenticated|unauthorized|not logged in/i.test(String(error))) {
        return readiness('unauthenticated', signInWith(DROID_LOGIN));
      }
      throw error;
    }
  },
};

export function createDroidAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(droidAcp, options);
}
