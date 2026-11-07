import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

export const AUGGIE_LOGIN = 'auggie login';

const SIGNED_OUT = /not (?:currently )?logged in/i;

/**
 * What a failed `auggie token print` means: signed out when it says so, else
 * unknown. What the command prints is never repeated, because when it
 * succeeds that is the session itself.
 */
export function auggieSignInFailure(error: unknown): ProviderReadiness {
  const { code, stdout, stderr } = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  const output = [stdout, stderr].filter((text) => typeof text === 'string').join('\n');
  if (SIGNED_OUT.test(output)) return readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
  return readiness(
    'unknown',
    `Could not verify the Augment sign-in${typeof code === 'string' ? ` (${code})` : ''}. Check that auggie runs on the execution machine and try again.`
  );
}

/** Augment's Auggie, `auggie --acp`, on the generic ACP adapter. */
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
  // Before a session's first turn Auggie asks, as a permission request,
  // whether it may index the working directory with Augment's context engine.
  // No turn is running, so the adapter can only cancel it, and Auggie goes on
  // without its index. The flag answers for this session: the directory an
  // agent is given is the code it is there to work on. A session runs the
  // version installed on the machine and does not update itself.
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp', '--allow-indexing'],
    env: { ...env, AUGMENT_DISABLE_AUTO_UPDATE: '1' },
  }),
  loginCommand: AUGGIE_LOGIN,
  // The session `auggie login` stores, as `auggie token print` prints it, for
  // a machine nobody can sign in on.
  inheritEnv: ['AUGMENT_SESSION_AUTH'],
  unsupportedPlatforms: {
    win32:
      'Augment supports Auggie on Windows only inside WSL, so it cannot run on Windows directly.',
  },
  // `initialize` lists no sign-in method whether or not Auggie is signed in,
  // and `authenticate` does nothing: the sign-in is `auggie login` on the
  // machine, or a session in AUGMENT_SESSION_AUTH. `token print` reads both
  // the way a session does, and exits 0 only when one is usable.
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    try {
      await execProvider(binaryPath, ['token', 'print'], {
        cwd,
        env,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      return auggieSignInFailure(error);
    }
    return readiness('authenticated', 'Signed in to Augment.');
  },
  // Auggie 0.36.0 answers `initialize` without `mcpCapabilities`, but its
  // `session/new` takes HTTP servers (name, url, headers) and gives them to
  // its MCP client as it does the servers in its own settings. The Switch
  // tools are served over HTTP, so without this no session could start.
  mcpCapabilities: { http: true },
  // Auggie's ACP modes are workflows (Default, Ask), not permission levels, so
  // the runtime mode is enforced on its permission requests: each action its
  // own safety check does not pass is offered as Allow or Deny. It has no
  // switch that approves everything; full access is the adapter answering
  // Allow to each request.
};

export function createAuggieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(auggieAcp, options);
}
