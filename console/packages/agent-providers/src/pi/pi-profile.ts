/**
 * Switch's Pi profile (`piAgentDir`, the "A+" contract of `ready_errata.md`
 * ER-03): checked before every Pi Switch starts — a session, a discovery of
 * models, the sign-in check — and set up before a session or a discovery.
 *
 * A profile Switch refuses (`PiProfileError`) holds something Pi would load,
 * run or migrate into what it loads (Pi at `PI_VERSION`, `dist/`):
 * - `mcp.json`: its servers start in every session (`extensions/mcp/config.js:108`;
 *   P-09: also with Switch's own flags);
 * - `models.json`: not supported in this version (P-07 = C,
 *   `09_human_decisions_probes.md:26`);
 * - `extensions/`, `skills/`, `prompts/`, `themes/` (`core/resource-loader.js:757-760`);
 *   `commands/`, which Pi renames to `prompts/` (`migrations.js:118-131`, `:229`);
 * - `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` (`core/resource-loader.js:115-116`,
 *   `:171`), `SYSTEM.md`, `APPEND_SYSTEM.md` (`:949`, `:960`);
 * - `bin/`, which Pi puts on every shell's PATH (`utils/shell.js:148`; P-11), and
 *   `tools/`, whose `fd`/`rg` Pi moves there (`migrations.js:159-190`);
 * - `oauth.json`, which Pi turns into `auth.json` when there is none, the
 *   person's fields over its own (`migrations.js:27-31`);
 * - in `auth.json`, a `key` that, read as Pi reads it (`core/auth-storage.js:175`:
 *   BOM stripped, `JSON.parse`), starts with `!`: Pi runs it as a command
 *   (`core/resolve-config-value.js:64-67`, `:123-128`). A value that only
 *   becomes `!…` once a `$VAR` in it is filled in is not a command and is
 *   allowed (E12-02: Pi decides before it interpolates);
 * - in `auth.json`, a sign-in of any shape but one Pi's own sign-in and its
 *   renewal write (`PI_AUTH_METHODS`, D-14 B′): a field Pi does not write
 *   there, or one that sends requests elsewhere — the environment of a
 *   credential (`env`, which Pi lays over its own: pi-ai `utils/provider-env.js:39`),
 *   GitHub Copilot Enterprise (`enterpriseUrl`) or a Copilot server outside
 *   GitHub Copilot's domain (`proxy-ep=` in `access`), Radius's old gateway
 *   catalog (`gatewayConfig`) — refuses the whole profile, saying how to remove
 *   that sign-in alone;
 * - a file Pi reads or writes by its name in the profile (`PI_PROFILE_OWN_FILES`)
 *   that is not a plain file of its own (a link, or a file with more than one
 *   name): Pi writes through a link to wherever it points (`keybindings.json`,
 *   which Pi rewrites on every start, `migrations.js:139-151`, `:278`), and its
 *   lock does not follow links (`realpath: false`, `core/auth-storage.js:50`,
 *   `core/settings-manager.js:132`), so two names of one file are two locks
 *   (EQ-05: one canonical `auth.json`);
 * - a `*.jsonl` file in the profile itself, which Pi moves into `sessions/`
 *   on start (`migrations.js:76-118`, `:276`);
 * - in `models-store.json`, any model catalog (`checkPiModelsStore`): Pi lays
 *   a stored catalog over its own models on every start, offline too, and a
 *   stored model of a known id replaces Pi's own, its `baseUrl` with it
 *   (`core/model-runtime.js:83-97`, `core/models-store.js:87-90`,
 *   `core/remote-catalog-provider.js:19-23`, `:75-85`) — custom models, which
 *   Switch does not support (P-07 = C), by another name. Pi writes a catalog
 *   there only after fetching one (`remote-catalog-provider.js:85`, `:131`;
 *   pi-ai `models.js:149-153`), which Switch's `--offline` never lets it do;
 *   the empty store it writes itself (`{}`, `core/auth-storage.js:40-43`) passes;
 * - in `mcp-auth.json`, any MCP server's sign-in (`checkPiMcpAuth`): Pi sends
 *   its stored token to a session's HTTP MCP server that has no `Authorization`
 *   header, and refreshes it at the authorization server stored beside it
 *   (`extensions/mcp/runtime.js:36-41`, `:120-127`; `extensions/mcp/oauth.js:225-275`;
 *   pi-mcp `oauth/flow.js:168-190`). Switch's sessions sign in to no MCP server
 *   through Pi — their servers get what they need from Switch — so Pi writes a
 *   sign-in there only in a sign-in Switch never runs (`oauth.js:91-105`); the
 *   empty store it writes itself passes;
 * - in `settings.json`, any key `PI_SETTINGS_ALLOWED` does not name, or a value
 *   it does not allow: `packages`, `extensions`, `skills`, `prompts`,
 *   `shellCommandPrefix`, `shellPath` and every other key are refused, not
 *   rewritten, so nothing a person or another Pi wrote there is lost unseen
 *   (E10-09: no rewriting of the whole file). The shell the bridge runs comes
 *   from the bridge's config instead (Q7 D, `pi-launch.ts` `piTrustedShellPath`).
 *
 * Everything else Pi writes there itself is left alone, each file of
 * `PI_PROFILE_OWN_FILES` once it is a plain file of its own: `auth.json`,
 * an empty `models-store.json`, `settings.json`, `trust.json` (ignored: Switch starts Pi
 * with `--no-approve`), `sessions/` (unused: Switch gives Pi `--session-dir`),
 * an empty `mcp-auth.json`, logs and crash records.
 *
 * Setting up (`preparePiProfile`) creates the directory (0700) and writes the
 * keys Switch manages in `settings.json` (`PI_SETTINGS_MANAGED`) when one is
 * missing or different — only then, atomically (a new file renamed over it),
 * and under the same lock Pi takes on that file (`withPiSettingsLock`), which
 * also keeps two Switch processes setting up one empty profile from racing (SC27).
 */
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Why Switch will not start Pi with its profile; `entry` is what in it (`''`: the directory). */
export class PiProfileError extends Error {
  constructor(
    readonly agentDir: string,
    readonly entry: string,
    message: string
  ) {
    super(message);
    this.name = 'PiProfileError';
  }
}

