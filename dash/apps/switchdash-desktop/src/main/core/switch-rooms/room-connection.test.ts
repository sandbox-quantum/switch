import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InjectionTarget } from './injection-sink';
import { type PromptInjector, RoomConnection } from './room-connection';
import { resolveSessionControl } from './session-control';
import type { AgentBridgeEvent, AttachmentRef } from './switch-event-format';

const silentLog = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

const creds = { agentId: 'agent-1', apiEndpoint: 'https://switch.test', token: 'tok' };

const mediaDir = path.join(os.tmpdir(), 'switchdash-room-connection-test');

const injector: PromptInjector = {
  build: (text) => ({ payload: `<<${text}>>`, submitSequence: '\r', submitDelayMs: 0 }),
};

// Claude supports all three control commands, so exercise the real recipes.
const control = resolveSessionControl('claude');

function commandEvent(
  command: string,
  args = '',
  threadId: string | null = null
): AgentBridgeEvent {
  return {
    type: 'command',
    room_id: 'room-1',
    payload: { command, args, user_id: '@u:switch', user_name: 'u', thread_id: threadId },
  };
}

function messageEvent(
  addressed: boolean,
  threadId: string | null = null,
  attachments: AttachmentRef[] = []
): AgentBridgeEvent {
  return {
    type: 'message',
    room_id: 'room-1',
    payload: {
      addressed,
      sender: '@someone:switch',
      sender_name: 'Someone',
      message_id: 'msg-1',
      body: 'hello agent',
      timestamp: 1,
      thread_id: threadId,
      attachments,
    },
  };
}

/**
 * Serves one batch of events on the first `/events` poll, then parks the loop
 * (a never-resolving promise) so the test controls exactly one poll cycle.
 * runtime-state + connection/renew always succeed; their request bodies are
 * captured on the returned mock for assertions.
 */
