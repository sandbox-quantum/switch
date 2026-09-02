import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InjectionTarget } from './injection-sink';
import { MAX_ROOM_TURN_MS, type PromptInjector, RoomConnection } from './room-connection';
import { resolveSessionControl } from './session-control';
import type { AgentBridgeEvent, AttachmentRef } from './switch-event-format';

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

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
  attachments: AttachmentRef[] = [],
  messageId = 'msg-1'
): AgentBridgeEvent {
  return {
    type: 'message',
    room_id: 'room-1',
    payload: {
      addressed,
      sender: '@someone:switch',
      sender_name: 'Someone',
      message_id: messageId,
      body: 'hello agent',
      timestamp: 1,
      thread_id: threadId,
      attachments,
    },
  };
}

/**
 * Serves one batch of events on the `/events` SSE stream, then holds the stream
 * open (never closing it) so the connection neither reconnects nor spins.
 *
 * The stream is the transport under test, so this speaks real SSE framing —
 * `event:`/`id:`/`data:` — rather than handing the client pre-parsed objects.
 * `connection/beat` and `runtime-state` always succeed; their request bodies
 * are captured on the returned mock for assertions.
 */
function sseBody(events: AgentBridgeEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'event: connection_state\n' +
            `data: ${JSON.stringify({ connection_id: 'c1', rooms: ['room-1'], cursor: 0 })}\n\n`
        )
      );
      events.forEach((event, i) => {
        controller.enqueue(
          encoder.encode(
            `id: ${i + 1}\nevent: ${event.type}\n` +
              `data: ${JSON.stringify({ ...event, sequence: i + 1 })}\n\n`
          )
        );
      });
      // Deliberately left open: closing would look like a dropped stream and
      // trigger a reconnect mid-assertion.
    },
  });
}

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
        return { ok: true, status: 200, body: sseBody(events), text: async () => '' };
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

function runtimeAnchors(fetchMock: ReturnType<typeof makeFetch>): (string | null)[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/runtime-state'))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string).anchor_event_id);
}

/** Anchors carried on `working` posts only — the bridge ignores the anchor on
 * any other state, so those carry whatever happened to be set. */