/** What in the profile Pi would load or run, by name in any case, and why Switch refuses it. */
export const PI_PROFILE_FORBIDDEN: Readonly<Record<string, string>> = {
  'mcp.json': 'its MCP servers would start in every Switch session',
  'models.json': 'Switch does not support custom Pi models (models.json) yet',
  extensions: 'Pi would load these extensions into every Switch session',
  skills: 'Pi would load these skills into every Switch session',
  prompts: 'Pi would load these prompt templates into every Switch session',
  commands: 'Pi would rename it to prompts/ and load it into every Switch session',
  themes: 'Pi would load these themes into every Switch session',
  'agents.md': 'Pi would add it to every Switch session’s context',
  'agents.override.md': 'Pi would add it to every Switch session’s context',
  'claude.md': 'Pi would add it to every Switch session’s context',
  'system.md': 'Pi would replace every Switch session’s system prompt with it',
  'append_system.md': 'Pi would add it to every Switch session’s system prompt',
  bin: 'Pi would put it on the PATH of every command an agent runs',
  tools: 'Pi would move its fd and rg to bin/, on the PATH of every command an agent runs',
  'oauth.json': 'Pi would turn it into an auth.json Switch has not checked',
};

/**
 * The files Pi reads or writes by their name in the profile (Pi at
 * `PI_VERSION`, `dist/`), each of which, when present, must be a plain file of
 * its own (not a link, one name only), or Switch refuses the profile.
 */
export const PI_PROFILE_OWN_FILES: readonly string[] = [
  // Read and written under a lock on its own name (`core/auth-storage.js:31`, `:50`, `:175`).
  'auth.json',
  // Read and written under a lock on its own name (`core/settings-manager.js:122-170`).
  'settings.json',
  // Rewritten on every start that runs migrations (`migrations.js:139-151`, `:278`).
  'keybindings.json',
  // Model catalogs, read and written under a lock (`core/models-store.js:30-32`); what it
  // holds is checked too (`checkPiModelsStore`).
  'models-store.json',
  // Projects' trust, read and written (`core/trust-manager.js:104`, `:174`).
  'trust.json',
  // MCP servers' logins, read and written under a lock (`extensions/mcp/oauth.js:88-89`); what
  // it holds is checked too (`checkPiMcpAuth`).
  'mcp-auth.json',
  // Appended to by the MCP extension, which every session loads (`extensions/mcp/log.js:47-50`,
  // `extensions/mcp/index.js:269`); its rotation renames it, which follows no link.
  'mcp.log',
  // Crash records, rewritten (`core/crash-log.js:8`, `:24-26`).
  'crashes.json',
  // The debug log (`config.js:531-532`).
  'pi-debug.log',
];

/** The keys Switch writes into the profile's `settings.json`, with their values. */
export const PI_SETTINGS_MANAGED: Readonly<Record<string, unknown>> = {
  // Belt and braces with `--no-approve`, also for `PI_LOGIN`'s terminal UI.
  defaultProjectTrust: 'never',
  enableInstallTelemetry: false,
  enableAnalytics: false,
};

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const MODES = ['all', 'one-at-a-time'];
// pi-ai `providers/model-schema.ts` MODEL_THINKING_LEVELS.
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function onlyEnabled(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, flag]) => key === 'enabled' && typeof flag === 'boolean')
  );
}

