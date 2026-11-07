import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpConnection, AcpProviderHooks } from '../acp/hooks';
import {
  modelConfigOption,
  type AcpConfigOption,
  type AcpSessionResult,
  type AcpSessionUpdate,
  type AcpToolCall,
} from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import { loginWontHelp, readiness, type ProviderReadiness } from '../readiness';
import { JsonRpcError } from '../transport/stdio-json-rpc';

/**
 * Junie has no sign-in subcommand: the CLI's own Account screen signs it in,
 * which is also what its ACP `junie-cli` auth method tells a client to run.
 */
export const JUNIE_LOGIN = 'junie';
export const JUNIE_SIGN_IN =
  'Sign in to Junie on the execution machine: run junie and choose Continue with JetBrains account or Use a Junie API key on its Account screen, or set JUNIE_API_KEY in the environment the session host runs with.';
/** A signed-in account that JetBrains AI authorises no model for: no Junie licence, trial or key. */
export const JUNIE_NO_MODELS =
  'Junie is signed in but offers no model, so every turn would be refused: the JetBrains account has no Junie licence or trial, and no Junie API key or provider key is configured. On the execution machine run junie and add a Junie API key on its Account screen, start a Junie subscription or trial, or set a JUNIE_<PROVIDER>_API_KEY for your own provider.';

/** The notification Junie publishes for each session, saying which account it runs under. */
export const JUNIE_AUTH_STATUS = '_auth/status_update';

export interface JunieAuthStatus {
  /** `account` (JetBrains account), `api_key`, `gateway` or `none`. */
  kind: string;
  label?: string;
  detail?: string;
  account?: { email?: string; organization?: string };
}

const AUTH_STATUS_TIMEOUT_MS = 10_000;
const MODEL_WAIT_MS = 8_000;

/** What an empty session says about the account and the models Junie offers it. */
export interface JunieSessionReport {
  /** The settled auth status, a `none` that never settled, or null when none was published. */
  status: JunieAuthStatus | null;
  /** Whether the session offered a model, in `session/new` or a later config update. */
  modelsOffered: boolean;
}

/** What Console is told from an empty session's report. */
export function junieReadiness(report: JunieSessionReport): ProviderReadiness {
  if (!report.status)
    return readiness(
      'unknown',
      `Junie started but did not report whether it is signed in. If its sessions fail, sign in on the execution machine with ${JUNIE_LOGIN}.`
    );
  const signIn = readinessFromAuthStatus(report.status);
  // JetBrains AI authorises no model for an account without a Junie licence;
  // Junie still reports the account, and refuses every prompt.
  return signIn.status === 'authenticated' && !report.modelsOffered
    ? loginWontHelp(readiness('unconfigured', JUNIE_NO_MODELS))
    : signIn;
}

/** The sign-in Junie's auth status for a session reports. */
export function readinessFromAuthStatus(status: JunieAuthStatus): ProviderReadiness {
  switch (status.kind) {
    case 'none':
      return readiness('unauthenticated', JUNIE_SIGN_IN);
    case 'account':
      return readiness(
        'authenticated',
        `Signed in to Junie with a JetBrains account${status.account?.email ? ` (${status.account.email})` : ''}.`
      );
    case 'api_key':
      return readiness(
        'authenticated',
        `Signed in to Junie with an API key${status.label ? ` (${status.label})` : ''}.`
      );
    case 'gateway':
      return readiness('authenticated', 'Junie runs through a configured model gateway.');
    default:
      return readiness(
        'unknown',
        `Junie reports a sign-in of kind '${status.kind}' this build does not know. If its sessions fail, sign in on the execution machine with ${JUNIE_LOGIN}.`
      );
  }
}

interface SessionSignals {
  status?: JunieAuthStatus;
  models: boolean;
}

function offersModel(result: AcpSessionResult | { configOptions?: AcpConfigOption[] }): boolean {
  return (
    modelConfigOption(result.configOptions ?? []) !== undefined ||
    ('models' in result && (result.models?.availableModels?.length ?? 0) > 0)
  );
}

