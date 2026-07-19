import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { generateSecrets, type LocalServerSecrets } from './secret-values';

/** Encrypted-store key holding the local stack's secret bundle (JSON). */
const SECRETS_KEY = 'local-switch-server:secrets';

/**
 * Return the stored secret bundle, generating and persisting one on first use.
 * Reusing the same secrets across restarts is required — the Postgres volume was
 * initialised with the first `DB_PASSWORD`, so regenerating it would lock the
 * stack out of its own database.
 */
export async function loadOrCreateSecrets(): Promise<LocalServerSecrets> {
  const existing = await encryptedAppSecretsStore.getSecret(SECRETS_KEY);
  if (existing) {
    try {
      return JSON.parse(existing) as LocalServerSecrets;
    } catch {
      // Corrupt bundle — fall through and regenerate.
    }
  }
  const fresh = generateSecrets();
  await encryptedAppSecretsStore.setSecret(SECRETS_KEY, JSON.stringify(fresh));
  return fresh;
}

/** Drop the secret bundle so the next start generates fresh credentials. Only
 * safe to call after the data volumes have been destroyed (reset). */
export async function clearSecrets(): Promise<void> {
  await encryptedAppSecretsStore.deleteSecret(SECRETS_KEY);
}