function workingAnchors(fetchMock: ReturnType<typeof makeFetch>): (string | null)[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/runtime-state'))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string))
    .filter((b) => b.state === 'working')
    .map((b) => b.anchor_event_id);
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
    isHumanTyping: () => boolean = () => false,
    spawnTurn: { threadId: string | null; anchorId: string | null } | null = null
  ) {
    const fetchMock = makeFetch(events);
    vi.stubGlobal('fetch', fetchMock);
    const conn = new RoomConnection({
      creds,
      roomId: 'room-1',
      roomName: 'Room One',
      connectionId: 'conn-1',
      sessionId: 'session-1',
      sink,
      injector,
      control,
      deeplinkScheme: 'switchdash',
      isHumanTyping,
      mediaDir,
      spawnTurn,
      log: silentLog,
    });
    conn.start();
    return { conn, fetchMock };
  }

  /**
   * The turn a spawned session was started for (CHOO-2173).
   *
   * Addressing an agent with no session gets "Starting a session to handle
   * this" — and then, until now, nothing. The message that caused the spawn
   * travels in the session's opening prompt, because it arrives before there is
   * a terminal to type into, so no injection ever opens the turn. That made the
   * first turn the one turn that reported no state at all: no working, and on
   * Mattermost no indicator and no typing.
   */
  describe('the turn a session was spawned to answer', () => {
    const idleSink = { acquire: () => null };

    it('reports working on reaching the room, with nobody having injected anything', async () => {
      const { conn, fetchMock } = connect(idleSink, [], () => false, {
        threadId: null,
        anchorId: 'msg-42',
      });
      await flush();
      conn.stop();

      expect(runtimeStates(fetchMock)[0]).toBe('working');
    });

    it('reports against the message that is waiting, not the room root', async () => {
      // So the indicator and Mattermost's typing land where the asking happened.
      const { conn, fetchMock } = connect(idleSink, [], () => false, {
        threadId: 'thread-9',
        anchorId: 'msg-42',
      });
      await flush();
      conn.stop();

      expect(workingAnchors(fetchMock)[0]).toBe('msg-42');
    });

    it('still goes idle when the agent finishes', async () => {
      // The turn has to close, or the indicator spins for the session's life.
      const { conn, fetchMock } = connect(idleSink, [], () => false, {
        threadId: null,
        anchorId: 'msg-42',
      });
      await flush();
      conn.onAgentStatusChange('completed');
      await flush();
      conn.stop();

      expect(runtimeStates(fetchMock)).toContain('idle');
    });

    it('opens the turn once, not again on every reconnect', async () => {
      const { conn, fetchMock } = connect(idleSink, [], () => false, {
        threadId: null,
        anchorId: 'msg-42',
      });
      await flush();
      conn.onAgentStatusChange('completed');
      await flush();
      // A second arrival in the same room must not re-raise a turn that is done.
      (conn as unknown as { adoptRoom: (rooms: string[]) => void }).adoptRoom(['room-2']);
      await flush();
      conn.stop();

      expect(runtimeStates(fetchMock).filter((s) => s === 'working')).toHaveLength(1);
    });

    it('a session nobody is waiting on reports idle, as before', async () => {
      const { conn, fetchMock } = connect(idleSink, []);
      await flush();
      conn.stop();

      expect(runtimeStates(fetchMock)).not.toContain('working');
    });
  });

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

  it('downloads and annotates non-image attachments', async () => {
    fs.rmSync(mediaDir, { recursive: true, force: true });
    const target: InjectionTarget = { write: vi.fn() };
    // A structural-biology file: an arbitrary mimetype the app has never heard
    // of must still reach the agent.
    const attachment: AttachmentRef = {
      filename: 'tyk2_ejm_31_minimized.pdb',
      mimetype: 'chemical/x-pdb',
      size: 3,
      mxc: 'mxc://switch.test/pdb',
      msgtype: 'm.file',
    };
    const { conn, fetchMock } = connect({ acquire: () => target }, [
      messageEvent(true, null, [attachment]),
    ]);

    await flush();

    const mediaCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/media'));
    expect(mediaCalls.length).toBe(1);
    expect(String(mediaCalls[0][0])).toContain(encodeURIComponent(attachment.mxc));

    const injected = vi.mocked(target.write).mock.calls.map((c) => c[0])[0];
    expect(injected).toContain('1 file attached');
    expect(injected).toContain(mediaDir);

    conn.stop();
    fs.rmSync(mediaDir, { recursive: true, force: true });
  });

  it('annotates images and other files separately in one message', async () => {
    fs.rmSync(mediaDir, { recursive: true, force: true });
    const target: InjectionTarget = { write: vi.fn() };
    const attachments: AttachmentRef[] = [
      {
        filename: 'shot.png',
        mimetype: 'image/png',
        size: 3,
        mxc: 'mxc://switch.test/png',
        msgtype: 'm.image',
      },
      {
        filename: 'notes.md',
        mimetype: 'text/markdown',
        size: 3,
        mxc: 'mxc://switch.test/md',
        msgtype: 'm.file',
      },
      {
        filename: 'data.csv',
        mimetype: 'text/csv',
        size: 3,
        mxc: 'mxc://switch.test/csv',
        msgtype: 'm.file',
      },
    ];
    const { conn, fetchMock } = connect({ acquire: () => target }, [
      messageEvent(true, null, attachments),
    ]);

    await flush();

    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/media')).length).toBe(3);
    const injected = vi.mocked(target.write).mock.calls.map((c) => c[0])[0];
    expect(injected).toContain('1 image attached');
    expect(injected).toContain('2 files attached');

    conn.stop();
    fs.rmSync(mediaDir, { recursive: true, force: true });
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

  it('delivers the message once the session has a terminal to type into', async () => {
    // The bug this guards (CHOO-2173): a session auto-started to answer a room
    // message opens this connection before its terminal exists, so the very
    // message it was started for arrives with nowhere to go. The dialog and
    // operator-typing gates both come back on a timer; this one did not, and
    // waited on an unrelated event that on a fresh session never came — so the
    // agent booted, said hello, and never saw what it was asked.
    vi.useFakeTimers();
    try {
      const target: InjectionTarget = { write: vi.fn() };
      let live = false;
      const { conn } = connect({ acquire: () => (live ? target : null) }, [messageEvent(true)]);

      await vi.advanceTimersByTimeAsync(1);
      expect(target.write).not.toHaveBeenCalled();

      live = true;
      // NO_TARGET_RETRY_MS.
      await vi.advanceTimersByTimeAsync(500);

      expect(vi.mocked(target.write).mock.calls.map((c) => c[0])[0]).toContain('<<');
      conn.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops looking for a terminal once the connection is stopped', async () => {
    vi.useFakeTimers();
    try {
      const target: InjectionTarget = { write: vi.fn() };
      let live = false;
      const { conn } = connect({ acquire: () => (live ? target : null) }, [messageEvent(true)]);

      await vi.advanceTimersByTimeAsync(1);
      conn.stop();

      live = true;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(target.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  // The bridge repositions the runtime indicator only when the anchor CHANGES,
  // and only ever to a message the agent has actually been handed — so these
  // report what the session has seen, never what merely arrived in the room.

  it('reports the addressed message as the anchor for the turn it starts', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, [
      messageEvent(true, null, [], 'msg-alpha'),
    ]);

    await flush();

    expect(runtimeAnchors(fetchMock)).toContain('msg-alpha');
    conn.stop();
  });

  it('moves the anchor to a follow-up message injected mid-turn', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, [
      messageEvent(true, null, [], 'msg-alpha'),
      messageEvent(true, null, [], 'msg-beta'),
    ]);

    await flush(12);
    // Force a push rather than waiting out the 5s refresh; the anchor rides on
    // whatever the next runtime-state post happens to be.
    conn.reportActivity('Editing x.py');
    await flush();

    const anchors = runtimeAnchors(fetchMock);
    expect(anchors.at(-1)).toBe('msg-beta');
    conn.stop();
  });

  it('does not anchor to a message the agent was never handed', async () => {
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, [
      messageEvent(true, null, [], 'msg-alpha'),
      // Unaddressed: surfaced as context only, so it must not look like the
      // agent turned its attention to it.
      messageEvent(false, null, [], 'msg-unaddressed'),
    ]);

    await flush(12);
    conn.reportActivity('Editing x.py');
    await flush();

    expect(runtimeAnchors(fetchMock)).not.toContain('msg-unaddressed');
    conn.stop();
  });

  it('stops reporting a live anchor once the turn ends', async () => {
    // The refresh is what keeps re-reporting the anchor. If it outlived the
    // turn it would go on naming a finished turn's message as the live one.
    vi.useFakeTimers();
    try {
      const target: InjectionTarget = { write: vi.fn() };
      const { conn, fetchMock } = connect({ acquire: () => target }, [
        messageEvent(true, null, [], 'msg-alpha'),
      ]);
      await vi.advanceTimersByTimeAsync(1);

      conn.onAgentStatusChange('idle');
      await vi.advanceTimersByTimeAsync(1);
      const settled = workingAnchors(fetchMock).length;

      await vi.advanceTimersByTimeAsync(16_000);

      expect(workingAnchors(fetchMock).length).toBe(settled);
      conn.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('repeats the current anchor on the periodic refresh so it moves nothing', async () => {
    vi.useFakeTimers();
    try {
      const target: InjectionTarget = { write: vi.fn() };
      const { conn, fetchMock } = connect({ acquire: () => target }, [
        messageEvent(true, null, [], 'msg-alpha'),
      ]);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(11_000);

      const anchors = workingAnchors(fetchMock);
      expect(anchors.length).toBeGreaterThan(1);
      expect(anchors.every((a) => a === 'msg-alpha')).toBe(true);

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

  it('recovers the heartbeat when a beat request hangs (aborts and retries)', async () => {
    // First beat hangs until its signal aborts; later beats succeed. A wedge
    // would mean only the one hung call is ever seen — and a heartbeat that has
    // stopped is a connection the server declares dead within its 6s TTL.
    let beats = 0;
    const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes('/connection/beat')) {
        beats += 1;
        if (beats === 1) {
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
      connectionId: 'conn-1',
      sessionId: 'session-1',
      sink: { acquire: () => ({ write: vi.fn() }) },
      injector,
      control,
      deeplinkScheme: 'switchdash',
      isHumanTyping: () => false,
      mediaDir,
      log: silentLog,
    });
    conn.start();

    // The hung beat aborts on its own request timeout (4s), which counts as a
    // failure, so the loop waits out one backoff (4s) before trying again.
    await new Promise((r) => setTimeout(r, 4_000 + 4_000 + 1_000));
    expect(beats).toBeGreaterThanOrEqual(2);

    conn.stop();
  }, 20_000);

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

  it('sends one heartbeat and none of the three renews it replaced', async () => {
    // /connection/renew, /leases/renew and /watch/heartbeat collapse into
    // /connection/beat. The server unions connection liveness into presence and
    // role-lease liveness, so the seat and the session survive on this alone —
    // still posting the old renews would be duplicate work against endpoints
    // this client no longer depends on.
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, []);
    await flush();

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    const beats = urls.filter((u) => u.includes('/connection/beat'));
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(urls.some((u) => u.includes('/connection/renew'))).toBe(false);
    expect(urls.some((u) => u.includes('/leases/renew'))).toBe(false);
    expect(urls.some((u) => u.includes('/watch/heartbeat'))).toBe(false);
    conn.stop();
  });

  it('reports its cursor on every beat so a reconnect can resume', async () => {
    // The cursor is what the whole transport turns on: without it the server
    // cannot know what this client has consumed, and resume degrades to the
    // poll's "whatever is in the queue now".
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, [messageEvent(true)]);
    // Past one beat interval: the first beat fires before the stream has
    // delivered anything, so a second is needed to observe the cursor move.
    await new Promise((r) => setTimeout(r, 2_500));

    const beats = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/connection/beat'));
    expect(beats.length).toBeGreaterThanOrEqual(1);
    const bodies = beats.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies[0].connection_id).toEqual(expect.any(String));
    // The first beat fires before anything has been read, so it legitimately
    // reports 0; what matters is that the cursor is reported and advances once
    // an event has been delivered.
    expect(bodies[bodies.length - 1].cursor).toBeGreaterThanOrEqual(1);
    conn.stop();
  }, 10_000);

  it('declares its room when opening the stream, not after', async () => {
    // A room subscribed after the stream opens arrives too late for catch-up:
    // buffered events for it are skipped as "not covered" AND the cursor is
    // advanced past them, losing exactly what resume exists to recover.
    const target: InjectionTarget = { write: vi.fn() };
    const { conn, fetchMock } = connect({ acquire: () => target }, []);
    await flush();

    const open = fetchMock.mock.calls.find((c) => String(c[0]).includes('/events'));
    expect(open).toBeDefined();
    expect(String(open![0])).toContain('rooms=room-1');
    expect((open![1] as RequestInit).headers).toMatchObject({
      Accept: 'text/event-stream',
    });
    conn.stop();
  });

  /**
   * A gap is reported by the server on routine reconnects — an aged-out cursor,
   * a restarted process. It used to be injected the moment it arrived, which
   * woke the session and spent a turn to say "you might have missed something
   * you might not care about". These pin the replacement: still never silent,
   * but carried on the next event the session was going to receive anyway.
   */
  describe('gap handling', () => {
    /** Serves a `gap` frame, then `events`, on one stream left open. */
    function sseBodyAfterGap(events: AgentBridgeEvent[]): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: connection_state\n' +
                `data: ${JSON.stringify({ connection_id: 'c1', rooms: ['room-1'], cursor: 0 })}\n\n`
            )
          );
          controller.enqueue(
            encoder.encode(
              'event: gap\n' +
                `data: ${JSON.stringify({
                  from_sequence: 7,
                  resumed_at: 7,
                  reason: 'the server restarted since your last connection',
                })}\n\n`
            )
          );
          events.forEach((event, i) => {
            controller.enqueue(
              encoder.encode(
                `id: ${i + 1}\nevent: ${event.type}\n` +
                  `data: ${JSON.stringify({ ...event, sequence: i + 1 })}\n\n`
              )
            );
          });
        },
      });
    }

    function connectAfterGap(events: AgentBridgeEvent[]) {
      let served = false;
      const fetchMock = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/events')) {
          if (!served) {
            served = true;
            return {
              ok: true,
              status: 200,
              body: sseBodyAfterGap(events),
              text: async (): Promise<string> => '',
            };
          }
          return new Promise(() => {});
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async (): Promise<string> => '',
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      const target: InjectionTarget = { write: vi.fn() };
      const conn = new RoomConnection({
        creds,
        roomId: 'room-1',
        roomName: 'Room One',
        connectionId: 'conn-1',
        sessionId: 'session-1',
        sink: { acquire: () => target },
        injector,
        control,
        deeplinkScheme: 'switchdash',
        isHumanTyping: () => false,
        mediaDir,
        log: silentLog,
      });
      conn.start();
      return { conn, target };
    }

    function writes(target: InjectionTarget): string[] {
      return (target.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    }

    it('does not wake the session for a gap on its own', async () => {
      const { conn, target } = connectAfterGap([]);
      await flush(8);

      expect(writes(target)).toEqual([]);
      // Silent to the session, but not silent: it is on the record.
      expect(silentLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('gap'),
        expect.objectContaining({ fromSequence: 7 })
      );
      conn.stop();
    });

    it('carries the gap warning on the next event it surfaces', async () => {
      const { conn, target } = connectAfterGap([messageEvent(true)]);
      await flush(8);

      const injected = writes(target).find((w) => w.includes('addressed you'));
      expect(injected).toBeDefined();
      expect(injected).toContain('dropped and cannot be replayed');
      expect(injected).toContain('read_context');
      conn.stop();
    });

    it('carries the warning once, not on every subsequent event', async () => {
      const { conn, target } = connectAfterGap([messageEvent(true), messageEvent(true)]);
      await flush(12);

      const warned = writes(target).filter((w) => w.includes('dropped and cannot be replayed'));
      expect(warned).toHaveLength(1);
      conn.stop();
    });
  });

  /**
   * An endpoint that is simply gone — a managed server's port after the stack
   * was destroyed — used to produce an unbounded stream of warnings: two renew
   * loops retrying every 2s with no backoff, plus a watchdog announcing the
   * staleness they were already reporting. One heartbeat replaced all three;
   * these keep the lesson attached to it.
   */
  describe('heartbeat against a dead endpoint', () => {
    /** Fails every beat; parks the stream so only the heartbeat is under test. */
    function makeFailingFetch(shouldFail: () => boolean) {
      return vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/connection/beat')) {
          if (shouldFail()) throw new TypeError('fetch failed');
          return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }
        if (u.includes('/events')) return new Promise(() => {});
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      });
    }

    function connectWith(fetchMock: ReturnType<typeof makeFailingFetch>) {
      vi.stubGlobal('fetch', fetchMock);
      const conn = new RoomConnection({
        creds,
        roomId: 'room-1',
        roomName: 'Room One',
        connectionId: 'conn-1',
        sessionId: 'session-1',
        sink: { acquire: () => ({ write: vi.fn() }) },
        injector,
        control,
        deeplinkScheme: 'switchdash',
        isHumanTyping: () => false,
        mediaDir,
        log: silentLog,
      });
      conn.start();
      return conn;
    }

    function warnings(match: string): unknown[][] {
      return silentLog.warn.mock.calls.filter((call) => String(call[0]).includes(match));
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('backs off instead of beating every two seconds forever', async () => {
      vi.useFakeTimers();
      const fetchMock = makeFailingFetch(() => true);
      const conn = connectWith(fetchMock);

      await vi.advanceTimersByTimeAsync(120_000);
      const attempts = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('/connection/beat')
      ).length;

      // A beat that has already missed the server's 6s TTL cannot save the
      // connection — reopening the stream is what does that — so hammering at
      // the healthy cadence buys nothing. Unbounded retries would be ~60 in two
      // minutes; capped at 30s it settles near a tenth of that.
      expect(attempts).toBeLessThan(15);
      conn.stop();
    });

    it('reports the outage on a curve rather than once per attempt', async () => {
      vi.useFakeTimers();
      const conn = connectWith(makeFailingFetch(() => true));

      await vi.advanceTimersByTimeAsync(120_000);

      const reported = warnings('heartbeat failed');
      expect(reported.length).toBeGreaterThan(0);
      expect(reported.length).toBeLessThan(8);
      // The first failure is always reported, with the endpoint that failed.
      expect(reported[0][1]).toMatchObject({
        endpoint: 'https://switch.test',
        failures: 1,
      });
      conn.stop();
    });

    it('says so when the endpoint comes back', async () => {
      vi.useFakeTimers();
      let failing = true;
      const conn = connectWith(makeFailingFetch(() => failing));

      await vi.advanceTimersByTimeAsync(60_000);
      failing = false;
      await vi.advanceTimersByTimeAsync(60_000);

      const recovered = warnings('heartbeat recovered');
      expect(recovered).toHaveLength(1);
      expect(recovered[0][1]).toMatchObject({ event: 'switch_beat_recovered' });
      conn.stop();
    });
  });
});

