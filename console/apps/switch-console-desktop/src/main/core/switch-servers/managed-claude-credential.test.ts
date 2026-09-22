import { beforeEach, describe, expect, it, vi } from 'vitest';

const secrets = vi.hoisted(() => ({ setSecret: vi.fn(), deleteSecret: vi.fn() }));
vi.mock('@main/core/secrets/encrypted-app-secrets-store', () => ({
  encryptedAppSecretsStore: secrets,
}));
import {
  saveManagedClaudeCredential,
  deleteManagedClaudeCredential,
} from './managed-claude-credential';

describe('managed Claude credential draft', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['api-key', 'setup-token'] as const)(
    'stores %s only through encrypted storage',
    async (kind) => {
      const value =
        kind === 'api-key'
          ? 'sk-ant-api-SYNTHETIC-PLACEHOLDER'
          : 'sk-ant-oat-SYNTHETIC-PLACEHOLDER';
      await saveManagedClaudeCredential('example-server', kind, ` ${value} `);
      expect(secrets.setSecret).toHaveBeenCalledWith(
        'managed-claude-draft:example-server',
        JSON.stringify({ kind, credential: value })
      );
    }
  );
  it('does not store a setup token as an API key', async () => {
    await expect(
      saveManagedClaudeCredential('example-server', 'api-key', 'sk-ant-oat-SYNTHETIC-PLACEHOLDER')
    ).rejects.toThrow('Subscription');
    expect(secrets.setSecret).not.toHaveBeenCalled();
  });
  it.each([
    '',
    'wrong-format',
    'sk-ant-api-two lines',
    'sk-ant-api-one\ntwo',
    'sk-ant-api-' + 'x'.repeat(16384),
  ])('rejects malformed input without echoing it', async (value) => {
    await expect(saveManagedClaudeCredential('example-server', 'api-key', value)).rejects.toThrow();
    expect(secrets.setSecret).not.toHaveBeenCalled();
  });
  it('surfaces secure storage failures', async () => {
    secrets.setSecret.mockRejectedValueOnce(new Error('Secure storage unavailable.'));
    await expect(
      saveManagedClaudeCredential('example-server', 'api-key', 'sk-ant-api-SYNTHETIC-PLACEHOLDER')
    ).rejects.toThrow('Secure storage unavailable');
  });
  it('deletes the scoped draft', async () => {
    await deleteManagedClaudeCredential('example-server');
    expect(secrets.deleteSecret).toHaveBeenCalledWith('managed-claude-draft:example-server');
  });
});
