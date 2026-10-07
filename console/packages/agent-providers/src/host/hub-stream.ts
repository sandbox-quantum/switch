import {
  type AgentBridgeEvent,
  type ApprovalOutcome,
  EVICTION_TAKEN_OVER,
  type SessionCommand,
  type SwitchEventStreamDeps,
} from '@sandboxaq/switch-agent-runtime';
import { z } from 'zod';
import type { AgentEventStream, OpenAgentStream } from './agent-host';

/**
 * The agents controller's hub, over a WebSocket on the controller's loopback
 * relay: how an agent host in a process of its own (an `isolated` agent) hears
 * its agent's events. The controller holds the agent's connection to Switch
 * and hands each event to the hub; the hub hands it here, one at a time, and
 * counts it taken once this side's handler has resolved, exactly as it does
 * for an agent host in the controller's own process.
 *
 * Every request the hub makes carries an `id` and is answered with `done`;
 * `placements` from this side is answered with `result`. The agent is the one
 * the bearer token names.
 */
export const HUB_PATH = '/hub';
export const HUB_PROTOCOL = 1;

/** Closes the hub sends. */
export const HUB_CLOSE = {
  /** The controller is stopping or restarting: reconnect soon. */
  restarting: 1012,
  /** A newer agent host for the same agent took the hub over: stand down. */
  takenOver: 4409,
  /** The hello was missing, malformed, or named a protocol the hub does not speak. */
  refused: 4400,
} as const;

const placementsSchema = z.record(z.string().min(1), z.string().min(1));

export const hubClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocol: z.number().int(),
    startCursor: z.number().int().nonnegative().nullable(),
    placements: placementsSchema,
  }),
  z.object({ type: z.literal('done'), id: z.number().int(), error: z.string().optional() }),
  z.object({ type: z.literal('placements'), id: z.number().int(), placements: placementsSchema }),
]);
export type HubClientMessage = z.infer<typeof hubClientMessageSchema>;

export type HubGap = Parameters<SwitchEventStreamDeps['onGap']>[0];

export type HubServerMessage =
  | { type: 'connected' }
  | { type: 'disconnected'; error: string }
  | { type: 'event'; id: number; event: AgentBridgeEvent }
  | { type: 'gap'; id: number; gap: HubGap }
  | { type: 'session_command'; id: number; command: SessionCommand }
  | { type: 'approval_outcome'; id: number; outcome: ApprovalOutcome }
  | { type: 'result'; id: number; error?: string };

/** Node's WebSocket, which, unlike a browser's, takes request headers. */
type HeaderedWebSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;

/**
 * Opens the agent's stream on the controller's hub at `url`
 * (`ws://127.0.0.1:<relay port>/hub`), with the relay token the agent host
 * was given.
 */
export function openHubStream(url: string): OpenAgentStream {
  return (deps) => new HubEventStream(url, deps);
}

class HubEventStream implements AgentEventStream {
  /** The agent host, not Switch, tells a room when it starts a session for it. */
  readonly announcesSessionStarts = true;
  private started = false;
  private socket: WebSocket | null = null;
  /** The last sequence this side has handled; sent on every hello. */
  private cursor: number | null;
  private placements: Record<string, string> = {};
  private nextId = 0;
  private readonly calls = new Map<number, (error: string | undefined) => void>();
  /** Requests are handled one at a time, in the order they came. */
  private handling: Promise<void> = Promise.resolve();
  private standingDown = false;

  constructor(
    private readonly url: string,
    private readonly deps: SwitchEventStreamDeps
  ) {
    this.cursor = deps.startCursor ?? null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.run();
  }

  // Switch decides who may start a session from the agent's binding.
  setSpawnCapable(): void {}

  async replacePlacements(placements: Record<string, string>): Promise<void> {
    this.placements = { ...placements };
    const socket = this.socket;
    // Not connected: the next hello carries them.
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const id = ++this.nextId;
    const error = await new Promise<string | undefined>((resolve) => {
      this.calls.set(id, resolve);
      socket.send(JSON.stringify({ type: 'placements', id, placements }));
    });
    if (error !== undefined) throw new Error(error);
  }

