import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  type AgentEventStream,
  type AgentStreamDeps,
  type BoxValve,
  HUB_CLOSE,
  HUB_PROTOCOL,
  type HubClientMessage,
  hubClientMessageSchema,
  type HubServerMessage,
  isValveFrame,
  ValveServer,
} from '@switch-console/agent-providers-box';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import type { AgentHub } from './agent-hub';
import type { HostTickets } from './host-tickets';
import { errorMessage, type Logger } from './log';

/** How long an agent host has, once its socket is open, to say hello. */
const HELLO_TIMEOUT_MS = 10_000;
/**
 * The largest frame an agent host may send: its hello and placements, done
 * and valve messages are all far smaller. Past it `ws` closes the connection
 * (1009) before buffering more.
 */
export const HUB_MAX_FRAME_BYTES = 1024 * 1024;
/** How long closing waits for the agent hosts to see the close before cutting them. */
const CLOSE_GRACE_MS = 500;

type Served = {
  socket: WebSocket;
  stream: AgentEventStream | null;
  onValve: boolean;
  /** When this host connected (Date.now()), for the live status. */
  since: number;
};

/** The box valve on the hub: one for the box, joined by each proven host. */
export type HubValve = {
  valve: BoxValve;
  /** Resolves once the guard's holds are restored: no host joins before then. */
  ready: Promise<void>;
  /** Whether the connection from `peerPort` to the relay's `localPort` is the agent's own host. */
  trusted: (agentId: string, peerPort: number, localPort: number) => Promise<boolean>;
  /** The agent's share of the cap while its hub is down. */
  share: () => number;
};

/**
 * The hub over a WebSocket, for agent hosts that run in a process of their
 * own: each is an agent host on the hub exactly as one in this process is
 * (`AgentHub.open`), with every callback the hub makes sent to it as a request
 * and resolved when it answers `done`. So an event counts as taken once the
 * agent host has handled it, wherever it runs.
 *
 * Served on the relay's loopback port at `/hub`; the relay authenticates the
 * upgrade with the agent's relay token and hands it here with the agent named.
 */