/**
 * The room comes from the server, on this connection's own stream.
 *
 * Switch Console used to learn it by reading the agent's `connect_to_room` tool
 * response through a hook — inference about another process, from a payload
 * shape nobody had agreed to keep stable. It broke the moment that shape
 * changed, and the failure was silent: no room in the sidebar, and no
 * connection started either, because both hang off the same dispatch.
 *
 * Now the session's tool call lands on this connection, the server claims the
 * room on it, and says so.
 */
describe('the room is set by the server', () => {
  function sseWithFrames(frames: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
      },
    });
  }

  function connectWithFrames(frames: string[], roomId: string | null = null) {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/events')) {
        return {
          ok: true,
          status: 200,
          body: sseWithFrames(frames),
          text: async (): Promise<string> => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async (): Promise<string> => '',
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const rooms: (string | null)[] = [];
    const conn = new RoomConnection({
      creds,
      roomId,
      roomName: null,
      connectionId: 'conn-1',
      sessionId: 'session-1',
      sink: { acquire: () => ({ write: vi.fn() }) },
      injector,
      control,
      deeplinkScheme: 'switchdash',
      isHumanTyping: () => false,
      mediaDir,
      onRoomChanged: (room) => rooms.push(room),
      log: silentLog,
    });
    conn.start();
    return { conn, rooms, fetchMock };
  }

  it('opens with no room when the session has not connected to one yet', async () => {
    const { conn, fetchMock } = connectWithFrames([]);
    await flush();

    const open = fetchMock.mock.calls.find((c) => String(c[0]).includes('/events'));
    expect(String(open?.[0])).not.toContain('rooms=');
    expect(conn.room).toBeNull();
    conn.stop();
  });

  it('takes the room from connection_state', async () => {
    const { conn, rooms } = connectWithFrames([
      `event: connection_state\ndata: ${JSON.stringify({ rooms: ['room-9'] })}\n\n`,
    ]);
    await flush(8);

    expect(conn.room).toBe('room-9');
    expect(rooms).toEqual(['room-9']);
    conn.stop();
  });

  it('follows a subscription_changed when the session moves room', async () => {
    const { conn, rooms } = connectWithFrames([
      `event: connection_state\ndata: ${JSON.stringify({ rooms: ['room-9'] })}\n\n`,
      `event: subscription_changed\ndata: ${JSON.stringify({ rooms: ['room-10'] })}\n\n`,
    ]);
    await flush(8);

    expect(conn.room).toBe('room-10');
    expect(rooms).toEqual(['room-9', 'room-10']);
    conn.stop();
  });

  it('does not re-announce a room that has not changed', async () => {
    // The server repeats the room on every reconnect; treating each as a change
    // would rewrite the session→room mapping and re-emit to the renderer for
    // nothing.
    const { conn, rooms } = connectWithFrames([
      `event: connection_state\ndata: ${JSON.stringify({ rooms: ['room-9'] })}\n\n`,
      `event: subscription_changed\ndata: ${JSON.stringify({ rooms: ['room-9'] })}\n\n`,
    ]);
    await flush(8);

    expect(rooms).toEqual(['room-9']);
    conn.stop();
  });

  it('reports the room going away', async () => {
    const { conn, rooms } = connectWithFrames([
      `event: connection_state\ndata: ${JSON.stringify({ rooms: ['room-9'] })}\n\n`,
      `event: subscription_changed\ndata: ${JSON.stringify({ rooms: [] })}\n\n`,
    ]);
    await flush(8);

    expect(conn.room).toBeNull();
    expect(rooms).toEqual(['room-9', null]);
    conn.stop();
  });

  it('declares a room it already knows, so catch-up covers it', async () => {
    // A restored or adopted session: we know the room before the stream opens,
    // and buffered events for it must be part of the first read.
    const { conn, fetchMock } = connectWithFrames([], 'room-known');
    await flush();

    const open = fetchMock.mock.calls.find((c) => String(c[0]).includes('/events'));
    expect(String(open?.[0])).toContain('rooms=room-known');
    conn.stop();
  });

  it('reports the room it declared once the server confirms it', async () => {
    // A session launched into a room declares it at open, and the server answers
    // with the same room. That answer is the only signal the rest of the app
    // gets that the session is in it — deduping it against the declared value
    // left the session showing as room-less until the agent's own
    // connect_to_room arrived, which can be a long time and may never come.
    const { conn, rooms } = connectWithFrames(
      [`event: connection_state\ndata: ${JSON.stringify({ rooms: ['room-declared'] })}\n\n`],
      'room-declared'
    );
    await flush(8);

    expect(conn.room).toBe('room-declared');
    expect(rooms).toEqual(['room-declared']);
    conn.stop();
  });

  it('ignores a control command that arrives before the room is known', async () => {
    // `reset` re-types a prompt naming the room; naming the wrong one would
    // move the session. Refusing beats guessing.
    const { conn } = connectWithFrames([
      `id: 1\nevent: command\ndata: ${JSON.stringify({
        type: 'command',
        room_id: 'room-9',
        payload: { command: 'reset', args: '', user_id: '@u', user_name: 'u', thread_id: null },
      })}\n\n`,
    ]);
    await flush(8);

    expect(
      silentLog.warn.mock.calls.some((c) => String(c[0]).includes('control command before'))
    ).toBe(true);
    conn.stop();
  });
});

