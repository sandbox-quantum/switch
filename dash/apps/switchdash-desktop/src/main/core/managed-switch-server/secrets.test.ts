import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecrets } from './secret-values';

const getSecret = vi.fn();
const setSecret = vi.fn();

vi.mock('@main/core/secrets/encrypted-app-secrets-store', () => ({
  encryptedAppSecretsStore: {
    getSecret: (...args: unknown[]) => getSecret(...args),
    setSecret: (...args: unknown[]) => setSecret(...args),
  },
}));

const { loadOrCreateSecrets } = await import('./secrets');

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

  it('propagates a decryption failure rather than treating it as absent', async () => {
    getSecret.mockRejectedValue(new Error("Stored secret 'host-a' could not be decrypted."));

    await expect(loadOrCreateSecrets({ secretsKey: 'host-a' })).rejects.toThrow(
      /could not be decrypted/
    );
    expect(setSecret).not.toHaveBeenCalled();
  });
});
