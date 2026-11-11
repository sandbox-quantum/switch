import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import { formElicitation } from '../acp/elicitation';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const DROID_LOGIN = 'droid';

/**
 * Only auth.verify establishes authentication. Credential-file presence and
 * initialize.authMethods do not: Droid advertises both methods even signed out.
 * Never return doctor details: they can contain account and deployment data.
 */
export function parseDroidDoctor(output: string): ProviderReadiness {
  const unknown = () =>
    readiness(
      'unknown',
      'Could not verify Factory authentication. Run droid doctor --checks auth on the execution machine; update Droid to 1.4.1 or newer if doctor is unavailable.'
    );
  try {
    const report: { results?: Array<{ id?: string; status?: string; detail?: string }> } =
      JSON.parse(output);
    const auth = report.results?.find((result) => result.id === 'auth.verify');
    if (auth?.status === 'pass') return readiness('authenticated', 'Signed in to Factory.');
    if (
      auth &&
      /no usable credentials found \(not logged in\)|Factory API rejected it/i.test(
        auth.detail ?? ''
      )
    )
      return readiness('unauthenticated', signInWith(DROID_LOGIN));
    return unknown();
  } catch {
    return unknown();
  }
}

/** Native ACP, verified with Factory Droid 1.4.1 on Linux x64. */
export const droidAcp: AcpProviderHooks = {
  provider: 'droid',
  label: 'Factory Droid',
  defaultBinary: 'droid',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  // Matches Factory's ACP registry entry. Both acp and acp-daemon answered
  // initialize in 1.4.1; bare `droid acp-daemon` is not an ACP entry point.
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['exec', '--output-format', 'acp-daemon'],
    env,
  }),
  loginCommand: DROID_LOGIN,
  inheritEnv: ['FACTORY_API_KEY', 'FACTORY_HOME_OVERRIDE', 'FACTORY_DISABLE_KEYRING'],
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    let output: string;
    try {
      ({ stdout: output } = await execProvider(
        binaryPath,
        ['doctor', '--checks', 'auth', '--json', '--timeout', '5000'],
        { cwd, env, timeout: 20_000, maxBuffer: 1024 * 1024 }
      ));
    } catch (error) {
      // Doctor can exit nonzero for a failed check. Parse only its structured
      // stdout, never echo its stderr or an exec error (which includes output).
      output = commandOutput(error);
    }
    return parseDroidDoctor(output);
  },
  // Keep native auto-run off even in full access: Switch answers allow_once
  // itself. A saved auto-high preference must not bypass chat approvals.
  sessionMode: (_runtimeMode, modes) => {
    if (!modes?.availableModes.some((mode) => mode.id === 'normal'))
      throw new Error('Factory Droid must offer normal (Auto Off) mode for Switch approvals.');
    return 'normal';
  },
  // Droid's allow_always options include persistent policies and changes to
  // autonomy tiers. None is a proven session-only grant.
  permissionOptions: (options) => options.filter((option) => option.kind !== 'allow_always'),
  mcpServerOf: (call) => {
    const factory = call._meta?.factory as { source?: unknown; server?: unknown } | undefined;
    return factory?.source === 'mcp' && typeof factory.server === 'string'
      ? factory.server
      : undefined;
  },
  itemType: (call) => (call._meta?.subagent_session_info ? 'subagent' : undefined),
  clientCapabilities: { elicitation: { form: {} } },
  extensions: formElicitation,
};

export function createDroidAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(droidAcp, options);
}
