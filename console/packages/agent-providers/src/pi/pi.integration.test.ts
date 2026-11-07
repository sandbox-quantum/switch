import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerSpec, ProviderAdapter } from '../adapter';
import { providerRuntime } from '../providers/registry';
import { describeConformance, echoMcpServerSpec, EventRecorder } from '../testing/index';
import { resolvePiBinary } from './pi-launch';
import { PI_AGENT_DIR_IN_HOME, piAgentDir } from './pi-paths';
import { checkPiAuth, PiProfileError } from './pi-profile';
import { PI_PACKAGE, PI_VERSION, PiVersionError, assertPiVersion } from './pi-version';
import { checkPiSignIn, PI_INHERIT_ENV } from './sign-in';

/** `provider/model`, as a Pi agent's model is chosen in Switch. */
const MODEL = process.env['SWITCH_PI_MODEL'] ?? 'anthropic/claude-sonnet-5-5';
const MODEL_PROVIDER = MODEL.slice(0, Math.max(MODEL.indexOf('/'), 0));
const MODEL_ID = MODEL.slice(MODEL.indexOf('/') + 1);
const TOKEN = 'SWITCH_CONFORMANCE_OK';
const TIMEOUT_MS = 240_000;
/** When the skips below were last checked against Pi. */
const CHECKED = '2026-11-07';

/** Switch's own Pi profile in the developer's home, where `PI_LOGIN` signs in. */
const USER_AUTH = join(homedir(), ...PI_AGENT_DIR_IN_HOME, 'auth.json');

/**
 * A throwaway home for every Pi the suite starts. Switch always runs Pi in its
 * own profile under `HOME` (`piAgentDir`, which does not follow a
 * `PI_CODING_AGENT_DIR` it is given), so a fresh `HOME` is what keeps the
 * suite away from the developer's own `~/.pi/agent`, projects and Switch
 * profile. The login lives in `auth.json` and is the only thing copied across:
 * Switch's check of the profile (D-14) refuses to start Pi with most of what
 * else a profile may hold (`pi-profile.ts` `PI_PROFILE_FORBIDDEN`), and the
 * profile's `settings.json` is Switch's to write. Nothing in a copied
 * `auth.json` points Pi at a file outside the profile: the one field that
 * could (`env`, e.g. Vertex's `GOOGLE_APPLICATION_CREDENTIALS`) is refused
 * outright by that check (`checkPiAuth`, D-14 B′), which every start and
 * sign-in check runs first, and a `key` of `$NAME` reads only the
 * environment below.
 */
function isolatedPiHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'switch-pi-home-'));
  const agentDir = piAgentDir({ HOME: home });
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  if (existsSync(USER_AUTH)) copyFileSync(USER_AUTH, join(agentDir, 'auth.json'));
  return home;
}

const piHome = isolatedPiHome();

/**
 * The variables of `PI_INHERIT_ENV` whose value is a path: a file or directory
 * Pi or the SDKs it signs in with read credentials or their configuration
 * from (Anthropic's and AWS's web identity tokens, the AWS container token,
 * profile files and `aws login` cache, Google's application default
 * credentials and certificate configuration). A fresh `HOME` does not stop
 * those reads, so the suite passes none of them on unless it points inside
 * the throwaway home.
 */
const PI_ENV_PATHS: ReadonlySet<string> = new Set([
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_LOGIN_CACHE_DIRECTORY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_API_CERTIFICATE_CONFIG',
]);

/** A name that reads as a path; each such name in `PI_INHERIT_ENV` must be in `PI_ENV_PATHS`. */
const PATH_LIKE_NAME = /(?:_FILE|_DIRECTORY|_DIR|_PATH|_CREDENTIALS|_CONFIG)$/;

