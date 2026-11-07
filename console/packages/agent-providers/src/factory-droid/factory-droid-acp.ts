import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { RuntimeMode } from '../adapter';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

/** Droid has no login subcommand: run bare, it starts its sign-in when it holds none. */
export const DROID_LOGIN = 'droid';

/**
 * Droid's autonomy levels, which `droid exec --output-format acp` 1.5.0 offers
 * as its session modes: `normal` runs only reads unasked, `auto-low` adds file
 * edits and low-risk commands, `auto-medium` adds recoverable ones (installs,
 * local git, builds) and still asks for risky ones, `auto-high` runs
 * everything. An organization can cap the level; a mode above the cap is
 * refused, so the session fails to start rather than running with less.
 */
const DROID_MODES: Record<RuntimeMode, string> = {
  'approval-required': 'normal',
  'auto-accept-edits': 'auto-low',
  auto: 'auto-medium',
  'full-access': 'auto-high',
};

interface DoctorCheck {
  id?: string;
  status?: string;
  detail?: string;
}

/**
 * Reads `droid doctor --checks auth --json`. Its `auth.verify` check passes
 * for a usable stored login and warns "not logged in" without one. A
 * `FACTORY_API_KEY` is only checked against the API with connectivity probes
 * too, so this check leaves it "inconclusive": the key is taken as given, and
 * a bad one fails the first turn.
 */
export function parseDroidDoctor(output: string, apiKey: boolean): ProviderReadiness {
  let checks: DoctorCheck[] = [];
  try {
    checks = (JSON.parse(output) as { results?: DoctorCheck[] }).results ?? [];
  } catch {
    // Not the report; handled below as unknown.
  }
  const verify = checks.find((check) => check.id === 'auth.verify');
  if (verify?.status === 'pass') return readiness('authenticated', 'Signed in.');
  if (apiKey && verify?.status === 'warn')
    return readiness('authenticated', 'Signs in with the Factory API key it was given.');
  if (verify?.status === 'fail' || /not logged in/i.test(verify?.detail ?? ''))
    return readiness('unauthenticated', signInWith(DROID_LOGIN));
  return readiness(
    'unknown',
    'Could not verify authentication. Check provider setup and try again.'
  );
}

/**
 * Factory's Droid, as `droid exec --output-format acp`. It signs in with
 * `FACTORY_API_KEY` or the login `droid` stores, which it reads itself when a
 * session starts, so a session sends no `authenticate`.
 */
export const factoryDroidAcp: AcpProviderHooks = {
  provider: 'factory-droid',
  label: 'Factory Droid',
  defaultBinary: 'droid',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    // Droid asks its AskUser questions as form elicitations whose answers it
    // reads back in its own shape; until those are mapped, it is not told the
    // client takes them and answers its own questions as cancelled.
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['exec', '--output-format', 'acp'],
    env,
  }),
  loginCommand: DROID_LOGIN,
  inheritEnv: ['FACTORY_API_KEY'],
  // Never `session/new`: without a login or a key, Droid 1.5.0 answers it by
  // requesting a device-pairing code, which is a sign-in started. The doctor's
  // auth checks read the stored login and the key without starting one.
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['doctor', '--checks', 'auth', '--json'], {
          cwd,
          env,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      output = commandOutput(error);
    }
    return parseDroidDoctor(output, Boolean(env.FACTORY_API_KEY?.trim()));
  },
  sessionMode: (runtimeMode) => DROID_MODES[runtimeMode],
  // Droid 1.5.0 names an MCP tool's server in `_meta.factory`.
  mcpServerOf: (toolCall) => {
    const factory = toolCall._meta?.factory as { source?: unknown; server?: unknown } | undefined;
    return factory?.source === 'mcp' && typeof factory.server === 'string' && factory.server
      ? factory.server
      : undefined;
  },
};

export function createFactoryDroidAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(factoryDroidAcp, options);
}
