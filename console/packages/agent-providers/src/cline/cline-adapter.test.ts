import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerSpec } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

const servers: FakeAppServer[] = [];
let lastSpawnOptions:
  | {
      command: string;
      args: string[];
      options?: { env?: Record<string, string>; [key: string]: unknown };
    }
  | undefined;
let nextInitError: string | undefined;
let nextSessionNewError: string | undefined;

const spawnSpy = vi.fn(
  (
    command: string,
    args: string[],
    options?: { env?: Record<string, string>; [key: string]: unknown }
  ) => {
    lastSpawnOptions = { command, args, options };
    const server = new FakeAppServer();
    if (nextInitError) {
      const err = nextInitError;
      server.on('message', (m) => {
        if (m.method === 'initialize' && m.id !== undefined) {
          server.send({ id: m.id, error: { code: -32603, message: err } });
        }
      });
    } else {
      server.replyAlways('initialize', () => ({ agentCapabilities: {} }));
    }

    if (nextSessionNewError) {
      const err = nextSessionNewError;
      server.on('message', (m) => {
        if (m.method === 'session/new' && m.id !== undefined) {
          server.send({ id: m.id, error: { code: -32603, message: err } });
        }
      });
    } else {
      server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    }

    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  }
);

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options?: Record<string, unknown>) =>
    spawnSpy(command, args, options),
}));

const { clineAcp, createClineAdapter } = await import('./cline-acp');

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  servers.length = 0;
  spawnSpy.mockClear();
  lastSpawnOptions = undefined;
  nextInitError = undefined;
  nextSessionNewError = undefined;
});

afterEach(() => {
  for (const server of servers) server.kill();
});

