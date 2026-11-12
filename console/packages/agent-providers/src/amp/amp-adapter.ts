import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider, findOnPath } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const AMP_LOGIN = 'amp login';
export const AMP_SIGN_IN = signInWith(AMP_LOGIN);

/** Interactive amp-acp --setup prompts only — never JSON-RPC lines. */
const SETUP_PROMPT = /paste your amp api key|no api key provided\. aborting/i;

/** Parses `amp account list --json` without spending model credits. */
export function parseAmpAccountList(output: string): ProviderReadiness {
  let parsed: { accounts?: Array<{ email?: string; active?: boolean }> };
  try {
    parsed = JSON.parse(output) as { accounts?: Array<{ email?: string; active?: boolean }> };
  } catch {
    return readiness(
      'unknown',
      'Could not verify Amp authentication. Check provider setup and try again.'
    );
  }
  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  if (accounts.some((account) => account.active === true || Boolean(account.email)))
    return readiness('authenticated', 'Signed in to Amp.');
  return readiness('unauthenticated', AMP_SIGN_IN);
}

async function resolveAmpCli(env: Record<string, string>): Promise<string | null> {
  const fromEnv = env.AMP_CLI_PATH?.trim();
  if (fromEnv) return fromEnv;
  return findOnPath('amp', env.PATH);
}

/**
 * Amp's `amp-acp` bridge.
 *
 * Amp has no native ACP. `amp-acp` maps the Amp CLI (`--stream-json` /
 * `@ampcode/sdk`) onto ACP v1 over stdio so Switch can reuse the generic ACP
 * adapter. Permissions are Amp session modes `default` (asks) and `bypass`
 * (auto-allow); sign-in is shared with the Amp CLI (`amp login` / `AMP_API_KEY`).
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
  launch: async ({ binaryPath, env }) => {
    const ampCli = await resolveAmpCli(env);
    return {
      command: binaryPath,
      args: [],
      env: {
        ...env,
        ...(ampCli ? { AMP_CLI_PATH: ampCli } : {}),
        BROWSER: 'false',
      },
      rejectOutputLine: (line) => {
        // stdout also carries JSON-RPC (initialize lists an auth method whose
        // description mentions an API key); only kill on interactive prompts.
        if (line.trimStart().startsWith('{')) return undefined;
        return SETUP_PROMPT.test(line) ? AMP_SIGN_IN : undefined;
      },
    };
  },
  loginCommand: AMP_LOGIN,
  inheritEnv: ['AMP_API_KEY', 'AMP_CLI_PATH'],
  // Amp is already signed in via the CLI or AMP_API_KEY; calling authenticate
  // would run amp-acp --setup, which is interactive and not finishable on a host.
  checkSignIn: async ({ cwd, env }) => {
    if (env.AMP_API_KEY?.trim())
      return readiness('authenticated', 'Signs in with the Amp API key it was given.');
    const ampCli = await resolveAmpCli(env);
    if (!ampCli)
      return readiness(
        'unconfigured',
        `Install the Amp CLI and run ${AMP_LOGIN} on the execution machine.`
      );
    let output: string;
    try {
      output = (
        await execProvider(ampCli, ['account', 'list', '--json'], {
          cwd,
          env,
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      output = commandOutput(error);
      if (!output.trim())
        return readiness(
          'unknown',
          `Could not verify Amp authentication (${String(error)}). ${AMP_SIGN_IN}`
        );
    }
    return parseAmpAccountList(output);
  },
  promptCapabilities: { image: true, embeddedContext: true },
  // Amp Neo's default mode runs tools without asking unless a permissions
  // plugin uses `ask`. amp-acp maps Switch modes onto Amp's permission modes:
  // `bypass` sets Amp's dangerouslyAllowAll for unattended runs; `default`
  // leaves Amp's configured behavior. amp-acp 0.12.0 does not yet surface Amp
  // `ask` rules as ACP session/request_permission, so Switch cannot offer
  // chat approvals for Amp tool calls until the bridge does.
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
      case 'auto':
      case 'auto-accept-edits':
        return 'bypass';
      case 'approval-required':
        return 'default';
    }
  },
};

export function createAmpAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(ampAcp, options);
}
