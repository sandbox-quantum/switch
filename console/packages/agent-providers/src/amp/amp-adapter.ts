import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const AMP_LOGIN = 'amp login';

export function ampHome(env: Record<string, string | undefined> = process.env): string {
  return env.AMP_HOME?.trim() || join(homedir(), '.amp');
}

export function ampSignedIn(env: Record<string, string | undefined> = process.env): boolean {
  if (env.AMP_API_KEY?.trim()) {
    return true;
  }
  const home = ampHome(env);
  const candidates = [
    join(home, 'config.json'),
    join(home, 'token'),
    join(homedir(), '.config', 'amp', 'config.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).size > 2) {
        return true;
      }
    } catch {
      // unreadable or non-existent
    }
  }
  return false;
}

/**
 * Amp's `amp-acp` / `amp acp`.
 *
 * Amp CLI natively speaks Sourcegraph's stream-json protocol and `@ampcode/sdk`.
 * Bridging via `amp-acp` maps it cleanly to the Agent Client Protocol (ACP),
 * enabling native Switch session management, model choices, and tool permission approvals.
 */
export const ampAcp: AcpProviderHooks = {
  provider: 'amp',
  label: 'Amp',
  defaultBinary: 'amp-acp',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => {
    const isAmpAcp = binaryPath.endsWith('amp-acp') || binaryPath.endsWith('amp-acp.exe');
    return {
      command: binaryPath,
      args: isAmpAcp ? [] : ['acp'],
      env,
    };
  },
  loginCommand: AMP_LOGIN,
  inheritEnv: ['AMP_API_KEY'],
  checkSignIn: async ({ env }) => {
    return ampSignedIn(env)
      ? readiness('authenticated', 'Signed in.')
      : readiness('unauthenticated', signInWith(AMP_LOGIN));
  },
  promptCapabilities: { image: true },
  sessionMode: () => 'default',
};

export function createAmpAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(ampAcp, options);
}