describe('cline provider hooks and adapter', () => {
  it('launches with binary path, exact --acp arg, env pass-through, settings path, and backend mode', async () => {
    const binaryPath = '/custom/bin/cline';
    const inputEnv = { CUSTOM_KEY: 'custom_val', FOO: 'bar' };
    const launch = await clineAcp.launch({
      binaryPath,
      cwd: '/work',
      env: inputEnv,
      mcpServers: {},
    });
    try {
      expect(launch.command).toBe(binaryPath);
      expect(launch.args).toEqual(['--acp']);
      expect(launch.mcpServersInLaunch).toBe(true);
      expect(launch.env).toMatchObject({
        CUSTOM_KEY: 'custom_val',
        FOO: 'bar',
        CLINE_SESSION_BACKEND_MODE: 'local',
      });
      expect(typeof launch.env.CLINE_MCP_SETTINGS_PATH).toBe('string');
      expect(isAbsolute(launch.env.CLINE_MCP_SETTINGS_PATH)).toBe(true);
      expect(basename(launch.env.CLINE_MCP_SETTINGS_PATH)).toBe('cline_mcp_settings.json');
    } finally {
      await launch.release?.();
    }
  });

  it('formats HTTP and stdio MCP servers in settings file, leaving out missing envVars, and formats empty servers as {}', async () => {
    const inputEnv = { PRESENT_VAR: 'present_val', EXTRA_VAR: 'extra' };
    const mcpServers: Record<string, McpServerSpec> = {
      http_srv: {
        transport: 'http',
        url: 'https://mcp.example.com/api',
        headers: { Authorization: 'Bearer my-token' },
      },
      stdio_srv: {
        transport: 'stdio',
        command: 'node',
        args: ['tool.js'],
        envVars: ['PRESENT_VAR', 'ABSENT_VAR'],
        env: { STATIC_VAR: 'static_val' },
      },
    };
    const launch = await clineAcp.launch({
      binaryPath: 'cline',
      cwd: '/work',
      env: inputEnv,
      mcpServers,
    });
    try {
      const raw = await readFile(launch.env.CLINE_MCP_SETTINGS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({
        mcpServers: {
          http_srv: {
            type: 'streamableHttp',
            url: 'https://mcp.example.com/api',
            headers: { Authorization: 'Bearer my-token' },
            disabled: false,
            autoApprove: [],
          },
          stdio_srv: {
            command: 'node',
            args: ['tool.js'],
            env: {
              PRESENT_VAR: 'present_val',
              STATIC_VAR: 'static_val',
            },
            disabled: false,
            autoApprove: [],
          },
        },
      });
    } finally {
      await launch.release?.();
    }

    const emptyLaunch = await clineAcp.launch({
      binaryPath: 'cline',
      cwd: '/work',
      env: inputEnv,
      mcpServers: {},
    });
    try {
      const raw = await readFile(emptyLaunch.env.CLINE_MCP_SETTINGS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({ mcpServers: {} });
    } finally {
      await emptyLaunch.release?.();
    }
  });

  it('sets file mode 0600 and folder mode 0700 (non-win32), and leaks no tokens or headers in command, args, or env', async () => {
    const secretToken = 'secret-token-value-999';
    const secretHeader = 'Bearer secret-auth-header-888';
    const launch = await clineAcp.launch({
      binaryPath: 'cline',
      cwd: '/work',
      env: { NORMAL_ENV: 'normal' },
      mcpServers: {
        secure_srv: {
          transport: 'http',
          url: 'https://secure.example.com',
          headers: {
            Authorization: secretHeader,
            'X-Secret': secretToken,
          },
        },
      },
    });
    try {
      if (process.platform !== 'win32') {
        const fileStat = await stat(launch.env.CLINE_MCP_SETTINGS_PATH);
        expect(fileStat.mode & 0o777).toBe(0o600);
        const dirStat = await stat(dirname(launch.env.CLINE_MCP_SETTINGS_PATH));
        expect(dirStat.mode & 0o777).toBe(0o700);
      }

      expect(launch.command).not.toContain(secretToken);
      expect(launch.command).not.toContain(secretHeader);
      for (const arg of launch.args) {
        expect(arg).not.toContain(secretToken);
        expect(arg).not.toContain(secretHeader);
      }
      for (const [key, value] of Object.entries(launch.env)) {
        if (key === 'CLINE_MCP_SETTINGS_PATH') continue;
        expect(value).not.toContain(secretToken);
        expect(value).not.toContain(secretHeader);
      }

      const content = await readFile(launch.env.CLINE_MCP_SETTINGS_PATH, 'utf8');
      expect(content).toContain(secretToken);
      expect(content).toContain(secretHeader);
    } finally {
      await launch.release?.();
    }
  });

  it('removes the temporary folder on release, and calling release twice does not throw', async () => {
    const launch = await clineAcp.launch({
      binaryPath: 'cline',
      cwd: '/work',
      env: {},
      mcpServers: {},
    });
    const dir = dirname(launch.env.CLINE_MCP_SETTINGS_PATH);
    const existsBefore = await stat(dir).then(
      () => true,
      () => false
    );
    expect(existsBefore).toBe(true);

    await launch.release?.();
    const existsAfter = await stat(dir).then(
      () => true,
      () => false
    );
    expect(existsAfter).toBe(false);

    await expect(launch.release?.()).resolves.not.toThrow();
  });

  it('checks sign-in via providers.json without spawning a process', async () => {
    spawnSpy.mockClear();
    const tempHome = await mkdtemp(join(tmpdir(), 'switch-cline-test-home-'));
    const settingsDir = join(tempHome, '.cline', 'data', 'settings');
    const providersPath = join(settingsDir, 'providers.json');

    const handshake = vi.fn();

    try {
      // 1. No providers.json
      const noFile = await clineAcp.checkSignIn?.({
        binaryPath: 'cline',
        cwd: tempHome,
        env: { HOME: tempHome },
        handshake,
      });
      expect(noFile?.status).toBe('unauthenticated');
      expect(noFile?.message).toContain('cline auth');

      // 2. Empty providers.json
      await mkdir(settingsDir, { recursive: true });
      await writeFile(providersPath, '');
      const emptyFile = await clineAcp.checkSignIn?.({
        binaryPath: 'cline',
        cwd: tempHome,
        env: { HOME: tempHome },
        handshake,
      });
      expect(emptyFile?.status).toBe('unauthenticated');
      expect(emptyFile?.message).toContain('cline auth');

      // 3. Non-empty providers.json
      await writeFile(providersPath, JSON.stringify({ provider: 'anthropic' }));
      const nonEmptyFile = await clineAcp.checkSignIn?.({
        binaryPath: 'cline',
        cwd: tempHome,
        env: { HOME: tempHome },
        handshake,
      });
      expect(nonEmptyFile?.status).toBe('authenticated');

      // 4. No HOME and no USERPROFILE
      const noHome = await clineAcp.checkSignIn?.({
        binaryPath: 'cline',
        cwd: tempHome,
        env: {},
        handshake,
      });
      expect(noHome?.status).toBe('unauthenticated');
      expect(noHome?.message).toContain('cline auth');

      expect(handshake).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('returns act for all runtime modes, leaves authMethodId undefined, and sets loginCommand to cline auth', () => {
    for (const mode of ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const) {
      expect(clineAcp.sessionMode?.(mode)).toBe('act');
    }
    expect(clineAcp.authMethodId).toBeUndefined();
    expect(clineAcp.loginCommand).toBe('cline auth');
  });

  it('starts session through adapter with an HTTP MCP server and no agent mcpCapabilities', async () => {
    const tempWork = await mkdtemp(join(tmpdir(), 'switch-cline-work-'));
    try {
      const adapter = createClineAdapter();
      const events: ProviderRuntimeEvent[] = [];
      adapter.subscribe((e) => events.push(e));

      const session = await adapter.startSession({
        sessionId: 's',
        cwd: tempWork,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {
          probe: {
            transport: 'http',
            url: 'http://127.0.0.1:1234/mcp',
            headers: { Authorization: 'Bearer token' },
          },
        },
        connectorMcpServers: [],
      });

      expect(session).toEqual({
        provider: 'cline',
        sessionId: 's',
        nativeSessionId: 'native',
      });

      const server = servers.at(-1)!;
      const sessionNew = server.received.find((m) => m.method === 'session/new');
      expect(sessionNew?.params).toMatchObject({ mcpServers: [] });
      expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);

      await adapter.stopSession('s');
    } finally {
      await rm(tempWork, { recursive: true, force: true });
    }
  });

  it('calls release and removes the temporary folder when the process exits (server.kill())', async () => {
    const tempWork = await mkdtemp(join(tmpdir(), 'switch-cline-work-'));
    try {
      const adapter = createClineAdapter();
      await adapter.startSession({
        sessionId: 's-kill',
        cwd: tempWork,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
        connectorMcpServers: [],
      });
      const server = servers.at(-1)!;
      const settingsPath = lastSpawnOptions?.options?.env?.CLINE_MCP_SETTINGS_PATH as string;
      expect(settingsPath).toBeDefined();
      const settingsDir = dirname(settingsPath);
      expect(
        await stat(settingsDir).then(
          () => true,
          () => false
        )
      ).toBe(true);

      server.kill();
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(
        await stat(settingsDir).then(
          () => true,
          () => false
        )
      ).toBe(false);
    } finally {
      await rm(tempWork, { recursive: true, force: true });
    }
  });

  it('calls release and removes the temporary folder when initialize fails', async () => {
    nextInitError = 'Init exploded';
    const tempWork = await mkdtemp(join(tmpdir(), 'switch-cline-work-'));
    try {
      const adapter = createClineAdapter();
      await expect(
        adapter.startSession({
          sessionId: 's-init-fail',
          cwd: tempWork,
          runtimeMode: 'approval-required',
          env: {},
          mcpServers: {},
          connectorMcpServers: [],
        })
      ).rejects.toThrow();

      await flush();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const settingsPath = lastSpawnOptions?.options?.env?.CLINE_MCP_SETTINGS_PATH as string;
      expect(settingsPath).toBeDefined();
      const settingsDir = dirname(settingsPath);
      expect(
        await stat(settingsDir).then(
          () => true,
          () => false
        )
      ).toBe(false);
    } finally {
      await rm(tempWork, { recursive: true, force: true });
    }
  });

  it('calls release and removes the temporary folder when session/new fails', async () => {
    nextSessionNewError = 'Session/new exploded';
    const tempWork = await mkdtemp(join(tmpdir(), 'switch-cline-work-'));
    try {
      const adapter = createClineAdapter();
      await expect(
        adapter.startSession({
          sessionId: 's-new-fail',
          cwd: tempWork,
          runtimeMode: 'approval-required',
          env: {},
          mcpServers: {},
          connectorMcpServers: [],
        })
      ).rejects.toThrow();

      await flush();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const settingsPath = lastSpawnOptions?.options?.env?.CLINE_MCP_SETTINGS_PATH as string;
      expect(settingsPath).toBeDefined();
      const settingsDir = dirname(settingsPath);
      expect(
        await stat(settingsDir).then(
          () => true,
          () => false
        )
      ).toBe(false);
    } finally {
      await rm(tempWork, { recursive: true, force: true });
    }
  });
});
