import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpToolCall } from '../acp/protocol';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import * as providerProcess from '../provider-process';
import { readiness, signInWith } from '../readiness';
import {
  createDroidAdapter,
  droidAcp,
  droidHome,
  hasFactoryAuth,
  DROID_LOGIN,
} from './droid-adapter';

const servers: FakeAppServer[] = [];

vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
      },
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({
      sessionId: 'native-droid-session',
    }));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/prompt', () => ({ stopReason: 'end_turn' }));
    servers.push(server);
    return server;
  },
}));

// Real fixture captured from droid 1.5.0 online doctor run
const DOCTOR_SIGNED_OUT_ONLINE = JSON.stringify({
  generatedAt: '2026-11-06T15:06:21.610Z',
  timeoutMs: 10000,
  ok: true,
  results: [
    {
      id: 'env.info',
      category: 'environment',
      label: 'Droid environment',
      status: 'pass',
      detail: 'v1.5.0 on linux x64 (bun 1.4.4)',
    },
    {
      id: 'auth.credentials',
      category: 'auth',
      label: 'Credential storage read',
      status: 'pass',
      detail: 'credential storage responded; no stored login found',
    },
    {
      id: 'auth.workosRefresh',
      category: 'auth',
      label: 'WorkOS token refresh endpoint',
      status: 'pass',
      detail: 'POST api.workos.com/authenticate answered HTTP 400',
    },
    {
      id: 'auth.verify',
      category: 'auth',
      label: 'Auth verification',
      status: 'warn',
      detail: 'no usable credentials found (not logged in)',
      remediation: 'Run `droid` and complete the login flow.',
    },
  ],
});

// Real fixture captured from droid 1.5.0 offline doctor run (exit 1 with stdout)
const DOCTOR_SIGNED_OUT_OFFLINE = JSON.stringify({
  generatedAt: '2026-11-06T15:24:38.973Z',
  timeoutMs: 1500,
  ok: false,
  results: [
    {
      id: 'env.info',
      category: 'environment',
      label: 'Droid environment',
      status: 'pass',
      detail: 'v1.5.0 on linux x64 (bun 1.4.4)',
    },
    {
      id: 'auth.credentials',
      category: 'auth',
      label: 'Credential storage read',
      status: 'pass',
      detail: 'credential storage responded; no stored login found',
    },
    {
      id: 'auth.workosRefresh',
      category: 'auth',
      label: 'WorkOS token refresh endpoint',
      status: 'fail',
      detail: 'ECONNREFUSED: Unable to connect. (ECONNREFUSED)',
    },
    {
      id: 'auth.verify',
      category: 'auth',
      label: 'Auth verification',
      status: 'warn',
      detail: 'no usable credentials found (not logged in)',
      remediation: 'Run `droid` and complete the login flow.',
    },
  ],
});

// Real fixture captured from droid 1.5.0 authenticated doctor run
const DOCTOR_SIGNED_IN = JSON.stringify({
  generatedAt: '2026-11-06T16:11:55.745Z',
  timeoutMs: 10000,
  ok: true,
  results: [
    {
      id: 'auth.credentials',
      category: 'auth',
      label: 'Credential storage read',
      status: 'pass',
      detail: 'stored login session loaded from credential storage',
    },
    {
      id: 'auth.verify',
      category: 'auth',
      label: 'Auth verification',
      status: 'pass',
      detail: 'authenticated as developer@example.com via stored login session',
    },
  ],
});

