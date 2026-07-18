import { describe, expect, it, vi } from 'vitest';
import {
  type AgentLaunchSpec,
  INITIAL_PROMPT_PLACEHOLDER,
  SESSION_ID_PLACEHOLDER,
} from './agent-launch-spec';
import { InProcessSessionSpawner, type InProcessSessionSpawnerDeps } from './session-spawner';

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const SPEC: AgentLaunchSpec = {
  command: '/usr/bin/claude',
  args: [
    '--session-id',
    SESSION_ID_PLACEHOLDER,
    '--dangerously-skip-permissions',
    INITIAL_PROMPT_PLACEHOLDER,
  ],
  env: { BASE: '1' },
  cwd: '/home/agent/repo',
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
    projectId: 'proj-1',
    hookPort: 4321,
    hookToken: 'hooktok',
    runtime,
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
    expect(inner).toContain('connect to switch room room-x');
    expect(inner).not.toContain(SESSION_ID_PLACEHOLDER);
    expect(inner).not.toContain(INITIAL_PROMPT_PLACEHOLDER);
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
  it('reports a launched session with its minted conversation id while its pane is live', async () => {
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

describe('InProcessSessionSpawner.drop', () => {
  it('forgets a launched session by its conversation id', async () => {
    const { spawner } = makeSpawner({ isPaneLive: () => true });
    await spawner.launch('room-x');
    const convId = spawner.spawnedSessions()[0]!.sessionId;

    spawner.drop(convId);

    expect(spawner.spawnedSessions()).toEqual([]);
    // The room is free to be spawned again.
    await expect(spawner.isRoomLive('room-x')).resolves.toBe(false);
  });

  it('is a no-op for an unknown conversation id', async () => {
    const { spawner } = makeSpawner({ isPaneLive: () => true });
    await spawner.launch('room-x');

    spawner.drop('not-a-real-conv');

    expect(spawner.spawnedSessions()).toHaveLength(1);
  });
});