  workerCall(): Promise<unknown> {
    return Promise.reject(
      new Error('An agent run by an agents controller is not a hosted worker.')
    );
  }

  private async run(): Promise<void> {
    const { signal, log } = this.deps;
    let backoff = INITIAL_BACKOFF_MS;
    let failures = 0;
    while (!signal.aborted && !this.standingDown) {
      const { code, reason, helloed } = await this.connectOnce();
      if (signal.aborted) return;
      if (code === HUB_CLOSE.takenOver) {
        this.standingDown = true;
        this.deps.onEvicted({
          code: EVICTION_TAKEN_OVER,
          reason: reason || 'another agent host for this agent took the controller hub over',
          roomId: null,
        });
        return;
      }
      const error = reason || `the agents controller hub closed (${code})`;
      this.deps.onDisconnected?.({ error });
      if (helloed) {
        backoff = INITIAL_BACKOFF_MS;
        failures = 0;
      }
      failures++;
      // The first failure, then powers of two: a long outage costs a few lines.
      if ((failures & (failures - 1)) === 0)
        log.warn(`The agents controller hub is unreachable (${error}); retrying.`);
      const wait = code === HUB_CLOSE.restarting ? INITIAL_BACKOFF_MS : backoff;
      await sleep(Math.round(wait * (0.5 + Math.random() * 0.5)), signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  /** One socket, from open to close. */
  private connectOnce(): Promise<{ code: number; reason: string; helloed: boolean }> {
    return new Promise((resolve) => {
      const Socket = (globalThis as { WebSocket?: HeaderedWebSocket }).WebSocket;
      if (!Socket) throw new Error('The agents controller hub needs Node 22 or newer.');
      const socket = new Socket(this.url, {
        headers: { Authorization: `Bearer ${this.deps.creds.token}` },
      });
      this.socket = socket;
      let helloed = false;
      const abort = () => socket.close(1000, 'the agent host is stopping');
      this.deps.signal.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', () => {
        helloed = true;
        socket.send(
          JSON.stringify({
            type: 'hello',
            protocol: HUB_PROTOCOL,
            startCursor: this.cursor,
            placements: this.placements,
          })
        );
      });
      socket.addEventListener('message', (message) => {
        let parsed: HubServerMessage;
        try {
          parsed = JSON.parse(String(message.data)) as HubServerMessage;
        } catch {
          this.deps.log.error('Dropped a message from the agents controller hub that is not JSON');
          return;
        }
        if (parsed.type === 'result') {
          const call = this.calls.get(parsed.id);
          this.calls.delete(parsed.id);
          call?.(parsed.error);
          return;
        }
        this.handling = this.handling.then(() => this.handle(socket, parsed));
      });
      socket.addEventListener('close', (event) => {
        this.deps.signal.removeEventListener('abort', abort);
        if (this.socket === socket) this.socket = null;
        // The placements a call was sending go again with the next hello.
        for (const call of this.calls.values()) call(undefined);
        this.calls.clear();
        resolve({ code: event.code, reason: event.reason, helloed });
      });
      // A failed handshake also closes; the close says what happened.
      socket.addEventListener('error', () => {});
    });
  }

  private async handle(socket: WebSocket, message: HubServerMessage): Promise<void> {
    const { deps } = this;
    if (message.type === 'connected') return deps.onConnected?.();
    if (message.type === 'disconnected') return deps.onDisconnected?.({ error: message.error });
    if (message.type === 'result') return;
    let error: string | undefined;
    try {
      switch (message.type) {
        case 'event':
          await deps.onEvent(message.event);
          if (typeof message.event.sequence === 'number')
            this.cursor = Math.max(this.cursor ?? 0, message.event.sequence);
          break;
        case 'gap':
          await deps.onGap(message.gap);
          if (message.gap.resumedAt !== undefined) this.cursor = message.gap.resumedAt;
          break;
        case 'session_command':
          await deps.onSessionCommand?.(message.command);
          break;
        case 'approval_outcome':
          await deps.onApprovalOutcome?.(message.outcome);
          break;
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: 'done', id: message.id, ...(error ? { error } : {}) }));
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
