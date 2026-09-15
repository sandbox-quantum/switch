// EX_TEMPFAIL: the worker stopped for a recoverable reason and the supervisor must relaunch it.
export const LEASE_EXPIRED_EXIT_CODE = 75;

/**
 * The resident host stopped, but room sessions outlived the drain. The worker
 * exits on it rather than waiting on a child that may never go, so the
 * supervisor can fence what is left instead of hanging on it.
 */
export const STOP_INCOMPLETE_EXIT_CODE = 76;
