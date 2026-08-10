import { pluginRegistry } from '@switchdash/plugins/agents';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSystemError, FileSystemErrorCodes } from '@main/core/fs/types';
import type { Pty, PtyExitInfo } from '@main/core/pty/pty';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { agentSessionExitedChannel } from '@shared/core/providers/agentEvents';
import { makeAgentPtySessionId } from '@shared/core/pty/ptySessionId';
import type { Session } from '@shared/core/sessions/sessions';
import { SWITCH_RUNTIME_REQUIRED_ENV } from '@shared/core/switch-rooms/switch-agent-runtime';
import { SidecarHttpStatusError } from './sidecar-http';
import { sidecarRelayRegistry } from './sidecar-relay-registry';
import { SshAgentRuntime } from './ssh-agent-runtime';

const openSsh2Pty = vi.hoisted(() => vi.fn());
const buildCommandMock = vi.hoisted(() =>
  vi.fn((_ctx: Record<string, unknown>) => ({
    command: 'agent',
    args: [] as string[],
    env: {} as Record<string, string>,
  }))
);
/** A provider with no `mcp` behavior — it resolves MCP servers from config. */
const defaultGetPlugin = vi.hoisted(() => (id: string) => ({
  metadata: { id },
  capabilities: { hostDependency: { binaryNames: [id] }, hooks: { kind: 'none' } },
  behavior: { prompt: { buildCommand: buildCommandMock } },
}));
const resolveSshCommand = vi.hoisted(() => vi.fn(() => 'remote-cmd'));
const deployAndLaunch = vi.hoisted(() => vi.fn(async () => ({ port: 9999, token: 'sidecar-tok' })));
const sidecarStop = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('./resolve-sidecar-bundle', () => ({
  resolveSidecarBundlePath: vi.fn(() => '/local/dist-sidecar/sidecar.mjs'),
}));

vi.mock('@main/core/agents/reap-stale-sidecars', () => ({
  reapStaleSidecarsForAgent: vi.fn(async () => {}),
}));

vi.mock('./remote-sidecar-launcher', () => ({
  RemoteSidecarLauncher: vi.fn(function () {
    return { deployAndLaunch, stop: sidecarStop };
  }),
  reapOrphanedSidecars: vi.fn(async () => {}),
  agentSidecarTmuxName: vi.fn(() => 'switchdash-sidecar-test'),
}));

const httpPostJsonOverChannel = vi.hoisted(() => vi.fn(async () => {}));
const httpPostForJsonOverChannel = vi.hoisted(() =>
  vi.fn(async () => ({ connectionId: 'conn-remote-1' }))
);

// POST is spied so disconnect and the connection hand-off can be asserted; GET
// is parked so the hook-event relay's poll loop doesn't spin in tests that
// don't exercise relaying. The real status error is kept: the runtime narrows
// on it to tell an out-of-date sidecar from an unreachable one.
vi.mock('./sidecar-http', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('./sidecar-http')),
  httpPostJsonOverChannel,
  httpPostForJsonOverChannel,
  httpGetJsonOverChannel: vi.fn(() => new Promise(() => {})),
}));

vi.mock('@main/core/pty/ssh2-pty', () => ({ openSsh2Pty }));

vi.mock('@main/core/pty/spawn-utils', () => ({ resolveSshCommand }));

const remoteNpmRegistryAuthEnv = vi.hoisted(() =>
  vi.fn(async () => ({
    npm_config_userconfig: '/repo/.switchdash/npmrc',
    SWITCHDASH_GITHUB_TOKEN: 'remote-tok',
  }))
);

vi.mock('@main/core/switch-rooms/npm-registry-auth', () => ({ remoteNpmRegistryAuthEnv }));

vi.mock('@main/core/pty/terminal-color-scheme', () => ({
  getTerminalColorEnv: vi.fn(async () => ({})),
}));

