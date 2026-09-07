/**
 * NOT WIRED — nothing calls `startMultiRoomAgent`. US-3.
 *
 * This is the entry point the US-3 cluster was built around, and no launcher
 * was ever written for it. See `docs/design/multi-surface-status.md` §3.
 */
/**
 * A running multi-room agent: the stream and the host, joined.
 *
 * Both halves are complete on their own and neither does anything alone. This
 * is the thirty lines that connect them, plus the clock the host needs in
 * production — and it is worth its own module because the failure mode of a
 * missing wire is *silence*, which from outside looks exactly like a quiet room.
 *
 * The stream has four callbacks and each has a counterpart here. `onEvicted`
 * was the one the host had nowhere to put when it was written, and it is the one
 * whose absence is worst: without it the agent keeps its rooms and keeps firing
 * scheduled work into them after another stream has taken the connection over,
 * receiving nothing and looking healthy throughout.
 */

import { SwitchEventStream, type SwitchEventStreamDeps } from './event-stream';
import { MultiRoomHost, type Clock, type HostLogger, type Turn } from './host';
import { MAX_TIMER_MS } from './schedule';
import type { AgentBridgeEvent, SwitchCredentials } from './types';

/** What `startMultiRoomAgent` hands to the stream. Injectable for tests. */
export type OpenStream = (deps: SwitchEventStreamDeps) => { start(): void };

/**
 * The clock a real agent runs on.
 *
 * The clamp is repeated here rather than left to `nextDelayMs`, because it
 * belongs where the timer is: Node keeps a delay in a 32-bit signed int and
 * anything larger fires *immediately*, so a caller that computes its own delay
 * and does not know that turns a monthly wake-up into a hot loop. Cheap to hold
 * in both places, expensive to be missing from this one.
 *
 * `now()` is wall-clock, deliberately — a schedule is written in wall-clock
 * terms — which does mean an NTP step or a suspended laptop moves every pending
 * wake-up. That is the right trade for "post the digest on Wednesday morning"
 * and the wrong one for measuring a duration; nothing here measures durations.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(delayMs: number, fire: () => void) {
    const safe = Math.min(Math.max(delayMs, 0), MAX_TIMER_MS);
    const handle = setTimeout(fire, safe);
    return () => clearTimeout(handle);
  },
};

export interface MultiRoomAgentDeps {
  creds: SwitchCredentials;
  /** Chosen by the caller and reused across reconnects. */
  connectionId: string;
  /** The surfaces this agent works across. */
  rooms: string[];
  onTurn(turn: Turn): Promise<void>;
  loadSchedule(): Promise<string>;
  saveSchedule(text: string): Promise<void>;
  log: HostLogger;
  clock?: Clock;
  /** Test seam. Production constructs a `SwitchEventStream`. */
  openStream?: OpenStream;
}

export interface RunningAgent {
  host: MultiRoomHost;
  /** Resolves once the schedule is loaded and the stream is open. */
  ready: Promise<void>;
  stop(): Promise<void>;
}

export function startMultiRoomAgent(deps: MultiRoomAgentDeps): RunningAgent {
  const host = new MultiRoomHost({
    rooms: deps.rooms,
    onTurn: deps.onTurn,
    loadSchedule: deps.loadSchedule,
    saveSchedule: deps.saveSchedule,
    clock: deps.clock ?? systemClock,
    log: deps.log,
  });

  const abort = new AbortController();
  const open = deps.openStream ?? ((streamDeps) => new SwitchEventStream(streamDeps));

  let stopRequested = false;

  const ready = (async () => {
    // Started before the socket, not after. Events arrive the moment the stream
    // opens, and a turn that ran against an empty schedule which was then
    // replaced underneath it reads as a wake-up that silently went missing.
    await host.start();
    if (stopRequested) {
      // Stopped while the schedule was loading. The host is running and armed
      // by now, so it has to be put back down — and no stream is opened, since
      // nobody would hold it.
      await host.stop();
      return;
    }

    const stream = open({
      creds: deps.creds,
      connectionId: deps.connectionId,
      scope: 'multi',
      filter: 'all',
      rooms: deps.rooms,
      // Discarded, not awaited. `handleFrame` awaits `onEvent`, so returning
      // the turn promise stops the reader for the whole turn — and then
      // `subscription_changed`, `gap` and `evicted` all queue behind it. The
      // host's re-check for a room claimed away *during* a turn could never see
      // one. Ordering is unaffected: `deliver` runs to its first await
      // synchronously and the chain is assigned there.
      onEvent: (event: AgentBridgeEvent) => {
        void host.deliver(event);
      },
      onRooms: (rooms: string[]) => host.acceptRooms(rooms),
      onGap: ({ fromSequence, reason }) =>
        // The sequence travels with the reason. It is the only thing telling
        // the agent how far back to re-read; without it the warning says only
        // that something, somewhere, was lost.
        host.noteGap(`${reason} (events from sequence ${fromSequence} were dropped)`),
      onEvicted: (reason: string) => host.evicted(reason),
      log: deps.log,
      signal: abort.signal,
    });
    stream.start();
  })().catch((error) => {
    // Startup failing is otherwise an unhandled rejection — fatal under Node's
    // default, with nothing tying it to the schedule that could not be read.
    // The host is already running and armed by this point, so it is stopped
    // too rather than left waking into a connection that never opened.
    deps.log.error('startMultiRoomAgent: failed to start', {
      error: error instanceof Error ? error.message : String(error),
    });
    void host.stop();
    throw error;
  });
  // Nothing else observes `ready`, and a caller is not obliged to.
  ready.catch(() => {});

  let stopping: Promise<void> | null = null;

  return {
    host,
    ready,
    stop() {
      // Memoised rather than flagged: a boolean set before the await lets a
      // second caller resolve while the first is still tearing down.
      stopping ??= (async () => {
        // `ready` is deliberately not awaited: a `loadSchedule` that hangs
        // would otherwise be a process that cannot shut down. Aborting before
        // the stream exists is safe — `streamLoop` and `beatLoop` both gate on
        // the signal — and `stopRequested` covers a startup that completes
        // after this, so the host cannot be left running behind us.
        stopRequested = true;
        abort.abort();
        await host.stop();
      })();
      return stopping;
    },
  };
}