export class HubSocket {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: HUB_MAX_FRAME_BYTES,
  });
  /** The agent host connected for each agent; a newer one takes the agent over. */
  private readonly served = new Map<string, Served>();

  constructor(
    private readonly deps: {
      hub: Pick<AgentHub, 'open'>;
      log: Logger;
      valve?: HubValve;
      /**
       * On a split box (the controller as its own user): every host must present the
       * one-time ticket the controller minted for its launch. A hello without
       * one, or with one spent, expired or another agent's, is refused, gets
       * no lease, and is logged as a WARN (C9). The ticket is the proof the
       * valve trusts, in place of reading `/proc`, which this user can't.
       */
      tickets?: Pick<HostTickets, 'take'>;
      /**
       * A ticketed host's connection closed and no other holds its agent: the
       * controller sends it a fresh ticket to reconnect with, if it still runs.
       */
      onTicketedClosed?: (agentId: string) => void;
      /**
       * The launch a ticket must belong to (`LauncherRunner.currentLaunch`): a
       * ticket for any other launch is refused as `stale_launch`.
       */
      currentLaunch?: (agentId: string) => number | null;
      /** A hello refused for its ticket, with the reason: the controller counts and relaunches. */
      onTicketRefused?: (agentId: string, reason: string) => void;
      /** A ticketed hello taken: the host is up. */
      onTicketTaken?: (agentId: string) => void;
    }
  ) {}

  /**
   * How many isolated hosts are connected, and how many of them joined the
   * box valve: if none could be proved, the box is back to per-host valves,
   * and the status says so.
   */
  valveHosts(): { joined: number; hosts: number } {
    let joined = 0;
    for (const entry of this.served.values()) if (entry.onValve) joined++;
    return { joined, hosts: this.served.size };
  }

  /** Each connected agent host: since when, and whether it joined the box valve (live status). */
  hosts(): Map<string, { since: number; onValve: boolean }> {
    const hosts = new Map<string, { since: number; onValve: boolean }>();
    for (const [agentId, entry] of this.served)
      hosts.set(agentId, { since: entry.since, onValve: entry.onValve });
    return hosts;
  }

  accept(agentId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head, (ws) =>
      this.serve(agentId, ws, { peer: req.socket.remotePort, local: req.socket.localPort })
    );
  }

  /**
   * Closes every agent host's socket as a restart (1012), so each reconnects
   * soon after the controller is back, and gives them a moment to read it.
   */
  async close(): Promise<void> {
    const closing = [...this.server.clients].map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === ws.CLOSED) return resolve();
          ws.once('close', () => resolve());
          ws.close(HUB_CLOSE.restarting, 'the agent controller is restarting');
        })
    );
    await Promise.race([
      Promise.all(closing),
      new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref()),
    ]);
    for (const ws of this.server.clients) ws.terminate();
    this.served.clear();
  }

  private serve(
    agentId: string,
    ws: WebSocket,
    ports: { peer: number | undefined; local: number | undefined } = {
      peer: undefined,
      local: undefined,
    }
  ): void {
    const { log } = this.deps;
    let valveServer: ValveServer | null = null;
    let valveDropped = 0;
    let valveDroppedLogged = Number.NEGATIVE_INFINITY;
    const lifetime = new AbortController();
    const waiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
    let nextId = 0;
    const entry: Served = { socket: ws, stream: null, onValve: false, since: Date.now() };

    const send = (message: HubServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const request = (message: (id: number) => HubServerMessage) =>
      new Promise<void>((resolve, reject) => {
        if (lifetime.signal.aborted)
          return reject(new Error('The agent host is no longer connected.'));
        const id = ++nextId;
        waiting.set(id, { resolve, reject });
        send(message(id));
      });

    const helloTimer = setTimeout(
      () => ws.close(HUB_CLOSE.refused, 'no hello within 10 s'),
      HELLO_TIMEOUT_MS
    );
    helloTimer.unref();

    let ticketed = false;
    const hello = (message: HubClientMessage & { type: 'hello' }) => {
      clearTimeout(helloTimer);
      if (this.deps.tickets) {
        const taken = message.ticket
          ? this.deps.tickets.take(agentId, message.ticket)
          : ({ ok: false, reason: 'missing' } as const);
        const reason = !taken.ok
          ? taken.reason
          : this.deps.currentLaunch && this.deps.currentLaunch(agentId) !== taken.launchId
            ? 'stale_launch'
            : null;
        if (reason !== null) {
          log.warn('Refused an agent host’s hub hello: its launch ticket was not good', {
            agentId,
            reason,
          });
          ws.close(HUB_CLOSE.refused, 'no good launch ticket');
          this.deps.onTicketRefused?.(agentId, reason);
          return;
        }
        ticketed = true;
        this.deps.onTicketTaken?.(agentId);
      }
      if (message.protocol !== HUB_PROTOCOL) {
        ws.close(
          HUB_CLOSE.refused,
          `hub protocol ${message.protocol} is not ${HUB_PROTOCOL}; restart the agent host`
        );
        return;
      }
      const previous = this.served.get(agentId);
      if (previous && previous.socket !== ws)
        previous.socket.close(
          HUB_CLOSE.takenOver,
          'another agent host for this agent connected to the hub'
        );
      this.served.set(agentId, entry);
      const streamDeps: AgentStreamDeps = {
        creds: { agentId, apiEndpoint: '', token: '' },
        connectionId: randomUUID(),
        scope: 'all',
        filter: 'addressed',
        rooms: [],
        ...(message.startCursor === null ? {} : { startCursor: message.startCursor }),
        log,
        signal: lifetime.signal,
        onEvent: (event) => request((id) => ({ type: 'event', id, event })),
        onGap: (gap) => request((id) => ({ type: 'gap', id, gap })),
        onSessionCommand: (command) => request((id) => ({ type: 'session_command', id, command })),
        onApprovalOutcome: (outcome) =>
          request((id) => ({ type: 'approval_outcome', id, outcome })),
        onRoomGone: ({ roomId, sessionId }) =>
          request((id) => ({ type: 'room_gone', id, roomId, sessionId })),
        onConnected: () => send({ type: 'connected' }),
        onDisconnected: ({ error }) => send({ type: 'disconnected', error }),
        onEvicted: () => {},
      };
      const stream = this.deps.hub.open(agentId, streamDeps);
      entry.stream = stream;
      if (Object.keys(message.placements).length)
        stream.replacePlacements(message.placements).catch((error: unknown) =>
          log.warn('Refused the placements an agent host reconnected with', {
            agentId,
            error: errorMessage(error),
          })
        );
      stream.start();
      log.info('An isolated agent host connected to the hub', {
        agentId,
        startCursor: message.startCursor,
      });
      void joinValve();
    };

    /**
     * Joins the box valve once the guard's holds are restored, and only if
     * the connection is proved to be the agent's own host process.
     */
    const joinValve = async () => {
      const hubValve = this.deps.valve;
      if (!hubValve?.valve.enabled) return;
      await hubValve.ready;
      if (lifetime.signal.aborted) return;
      // A spent ticket proves the host on split boxes; elsewhere, `/proc` does.
      const proven = this.deps.tickets
        ? ticketed
        : ports.peer !== undefined &&
          ports.local !== undefined &&
          (await hubValve.trusted(agentId, ports.peer, ports.local).catch(() => false));
      if (lifetime.signal.aborted) return;
      if (!proven) {
        log.warn(
          'An agent host’s hub connection could not be proved to be its own host process, so it stays on its narrower fallback valve',
          { agentId }
        );
        return;
      }
      valveServer = new ValveServer({
        valve: hubValve.valve,
        agentId,
        send,
        log,
        share: hubValve.share(),
      });
      entry.onValve = true;
    };

    const receive = (raw: RawData) => {
      const text = raw.toString();
      // The box valve's messages: checked by the valve's own rules, dropped
      // (never a close) when refused, and only from a proven host.
      if (isValveFrame(text)) {
        if (valveServer) valveServer.receive(text);
        else {
          valveDropped++;
          const now = Date.now();
          if (now - valveDroppedLogged >= 60_000) {
            valveDroppedLogged = now;
            log.warn('Dropped box valve messages from an agent host not on the valve', {
              agentId,
              dropped: valveDropped,
            });
            valveDropped = 0;
          }
        }
        return;
      }
      let message: HubClientMessage;
      try {
        message = hubClientMessageSchema.parse(JSON.parse(text));
      } catch (error) {
        log.warn('Closed a hub connection that sent something the hub does not read', {
          agentId,
          error: errorMessage(error),
        });
        ws.close(HUB_CLOSE.refused, 'unreadable message');
        return;
      }
      if (message.type === 'hello') {
        if (entry.stream) ws.close(HUB_CLOSE.refused, 'a second hello');
        else hello(message);
        return;
      }
      if (!entry.stream) {
        ws.close(HUB_CLOSE.refused, 'hello first');
        return;
      }
      if (message.type === 'done') {
        const call = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error === undefined) call?.resolve();
        else call?.reject(new Error(message.error));
        return;
      }
      entry.stream.replacePlacements(message.placements).then(
        ({ refusedRooms }) => send({ type: 'result', id: message.id, refusedRooms }),
        (error: unknown) => send({ type: 'result', id: message.id, error: errorMessage(error) })
      );
    };

    ws.on('message', receive);
    ws.on('close', () => {
      clearTimeout(helloTimer);
      lifetime.abort();
      valveServer?.close();
      valveServer = null;
      for (const call of waiting.values())
        call.reject(new Error('The agent host disconnected from the hub.'));
      waiting.clear();
      if (this.served.get(agentId) === entry) {
        this.served.delete(agentId);
        if (ticketed) this.deps.onTicketedClosed?.(agentId);
      }
    });
    ws.on('error', (error) =>
      log.warn('A hub connection failed', { agentId, error: errorMessage(error) })
    );
  }
}