/**
 * A session spawned to answer a message must start from before that message.
 *
 * The watcher consumed the triggering event — that is how it knew to spawn — so
 * by the time the session's connection opens, the message is already behind
 * head. Opening at head starts the session *after* the one thing it exists to
 * handle, and it comes up to silence.
 *
 * This worked before the push transport by accident: the notification queue and
 * the per-room queue were separate, so consuming one left the other intact.
 * With a single buffer and per-connection cursors, the start position has to be
 * passed explicitly.
 */
describe('a spawned session starts from its trigger', () => {
  function openWith(startCursor: number | undefined) {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/events')) {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({ start() {} }),
          text: async (): Promise<string> => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async (): Promise<string> => '',
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const conn = new RoomConnection({
      creds,
      roomId: null,
      roomName: null,
      connectionId: 'conn-1',
      startCursor,
      sessionId: 'session-1',
      sink: { acquire: () => ({ write: vi.fn() }) },
      injector,
      control,
      deeplinkScheme: 'switchdash',
      isHumanTyping: () => false,
      mediaDir,
      log: silentLog,
    });
    conn.start();
    return { conn, fetchMock };
  }

  function openUrl(fetchMock: ReturnType<typeof vi.fn>): string {
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/events'));
    return String(call?.[0]);
  }

  it('opens at the given cursor rather than at head', async () => {
    const { conn, fetchMock } = openWith(41);
    await flush();

    expect(openUrl(fetchMock)).toContain('start_from=41');
    expect(openUrl(fetchMock)).not.toContain('start_from=head');
    conn.stop();
  });

  it('sends Last-Event-ID so the server resumes from there', async () => {
    const { conn, fetchMock } = openWith(41);
    await flush();

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/events'));
    expect(call).toBeDefined();
    expect((call![1] as RequestInit).headers).toMatchObject({ 'Last-Event-ID': '41' });
    conn.stop();
  });

  it('still opens at head when nothing triggered the session', async () => {
    // A session the operator started themselves has no message waiting for it;
    // replaying history into it would be wrong.
    const { conn, fetchMock } = openWith(undefined);
    await flush();

    expect(openUrl(fetchMock)).toContain('start_from=head');
    conn.stop();
  });
});