/**
 * The keys a `settings.json` in Switch's profile may hold besides
 * `PI_SETTINGS_MANAGED`, each with the values it may have: what Pi writes
 * there itself — on its first start (`lastChangelogVersion`, P-11), when a
 * model is chosen as the default (`core/agent-session.js:2017`, `:2122`), and
 * for RPC commands (`modes/rpc/rpc-mode.js:407-429`).
 */
export const PI_SETTINGS_ALLOWED: Readonly<Record<string, (value: unknown) => boolean>> = {
  lastChangelogVersion: (value) => typeof value === 'string' && VERSION.test(value),
  defaultProvider: (value) => typeof value === 'string' && value.length <= 64 && NAME.test(value),
  defaultModel: (value) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !Array.from({ length: value.length }, (_, at) => value.charCodeAt(at)).some(
      (code) => code < 0x20 || code === 0x7f
    ),
  defaultThinkingLevel: (value) => typeof value === 'string' && THINKING.includes(value),
  steeringMode: (value) => typeof value === 'string' && MODES.includes(value),
  followUpMode: (value) => typeof value === 'string' && MODES.includes(value),
  compaction: onlyEnabled,
  retry: onlyEnabled,
};

/**
 * How Pi reads its `auth.json` and `settings.json`: a leading BOM dropped, then
 * `JSON.parse` (`utils/text.js:2-8` stripBom; `core/auth-storage.js:175`,
 * `core/settings-manager.js:269`). The one parser Switch reads them with (the
 * sign-in check's too, `sign-in.ts`).
 */
export function parseAsPi(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HOW = 'Move it out of Switch’s Pi profile, then start the agent again.';

async function lstatOrNull(file: string): Promise<Stats | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Throws unless `name` in the profile is absent or a plain file of its own; whether it is there. */
async function assertOwnFile(agentDir: string, name: string): Promise<boolean> {
  const file = join(agentDir, name);
  const found = await lstatOrNull(file);
  if (!found) return false;
  if (!found.isFile() || found.nlink > 1)
    throw new PiProfileError(
      agentDir,
      name,
      `${file} is ${found.isSymbolicLink() ? 'a link' : found.isFile() ? 'a file with more than one name' : 'not a file'}: Pi reads, writes and locks it by this name, so Switch uses only a plain file of its own there. ${HOW}`
    );
  return true;
}

/** A JSON file of the profile, read when it is a plain file of its own; `null` when absent. */
async function ownFile(agentDir: string, name: string): Promise<string | null> {
  return (await assertOwnFile(agentDir, name)) ? readFile(join(agentDir, name), 'utf8') : null;
}

function readJson(agentDir: string, name: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseAsPi(text);
  } catch {
    throw new PiProfileError(
      agentDir,
      name,
      `${join(agentDir, name)} is not JSON Pi can read. ${HOW}`
    );
  }
  if (!isRecord(parsed))
    throw new PiProfileError(
      agentDir,
      name,
      `${join(agentDir, name)} is not a JSON object. ${HOW}`
    );
  return parsed;
}

