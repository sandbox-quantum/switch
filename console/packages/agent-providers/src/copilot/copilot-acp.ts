import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { optionalText } from '../host/provider-home';
import {
  loginWontHelp,
  readiness,
  signInWith,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';

const COPILOT_LOGIN = 'copilot login';

interface CopilotAccount {
  host?: unknown;
  login?: unknown;
}

/**
 * The account `copilot login` recorded in Copilot CLI's `config.json`, under
 * `COPILOT_HOME` or else `~/.copilot`: the last one signed in, while it is
 * still among the accounts signed in. The file starts with `//` comments, and
 * the token itself is kept elsewhere: in the system credential store, or in
 * this directory when there is none.
 */
async function savedLogin(env: Record<string, string>): Promise<ProviderReadiness> {
  const path = join(env.COPILOT_HOME || join(env.HOME || homedir(), '.copilot'), 'config.json');
  const text = await optionalText(path);
  if (text !== null) {
    const errors: ParseError[] = [];
    const config: unknown = parse(text, errors, { allowTrailingComma: true });
    if (errors.length || !config || typeof config !== 'object' || Array.isArray(config))
      return readiness('unknown', `Could not read the Copilot CLI sign-in: ${path} is not JSON.`);
    const { lastLoggedInUser: last, loggedInUsers } = config as {
      lastLoggedInUser?: CopilotAccount;
      loggedInUsers?: Array<CopilotAccount | null>;
    };
    if (
      typeof last?.host === 'string' &&
      typeof last.login === 'string' &&
      last.login &&
      Array.isArray(loggedInUsers) &&
      loggedInUsers.some((user) => user?.host === last.host && user?.login === last.login)
    )
      return readiness('authenticated', `Signed in to ${last.host} as ${last.login}.`);
  }
  return readiness(
    'unauthenticated',
    `${signInWith(COPILOT_LOGIN)} Or give it a token in COPILOT_GITHUB_TOKEN, or a model provider of your own in COPILOT_PROVIDER_BASE_URL and COPILOT_MODEL.`
  );
}

/**
 * Whether Copilot CLI can make model calls with what a session is given, in
 * the order it decides: a custom model provider, then COPILOT_GITHUB_TOKEN,
 * then the saved login. Copilot also takes GH_TOKEN and GITHUB_TOKEN, but a
 * session is not given them (see `inheritEnv`), so they count for nothing
 * here. Nothing is started, so nothing signs in and no session is added to
 * Copilot's own list.
 */
async function checkCopilotSignIn({ env }: SignInCheckInput): Promise<ProviderReadiness> {
  if (env.COPILOT_PROVIDER_BASE_URL?.trim())
    // Without a model Copilot exits as it starts: "BYOK providers require an explicit model."
    return env.COPILOT_MODEL?.trim() || env.COPILOT_PROVIDER_MODEL_ID?.trim()
      ? readiness(
          'authenticated',
          'Runs on the custom model provider in COPILOT_PROVIDER_BASE_URL, with no GitHub sign-in.'
        )
      : loginWontHelp(
          readiness(
            'unconfigured',
            'COPILOT_PROVIDER_BASE_URL names a custom model provider, which also needs a model: set COPILOT_MODEL.'
          )
        );
  if (env.COPILOT_GITHUB_TOKEN?.trim())
    return readiness('authenticated', 'Signs in with the COPILOT_GITHUB_TOKEN it was given.');
  return await savedLogin(env);
}

/** GitHub Copilot CLI's `copilot --acp`. */
export const copilotAcp: AcpProviderHooks = {
  provider: 'copilot',
  label: 'Copilot CLI',
  defaultBinary: 'copilot',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp', '--stdio'], env }),
  loginCommand: COPILOT_LOGIN,
  // The variables `copilot help environment` lists for signing in and for a
  // custom model provider, and GH_HOST, the GitHub host Copilot signs in to
  // when COPILOT_GH_HOST names none. GH_TOKEN and GITHUB_TOKEN, which Copilot
  // also reads, stay on the machine: they are usually a git or gh token, and
  // would outrank the saved login.
  inheritEnv: [
    'COPILOT_GITHUB_TOKEN',
    'COPILOT_GH_HOST',
    'COPILOT_HOME',
    'COPILOT_MODEL',
    'COPILOT_OFFLINE',
    'COPILOT_PROVIDER_API_KEY',
    'COPILOT_PROVIDER_API_KEY_COMMAND',
    'COPILOT_PROVIDER_AZURE_API_VERSION',
    'COPILOT_PROVIDER_BASE_URL',
    'COPILOT_PROVIDER_BEARER_TOKEN',
    'COPILOT_PROVIDER_HEADERS',
    'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS',
    'COPILOT_PROVIDER_MAX_PROMPT_TOKENS',
    'COPILOT_PROVIDER_MODEL_ID',
    'COPILOT_PROVIDER_TRANSPORT',
    'COPILOT_PROVIDER_TYPE',
    'COPILOT_PROVIDER_WIRE_API',
    'COPILOT_PROVIDER_WIRE_MODEL',
    'GH_HOST',
  ],
  // `initialize` lists `copilot-login` whether or not Copilot is signed in,
  // and with a custom provider too, so the handshake cannot tell.
  checkSignIn: checkCopilotSignIn,
  // Copilot's session modes are workflows (agent, plan, autopilot) and an ACP
  // session starts in agent mode, so none is set: Switch answers its
  // permission requests by the runtime mode, and auto mode asks the way
  // approval-required does.
  //
  // A tool on an MCP server is announced as `<server>-<tool>` and its
  // permission request names only `<tool>`; nothing else names the server.
  // The servers in Copilot's own configuration are named the same way, so a
  // request is placed on a session server only when the two names agree
  // exactly. An announcement on its own is shown as an MCP tool when it
  // starts with a session server's name. Commands and edits, whose titles the
  // model writes, are never taken for one.
  mcpServerOf: ({ kind, title }, servers, request) => {
    if (kind !== 'other' || !title) return undefined;
    return [...servers].find(
      (name) =>
        title.startsWith(`${name}-`) && (!request || title.slice(name.length + 1) === request.title)
    );
  },
  // The task tool starts a subagent, and is the only one whose input names an agent type.
  itemType: (toolCall) =>
    typeof toolCall.rawInput?.agent_type === 'string' ? 'subagent' : undefined,
};

export function createCopilotAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(copilotAcp, options);
}
