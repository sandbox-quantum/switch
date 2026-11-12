import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import { answerFormElicitations, FORM_ELICITATION_CAPABILITIES } from '../acp/elicitation';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpSessionModes, AcpToolCall } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import { readiness, signInWith } from '../readiness';

const MISTRAL_VIBE_LOGIN = 'vibe-acp --setup';

/**
 * Vibe's modes for each runtime mode, best first. They are permission
 * profiles: `ask` asks before every tool, `accept-edits` runs edits,
 * `smart-approve` has Vibe's own reviewer run the calls it rates safe and ask
 * for the rest, and `auto-approve` runs everything.
 */
const MODE_PREFERENCES: Record<RuntimeMode, readonly string[]> = {
  'full-access': ['auto-approve'],
  auto: ['smart-approve', 'accept-edits', 'ask'],
  'auto-accept-edits': ['accept-edits', 'ask'],
  'approval-required': ['ask'],
};

/**
 * The mode for `runtimeMode` among those the session advertised. Vibe ignores
 * a mode it does not offer without an error, and its config can hide any of
 * them (`enabled_agents`, `disabled_agents`), so a session that has to ask
 * before running tools and is offered no mode that asks is refused rather
 * than left in whatever mode Vibe starts in. Full access needs no mode: the
 * adapter approves every request a full-access session receives.
 */
export function mistralVibeSessionMode(
  runtimeMode: RuntimeMode,
  modes: AcpSessionModes | undefined
): string | undefined {
  const preferences = MODE_PREFERENCES[runtimeMode];
  const mode = preferences.find((id) => modes?.availableModes.some((offered) => offered.id === id));
  if (mode || runtimeMode === 'full-access') return mode;
  throw new Error(
    `Mistral Vibe offered none of the modes this session needs (${preferences.join(', ')}), so it could not be made to ask before running tools. Enable one in Vibe's config (enabled_agents, disabled_agents), or give the agent full access.`
  );
}

/**
 * Vibe's alias for an MCP server: `mcp_` and its name, with each character
 * other than a letter, digit, `_` or `$` replaced by `_`.
 */
const vibeMcpAlias = (server: string) => `mcp_${server.replace(/[^A-Za-z0-9_$]/gu, '_') || '_'}`;

/**
 * The alias in an MCP tool's name, `mcp_<alias>.<tool>`. A permission request
 * with no call to point to names the tool in place of a call id.
 */
function mcpAliasOf(toolCall: AcpToolCall): string | undefined {
  const name = toolCall._meta?.tool_name ?? toolCall.toolCallId;
  return typeof name === 'string' ? /^(mcp_[^.]+)\./.exec(name)?.[1] : undefined;
}

/** Mistral Vibe's `vibe-acp`. */
export const mistralVibeAcp: AcpProviderHooks = {
  provider: 'mistral-vibe',
  label: 'Mistral Vibe',
  defaultBinary: 'vibe-acp',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  // Sessions are given no keyring bus, so a sign-in check that ran with one
  // would read a key in the desktop keyring that no session can.
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: [],
    env: Object.fromEntries(
      Object.entries(env).filter(([name]) => name !== 'DBUS_SESSION_BUS_ADDRESS')
    ),
  }),
  loginCommand: MISTRAL_VIBE_LOGIN,
  // Where Vibe keeps its `.env` key, its config and the sessions it resumes.
  inheritEnv: ['VIBE_HOME'],
  // `authMethods` offers browser sign-in whether or not a key is saved, and
  // `authenticate` would open the browser. `_auth/status` is Vibe's read-only
  // answer, covering a key in the environment, in `.env` or in the keyring.
  checkSignIn: async ({ handshake, request }) => {
    await handshake();
    const { authenticated } = await request<{ authenticated: boolean }>('_auth/status', {});
    return authenticated
      ? readiness('authenticated', 'Signed in to Mistral Vibe.')
      : readiness(
          'unauthenticated',
          `${signInWith(MISTRAL_VIBE_LOGIN)} On Linux, keep the key in MISTRAL_API_KEY or $VIBE_HOME/.env: sessions cannot reach the desktop keyring.`
        );
  },
  // vibe-acp 3.1 takes HTTP MCP servers without declaring `mcpCapabilities.http`.
  mcpCapabilities: { http: true },
  sessionMode: mistralVibeSessionMode,
  // Vibe normalises the server name in an alias, and gives servers whose names
  // normalise alike suffixed aliases instead, so an alias maps back only to the
  // one registered server it names: a call it cannot place asks a person.
  mcpServerOf: (toolCall, mcpServerNames) => {
    const alias = mcpAliasOf(toolCall);
    if (!alias) return undefined;
    const servers = [...mcpServerNames].filter((server) => vibeMcpAlias(server) === alias);
    return servers.length === 1 ? servers[0] : undefined;
  },
  itemType: (toolCall) =>
    toolCall._meta?.effect_kind === 'subagent'
      ? 'subagent'
      : mcpAliasOf(toolCall)
        ? 'mcp_tool_call'
        : undefined,
  // Vibe offers its `ask_user_question` tool only to a client that answers
  // form elicitations. Each question is a field whose title is its header and
  // whose description is the question.
  clientCapabilities: FORM_ELICITATION_CAPABILITIES,
  extensions: answerFormElicitations,
};

export function createMistralVibeAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(mistralVibeAcp, options);
}
