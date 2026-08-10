import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseTOML } from 'smol-toml';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  type AgentLaunchSpec,
  INITIAL_PROMPT_PLACEHOLDER,
  SESSION_ID_PLACEHOLDER,
} from './agent-launch-spec';
import { InProcessSessionSpawner, type InProcessSessionSpawnerDeps } from './session-spawner';

/** Swap in a stand-in provider for one test; null falls through to the real one. */
const pluginOverride = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@main/core/providers/plugin-registry', async () => {
  const { pluginRegistry } = await import('@switch-console/plugins/agents');
  return { getPlugin: (id: string) => pluginOverride.current ?? pluginRegistry.get(id) };
});

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// A launch writes real files: the provider's hooks under the session's working
// dir or the home, and any baked launch files under the home. Both point at
// throwaway directories so a test run does not rewrite the developer's own
// ~/.codex or fail trying to create the VM's paths.
const CWD = await mkdtemp(join(tmpdir(), 'session-spawner-cwd-'));
const HOME = await mkdtemp(join(tmpdir(), 'session-spawner-home-'));
const realHome = process.env.HOME;
process.env.HOME = HOME;

afterAll(async () => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  await rm(CWD, { recursive: true, force: true });
  await rm(HOME, { recursive: true, force: true });
});

const SPEC: AgentLaunchSpec = {
  command: '/usr/bin/claude',
  args: [
    '--session-id',
    SESSION_ID_PLACEHOLDER,
    '--dangerously-skip-permissions',
    INITIAL_PROMPT_PLACEHOLDER,
  ],
  env: { BASE: '1' },
  cwd: CWD,
  providerId: 'claude',
  deeplinkScheme: 'switchdash',
};

function makeSpawner(over: Partial<InProcessSessionSpawnerDeps> = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args });
    return { stdout: '', stderr: '' };
  });
  const runtime = { hasLiveRoom: vi.fn(() => false) };
  const spawner = new InProcessSessionSpawner({
    spec: SPEC,
    hookPort: 4321,
    hookToken: 'hooktok',
    endpointFile: `${CWD}/.switchdash/sidecar-endpoint.json`,
    runtime,
    switchEnv: {
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'tok',
      SWITCH_AGENT_ID: 'agent-1',
    },
    isPaneLive: () => true,
    log: silentLog,
    exec,
    ...over,
  });
  return { spawner, exec, calls, runtime };
}

describe('InProcessSessionSpawner.launch', () => {
  it('launches the agent tmux session wired to the local hook server', async () => {
    const { spawner, calls } = makeSpawner();
    await spawner.launch('room-x');

    const launch = calls.find((c) => c.args[0] === 'new-session');
    expect(launch).toBeDefined();
    const inner = launch!.args.at(-1)!;
    expect(inner).toContain("SWITCHDASH_HOOK_PORT='4321'");
    expect(inner).toContain("SWITCHDASH_HOOK_TOKEN='hooktok'");
    expect(inner).toContain("SWITCH_CHANNEL_DISABLE_POLL='1'");
    // The agent's identity is injected so the auto-started session authenticates
    // as this agent (CHOO-1440).
    expect(inner).toContain("SWITCH_API_ENDPOINT='https://switch.example.com'");
    expect(inner).toContain("SWITCH_AGENT_ID='agent-1'");
    expect(inner).toContain('connect to switch room room-x');
    expect(inner).not.toContain(SESSION_ID_PLACEHOLDER);
    expect(inner).not.toContain(INITIAL_PROMPT_PLACEHOLDER);
  });

  it('gives the pane every credential the baked Codex profile forwards', async () => {
    // The sidecar writes the profile but the pane supplies the values it names.
    // Codex reads them from its own environment and forwards them onward, so a
    // name the profile lists and the pane lacks reaches the runtime as nothing.
    const profile = [
      '[mcp_servers.switch]',
      'command = "npx"',
      'env_vars = ["SWITCH_API_ENDPOINT", "SWITCH_API_TOKEN", "SWITCH_AGENT_ID"]',
      '',
    ].join('\n');
    const { spawner, calls } = makeSpawner({
      spec: {
        ...SPEC,
        launchFiles: [{ homeRelativePath: '.codex/codex-hoot.config.toml', content: profile }],
      },
    });

    await spawner.launch('room-x');

    const inner = calls.find((c) => c.args[0] === 'new-session')!.args.at(-1)!;
    const names = (parseTOML(profile) as { mcp_servers: Record<string, { env_vars: string[] }> })
      .mcp_servers.switch.env_vars;
    for (const name of names) {
      expect(inner).toContain(`${name}=`);
    }
    expect(await readFile(join(HOME, '.codex/codex-hoot.config.toml'), 'utf8')).toBe(profile);
  });

  // The pane is launched pointing at this sidecar's hook server, but nothing
  // posts to it unless the provider's own config registers the hook commands —
  // and Codex keeps that config in the home, not the working dir. Without it the
  // auto-started session never reports that it stopped, so the room it was
  // spawned to answer shows it working forever.
  it("writes a global-scope provider's hooks under the home before the pane starts", async () => {
    const { spawner, calls } = makeSpawner({ spec: { ...SPEC, providerId: 'codex' } });

    await spawner.launch('room-x');

    const config = JSON.parse(await readFile(join(HOME, '.codex/hooks.json'), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(config.hooks).sort()).toEqual([
      'PermissionRequest',
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
    ]);
    expect(calls.find((c) => c.args[0] === 'new-session')).toBeDefined();
  });

  it("writes a workspace-scoped provider's hooks under the session's working dir", async () => {
    const { spawner } = makeSpawner();

    await spawner.launch('room-x');

    expect(await readFile(join(CWD, '.claude/settings.local.json'), 'utf8')).toContain('hooks');
  });

  // Neither root fits a scope this path has not been taught, and a session
  // spawned with no hooks looks fine right up until nobody can tell it is done.
  it('refuses to spawn a session whose hook scope has no root here', async () => {
    pluginOverride.current = {
      capabilities: { hooks: { kind: 'config', scope: 'user-profile', supportedEvents: [] } },
      behavior: { hooks: { writeHooks: vi.fn(async () => []) } },
    };
    try {
      const { spawner, calls } = makeSpawner();
      await expect(spawner.launch('room-x')).rejects.toThrow(/no hook root for scope/);
      expect(calls.find((c) => c.args[0] === 'new-session')).toBeUndefined();
    } finally {
      pluginOverride.current = null;
    }
  });

  it('reports a launched-but-not-yet-connected room live while its pane is up', async () => {
    const { spawner } = makeSpawner({ isPaneLive: () => true });
    await spawner.launch('room-x');
    await expect(spawner.isRoomLive('room-x')).resolves.toBe(true);
  });

  it('treats a launched room whose pane died as not live', async () => {
    const { spawner } = makeSpawner({ isPaneLive: () => false });
    await spawner.launch('room-x');
    await expect(spawner.isRoomLive('room-x')).resolves.toBe(false);
  });

  it('reports a room live when the runtime is already serving it', async () => {
    const runtime = { hasLiveRoom: vi.fn((r: string) => r === 'room-x') };
    const { spawner } = makeSpawner({ runtime });
    await expect(spawner.isRoomLive('room-x')).resolves.toBe(true);
  });

  it('is not live for an unknown room', async () => {
    const { spawner } = makeSpawner();
    await expect(spawner.isRoomLive('room-y')).resolves.toBe(false);
  });
});

describe('InProcessSessionSpawner.spawnedSessions', () => {
  it('reports a launched session with its minted session id while its pane is live', async () => {
    const { spawner } = makeSpawner({ isPaneLive: () => true });
    await spawner.launch('room-x');
    const spawned = spawner.spawnedSessions();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.roomId).toBe('room-x');
    expect(spawned[0]!.sessionId).toMatch(/[0-9a-f-]{36}/);
  });

  it('omits a launched session whose pane has died (no ghost row)', async () => {
    const { spawner } = makeSpawner({ isPaneLive: () => false });
    await spawner.launch('room-x');
    expect(spawner.spawnedSessions()).toEqual([]);
  });
});

