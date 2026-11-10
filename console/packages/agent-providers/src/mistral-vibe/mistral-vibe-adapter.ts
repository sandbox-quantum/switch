import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const MISTRAL_VIBE_LOGIN = 'vibe --setup';

export function vibeHome(env: Record<string, string | undefined> = process.env): string {
  return env.VIBE_HOME?.trim() || join(homedir(), '.vibe');
}

export function vibeSignedIn(env: Record<string, string | undefined> = process.env): boolean {
  if (env.MISTRAL_API_KEY?.trim()) {
    return true;
  }
  const home = vibeHome(env);
  const candidates = [
    join(home, 'config.toml'),
    join(home, '.env'),
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

/** Mistral Vibe's `vibe-acp` / `vibe acp`. */
export const mistralVibeAcp: AcpProviderHooks = {
  provider: 'mistral-vibe',
  label: 'Mistral Vibe',
  defaultBinary: 'vibe-acp',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => {
    const isVibeAcp = binaryPath.endsWith('vibe-acp') || binaryPath.endsWith('vibe-acp.exe');
    return {
      command: binaryPath,
      args: isVibeAcp ? [] : ['acp'],
      env,
    };
  },
  loginCommand: MISTRAL_VIBE_LOGIN,
  inheritEnv: ['MISTRAL_API_KEY'],
  checkSignIn: async ({ env }) => {
    return vibeSignedIn(env)
      ? readiness('authenticated', 'Signed in.')
      : readiness('unauthenticated', signInWith(MISTRAL_VIBE_LOGIN));
  },
  promptCapabilities: { image: true },
  sessionMode: () => 'default',
};

export function createMistralVibeAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(mistralVibeAcp, options);
}