/**
 * A restored session claims the room we remembered for it.
 *
 * Normally the room arrives from the server, because the session's
 * `connect_to_room` claims it on this connection. A resumed session never
 * calls the tool again — it does not re-run its initial prompt — so nothing is
 * coming. Waiting leaves the connection room-less forever: the session is
 * silent, and the watcher spawns a duplicate for the next message.
 */
describe('repointing a restored session', () => {
  it('claims the remembered room on the existing connection', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/events')) {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({ start() {} }),
          text: async (): Promise<string> => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async (): Promise<string> => '',
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const conn = new RoomConnection({
      creds,
      roomId: null,
      roomName: null,
      connectionId: 'conn-1',
      sessionId: 'session-1',
      sink: { acquire: () => ({ write: vi.fn() }) },
      injector,
      control,
      deeplinkScheme: 'switchdash',
      isHumanTyping: () => false,
      mediaDir,
      log: silentLog,
    });
    conn.start();
    await flush();

    await conn.repointTo('room-remembered', 'Remembered');

    const subscribe = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/connection/subscribe')
    );
    expect(subscribe).toBeDefined();
    expect(String((subscribe![1] as RequestInit).body)).toContain('room-remembered');
    conn.stop();
  });

  it('does nothing when it already holds that room', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/events')) {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({ start() {} }),
          text: async (): Promise<string> => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async (): Promise<string> => '',
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const conn = new RoomConnection({
      creds,
      roomId: 'room-1',
      roomName: 'Room One',
      connectionId: 'conn-1',
      sessionId: 'session-1',
      sink: { acquire: () => ({ write: vi.fn() }) },
      injector,
      control,
      deeplinkScheme: 'switchdash',
      isHumanTyping: () => false,
      mediaDir,
      log: silentLog,
    });
    conn.start();
    await flush();

    await conn.repointTo('room-1', 'Room One');

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/connection/subscribe'))).toBe(
      false
    );
    conn.stop();
  });
});

