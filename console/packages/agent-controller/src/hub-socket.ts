import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime';
import {
  type AgentEventStream,
  HUB_CLOSE,
  HUB_PROTOCOL,
  type HubClientMessage,
  hubClientMessageSchema,
  type HubServerMessage,
} from '@switch-console/agent-providers';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import type { AgentHub } from './agent-hub';
import { errorMessage, type Logger } from './log';

/** How long an agent host has, once its socket is open, to say hello. */
const HELLO_TIMEOUT_MS = 10_000;
/** How long closing waits for the agent hosts to see the close before cutting them. */
const CLOSE_GRACE_MS = 500;

type Served = { socket: WebSocket; stream: AgentEventStream | null };

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
  private readonly server = new WebSocketServer({ noServer: true });
  /** The agent host connected for each agent; a newer one takes the agent over. */
  private readonly served = new Map<string, Served>();

  constructor(
    private readonly deps: {
      hub: Pick<AgentHub, 'open'>;
      log: Logger;
    }
  ) {}

  accept(agentId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head, (ws) => this.serve(agentId, ws));
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
          ws.close(HUB_CLOSE.restarting, 'the agents controller is restarting');
        })
    );
    await Promise.race([
      Promise.all(closing),
      new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref()),
    ]);
    for (const ws of this.server.clients) ws.terminate();
    this.served.clear();
  }

  private serve(agentId: string, ws: WebSocket): void {
    const { log } = this.deps;
    const lifetime = new AbortController();
    const waiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
    let nextId = 0;
    const entry: Served = { socket: ws, stream: null };

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

    const hello = (message: HubClientMessage & { type: 'hello' }) => {
      clearTimeout(helloTimer);
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
      const streamDeps: SwitchEventStreamDeps = {
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
    };

    const receive = (raw: RawData) => {
      let message: HubClientMessage;
      try {
        message = hubClientMessageSchema.parse(JSON.parse(raw.toString()));
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
        () => send({ type: 'result', id: message.id }),
        (error: unknown) => send({ type: 'result', id: message.id, error: errorMessage(error) })
      );
    };

    ws.on('message', receive);
    ws.on('close', () => {
      clearTimeout(helloTimer);
      lifetime.abort();
      for (const call of waiting.values())
        call.reject(new Error('The agent host disconnected from the hub.'));
      waiting.clear();
      if (this.served.get(agentId) === entry) this.served.delete(agentId);
    });
    ws.on('error', (error) =>
      log.warn('A hub connection failed', { agentId, error: errorMessage(error) })
    );
  }
}