describe('droidHome and hasFactoryAuth', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'droid-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves droidHome respecting FACTORY_HOME_OVERRIDE then HOME', () => {
    expect(droidHome({ FACTORY_HOME_OVERRIDE: tempDir })).toBe(join(tempDir, '.factory'));
    expect(droidHome({ FACTORY_HOME_OVERRIDE: '   ', HOME: tempDir })).toBe(
      join(tempDir, '.factory')
    );
    expect(droidHome({ USERPROFILE: tempDir })).toBe(join(tempDir, '.factory'));
  });

  it('detects credentials when auth.v2.keyring has non-zero size', async () => {
    const factoryDir = join(tempDir, '.factory');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(factoryDir, { recursive: true });
    await writeFile(join(factoryDir, 'auth.v2.keyring'), 'encrypted-keyring-data');

    expect(hasFactoryAuth({ FACTORY_HOME_OVERRIDE: tempDir })).toBe(true);
  });

  it('detects credentials when auth.v2.loginkeychain or auth.v2.file has non-zero size', async () => {
    const factoryDir = join(tempDir, '.factory');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(factoryDir, { recursive: true });

    await writeFile(join(factoryDir, 'auth.v2.loginkeychain'), 'keychain-data');
    expect(hasFactoryAuth({ FACTORY_HOME_OVERRIDE: tempDir })).toBe(true);
    await rm(join(factoryDir, 'auth.v2.loginkeychain'));

    await writeFile(join(factoryDir, 'auth.v2.file'), 'plain-token');
    expect(hasFactoryAuth({ FACTORY_HOME_OVERRIDE: tempDir })).toBe(true);
  });

  it('returns false when auth file is empty (0 bytes) or directory does not exist', async () => {
    const factoryDir = join(tempDir, '.factory');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(factoryDir, { recursive: true });
    await writeFile(join(factoryDir, 'auth.v2.keyring'), '');

    expect(hasFactoryAuth({ FACTORY_HOME_OVERRIDE: tempDir })).toBe(false);
    expect(hasFactoryAuth({ FACTORY_HOME_OVERRIDE: join(tempDir, 'nonexistent') })).toBe(false);
  });
});

