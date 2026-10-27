import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexKeyringLogin, ProviderSessionStartInput } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { FakeAppServer } from './fake-app-server';

/** Stands in for an API key; asserted never to reach an error, a log line or an event. */
const SENTINEL = 'sk-sentinel-keyring-login-0001';
const EPHEMERAL = 'cli_auth_credentials_store="ephemeral"';

interface Spawned {
  spawnArgs: string[];
  spawnOptions: { cwd: string; env: Record<string, string> };
}

let sourceHome = '';
let sessionHome = '';
/** The Codex run against the machine's own home to read its login. */
const sources: Array<FakeAppServer & Spawned> = [];
/** The session's Codex: the login check first, then the session itself. */
const sessions: Array<FakeAppServer & Spawned> = [];
let source: {
  account: Record<string, unknown> | null;
  authStatus: Record<string, unknown> | { error: { code: number; message: string } };
  /** A keychain prompt nobody answers: Codex never gets as far as replying. */
  silent: boolean;
  /** Holds back the key until released. */
  hold: Promise<void> | null;
  /** Exits at once, saying this on stderr. */
  crash: string | null;
};
let session: {
  /** The login the session's Codex has of its own, without the in-memory store. */
  ownLogin: Record<string, unknown> | null;
  store: unknown;
  afterLogin: Record<string, unknown> | null;
  /** The login check exits at once, saying this on stderr. */
  probeCrash: string | null;
};

function crash(server: FakeAppServer, output: string) {
  server.stderr.write(`${output}\n`);
  setTimeout(() => server.kill(), 10);
}

vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[], options: Spawned['spawnOptions']) => {
    const server = Object.assign(new FakeAppServer(), { spawnArgs: args, spawnOptions: options });
    if (options.cwd === sourceHome) {
      sources.push(server);
      if (source.silent) return server;
      if (source.crash) {
        crash(server, source.crash);
        return server;
      }
      server.replyAlways('initialize', () => ({ userAgent: 'fake' }));
      server.replyAlways('account/read', () => ({
        account: source.account,
        requiresOpenaiAuth: true,
      }));
      server.on('message', async (message) => {
        if (message.method !== 'getAuthStatus' || message.id === undefined) return;
        await source.hold;
        const reply = source.authStatus;
        if ('error' in reply) server.send({ id: message.id, error: reply.error as never });
        else server.send({ id: message.id, result: reply });
      });
      return server;
    }
    sessions.push(server);
    const ephemeral = args.includes(EPHEMERAL);
    if (!ephemeral && session.probeCrash) {
      crash(server, session.probeCrash);
      return server;
    }
    let signedIn = false;
    server.replyAlways('initialize', () => ({ userAgent: 'fake' }));
    server.replyAlways('account/read', () => ({
      account: ephemeral ? (signedIn ? session.afterLogin : null) : session.ownLogin,
      requiresOpenaiAuth: true,
    }));
    server.replyAlways('config/read', () => ({
      config: { cli_auth_credentials_store: session.store },
      origins: {},
    }));
    server.replyAlways('account/login/start', () => {
      signedIn = true;
      return { type: 'apiKey' };
    });
    server.replyAlways('thread/start', () => ({ thread: { id: 'thread-1' } }));
    return server;
  },
}));

const { CODEX_KEYRING_SIGN_IN_REQUIRED, createCodexAdapter } = await import('./codex-adapter');
const { CODEX_FILE_STORE_WORKAROUND, readCodexKeyringApiKey } = await import('./keyring-login');

const methods = (server: FakeAppServer | undefined) =>
  (server?.received ?? []).map((message) => message.method);
const sessionServer = () => sessions.at(-1);

function keyringLogin(redact: (secret: string) => void = () => {}): CodexKeyringLogin {
  return { home: sourceHome, env: { PATH: '/usr/bin' }, redact };
}

function startInput(login: CodexKeyringLogin | null): ProviderSessionStartInput {
  return {
    sessionId: 'session-1',
    cwd: '/work',
    runtimeMode: 'full-access',
    env: { PATH: '/usr/bin', CODEX_HOME: sessionHome },
    mcpServers: {},
    connectorMcpServers: [],
    ...(login ? { codexKeyringLogin: login } : {}),
  };
}

/** Starts a session that may be handed a keyring login, recording everything that could leak the key. */
async function start(login: CodexKeyringLogin = keyringLogin()) {
  const logged: unknown[] = [];
  const record = (...args: unknown[]) => logged.push(args);
  const adapter = createCodexAdapter({ logger: { debug: record, warn: record, error: record } });
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const outcome = await adapter.startSession(startInput(login)).then(
    (value) => ({ session: value, error: null }),
    (error: unknown) => ({ session: null, error: error as Error })
  );
  return { adapter, events, logged, ...outcome };
}

