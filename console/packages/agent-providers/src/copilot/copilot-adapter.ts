import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

export const COPILOT_LOGIN = 'copilot login';

/** The one auth method the CLI's `initialize` reply names (verified against 1.0.105). */
const LOGIN_METHOD = 'copilot-login';

/**
 * Whether a sign-in source that needs no handshake is already present: a
 * GitHub token from the environment, or bring-your-own-key provider config,
 * which the CLI documents as a way to run without a GitHub sign-in at all.
 */
export function copilotEnvSignIn(env: Record<string, string>): boolean {
  if (env.COPILOT_GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()) {
    return true;
  }
  if (env.COPILOT_PROVIDERS_CONFIG?.trim()) return true;
  // A provider type by itself does not authenticate anything. The inline
  // provider form needs an endpoint and a credential (or a credential command).
  const endpoint = env.COPILOT_PROVIDER_BASE_URL?.trim();
  const credential =
    env.COPILOT_PROVIDER_API_KEY?.trim() ||
    env.COPILOT_PROVIDER_BEARER_TOKEN?.trim() ||
    env.COPILOT_PROVIDER_API_KEY_COMMAND?.trim();
  return Boolean(endpoint && credential);
}

/**
 * Whether the login `copilot login` saves is present. The CLI keeps its state
 * in `config.json` under `$COPILOT_HOME` (or `~/.copilot`): a commented file
 * whose `loggedInUsers` names the saved logins — empty on a machine that has
 * only ever run signed out, which is why the `initialize` reply cannot be
 * trusted for this: 1.0.105 names its login method either way.
 */
export async function copilotSignedIn(env: Record<string, string>): Promise<boolean> {
  const home = env.COPILOT_HOME || join(env.HOME || homedir(), '.copilot');
  try {
    const raw = await readFile(join(home, 'config.json'), 'utf8');
    const firstBrace = raw.indexOf('{');
    if (firstBrace === -1) return false;
    const config = JSON.parse(raw.slice(firstBrace)) as { loggedInUsers?: unknown };
    return Array.isArray(config.loggedInUsers) && config.loggedInUsers.length > 0;
  } catch {
    return false;
  }
}

/**
 * GitHub Copilot CLI as an ACP provider.
 *
 * Launch is `copilot --acp --stdio`. The 1.0.105 handshake advertises
 * `loadSession`, image and embedded-context prompts and HTTP/SSE MCP
 * servers; its session capabilities are close and list only, so a session is
 * resumed with `session/load`, never forked. A signed-out `session/new`
 * refuses outright ("You are not authenticated"), so sign-in state has to be
 * settled before a session starts: the hooks answer it from the environment
 * and the saved login, and name the terminal auth method only when neither
 * is present.
 *
 * The CLI has no Switch-shaped permission modes to map onto: the issue
 * itself notes `--yolo` may not take effect in ACP mode and Switch must
 * answer permission requests itself, which is what the generic adapter does
 * from the runtime mode — so there is deliberately no `sessionMode` hook.
 */
export const copilotAcp: AcpProviderHooks = {
  provider: 'copilot',
  label: 'GitHub Copilot CLI',
  defaultBinary: 'copilot',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp', '--stdio'],
    env,
  }),
  promptCapabilities: { image: true, embeddedContext: true },
  loginCommand: COPILOT_LOGIN,
  authMethodId: (env) => (copilotEnvSignIn(env) ? undefined : LOGIN_METHOD),
  // A saved `copilot login` session is already usable. Sending the ACP login
  // method in that case would unnecessarily start another browser flow.
  alreadySignedIn: async ({ env }) => copilotEnvSignIn(env) || (await copilotSignedIn(env)),
  checkSignIn: async ({ env, handshake }): Promise<ProviderReadiness> => {
    if (copilotEnvSignIn(env)) {
      return readiness(
        'authenticated',
        'Signs in with a GitHub token or provider config from the environment.'
      );
    }
    if (await copilotSignedIn(env)) {
      return readiness('authenticated', 'Signed in to GitHub Copilot CLI.');
    }
    const init = await handshake();
    return (init.authMethods ?? []).length > 0
      ? readiness('unauthenticated', signInWith(COPILOT_LOGIN))
      : readiness('authenticated', 'The CLI offers no sign-in method, so it is already signed in.');
  },
  inheritEnv: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_PROVIDERS_CONFIG'],
};

export function createCopilotAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(copilotAcp, options);
}