vi.mock('@main/core/dependencies/host-dependency-store', () => ({
  hostDependencyStore: {
    getSelection: vi.fn().mockResolvedValue(null),
    setSelection: vi.fn().mockResolvedValue(undefined),
  },
}));

// Stubbed so importing the runtime doesn't pull in the DB client (no Electron
// `app` in tests). launchSidecar reads the agent's autoApprove for the spec.
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: vi.fn(async () => ({ autoApprove: false })),
}));

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: vi.fn(defaultGetPlugin),
}));

vi.mock('./keystroke-injection', () => ({
  scheduleInitialPromptInjection: vi.fn(),
}));

vi.mock('@main/lib/events', () => ({
  events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
}));

vi.mock('@main/core/settings/provider-settings-service', () => ({
  providerOverrideSettings: { getItem: vi.fn(async () => undefined) },
}));

vi.mock('./resolve-agent-executable', () => ({
  resolveAgentExecutable: vi.fn(async ({ binaryName }: { binaryName: string }) => binaryName),
  clearResolvedPathCache: vi.fn(),
}));

const handleRawHook = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: { handleRawHook },
}));

const connectionListeners = vi.hoisted(
  () => [] as Array<(evt: { type: string; connectionId: string }) => void>
);

vi.mock('@main/core/ssh/lifecycle/production-ssh-connection-manager', () => ({
  sshConnectionManager: {
    on: vi.fn((_event: string, cb: (evt: { type: string; connectionId: string }) => void) => {
      connectionListeners.push(cb);
    }),
    off: vi.fn((_event: string, cb: (evt: { type: string; connectionId: string }) => void) => {
      const idx = connectionListeners.indexOf(cb);
      if (idx >= 0) connectionListeners.splice(idx, 1);
    }),
  },
}));

function emitReconnected(connectionId: string): void {
  for (const cb of [...connectionListeners]) cb({ type: 'reconnected', connectionId });
}

const { events } = await import('@main/lib/events');
const { getAgentById } = await import('@main/core/agents/getAgentById');
const { getPlugin } = await import('@main/core/providers/plugin-registry');

type ProviderState = {
  known: boolean;
  pty: Pty | null;
};

function makeProxy(overrides: Partial<SshClientProxy> = {}): SshClientProxy {
  return {
    connectionId: 'ssh-1',
    getRemoteShellProfile: vi.fn(async () => ({ shell: '/bin/bash', env: {} })),
    refreshRemoteShellProfile: vi.fn(async () => ({ shell: '/bin/bash', env: {} })),
    // A channel opens, but the mocked GET on it never resolves — which parks the
    // hook-event relay's poll loop so it does not spin in tests that don't
    // exercise event relaying, while still letting the connection hand-off (a
    // POST) complete.
    forwardOut: vi.fn(async () => ({ destroy: vi.fn() }) as never),
    ...overrides,
  } as unknown as SshClientProxy;
}

/** A remote host with an empty home: the home-rooted read probe answers `0`
 *  ("no such file") and every other command exits quietly. */
function makeCtx(): ConstructorParameters<typeof SshAgentRuntime>[0]['ctx'] {
  return { exec: vi.fn(async () => ({ stdout: '0', stderr: '' })) } as never;
}

/** A remote filesystem holding `files` (keyed by repo-relative path); anything
 *  else reads as NOT_FOUND, matching SshFileSystem. */
function makeRemoteFs(files: Record<string, string> = {}) {
  return {
    copyLocalFile: vi.fn(async () => {}),
    read: vi.fn(async (relPath: string) => {
      const content = files[relPath];
      if (content === undefined) {
        throw new FileSystemError(`no such file: ${relPath}`, FileSystemErrorCodes.NOT_FOUND);
      }
      return { content };
    }),
  } as never;
}

