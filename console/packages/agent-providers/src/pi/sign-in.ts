import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SHARED_GROUP_ENV } from '../host/host-permissions';
import {
  commandOutput,
  loginWontHelp,
  readiness,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';
import { execWithin, OUT_OF_TIME } from './exec-within';
import { piArgs } from './pi-args';
import { PiLaunchError, preparePiLaunch } from './pi-launch';
import { piAgentDir } from './pi-paths';
import { parseAsPi, PiProfileError } from './pi-profile';
import { PiVersionError } from './pi-version';

/**
 * What a person runs on the execution machine to sign Pi in: Pi's own
 * terminal UI, in Switch's profile (`piAgentDir`) and offline, where they then
 * type /login. Switch Console runs it through a login shell, which expands
 * `$HOME`.
 */
export const PI_LOGIN = 'PI_CODING_AGENT_DIR="$HOME/.local/state/switch/pi/agent" pi --offline';

/** Said whenever a sign-in would help: how, in full. */
export const PI_SIGN_IN = `Sign in on the execution machine: run ${PI_LOGIN}, then type /login, or set a provider API key.`;

/**
 * The variables Pi 1.4.0 takes a provider's credentials from, by Pi's
 * provider id (`pi-ai/dist/env-api-keys.js`, `docs/providers.md`). A variable
 * set and non-empty in a check's environment makes its provider one to check.
 */
export const PI_PROVIDER_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
  'ant-ling': ['ANT_LING_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  'amazon-bedrock': [
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_ACCESS_KEY_ID',
    'AWS_PROFILE',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
  ],
  deepseek: ['DEEPSEEK_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  radius: ['RADIUS_API_KEY'],
  typesafe: ['TYPESAFE_API_KEY'],
  huggingface: ['HF_TOKEN'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  baseten: ['BASETEN_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  meta: ['META_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
};

/**
 * Read beside a provider's own variable: its secret half, endpoint, region,
 * project, account or deployment names (`docs/providers.md`).
 */
const PI_COMPANION_ENV = [
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_WORKSPACE_ID',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  'AZURE_OPENAI_API_VERSION',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  // What the AWS SDK Pi signs Bedrock in with reads beside its own variable:
  // the role a web identity token assumes (credential-provider-web-identity
  // fromTokenFile), the container endpoint's authorization (credential-provider-http
  // fromHttp), and where the profile files are (shared-ini-file-loader).
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  // And what keeps it from a source the machine's operator shut: the instance
  // metadata service altogether (credential-provider-node remoteProvider), or
  // its unauthenticated first version (credential-provider-imds fromInstanceMetadata).
  'AWS_EC2_METADATA_DISABLED',
  'AWS_EC2_METADATA_V1_DISABLED',
  // The rest of what those SDKs read of credentials, endpoints and regions,
  // each searched for and decided on in `PI_SDK_ENV` (`sdk-env.ts`): the
  // instance metadata service's endpoint, the environment credentials' account,
  // expiry and scope, `aws login`'s cache, the auth scheme, endpoints (FIPS,
  // dual-stack, configured, per service), the SigV4a region set, and Pi's
  // signing nothing for an endpoint that holds the credentials itself.
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
  'AWS_ACCOUNT_ID',
  'AWS_CREDENTIAL_EXPIRATION',
  'AWS_CREDENTIAL_SCOPE',
  'AWS_LOGIN_CACHE_DIRECTORY',
  'AWS_AUTH_SCHEME_PREFERENCE',
  'AWS_USE_FIPS_ENDPOINT',
  'AWS_USE_DUALSTACK_ENDPOINT',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
  'AWS_ENDPOINT_URL_STS',
  'AWS_ENDPOINT_URL_SSO',
  'AWS_ENDPOINT_URL_SSO_OIDC',
  'AWS_ENDPOINT_URL_SIGNIN',
  'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
  'AWS_SIGV4A_SIGNING_REGION_SET',
  'AWS_BEDROCK_SKIP_AUTH',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  // What Google's auth library reads of Vertex's application default
  // credentials beside their file: the quota project, a certificate's
  // configuration, consent to an executable source, the metadata server.
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_API_CERTIFICATE_CONFIG',
  'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES',
  'GCE_METADATA_HOST',
  'GCE_METADATA_IP',
  'METADATA_SERVER_DETECTION',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_GATEWAY_ID',
  // Where Pi renews a Kimi login.
  'KIMI_CODE_OAUTH_HOST',
  'KIMI_OAUTH_HOST',
];

/**
 * What else, set together and non-empty, makes a provider one to check: a
 * sign-in Pi takes without any of its keys (`PI_PROVIDER_ENV`). Whether it
 * works is still Pi's to say. Anthropic's workload identity federation needs
 * all three of these (pi-ai `providers/anthropic.js`); Vertex's application
 * default credentials, a project and a location, the credentials file being
 * gcloud's own when none is named (pi-ai `providers/google-vertex.js`).
 */
export const PI_PROVIDER_SIGNALS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  anthropic: [
    ['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_IDENTITY_TOKEN_FILE'],
  ],
  'google-vertex': [
    ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
    ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
  ],
};

/** What a session host passes Pi from the machine's environment: the registry's `inheritEnv`. */
export const PI_INHERIT_ENV: readonly string[] = [
  ...new Set([...Object.values(PI_PROVIDER_ENV).flat(), ...PI_COMPANION_ENV]),
];

/**
 * The provider keys that reach Pi on an agent controller that runs each
 * agent as a user of its own (systemd): its own `AGENT_ENV_VARS`, without the
 * ones naming a path in the controller user's home. Every other Pi provider
 * there has no way in: `/login` signs in a profile no agent reads.
 */
export const PI_SYSTEMD_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
];

/** Said on such a controller, where only a key in its environment can help. */
export const PI_ENV_ONLY = `Only keys in the controller's environment reach Pi here, not /login: ${PI_SYSTEMD_ENV.join(', ')}.`;

/**
 * Said when Switch's check of its Pi profile refuses to start Pi there
 * (the check itself is the launch's): no sign-in changes the profile back.
 */
export function piProfileRefused(reason: string): ProviderReadiness {
  return loginWontHelp(
    readiness('unconfigured', `Switch will not start Pi with its profile: ${reason}`)
  );
}

/** Each `pi auth check` asked for one provider: offline, never refreshing a login, never printing one. */
export function piAuthCheckArgs(provider: string): string[] {
  return piArgs({ kind: 'readiness', provider });
}

const CHECK_TIMEOUT_MS = 15_000;

/**
 * How long all of a check's `pi auth check`s may take together, so a crowded
 * environment cannot stall it: within the 90 s the agent controller gives the
 * whole probe (`agent-controller/src/runtime.ts` PROBE_TIMEOUT_MS), after the
 * version's at most 15 s. A provider not asked in it leaves the check unknown,
 * never unconfigured.
 */
export const PI_CHECK_BUDGET_MS = 60_000;

const authCheckSchema = z.object({
  status: z.enum(['ready', 'not_ready', 'invalid']),
  provider: z.string(),
  reason: z.string().optional(),
});

type ProviderAnswer = 'ready' | 'missing' | 'unknown';

/** Whether this check runs where agents are users of their own and take keys only from the environment (Q5). */
function envOnly(env: Record<string, string>): boolean {
  return env[SHARED_GROUP_ENV] === '1';
}

/** The providers the environment names: by one of their keys, or by a sign-in that needs none. */
function fromEnvironment(env: Record<string, string>): string[] {
  const set = (name: string) => Boolean(env[name]);
  return Object.entries(PI_PROVIDER_ENV)
    .filter(
      ([provider, names]) =>
        names.some(set) || (PI_PROVIDER_SIGNALS[provider] ?? []).some((all) => all.every(set))
    )
    .map(([provider]) => provider);
}

/** The providers Switch's profile holds a login for, by name only: what each holds is not read. */
async function fromProfile(agentDir: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(agentDir, 'auth.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // Read as Pi reads it, as the profile's check did (`pi-profile.ts` `parseAsPi`).
  const parsed = parseAsPi(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
}

/**
 * What `pi auth check` said of `provider`, taken from its exit and its JSON
 * together (P-05): ready only on exit 0 with `ready`; missing only on exit 1
 * with `not_ready` for want of credentials or of the provider. A usage error
 * (exit 2), a timeout, a signal, or an exit the JSON contradicts is unknown.
 *
 * Its time (15 s, cut short when the check's `budget` is spent; nothing is run
 * once it is) is a hard limit: when it runs out the check is killed (SIGKILL,
 * which no process ignores; it only reads, so there is nothing to finish) and
 * the answer is unknown at once, never waiting for the process to end. Node
 * signals only a process that has not exited.
 */
async function askPi(
  binaryPath: string,
  env: Record<string, string>,
  cwd: string,
  provider: string,
  budget: AbortSignal
): Promise<ProviderAnswer> {
  let output: string;
  let exit: unknown = 0;
  try {
    const done = await execWithin(binaryPath, piAuthCheckArgs(provider), {
      cwd,
      env,
      timeout: CHECK_TIMEOUT_MS,
      budget,
      maxBuffer: 64 * 1024,
    });
    if (done === OUT_OF_TIME) return 'unknown';
    output = done.stdout;
  } catch (error) {
    const failed = error as { code?: unknown; signal?: unknown; killed?: unknown };
    // Stopped, by its time running out or otherwise: what it printed is not an answer.
    if (failed.signal || failed.killed) return 'unknown';
    // Pi exits 1 for a provider it cannot use, still with its JSON on stdout.
    exit = failed.code;
    output = commandOutput(error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim().split('\n').at(-1) ?? '');
  } catch {
    return 'unknown';
  }
  const answer = authCheckSchema.safeParse(parsed);
  if (!answer.success || answer.data.provider !== provider) return 'unknown';
  if (exit === 0) return answer.data.status === 'ready' ? 'ready' : 'unknown';
  if (
    exit === 1 &&
    answer.data.status === 'not_ready' &&
    (answer.data.reason === 'credentials_not_configured' ||
      answer.data.reason === 'provider_not_found')
  )
    return 'missing';
  return 'unknown';
}

/** At most `count` of `names`, saying how many more there are. */
function someOf(names: string[], count = 4): string {
  return names.length > count
    ? `${names.slice(0, count).join(', ')} and ${names.length - count} more`
    : names.join(', ');
}

/**
 * Whether Pi can answer an agent: asked of `pi auth check` in Switch's profile,
 * for the agent's model's provider when that is known, else for each provider
 * a key in the environment or a login in the profile names. Signed in when any
 * of them is; unknown when one was not asked within `budgetMs` (default
 * `PI_CHECK_BUDGET_MS`) and none is. Nothing is written and no model is called.
 */
export async function checkPiSignIn(
  input: SignInCheckInput,
  options: { modelProvider?: string; budgetMs?: number } = {}
): Promise<ProviderReadiness> {
  // The same check of the executable, the profile, the version and the
  // environment as every Pi Switch starts (ER-03, ER-09; `pi-launch.ts`).
  let launch: Awaited<ReturnType<typeof preparePiLaunch>>;
  try {
    launch = await preparePiLaunch({
      kind: 'readiness',
      binaryPath: input.binaryPath,
      env: input.env,
      cwd: input.cwd,
    });
  } catch (error) {
    if (error instanceof PiProfileError) return piProfileRefused(error.message);
    if (error instanceof PiVersionError || error instanceof PiLaunchError)
      return loginWontHelp(readiness('unconfigured', error.message));
    throw error;
  }
  const agentDir = piAgentDir(input.env);
  const onlyEnv = envOnly(input.env);
  let providers: string[];
  if (options.modelProvider) providers = [options.modelProvider];
  else {
    let inProfile: string[];
    try {
      inProfile = onlyEnv ? [] : await fromProfile(agentDir);
    } catch {
      return readiness('unknown', "Could not read the logins in Switch's Pi profile.");
    }
    providers = [...new Set([...fromEnvironment(input.env), ...inProfile])];
  }
  if (!providers.length)
    return onlyEnv
      ? loginWontHelp(readiness('unconfigured', PI_ENV_ONLY))
      : readiness('unconfigured', `Pi has no provider key or login. ${PI_SIGN_IN}`);
  const env = launch.env;
  const budgetMs = options.budgetMs ?? PI_CHECK_BUDGET_MS;
  // One timer for the whole budget both ends the check it cuts short and tells
  // the loop it is spent. A clock read beside it could yet show a millisecond
  // left after it fired, and ask the next provider in no time at all.
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), budgetMs);
  if (budgetMs <= 0) budget.abort();
  const answers = new Map<string, ProviderAnswer>();
  try {
    for (const provider of providers) {
      if (budget.signal.aborted) break;
      answers.set(provider, await askPi(launch.command, env, input.cwd, provider, budget.signal));
    }
  } finally {
    clearTimeout(budgetTimer);
  }
  const named = (answer: ProviderAnswer) =>
    providers.filter((provider) => answers.get(provider) === answer);
  if (named('ready').length)
    return readiness('authenticated', `Signed in to ${someOf(named('ready'))}.`);
  const unasked = providers.filter((provider) => !answers.has(provider));
  if (named('unknown').length || unasked.length) {
    const unsure = [
      ...(named('unknown').length
        ? [`Pi did not say whether it can use ${someOf(named('unknown'))}.`]
        : []),
      ...(unasked.length
        ? [`Pi was not asked about ${someOf(unasked)} in the ${budgetMs / 1000} s a check has.`]
        : []),
    ].join(' ');
    // Where only a key in the environment helps, /login does not, whatever Pi said.
    return onlyEnv ? loginWontHelp(readiness('unknown', unsure)) : readiness('unknown', unsure);
  }
  const missing = `Pi has no usable login or key for ${someOf(named('missing'))}.`;
  return onlyEnv
    ? loginWontHelp(readiness('unconfigured', `${missing} ${PI_ENV_ONLY}`))
    : readiness('unconfigured', `${missing} ${PI_SIGN_IN}`);
}
