import { beforeEach, describe, expect, it, vi } from 'vitest';

const secrets = vi.hoisted(() => ({ setSecret: vi.fn(), deleteSecret: vi.fn() }));
vi.mock('@main/core/secrets/encrypted-app-secrets-store', () => ({
  encryptedAppSecretsStore: secrets,
}));
import { deleteManagedClaudeCredential } from './managed-claude-credential';

describe('managed Claude credential draft', () => {
  beforeEach(() => vi.clearAllMocks());
  it('deletes the scoped draft', async () => {
    await deleteManagedClaudeCredential('example-server');
    expect(secrets.deleteSecret).toHaveBeenCalledWith('managed-claude-draft:example-server');
  });
});
