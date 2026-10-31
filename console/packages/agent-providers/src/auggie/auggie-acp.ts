import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

const AUGGIE_LOGIN = 'auggie login';

/** Never return the CLI's output: `token print` contains the credential. */
export function parseAuggieSession(output: string): ProviderReadiness {
  try {
    // 0.36.0 wraps the JSON in a SESSION= line and usage instructions.
    const assignment = output.split(/\r?\n/).find((line) => /^(?:SESSION|TOKEN)=/.test(line));
    const session: unknown = JSON.parse(
      assignment ? assignment.replace(/^(?:SESSION|TOKEN)=\s*/, '') : output.trim()
    );
    if (
      typeof session === 'object' &&
      session !== null &&
      'accessToken' in session &&
      typeof session.accessToken === 'string' &&
      session.accessToken.trim() &&
      'tenantURL' in session &&
      typeof session.tenantURL === 'string' &&
      session.tenantURL.trim()
    )
      return readiness('authenticated', 'Auggie has a stored authentication session.');
  } catch {
    if (
      !/not (?:currently )?(?:logged|signed) in|no (?:stored |authentication )?(?:session|token)/i.test(
        output
      )
    )
      return readiness(
        'unknown',
        'Could not read Auggie authentication. Check CLI setup and retry.'
      );
  }
  return readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
}

/** Auggie's native ACP agent; permissions are handled by the generic adapter. */
export const auggieAcp: AcpProviderHooks = {
  provider: 'auggie',
  label: 'Auggie',
  defaultBinary: 'auggie',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  // Auggie otherwise asks for indexing consent before the first turn exists,
  // which an unattended session host cannot answer. Auggie indexes this cwd.
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp', '--allow-indexing'],
    env,
  }),
  loginCommand: AUGGIE_LOGIN,
  inheritEnv: ['AUGMENT_SESSION_AUTH', 'AUGMENT_DISABLE_AUTO_UPDATE'],
  // 0.36.0 accepts HTTP MCP entries (including headers) in createSession,
  // but omits mcpCapabilities from initialize. Keep explicit vendor refusals.
  mcpCapabilities: { http: true },
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    // Check the supplied session first, as the CLI does. This checks credential
    // presence, not vendor validity; an expired/revoked token fails the first turn.
    if (env.AUGMENT_SESSION_AUTH?.trim()) return parseAuggieSession(env.AUGMENT_SESSION_AUTH);
    try {
      const { stdout } = await execProvider(binaryPath, ['token', 'print'], {
        cwd,
        env,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      return parseAuggieSession(stdout);
    } catch (error) {
      // Do not propagate an exec error: its message can contain session JSON.
      const output = error as { stdout?: unknown; stderr?: unknown };
      if (
        [output.stdout, output.stderr].some(
          (text) =>
            typeof text === 'string' &&
            /not (?:currently )?(?:logged|signed) in|no (?:stored |authentication )?(?:session|token)|login required/i.test(
              text
            )
        )
      )
        return readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
      return readiness(
        'unknown',
        'Could not check Auggie authentication. Check CLI setup and retry.'
      );
    }
  },
  // No CLI bypass flag: full-access auto-allows ACP permission requests once;
  // approval-required and auto continue to ask through Switch.
};

export function createAuggieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(auggieAcp, options);
}
