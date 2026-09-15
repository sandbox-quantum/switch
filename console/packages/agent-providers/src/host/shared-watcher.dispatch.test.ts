import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBridgeEvent, SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionDispatcher } from './resident-host';
import { sharedConfigSchema, type SharedHostConfig } from './shared-config';
import { runSharedWatcher } from './shared-watcher';

const { streams } = vi.hoisted(() => ({ streams: [] as SwitchEventStreamDeps[] }));
vi.mock('@sandboxaq/switch-agent-runtime', () => ({
  SwitchEventStream: class {
    constructor(private readonly deps: SwitchEventStreamDeps) {
      streams.push(deps);
    }
    start(): void {}
  },
}));

const roots: string[] = [];
afterEach(async () => {
  streams.length = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const addressed = (sequence: number, roomId: string): AgentBridgeEvent => ({
  type: 'message',
  room_id: roomId,
  sequence,
  payload: {
    addressed: true,
    sender: '@owner:example.test',
    sender_name: 'Owner',
    message_id: `message-${sequence}`,
    body: 'Run the check',
    timestamp: sequence,
  },
});

function templateFor(root: string, credentialsPath: string): SharedHostConfig {
  return sharedConfigSchema.parse({
    session: {
      sessionId: 'watcher',
      agentId: 'agent',
      hostId: 'host',
      epoch: 'initial',
      provider: 'claude',
      status: 'starting',
      connectivity: 'online',
      pendingRequestIds: [],
      capabilities: {
        input: 'queue',
        approvals: true,
        questions: true,
        interrupt: true,
        reset: false,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    },
    start: {
      provider: 'claude',
      input: {
        sessionId: 'watcher',
        cwd: root,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
      },
    },
    roomConnection: { connectionId: 'discovery', rooms: [], startCursor: 0 },
    execution: {
      credentialsPath,
      inheritEnv: [],
      mcpRuntime: '@example/runtime',
      codexConfig: '',
      skill: '',
      context: '',
    },
  });
}

it('records a room it cannot admit instead of stopping the agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watcher-dispatch-test-'));
  roots.push(root);
  const credentialsPath = join(root, 'credentials.json');
  await writeFile(
    credentialsPath,
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'http://127.0.0.1/agent',
        SWITCH_API_TOKEN: 'token',
        SWITCH_AGENT_ID: 'agent',
      },
    })
  );
  const template = templateFor(root, credentialsPath);
  await writeFile(join(root, 'config.json'), JSON.stringify(template));
  await writeFile(join(root, 'watch.json'), JSON.stringify({ enabled: true }));

  const admitted: string[] = [];
  const rejected: { roomId: string; message: string }[] = [];
  const dispatcher: SessionDispatcher = {
    incomplete: false,
    dispatch: vi.fn(async (roomId: string) => {
      if (roomId === 'room-refused')
        throw new Error('Room room-refused is already served by session other.');
      admitted.push(roomId);
    }),
    reject: vi.fn(async (roomId: string, _config: SharedHostConfig, error: unknown) => {
      rejected.push({ roomId, message: String(error) });
    }),
    stop: vi.fn(async () => {}),
    live: () => [],
    failures: () => [],
    stopAll: vi.fn(async () => {}),
  };

  const stop = new AbortController();
  const watching = runSharedWatcher(root, dispatcher, template, stop.signal);
  const stream = await vi.waitFor(() => {
    const deps = streams[0];
    if (!deps) throw new Error('the watcher has not opened its discovery connection');
    return deps;
  });

  await stream.onEvent(addressed(1, 'room-refused'));
  await stream.onEvent(addressed(2, 'room-ok'));
  // Turning the watcher off is how it exits; it must reach that, not fault.
  await writeFile(join(root, 'watch.json'), JSON.stringify({ enabled: false }));

  await expect(watching).resolves.toBeUndefined();
  expect(rejected).toEqual([
    { roomId: 'room-refused', message: expect.stringContaining('already served by session other') },
  ]);
  // The sibling room was admitted after the refusal, and the watcher stopped
  // cleanly rather than tearing every room down.
  expect(admitted).toEqual(['room-ok']);
  expect(dispatcher.stopAll).toHaveBeenCalled();
});
