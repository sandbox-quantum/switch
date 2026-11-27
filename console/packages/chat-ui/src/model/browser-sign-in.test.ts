import { describe, expect, it } from 'vitest';
import { browserSignInState, type SignInOperation } from './browser-sign-in';

const WORDS = { expired: 'ran out', cancelled: 'replaced', failed: 'did not sign in' };

function operation(extra: Partial<SignInOperation>): SignInOperation {
  return { state: 'claimed', progress: null, result: null, ...extra };
}

describe('browserSignInState', () => {
  it('is starting until the machine reports its page', () => {
    expect(browserSignInState(undefined, WORDS)).toEqual({ state: 'starting' });
    expect(browserSignInState(operation({ state: 'pending' }), WORDS)).toEqual({
      state: 'starting',
    });
  });

  it('offers the page the machine reported, and the code to type there', () => {
    expect(
      browserSignInState(
        operation({
          progress: {
            sign_in: { url: 'https://auth.example/device', user_code: 'AB-12', needs_code: false },
          },
        }),
        WORDS
      )
    ).toEqual({
      state: 'open',
      url: 'https://auth.example/device',
      userCode: 'AB-12',
      needsCode: false,
    });
  });

  it('never offers a page that is not https', () => {
    expect(
      browserSignInState(
        operation({ progress: { sign_in: { url: 'javascript:alert(1)', needs_code: true } } }),
        WORDS
      )
    ).toEqual({ state: 'starting' });
  });

  it("ends with the machine's reason, or words of its own", () => {
    expect(browserSignInState(operation({ state: 'succeeded', result: {} }), WORDS)).toEqual({
      state: 'succeeded',
    });
    expect(
      browserSignInState(
        operation({ state: 'failed', result: { error: { message: 'code refused' } } }),
        WORDS
      )
    ).toEqual({ state: 'failed', message: 'code refused' });
    expect(browserSignInState(operation({ state: 'expired' }), WORDS)).toEqual({
      state: 'failed',
      message: 'ran out',
    });
    expect(browserSignInState(operation({ state: 'cancelled' }), WORDS)).toEqual({
      state: 'failed',
      message: 'replaced',
    });
  });
});
