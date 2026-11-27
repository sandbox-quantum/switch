/**
 * The AI providers an app offers, as one list both apps draw from: which
 * providers there are (the server's list on the web, the provider registry in
 * Console, each filtered by the same feature flags), where each stands on the
 * chosen machine, and the logins each can be given there.
 */

/** A way a machine can be given a provider's login. */
export type LoginKind =
  | 'browser'
  | 'setup-token'
  | 'api-key'
  | 'auth-json'
  | 'this-computer'
  | 'vertex';
export type LoginKindOption = { value: LoginKind; label: string };

type LoginWay = 'setup-token' | 'api-key' | 'vertex' | 'sign-in-file';

/**
 * The logins a machine's agent controller takes for each provider, as it
 * opens and applies a sealed one (`@switch-console/agent-providers`'
 * `hostedCredentialSchema` and `materializeHostedProvider`), in the order
 * they are offered. A provider not here takes none.
 */
const LOGIN_WAYS: Record<string, readonly LoginWay[]> = {
  claude: ['setup-token', 'api-key', 'vertex'],
  codex: ['api-key', 'sign-in-file'],
  cursor: ['api-key'],
  opencode: ['sign-in-file'],
  antigravity: ['sign-in-file', 'vertex'],
};

/** How to get each provider's sign-in file, for a browser that picks it. */
const SIGN_IN_FILES: Record<string, string> = {
  codex:
    'Pick the sign-in file Codex writes when you sign in with your ChatGPT account (`codex login`): `~/.codex/auth.json`. It uses your ChatGPT subscription.',
  opencode:
    'Pick the sign-in file OpenCode writes when you sign in (`opencode auth login`): `~/.local/share/opencode/auth.json`.',
  antigravity:
    'Pick the sign-in file Antigravity writes when Switch Console signs it in: `~/.local/state/switch/antigravity-acp/antigravity-acp/acp_token.json`.',
};

/**
 * The logins a machine can be given for `provider` from this app. A sign-in
 * file is read from this computer where the app runs on one (`thisComputer`,
 * Console), and picked by the person in a browser.
 */
export function providerLoginKinds(provider: string, thisComputer: boolean): LoginKindOption[] {
  return (LOGIN_WAYS[provider] ?? []).map((way) => {
    if (way === 'setup-token') return { value: 'setup-token', label: 'Setup token' };
    if (way === 'api-key') return { value: 'api-key', label: 'API key' };
    if (way === 'vertex') return { value: 'vertex', label: 'Vertex AI' };
    return thisComputer
      ? { value: 'this-computer', label: "This computer's sign-in" }
      : { value: 'auth-json', label: 'Sign-in file' };
  });
}

/** The providers a machine's controller signs in through a browser. */
const BROWSER_SIGN_IN = new Set(['claude', 'codex', 'cursor', 'antigravity', 'opencode']);
/**
 * Those a Switch Cloud device signs in through a browser. Its agents' CLIs
 * never hold the real login: the provider gateway does, and of these sign-ins
 * it fronts Claude Code's setup token and Codex's ChatGPT sign-in, which it
 * renews itself. OpenCode keeps its ChatGPT sign-in in a file of its own the
 * gateway doesn't front, and Cursor and Antigravity keep theirs inside the CLI.
 */
const CLOUD_BROWSER_SIGN_IN = new Set(['claude', 'codex']);

/** What a browser sign-in asks of the person, by provider, once the machine shows its page. */
const BROWSER_HINTS: Record<string, string> = {
  claude:
    'Sign in with your Claude account on a page that opens in a new tab, then paste back the code it shows.',
  codex:
    'Sign in with your ChatGPT account on a page that opens in a new tab, and type in the code shown here.',
  opencode:
    'Sign in with your ChatGPT account on a page that opens in a new tab, and type in the code shown here. OpenCode then uses your ChatGPT subscription.',
  cursor:
    'Sign in with your Cursor account on a page that opens in a new tab; the machine notices by itself. The sign-in stays on the machine; sign out of Cursor there to remove it.',
  antigravity:
    'Sign in with your Google account on a page that opens in a new tab, then paste back the code the page shows. The sign-in stays on the machine; sign out of Antigravity there to remove it.',
};

/** What to paste back into a browser sign-in waiting for the code its page shows. */
export function browserCodePrompt(provider: string): string {
  return provider === 'antigravity'
    ? 'Once you have signed in, paste the code the page shows, or the full address of the page you landed on:'
    : 'Paste the code the page shows once you have signed in:';
}

/** Signing in through a browser, offered first where a machine can: null where it can't. */
export function browserSignInKind(provider: string, cloud: boolean): LoginKindOption | null {
  if (!(cloud ? CLOUD_BROWSER_SIGN_IN : BROWSER_SIGN_IN).has(provider)) return null;
  return { value: 'browser', label: 'Sign in with browser' };
}

/** What to give for a login of `kind`, for the provider called `name`. */
export function loginHint(
  provider: string,
  name: string,
  kind: LoginKind,
  vertexFrom: 'key' | 'this-computer'
): string {
  if (kind === 'vertex')
    return vertexFrom === 'key'
      ? `${name} signs in to Google Vertex AI with a service account key. Make one for a service account that can use only Vertex AI (roles/aiplatform.user), and paste its JSON or pick its file.`
      : `${name} signs in to Google Vertex AI as you, with the sign-in \`gcloud auth application-default login\` made on this computer.`;
  if (kind === 'browser')
    return (
      BROWSER_HINTS[provider] ??
      `Sign in with your ${name} account on a page that opens in a new tab.`
    );
  if (kind === 'setup-token')
    return 'Run `claude setup-token` on any computer signed in to Claude, and paste the token it prints.';
  if (kind === 'auth-json')
    return SIGN_IN_FILES[provider] ?? `Pick the sign-in file ${name} writes when you sign in.`;
  if (kind === 'this-computer')
    return `The ${name} sign-in on this computer is sent, sealed for the machine.`;
  return `Paste a ${name} API key.`;
}

/** A provider a machine may run an agent with, as it last reported it. */
export type MachineProviderOption<P extends string> = {
  id: P;
  name: string;
  ready: boolean;
  problem: string | null;
};

/** How long after a machine connects the checks it starts with may still be reporting. */
const REPORT_PATIENCE_MS = 60_000;

/**
 * Whether a machine has reported every provider it runs: it checks them all
 * as it starts and reports each as its check ends, so one still missing from
 * a report made a minute after it connected is one it does not run. False
 * while either time is unknown.
 */
export function providerReportSettled(
  connectedAt: string | null,
  observedAt: string | null
): boolean {
  if (!connectedAt || !observedAt) return false;
  return Date.parse(observedAt) - Date.parse(connectedAt) >= REPORT_PATIENCE_MS;
}

/**
 * Each provider offered, in the order offered, with where it stands on the
 * machine: ready (installed and signed in), or why not. One the machine has
 * not reported is "not checked yet" while its report may still be coming
 * (`settled`, `providerReportSettled`), and "not available" once it is not.
 */
export function machineProviderOptions<P extends string>(
  offered: readonly { id: P; name: string }[],
  reported: readonly { provider: string; ready: boolean; problem: string | null }[],
  settled: boolean
): MachineProviderOption<P>[] {
  return offered.map((provider) => {
    const report = reported.find((entry) => entry.provider === provider.id);
    return {
      id: provider.id,
      name: provider.name,
      ready: report?.ready ?? false,
      problem: report ? report.problem : settled ? 'not available' : 'not checked yet',
    };
  });
}