type PiAuthField = (value: unknown) => boolean;
const aString: PiAuthField = (value) => typeof value === 'string';
const strings: PiAuthField = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const aTime: PiAuthField = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * How one of Pi's built-in providers signs in (Pi at `PI_VERSION`, pi-ai `dist/`):
 * - `apiKey`: a key, as its sign-in writes it — `{ type: "api_key", key }`
 *   (`auth/helpers.js:10-15`; `providers/anthropic.js:10-15`;
 *   `providers/amazon-bedrock.js:23-28`; `providers/google-vertex.js:24-29`), or for
 *   `'optional'` (Amazon Bedrock's AWS credential chain) none at all
 *   (`providers/amazon-bedrock.js:51`). What a sign-in writes beside it in
 *   `env` (Bedrock's AWS profile `:39-44`, Vertex's project `:50-57`,
 *   Cloudflare's ids `providers/cloudflare-auth.js:41`, `:62-66`) Switch does
 *   not take: Pi sends it with every request, over the process's own
 *   (`auth/resolve.js:30`, `models.js:445`, `utils/provider-env.js:39`), and
 *   it names addresses (`AZURE_OPENAI_BASE_URL`), profiles and files.
 * - `oauth`: the fields its sign-in and its renewal write beside `access`,
 *   `refresh` and `expires` (`auth/types.d.ts:21-30`, checked as
 *   `core/auth-storage.js:202-206` checks them); a renewal replaces the whole
 *   sign-in with what it returns (`auth/resolve.js:78`, `core/auth-storage.js:396`).
 * - `envKeys`: what gives Pi the same sign-in through the environment, when
 *   Switch refuses the one in `auth.json` for its `env` (`sign-in.ts`
 *   `PI_PROVIDER_ENV`, `PI_COMPANION_ENV`).
 */
export interface PiAuthMethods {
  apiKey?: 'required' | 'optional';
  oauth?: Readonly<Record<string, PiAuthField>>;
  envKeys?: readonly string[];
}

const KEY = { apiKey: 'required' } as const;

/**
 * Every built-in provider of Pi at `PI_VERSION` (pi-ai `providers/all.js`) and
 * how it signs in; a sign-in in `auth.json` for any other is refused.
 */
export const PI_AUTH_METHODS: Readonly<Record<string, PiAuthMethods>> = {
  // `providers/amazon-bedrock.js:9-52`: a bearer token, an AWS profile (`env`), or the chain.
  'amazon-bedrock': { apiKey: 'optional', envKeys: ['AWS_PROFILE'] },
  'ant-ling': KEY,
  // `auth/oauth/anthropic.js:107-112` (sign-in), `:226-231` (renewal).
  anthropic: { ...KEY, oauth: {} },
  azure: KEY,
  baseten: KEY,
  cerebras: KEY,
  // `providers/cloudflare-auth.js:58-66`: a key and both ids, always in `env`.
  'cloudflare-ai-gateway': {
    ...KEY,
    envKeys: ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'],
  },
  // `providers/cloudflare-auth.js:38-41`.
  'cloudflare-workers-ai': { ...KEY, envKeys: ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'] },
  deepseek: KEY,
  fireworks: KEY,
  // `auth/oauth/github-copilot.js:263-269`, `:280-283` (renewal), `:368-371` (sign-in);
  // `enterpriseUrl` and `proxy-ep=` in `access` checked apart (`copilotProblem`).
  'github-copilot': { ...KEY, oauth: { availableModelIds: strings } },
  google: KEY,
  // `providers/google-vertex.js:12-58`: a key, or the project, location and credentials file in `env`.
  'google-vertex': {
    ...KEY,
    envKeys: ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'],
  },
  groq: KEY,
  huggingface: KEY,
  // `auth/oauth/kimi-coding.js:233`, `:240-243`.
  'kimi-coding': { ...KEY, oauth: {} },
  // `auth/oauth/meta.js:157`, `:185`.
  meta: { ...KEY, oauth: {} },
  minimax: KEY,
  'minimax-cn': KEY,
  mistral: KEY,
  moonshotai: KEY,
  'moonshotai-cn': KEY,
  nvidia: KEY,
  // ChatGPT: `auth/oauth/openai-chatgpt.js:147-154`, its renewal the same (`:172-184`).
  openai: { ...KEY, oauth: { clientId: aString, scopes: strings } },
  // OAuth only (`providers/openai-codex.js:11-17`): `auth/oauth/openai-codex.js:247-258`, `:318-320`.
  'openai-codex': { oauth: { accountId: aString } },
  opencode: KEY,
  'opencode-go': KEY,
  // `auth/oauth/openrouter.js:96-101`; its renewal returns it as it is (`:151-153`).
  openrouter: { ...KEY, oauth: {} },
  'qwen-token-plan': KEY,
  'qwen-token-plan-cn': KEY,
  'qwen-token-plan-individual': KEY,
  // `auth/oauth/radius.js:89-95`, its renewal the same (`:239-246`). `gatewayConfig`, which
  // only an older Pi wrote, is refused (`checkPiAuth`).
  radius: { ...KEY, oauth: { scope: aString } },
  together: KEY,
  typesafe: KEY,
  'vercel-ai-gateway': KEY,
  // `auth/oauth/xai.js:107-112`.
  xai: { ...KEY, oauth: {} },
  xiaomi: KEY,
  'xiaomi-token-plan-ams': KEY,
  'xiaomi-token-plan-cn': KEY,
  'xiaomi-token-plan-sgp': KEY,
  zai: KEY,
  'zai-coding-cn': KEY,
};

/** What every OAuth sign-in holds (`core/auth-storage.js:202-206`). */
const OAUTH_BASE: Readonly<Record<string, PiAuthField>> = {
  access: aString,
  refresh: aString,
  expires: aTime,
};

/** Pi's reading of a Copilot server from a Copilot token (`auth/oauth/github-copilot.js:40-48`). */
const PROXY_EP = /proxy-ep=([^;]+)/;
/** GitHub Copilot's domain, the only one Pi 1.4.0 names (`auth/oauth/github-copilot.js:37-38`, `:59`). */
const COPILOT_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+githubcopilot\.com$/i;

/**
 * Why Switch refuses the server a Copilot token sends requests to, if it does:
 * Pi takes the first `proxy-ep=` in `access`, makes `proxy.` into `api.` and
 * sends every request there (`auth/oauth/github-copilot.js:40-48`, `:385-390`;
 * `models.js:440`). None is Pi's own `api.individual.githubcopilot.com` (`:59`).
 */
function copilotProblem(access: string): string | undefined {
  const named = access.match(/proxy-ep=/g)?.length ?? 0;
  if (named === 0) return undefined;
  if (named > 1) return 'its "access" token names more than one Copilot server ("proxy-ep=")';
  const host = PROXY_EP.exec(access)?.[1] ?? '';
  if (!COPILOT_HOST.test(host) || !COPILOT_HOST.test(host.replace(/^proxy\./, 'api.')))
    return 'its "access" token sends requests to a server outside GitHub Copilot’s githubcopilot.com ("proxy-ep=")';
  return undefined;
}

/** A name from `auth.json` as a message gives it: quoted, and never more than a short line. */
function quoted(name: string): string {
  return JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}…` : name);
}

/** Why Switch does not take one sign-in in `auth.json`, and what to do once it is removed; none when it takes it. */
function authProblem(
  provider: string,
  credential: unknown
): { why: string; then: string } | undefined {
  const methods = Object.hasOwn(PI_AUTH_METHODS, provider) ? PI_AUTH_METHODS[provider] : undefined;
  if (!methods)
    return {
      why: 'Pi 1.4.0 has no built-in provider of that name, and Switch loads no other',
      then: 'start the agent again',
    };
  const again = `sign in to ${provider} again with /login${methods.apiKey ? ', or give Pi its key through Switch’s environment' : ''}`;
  if (!isRecord(credential)) return { why: 'it is not a sign-in Pi writes', then: again };
  const { type } = credential;
  if (type !== 'api_key' && type !== 'oauth')
    return { why: 'its "type" is not one Pi writes ("api_key" or "oauth")', then: again };
  const fields: Record<string, PiAuthField> | undefined =
    type === 'api_key'
      ? methods.apiKey && { key: aString }
      : methods.oauth && { ...OAUTH_BASE, ...methods.oauth };
  if (!fields)
    return {
      why: `Pi does not sign in to ${provider} with ${type === 'oauth' ? 'OAuth' : 'a key'}`,
      then: again,
    };
  for (const field of Object.keys(credential)) {
    if (field === 'type' || Object.hasOwn(fields, field)) continue;
    if (field === 'env')
      return {
        why: 'it holds an environment ("env"), which Pi would send with every request in place of Switch’s',
        then: methods.envKeys
          ? `give Pi ${methods.envKeys.join(', ')} through Switch’s environment instead (on an agent controller, only the keys it passes on reach Pi)`
          : `sign in to ${provider} again without one, or give Pi what it held through Switch’s environment`,
      };
    if (field === 'enterpriseUrl' && provider === 'github-copilot')
      return {
        why: 'it signs in to GitHub Copilot Enterprise ("enterpriseUrl"), which Switch does not support yet',
        then: 'Switch has no other way to GitHub Copilot Enterprise yet',
      };
    if (field === 'gatewayConfig' && provider === 'radius')
      return {
        why: 'it holds the gateway catalog an older Pi wrote ("gatewayConfig"), with models and an address of its own',
        then: `${again}, which writes none`,
      };
    return {
      why: `it holds ${quoted(field)}, which Pi does not write in a ${provider} sign-in`,
      then: again,
    };
  }
  for (const [field, valid] of Object.entries(fields)) {
    const optional =
      field === 'key' ? methods.apiKey === 'optional' : !Object.hasOwn(OAUTH_BASE, field);
    if (!Object.hasOwn(credential, field)) {
      if (optional) continue;
      return { why: `it has no "${field}"`, then: again };
    }
    if (!valid(credential[field]))
      return { why: `its "${field}" is not what Pi writes there`, then: again };
  }
  if (provider === 'github-copilot' && type === 'oauth') {
    const why = copilotProblem(credential.access as string);
    if (why) return { why, then: again };
  }
  return undefined;
}

/**
 * Throws unless every sign-in in `auth.json` is one Switch takes: no `key` Pi
 * would run as a command, and each of a shape Pi's own sign-in or renewal of
 * that provider writes (`PI_AUTH_METHODS`), sending requests nowhere Pi would
 * not by itself (D-14 B′). One refused refuses the whole profile; the message
 * names each provider, what is wrong and how to remove that sign-in alone.
 */
export function checkPiAuth(agentDir: string, text: string): void {
  const auth = readJson(agentDir, 'auth.json', text);
  const file = join(agentDir, 'auth.json');
  const commands = Object.entries(auth)
    .filter(
      ([, credential]) =>
        isRecord(credential) && typeof credential.key === 'string' && credential.key.startsWith('!')
    )
    .map(([provider]) => provider);
  if (commands.length)
    throw new PiProfileError(
      agentDir,
      'auth.json',
      `${file} has a key that is a command (starts with "!") for ${commands.join(', ')}: Pi would run it. Switch takes a key itself, or one from a variable ("$NAME"); replace it with one of those.`
    );
  const refused = Object.entries(auth).flatMap(([provider, credential]) => {
    const problem = authProblem(provider, credential);
    if (!problem) return [];
    const shown = /^[A-Za-z0-9._-]{1,64}$/.test(provider) ? provider : quoted(provider);
    return [
      `Its sign-in for ${shown}: ${problem.why}. Remove that sign-in alone, which keeps your other sign-ins: start Pi in this profile (PI_CODING_AGENT_DIR=${JSON.stringify(agentDir)} pi --offline, as Switch’s sign-in says), type /logout and choose ${shown}, or delete ${quoted(provider)} from ${file} yourself. Then ${problem.then}.`,
    ];
  });
  if (refused.length)
    throw new PiProfileError(
      agentDir,
      'auth.json',
      `Switch will not start Pi with ${file}. ${refused.join(' ')}`
    );
}

/**
 * The managed keys `settings.json` lacks or holds otherwise; throws when it
 * holds a key Switch does not allow, or a value it does not.
 */
export function checkPiSettings(agentDir: string, text: string | null): string[] {
  const settings = text === null ? {} : readJson(agentDir, 'settings.json', text);
  const file = join(agentDir, 'settings.json');
  for (const [key, setting] of Object.entries(settings)) {
    if (Object.hasOwn(PI_SETTINGS_MANAGED, key)) continue;
    const allowed = Object.hasOwn(PI_SETTINGS_ALLOWED, key) ? PI_SETTINGS_ALLOWED[key] : undefined;
    if (!allowed)
      throw new PiProfileError(
        agentDir,
        'settings.json',
        `${file} sets "${key}", which Switch does not allow in its Pi profile. Remove "${key}" from it, then start the agent again.`
      );
    if (!allowed(setting))
      throw new PiProfileError(
        agentDir,
        'settings.json',
        `${file} sets "${key}" to ${JSON.stringify(setting)}, which Switch does not allow. Remove "${key}" from it, then start the agent again.`
      );
  }
  return Object.keys(PI_SETTINGS_MANAGED).filter(
    (key) => !Object.hasOwn(settings, key) || settings[key] !== PI_SETTINGS_MANAGED[key]
  );
}

const STORE_HOW = 'Delete it (Pi makes a new, empty one), then start the agent again.';

/** A store Pi keeps by itself in the profile, parsed as Pi parses it; one Pi cannot read is refused. */
function readStore(
  agentDir: string,
  name: string,
  text: string,
  parse: (text: string) => unknown
): Record<string, unknown> {
  const file = join(agentDir, name);
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    throw new PiProfileError(agentDir, name, `${file} is not JSON Pi can read. ${STORE_HOW}`);
  }
  if (!isRecord(parsed))
    throw new PiProfileError(agentDir, name, `${file} is not a JSON object. ${STORE_HOW}`);
  return parsed;
}

/**
 * Throws unless `models-store.json`, read as Pi reads it (empty text is an
 * empty store, else a BOM dropped and `JSON.parse`: `core/models-store.js:39-41`),
 * holds no model catalog: every provider's entry, if any, lists no model
 * (`models: []`), so Pi lays nothing over its own models
 * (`core/remote-catalog-provider.js:53-55`, `:75-85`; `core/model-runtime.js:83-97`).
 */
export function checkPiModelsStore(agentDir: string, text: string): void {
  const store = readStore(agentDir, 'models-store.json', text, (given) =>
    given ? parseAsPi(given) : {}
  );
  const overlays = Object.entries(store)
    .filter(([, entry]) => !isRecord(entry) || !Array.isArray(entry.models) || entry.models.length)
    .map(([provider]) => provider);
  if (overlays.length)
    throw new PiProfileError(
      agentDir,
      'models-store.json',
      `${join(agentDir, 'models-store.json')} holds a model catalog for ${overlays.join(', ')}: Pi would use its models, the address each is sent to included, in place of its own, and Switch does not support custom Pi models yet. ${STORE_HOW}`
    );
}

/**
 * Throws unless `mcp-auth.json`, read as Pi reads it (blank text is an empty
 * store, else `JSON.parse`: `extensions/mcp/oauth.js:65-70`), holds no MCP
 * server's sign-in, as the module comment says why.
 */
export function checkPiMcpAuth(agentDir: string, text: string): void {
  const store = readStore(agentDir, 'mcp-auth.json', text, (given) =>
    given.trim() ? JSON.parse(given) : {}
  );
  const servers = Object.keys(store);
  if (servers.length)
    throw new PiProfileError(
      agentDir,
      'mcp-auth.json',
      `${join(agentDir, 'mcp-auth.json')} holds an MCP sign-in for ${servers.join(', ')}: Pi would send its token to a session’s MCP server and refresh it where it says, and Switch’s sessions sign in to no MCP server through Pi. ${STORE_HOW}`
    );
}

/**
 * Throws unless the profile is an absolute path: Pi takes `PI_CODING_AGENT_DIR`
 * as given, `~` aside (`config.js:491-496`), so a relative one would be found
 * from Pi's directory (the project), not from the one Switch checks it from.
 */
function assertAbsoluteProfile(agentDir: string): void {
  if (!isAbsolute(agentDir))
    throw new PiProfileError(
      agentDir,
      '',
      `Switch’s Pi profile ${JSON.stringify(agentDir)} is not an absolute path (is HOME one?): Pi would find it from the project’s directory instead. Give Switch an absolute HOME.`
    );
}

/**
 * Checks Switch's Pi profile and writes nothing: throws `PiProfileError` for
 * what the module comment lists. A profile that does not exist yet passes.
 * Returns the managed keys `settings.json` still lacks.
 */
export async function checkPiProfile(agentDir: string): Promise<string[]> {
  assertAbsoluteProfile(agentDir);
  const dir = await lstatOrNull(agentDir);
  if (!dir) return Object.keys(PI_SETTINGS_MANAGED);
  if (!dir.isDirectory())
    throw new PiProfileError(
      agentDir,
      '',
      `${agentDir} is ${dir.isSymbolicLink() ? 'a link' : 'not a directory'}: Switch runs Pi only in a profile directory of its own. ${HOW}`
    );
  const entries = await readdir(agentDir);
  const found = entries
    .filter((name) => Object.hasOwn(PI_PROFILE_FORBIDDEN, name.toLowerCase()))
    .sort();
  if (found.length)
    throw new PiProfileError(
      agentDir,
      found[0] as string,
      `Switch’s Pi profile holds ${found.map((name) => `${join(agentDir, name)} (${PI_PROFILE_FORBIDDEN[name.toLowerCase()]})`).join('; ')}. ${HOW}`
    );
  // Pi's own test is the name's ending, in this case (`migrations.js:81-83`).
  const sessions = entries.filter((name) => name.endsWith('.jsonl')).sort();
  if (sessions.length)
    throw new PiProfileError(
      agentDir,
      sessions[0] as string,
      `Switch’s Pi profile holds ${sessions.map((name) => join(agentDir, name)).join(', ')}: Pi would move it into its sessions/ when it starts. ${HOW}`
    );
  for (const name of PI_PROFILE_OWN_FILES) await assertOwnFile(agentDir, name);
  const auth = await ownFile(agentDir, 'auth.json');
  if (auth !== null) checkPiAuth(agentDir, auth);
  const models = await ownFile(agentDir, 'models-store.json');
  if (models !== null) checkPiModelsStore(agentDir, models);
  const mcpAuth = await ownFile(agentDir, 'mcp-auth.json');
  if (mcpAuth !== null) checkPiMcpAuth(agentDir, mcpAuth);
  return checkPiSettings(agentDir, await ownFile(agentDir, 'settings.json'));
}

/** How long a lock on `settings.json` stays valid without its holder (`proper-lockfile`'s `stale`). */
export const PI_SETTINGS_LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

/** What `fn` of `withPiSettingsLock` is given: a way to make sure the lock is still its own. */
export interface PiSettingsLockHold {
  /** Throws `PiProfileError` once the lock has been lost or taken over. */
  assertHeld(): Promise<void>;
}

export interface PiSettingsLockOptions {
  /** How long to wait for another holder (5 s). */
  waitMs?: number;
  /** When a lock nobody renews is stale (`PI_SETTINGS_LOCK_STALE_MS`, as Pi's). */
  staleMs?: number;
  /** How often the holder renews its lock (half of `staleMs`, at least 1 s, as Pi's). */
  updateMs?: number;
}

async function statOrNull(file: string): Promise<Stats | null> {
  try {
    return await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Runs `fn` holding Pi's own lock on the profile's `settings.json`, by the
 * protocol of `proper-lockfile` that Pi takes it with (`core/settings-manager.js:126-149`;
 * `proper-lockfile/lib/lockfile.js`):
 * - the lock is the directory `settings.json.lock`, made with `mkdir` (`:25-29`);
 * - one whose time is older than `staleMs` is stale: removed with `rmdir` and
 *   made anew (`:51-86`, `:88-97`); one removed meanwhile is made anew (`:56-61`);
 * - its holder sets its time once it has it (`mtime-precision.js:19-22`) and
 *   renews it every `updateMs` while `fn` runs, so no one takes over a lock in
 *   use (`:99-167`, `:220-221`), and checks before each renewal that the lock is
 *   still the one it made, by its time and, beyond Pi, its inode (`:114-139`);
 * - a lock removed or taken over meanwhile is lost (`:120-121`, `:131-138`):
 *   `fn` sees it in `assertHeld`, and `withPiSettingsLock` throws once `fn` is
 *   done, when `fn` itself did not;
 * - it is removed on release only while it is still the one it made (beyond
 *   Pi, which removes it unless it saw it lost, `:254-262`, `:268-293`), so a
 *   holder that lost it never removes the lock of the one that took over.
 * The time between that last check and `rmdir` is a known limit, as in Pi.
 */
export async function withPiSettingsLock<T>(
  agentDir: string,
  fn: (hold: PiSettingsLockHold) => Promise<T>,
  options: PiSettingsLockOptions = {}
): Promise<T> {
  const lock = join(agentDir, 'settings.json.lock');
  const staleMs = options.staleMs ?? PI_SETTINGS_LOCK_STALE_MS;
  const updateMs = options.updateMs ?? Math.max(staleMs / 2, 1_000);
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  const failure = (why: string) =>
    new PiProfileError(
      agentDir,
      'settings.json.lock',
      `${lock} ${why} while Switch held it, so Switch did not finish setting up its Pi profile: start the agent again.`
    );
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const other = await statOrNull(lock);
    if (other === null) continue;
    if (other.mtimeMs < Date.now() - staleMs) {
      await rmdir(lock).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return;
        throw new PiProfileError(
          agentDir,
          'settings.json.lock',
          `${lock} is stale but not a lock Pi made (${error.code ?? 'error'}): remove it if no Pi is running.`
        );
      });
      continue;
    }
    if (Date.now() > deadline)
      throw new PiProfileError(
        agentDir,
        'settings.json.lock',
        `${lock} is held by another Pi or Switch: try again, or remove it if no Pi is running.`
      );
    await delay(20);
  }

  const now = new Date();
  await utimes(lock, now, now);
  const made = await stat(lock);
  const own = { ino: made.ino, mtimeMs: made.mtimeMs };
  const ours = (found: Stats | null) =>
    found !== null && found.ino === own.ino && found.mtimeMs === own.mtimeMs;
  let lost: PiProfileError | undefined;
  let done = false;
  let timer: NodeJS.Timeout | undefined;
  // Renewals, checks and the release one at a time: a check never sees a time
  // a renewal has set but not yet noted as its own.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <R>(task: () => Promise<R>): Promise<R> => {
    const next = queue.then(task);
    queue = next.catch(() => undefined);
    return next;
  };
  const check = async () => {
    const found = await statOrNull(lock).catch(() => null);
    if (!ours(found))
      lost ??= failure(found === null ? 'was removed' : 'was taken over by another Pi or Switch');
  };

  const renew = async () => {
    await check();
    if (lost || done) return;
    try {
      const time = new Date();
      await utimes(lock, time, time);
      own.mtimeMs = (await stat(lock)).mtimeMs;
    } catch {
      lost ??= failure('could not be renewed');
    }
  };
  const schedule = () => {
    timer = setTimeout(() => {
      void serial(renew).then(() => {
        if (!done && !lost) schedule();
      });
    }, updateMs);
    timer.unref();
  };
  schedule();

  const hold: PiSettingsLockHold = {
    assertHeld: () =>
      serial(async () => {
        await check();
        if (lost) throw lost;
      }),
  };

  let result: T;
  try {
    result = await fn(hold);
  } finally {
    done = true;
    clearTimeout(timer);
    await serial(async () => {
      await check();
      if (!lost)
        await rmdir(lock).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
    });
  }
  if (lost) throw lost;
  return result;
}

/**
 * Sets Switch's Pi profile up for a session or a discovery: creates it (0700)
 * when missing, checks it (`checkPiProfile`) under the `settings.json` lock,
 * and writes the managed keys only when one is missing or different, keeping
 * every other key as it is, and only while the lock is still its own. Returns
 * whether it wrote `settings.json`.
 */
export async function preparePiProfile(
  agentDir: string,
  options: PiSettingsLockOptions = {}
): Promise<boolean> {
  assertAbsoluteProfile(agentDir);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  return withPiSettingsLock(
    agentDir,
    async (hold) => {
      const lacking = await checkPiProfile(agentDir);
      if (!lacking.length) return false;
      const file = join(agentDir, 'settings.json');
      const text = await ownFile(agentDir, 'settings.json');
      const settings = text === null ? {} : readJson(agentDir, 'settings.json', text);
      const next = { ...settings, ...PI_SETTINGS_MANAGED };
      const temp = `${file}.switch-${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await hold.assertHeld();
        await rename(temp, file);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      return true;
    },
    options
  );
}