function sshProvider({
  proxy = makeProxy(),
  tmux = false,
  ctx = makeCtx(),
  fs = makeRemoteFs(),
}: {
  proxy?: SshClientProxy;
  tmux?: boolean;
  ctx?: ConstructorParameters<typeof SshAgentRuntime>[0]['ctx'];
  fs?: ConstructorParameters<typeof SshAgentRuntime>[0]['fs'];
} = {}) {
  return new SshAgentRuntime({
    locationId: 'location-1',
    sessionId: 'session-1',
    sessionPath: '/repo',
    tmux,
    ctx,
    fs,
    proxy,
    connectionId: 'ssh-1',
  });
}

function session(): Session {
  const now = '2024-01-01T00:00:00.000Z';
  return {
    id: 'session-1',
    agentId: 'agent-1',
    agentName: 'codex-hoot',
    providerId: 'codex',
    title: 'Session 1',
    shellId: 'system',
    status: 'in_progress',
    statusChangedAt: now,
    agentSessionId: null,
    providerSessionId: 'provider-session-1',
    isInitialSession: false,
    isPinned: false,
    createdAt: now,
    updatedAt: now,
  };
}

function fakePty(exitHandlers: Array<(info: PtyExitInfo) => void>): Pty {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((handler) => exitHandlers.push(handler)),
  } as unknown as Pty;
}

function mockSpawn(exitHandlers: Array<Array<(info: PtyExitInfo) => void>>): void {
  openSsh2Pty.mockImplementation(async () => {
    const handlers: Array<(info: PtyExitInfo) => void> = [];
    exitHandlers.push(handlers);
    return { success: true, data: fakePty(handlers) };
  });
}

