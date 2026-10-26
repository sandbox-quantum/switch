import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexKeyringLogin } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { FakeAppServer } from './fake-app-server';

/** Stands in for an API key; asserted never to reach an error, a log line or an event. */
const SENTINEL = 'sk-sentinel-keyring-login-0001';

interface Spawned {
  spawnArgs: string[];
  spawnOptions: { cwd: string; env: Record<string, string> };
}

let sourceHome = '';
const sources: FakeAppServer[] = [];
const sessions: FakeAppServer[] = [];
let source: {
  account: Record<string, unknown> | null;
  authStatus: Record<string, unknown> | { error: { code: number; message: string } };
  silent: boolean;
};
let session: { store: unknown; afterLogin: Record<string, unknown> | null };

vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[], options: Spawned['spawnOptions']) => {
    const server = new FakeAppServer();
    Object.assign(server, { spawnArgs: args, spawnOptions: options });
    if (options.cwd === sourceHome) {
      sources.push(server);
      // A keychain prompt nobody answers: Codex never gets as far as replying.
      if (source.silent) return server;
      server.replyAlways('initialize', () => ({ userAgent: 'fake' }));
      server.replyAlways('account/read', () => ({
        account: source.account,
        requiresOpenaiAuth: true,
      }));
      server.on('message', (message) => {
        if (message.method !== 'getAuthStatus' || message.id === undefined) return;
        const reply = source.authStatus;
        if ('error' in reply) server.send({ id: message.id, error: reply.error as never });
        else server.send({ id: message.id, result: reply });
      });
      return server;
    }
    sessions.push(server);
    let signedIn = false;
    server.replyAlways('initialize', () => ({ userAgent: 'fake' }));
    server.replyAlways('account/read', () => ({
      account: signedIn ? session.afterLogin : null,
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
const { CODEX_FILE_STORE_WORKAROUND, keyringBusEnvironment, readCodexKeyringApiKey } =
  await import('./keyring-login');

const methods = (server: FakeAppServer | undefined) =>
  (server?.received ?? []).map((message) => message.method);

function keyringLogin(redact: (secret: string) => void = () => {}): CodexKeyringLogin {
  return {
    home: sourceHome,
    env: { PATH: '/usr/bin', CODEX_HOME: '/sessions/session-home' },
    redact,
  };
}

/** Starts a session handed a keyring login, recording everything that could leak the key. */
async function start(login: CodexKeyringLogin = keyringLogin()) {
  const logged: unknown[] = [];
  const record = (...args: unknown[]) => logged.push(args);
  const adapter = createCodexAdapter({
    logger: { debug: record, warn: record, error: record },
  });
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const started = adapter.startSession({
    sessionId: 'session-1',
    cwd: '/work',
    runtimeMode: 'full-access',
    env: { PATH: '/usr/bin', CODEX_HOME: '/sessions/session-home' },
    mcpServers: {},
    connectorMcpServers: [],
    codexKeyringLogin: login,
  });
  const outcome = await started.then(
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
  sources.length = 0;
  sessions.length = 0;
  source = {
    account: { type: 'apiKey' },
    authStatus: { authMethod: 'apikey', authToken: SENTINEL, requiresOpenaiAuth: true },
    silent: false,
  };
  session = { store: 'ephemeral', afterLogin: { type: 'apiKey' } };
});

afterEach(async () => {
  await rm(sourceHome, { recursive: true, force: true });
});

describe('a Codex session handed a keyring login', () => {
  it('keeps the login in memory and takes the key from Codex run against its own home', async () => {
    const order: string[] = [];
    const result = await start(
      keyringLogin((secret) => {
        order.push(`redact ${secret === SENTINEL}`);
        order.push(...methods(sessions[0]).filter((method) => method === 'account/login/start'));
      })
    );
    expect(result.error).toBeNull();
    expect(result.session?.nativeSessionId).toBe('thread-1');
    const [sessionServer] = sessions as unknown as Array<FakeAppServer & Spawned>;
    expect(sessionServer.spawnArgs.slice(-2)).toEqual([
      '-c',
      'cli_auth_credentials_store="ephemeral"',
    ]);
    expect(methods(sessionServer)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'config/read',
      'account/login/start',
      'account/read',
      'thread/start',
    ]);
    expect(sessionServer.received.find((m) => m.method === 'config/read')?.params).toEqual({
      cwd: '/work',
    });
    expect(sessionServer.received.find((m) => m.method === 'account/login/start')?.params).toEqual({
      type: 'apiKey',
      apiKey: SENTINEL,
    });
    // Scrubbed before it is sent anywhere.
    expect(order).toEqual(['redact true']);

    const [sourceServer] = sources as unknown as Array<FakeAppServer & Spawned>;
    expect(sourceServer.spawnArgs).toEqual(['app-server']);
    expect(sourceServer.spawnOptions.cwd).toBe(sourceHome);
    expect(sourceServer.spawnOptions.env).toEqual({ PATH: '/usr/bin', CODEX_HOME: sourceHome });
    expect(methods(sourceServer)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'getAuthStatus',
    ]);
    expect(sourceServer.received.find((m) => m.method === 'getAuthStatus')?.params).toEqual({
      includeToken: true,
      refreshToken: false,
    });
    expect(sourceServer.stdin.writableEnded).toBe(true);
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

  it('does not read the key when Codex would save it outside memory', async () => {
    session.store = 'file';
    const result = await start();
    expect(result.error?.message).toContain('sets cli_auth_credentials_store to "file"');
    expect(sources).toHaveLength(0);
    expect(methods(sessions[0])).not.toContain('account/login/start');
    expect(methods(sessions[0])).not.toContain('thread/start');
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
      expect(methods(sessions[0])).not.toContain('account/login/start');
    }
  );

  it('sends nothing when Codex reports an API-key account but exports something else', async () => {
    source.authStatus = { authMethod: 'chatgpt', authToken: SENTINEL };
    const result = await start();
    expect(result.error?.message).toContain('did not hand over the key');
    expect(methods(sessions[0])).not.toContain('account/login/start');
    expectNoLeak(result);
  });

  it('asks for a sign-in, naming the keyring, when the machine’s Codex is signed out', async () => {
    source.account = null;
    const result = await start();
    expect(result.error?.message).toContain(CODEX_KEYRING_SIGN_IN_REQUIRED);
    expect(methods(sources[0])).not.toContain('getAuthStatus');
  });

  it('asks for a sign-in without starting Codex when the machine has no Codex home', async () => {
    await rm(sourceHome, { recursive: true });
    const result = await start();
    expect(result.error?.message).toContain(CODEX_KEYRING_SIGN_IN_REQUIRED);
    expect(sources).toHaveLength(0);
  });

  it('says so when this Codex no longer exports its login', async () => {
    source.authStatus = { error: { code: -32601, message: 'method not found' } };
    const result = await start();
    expect(result.error?.message).toContain('no longer answers getAuthStatus');
    expect(methods(sessions[0])).not.toContain('account/login/start');
  });

  it('fails when Codex does not take the key, without repeating it', async () => {
    session.afterLogin = null;
    const result = await start();
    expect(result.error?.message).toContain('did not take the API key');
    expect(methods(sessions[0])).not.toContain('thread/start');
    expectNoLeak(result);
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

describe('keyringBusEnvironment', () => {
  it('passes on only what reaches the session bus', () => {
    expect(
      keyringBusEnvironment({
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XDG_RUNTIME_DIR: '/run/user/1000',
        OPENAI_API_KEY: 'unrelated',
        HOME: '/home/user',
      })
    ).toEqual({
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
    expect(keyringBusEnvironment({ HOME: '/home/user' })).toEqual({});
  });
});