describe('droidAcp hooks', () => {
  it('configures launch command, loginCommand, and capabilities correctly', () => {
    expect(droidAcp.provider).toBe('droid');
    expect(droidAcp.label).toBe('Factory Droid');
    expect(droidAcp.loginCommand).toBe(DROID_LOGIN);
    expect(droidAcp.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
    expect(droidAcp.inheritEnv).toEqual([
      'FACTORY_API_KEY',
      'FACTORY_HOME_OVERRIDE',
      'FACTORY_APPEND_SYSTEM_PROMPT',
      'DBUS_SESSION_BUS_ADDRESS',
      'XDG_RUNTIME_DIR',
    ]);

    const launched = droidAcp.launch({
      binaryPath: '/custom/droid',
      cwd: '/tmp',
      env: { TEST: '1' },
    });
    expect(launched).toEqual({
      command: '/custom/droid',
      args: ['exec', '--output-format', 'acp'],
      env: { TEST: '1' },
    });
  });

  it('maps runtimeMode to Droid ACP autonomy modes', () => {
    expect(droidAcp.sessionMode!('full-access', undefined)).toBe('auto-high');
    expect(droidAcp.sessionMode!('auto', undefined)).toBe('auto-medium');
    expect(droidAcp.sessionMode!('auto-accept-edits', undefined)).toBe('auto-low');
    expect(droidAcp.sessionMode!('approval-required', undefined)).toBe('normal');
  });

  it('provides non-blocking authMethodId', () => {
    expect(droidAcp.authMethodId?.({ FACTORY_API_KEY: 'test-key' }, 'droid')).toBe(
      'factory-api-key'
    );
    expect(droidAcp.authMethodId?.({ FACTORY_API_KEY: '   ' }, 'droid')).toBeUndefined();
    expect(droidAcp.authMethodId?.({}, 'droid')).toBeUndefined();
  });

  it('extracts MCP server attribution from _meta.factory.server or name prefix', () => {
    const withMeta: AcpToolCall = {
      toolCallId: 'tc-1',
      title: 'echo: Switch echo',
      kind: 'other',
      _meta: { factory: { source: 'mcp', server: 'echo', tool: 'switch_echo' } },
    };
    expect(droidAcp.mcpServerOf?.(withMeta, new Set())).toBe('echo');

    const withPrefix: AcpToolCall = {
      toolCallId: 'tc-2',
      title: 'github___search_issues',
      kind: 'other',
    };
    expect(droidAcp.mcpServerOf?.(withPrefix, new Set())).toBe('github');

    const underscoredServer: AcpToolCall = {
      toolCallId: 'tc-2b',
      title: 'switch_connector___post_message',
      kind: 'other',
    };
    expect(droidAcp.mcpServerOf?.(underscoredServer, new Set())).toBe('switch_connector');

    const unmapped: AcpToolCall = {
      toolCallId: 'tc-3',
      title: 'execute',
      kind: 'execute',
    };
    expect(droidAcp.mcpServerOf?.(unmapped, new Set())).toBeUndefined();
  });
});

describe('checkSignIn', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'droid-check-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const dummyHandshake = async () => ({ protocolVersion: 1 });
  const dummyRequest = async <T>() => ({}) as T;
  const checkInput = (env: Record<string, string>) => ({
    binaryPath: 'droid',
    cwd: '/tmp',
    env,
    handshake: dummyHandshake,
    request: dummyRequest,
  });

  const doctorSays = (stdout: string) =>
    vi.spyOn(providerProcess, 'execProvider').mockResolvedValue({ stdout, stderr: '' });

  const writeAuthFile = async () => {
    const factoryDir = join(tempDir, '.factory');
    await mkdir(factoryDir, { recursive: true });
    await writeFile(join(factoryDir, 'auth.v2.keyring'), 'mock-keyring');
  };

  it('returns authenticated when droid doctor passes', async () => {
    doctorSays(DOCTOR_SIGNED_IN);
    const res = await droidAcp.checkSignIn!(checkInput({ FACTORY_HOME_OVERRIDE: tempDir }));
    expect(res).toEqual(readiness('authenticated', 'Signed in to Factory Droid.'));
  });

  it('verifies a Factory API key with droid doctor rather than trusting it', async () => {
    const exec = doctorSays(DOCTOR_SIGNED_OUT_ONLINE);
    const res = await droidAcp.checkSignIn!(
      checkInput({ FACTORY_API_KEY: 'sk-revoked', FACTORY_HOME_OVERRIDE: tempDir })
    );
    expect(exec).toHaveBeenCalled();
    expect(res).toEqual(readiness('unauthenticated', signInWith(DROID_LOGIN)));
  });

  it('verifies a stored login with droid doctor rather than trusting the file', async () => {
    await writeAuthFile();
    doctorSays(DOCTOR_SIGNED_OUT_ONLINE);
    const res = await droidAcp.checkSignIn!(checkInput({ FACTORY_HOME_OVERRIDE: tempDir }));
    expect(res).toEqual(readiness('unauthenticated', signInWith(DROID_LOGIN)));
  });

  it('returns unauthenticated when doctor reports not logged in (exit 0)', async () => {
    doctorSays(DOCTOR_SIGNED_OUT_ONLINE);
    const res = await droidAcp.checkSignIn!(checkInput({ FACTORY_HOME_OVERRIDE: tempDir }));
    expect(res).toEqual(readiness('unauthenticated', signInWith(DROID_LOGIN)));
  });

  it('returns unauthenticated when doctor exits 1 offline but outputs valid diagnostic JSON', async () => {
    const err = Object.assign(new Error('Command failed'), {
      code: 1,
      stdout: DOCTOR_SIGNED_OUT_OFFLINE,
      stderr: '',
    });
    vi.spyOn(providerProcess, 'execProvider').mockRejectedValue(err);

    const res = await droidAcp.checkSignIn!(checkInput({ FACTORY_HOME_OVERRIDE: tempDir }));
    expect(res).toEqual(readiness('unauthenticated', signInWith(DROID_LOGIN)));
  });

  it('says a credential was found but not verified when doctor fails', async () => {
    vi.spyOn(providerProcess, 'execProvider').mockRejectedValue(new Error('ETIMEDOUT'));
    const res = await droidAcp.checkSignIn!(
      checkInput({ FACTORY_API_KEY: 'sk-test', FACTORY_HOME_OVERRIDE: tempDir })
    );
    expect(res).toEqual(
      readiness('unknown', 'A Factory API key was given, but droid doctor failed: ETIMEDOUT')
    );
  });

  it('names the stored login when doctor cannot verify it', async () => {
    await writeAuthFile();
    vi.spyOn(providerProcess, 'execProvider').mockRejectedValue(new Error('ETIMEDOUT'));
    const res = await droidAcp.checkSignIn!(checkInput({ FACTORY_HOME_OVERRIDE: tempDir }));
    expect(res).toEqual(
      readiness(
        'unknown',
        'Factory Droid credentials were found, but droid doctor failed: ETIMEDOUT'
      )
    );
  });

  it('reports output that is not JSON', async () => {
    doctorSays('Segmentation fault');
    const res = await droidAcp.checkSignIn!(checkInput({ FACTORY_HOME_OVERRIDE: tempDir }));
    expect(res.status).toBe('unknown');
    expect(res.message).toMatch(
      /^No Factory Droid credentials were found, but droid doctor's output is not JSON \(/
    );
  });

  it('reports a report without the auth.verify check', async () => {
    doctorSays(JSON.stringify({ results: [] }));
    const res = await droidAcp.checkSignIn!(checkInput({ FACTORY_HOME_OVERRIDE: tempDir }));
    expect(res).toEqual(
      readiness(
        'unknown',
        "No Factory Droid credentials were found, but droid doctor's report has no auth.verify check"
      )
    );
  });

  it('surfaces an auth check failure in wording it does not recognise', async () => {
    doctorSays(
      JSON.stringify({
        results: [{ id: 'auth.verify', status: 'fail', detail: 'session expired' }],
      })
    );
    const res = await droidAcp.checkSignIn!(checkInput({ FACTORY_HOME_OVERRIDE: tempDir }));
    expect(res).toEqual(
      readiness(
        'unknown',
        "No Factory Droid credentials were found, but droid doctor's auth check reported fail: session expired"
      )
    );
  });
});