/**
 * A turn that cannot end (CHOO-2274).
 *
 * Measured on a live deployment: a session reported `working` against a room it
 * no longer held, every five seconds, for 32 hours. The server rejected each
 * report — the room id it carried was null — and nothing here noticed, because
 * the only thing that ever closed a turn was the agent going idle, and that
 * signal was never coming. Three ways out now: the room being withdrawn, the
 * report being refused, and the clock.
 */
describe('a turn that cannot end', () => {
  function pushable() {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return { stream, push: (frame: string) => controller.enqueue(encoder.encode(frame)) };
  }

  /** A session already in a room, already mid-turn: exactly the shape the
   * stuck session was in. `spawnTurn` opens the turn as `start()` runs. */
  function workingSession(opts: { runtimeStateStatus?: number } = {}) {
    const { stream, push } = pushable();
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/events')) {
        return { ok: true, status: 200, body: stream, text: async (): Promise<string> => '' };
      }
      if (u.includes('/runtime-state') && opts.runtimeStateStatus) {
        return {
          ok: false,
          status: opts.runtimeStateStatus,
          text: async (): Promise<string> => 'room_id must be a string',
        };
      }
      return { ok: true, status: 200, text: async (): Promise<string> => '' };
    });
    vi.stubGlobal('fetch', fetchMock);
    const conn = new RoomConnection({
      creds,
      roomId: 'room-1',
      roomName: 'Room One',
      connectionId: 'conn-1',
      sessionId: 'session-1',
      sink: { acquire: () => ({ write: vi.fn() }) },
      injector,
      control,
      deeplinkScheme: 'switchdash',
      isHumanTyping: () => false,
      mediaDir,
      spawnTurn: { threadId: 'thread-1', anchorId: 'msg-1' },
      log: silentLog,
    });
    conn.start();
    return { conn, fetchMock, push };
  }

  function loggedAt(level: 'warn' | 'error', fragment: string): boolean {
    return silentLog[level].mock.calls.some((c) => String(c[0]).includes(fragment));
  }

  /** runtime-state posts only: the heartbeat keeps beating regardless, and it
   * is the reporting that must stop. */
  function reports(fetchMock: { mock: { calls: unknown[][] } }): number {
    return fetchMock.mock.calls.filter((c) => String(c[0]).includes('/runtime-state')).length;
  }

  beforeEach(() => {
    silentLog.debug.mockClear();
    silentLog.info.mockClear();
    silentLog.warn.mockClear();
    silentLog.error.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ends when the server withdraws the room', async () => {
    const { conn, fetchMock, push } = workingSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtimeStates(fetchMock)).toContain('working');

    push(`event: subscription_changed\ndata: ${JSON.stringify({ rooms: [] })}\n\n`);
    await vi.advanceTimersByTimeAsync(0);

    expect(loggedAt('warn', 'the room was withdrawn')).toBe(true);
    expect(conn.room).toBeNull();

    // The ticker is what kept the 422s coming; nothing more may be reported.
    const settled = reports(fetchMock);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports(fetchMock)).toBe(settled);
    conn.stop();
  });

  it('gives up when the room keeps refusing the report', async () => {
    const { conn, fetchMock } = workingSession({ runtimeStateStatus: 422 });
    await vi.advanceTimersByTimeAsync(0);

    // Five consecutive refusals: the opening push plus four ticks.
    await vi.advanceTimersByTimeAsync(4 * 5_000);
    expect(loggedAt('error', 'abandoning the turn')).toBe(true);

    const settled = reports(fetchMock);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports(fetchMock)).toBe(settled);
    conn.stop();
  });

  it('gives up when the turn outruns the wall clock', async () => {
    const { conn, fetchMock } = workingSession();
    await vi.advanceTimersByTimeAsync(0);

    vi.setSystemTime(Date.now() + MAX_ROOM_TURN_MS);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(loggedAt('error', 'outrun the cap')).toBe(true);
    // The room is told the turn is over rather than left showing "working".
    expect(runtimeStates(fetchMock).at(-1)).toBe('idle');

    const settled = reports(fetchMock);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports(fetchMock)).toBe(settled);
    conn.stop();
  });

  it('keeps ticking while the reports land', async () => {
    const { conn, fetchMock } = workingSession();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(loggedAt('error', 'abandoning the turn')).toBe(false);
    expect(runtimeStates(fetchMock).filter((s) => s === 'working').length).toBeGreaterThan(4);
    conn.stop();
  });
});

/**
 * A room the server refuses outright.
 *
 * The open is refused, not the room — so the connection never gets as far as a
 * room list, and re-declaring the same dead room means never connecting again.
 * Measured on a live deployment at roughly 29 errors a minute, for over a day,
 * with no path back.
 */