/**
 * Which account an empty session in `cwd` runs under and whether it offers a
 * model, from the `_auth/status_update` and config updates Junie publishes for
 * every session. Nothing is prompted and `authenticate` is never sent, so no
 * browser opens. Junie's first status is `none` ("Not ready") while its
 * account settles, so a `none` is only final when nothing better follows
 * within `statusWaitMs`; a settled account is then given `modelWaitMs` to
 * offer a model.
 */
export async function junieSessionReport(
  connection: AcpConnection,
  cwd: string,
  statusWaitMs = AUTH_STATUS_TIMEOUT_MS,
  modelWaitMs = MODEL_WAIT_MS
): Promise<JunieSessionReport> {
  const sessions = new Map<string, SessionSignals>();
  const signals = (id: string) => {
    const existing = sessions.get(id);
    if (existing) return existing;
    const created: SessionSignals = { models: false };
    sessions.set(id, created);
    return created;
  };
  const probe: { sessionId?: string } = {};
  let settleStatus: ((status: JunieAuthStatus) => void) | undefined;
  let settleModels: (() => void) | undefined;
  connection.onNotification(JUNIE_AUTH_STATUS, (params) => {
    const update = params as { sessionId?: unknown; authStatus?: JunieAuthStatus } | undefined;
    if (typeof update?.sessionId !== 'string' || !update.authStatus?.kind) return;
    signals(update.sessionId).status = update.authStatus;
    if (update.sessionId === probe.sessionId && update.authStatus.kind !== 'none')
      settleStatus?.(update.authStatus);
  });
  connection.onNotification('session/update', (params) => {
    const payload = params as { sessionId?: unknown; update?: AcpSessionUpdate } | undefined;
    if (typeof payload?.sessionId !== 'string' || !payload.update) return;
    if (payload.update.sessionUpdate !== 'config_option_update' || !offersModel(payload.update))
      return;
    signals(payload.sessionId).models = true;
    if (payload.sessionId === probe.sessionId) settleModels?.();
  });
  const session = await connection.request<AcpSessionResult>('session/new', {
    cwd,
    mcpServers: [],
  });
  probe.sessionId = session.sessionId;
  if (!probe.sessionId) return { status: null, modelsOffered: false };
  const own = signals(probe.sessionId);
  if (offersModel(session)) own.models = true;
  const wait = <T>(ms: number, arm: (settle: () => void) => void, value: () => T): Promise<T> =>
    new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(value()), ms);
      timer.unref();
      arm(() => {
        clearTimeout(timer);
        resolve(value());
      });
    });
  const status =
    own.status && own.status.kind !== 'none'
      ? own.status
      : await wait(
          statusWaitMs,
          (settle) => {
            settleStatus = () => settle();
          },
          () => own.status ?? null
        );
  if (status && status.kind !== 'none' && !own.models)
    await wait(
      modelWaitMs,
      (settle) => {
        settleModels = settle;
      },
      () => undefined
    );
  return { status, modelsOffered: own.models };
}

/**
 * Junie marks an MCP tool call with `_meta.is_mcp_tool_call` and titles it,
 * and the permission request for it, `<server>/<tool>` (`echo/switch_echo`);
 * its allowlist writes the same name as `<server>:<tool>`. The server is what
 * precedes the first slash or colon.
 */
export function junieMcpServer(toolCall: AcpToolCall): string | undefined {
  if (toolCall._meta?.is_mcp_tool_call !== true) return undefined;
  return /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)[/:][A-Za-z0-9_]/.exec(toolCall.title ?? '')?.[1];
}

/**
 * A delegated run arrives as a `think` tool call titled "Subagent <name>"
 * (Junie's legacy subagent pipeline, which carries no marker); a newer one may
 * mark it in `_meta` instead.
 */
export function junieSubagent(toolCall: AcpToolCall): boolean {
  const meta = toolCall._meta as
    | { junie?: { subagent?: unknown }; claudeCode?: { subagent?: unknown } }
    | undefined;
  return (
    meta?.junie?.subagent === true ||
    meta?.claudeCode?.subagent === true ||
    /^subagent\b/i.test(toolCall.title ?? '')
  );
}

/**
 * The brave-mode choice for a runtime mode: Safe (`off`) asks before every
 * sensitive action, Auto (`brave-auto`) runs the commands Junie's safety check
 * clears and asks for the rest, Brave (`on`) runs everything. Matched on the
 * value Junie offers, then on its label.
 */
