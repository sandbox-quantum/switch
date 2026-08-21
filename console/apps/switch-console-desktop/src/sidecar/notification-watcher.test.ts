import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationWatcher, type SessionSpawner } from './notification-watcher';

const CREDS = { agentId: 'switch-agent-1', apiEndpoint: 'http://switch.test', token: 'tok' };
const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeSpawner(over: Partial<SessionSpawner> = {}): SessionSpawner {
  return {
    isRoomLive: vi.fn(async () => false),
    launch: vi.fn(async () => {}),
    ...over,
  };
}

const watchers: NotificationWatcher[] = [];
function makeWatcher(spawner: SessionSpawner, watchEnabled: () => boolean = () => true) {
  const watcher = new NotificationWatcher({ creds: CREDS, spawner, watchEnabled, log: silentLog });
  watchers.push(watcher);
  return watcher;
}

// Stop every watcher after each test so its in-flight guard timers (and loops)
// are cleared — otherwise the 120s in-flight setTimeout keeps the worker alive.
afterEach(() => {
  for (const w of watchers.splice(0)) w.stop();
});

// spawnForRoom / handleNotification are private; reach them to test the spawn
// decision in isolation from the long-poll loop.
function handle(
  watcher: NotificationWatcher,
  roomId: string,
  sequence?: number,
  requesterName: string | null = null
): void {
  (
    watcher as unknown as {
      handleNotification: (r: string, who: string | null, s?: number) => void;
    }
  ).handleNotification(roomId, requesterName, sequence);
}

describe('NotificationWatcher spawn decision', () => {
  beforeEach(() => {
    for (const fn of Object.values(silentLog)) fn.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 }))
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('launches a session when no live session is attending the room', async () => {
    const spawner = makeSpawner();
    handle(makeWatcher(spawner), 'room-x');
    await vi.waitFor(() => expect(spawner.launch).toHaveBeenCalledTimes(1));
    expect(spawner.launch).toHaveBeenCalledWith('room-x', null, undefined);
  });

  // The watcher consumed the triggering event to decide to spawn, so the
  // session it starts must rewind to it. Launched at head, the session comes up
  // having missed the one message it exists to answer.
  it('starts the spawned session one event before its trigger', async () => {
    const spawner = makeSpawner();
    handle(makeWatcher(spawner), 'room-x', 42);
    await vi.waitFor(() => expect(spawner.launch).toHaveBeenCalledTimes(1));
    expect(spawner.launch).toHaveBeenCalledWith('room-x', null, 41);
  });

  it('does not rewind past the start of the stream', async () => {
    const spawner = makeSpawner();
    handle(makeWatcher(spawner), 'room-x', 0);
    await vi.waitFor(() => expect(spawner.launch).toHaveBeenCalledTimes(1));
    expect(spawner.launch).toHaveBeenCalledWith('room-x', null, 0);
  });

  it('does not launch when a live session already attends the room', async () => {
    const spawner = makeSpawner({ isRoomLive: vi.fn(async () => true) });
    handle(makeWatcher(spawner), 'room-x');
    await new Promise((r) => setTimeout(r, 10));
    expect(spawner.launch).not.toHaveBeenCalled();
  });

  it('in-flight guard prevents a second launch for the same room', async () => {
    const spawner = makeSpawner();
    const watcher = makeWatcher(spawner);
    handle(watcher, 'room-x');
    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(spawner.launch).toHaveBeenCalledTimes(1));
    expect(spawner.launch).toHaveBeenCalledTimes(1);
  });

  it('logs at info when a notification is dropped because a spawn is in flight', async () => {
    const spawner = makeSpawner();
    const watcher = makeWatcher(spawner);
    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(spawner.launch).toHaveBeenCalledTimes(1));
    handle(watcher, 'room-x'); // suppressed by the in-flight guard
    expect(spawner.launch).toHaveBeenCalledTimes(1);
    expect(silentLog.info).toHaveBeenCalledWith(
      expect.stringContaining('skipping duplicate spawn'),
      { roomId: 'room-x' }
    );
  });

  it('clearRoom releases the in-flight guard so the next notification spawns again', async () => {
    const spawner = makeSpawner();
    const watcher = makeWatcher(spawner);
    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(spawner.launch).toHaveBeenCalledTimes(1));

    // Without a clear, a re-notification is suppressed by the in-flight guard.
    handle(watcher, 'room-x');
    expect(spawner.launch).toHaveBeenCalledTimes(1);

    // Handing the guard off (session connected, or deleted) lets the next one spawn.
    watcher.clearRoom('room-x');
    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(spawner.launch).toHaveBeenCalledTimes(2));
  });

  it('retries on launch failure then posts a spawn-failure notice', async () => {
    const launch = vi.fn(async () => {
      throw new Error('boom');
    });
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    handle(makeWatcher(makeSpawner({ launch })), 'room-x');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 8000 });
    expect(launch).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toContain('/agents/switch-agent-1/message');
    expect(String((init as RequestInit).body)).toContain('start a session');
  }, 10_000);

  // A notice nobody is pinged by scrolls past in a channel the person who asked
  // may not be watching, which defeats the point of saying nobody is coming.
  it('addresses the spawn-failure notice to whoever asked', async () => {
    const launch = vi.fn(async () => {
      throw new Error('boom');
    });
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    handle(makeWatcher(makeSpawner({ launch })), 'room-x', undefined, 'ada.lovelace');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 8000 });
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(String((init as RequestInit).body)).toContain('@ada.lovelace');
  }, 10_000);
});

describe('NotificationWatcher watch gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not poll or heartbeat while watch is disabled, then starts when enabled', async () => {
    // Park like the real long-poll (resolve only on abort) so the loop doesn't
    // hot-spin and stop() unwinds it cleanly.
    const fetchMock = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    let enabled = false;
    const watcher = makeWatcher(makeSpawner(), () => enabled);
    watcher.start();

    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled(); // disabled → idle

    enabled = true;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2000 });
    watcher.stop();
  });
});
