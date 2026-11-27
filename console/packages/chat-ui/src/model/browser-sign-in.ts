import type { BrowserSignInState } from '../contracts/machine-logins';

/** A `provider.login` operation as the server shows its owner, as far as a browser sign-in reads it. */
export type SignInOperation = {
  state: 'pending' | 'claimed' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  progress?: { sign_in?: { url: string; user_code?: string; needs_code: boolean } } | null;
  result: Record<string, unknown> | null;
};

/**
 * Where a browser sign-in stands, from its operation (undefined when it is
 * not listed yet): the machine's own reason for one that failed, else
 * `words` for one that ran out of time, was replaced, or failed saying
 * nothing. A page that is not https is never offered to open.
 */
export function browserSignInState(
  operation: SignInOperation | undefined,
  words: { expired: string; cancelled: string; failed: string }
): BrowserSignInState {
  if (!operation) return { state: 'starting' };
  if (operation.state === 'pending' || operation.state === 'claimed') {
    const signIn = operation.progress?.sign_in;
    if (!signIn || !signIn.url.startsWith('https://')) return { state: 'starting' };
    return {
      state: 'open',
      url: signIn.url,
      userCode: signIn.user_code ?? null,
      needsCode: signIn.needs_code,
    };
  }
  const error = operation.result?.error as { message?: string } | undefined;
  if (operation.state === 'succeeded' && !error) return { state: 'succeeded' };
  return {
    state: 'failed',
    message:
      error?.message ??
      (operation.state === 'expired'
        ? words.expired
        : operation.state === 'cancelled'
          ? words.cancelled
          : words.failed),
  };
}