const BRAVE_MODE: Record<RuntimeMode, { values: readonly string[]; label: RegExp }> = {
  'approval-required': { values: ['off'], label: /^(safe|off)$/i },
  // The adapter allows edits itself, and Junie only asks about edits outside the project.
  'auto-accept-edits': { values: ['off'], label: /^(safe|off)$/i },
  auto: { values: ['brave-auto', 'auto'], label: /^auto$/i },
  'full-access': { values: ['on', 'brave'], label: /^(brave|on)$/i },
};

/** The `brave_mode` value to set for `runtimeMode`, from the choices the session offers. */
export function junieBraveMode(runtimeMode: RuntimeMode, options: AcpConfigOption[]): string {
  const option = options.find((candidate) => candidate.id === 'brave_mode');
  if (!option)
    throw new Error(
      `Junie offers no brave_mode session option, so its permission level for ${runtimeMode} cannot be set.`
    );
  const choices = (option.options ?? []).flatMap((choice) =>
    'value' in choice ? [choice] : choice.options
  );
  const wanted = BRAVE_MODE[runtimeMode];
  const choice =
    choices.find((candidate) => wanted.values.includes(candidate.value)) ??
    choices.find((candidate) => wanted.label.test(candidate.name));
  if (!choice)
    throw new Error(
      `Junie offers no brave mode for ${runtimeMode}; it offers ${choices.map((candidate) => `${candidate.value} (${candidate.name})`).join(', ')}.`
    );
  return choice.value;
}

/** Junie's `junie --acp=true`, with its brave mode, MCP tool naming and subagent markers. */
export const junieAcp: AcpProviderHooks = {
  provider: 'junie',
  label: 'Junie',
  defaultBinary: 'junie',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  // The managed launcher would otherwise check for and download an update on
  // every session start.
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp=true', '--skip-update-check'],
    env,
  }),
  loginCommand: JUNIE_LOGIN,
  inheritEnv: [
    'JUNIE_API_KEY',
    'JUNIE_HOME',
    'JUNIE_LLM_PROVIDER',
    'JUNIE_ANTHROPIC_API_KEY',
    'JUNIE_OPENAI_API_KEY',
    'JUNIE_GOOGLE_API_KEY',
    'JUNIE_GROK_API_KEY',
    'JUNIE_META_API_KEY',
    'JUNIE_OPENROUTER_API_KEY',
    'JUNIE_LITELLM_URL',
    'JUNIE_LITELLM_API_KEY',
  ],
  checkSignIn: async ({ env, cwd, handshake, connection }) => {
    // Junie reads the key itself; a bad one fails the first turn.
    if (env.JUNIE_API_KEY?.trim())
      return readiness('authenticated', 'Signs in with the Junie API key it was given.');
    const agent = await handshake();
    if (!agent.authMethods?.length) return readiness('authenticated', 'Signed in to Junie.');
    // Junie lists its sign-in methods (a JetBrains account in a browser, the
    // terminal's Account screen) whether or not one is in use, so the
    // handshake alone does not say. An empty session does: Junie publishes
    // the account it runs under and the models it offers. `authenticate` is
    // never sent; for the account method it is the browser sign-in itself.
    try {
      return junieReadiness(await junieSessionReport(connection(), cwd));
    } catch (error) {
      if (error instanceof JsonRpcError && error.code === -32000)
        return readiness('unauthenticated', JUNIE_SIGN_IN);
      throw error;
    }
  },
  // Junie's permission level is its brave mode, a session config option; its
  // ACP modes (default, plan, goal) are workflows.
  sessionConfigOptions: (runtimeMode, options) => ({
    brave_mode: junieBraveMode(runtimeMode, options),
  }),
  // "Always allow" adds the action to ~/.junie/allowlist.json, which every
  // later run of Junie reads, in and outside Switch.
  persistentPermissionKinds: ['allow_always', 'reject_always'],
  mcpServerOf: junieMcpServer,
  itemType: (toolCall) => (junieSubagent(toolCall) ? 'subagent' : undefined),
};

export function createJunieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(junieAcp, options);
}
