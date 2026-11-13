import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness } from '../readiness';

const GROK_LOGIN = 'grok login';
const GROK_SIGN_IN =
  'Sign in on the execution machine with grok login (or grok login --device-auth without a browser), or set XAI_API_KEY there.';

/** Grok Build's `grok agent stdio`. */
export const grokBuildAcp: AcpProviderHooks = {
  provider: 'grok-build',
  label: 'Grok Build',
  defaultBinary: 'grok',
  capabilities: {
    // `session/new`'s configOptions carries a select-type `model` option
    // (observed live, 2026-11-04), which is exactly what the generic
    // adapter's own model-switching path looks for — the mechanism is
    // present even though this account only ever offers one model to
    // choose from, so switching itself was not exercised.
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  // No `--no-auto-update`: despite docs.x.ai naming it for ACP/automated use,
  // it does not exist on 1.0.70 (`grok agent stdio --help` and `grok --help`
  // both refuse it with "unexpected argument"). Nothing to pin here.
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['agent', 'stdio'], env }),
  loginCommand: GROK_LOGIN,
  // `initialize`'s `authMethods` differs by sign-in state on its own (unlike
  // Cline, where it never changes): signed out it names one method,
  // `grok.com`; signed in it adds `cached_token` (and
  // `defaultAuthMethodId` becomes `"cached_token"`), confirmed live,
  // 2026-11-04. No `session/new` probe is needed, and `authenticate` is
  // never called by this check.
  checkSignIn: async ({ handshake, env }) => {
    if (env.XAI_API_KEY?.trim())
      return readiness('authenticated', 'Signs in with the XAI API key it was given.');
    const { authMethods } = await handshake();
    const signedIn = (authMethods ?? []).some((method) => method.id === 'cached_token');
    return signedIn
      ? readiness('authenticated', 'Signed in.')
      : readiness('unauthenticated', GROK_SIGN_IN);
  },
  // `XAI_API_KEY` is already in the shared `AGENT_ENV_VARS` pass-through
  // list (`host/agent-env.ts`), so nothing to add here.
  //
  // No `authMethodId`: a session starts and runs correctly with no explicit
  // `authenticate` call at all once signed in — `session/new` picks up the
  // cached token on its own (confirmed live). The only other method,
  // `grok.com`, is an interactive device-auth flow; starting it from a
  // session would only make sense if Switch could surface its URL/code to
  // the room the way it would a real prompt, which is unverified, so this
  // hook deliberately never triggers it. A truly signed-out session simply
  // fails clearly, and `checkSignIn`'s hint already told the person to run
  // `grok login` first.
  //
  // No `sessionMode`: `session/new`'s result never returns a `modes` field
  // at all (confirmed live, both signed-out and signed-in), and
  // `session/set_mode` accepts any string, including nonsense ids, and
  // always answers `{}` — it does not validate its input, so a success
  // response is not evidence a mode change took effect. With nothing
  // reliable to pin, this is left to the generic adapter's own runtime-mode
  // permission handling, which Cline and Cursor also rely on for everything
  // but a genuine workflow-mode vendor; our own probe confirmed Grok's
  // default state already asks for permission on an MCP tool call
  // (`session/request_permission`, with `kind: allow_once` among the
  // options), which is exactly what that handling needs to work.
  //
  // Grok retitles an MCP tool call from a generic `use_tool` wrapper to
  // `<server>__<tool>` once it resolves (confirmed live: `echo__switch_echo`),
  // the same shape observed for Cline.
  mcpServerOf: (toolCall) => {
    const name = toolCall.title?.split(':')[0] ?? '';
    const split = name.indexOf('__');
    return split > 0 && /^[\w.-]+$/.test(name.slice(0, split)) ? name.slice(0, split) : undefined;
  },
  // Every Grok tool call carries a stable identifier in `_meta['x.ai/tool'].name`
  // (confirmed live, 2026-11-04) that survives the title changing from the
  // generic wrapper name to the task's own description as the call resolves.
  // `spawn_subagent` is Grok's delegation tool: calling it runs a nested
  // conversation and reports back `rawOutput.type: 'SubagentCompleted'`.
  itemType: (toolCall) => {
    const tool = toolCall._meta?.['x.ai/tool'] as { name?: string } | undefined;
    return tool?.name === 'spawn_subagent' ? 'subagent' : undefined;
  },
};

export function createGrokBuildAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(grokBuildAcp, options);
}