function makeFetch(events: AgentBridgeEvent[]) {
  let served = false;
  return vi.fn(async (url: string, _opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('/media')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        text: async () => '',
      };
    }
    if (u.includes('/events')) {
      if (!served) {
        served = true;
        return { ok: true, status: 200, json: async () => ({ events }), text: async () => '' };
      }
      return new Promise(() => {});
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
}

function runtimeStates(fetchMock: ReturnType<typeof makeFetch>): string[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/runtime-state'))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string).state);
}

function runtimeDetails(fetchMock: ReturnType<typeof makeFetch>): (string | null)[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/runtime-state'))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string).detail);
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe('RoomConnection', () => {
  beforeEach(() => {
    silentLog.debug.mockClear();
    silentLog.warn.mockClear();
    silentLog.error.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function connect(
    sink: { acquire: () => InjectionTarget | null },
    events: AgentBridgeEvent[],
    isHumanTyping: () => boolean = () => false
  ) {
    const fetchMock = makeFetch(events);
    vi.stubGlobal('fetch', fetchMock);
    const conn = new RoomConnection({
      creds,
      roomId: 'room-1',
      roomName: 'Room One',
      sessionId: 'conv-1',
      sink,
      injector,
      control,
      deeplinkScheme: 'switchdash',
      isHumanTyping,
      mediaDir,
      log: silentLog,
    });
    conn.start();
    return { conn, fetchMock };
  }

  it('injects an addressed message then submits, and surfaces a working turn', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, [messageEvent(true)]);

    await flush();

    const writes = vi.mocked(target.write).mock.calls.map((c) => c[0]);
    expect(writes[0]).toContain('<<');
    expect(writes[0]).toContain('addressed you');
    expect(writes).toContain('\r');
    expect(runtimeStates(fetchMock)).toContain('working');

    conn.stop();
  });

  it('downloads image attachments and annotates the injected message', async () => {
    fs.rmSync(mediaDir, { recursive: true, force: true });
    const target: InjectionTarget = { write: vi.fn() };
    const attachment: AttachmentRef = {
      filename: 'diagram.png',
      mimetype: 'image/png',
      size: 3,
      mxc: 'mxc://switch.test/abc',
      msgtype: 'm.image',
    };
    const { conn, fetchMock } = connect({ acquire: () => target }, [
      messageEvent(true, null, [attachment]),
    ]);

    await flush();

    // The bridge media endpoint was hit for the attachment's mxc.
    const mediaCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/media'));
    expect(mediaCalls.length).toBe(1);
    expect(String(mediaCalls[0][0])).toContain(encodeURIComponent(attachment.mxc));

    // The injected text tells the agent an image is attached with a local path.
    const injected = vi.mocked(target.write).mock.calls.map((c) => c[0])[0];
    expect(injected).toContain('1 image attached');
    expect(injected).toContain(mediaDir);

    conn.stop();
    fs.rmSync(mediaDir, { recursive: true, force: true });
  });

  it('does not annotate or download non-image attachments', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const attachment: AttachmentRef = {
      filename: 'notes.pdf',
      mimetype: 'application/pdf',
      size: 3,
      mxc: 'mxc://switch.test/pdf',
      msgtype: 'm.file',
    };
    const { conn, fetchMock } = connect({ acquire: () => target }, [
      messageEvent(true, null, [attachment]),
    ]);

    await flush();

    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/media')).length).toBe(0);
    const injected = vi.mocked(target.write).mock.calls.map((c) => c[0])[0];
    expect(injected).not.toContain('attached');

    conn.stop();
  });

  it('does not inject unaddressed chatter', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn } = connect({ acquire: () => target }, [messageEvent(false)]);

    await flush();

    expect(target.write).not.toHaveBeenCalled();
    conn.stop();
  });

  it('defers injection while no target is live and keeps the message queued', async () => {
    const { conn } = connect({ acquire: () => null }, [messageEvent(true)]);

    await flush();

    // Nothing crashed and the deferral was logged, not silently dropped.
    expect(silentLog.warn).toHaveBeenCalledWith(
      'RoomConnection: injection deferred — no live target for session',
      expect.objectContaining({ queued: 1 })
    );
    conn.stop();
  });

  it('defers injection while the operator is typing into the pane', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn } = connect({ acquire: () => target }, [messageEvent(true)], () => true);

    await flush();

    expect(target.write).not.toHaveBeenCalled();
    expect(silentLog.debug).toHaveBeenCalledWith(
      'RoomConnection: injection deferred — operator typing',
      expect.objectContaining({ queued: 1 })
    );
    conn.stop();
  });

  it('injects once the operator stops typing', async () => {
    vi.useFakeTimers();
    try {
      const target: InjectionTarget = { write: vi.fn() };
      let typing = true;
      const { conn } = connect({ acquire: () => target }, [messageEvent(true)], () => typing);

      await vi.advanceTimersByTimeAsync(1);
      expect(target.write).not.toHaveBeenCalled();

      typing = false;
      // The gate re-checks after HUMAN_GATE_RETRY_MS (500ms).
      await vi.advanceTimersByTimeAsync(500);
      expect(vi.mocked(target.write).mock.calls.map((c) => c[0])[0]).toContain('<<');

      conn.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the room turn and posts idle when the agent goes idle', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, [messageEvent(true)]);
    await flush();

    conn.onAgentStatusChange('idle');
    await flush();

    expect(runtimeStates(fetchMock)).toContain('idle');
    conn.stop();
  });

  it('refreshes the working message with a per-turn activity detail', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, [messageEvent(true)]);
    await flush();

    conn.reportActivity('Editing x.py');
    await flush();

    // The line is posted with a live elapsed suffix, e.g. "Editing x.py · 0s".
    const details = runtimeDetails(fetchMock);
    expect(details.some((d) => d?.startsWith('Editing x.py'))).toBe(true);
    // The activity post keeps state 'working'.
    const activityCall = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/runtime-state'))
      .map((c) => JSON.parse((c[1] as RequestInit).body as string))
      .find((b) => typeof b.detail === 'string' && b.detail.startsWith('Editing x.py'));
    expect(activityCall.state).toBe('working');

    conn.stop();
  });

  it('starts the elapsed timer on the generic working message before any activity', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, [messageEvent(true)]);
    await flush();

    // The working turn posts a "working on it…" line with an elapsed suffix
    // immediately, without waiting for the first activity/status change.
    const details = runtimeDetails(fetchMock);
    expect(details.some((d) => d != null && /Working on it….*·\s*\d/.test(d))).toBe(true);

    conn.stop();
  });

  it('re-pushes the elapsed suffix on each tick with no activity reported', async () => {
    vi.useFakeTimers();
    try {
      const target: InjectionTarget = { write: vi.fn() };
      const { conn, fetchMock } = connect({ acquire: () => target }, [messageEvent(true)]);
      await vi.advanceTimersByTimeAsync(1);

      const before = runtimeDetails(fetchMock).filter(
        (d) => d != null && d.includes('Working on it…')
      ).length;

      // Advance past two ticker intervals (5s each) with no reportActivity call.
      await vi.advanceTimersByTimeAsync(11_000);

      const after = runtimeDetails(fetchMock).filter(
        (d) => d != null && d.includes('Working on it…')
      ).length;
      expect(after).toBeGreaterThan(before);

      conn.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dedupes consecutive identical activity lines', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, [messageEvent(true)]);
    await flush();

    conn.reportActivity('Reading a.ts');
    conn.reportActivity('Reading a.ts');
    await flush();

    const count = runtimeDetails(fetchMock).filter((d) => d?.startsWith('Reading a.ts')).length;
    expect(count).toBe(1);

    conn.stop();
  });

  it('ignores activity when no room turn is active', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    // No addressed message → no active turn.
    const { conn, fetchMock } = connect({ acquire: () => target }, []);
    await flush();

    conn.reportActivity('Editing x.py');
    await flush();

    expect(runtimeDetails(fetchMock).some((d) => d?.startsWith('Editing x.py'))).toBe(false);
    conn.stop();
  });

  it('stops posting after stop()', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, [messageEvent(true)]);
    await flush();
    conn.stop();
    const before = fetchMock.mock.calls.length;

    conn.onAgentStatusChange('working');
    await flush();

    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('reports control_capabilities in the runtime-state report', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, []);
    await flush();

    const body = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/runtime-state'))
      .map((c) => JSON.parse((c[1] as RequestInit).body as string))[0];
    expect(body.control_capabilities).toEqual({ reset: true, compact: true, interrupt: true });
    conn.stop();
  });

  it('executes an interrupt command as a raw ESC keystroke, not injected text', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn } = connect({ acquire: () => target }, [commandEvent('interrupt')]);
    await flush();

    expect(target.write).toHaveBeenCalledWith('\x1b');
    // No prompt was built/submitted for an interrupt.
    expect(target.write).not.toHaveBeenCalledWith('\r');
    conn.stop();
  });

  it('executes a compact by compacting then reconnecting, re-assuming role, and announcing', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn } = connect({ acquire: () => target }, [commandEvent('compact', 'worker')]);
    // Compact runs two steps spaced by CONTROL_STEP_GAP_MS (/compact then the
    // reconnect-and-announce prompt); wait past the gap so the second lands.
    await new Promise((r) => setTimeout(r, 800));

    const written = (target.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(written).toContain('<</compact>>');
    const reconnect = written.find((w) => w.includes('connect to switch room'));
    expect(reconnect).toContain('connect to switch room "Room One"');
    expect(reconnect).toContain('assume the role worker');
    expect(reconnect).toContain('context has been compacted');
    conn.stop();
  });

  it('executes a reset by clearing then reconnecting, re-assuming role, and announcing in-thread', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn } = connect({ acquire: () => target }, [
      commandEvent('reset', 'worker', '$cmd-thread'),
    ]);
    // Reset runs two steps spaced by CONTROL_STEP_GAP_MS (/clear then reconnect);
    // wait past that real-time gap so the second step lands.
    await new Promise((r) => setTimeout(r, 800));

    const written = (target.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(written).toContain('<</clear>>');
    const reconnect = written.find((w) => w.includes('connect to switch room'));
    expect(reconnect).toContain('connect to switch room "Room One"');
    expect(reconnect).toContain('assume the role worker');
    expect(reconnect).toContain('session has been reset');
    // The completion notice is addressed to the command sender and replies into
    // the originating command's thread.
    expect(reconnect).toContain('targeted message to u');
    expect(reconnect).toContain('threaded reply to message $cmd-thread');
    conn.stop();
  });

  it('bounds every fetch with an abort signal so a request cannot hang forever', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, []);
    await flush();

    // Every request carries a signal — the combined timeout+abort guard. Without
    // it a half-open socket would wedge the awaiting loop indefinitely.
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
    conn.stop();
  });

  it('recovers the renew loop when a renew request hangs (aborts and retries)', async () => {
    // First renew hangs until its signal aborts; later renews succeed. A wedge
    // would mean only the one hung call is ever seen.
    let renewCount = 0;
    const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes('/connection/renew')) {
        renewCount += 1;
        if (renewCount === 1) {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            );
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => '',
        });
      }
      if (u.includes('/events')) return new Promise(() => {});
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const conn = new RoomConnection({
      creds,
      roomId: 'room-1',
      roomName: 'Room One',
      sessionId: 'conv-1',
      sink: { acquire: () => ({ write: vi.fn() }) },
      injector,
      control,
      deeplinkScheme: 'switchdash',
      isHumanTyping: () => false,
      mediaDir,
      log: silentLog,
    });
    conn.start();

    // The hung renew aborts on its own request timeout (RENEW_REQUEST_TIMEOUT_MS),
    // then the loop backs off CONNECTION_RENEW_INTERVAL_MS and tries again. Wait
    // past the timeout + interval and confirm a second renew was attempted.
    await new Promise((r) => setTimeout(r, 4_000 + 2_000 + 500));
    expect(renewCount).toBeGreaterThanOrEqual(2);

    conn.stop();
  }, 15_000);

  it('reset without a prior role reconnects without an assume-role clause', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn } = connect({ acquire: () => target }, [commandEvent('reset', '')]);
    await new Promise((r) => setTimeout(r, 800));

    const written = (target.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    const reconnect = written.find((w) => w.includes('connect to switch room'));
    expect(reconnect).toContain('connect to switch room "Room One"');
    expect(reconnect).not.toContain('assume the role');
    conn.stop();
  });

  it('renews the role lease so an assumed role does not auto-release', async () => {
    // Without a /leases/renew heartbeat the server drops the seat within
    // LEASE_TTL (~6s), so any role assumed from a switchdash session releases
    // "instantly". Confirm the loop posts to /leases/renew.
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, []);
    await flush();

    const leaseCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/leases/renew'));
    expect(leaseCalls.length).toBeGreaterThanOrEqual(1);
    expect((leaseCalls[0][1] as RequestInit).method).toBe('POST');
    conn.stop();
  });
});
