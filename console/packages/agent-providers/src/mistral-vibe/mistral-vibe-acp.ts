import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type {
  AcpAdapterOptions,
  AcpProviderHooks,
  AcpSignInInput,
} from '../acp/hooks';
import type { AcpSessionModes } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import { execProvider } from '../provider-process';
import {
  commandOutput,
  readiness,
  signInWith,
  SIGNED_OUT_ERROR,
  type ProviderReadiness,
} from '../readiness';

export const VIBE_LOGIN = 'vibe login';
const SIGNED_OUT = /not logged in|login required|authentication required|not signed in|unauthenticated/i;

/** Reads output from `vibe auth status` or `vibe whoami`. */
export function parseMistralVibeAuth(output: string): ProviderReadiness {
  if (SIGNED_OUT.test(output)) {
    return readiness('unauthenticated', signInWith(VIBE_LOGIN));
  }
  const email = output.match(/(?:email|user|logged in as)[: \t]+([^\s,;]+)/i)?.[1]?.trim();
  if (email && !SIGNED_OUT.test(email)) {
    return readiness('authenticated', `Signed in as ${email}.`);
  }
  if (/authenticated|logged in|sign-in valid|status: ok/i.test(output)) {
    return readiness('authenticated', 'Signed in.');
  }
  return readiness('unauthenticated', signInWith(VIBE_LOGIN));
}

const MODE_PREFERENCES: Record<RuntimeMode, readonly string[]> = {
  'full-access': ['auto-approve', 'yolo', 'default'],
  'auto-accept-edits': ['accept-edits', 'auto_edit', 'default'],
  auto: ['smart-approve', 'accept-edits', 'default'],
  'approval-required': ['ask', 'default'],
};

export function mistralVibeSessionMode(
  runtimeMode: RuntimeMode,
  modes: AcpSessionModes | undefined
): string | undefined {
  if (!modes?.availableModes.length) return undefined;
  const preferences = MODE_PREFERENCES[runtimeMode];
  return (
    preferences.find((id) => modes.availableModes.some((mode) => mode.id === id)) ??
    modes.availableModes[0]?.id
  );
}

export async function checkMistralVibeSignIn(
  input: AcpSignInInput
): Promise<ProviderReadiness> {
  const { binaryPath, cwd, env } = input;
  if (env.MISTRAL_API_KEY?.trim()) {
    return readiness('authenticated', 'Signs in with the Mistral API key it was given.');
  }

  let output: string;
  try {
    output = (
      await execProvider(binaryPath, ['auth', 'status'], {
        cwd,
        env,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
    return parseMistralVibeAuth(output);
  } catch (error) {
    output = commandOutput(error);
    if (output) {
      return parseMistralVibeAuth(output);
    }
  }

  // Fallback to ACP handshake without starting an interactive login
  try {
    await input.handshake();
    try {
      const status = await input.request<{ authenticated?: boolean; user?: { email?: string } }>(
        '_auth/status',
        {}
      );
      if (status?.authenticated === false) {
        return readiness('unauthenticated', signInWith(VIBE_LOGIN));
      }
      if (status?.authenticated || status?.user?.email) {
        return readiness(
          'authenticated',
          status.user?.email ? `Signed in as ${status.user.email}.` : 'Signed in.'
        );
      }
    } catch {
      // _auth/status not supported
    }
    return readiness('authenticated', 'Signed in.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (SIGNED_OUT_ERROR.test(message)) {
      return readiness('unauthenticated', signInWith(VIBE_LOGIN));
    }
    return readiness('unknown', `Could not verify authentication: ${message}`);
  }
}

export const mistralVibeAcp: AcpProviderHooks = {
  provider: 'mistral-vibe',
  label: 'Mistral Vibe',
  defaultBinary: 'vibe',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp'],
    env,
  }),
  loginCommand: VIBE_LOGIN,
  inheritEnv: ['MISTRAL_API_KEY'],
  checkSignIn: checkMistralVibeSignIn,
  sessionMode: mistralVibeSessionMode,
};

export function createMistralVibeAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(mistralVibeAcp, options);
}
