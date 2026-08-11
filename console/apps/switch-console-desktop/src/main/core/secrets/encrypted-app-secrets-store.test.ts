import { beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.fn();
vi.mock('@main/lib/logger', () => ({ log: { warn: (...args: unknown[]) => warn(...args) } }));
vi.mock('electron', () => ({ safeStorage: {} }));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/db/schema', () => ({ appSecrets: { key: 'key', secret: 'secret' } }));

const { EncryptedAppSecretsStore, UndecryptableSecretError } =
  await import('./encrypted-app-secrets-store');

/** A drizzle stand-in whose select chain resolves to `rows`. */
function fakeDb(rows: { secret: string }[], deleted: string[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return {
    select: () => chain,
    delete: () => ({
      where: (condition: unknown) => {
        deleted.push(String(condition));
        return Promise.resolve();
      },
    }),
  };
}

function storeWith(rows: { secret: string }[], decrypt: () => string, deleted: string[] = []) {
  const safeStorageApi = {
    isEncryptionAvailable: () => true,
    decryptString: decrypt,
    getSelectedStorageBackend: () => 'gnome_libsecret',
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new EncryptedAppSecretsStore(
    fakeDb(rows, deleted) as any,
    safeStorageApi as any,
    'darwin'
  );
}

const CIPHERTEXT = [{ secret: Buffer.from('whatever').toString('base64') }];

function throws(): never {
  throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
}

describe('getSecret', () => {
  beforeEach(() => warn.mockReset());

  it('returns null when nothing is stored', async () => {
    await expect(storeWith([], () => 'unused').getSecret('k')).resolves.toBeNull();
  });

  it('names the rename as the reason a stored secret will not decrypt', async () => {
    const store = storeWith(CIPHERTEXT, throws);

    await expect(store.getSecret('k')).rejects.toBeInstanceOf(UndecryptableSecretError);
    await expect(store.getSecret('k')).rejects.toThrow(/named after the application/);
  });
});

describe('readRecoverableSecret', () => {
  beforeEach(() => warn.mockReset());

  it('reports an undecryptable secret as absent and drops the dead row', async () => {
    const deleted: string[] = [];
    const store = storeWith(CIPHERTEXT, throws, deleted);

    await expect(store.readRecoverableSecret('switch-server-cookie:s1')).resolves.toBeNull();
    expect(deleted).toHaveLength(1);
  });

  it('says so in the log rather than dropping the row silently', async () => {
    await storeWith(CIPHERTEXT, throws).readRecoverableSecret('switch-server-cookie:s1');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot decrypt'), {
      key: 'switch-server-cookie:s1',
    });
  });

  it('returns the secret untouched when it decrypts', async () => {
    const deleted: string[] = [];
    const store = storeWith(CIPHERTEXT, () => 'jwt-value', deleted);

    await expect(store.readRecoverableSecret('k')).resolves.toBe('jwt-value');
    expect(deleted).toHaveLength(0);
  });

  it('does not swallow a failure that is not a decryption failure', async () => {
    const store = storeWith(CIPHERTEXT, () => 'unused');
    vi.spyOn(store, 'getSecret').mockRejectedValue(new Error('database is locked'));

    await expect(store.readRecoverableSecret('k')).rejects.toThrow(/database is locked/);
  });
});