describe('createDroidAdapter ACP session flow', () => {
  beforeEach(() => {
    servers.length = 0;
  });

  afterEach(() => {
    for (const server of servers) server.kill();
    vi.restoreAllMocks();
  });

  it('starts session in normal mode and auto-approves registered MCP server calls', async () => {
    const adapter = createDroidAdapter();
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((e) => events.push(e));

    const session = await adapter.startSession({
      sessionId: 'test-s1',
      cwd: tmpdir(),
      runtimeMode: 'approval-required',
      env: { FACTORY_API_KEY: 'test-key' },
      mcpServers: {
        echo: { transport: 'stdio', command: 'node', args: ['echo.js'] },
      },
      connectorMcpServers: [],
    });

    expect(session.sessionId).toBe('test-s1');
    expect(session.nativeSessionId).toBe('native-droid-session');

    const server = servers[0]!;
    // Verify set_mode received normal for approval-required
    expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toMatchObject({
      sessionId: 'native-droid-session',
      modeId: 'normal',
    });

    // Send a turn
    await adapter.sendTurn({ sessionId: 'test-s1', turnId: 't1', text: 'call echo tool' });

    // Simulate Droid sending session/request_permission for registered MCP tool
    server.send({
      id: 99,
      method: 'session/request_permission',
      params: {
        sessionId: 'native-droid-session',
        toolCall: {
          toolCallId: 'tc-call',
          title: 'echo: Switch echo',
          kind: 'other',
          _meta: { factory: { source: 'mcp', server: 'echo', tool: 'switch_echo' } },
        },
        options: [{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' }],
      },
    });

    await new Promise((resolve) => setImmediate(resolve));

    // Must be auto-approved because echo was registered in the session
    expect(server.received.find((m) => m.id === 99)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    });
    expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  });
});
