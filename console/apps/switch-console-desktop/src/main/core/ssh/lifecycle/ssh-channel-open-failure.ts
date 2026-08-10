type ChannelOpenErrorLike = {
  message?: unknown;
  reason?: unknown;
};

const SSH_CHANNEL_OPEN_FAILURE_REASONS = new Set([1, 2, 3, 4]);

export function isSshChannelOpenFailure(error: unknown): boolean {
  const candidate = error as ChannelOpenErrorLike | undefined;
  const message =
    typeof candidate?.message === 'string'
      ? candidate.message
      : error instanceof Error
        ? error.message
        : String(error);
  const reason =
    typeof candidate?.reason === 'number' && SSH_CHANNEL_OPEN_FAILURE_REASONS.has(candidate.reason)
      ? candidate.reason
      : undefined;
  const lower = message.toLowerCase();

  if (
    reason !== undefined ||
    lower.includes('channel open failure') ||
    lower.includes('no more sessions') ||
    lower.includes('administratively prohibited')
  ) {
    return true;
  }

  return false;
}

/**
 * A channel open (exec / pty / direct-tcpip / sftp) that the server never
 * answered within the deadline. Distinct from a channel-open *refusal* (the
 * server answered "no"): a refusal usually means session exhaustion, while a
 * silent open is the signature of a wedged transport — TCP up, mux dead. Both
 * feed the connection manager's wedge watchdog.
 */
export class SshChannelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshChannelTimeoutError';
  }
}

export function isSshChannelTimeout(error: unknown): boolean {
  return error instanceof SshChannelTimeoutError;
}