describe('SshAgentRuntime', () => {
  beforeEach(() => {
    vi.useRealTimers();
    openSsh2Pty.mockReset();
    buildCommandMock.mockReset();
    buildCommandMock.mockReturnValue({ command: 'agent', args: [], env: {} });
    vi.mocked(getPlugin).mockImplementation(defaultGetPlugin as never);
    resolveSshCommand.mockClear();
    deployAndLaunch.mockClear();
    remoteNpmRegistryAuthEnv.mockClear();
    sidecarStop.mockClear();
    httpPostJsonOverChannel.mockClear();
    httpPostForJsonOverChannel.mockReset();
    httpPostForJsonOverChannel.mockResolvedValue({ connectionId: 'conn-remote-1' });
    vi.mocked(events.emit).mockClear();
    connectionListeners.length = 0;
    // The relay registry is a module singleton keyed by host+dir+agent, so a
    // relay acquired by one test would otherwise be reused by the next and its
    // fresh proxy never polled.
    sidecarRelayRegistry.stopAll();
    ptySessionRegistry.unregister('location-1:session-1');
  });

  it('spawns the agent over SSH and registers a remote pty', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const item = session();
    const sessionId = makeAgentPtySessionId('location-1', item.id);

    await sshProvider().start(item);

    expect(openSsh2Pty).toHaveBeenCalledTimes(1);
    expect(resolveSshCommand).toHaveBeenCalledWith(
      'agent',
      expect.objectContaining({ cwd: '/repo', sessionId: 'session-1' }),
      expect.anything(),
      expect.anything()
    );
    expect(ptySessionRegistry.get(sessionId)).toBeDefined();
  });

  it('injects the agent identity from its neutral creds file for a provider without repo-agents', async () => {
    // Codex has no `repoAgents` behavior, so there is no `readLaunchEnv` hook to
    // go through — the runtime must still read `.switch/agents/<name>.json` from
    // the VM, or the remote session authenticates to Switch as nobody.
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);

    await sshProvider({
      fs: makeRemoteFs({
        '.switch/agents/codex-hoot.json': JSON.stringify({
          env: {
            SWITCH_API_ENDPOINT: 'https://switch.example.com',
            SWITCH_API_TOKEN: 'tok-123',
            SWITCH_AGENT_ID: 'sw-1',
          },
        }),
      }),
    }).start(session());

    expect(resolveSshCommand).toHaveBeenCalledWith(
      'agent',
      expect.anything(),
      expect.objectContaining({
        SWITCH_API_ENDPOINT: 'https://switch.example.com',
        SWITCH_API_TOKEN: 'tok-123',
        SWITCH_AGENT_ID: 'sw-1',
      }),
      expect.anything()
    );
  });

  it('writes the per-agent Codex profile to the VM home and loads it on argv', async () => {
    // The profile carries model / effort / instructions. The Switch server is no
    // longer among them — the connector plugin registers it — but the
    // credentials it names must still reach the remote session, or the runtime
    // starts blind and never answers the handshake.
    const ctx = makeCtx();
    vi.mocked(getPlugin).mockImplementation(
      (id: string) =>
        ({
          metadata: { id },
          capabilities: { hostDependency: { binaryNames: [id] }, hooks: { kind: 'none' } },
          behavior: {
            prompt: { buildCommand: buildCommandMock },
            // The real builder, so the payload written to the VM is the profile
            // Codex will actually read rather than a stand-in string.
            mcp: (pluginRegistry.get('codex')!.behavior as { mcp?: unknown }).mcp,
          },
        }) as never
    );
    vi.mocked(getAgentById).mockResolvedValueOnce({
      autoApprove: false,
      name: 'codex-hoot',
      providerConfig: { model: 'gpt-5.6-terra' },
    } as never);
    mockSpawn([]);

    await sshProvider({
      ctx,
      fs: makeRemoteFs({
        '.switch/agents/codex-hoot.json': JSON.stringify({
          env: {
            SWITCH_API_ENDPOINT: 'https://switch.example.com/',
            SWITCH_API_TOKEN: 'tok-123',
            SWITCH_AGENT_ID: 'sw-1',
          },
        }),
      }),
    }).start(session());

    // Profile name is digest-suffixed on (dir, slug); the argv and the written
    // path must carry the same name.
    expect(buildCommandMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentArgs: ['--profile', expect.stringMatching(/^codex-hoot-[a-z0-9]+$/)],
      })
    );
    // The profile is written to the VM home over ctx.exec (base64), not the
    // repo-dir filesystem.
    expect(ctx.exec).toHaveBeenCalledWith(
      'sh',
      expect.arrayContaining([
        expect.stringMatching(/^\.codex\/codex-hoot-[a-z0-9]+\.config\.toml$/),
      ])
    );

    const written = (vi.mocked(ctx.exec).mock.calls as unknown[][])
      .flatMap((call) => (call[1] as string[]) ?? [])
      .map((arg) => {
        try {
          return Buffer.from(arg, 'base64').toString('utf8');
        } catch {
          return '';
        }
      })
      .find((decoded) => decoded.includes('model = "gpt-5.6-terra"'));
    expect(written).toBeDefined();
    // The connector plugin declares the server on the VM as it does locally.
    expect(written).not.toContain('mcp_servers');

    // Every credential the runtime needs must be on the remote session. Only the
    // identity tier here: this session runs without tmux, so it has no sidecar
    // and therefore no connection id or registry config.
    const env = (resolveSshCommand.mock.calls[0] as unknown[])[2] as Record<string, string>;
    for (const name of SWITCH_RUNTIME_REQUIRED_ENV) {
      expect(env).toHaveProperty(name);
    }
  });

  // Codex keeps its hooks in `~/.codex/hooks.json`, which the repo-rooted SFTP
  // filesystem cannot reach. Skipped, the VM has nothing that posts to the
  // sidecar: SessionStart never fires so no provider session id is captured and
  // every resume silently starts a new conversation, and Stop never fires so the
  // room's "working on it" never clears.
  it('installs a global-scope provider hooks under the VM home', async () => {
    const ctx = makeCtx();
    vi.mocked(getPlugin).mockImplementation(
      (id: string) =>
        ({
          metadata: { id },
          capabilities: {
            hostDependency: { binaryNames: [id] },
            hooks: { kind: 'config', scope: 'global', supportedEvents: ['stop'] },
          },
          behavior: {
            prompt: { buildCommand: buildCommandMock },
            hooks: pluginRegistry.get('codex')!.behavior.hooks,
          },
        }) as never
    );
    mockSpawn([]);

    await sshProvider({ ctx, tmux: true }).start(session());

    const written = (vi.mocked(ctx.exec).mock.calls as unknown[][])
      .map((call) => (call[1] as string[]) ?? [])
      .find((args) => args.includes('.codex/hooks.json') && args[1]?.includes('base64 -d'));
    expect(written).toBeDefined();
    const config = JSON.parse(Buffer.from(written!.at(-1)!, 'base64').toString('utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(config.hooks).sort()).toEqual([
      'PermissionRequest',
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
    ]);
  });

  // Neither root fits a scope nobody has taught the remote path about, and the
  // session would come up with no hooks at all — which looks fine until someone
  // notices resume has been starting fresh conversations for a month.
  it('refuses to start a session whose hook scope has no remote root', async () => {
    vi.mocked(getPlugin).mockImplementation(
      (id: string) =>
        ({
          metadata: { id },
          capabilities: {
            hostDependency: { binaryNames: [id] },
            hooks: { kind: 'config', scope: 'user-profile', supportedEvents: ['stop'] },
          },
          behavior: {
            prompt: { buildCommand: buildCommandMock },
            hooks: pluginRegistry.get('codex')!.behavior.hooks,
          },
        }) as never
    );
    mockSpawn([]);

    await expect(sshProvider({ tmux: true }).start(session())).rejects.toThrow(
      /no remote hook root for scope 'user-profile'/
    );
    expect(openSsh2Pty).not.toHaveBeenCalled();
  });

  it('propagates a failed SSH channel open as an error', async () => {
    openSsh2Pty.mockResolvedValue({ success: false, error: new Error('channel refused') });

    await expect(sshProvider().start(session())).rejects.toThrow('channel refused');
  });

  it('restarts a resumed session fresh after it exits', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      mockSpawn(exitHandlers);
      const item = session();

      await sshProvider().start(item, { cols: 80, rows: 24 }, true, 'continue');
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);

      expect(openSsh2Pty).toHaveBeenCalledTimes(2);
      expect(buildCommandMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ isResuming: false })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the remote shell profile and retries once on exit 127', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      mockSpawn(exitHandlers);
      const proxy = makeProxy();
      const item = session();

      await sshProvider({ proxy }).start(item);
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 127 });
      await vi.advanceTimersByTimeAsync(500);

      expect(proxy.refreshRemoteShellProfile).toHaveBeenCalledTimes(1);
      expect(openSsh2Pty).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a delayed replacement after explicit stop', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      mockSpawn(exitHandlers);
      const provider = sshProvider();
      const item = session();

      await provider.start(item);
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 0 });
      await provider.stop();
      await vi.advanceTimersByTimeAsync(500);

      expect(openSsh2Pty).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits session-exited on a non-stopped exit', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider();
    const item = session();

    await provider.start(item);
    vi.mocked(events.emit).mockClear();
    for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 1 });

    expect(events.emit).toHaveBeenCalledWith(
      agentSessionExitedChannel,
      expect.objectContaining({ sessionId: item.id })
    );
  });

  it('launches the sidecar and points the agent hook env at it when tmux is on', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const item = session();

    await sshProvider({ tmux: true }).start(item);

    expect(deployAndLaunch).toHaveBeenCalledTimes(1);
    const env = (resolveSshCommand.mock.calls[0] as unknown[])[2] as Record<string, string>;
    expect(env.SWITCHDASH_HOOK_PORT).toBe('9999');
    expect(env.SWITCHDASH_HOOK_TOKEN).toBe('sidecar-tok');
    expect(env.SWITCH_CHANNEL_DISABLE_POLL).toBe('1');
  });

  // A session's room is claimed on the connection whose id it carries, and on a
  // remote host only the sidecar reads that connection. Left to mint its own,
  // the session is addressable by nobody: an @-mention reaches silence and the
  // session shows no room, while the identical local session works.
  it('opens a connection on the sidecar and hands its id to the remote session', async () => {
    mockSpawn([]);

    await sshProvider({ tmux: true }).start(session());

    expect(httpPostForJsonOverChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: '/connection',
        body: { sessionId: 'session-1', providerId: 'codex' },
      })
    );
    const env = (resolveSshCommand.mock.calls[0] as unknown[])[2] as Record<string, string>;
    expect(env.SWITCH_CONNECTION_ID).toBe('conn-remote-1');
  });

  // `ensureAttachable` brings the sidecar up at provision time, so by the first
  // attach the sidecar is long since ready. Deciding "is this a re-attach?" from
  // the sidecar would therefore skip the connection hand-off on the very launch
  // that needs it, and the agent would come up addressable by nobody.
  it('still hands over a connection id when the sidecar was readied before the first attach', async () => {
    mockSpawn([]);
    const provider = sshProvider({ tmux: true });
    const item = session();

    await provider.ensureAttachable(item);
    expect(resolveSshCommand).not.toHaveBeenCalled();

    await provider.start(item);

    const env = (resolveSshCommand.mock.calls[0] as unknown[])[2] as Record<string, string>;
    expect(env.SWITCH_CONNECTION_ID).toBe('conn-remote-1');
  });

  // The hand-off opens a connection the sidecar renews, so repeating it per
  // attach would leak one per eviction cycle and leave the agent showing `live`
  // in rooms with no session behind it (CHOO-1106).
  it('opens the sidecar connection once per pane, not once per attach', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider({ tmux: true });

    await provider.start(session());
    expect(httpPostForJsonOverChannel).toHaveBeenCalledTimes(1);

    await provider.detachForEviction();
    await provider.attach();

    expect(openSsh2Pty).toHaveBeenCalledTimes(2);
    expect(httpPostForJsonOverChannel).toHaveBeenCalledTimes(1);
  });

  // A sidecar predating the endpoint 404s. Starting anyway would put the session
  // back in exactly the silence the hand-off exists to prevent, so the start has
  // to fail and say which upgrade fixes it.
  it('fails the start when the sidecar has no /connection endpoint', async () => {
    mockSpawn([]);
    httpPostForJsonOverChannel.mockRejectedValue(
      new SidecarHttpStatusError(404, 'POST /connection returned status 404')
    );

    await expect(sshProvider({ tmux: true }).start(session())).rejects.toThrow(
      /did not open a Switch connection.*restart it to upgrade/s
    );
    expect(openSsh2Pty).not.toHaveBeenCalled();
  });

  // An unreachable host is a different fault with a different fix, so it must
  // not be reported as an out-of-date sidecar.
  it('does not blame the sidecar version when the connection call simply fails', async () => {
    mockSpawn([]);
    httpPostForJsonOverChannel.mockRejectedValue(new Error('POST /connection timed out'));

    await expect(sshProvider({ tmux: true }).start(session())).rejects.toThrow(
      /did not open a Switch connection/
    );
    await expect(sshProvider({ tmux: true }).start(session())).rejects.not.toThrow(
      /restart it to upgrade/
    );
  });

  // Left open the connection keeps renewing, so the agent shows `live` in its
  // room with no session behind it — the CHOO-1106 ghost, now reachable through
  // a launch that dies between opening the connection and starting the pane.
  it('hands the connection back when the launch fails after opening it', async () => {
    openSsh2Pty.mockResolvedValue({ success: false, error: new Error('channel refused') });

    await expect(sshProvider({ tmux: true }).start(session())).rejects.toThrow('channel refused');

    expect(httpPostJsonOverChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: '/disconnect',
        body: { sessionId: 'session-1', terminated: false },
      })
    );
  });

  it('rejects a /connection reply carrying no id rather than launching without one', async () => {
    mockSpawn([]);
    httpPostForJsonOverChannel.mockResolvedValue({} as never);

    await expect(sshProvider({ tmux: true }).start(session())).rejects.toThrow(/no connection id/);
  });

  // The runtime is fetched with `npx` from a private registry, so without this
  // the remote session comes up with no MCP server and npm reports a 404 that
  // names neither the registry nor the missing credential.
  it('gives a freshly launched remote session its registry access', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);

    await sshProvider({ tmux: true }).start(session());

    expect(remoteNpmRegistryAuthEnv).toHaveBeenCalledTimes(1);
    const env = (resolveSshCommand.mock.calls[0] as unknown[])[2] as Record<string, string>;
    expect(env.npm_config_userconfig).toBe('/repo/.switchdash/npmrc');
    expect(env.SWITCHDASH_GITHUB_TOKEN).toBe('remote-tok');
  });

  // Re-attach is decided from whether this runtime has already opened the pane,
  // not from the sidecar being up: with on-demand attachment the sidecar is
  // running long before the first PTY, so reading it would make every first
  // attach look like a re-attach and silently lose its registry config.
  it('does not recompute registry access when re-attaching', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider({ tmux: true });

    await provider.start(session());
    expect(remoteNpmRegistryAuthEnv).toHaveBeenCalledTimes(1);

    for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 1 });
    await provider.attach();
    expect(openSsh2Pty).toHaveBeenCalledTimes(2);

    // The pane still has the environment it was created with; tmux applies
    // `-e` only at creation, so recomputing would cost round trips for nothing.
    expect(remoteNpmRegistryAuthEnv).toHaveBeenCalledTimes(1);
  });

  it('starts the hook-event relay against the sidecar endpoint when tmux is on', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const proxy = makeProxy();
    const item = session();

    await sshProvider({ proxy, tmux: true }).start(item);
    await vi.waitFor(() => expect(proxy.forwardOut).toHaveBeenCalledWith(9999));
  });

  it('leaves the shared sidecar running when a single session is stopped', async () => {
    // The sidecar is agent-scoped and shared (other sessions + its notification
    // watcher rely on it), so stopping one session must not kill it — only its
    // own tmux pane and hook-event relay are torn down.
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const proxy = makeProxy({ forwardOut: vi.fn(async () => ({ destroy: vi.fn() }) as never) });
    const provider = sshProvider({ proxy, tmux: true });
    const item = session();

    await provider.start(item);
    await provider.stop();

    expect(sidecarStop).not.toHaveBeenCalled();
  });

  it('POSTs /disconnect to the sidecar on stopSession when tmux is on', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const proxy = makeProxy({ forwardOut: vi.fn(async () => ({ destroy: vi.fn() }) as never) });
    const provider = sshProvider({ proxy, tmux: true });
    const item = session();

    await provider.start(item);
    await provider.stop();

    expect(httpPostJsonOverChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: '/disconnect',
        body: { sessionId: item.id, terminated: true },
      })
    );
  });

  it('does not disconnect the sidecar for a local (non-tmux) session', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider({ tmux: false });
    const item = session();

    await provider.start(item);
    await provider.stop();

    expect(httpPostJsonOverChannel).not.toHaveBeenCalled();
  });

  it('re-attaches a remote tmux session without relaunching the sidecar', async () => {
    // Re-attach is driven by RemoteAttachmentPool rather than a per-runtime
    // reconnect listener: 51 sessions each listening meant 51 simultaneous
    // attaches on a transport that had only just come back.
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const item = session();
    const provider = sshProvider({ tmux: true });

    await provider.start(item);
    expect(openSsh2Pty).toHaveBeenCalledTimes(1);
    expect(deployAndLaunch).toHaveBeenCalledTimes(1);

    // The interactive PTY dies with the dropped connection; for tmux the
    // provider tears down the local session but keeps it re-attachable.
    for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 1 });

    await provider.attach();

    expect(openSsh2Pty).toHaveBeenCalledTimes(2);
    // Re-attach reuses the still-running sidecar + relay rather than relaunching.
    expect(deployAndLaunch).toHaveBeenCalledTimes(1);
  });

  it('re-attaches after an eviction, which clears the supervisor desired flag', async () => {
    // dehydrate() -> detachPty() -> supervisor.stop() clears `desired`. attach()
    // must not gate on it, or an evicted session could never come back.
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider({ tmux: true });

    await provider.start(session());
    expect(openSsh2Pty).toHaveBeenCalledTimes(1);

    await provider.detachForEviction();
    expect(provider.isAttached()).toBe(false);

    await provider.attach();
    expect(openSsh2Pty).toHaveBeenCalledTimes(2);
  });

  // A runtime joins the attachment pool at provision time but learns its session
  // only from `ensureAttachable`. Returning quietly here is indistinguishable to
  // the pool from a successful attach: it logs `remote_attach`, reports the
  // session attached, and the user stares at an empty pane with nothing in the
  // log. Observed on a real host — every click logged an attach and
  // `attachedCount` never left 0.
  it('fails loudly when asked to attach before it knows its session', async () => {
    mockSpawn([]);
    const provider = sshProvider({ tmux: true });

    await expect(provider.attach()).rejects.toThrow(/never made attachable/);
    expect(openSsh2Pty).not.toHaveBeenCalled();
  });

  it('attaches once ensureAttachable has told it which session it serves', async () => {
    mockSpawn([]);
    const provider = sshProvider({ tmux: true });

    await provider.ensureAttachable(session());
    await provider.attach();

    expect(openSsh2Pty).toHaveBeenCalledTimes(1);
    expect(provider.isAttached()).toBe(true);
  });

  it('does not report the agent as exited when a session is evicted', async () => {
    // The sidebar derives status from hook events; a deliberate detach must not
    // look like the agent stopping, or every eviction would flip it to idle.
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider({ tmux: true });

    await provider.start(session());
    vi.mocked(events.emit).mockClear();

    await provider.detachForEviction();

    expect(vi.mocked(events.emit)).not.toHaveBeenCalledWith(
      agentSessionExitedChannel,
      expect.anything()
    );
  });

  it('makes a session attachable without opening a PTY', async () => {
    // Provisioned-but-not-viewed sessions still need the sidecar and its relay:
    // status, room membership and notifications all arrive over the relay.
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider({ tmux: true });

    await provider.ensureAttachable(session());

    expect(deployAndLaunch).toHaveBeenCalledTimes(1);
    expect(openSsh2Pty).not.toHaveBeenCalled();
    expect(provider.isAttached()).toBe(false);
  });

  it('does not re-launch the sidecar when ensureAttachable is called again', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider({ tmux: true });
    const item = session();

    await provider.ensureAttachable(item);
    await provider.ensureAttachable(item);
    // The subsequent attach reuses it too.
    await provider.attach();

    expect(deployAndLaunch).toHaveBeenCalledTimes(1);
    expect(openSsh2Pty).toHaveBeenCalledTimes(1);
  });

  it('ignores reconnect events for other connections', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const item = session();

    await sshProvider({ tmux: true }).start(item);
    for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 1 });

    emitReconnected('ssh-OTHER');
    await new Promise((r) => setTimeout(r, 20));
    expect(openSsh2Pty).toHaveBeenCalledTimes(1);
  });

  it('forgets the session and kills the pty on stop', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider();
    const item = session();

    await provider.start(item);
    const pty = (provider as unknown as ProviderState).pty!;
    await provider.stop();

    expect(pty.kill).toHaveBeenCalled();
    expect((provider as unknown as ProviderState).known).toBe(false);
  });
});
