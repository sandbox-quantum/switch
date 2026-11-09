import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness } from '../readiness';
import { JsonRpcError } from '../transport/stdio-json-rpc';

const JUNIE_LOGIN = 'junie';
const JUNIE_SIGN_IN =
  'Sign in on the execution machine by running junie and completing sign-in (a JetBrains account, or a Junie API key from junie.jetbrains.com/cli).';

/** JetBrains' Junie, `junie --acp=true`. */
export const junieAcp: AcpProviderHooks = {
  provider: 'junie',
  label: 'Junie',
  defaultBinary: 'junie',
  capabilities: {
    // `session/new`'s configOptions carries a select-type `model` option
    // (confirmed live, 2026-11-06, signed in), which is exactly what the
    // generic adapter's own model-switching path looks for.
    modelSwitchInSession: true,
    // `initialize`'s `_meta.steering.supported` is true (confirmed live,
    // signed out and signed in alike).
    steering: true,
    // `agentCapabilities.loadSession: true` and `sessionCapabilities.resume`
    // are both advertised (confirmed live); the generic adapter prefers
    // `session/load` when `loadSession` is set.
    resume: true,
    // `session/request_permission` is ACP's baseline mechanism; Junie's own
    // default permission mode (`brave_mode: "brave-auto"`, confirmed live)
    // is "ask for anything risky", consistent with asking at all. Not
    // measured whether it actually asks for a real tool call: no model turn
    // ran under the account used (see below).
    approvals: true,
    // No ask-the-user mechanism was observed, but no real turn ran either to
    // observe one either way (checked 2026-11-06, blocked at the model-call
    // step by the account's subscription — see checkSignIn).
    userInput: false,
  },
  // `--skip-update-check` exists and is documented "for CI or automation"
  // (`junie --help`, 2026-11-06): a session host is exactly that, and an
  // agent updating itself mid-session would be unwelcome. No flag disables
  // auto-update outright; this only skips the startup check for one.
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp=true', '--skip-update-check'],
    env,
  }),
  loginCommand: JUNIE_LOGIN,
  // `initialize`'s `authMethods` never changes between signed-out and
  // signed-in (confirmed live, 2026-11-06: always exactly one method,
  // `jetbrains-account`), so unlike Grok it carries no signal. `session/new`
  // does: signed out it fails immediately with a JSON-RPC -32000,
  // "Authentication is required before this operation can be performed.";
  // signed in it succeeds and returns configOptions. `session/list`
  // (`sessionCapabilities.list`) is the same signal for less work — no
  // session object is created — mirroring how Antigravity's own check
  // works. Neither call is ever answered differently by signing in through
  // `authenticate`: a session started right after `initialize` succeeds with
  // no `authenticate` round trip at all once `junie` has been signed in
  // interactively once, so there is no `authMethodId` hook below either.
  checkSignIn: async ({ handshake, request }) => {
    await handshake();
    try {
      await request('session/list', {});
      return readiness('authenticated', 'Signed in.');
    } catch (error) {
      if (
        error instanceof JsonRpcError &&
        error.code === -32000 &&
        /authentication is required/i.test(error.message)
      )
        return readiness('unauthenticated', JUNIE_SIGN_IN);
      throw error;
    }
  },
  // No `sessionMode`: Junie's permission level is a session config option
  // (`brave_mode`: off = Safe (asks for everything), brave-auto = Auto
  // (auto-approves safe commands, asks for the rest), on = Brave (never
  // asks)), not an ACP `modes`/`session/set_mode` value — `session/new`
  // never returns a `modes` field (confirmed live). There is no hook to set
  // a config option at session start without a generic adapter change, so
  // this is left at Junie's own default (`brave-auto`), the same way Cursor
  // and Grok leave an unreachable vendor mode and rely on the generic
  // adapter's own per-request permission answers instead. Full-access and
  // approval-required both therefore depend on Junie actually sending
  // `session/request_permission` for a real tool call under `brave-auto`,
  // which was not observed: no model turn ran under the account used for
  // this work (see `checkSignIn`'s docs and the PR description for why).
  //
  // No `mcpServerOf` or `itemType`: both would need a resolved MCP tool
  // call's exact shape, and the account used could create a session with a
  // stdio MCP server registered (no protocol error) but never actually
  // reach a model turn that could call it. Left to the generic adapter's
  // own fallback (`toolCallId` starting with `mcp_`) until observed.
};

export function createJunieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(junieAcp, options);
}
