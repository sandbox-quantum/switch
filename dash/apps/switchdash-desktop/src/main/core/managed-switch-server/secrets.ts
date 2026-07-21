import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import type { ServerHost } from './host/types';
import { generateSecrets, type LocalServerSecrets } from './secret-values';

/**
 * Return the host's stored secret bundle, generating and persisting one on first
 * use. Reusing the same secrets across restarts is required — the Postgres
 * volume was initialised with the first `DB_PASSWORD`, so regenerating it would
 * lock the stack out of its own database. Keyed per host (`host.secretsKey`) so
 * local and remote managed stacks keep separate credentials.
 */
export async function loadOrCreateSecrets(
  host: Pick<ServerHost, 'secretsKey'>
): Promise<LocalServerSecrets> {
  const existing = await encryptedAppSecretsStore.getSecret(host.secretsKey);
  if (existing) {
    try {
      return JSON.parse(existing) as LocalServerSecrets;
    } catch {
      // Corrupt bundle — fall through and regenerate.
    }
  }
  const fresh = generateSecrets();
  await encryptedAppSecretsStore.setSecret(host.secretsKey, JSON.stringify(fresh));
  return fresh;
}

/** Drop the host's secret bundle so the next start generates fresh credentials.
 * Only safe to call after the data volumes have been destroyed (reset). */
export async function clearSecrets(host: Pick<ServerHost, 'secretsKey'>): Promise<void> {
  await encryptedAppSecretsStore.deleteSecret(host.secretsKey);
}
