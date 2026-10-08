import {
  gatewaySocketTarget,
  type GatewaySocketTarget,
} from '@main/core/switch-servers/gateway-client';
import { withReachableServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { type UserChange, userChangesChannel } from '@shared/events/userChangesEvents';

/**
 * One change socket per server whose lists a window is showing
 * (`/gateway/changes/ws`), so those lists are read again when the server says
 * something changed instead of on a timer.
 *
 * Watched by reference count: a list that is shown calls `watch`, and the
 * socket closes when the last one is gone. While watched, a closed socket is
 * opened again with back-off. A server without the socket (older than it)
 * answers the handshake with an error and is tried again only rarely; until
 * the socket says hello, the lists keep polling, so nothing goes stale.
 */

/** Node's WebSocket, which, unlike a browser's, takes request headers. */
type HeaderedWebSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** Back-off after a handshake that never opened: likely a server without the socket. */
const UNSUPPORTED_RETRY_MS = 5 * 60_000;
/** Pings missed before the socket is taken for dead and opened again. */
const MISSED_PINGS = 3;

type Hello = { kinds: string[]; ping_interval_s: number };

export type UserChangesDeps = {
  target: (serverId: string) => Promise<GatewaySocketTarget>;
  socket: HeaderedWebSocket | undefined;
  emit: typeof events.emit;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
};

const defaultDeps: UserChangesDeps = {
  target: (serverId) =>
    withReachableServerWorkspaceSession(serverId, (server) =>
      gatewaySocketTarget(server, '/changes/ws')
    ),
  socket: (globalThis as unknown as { WebSocket?: HeaderedWebSocket }).WebSocket,
  emit: (...args) => events.emit(...args),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
};

class ServerSocket {
  watchers = 0;
  live = false;
  private socket: WebSocket | null = null;
  private retryMs = MIN_RETRY_MS;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly serverId: string,
    private readonly deps: UserChangesDeps
  ) {}

  start(): void {
    this.stopped = false;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) this.deps.clearTimer(this.retry);
    if (this.watchdog) this.deps.clearTimer(this.watchdog);
    this.retry = null;
    this.watchdog = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
    this.setDown();
  }

  private async open(): Promise<void> {
    if (this.stopped || this.socket) return;
    const Socket = this.deps.socket;
    if (!Socket) return; // No WebSocket in this runtime: the lists keep polling.
    let target: GatewaySocketTarget;
    try {
      target = await this.deps.target(this.serverId);
    } catch (error) {
      this.schedule(this.retryMs, `could not prepare: ${String(error)}`);
      return;
    }
    if (this.stopped) return;
    let opened = false;
    const socket = new Socket(target.url, { headers: target.headers });
    this.socket = socket;
    socket.addEventListener('open', () => {
      opened = true;
    });
    socket.addEventListener('message', (event) => this.onMessage(socket, event.data));
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.watchdog) this.deps.clearTimer(this.watchdog);
      this.setDown();
      // A handshake that never opened is most likely a server without the socket.
      this.schedule(opened ? this.retryMs : UNSUPPORTED_RETRY_MS, `closed (${event.code})`);
    });
  }

  private onMessage(socket: WebSocket, data: unknown): void {
    let frame: { event?: string; data?: Record<string, unknown> };
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (frame.event) {
      case 'hello': {
        const hello = frame.data as unknown as Hello;
        this.retryMs = MIN_RETRY_MS;
        this.live = true;
        this.arm(socket, hello.ping_interval_s);
        this.deps.emit(userChangesChannel, {
          serverId: this.serverId,
          type: 'live',
          kinds: hello.kinds,
        });
        return;
      }
      case 'ping':
        socket.send(JSON.stringify({ type: 'pong' }));
        this.arm(socket);
        return;
      case 'changed':
        this.deps.emit(userChangesChannel, {
          serverId: this.serverId,
          type: 'changed',
          changes: (frame.data?.changes ?? []) as UserChange[],
        });
        return;
      default:
        return; // `refused` is followed by the close that schedules the retry.
    }
  }

  private pingIntervalMs = 25_000;

  /** Take the socket for dead when the server goes quiet for `MISSED_PINGS` pings. */
  private arm(socket: WebSocket, pingIntervalS?: number): void {
    if (pingIntervalS !== undefined) this.pingIntervalMs = pingIntervalS * 1000;
    if (this.watchdog) this.deps.clearTimer(this.watchdog);
    this.watchdog = this.deps.setTimer(
      () => socket.close(4000),
      this.pingIntervalMs * MISSED_PINGS
    );
  }

  private setDown(): void {
    if (!this.live) return;
    this.live = false;
    this.deps.emit(userChangesChannel, { serverId: this.serverId, type: 'down' });
  }

  private schedule(ms: number, why: string): void {
    if (this.stopped) return;
    log.debug(`Change socket for server ${this.serverId} ${why}; retrying in ${ms} ms`);
    this.retry = this.deps.setTimer(() => {
      this.retry = null;
      void this.open();
    }, ms);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }
}

export function createUserChangesService(deps: UserChangesDeps = defaultDeps) {
  const sockets = new Map<string, ServerSocket>();
  return {
    /** A list for this server is shown: keep its change socket open. */
    watch(serverId: string): void {
      let socket = sockets.get(serverId);
      if (!socket) {
        socket = new ServerSocket(serverId, deps);
        sockets.set(serverId, socket);
      }
      socket.watchers += 1;
      if (socket.watchers === 1) socket.start();
    },
    /** The list is gone; close the socket once nothing watches it. */
    unwatch(serverId: string): void {
      const socket = sockets.get(serverId);
      if (!socket) return;
      socket.watchers = Math.max(0, socket.watchers - 1);
      if (socket.watchers === 0) {
        socket.stop();
        sockets.delete(serverId);
      }
    },
    /** Whether the server is pushing changes right now. */
    isLive(serverId: string): boolean {
      return sockets.get(serverId)?.live ?? false;
    },
  };
}

export const userChangesService = createUserChangesService();