describe('InProcessSessionSpawner.setSpec', () => {
  it('applies a swapped launch spec to the next launch (live toggle, no restart)', async () => {
    const { spawner, calls } = makeSpawner();
    spawner.setSpec({
      ...SPEC,
      command: '/usr/bin/other-cli',
      args: ['--session-id', SESSION_ID_PLACEHOLDER, '--no-skip', INITIAL_PROMPT_PLACEHOLDER],
    });
    await spawner.launch('room-x');

    const inner = calls.find((c) => c.args[0] === 'new-session')!.args.at(-1)!;
    expect(inner).toContain('/usr/bin/other-cli');
    expect(inner).toContain('--no-skip');
    expect(inner).not.toContain('--dangerously-skip-permissions');
  });
});

describe('InProcessSessionSpawner.roomIdForSession', () => {
  it('returns the room a launched session was started for, or null', async () => {
    const { spawner } = makeSpawner({ isPaneLive: () => true });
    await spawner.launch('room-x');
    const sessionId = spawner.spawnedSessions()[0]!.sessionId;

    expect(spawner.roomIdForSession(sessionId)).toBe('room-x');
    expect(spawner.roomIdForSession('unknown-session')).toBeNull();
  });
});

describe('InProcessSessionSpawner.drop', () => {
  it('forgets a launched session by its session id', async () => {
    const { spawner } = makeSpawner({ isPaneLive: () => true });
    await spawner.launch('room-x');
    const convId = spawner.spawnedSessions()[0]!.sessionId;

    spawner.drop(convId);

    expect(spawner.spawnedSessions()).toEqual([]);
    // The room is free to be spawned again.
    await expect(spawner.isRoomLive('room-x')).resolves.toBe(false);
  });

  it('is a no-op for an unknown session id', async () => {
    const { spawner } = makeSpawner({ isPaneLive: () => true });
    await spawner.launch('room-x');

    spawner.drop('not-a-real-conv');

    expect(spawner.spawnedSessions()).toHaveLength(1);
  });

  // A session started for room A that moves to room B leaves A uncovered, and a
  // ping there must spawn again. The launched entry is keyed by the room the
  // session was started for and its pane is still alive in room B, so left in
  // place it vouches for A forever and A becomes permanently unspawnable.
  it('frees the original room once its session has moved elsewhere', async () => {
    const rooms = new Map<string, string>();
    const runtime = {
      hasLiveRoom: vi.fn((r: string) => [...rooms.values()].includes(r)),
    };
    const { spawner } = makeSpawner({ isPaneLive: () => true, runtime });

    await spawner.launch('room-a');
    const sessionId = spawner.spawnedSessions()[0]!.sessionId;

    // Connects to the room it was started for: still covered.
    rooms.set(sessionId, 'room-a');
    spawner.drop(sessionId);
    await expect(spawner.isRoomLive('room-a')).resolves.toBe(true);

    // Re-targets to another room. Its pane is still live — that is the trap.
    rooms.set(sessionId, 'room-b');
    await expect(spawner.isRoomLive('room-b')).resolves.toBe(true);
    await expect(spawner.isRoomLive('room-a')).resolves.toBe(false);
  });
});