function expectNoLeak(result: Awaited<ReturnType<typeof start>>) {
  expect(result.error?.message ?? '').not.toContain(SENTINEL);
  expect(String(result.error?.cause ?? '')).not.toContain(SENTINEL);
  expect(JSON.stringify(result.logged)).not.toContain(SENTINEL);
  expect(JSON.stringify(result.events)).not.toContain(SENTINEL);
}

beforeEach(async () => {
  sourceHome = await mkdtemp(join(tmpdir(), 'codex-keyring-source-'));
  sessionHome = await mkdtemp(join(tmpdir(), 'codex-keyring-session-'));
  sources.length = 0;
  sessions.length = 0;
  source = {
    account: { type: 'apiKey' },
    authStatus: { authMethod: 'apikey', authToken: SENTINEL, requiresOpenaiAuth: true },
    silent: false,
    hold: null,
    crash: null,
  };
  session = {
    ownLogin: null,
    store: 'ephemeral',
    afterLogin: { type: 'apiKey' },
    probeCrash: null,
  };
});

afterEach(async () => {
  await rm(sourceHome, { recursive: true, force: true });
  await rm(sessionHome, { recursive: true, force: true });
});

describe('a Codex session with no login of its own', () => {
  it('keeps the login in memory and takes the key from Codex run against its own home', async () => {
    const order: string[] = [];
    const result = await start(
      keyringLogin((secret) => {
        order.push(`redact ${secret === SENTINEL}`);
        order.push(
          ...methods(sessionServer()).filter((method) => method === 'account/login/start')
        );
      })
    );
    expect(result.error).toBeNull();
    expect(result.session?.nativeSessionId).toBe('thread-1');

    // The login check runs the session's Codex as configured, and only reads.
    const [check, started] = sessions;
    expect(sessions).toHaveLength(2);
    expect(check.spawnArgs).not.toContain(EPHEMERAL);
    expect(check.spawnOptions.cwd).toBe('/work');
    expect(methods(check)).toEqual(['initialize', 'initialized', 'account/read']);
    expect(check.stdin.writableEnded).toBe(true);

    expect(started.spawnArgs.slice(-2)).toEqual(['-c', EPHEMERAL]);
    expect(methods(started)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'config/read',
      'account/login/start',
      'account/read',
      'thread/start',
    ]);
    expect(started.received.find((m) => m.method === 'config/read')?.params).toEqual({
      cwd: '/work',
    });
    expect(started.received.find((m) => m.method === 'account/login/start')?.params).toEqual({
      type: 'apiKey',
      apiKey: SENTINEL,
    });
    // Scrubbed before it is sent anywhere.
    expect(order).toEqual(['redact true']);

    const [reader] = sources;
    expect(reader.spawnArgs).toEqual(['app-server']);
    expect(reader.spawnOptions.cwd).toBe(sourceHome);
    expect(reader.spawnOptions.env).toEqual({ PATH: '/usr/bin', CODEX_HOME: sourceHome });
    expect(methods(reader)).toEqual(['initialize', 'initialized', 'account/read', 'getAuthStatus']);
    expect(reader.received.find((m) => m.method === 'getAuthStatus')?.params).toEqual({
      includeToken: true,
      refreshToken: false,
    });
    expect(reader.stdin.writableEnded).toBe(true);
    expectNoLeak(result);
    await result.adapter.stopAll();
  });

  it('reads the key again each time the session starts, so a changed key is picked up', async () => {
    const first = await start();
    await first.adapter.stopAll();
    const second = await start();
    expect(second.error).toBeNull();
    expect(sources).toHaveLength(2);
    await second.adapter.stopAll();
  });

  it('removes a copied login that no longer works before handing over the key', async () => {
    await writeFile(join(sessionHome, 'auth.json'), 'stale-login');
    const result = await start();
    expect(result.error).toBeNull();
    expect(await readdir(sessionHome)).not.toContain('auth.json');
    await result.adapter.stopAll();
  });

  it('does not read the key when Codex would save it outside memory', async () => {
    session.store = 'file';
    const result = await start();
    expect(result.error?.message).toContain('sets cli_auth_credentials_store to "file"');
    expect(sources).toHaveLength(0);
    expect(methods(sessionServer())).not.toContain('account/login/start');
    expect(methods(sessionServer())).not.toContain('thread/start');
  });

  it.each([
    ['chatgpt', 'ChatGPT'],
    ['amazonBedrock', 'a amazonBedrock login'],
  ])(
    'explains why a %s keyring login cannot be handed over, without asking for its token',
    async (type, shown) => {
      source.account = { type };
      const result = await start();
      expect(result.error?.message).toContain(`signed in with ${shown}`);
      expect(result.error?.message).toContain('only when it is an API key');
      expect(result.error?.message).toContain(CODEX_FILE_STORE_WORKAROUND);
      expect(methods(sources[0])).not.toContain('getAuthStatus');
      expect(methods(sessionServer())).not.toContain('account/login/start');
    }
  );

  it('sends nothing when Codex reports an API-key account but exports something else', async () => {
    source.authStatus = { authMethod: 'chatgpt', authToken: SENTINEL };
    const result = await start();
    expect(result.error?.message).toContain('did not hand over the key');
    expect(methods(sessionServer())).not.toContain('account/login/start');
    expectNoLeak(result);
  });

  it('asks for a sign-in, naming the keyring, when the machine’s Codex is signed out', async () => {
    source.account = null;
    const result = await start();
    expect(result.error?.message).toContain(CODEX_KEYRING_SIGN_IN_REQUIRED);
    expect(methods(sources[0])).not.toContain('getAuthStatus');
  });

  it('asks for a sign-in without starting that Codex when the machine has no Codex home', async () => {
    await rm(sourceHome, { recursive: true });
    const result = await start();
    expect(result.error?.message).toContain(CODEX_KEYRING_SIGN_IN_REQUIRED);
    expect(sources).toHaveLength(0);
  });

  it('says so when this Codex no longer exports its login', async () => {
    source.authStatus = { error: { code: -32601, message: 'method not found' } };
    const result = await start();
    expect(result.error?.message).toContain('no longer answers getAuthStatus');
    expect(methods(sessionServer())).not.toContain('account/login/start');
  });

  it('passes on what Codex said when it fails to report its login', async () => {
    source.crash = 'fixture: keyring backend unavailable';
    const result = await start();
    expect(result.error?.message).toContain('could not report its login');
    expect(result.error?.message).toContain('fixture: keyring backend unavailable');
  });

  it('fails when Codex does not take the key, without repeating it', async () => {
    session.afterLogin = null;
    const result = await start();
    expect(result.error?.message).toContain('did not take the API key');
    expect(methods(sessionServer())).not.toContain('thread/start');
    expectNoLeak(result);
  });

  it('does not unregister the session that replaced a start stopped while it waited on the keyring', async () => {
    let release = () => {};
    source.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createCodexAdapter();
    const stale = adapter.startSession(startInput(keyringLogin()));
    await vi.waitFor(() => expect(methods(sources[0])).toContain('getAuthStatus'));
    await adapter.stopSession('session-1');
    session.ownLogin = { type: 'apiKey' };
    await adapter.startSession(startInput(null));
    release();
    await expect(stale).rejects.toThrow();
    expect(adapter.hasSession('session-1')).toBe(true);
    await adapter.stopAll();
  });
});

