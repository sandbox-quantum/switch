import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecrets } from './secret-values';

const getSecret = vi.fn();
const setSecret = vi.fn();

class FakeUndecryptableSecretError extends Error {
  constructor(readonly key: string) {
    super(`Stored secret '${key}' exists but could not be decrypted.`);
  }
}

vi.mock('@main/core/secrets/encrypted-app-secrets-store', () => ({
  encryptedAppSecretsStore: {
    getSecret: (...args: unknown[]) => getSecret(...args),
    setSecret: (...args: unknown[]) => setSecret(...args),
  },
  UndecryptableSecretError: FakeUndecryptableSecretError,
}));

const { loadOrCreateSecrets, readSecrets } = await import('./secrets');

describe('generateSecrets', () => {
  it('populates every field with a non-empty value', () => {
    const s = generateSecrets();
    for (const [key, value] of Object.entries(s)) {
      expect(value, `empty ${key}`).toBeTruthy();
      expect(value.length, `short ${key}`).toBeGreaterThanOrEqual(16);
    }
  });

  it('generates distinct values across fields and across calls', () => {
    const a = generateSecrets();
    const b = generateSecrets();
    expect(new Set(Object.values(a)).size).toBe(Object.keys(a).length);
    expect(a.jwtSecretKey).not.toBe(b.jwtSecretKey);
    expect(a.dbPassword).not.toBe(b.dbPassword);
  });
});

describe('loadOrCreateSecrets', () => {
  beforeEach(() => {
    getSecret.mockReset();
    setSecret.mockReset();
  });

  it('creates and persists a bundle when the host has none', async () => {
    getSecret.mockResolvedValue(null);

    const secrets = await loadOrCreateSecrets({ secretsKey: 'host-a' });

    expect(secrets.dbPassword).toBeTruthy();
    expect(setSecret).toHaveBeenCalledWith('host-a', JSON.stringify(secrets));
  });

  it('reuses the stored bundle rather than generating a second one', async () => {
    const stored = generateSecrets();
    getSecret.mockResolvedValue(JSON.stringify(stored));

    await expect(loadOrCreateSecrets({ secretsKey: 'host-a' })).resolves.toEqual(stored);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('fails loud on an unreadable bundle instead of regenerating over a live volume', async () => {
    getSecret.mockResolvedValue('not json');

    await expect(loadOrCreateSecrets({ secretsKey: 'host-a' })).rejects.toThrow(
      /credentials for this managed server are unreadable/
    );
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('refuses to mint replacements when the stored bundle cannot be decrypted', async () => {
    getSecret.mockRejectedValue(new FakeUndecryptableSecretError('host-a'));

    await expect(loadOrCreateSecrets({ secretsKey: 'host-a' })).rejects.toThrow(
      /credentials for this managed server are unreadable/
    );
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('lets an unrelated storage failure through untouched', async () => {
    getSecret.mockRejectedValue(new Error('database is locked'));

    await expect(loadOrCreateSecrets({ secretsKey: 'host-a' })).rejects.toThrow(
      /database is locked/
    );
    expect(setSecret).not.toHaveBeenCalled();
  });
});

describe('readSecrets', () => {
  beforeEach(() => {
    getSecret.mockReset();
    setSecret.mockReset();
  });

  it('shows nothing rather than throwing when the bundle cannot be decrypted', async () => {
    getSecret.mockRejectedValue(new FakeUndecryptableSecretError('host-a'));

    await expect(readSecrets({ secretsKey: 'host-a' })).resolves.toBeNull();
    expect(setSecret).not.toHaveBeenCalled();
  });
});
