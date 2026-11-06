import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSignInInput } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import { execProvider } from '../provider-process';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

export const DROID_LOGIN = 'droid';

const AUTH_FILES = ['auth.v2.keyring', 'auth.v2.loginkeychain', 'auth.v2.file'] as const;

export function droidHome(env: Record<string, string | undefined>): string {
  const base =
    env.FACTORY_HOME_OVERRIDE?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return join(base, '.factory');
}

/**
 * Checks whether Factory Droid authentication credentials exist on disk in the .factory directory.
 * Inspects Linux keyring, macOS loginkeychain, and fallback auth file.
 */
export function hasFactoryAuth(env: Record<string, string | undefined>): boolean {
  const dir = droidHome(env);
  return AUTH_FILES.some((file) => {
    try {
      const p = join(dir, file);
      return existsSync(p) && statSync(p).size > 0;
    } catch {
      return false;
    }
  });
}

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
  inheritEnv: [
    'FACTORY_API_KEY',
    'FACTORY_HOME_OVERRIDE',
    'FACTORY_APPEND_SYSTEM_PROMPT',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
  ],
  checkSignIn: async ({ binaryPath, cwd, env }: AcpSignInInput): Promise<ProviderReadiness> => {
    if (env.FACTORY_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the Factory API key it was given.');
    }
    if (hasFactoryAuth(env)) {
      return readiness('authenticated', 'Signed in to Factory Droid.');
    }
    let stdout = '';
    try {
      const res = await execProvider(binaryPath, ['doctor', '--checks', 'auth', '--json'], {
        cwd,
        env,
        timeout: 5000,
        maxBuffer: 512 * 1024,
      });
      stdout = res.stdout;
    } catch (err) {
      // droid doctor exits with code 1 if any sub-check fails (e.g. offline WorkOS probe),
      // but still writes the complete diagnostic JSON to stdout.
      if (err && typeof (err as { stdout?: string }).stdout === 'string') {
        stdout = (err as { stdout: string }).stdout;
      }
    }
    if (stdout.trim()) {
      try {
        const data = JSON.parse(stdout) as {
          results?: Array<{ id: string; status: string; detail?: string }>;
        };
        const verify = data.results?.find((r) => r.id === 'auth.verify');
        if (verify?.status === 'pass') {
          return readiness('authenticated', 'Signed in to Factory Droid.');
        }
        // Human-readable string from droid 1.5.0 doctor output; pinned in unit test fixtures.
        if (verify?.detail && /not logged in|no usable credentials/i.test(verify.detail)) {
          return readiness('unauthenticated', signInWith(DROID_LOGIN));
        }
      } catch {
        // Output not valid JSON; fall through to unknown
      }
    }
    // If doctor failed or shape was unrecognized, return unknown (avoids false negative on macOS Keychain)
    return readiness(
      'unknown',
      'Could not verify authentication. Check provider setup and try again.'
    );
  },
  authMethodId: (env) => (env.FACTORY_API_KEY?.trim() ? 'factory-api-key' : undefined),
  promptCapabilities: {
    image: true,
    embeddedContext: true,
  },
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
        return 'auto-high';
      case 'auto':
        return 'auto-medium';
      case 'auto-accept-edits':
        return 'auto-low';
      case 'approval-required':
      default:
        return 'normal';
    }
  },
  mcpServerOf: (toolCall: AcpToolCall): string | undefined => {
    // Verified live from Gate 2.4 echo MCP wire frames:
    // Droid emits toolCall._meta.factory.server and names tools as "${server}___${tool}".
    const meta = toolCall._meta as { factory?: { server?: string } } | undefined;
    if (typeof meta?.factory?.server === 'string') return meta.factory.server;
    const name = (toolCall as { name?: string }).name ?? toolCall.title;
    const match = name?.match(/^([^_]+)___/);
    if (match) return match[1];
    return undefined;
  },
};

export function createDroidAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(droidAcp, options);
}
