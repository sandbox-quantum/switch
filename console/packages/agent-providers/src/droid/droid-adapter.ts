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

type DoctorAuth =
  | { kind: 'signed-in' }
  | { kind: 'signed-out' }
  | { kind: 'unverified'; reason: string };

function credentialsFound(env: Record<string, string | undefined>): string {
  if (env.FACTORY_API_KEY?.trim()) return 'A Factory API key was given';
  if (hasFactoryAuth(env)) return 'Factory Droid credentials were found';
  return 'No Factory Droid credentials were found';
}

/**
 * Asks `droid doctor` whether the stored login or API key works. The
 * signed-out case is recognised by droid 1.5.0's wording of the check's
 * detail; any other outcome comes back as `unverified` with what doctor said.
 */
async function doctorAuth(
  binaryPath: string,
  cwd: string,
  env: Record<string, string>
): Promise<DoctorAuth> {
  let stdout: string;
  try {
    stdout = (
      await execProvider(binaryPath, ['doctor', '--checks', 'auth', '--json'], {
        cwd,
        env,
        timeout: 5000,
        maxBuffer: 512 * 1024,
      })
    ).stdout;
  } catch (error) {
    // doctor exits 1 when any sub-check fails (an offline WorkOS probe, say)
    // but still writes the full report to stdout.
    const output = (error as { stdout?: unknown }).stdout;
    if (typeof output !== 'string' || !output.trim()) {
      return {
        kind: 'unverified',
        reason: `droid doctor failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    stdout = output;
  }
  let report: { results?: Array<{ id: string; status: string; detail?: string }> };
  try {
    report = JSON.parse(stdout) as typeof report;
  } catch (error) {
    return {
      kind: 'unverified',
      reason: `droid doctor's output is not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const verify = report.results?.find((result) => result.id === 'auth.verify');
  if (!verify) {
    return { kind: 'unverified', reason: "droid doctor's report has no auth.verify check" };
  }
  if (verify.status === 'pass') return { kind: 'signed-in' };
  if (verify.detail && /not logged in|no usable credentials/i.test(verify.detail)) {
    return { kind: 'signed-out' };
  }
  return {
    kind: 'unverified',
    reason: `droid doctor's auth check reported ${verify.status}: ${verify.detail ?? 'no detail'}`,
  };
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
    const probe = await doctorAuth(binaryPath, cwd, env);
    if (probe.kind === 'signed-in') {
      return readiness('authenticated', 'Signed in to Factory Droid.');
    }
    if (probe.kind === 'signed-out') {
      return readiness('unauthenticated', signInWith(DROID_LOGIN));
    }
    return readiness('unknown', `${credentialsFound(env)}, but ${probe.reason}`);
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
    const match = name?.match(/^(.+?)___/);
    if (match) return match[1];
    return undefined;
  },
};

export function createDroidAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(droidAcp, options);
}