describe('a Codex session with a login of its own', () => {
  it('starts as before, with its copy and no keyring read, when the machine moved its own login to the keyring', async () => {
    session.ownLogin = { type: 'chatgpt', email: null, planType: null };
    await writeFile(join(sessionHome, 'auth.json'), 'copied-login');
    const result = await start();
    expect(result.error).toBeNull();
    expect(sessionServer()?.spawnArgs).not.toContain(EPHEMERAL);
    expect(methods(sessionServer())).not.toContain('account/login/start');
    expect(sources).toHaveLength(0);
    expect(await readFile(join(sessionHome, 'auth.json'), 'utf8')).toBe('copied-login');
    await result.adapter.stopAll();
  });

  it('passes on what Codex said when checking the session’s login fails', async () => {
    session.probeCrash = 'fixture: invalid configuration';
    const result = await start();
    expect(result.error?.message).toContain('could not check the codex login');
    expect(result.error?.message).toContain('fixture: invalid configuration');
    expect(sources).toHaveLength(0);
  });
});

describe('readCodexKeyringApiKey', () => {
  it('gives up with a reason when the keyring does not answer, and stops that Codex', async () => {
    source.silent = true;
    await expect(readCodexKeyringApiKey('codex', keyringLogin(), 50)).rejects.toThrow(
      /did not read its login from the OS keyring within 0\.05 seconds.*"Codex Auth"/
    );
    expect(sources[0]?.stdin.writableEnded).toBe(true);
  });
});
