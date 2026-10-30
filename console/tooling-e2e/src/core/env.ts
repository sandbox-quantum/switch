import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Configuration for the harness. Every value is a secret or a deployment
 * address, so nothing is hard-coded: it comes from the process environment, or
 * from a gitignored `.env` beside this package. Deployed environments' URLs are
 * deliberately absent from source.
 */

/**
 * Which runner mode a run is in.
 *
 * `fast` needs nothing but a Switch server (and Mattermost, for the scenarios
 * that cross the bridge): no provider, no Console, no LLM key. It is the lane
 * that can gate pull requests, because it carries no secrets a fork lacks.
 * `provider` needs a real agent session attending the room, driven by Switch
 * Console or its sidecar. `browser` drives the gateway UI in a headless
 * Chromium against the same server: a smoke test of what an operator sees,
 * which no HTTP-level scenario can see break. `agentic` runs the same real
 * session as `provider`, but a model plays the human from a scenario file and
 * another model judges the conversation.
 */
export type Lane = 'fast' | 'provider' | 'browser' | 'agentic';

/** Every lane: the one list anything that takes a lane by name checks against. */
export const LANES: readonly Lane[] = ['fast', 'provider', 'browser', 'agentic'];

export function isLane(raw: string): raw is Lane {
  return (LANES as readonly string[]).includes(raw);
}

/**
 * What the target is. Scenarios declare which they may run against.
 *
 * `ephemeral` is a stack created for this run and destroyed after it, so a
 * scenario may change server-global state there (feature flags, for one).
 * `local` is a developer's own long-lived stack. `prod` is read-only: the
 * clients refuse every authenticated write against it.
 */
export type Environment = 'ephemeral' | 'local' | 'dev' | 'staging' | 'prod';

/** The Switch known-agent type the provider lane registers its throwaway agent as. */
export type HarnessAgentType =
  | 'opencode'
  | 'claude-code'
  | 'codex'
  | 'antigravity'
  | 'cursor'
  | 'mistral-vibe';

/**
 * How the `question` scenario expects the agent to ask.
 *
 * `numbered` is the real thing: the provider offers a native ask-the-user tool,
 * the console relays it into the room as a numbered list, and the answer goes
 * back by number. It is the default for every agent type. `prose` is the
 * explicit fallback for a provider whose SDK sessions are offered no such tool:
 * the agent asks in an ordinary message and is answered with the word. The
 * round trip being tested (the session is still alive and still connected when
 * the second message arrives) is the same; the relay path is not exercised.
 */
export type QuestionMode = 'numbered' | 'prose';

export interface SwitchEnv {
  apiUrl: string;
  gatewayAdminEmail: string;
  gatewayAdminPassword: string;
  agentRegistrationToken: string;
}

export interface MattermostEnv {
  url: string;
  /** Token of the **human** the harness posts as. */
  token: string;
  /** Team slug (e.g. `switch`), not its display name. */
  team: string;
}

/** Settings only the provider lane reads. */
export interface ProviderEnv {
  /** Working directory the console session under test runs from. */
  agentRepoDir: string | null;
  /**
   * Where a setup records the agent and room it created, so a later process can
   * reuse them instead of registering its own. Needed because a Switch Console
   * session can only be pointed at an agent that already exists: seed first,
   * start the console, then run the scenarios against the same agent.
   */
  manifestPath: string | null;
  /** Which agent type to register, and so which provider's runtime is exercised. */
  agentType: HarnessAgentType;
  /** How `question` expects the clarifying question to arrive. */
  questionMode: QuestionMode;
  /**
   * A headless agent controller to run the agent on. When set, setup places
   * the agent on it through the management API and writes no Switch Console
   * files; when not, a Console session for the agent is expected instead.
   */
  controllerId: string | null;
}

/**
 * Settings only the agentic lane reads. Each is null when unset, and the lane's
 * scenarios then need it (`agentic-models`): a model is never picked for a run
 * that did not name one, and a run never spends without a limit.
 */
export interface AgenticEnv {
  /** Exact model id that plays the human. */
  driverModel: string | null;
  /** Exact model id that judges the conversation. */
  judgeModel: string | null;
  /** What the lane may spend, driver, judge and agent together, in USD. */
  budgetUsd: number | null;
  /**
   * A file of provider keys (`ANTHROPIC_API_KEY=…`), the one the agent
   * controller is handed too. Without it, the driver and judge use the
   * Claude Code CLI's own sign-in.
   */
  providerEnvFile: string | null;
}

