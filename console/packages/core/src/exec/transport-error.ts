/**
 * A command failed because the *transport* to the host failed (dead SSH
 * connection, channel open refused or timed out) — not because the command
 * itself ran and said no. Probe-style callers must treat the two differently:
 * "which git failed over a dead pipe" means UNKNOWN, not "git is missing".
 *
 * Detection is structural (the `transportFailure` marker) rather than
 * instanceof, so errors survive package boundaries and wrapping.
 */
export class TransportError extends Error {
  readonly transportFailure = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
  }
}

export function isTransportFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { transportFailure?: unknown }).transportFailure === true
  );
}
