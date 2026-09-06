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
  let stopped = false;

  const ready = (async () => {
    // Started before the socket, not after. Events arrive the moment the stream
    // opens, and a turn that ran against an empty schedule which was then
    // replaced underneath it reads as a wake-up that silently went missing.
    await host.start();

    const stream = open({
      creds: deps.creds,
      connectionId: deps.connectionId,
      scope: 'multi',
      filter: 'all',
      rooms: deps.rooms,
      onEvent: (event: AgentBridgeEvent) => host.deliver(event),
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
  })();

  return {
    host,
    ready,
    async stop() {
      if (stopped) return;
      stopped = true;
      // Wait for the open to finish first, so a stop racing startup does not
      // leave a stream nobody holds a reference to.
      await ready.catch(() => {});
      abort.abort();
      await host.stop();
    },
  };
}
