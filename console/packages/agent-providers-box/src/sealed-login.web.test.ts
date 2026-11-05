import { describe, expect, it } from 'vitest';
import { openProviderLogin, sealingKeyId } from './sealed-login';

/**
 * A login sealed in a browser by Switch web's `sealLogin()` (WebCrypto,
 * `gateway/src/data/sealLogin.ts`), opened here with the box controller's real
 * opener. If either side's wire format changes, this fails. The keys are
 * throwaway test keys and the credential is not a real one.
 */
const WEB_SEALED = {
  keys: {
    publicKey: 'IrjBneXnzBGmTuMNdRlMKtVD7YXglYSaZSpkoSBQ73I=',
    privateKey: 'mK9YFSnL+gcY/ye+4HkkiK7eVYX/u+CQzDECYtOqRUM=',
  },
  controllerId: 'ctl-fixture',
  provider: 'claude',
  login: { kind: 'api-key', credential: 'sk-test-FIXTURE-not-a-real-key' },
  sealed: {
    alg: 'X25519-HKDF-SHA256-A256GCM' as const,
    key_id: '8505b05b4f4c6f2a',
    ephemeral_key: 'qh92VjE6EvWweftDb6jNmtIsKJKOO5NzXaXl1kXzlFE=',
    nonce: 'T0si9baGBBbvhGs5',
    ciphertext:
      'yAsKZ38p164Xl+GzujF5QTt51X7OgcDP9oCHxahGH8ZAjM8tDLRO53EZUBhnewT7aqKIvsXOoKP92eJyYqfyJl3wlk5iinAf10F4IMoHpCg=',
  },
};

describe('a login sealed by Switch web', () => {
  const { keys, controllerId, provider, sealed, login } = WEB_SEALED;

  it('names the controller key by the same id', () => {
    expect(sealingKeyId(keys.publicKey)).toBe(sealed.key_id);
  });

  it('opens with the controller opener', () => {
    expect(openProviderLogin({ keys, controllerId, provider, sealed })).toEqual(login);
  });

  it('opens only for the controller and provider it was sealed for', () => {
    expect(() => openProviderLogin({ keys, controllerId: 'ctl-other', provider, sealed })).toThrow(
      /does not open/
    );
    expect(() => openProviderLogin({ keys, controllerId, provider: 'codex', sealed })).toThrow(
      /does not open/
    );
  });

  it('refuses a changed ciphertext', () => {
    const body = Buffer.from(sealed.ciphertext, 'base64');
    body[0] ^= 1;
    const changed = { ...sealed, ciphertext: body.toString('base64') };
    expect(() => openProviderLogin({ keys, controllerId, provider, sealed: changed })).toThrow(
      /does not open/
    );
  });
});
