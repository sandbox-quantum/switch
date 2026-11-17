import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SEALED_LOGIN_ALG, sealProviderLogin } from './seal-login';

/** A machine's keypair as a controller makes it: each half's raw 32 bytes, base64. */
function machineKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const raw = (b64url: string) => Buffer.from(b64url, 'base64url').toString('base64');
  return {
    publicKey: raw(publicKey.export({ format: 'jwk' }).x!),
    privateKey: raw(privateKey.export({ format: 'jwk' }).d!),
  };
}

/** Opens a sealed login the way the controller does (`openProviderLogin`), with Node's crypto. */
function open(
  keys: { publicKey: string; privateKey: string },
  controllerId: string,
  provider: string,
  sealed: { ephemeral_key: string; nonce: string; ciphertext: string }
) {
  const url = (b64: string) => Buffer.from(b64, 'base64').toString('base64url');
  const shared = diffieHellman({
    privateKey: createPrivateKey({
      key: { kty: 'OKP', crv: 'X25519', d: url(keys.privateKey), x: url(keys.publicKey) },
      format: 'jwk',
    }),
    publicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: url(sealed.ephemeral_key) },
      format: 'jwk',
    }),
  });
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([
        Buffer.from(sealed.ephemeral_key, 'base64'),
        Buffer.from(keys.publicKey, 'base64'),
      ]),
      Buffer.from('switch provider login v1'),
      32
    )
  );
  const body = Buffer.from(sealed.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(`switch-provider-login-v1\n${controllerId}\n${provider}`));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return JSON.parse(
    Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString(
      'utf8'
    )
  );
}

describe('sealProviderLogin', () => {
  it('seals a login only the machine it was sealed to opens, for its controller and provider', async () => {
    const keys = machineKeys();
    const sealed = await sealProviderLogin({
      publicKey: keys.publicKey,
      controllerId: 'controller-1',
      provider: 'claude',
      login: { kind: 'api-key', credential: '  sk-ant-test  ' },
    });
    expect(sealed.alg).toBe(SEALED_LOGIN_ALG);
    expect(sealed.key_id).toBe(
      createHash('sha256').update(Buffer.from(keys.publicKey, 'base64')).digest('hex').slice(0, 16)
    );
    expect(open(keys, 'controller-1', 'claude', sealed)).toEqual({
      kind: 'api-key',
      credential: 'sk-ant-test',
    });
    expect(() => open(keys, 'controller-2', 'claude', sealed)).toThrow();
    expect(() => open(keys, 'controller-1', 'codex', sealed)).toThrow();
    expect(() => open(machineKeys(), 'controller-1', 'claude', sealed)).toThrow();
  });

  it('refuses an empty credential, and a key that is not one', async () => {
    const keys = machineKeys();
    await expect(
      sealProviderLogin({
        publicKey: keys.publicKey,
        controllerId: 'c',
        provider: 'claude',
        login: { kind: 'api-key', credential: '   ' },
      })
    ).rejects.toThrow('There is no key or token');
    await expect(
      sealProviderLogin({
        publicKey: 'c2hvcnQ=',
        controllerId: 'c',
        provider: 'claude',
        login: { kind: 'api-key', credential: 'k' },
      })
    ).rejects.toThrow('32 bytes');
  });
});