/** Whether `path` (resolved against the working directory) lies inside `dir`. */
function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * What the harness layers over its minimal PATH/HOME: the throwaway home, and
 * the provider keys a session host passes Pi (the registry's `inheritEnv`), so
 * a key in the shell reaches Pi as it would in Switch. Only values are passed
 * on as they are; a variable naming a file (`PI_ENV_PATHS`) only when the file
 * is inside `home`, so the suite reads no credentials of the developer's from
 * outside its own profile (N-01).
 */
function inheritPiEnv(
  source: Record<string, string | undefined>,
  home: string
): Record<string, string> {
  const env: Record<string, string> = { HOME: home };
  for (const name of PI_INHERIT_ENV) {
    const value = source[name];
    if (!value) continue;
    if (PI_ENV_PATHS.has(name) && !isInside(home, value)) continue;
    env[name] = value;
  }
  return env;
}

const piEnv = inheritPiEnv(process.env, piHome);

/** The environment the harness gives each session (`conformance.ts` `baseEnv`). */
function sessionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...piEnv };
}

async function findUnavailable(): Promise<string | null> {
  if (!MODEL_PROVIDER || !MODEL_ID) return `SWITCH_PI_MODEL must be provider/model, not ${MODEL}`;
  const env = sessionEnv();
  let binary: string;
  try {
    binary = await resolvePiBinary(undefined, env);
  } catch {
    return `the pi binary is not on PATH; install ${PI_PACKAGE}@${PI_VERSION}`;
  }
  try {
    await assertPiVersion(binary, { env });
  } catch (error) {
    if (error instanceof PiVersionError) return error.message;
    throw error;
  }
  const cwd = mkdtempSync(join(tmpdir(), 'switch-pi-check-'));
  try {
    const signIn = await checkPiSignIn(
      { binaryPath: binary, cwd, env },
      { modelProvider: MODEL_PROVIDER }
    );
    if (signIn.status !== 'authenticated') {
      return `Pi is not signed in to ${MODEL_PROVIDER} (no login copied from ${USER_AUTH} and no provider key in the environment, such as ANTHROPIC_API_KEY): ${signIn.message}`;
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return null;
}

let availability: Promise<string | null> | undefined;
/** Asked once for both suites in this file. */
const unavailableReason = () => (availability ??= findUnavailable());

const createAdapter = async (): Promise<ProviderAdapter> =>
  providerRuntime('pi').createAdapter({
    binaryPath: undefined,
    logger: undefined,
    skill: '',
    serviceSkills: [],
  });

/** Runs with no Pi, key or model: what the suite hands Pi from the developer's environment. */
describe('pi integration suite environment', () => {
  it('passes on no variable naming a file outside the throwaway home', () => {
    const home = mkdtempSync(join(tmpdir(), 'switch-pi-env-'));
    try {
      const outside = join(tmpdir(), 'switch-pi-not-the-profile', 'credentials');
      const inside = join(home, 'token');
      const env = inheritPiEnv(
        {
          ANTHROPIC_API_KEY: 'sk-fake-value',
          AWS_REGION: 'eu-central-1',
          ANTHROPIC_IDENTITY_TOKEN_FILE: outside,
          GOOGLE_APPLICATION_CREDENTIALS: outside,
          AWS_SHARED_CREDENTIALS_FILE: outside,
          AWS_CONFIG_FILE: 'relative/config',
          AWS_LOGIN_CACHE_DIRECTORY: `${home}${sep}..`,
          AWS_WEB_IDENTITY_TOKEN_FILE: inside,
          NOT_PI_ENV: 'ignored',
        },
        home
      );
      expect(env).toEqual({
        HOME: home,
        ANTHROPIC_API_KEY: 'sk-fake-value',
        AWS_REGION: 'eu-central-1',
        AWS_WEB_IDENTITY_TOKEN_FILE: inside,
      });
      expect(Object.values(env)).not.toContain(outside);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('treats every path-like name Pi inherits as a path', () => {
    const pathLike = PI_INHERIT_ENV.filter((name) => PATH_LIKE_NAME.test(name));
    expect(pathLike.filter((name) => !PI_ENV_PATHS.has(name))).toEqual([]);
    expect([...PI_ENV_PATHS].filter((name) => !PI_INHERIT_ENV.includes(name))).toEqual([]);
  });

  it('refuses a copied sign-in that brings an environment of its own (env)', () => {
    const agentDir = join(tmpdir(), 'switch-pi-auth-check');
    const auth = JSON.stringify({
      'google-vertex': {
        type: 'api_key',
        key: 'fake',
        env: { GOOGLE_APPLICATION_CREDENTIALS: '/outside/the/profile/adc.json' },
      },
    });
    expect(() => checkPiAuth(agentDir, auth)).toThrow(PiProfileError);
  });
});

describeConformance('pi', {
  createAdapter,
  unavailableReason,
  model: { id: MODEL },
  env: piEnv,
  mcpServers: { switch_echo: echoMcpServerSpec() },
  timeoutMs: TIMEOUT_MS,
  skip: {
    'user-input': `Pi ${PI_VERSION} (checked ${CHECKED}) has no ask-the-user tool among its built-in tools (read, bash, edit, write: pi-coding-agent dist/core/agent-session.js:2991), and the adapter refuses Pi's extension questions (select, input) instead of showing them (capabilities userInput: false).`,
    subagent: `Pi ${PI_VERSION} (checked ${CHECKED}) has no subagent or task tool (pi-coding-agent dist/core/tools: bash, edit, find, grep, ls, read, write), so there is nothing to delegate to.`,
  },
});

/**
 * A stdio MCP server that writes every call it gets to `log` (one JSON line
 * each) and answers with the text and `nonce`, which is in no prompt: an
 * answer holding it came from the call.
 */
const RECORDING_STDIO_SERVER = `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [log, nonce] = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params } = request;
  if (id === undefined) return;
  if (method === 'initialize')
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'switch-record', version: '0.0.1' } } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list')
    return send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'switch_echo', description: 'Echoes the given text back with a stamp. Used by Switch conformance tests.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  if (method === 'tools/call') {
    appendFileSync(log, JSON.stringify({ name: params?.name, arguments: params?.arguments }) + '\\n');
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(params?.arguments?.text ?? '') + ' ' + nonce }] } });
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method ' + method } });
});
`;

interface RecordedCall {
  name: unknown;
  arguments: unknown;
}

/** The same server over streamable HTTP (POST JSON in, JSON out), on 127.0.0.1 only. */
async function startRecordingHttpServer(
  nonce: string,
  calls: RecordedCall[]
): Promise<{ server: Server; url: string }> {
  const answer = (message: {
    id?: unknown;
    method?: unknown;
    params?: { protocolVersion?: string; name?: unknown; arguments?: { text?: unknown } };
  }) => {
    const { id, method, params } = message;
    if (id === undefined) return null;
    if (method === 'initialize')
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'switch-record', version: '0.0.1' },
        },
      };
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list')
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'switch_echo',
              description:
                'Echoes the given text back with a stamp. Used by Switch conformance tests.',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          ],
        },
      };
    if (method === 'tools/call') {
      calls.push({ name: params?.name, arguments: params?.arguments });
      const text = `${String(params?.arguments?.text ?? '')} ${nonce}`;
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown method ${String(method)}` },
    };
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method !== 'POST') return void res.writeHead(405).end();
      let message: Parameters<typeof answer>[0];
      try {
        message = JSON.parse(body);
      } catch {
        return void res.writeHead(400).end();
      }
      const out = answer(message);
      if (!out) return void res.writeHead(202).end();
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'switch-record' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the HTTP MCP server has no port');
  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}

/**
 * What the harness leaves open (READY §5): `mcp-registered` only checks a
 * token the prompt itself holds, and nothing checks which model answered. Here
 * a server records each call it gets and stamps its answer with a nonce in no
 * prompt, over stdio and HTTP, and the turn's usage must name the model the
 * session chose.
 */
describe('pi on the real CLI, beyond the harness', () => {
  let unavailable: string | null = null;
  const adapters: ProviderAdapter[] = [];
  const dirs: string[] = [];
  const servers: Server[] = [];

  beforeAll(async () => {
    unavailable = await unavailableReason();
  });

  afterAll(async () => {
    await Promise.allSettled(adapters.map((adapter) => adapter.stopAll()));
    await Promise.allSettled(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
    for (const dir of [...dirs, piHome]) rmSync(dir, { recursive: true, force: true });
  });

  async function session(mcpServers: Record<string, McpServerSpec>) {
    const adapter = await createAdapter();
    adapters.push(adapter);
    const cwd = mkdtempSync(join(tmpdir(), 'switch-pi-real-'));
    dirs.push(cwd);
    writeFileSync(join(cwd, 'README.md'), '# pi real-CLI scratch\n');
    const recorder = new EventRecorder(adapter);
    const sessionId = `session-pi-${Date.now().toString(36)}-${adapters.length}`;
    await adapter.startSession({
      sessionId,
      cwd,
      // Switch's own servers are approved in every mode; the call must not ask.
      runtimeMode: 'approval-required',
      env: sessionEnv(),
      mcpServers,
      connectorMcpServers: [],
      model: { id: MODEL },
    });
    return { adapter, recorder, sessionId, cwd };
  }

  /** The turn's usage names the session's model (with or without its provider) and counts tokens. */
  function expectUsageOfModel(
    usage: { model: string; inputTokens: number; outputTokens: number }[]
  ) {
    const own = usage.filter((entry) => entry.model === MODEL || entry.model === MODEL_ID);
    expect(own, `usage ${JSON.stringify(usage)} names ${MODEL}`).toHaveLength(1);
    expect(own[0]!.inputTokens).toBeGreaterThan(0);
    expect(own[0]!.outputTokens).toBeGreaterThan(0);
  }

  async function callsEchoTool(
    server: string,
    spec: McpServerSpec,
    nonce: string,
    calls: () => Promise<RecordedCall[]>
  ) {
    const { adapter, recorder, sessionId } = await session({ [server]: spec });
    const turnId = `turn-pi-${server}`;
    await adapter.sendTurn({
      sessionId,
      turnId,
      text: `Call the switch_echo tool from the MCP server named ${server} with the text ${TOKEN}, then reply with exactly what it returned.`,
    });
    const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, TIMEOUT_MS);
    expect(done.outcome).toBe('completed');
    expect(recorder.ofType('request.opened')).toEqual([]);
    const call = recorder
      .ofType('item.completed')
      .find((e) => e.turnId === turnId && e.item.type === 'mcp_tool_call');
    expect(call?.item.status).toBe('completed');
    expect(call?.item.toolName ?? '').toContain('switch_echo');
    expect(await calls()).toEqual([{ name: 'switch_echo', arguments: { text: TOKEN } }]);
    expect(recorder.assistantText(turnId)).toContain(nonce);
    expectUsageOfModel(done.usage);
    await adapter.stopSession(sessionId);
  }

  it(
    'names the chosen model in the usage of a turn',
    async (ctx) => {
      if (unavailable) return ctx.skip(`pi unavailable: ${unavailable}`);
      const { adapter, recorder, sessionId } = await session({});
      const turnId = 'turn-pi-usage';
      await adapter.sendTurn({
        sessionId,
        turnId,
        text: `Reply with exactly the text ${TOKEN} and nothing else. Do not use any tools.`,
      });
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, TIMEOUT_MS);
      expect(done.outcome).toBe('completed');
      expect(recorder.assistantText(turnId)).toContain(TOKEN);
      expectUsageOfModel(done.usage);
      await adapter.stopSession(sessionId);
    },
    TIMEOUT_MS
  );

  it(
    'calls a tool of a stdio MCP server',
    async (ctx) => {
      if (unavailable) return ctx.skip(`pi unavailable: ${unavailable}`);
      const dir = mkdtempSync(join(tmpdir(), 'switch-pi-mcp-'));
      dirs.push(dir);
      const script = join(dir, 'record-mcp-server.mjs');
      const log = join(dir, 'calls.jsonl');
      writeFileSync(script, RECORDING_STDIO_SERVER);
      const nonce = `stdio-${Math.random().toString(36).slice(2, 10)}`;
      await callsEchoTool(
        'switch_stdio',
        { transport: 'stdio', command: process.execPath, args: [script, log, nonce] },
        nonce,
        async () =>
          existsSync(log)
            ? (await readFile(log, 'utf8'))
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line) as RecordedCall)
            : []
      );
    },
    TIMEOUT_MS
  );

  it(
    'calls a tool of an HTTP MCP server',
    async (ctx) => {
      if (unavailable) return ctx.skip(`pi unavailable: ${unavailable}`);
      const nonce = `http-${Math.random().toString(36).slice(2, 10)}`;
      const calls: RecordedCall[] = [];
      const { server, url } = await startRecordingHttpServer(nonce, calls);
      servers.push(server);
      await callsEchoTool('switch_http', { transport: 'http', url }, nonce, async () => calls);
    },
    TIMEOUT_MS
  );
});
