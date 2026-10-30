import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const COPILOT_LOGIN = 'copilot login';

const AUTH_ERROR_PATTERN = /sign[- ]?in|auth|login|unauthenticated|unauthorized|not logged in/i;

/**
 * Checks whether Copilot CLI has a saved login in ~/.copilot/config.json.
 * Like Antigravity, Copilot CLI lists its login authMethod in initialize
 * regardless of whether an active login exists, so local credentials are
 * verified when no environment token is supplied.
 */
export async function copilotSignedIn(env: Record<string, string>): Promise<boolean> {
  const home = env.COPILOT_HOME || env.HOME || homedir();
  try {
    const raw = await readFile(join(home, '.copilot', 'config.json'), 'utf8');
    const firstBrace = raw.indexOf('{');
    if (firstBrace === -1) return false;
    const config = JSON.parse(raw.slice(firstBrace)) as {
      loggedInUsers?: Array<{ login?: string }>;
    };
    return Array.isArray(config.loggedInUsers) && config.loggedInUsers.length > 0;
  } catch {
    return false;
  }
}

/** GitHub Copilot CLI running over ACP with stdio transport. */
export const copilotAcp: AcpProviderHooks = {
  provider: 'copilot',
  label: 'GitHub Copilot',
  defaultBinary: 'copilot',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp', '--stdio'],
    env,
  }),
  loginCommand: COPILOT_LOGIN,
  inheritEnv: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_PROVIDERS_CONFIG'],
  promptCapabilities: { image: true },
  checkSignIn: async ({ handshake, env }) => {
    if (
      env.COPILOT_GITHUB_TOKEN?.trim() ||
      env.GH_TOKEN?.trim() ||
      env.GITHUB_TOKEN?.trim() ||
      env.COPILOT_PROVIDERS_CONFIG?.trim() ||
      Object.keys(env).some((key) => key.startsWith('COPILOT_PROVIDER_') && env[key]?.trim())
    ) {
      return readiness(
        'authenticated',
        'Signs in with token or provider configuration from environment.'
      );
    }
    try {
      await handshake();
      if (await copilotSignedIn(env)) {
        return readiness('authenticated', 'Signed in to GitHub Copilot CLI.');
      }
      return readiness('unauthenticated', signInWith(COPILOT_LOGIN));
    } catch (error) {
      if (AUTH_ERROR_PATTERN.test(String(error))) {
        return readiness('unauthenticated', signInWith(COPILOT_LOGIN));
      }
      throw error;
    }
  },
};

export function createCopilotAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(copilotAcp, options);
}
