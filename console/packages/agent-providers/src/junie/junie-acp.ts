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

export const JUNIE_LOGIN = 'junie login';
const SIGNED_OUT = /not logged in|login required|authentication required|not signed in|unauthenticated/i;

/** Reads output from `junie auth status` or `junie whoami`. */
export function parseJunieAuth(output: string): ProviderReadiness {
  if (SIGNED_OUT.test(output)) {
    return readiness('unauthenticated', signInWith(JUNIE_LOGIN));
  }
  const email = output.match(/(?:email|user|account)[: \t]+([^\s,;]+)/i)?.[1]?.trim();
  if (email && !SIGNED_OUT.test(email)) {
    return readiness('authenticated', `Signed in as ${email}.`);
  }
  if (/authenticated|logged in|sign-in valid|status: ok/i.test(output)) {
    return readiness('authenticated', 'Signed in.');
  }
  return readiness('unauthenticated', signInWith(JUNIE_LOGIN));
}

const MODE_PREFERENCES: Record<RuntimeMode, readonly string[]> = {
  'full-access': ['auto-approve', 'auto_edit', 'default'],
  'auto-accept-edits': ['accept-edits', 'auto_edit', 'default'],
  auto: ['accept-edits', 'default'],
  'approval-required': ['ask', 'default'],
};

export function junieSessionMode(
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

export async function checkJunieSignIn(
  input: AcpSignInInput
): Promise<ProviderReadiness> {
  const { binaryPath, cwd, env } = input;
  if (env.JETBRAINS_TOKEN?.trim() || env.JUNIE_API_KEY?.trim()) {
    return readiness('authenticated', 'Signs in with the JetBrains token it was given.');
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
    return parseJunieAuth(output);
  } catch (error) {
    output = commandOutput(error);
    if (output) {
      return parseJunieAuth(output);
    }
  }

  // Fallback to ACP handshake without starting an interactive browser sign-in
  try {
    await input.handshake();
    try {
      const status = await input.request<{ authenticated?: boolean; user?: { email?: string } }>(
        '_auth/status',
        {}
      );
      if (status?.authenticated === false) {
        return readiness('unauthenticated', signInWith(JUNIE_LOGIN));
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
      return readiness('unauthenticated', signInWith(JUNIE_LOGIN));
    }
    return readiness('unknown', `Could not verify authentication: ${message}`);
  }
}

export const junieAcp: AcpProviderHooks = {
  provider: 'junie',
  label: 'Junie',
  defaultBinary: 'junie',
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
  loginCommand: JUNIE_LOGIN,
  inheritEnv: ['JETBRAINS_TOKEN', 'JUNIE_API_KEY'],
  checkSignIn: checkJunieSignIn,
  sessionMode: junieSessionMode,
};

export function createJunieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(junieAcp, options);
}
