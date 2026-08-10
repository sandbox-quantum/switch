/**
 * Reading an install's live output as one line of progress (CHOO-1809).
 *
 * Install commands run in a PTY, so what arrives is terminal output rather than
 * a log: escape sequences, and carriage returns that redraw the current line
 * instead of adding a new one. `apt-get` repaints `0% [Waiting for headers]`
 * dozens of times a second that way.
 *
 * What a user wants from that is the one line a terminal would be showing. This
 * reconstructs it, and nothing else — no history, no buffering of the whole
 * transcript (the failure path already keeps that).
 */

/** CSI sequences (colour, cursor moves), OSC strings (title sets), and the rest. */
const ANSI_ESCAPE =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

/** Backspaces, bells and friends: a terminal acts on these rather than showing them. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Long enough to carry a package name and what is happening to it; short enough
 * that a row does not reflow. Kept from the start of the line — apt puts the
 * subject first and the byte counts last.
 */
const MAX_LINE = 160;

function clean(raw: string): string {
  return raw.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARS, '').trim().slice(0, MAX_LINE);
}

export class InstallProgressReader {
  /** The line being drawn, which may still be mid-arrival. */
  private line = '';
  /** The last line that actually said something. */
  private latest = '';
  private lastTaken: string | null = null;

  /** Feed a chunk of raw PTY output. */
  push(chunk: string): void {
    // Both terminators end the current line. For a newline that starts a
    // genuinely new one; for a carriage return the same one is repainted. Only
    // the newest is ever shown, so the distinction does not matter here.
    const segments = chunk.split(/\r\n|\r|\n/);
    this.line += segments[0] ?? '';
    for (let i = 1; i < segments.length; i++) {
      this.settle();
      this.line = segments[i]!;
    }
  }

  /**
   * The current line, or null when there is nothing new worth showing.
   *
   * Blank output reports null rather than an empty string, and leaves the last
   * real message standing: every completed line leaves the cursor on an empty
   * one, and blanking the display for each of those would flicker.
   */
  take(): string | null {
    this.settle();
    if (!this.latest || this.latest === this.lastTaken) return null;
    this.lastTaken = this.latest;
    return this.latest;
  }

  private settle(): void {
    const current = clean(this.line);
    if (current) this.latest = current;
  }
}
