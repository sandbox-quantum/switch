import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const CLINE_LOGIN = 'cline auth';

/** The Cline data directory where saved provider settings and credentials live. */
export function clineProfile(env: Record<string, string>): string {
  return env.CLINE_DATA_DIR || join(env.HOME || homedir(), '.cline', 'data');
}

interface ClineProviderAuth {
  accountId?: string;
  accessToken?: string;
}

interface ClineProviderRecord {
  apiKey?: string;
  auth?: ClineProviderAuth;
  settings?: {
    apiKey?: string;
    auth?: ClineProviderAuth;
  };
}

interface ClineProvidersSettings {
  providers?: Record<string, ClineProviderRecord>;
}

/**
 * Checks whether Cline CLI has saved credentials in its global settings.
 * Cline persists OAuth tokens and configured provider API keys under
 * `~/.cline/data/settings/providers.json`.
 */
export async function clineSignedIn(dataDir: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(dataDir, 'settings', 'providers.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const data = JSON.parse(text) as ClineProvidersSettings | null;
    if (!data?.providers) return false;
    return Object.values(data.providers).some((p) => {
      const apiKey = p.apiKey ?? p.settings?.apiKey;
      const accountId = p.auth?.accountId ?? p.settings?.auth?.accountId;
      const accessToken = p.auth?.accessToken ?? p.settings?.auth?.accessToken;
      return (
        (typeof apiKey === 'string' && apiKey.trim().length > 0) ||
        (typeof accountId === 'string' && accountId.trim().length > 0) ||
        (typeof accessToken === 'string' && accessToken.trim().length > 0)
      );
    });
  } catch {
    return false;
  }
}

/** Cline CLI running in ACP mode (`cline --acp`). */
export const clineAcp: AcpProviderHooks = {
  provider: 'cline',
  label: 'Cline CLI',
  defaultBinary: 'cline',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp'],
    env,
  }),
  loginCommand: CLINE_LOGIN,
  inheritEnv: ['CLINE_API_KEY', 'CLINE_PROVIDER', 'CLINE_MODEL'],
  checkSignIn: async ({ handshake, env }) => {
    if (env.CLINE_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the Cline API key it was given.');
    }
    try {
      await handshake();
      return (await clineSignedIn(clineProfile(env)))
        ? readiness('authenticated', 'Signed in.')
        : readiness('unauthenticated', signInWith(CLINE_LOGIN));
    } catch (error) {
      if (
        /sign in|auth.*required|authentication required|unauthenticated|not logged in/i.test(
          String(error)
        )
      ) {
        return readiness('unauthenticated', signInWith(CLINE_LOGIN));
      }
      throw error;
    }
  },
  promptCapabilities: { image: true },
  sessionMode: () => 'act',
};

export function createClineAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(clineAcp, options);
}
