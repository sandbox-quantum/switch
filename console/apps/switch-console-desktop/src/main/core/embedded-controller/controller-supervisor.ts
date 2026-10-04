import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { EmbeddedControllerPhase } from '@shared/core/embedded-controller/embedded-controller';

/** The controller's exit codes (see the agent-controller README). */
export const EXIT_CONFIGURATION = 2;
export const EXIT_REVOKED = 3;
export const EXIT_TAKEN_OVER = 4;

/** The part of a spawned `ChildProcess` the supervisor uses. */
export interface ControllerChild {
  readonly pid?: number;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

export type SpawnController = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }
) => ControllerChild;

/** How to start the controller this time: read afresh before every start. */
export type ControllerLaunch = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin and the pipe closed; never on argv, in env or on disk. */
  credential: string;
};

export type ControllerBackoff = {
  initialMs: number;
  maxMs: number;
  /** A run that lasts this long resets the backoff. */
  stableMs: number;
};

export const DEFAULT_BACKOFF: ControllerBackoff = {
  initialMs: 1_000,
  maxMs: 60_000,
  stableMs: 60_000,
};

export type ControllerLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type SupervisorDeps = {
  spawn: SpawnController;
  launch: () => Promise<ControllerLaunch>;
  onPhase: (phase: EmbeddedControllerPhase) => void;
  /** It exited in a way that must not be retried: the server revoked it, or another copy took over. */
  onFinal: (exit: 'revoked' | 'taken_over') => void;
  /** One line the controller wrote, at the level it wrote it at. */
  onLine: (level: ControllerLogLevel, line: string) => void;
  now: () => number;
  backoff: ControllerBackoff;
};

const LINE = /^\S+ (DEBUG|INFO|WARN|ERROR) /;
/** How the CLI prefixes the reason it stopped, on the last line it writes. */
const REASON_PREFIX = 'switch-agent-controller: ';
const KEPT_LINES = 10;

function levelOf(line: string, stream: 'stdout' | 'stderr'): ControllerLogLevel {
  const match = LINE.exec(line);
  if (match) return match[1]!.toLowerCase() as ControllerLogLevel;
  // An unformatted stderr line is the CLI's own failure message, or a crash.
  return stream === 'stderr' ? 'error' : 'info';
}

/**
 * Runs one embedded controller process, and starts it again when it exits on
 * its own, backing off while it keeps failing. It does not restart a
 * controller that was revoked (exit 3), taken over (exit 4) or stopped on a
 * configuration error (exit 2), which starting it again the same way would
 * repeat: those are handed to `onFinal` or reported as an error, with the
 * reason the controller gave.
 */
export class ControllerSupervisor {
  private child: ControllerChild | null = null;
  private exited: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopping = false;
  private recent: string[] = [];

  constructor(private readonly deps: SupervisorDeps) {}

  get running(): boolean {
    return this.child !== null;
  }

  start(): void {
    this.stopping = false;
    this.attempt = 0;
    this.clearRestart();
    if (this.child) return;
    void this.launchOnce();
  }

  /**
   * Stops supervising and asks the process to end (SIGTERM). The agents keep
   * running: the controller leaves its watchers up, and they reconnect when a
   * controller comes back. Escalates to SIGKILL after `timeoutMs`.
   */
  async stop(timeoutMs: number): Promise<void> {
    this.stopping = true;
    this.clearRestart();
    const child = this.child;
    const exited = this.exited;
    if (!child || !exited) return;
    child.kill('SIGTERM');
    if (await within(exited, timeoutMs)) return;
    child.kill('SIGKILL');
    await within(exited, 2_000);
  }

  /**
   * Stops supervising without signalling, and waits up to `timeoutMs` for the
   * process to end by itself (as it does once told it was revoked). Resolves
   * whether it did.
   */
  async release(timeoutMs: number): Promise<boolean> {
    this.stopping = true;
    this.clearRestart();
    if (!this.exited) return true;
    return within(this.exited, timeoutMs);
  }

  private async launchOnce(): Promise<void> {
    let launch: ControllerLaunch;
    try {
      launch = await this.deps.launch();
    } catch (error) {
      if (!this.stopping)
        this.deps.onPhase({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      return;
    }
    if (this.stopping || this.child) return;
    this.recent = [];
    const child = this.deps.spawn(launch.executable, launch.args, {
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let resolveExited!: () => void;
    this.exited = new Promise<void>((resolve) => (resolveExited = resolve));
    const finish = (code: number | null, signal: NodeJS.Signals | null, failure: Error | null) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = null;
      resolveExited();
      this.handleExit(code, signal, failure);
    };
    child.once('error', (error) => finish(null, null, error));
    child.once('exit', (code, signal) => finish(code, signal, null));
    this.read(child.stdout, 'stdout');
    this.read(child.stderr, 'stderr');
    // A child that died before reading closes the pipe under us; its exit says why.
    child.stdin?.on('error', () => {});
    child.stdin?.end(launch.credential);
    this.deps.onPhase({ kind: 'running', since: new Date(this.deps.now()).toISOString() });
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.attempt = 0;
    }, this.deps.backoff.stableMs);
  }

  private read(stream: Readable | null, which: 'stdout' | 'stderr'): void {
    if (!stream) return;
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (!line) return;
      if (which === 'stderr') {
        this.recent.push(line);
        if (this.recent.length > KEPT_LINES) this.recent.shift();
      }
      this.deps.onLine(levelOf(line, which), line);
    });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, failure: Error | null) {
    if (this.stopping) return;
    if (failure) {
      this.deps.onPhase({
        kind: 'error',
        message: `The agents controller could not be started: ${failure.message}`,
      });
      return;
    }
    if (code === EXIT_REVOKED) return this.deps.onFinal('revoked');
    if (code === EXIT_TAKEN_OVER) return this.deps.onFinal('taken_over');
    if (code === EXIT_CONFIGURATION) {
      this.deps.onPhase({
        kind: 'error',
        message: `The agents controller cannot run as it is set up: ${this.lastWords() ?? 'it gave no reason'}`,
      });
      return;
    }
    this.attempt += 1;
    const delay = Math.min(
      this.deps.backoff.maxMs,
      this.deps.backoff.initialMs * 2 ** (this.attempt - 1)
    );
    const how = code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`;
    const words = this.lastWords();
    this.deps.onPhase({
      kind: 'restarting',
      attempt: this.attempt,
      retryAt: new Date(this.deps.now() + delay).toISOString(),
      lastExit: words ? `${how}: ${words}` : how,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) void this.launchOnce();
    }, delay);
  }

  /**
   * Why it stopped: the reason the CLI gave as it exited, else the last thing
   * it said that was not routine.
   */
  private lastWords(): string | null {
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const line = this.recent[i]!;
      if (line.startsWith(REASON_PREFIX)) return line.slice(REASON_PREFIX.length);
    }
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const line = this.recent[i]!;
      const level = levelOf(line, 'stderr');
      if (level === 'error' || level === 'warn') return line.replace(LINE, '');
    }
    return null;
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
}

async function within(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