export interface HarnessEnv {
  lane: Lane;
  environment: Environment;
  /**
   * In strict mode a scenario whose prerequisites are missing fails instead of
   * skipping. CI runs strict, so a misconfigured job goes red rather than
   * reporting a suite that ran nothing as green.
   */
  strict: boolean;
  /** Leave created agents, rooms and channels behind after the run (for debugging). */
  keepArtifacts: boolean;
  /** Where to record the credentials the server issues during the run; see `IssuedSecrets`. */
  secretsFile: string | null;
  /** The server's JSON log, when the harness can read it; see `ServerLog`. */
  serverLog: string | null;
  /**
   * The gateway UI, served against `switch.apiUrl` (its `/gateway` requests
   * reach that server). Only the browser lane reads it.
   */
  gatewayUiUrl: string | null;
  /** Where the browser lane saves a screenshot of a page that failed, if anywhere. */
  outputDir: string | null;
  switch: SwitchEnv;
  /** `null` when no Mattermost is configured; scenarios that need one then skip or fail. */
  mattermost: MattermostEnv | null;
  /**
   * The environment deploys no Mattermost, by design (`SWITCH_E2E_NO_MATTERMOST=1`).
   * Scenarios that need one skip even in strict mode, and say why.
   */
  noMattermost: boolean;
  provider: ProviderEnv;
  agentic: AgenticEnv;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Parse `KEY=VALUE` lines. Blank lines and `#` comments are skipped; a value may
 * be wrapped in single or double quotes. Deliberately tiny — this is the only
 * reason the package would otherwise need a dotenv dependency.
 */
export function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Values from `.env` beside this package, or `{}` when there is no such file. */
export function readDotEnvFile(file = path.join(PACKAGE_ROOT, '.env')): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  return parseDotEnv(raw);
}

