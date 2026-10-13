import { describe, expect, it } from 'vitest';
import {
  generateSealingKeyPair,
  openProviderLogin,
  sealedLoginSchema,
  sealingKeyId,
  sealProviderLogin,
} from './sealed-login';

const LOGIN = { kind: 'setup-token' as const, credential: 'sk-ant-oat-placeholder' };

describe('sealed provider logins', () => {
  it('opens only for the controller and provider it was sealed for', () => {
    const keys = generateSealingKeyPair();
    const sealed = sealProviderLogin({
      publicKey: keys.publicKey,
      controllerId: 'controller-1',
      provider: 'claude',
      login: LOGIN,
    });
    expect(sealedLoginSchema.parse(sealed).key_id).toBe(sealingKeyId(keys.publicKey));
    expect(sealed.ciphertext).not.toContain('sk-ant');
    expect(
      openProviderLogin({ keys, controllerId: 'controller-1', provider: 'claude', sealed })
    ).toEqual(LOGIN);
    expect(() =>
      openProviderLogin({ keys, controllerId: 'controller-2', provider: 'claude', sealed })
    ).toThrow(/does not open/);
    expect(() =>
      openProviderLogin({ keys, controllerId: 'controller-1', provider: 'codex', sealed })
    ).toThrow(/does not open/);
  });

  it('refuses another key and a tampered envelope', () => {
    const keys = generateSealingKeyPair();
    const other = generateSealingKeyPair();
    const sealed = sealProviderLogin({
      publicKey: keys.publicKey,
      controllerId: 'controller-1',
      provider: 'claude',
      login: LOGIN,
    });
    expect(() =>
      openProviderLogin({ keys: other, controllerId: 'controller-1', provider: 'claude', sealed })
    ).toThrow(/another key/);
    const body = Buffer.from(sealed.ciphertext, 'base64');
    body[0] = body[0]! ^ 1;
    expect(() =>
      openProviderLogin({
        keys,
        controllerId: 'controller-1',
        provider: 'claude',
        sealed: { ...sealed, ciphertext: body.toString('base64') },
      })
    ).toThrow(/does not open/);
  });

  it('names a key by the same id Core computes', () => {
    // sha256 of 32 zero bytes, as core/switch_core/management/sealed_logins.key_id gives it.
    expect(sealingKeyId(Buffer.alloc(32).toString('base64'))).toBe('66687aadf862bd77');
  });
});
