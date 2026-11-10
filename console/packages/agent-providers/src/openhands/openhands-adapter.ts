import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const OPENHANDS_LOGIN = 'openhands login';

export function openhandsHome(env: Record<string, string | undefined> = process.env): string {
  return env.OPENHANDS_HOME?.trim() || join(homedir(), '.openhands');
}

export function openhandsSignedIn(env: Record<string, string | undefined> = process.env): boolean {
  if (
    env.OPENHANDS_API_KEY?.trim() ||
    env.ALL_HANDS_API_KEY?.trim() ||
    env.LLM_API_KEY?.trim()
  ) {
    return true;
  }
  const home = openhandsHome(env);
  const candidates = [
    join(home, 'settings.json'),
    join(home, 'agent_settings.json'),
    join(home, 'cli_config.json'),
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

/** OpenHands' `openhands acp`. */
export const openhandsAcp: AcpProviderHooks = {
  provider: 'openhands',
  label: 'OpenHands',
  defaultBinary: 'openhands',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['acp'], env }),
  loginCommand: OPENHANDS_LOGIN,
  inheritEnv: ['OPENHANDS_API_KEY', 'ALL_HANDS_API_KEY', 'LLM_API_KEY'],
  checkSignIn: async ({ env }) => {
    return openhandsSignedIn(env)
      ? readiness('authenticated', 'Signed in.')
      : readiness('unauthenticated', signInWith(OPENHANDS_LOGIN));
  },
  promptCapabilities: { image: true },
  sessionMode: () => 'default',
};

export function createOpenhandsAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(openhandsAcp, options);
}