export class MissingConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Missing required configuration: ${missing.join(', ')}. ` +
        `Set them in the environment or in console/tooling-e2e/.env (see README.md).`
    );
    this.name = 'MissingConfigError';
    this.missing = missing;
  }
}

type Source = Record<string, string | undefined>;

function reader(source: Source, file: Record<string, string>): (key: string) => string | undefined {
  return (key) => {
    const value = source[key] ?? file[key];
    return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
  };
}

/**
 * The lane this process was asked to run, or `null` when none was — in which
 * case every end-to-end suite skips, which is what keeps `pnpm -r test` on a
 * developer machine from reaching for a server.
 */
export function laneFrom(
  source: Source = process.env,
  file: Record<string, string> = readDotEnvFile()
): Lane | null {
  const raw = reader(source, file)('SWITCH_E2E_LANE');
  if (raw === undefined) return null;
  if (isLane(raw)) return raw;
  throw new Error(`SWITCH_E2E_LANE must be one of ${LANES.join(', ')} — got '${raw}'.`);
}

/**
 * Whether a run that cannot go ahead fails rather than skips. Read from the
 * same sources as everything else, so `.env` and the environment never
 * disagree about it.
 */
export function strictFrom(
  source: Source = process.env,
  file: Record<string, string> = readDotEnvFile()
): boolean {
  return reader(source, file)('SWITCH_E2E_STRICT') === '1';
}

/**
 * Resolve the harness configuration from `process.env` layered over `.env`.
 * Throws {@link MissingConfigError} naming every absent variable at once rather
 * than failing on the first — a first run is usually missing several.
 *
 * Mattermost is all-or-nothing: none of its three variables means "no
 * Mattermost here", some of them is a mistake and is reported as one.
 */
export function loadEnv(
  lane: Lane,
  source: Source = process.env,
  file: Record<string, string> = readDotEnvFile()
): HarnessEnv {
  const get = reader(source, file);

  const required = {
    SWITCH_API_URL: get('SWITCH_API_URL'),
    SWITCH_GATEWAY_ADMIN_EMAIL: get('SWITCH_GATEWAY_ADMIN_EMAIL'),
    SWITCH_GATEWAY_ADMIN_PASSWORD: get('SWITCH_GATEWAY_ADMIN_PASSWORD'),
    SWITCH_AGENT_REGISTRATION_TOKEN: get('SWITCH_AGENT_REGISTRATION_TOKEN'),
    SWITCH_E2E_ENVIRONMENT: get('SWITCH_E2E_ENVIRONMENT'),
  };
  const mattermost = {
    MATTERMOST_URL: get('MATTERMOST_URL'),
    MATTERMOST_TOKEN: get('MATTERMOST_TOKEN'),
    MATTERMOST_TEAM: get('MATTERMOST_TEAM'),
  };
  const mattermostGiven = Object.values(mattermost).some((value) => value !== undefined);

  const missing = [
    ...Object.entries(required),
    ...(mattermostGiven ? Object.entries(mattermost) : []),
  ]
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) throw new MissingConfigError(missing);
  const noMattermost = get('SWITCH_E2E_NO_MATTERMOST') === '1';
  if (noMattermost && mattermostGiven) {
    throw new Error(
      'SWITCH_E2E_NO_MATTERMOST=1 says this environment has no Mattermost, but MATTERMOST_* is set too. Unset one.'
    );
  }
  const agentType = agentTypeFrom(get('SWITCH_E2E_AGENT_TYPE'));

  return {
    lane,
    environment: environmentFrom(required.SWITCH_E2E_ENVIRONMENT as string),
    strict: strictFrom(source, file),
    keepArtifacts: get('SWITCH_E2E_KEEP') === '1',
    secretsFile: get('SWITCH_E2E_SECRETS_FILE') ?? null,
    serverLog: get('SWITCH_E2E_SERVER_LOG') ?? null,
    gatewayUiUrl: optionalUrl(get('SWITCH_GATEWAY_UI_URL')),
    outputDir: get('SWITCH_E2E_OUTPUT_DIR') ?? null,
    switch: {
      apiUrl: stripTrailingSlash(required.SWITCH_API_URL as string),
      gatewayAdminEmail: required.SWITCH_GATEWAY_ADMIN_EMAIL as string,
      gatewayAdminPassword: required.SWITCH_GATEWAY_ADMIN_PASSWORD as string,
      agentRegistrationToken: required.SWITCH_AGENT_REGISTRATION_TOKEN as string,
    },
    mattermost: mattermostGiven
      ? {
          url: stripTrailingSlash(mattermost.MATTERMOST_URL as string),
          token: mattermost.MATTERMOST_TOKEN as string,
          team: mattermost.MATTERMOST_TEAM as string,
        }
      : null,
    noMattermost,
    provider: {
      agentRepoDir: get('SWITCH_E2E_AGENT_DIR') ?? null,
      manifestPath: get('SWITCH_E2E_MANIFEST') ?? null,
      agentType,
      questionMode: questionModeFrom(get('SWITCH_E2E_QUESTION_MODE'), agentType),
      controllerId: get('SWITCH_E2E_CONTROLLER_ID') ?? null,
    },
    agentic: {
      driverModel: get('SWITCH_E2E_DRIVER_MODEL') ?? null,
      judgeModel: get('SWITCH_E2E_JUDGE_MODEL') ?? null,
      budgetUsd: budgetFrom(get('SWITCH_E2E_AGENTIC_BUDGET_USD')),
      providerEnvFile: get('SWITCH_E2E_PROVIDER_ENV_FILE') ?? null,
    },
  };
}

const ENVIRONMENTS: readonly Environment[] = ['ephemeral', 'local', 'dev', 'staging', 'prod'];

function environmentFrom(raw: string): Environment {
  const found = ENVIRONMENTS.find((environment) => environment === raw);
  if (!found) {
    throw new Error(
      `SWITCH_E2E_ENVIRONMENT must be one of ${ENVIRONMENTS.join(', ')} — got '${raw}'.`
    );
  }
  return found;
}

const AGENT_TYPES: readonly HarnessAgentType[] = [
  'opencode',
  'claude-code',
  'codex',
  'antigravity',
  'cursor',
  'mistral-vibe',
];

function agentTypeFrom(raw: string | undefined): HarnessAgentType {
  if (raw === undefined) return 'opencode';
  const found = AGENT_TYPES.find((type) => type === raw);
  if (!found) {
    throw new Error(
      `SWITCH_E2E_AGENT_TYPE must be one of ${AGENT_TYPES.join(', ')} — got '${raw}'.`
    );
  }
  return found;
}

function questionModeFrom(raw: string | undefined, agentType: HarnessAgentType): QuestionMode {
  if (raw === undefined) return agentType === 'mistral-vibe' ? 'prose' : 'numbered';
  if (raw === 'numbered') return 'numbered';
  if (raw === 'prose') return 'prose';
  throw new Error(`SWITCH_E2E_QUESTION_MODE must be 'numbered' or 'prose' — got '${raw}'.`);
}

function budgetFrom(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const budget = Number(raw);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(
      `SWITCH_E2E_AGENTIC_BUDGET_USD must be a positive number of dollars — got '${raw}'.`
    );
  }
  return budget;
}

function optionalUrl(raw: string | undefined): string | null {
  return raw === undefined ? null : stripTrailingSlash(raw);
}

export function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * A message that names the running config without disclosing any of it. Used in
 * skip reasons and the result table, which are printed to a terminal and may be
 * pasted into a ticket.
 */
export function describeEnv(env: HarnessEnv): string {
  const mattermost = env.mattermost
    ? `mattermost=${env.mattermost.url} team=${env.mattermost.team}`
    : 'mattermost=none';
  const ui = env.lane === 'browser' ? ` gateway-ui=${env.gatewayUiUrl ?? 'none'}` : '';
  return `lane=${env.lane} environment=${env.environment} switch=${env.switch.apiUrl} ${mattermost}${ui}`;
}
