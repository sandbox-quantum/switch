import { chmod, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { type LauncherAddress, netOptions } from './launcher-address';
import {
  encodeLine,
  type LauncherOrder,
  type LauncherReport,
  launcherReportSchema,
  LineReader,
  type LineRefusal,
} from './launcher-protocol';

/**
 * The controller's end of the launcher socket. The controller listens:
 * the launcher, and anything else running as the agents'
 * user, can connect, but can't put its own socket in the controller's place
 * (`/run/switch` is read-only in the agents container, C10).
 *
 * - **One launcher per boot, first wins:** a second connection while one is
 *   live is refused and logged, never taken as a replacement.
 * - **Silence means stop:** no `measure` for 6 s (3 samples) is `quiet`, and
 *   the controller stops admitting and parks; for 30 s, or a closed socket,
 *   is `lost`, and nothing is started. A launcher that comes back with a new
 *   `bootId` means the agents container restarted: every host is gone.
 * - Everything from the launcher is untrusted: one schema-checked line at a
 *   time, refusals logged by code, and malformed lines count as silence.
 */

export const QUIET_AFTER_MS = 6_000;
export const LOST_AFTER_MS = 30_000;
export const ORDER_TIMEOUT_MS = 60_000;

export type LinkState = 'waiting' | 'live' | 'quiet' | 'lost';

export type Measurement = Extract<LauncherReport, { kind: 'measure' }>;
type Reply = Extract<LauncherReport, { kind: 'reply' }>;
/** What the launcher sends back for one file request: replies and `files_chunk`s, in order. */
export type FileReport = Reply | Extract<LauncherReport, { kind: 'files_chunk' }>;
type FileOrder = Extract<LauncherOrder, { kind: 'files_list' | 'files_read' | 'files_zip' }>;
type FileFollowUp = Extract<LauncherOrder, { kind: 'files_more' | 'files_cancel' }>;
type FileOrderWithoutId = FileOrder extends infer O
  ? O extends FileOrder
    ? Omit<O, 'id'>
    : never
  : never;
type OrderWithoutId = LauncherOrder extends infer O
  ? O extends LauncherOrder
    ? Omit<O, 'id'>
    : never
  : never;

export type LauncherLinkDeps = {
  /** A Unix socket path (outside gVisor, and tests)... */
  socketPath?: string;
  /** ...or loopback inside the pod (`--launcher-address`): exactly one of the two. */
  address?: LauncherAddress;
  now: () => number;
  /** Fixed events with ids and numbers only. */
  log: (event: string, fields: Record<string, string | number>) => void;
  /** The state changed: the valve and status read it. */
  onState?: (state: LinkState) => void;
  /** A launcher said hello (every time): the controller sends it its settings. */
  onConnected?: () => void;
  /** A launcher said hello with a boot id other than the last: the agents container restarted. */
  onRestarted?: (bootId: string) => void;
  onMeasure?: (measurement: Measurement) => void;
  /**
   * Whether the controller launched this agent (C6): an `exited` for any
   * other is refused, counted and logged by code, never acted on.
   */
  launched?: (agentId: string) => boolean;
  onExited?: (
    agentId: string,
    launchId: number,
    reason: 'gone' | 'unconfirmed' | 'wrong_port'
  ) => void;
};

type LinkHandlers = Pick<
  LauncherLinkDeps,
  'onState' | 'onRestarted' | 'onMeasure' | 'onExited' | 'launched' | 'onConnected'
>;

export class LauncherLink {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (reply: Reply) => void; timer: NodeJS.Timeout }
  >();
  /** File requests (the file explorer), by launcher id: each gets every report under its id until it ends. */
  private readonly files = new Map<number, (report: FileReport) => void>();
  private lastMeasureAt: number | null = null;
  private lastBootId: string | null = null;
  /** Launchers greeted since this controller started, so a box whose launcher keeps reconnecting shows. */
  private greetings = 0;
  private state: LinkState = 'waiting';
  private connectedAt: number | null = null;
  /** Replies whose id wasn't outstanding. */
  unmatchedReplies = 0;
  /** `exited` reports for agents the controller didn't launch. */
  unknownExits = 0;

  private handlers: LinkHandlers;

  constructor(private readonly deps: LauncherLinkDeps) {
    this.handlers = {
      onState: deps.onState,
      onRestarted: deps.onRestarted,
      onMeasure: deps.onMeasure,
      onExited: deps.onExited,
      launched: deps.launched,
      onConnected: deps.onConnected,
    };
  }

  /** Sets what the link tells, for an owner made after it (the controller's valve and guard). */
  listenTo(handlers: LinkHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  private get address(): LauncherAddress {
    if (this.deps.address) return this.deps.address;
    if (this.deps.socketPath) return { kind: 'path', path: this.deps.socketPath };
    throw new Error('The launcher link needs a socket path or a loopback address.');
  }

  /**
   * Listens. On loopback: `127.0.0.1` only, the one port given, never another
   * (a taken port fails, for the caller to fail closed). On a socket path:
   * group-writable for the agents' user to connect (`0660`).
   */
  async listen(): Promise<void> {
    const address = this.address;
    if (address.kind === 'loopback') {
      const server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ ...netOptions(address), exclusive: true }, () => resolve());
      });
      this.server = server;
      return;
    }
    await rm(address.path, { force: true });
    this.server = createServer((socket) => this.accept(socket));
    // Made at 0660 from the start: the umask is set only around the
    // listen, so there's no moment at the default mode; chmod after makes sure.
    const before = process.umask(0o117);
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(address.path, () => resolve());
      });
    } finally {
      process.umask(before);
    }
    await chmod(address.path, 0o660);
  }

  async close(): Promise<void> {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.files.clear();
    this.socket?.destroy();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve()
    );
  }

  get current(): LinkState {
    return this.state;
  }

  /**
   * Re-judges silence by the controller's own clock; call it on a timer. A
   * launcher that stopped measuring, or never started, goes quiet then lost.
   */
  tick(): void {
    if (this.state === 'waiting' || this.state === 'lost') return;
    const since = this.lastMeasureAt ?? this.connectedAt ?? this.deps.now();
    const silent = this.deps.now() - since;
    if (silent >= LOST_AFTER_MS) this.lose('silent');
    else if (silent >= QUIET_AFTER_MS) this.setState('quiet');
  }

  /** Sends an order and waits for its reply; a lost link or no answer in time is a failed reply. */
  order(order: OrderWithoutId): Promise<Reply> {
    const id = this.nextId++;
    if (!this.socket || this.state === 'lost' || this.state === 'waiting')
      return Promise.resolve({ kind: 'reply', id, ok: false, code: 'launcher_lost' });
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ kind: 'reply', id, ok: false, code: 'timed_out' });
      }, ORDER_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, timer });
      this.socket!.write(encodeLine({ ...order, id } as LauncherOrder));
    });
  }

  /**
   * Starts a file request (the file explorer): every `reply` and `files_chunk`
   * under its id goes to `onReport`, in order, until `endFile`. Unlike `order`
   * it has no deadline of its own: the file relay keeps the request's deadline.
   * A lost link answers `launcher_lost` at once. Returns the launcher id.
   */
  startFile(order: FileOrderWithoutId, onReport: (report: FileReport) => void): number {
    const id = this.nextId++;
    if (!this.socket || this.state === 'lost' || this.state === 'waiting') {
      queueMicrotask(() => onReport({ kind: 'reply', id, ok: false, code: 'launcher_lost' }));
      return id;
    }
    this.files.set(id, onReport);
    this.socket.write(encodeLine({ ...order, id } as LauncherOrder));
    return id;
  }

  /** `files_more` or `files_cancel` for a file request still open; anything else is dropped. */
  followFile(kind: FileFollowUp['kind'], id: number): void {
    if (!this.files.has(id) || !this.socket) return;
    this.socket.write(encodeLine({ kind, id }));
  }

  /** The file request is over: later reports under its id count as unmatched. */
  endFile(id: number): void {
    this.files.delete(id);
  }

  private accept(socket: Socket): void {
    if (this.socket) {
      // First wins: a second connection is refused, never a replacement.
      this.deps.log('launcher_refused', { reason: 'already_connected' });
      socket.destroy();
      return;
    }
    this.socket = socket;
    this.connectedAt = this.deps.now();
    this.lastMeasureAt = null;
    let greeted = false;
    const reader = new LineReader<LauncherReport>(
      launcherReportSchema,
      (report) => {
        if (!greeted) {
          if (report.kind !== 'hello') {
            this.deps.log('launcher_refused', { reason: 'no_hello' });
            socket.destroy();
            return;
          }
          greeted = true;
          this.hello(report);
          return;
        }
        this.report(report);
      },
      (reason: LineRefusal) => this.deps.log('launcher_line_refused', { reason })
    );
    socket.on('data', (chunk: Buffer) => reader.feed(chunk));
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.lose('closed');
      }
    });
    socket.on('error', () => socket.destroy());
  }

  private hello(report: Extract<LauncherReport, { kind: 'hello' }>): void {
    const restarted = this.lastBootId !== null && this.lastBootId !== report.bootId;
    this.lastBootId = report.bootId;
    this.greetings += 1;
    // The first at INFO; any later one is a reconnect, logged at WARN with the count.
    this.deps.log(this.greetings === 1 ? 'launcher_connected' : 'launcher_reconnected', {
      version: report.version,
      connections: this.greetings,
    });
    this.setState('quiet'); // live only once it measures
    this.handlers.onConnected?.();
    if (restarted) this.handlers.onRestarted?.(report.bootId);
  }

  private report(report: LauncherReport): void {
    switch (report.kind) {
      case 'hello':
        this.deps.log('launcher_line_refused', { reason: 'second_hello' });
        return;
      case 'files_chunk': {
        const file = this.files.get(report.id);
        if (file) file(report);
        else this.unmatched();
        return;
      }
      case 'reply': {
        const file = this.files.get(report.id);
        if (file) {
          file(report);
          return;
        }
        const waiting = this.pending.get(report.id);
        if (!waiting) {
          this.unmatched();
          return;
        }
        clearTimeout(waiting.timer);
        this.pending.delete(report.id);
        waiting.resolve(report);
        return;
      }
      case 'measure':
        this.lastMeasureAt = this.deps.now();
        this.setState('live');
        this.handlers.onMeasure?.(report);
        return;
      case 'exited':
        if (this.handlers.launched && !this.handlers.launched(report.agentId)) {
          const count = ++this.unknownExits;
          if ((count & (count - 1)) === 0)
            this.deps.log('launcher_line_refused', { reason: 'unknown_agent', count });
          return;
        }
        this.handlers.onExited?.(report.agentId, report.launchId, report.reason ?? 'gone');
        return;
    }
  }

  /** An answer to nothing asked (or asked too long ago): ignored and counted. */
  private unmatched(): void {
    const count = ++this.unmatchedReplies;
    // The first, then at powers of two: a flood costs a few lines.
    if ((count & (count - 1)) === 0)
      this.deps.log('launcher_line_refused', { reason: 'unmatched_reply', count });
  }

  private lose(reason: 'closed' | 'silent'): void {
    if (this.state !== 'lost') this.deps.log('launcher_lost', { reason });
    for (const [id, { resolve, timer }] of this.pending) {
      clearTimeout(timer);
      resolve({ kind: 'reply', id, ok: false, code: 'launcher_lost' });
    }
    this.pending.clear();
    const files = [...this.files];
    this.files.clear();
    for (const [id, onReport] of files)
      onReport({ kind: 'reply', id, ok: false, code: 'launcher_lost' });
    if (reason === 'silent') this.socket?.destroy();
    this.setState('lost');
  }

  private setState(state: LinkState): void {
    if (state === this.state) return;
    this.state = state;
    this.handlers.onState?.(state);
  }
}
