import { execFile } from 'node:child_process';
import type { InjectionSink, InjectionTarget } from './injection-sink';
import type { RoomConnectionLogger } from './room-connection';

/**
 * Runs a `tmux` subcommand with the given argv (no shell). Fire-and-forget:
 * send-keys is a fast local command and the caller does not await it.
 */
export type TmuxRun = (args: string[]) => void;

/**
 * Production tmux runner: shells out to the `tmux` binary with `execFile` (argv
 * array, no shell), so payloads containing control bytes (e.g. bracketed-paste
 * markers) pass through verbatim without quoting hazards. Failures are logged,
 * never swallowed silently.
 */
export function createTmuxRun(log: RoomConnectionLogger, tmuxBin = 'tmux'): TmuxRun {
  return (args) => {
    execFile(tmuxBin, args, (error) => {
      if (error) {
        log.warn('tmux: command failed', { args, error: String(error) });
      }
    });
  };
}

/**
 * Injects keystrokes into a tmux pane via `tmux send-keys -l` — the on-VM
 * counterpart to PtyInjectionSink. Used by the remote sidecar, where the agent
 * runs in a tmux session rather than a local node-pty; `-l` sends the bytes
 * literally so a multiline bracketed-paste payload is delivered unchanged.
 *
 * `isLive` reports whether the target pane currently exists; the sidecar owns
 * the tmux session lifecycle, so it supplies the predicate. When the pane is
 * gone `acquire` returns null and the RoomConnection defers the injection.
 */
export class TmuxInjectionSink implements InjectionSink, InjectionTarget {
  constructor(
    private readonly target: string,
    private readonly run: TmuxRun,
    private readonly isLive: () => boolean
  ) {}

  acquire(): InjectionTarget | null {
    return this.isLive() ? this : null;
  }

  write(data: string): void {
    this.run(['send-keys', '-t', this.target, '-l', '--', data]);
  }
}
