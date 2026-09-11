import {
  encryptedAppSecretsStore,
  UndecryptableSecretError,
} from '@main/core/secrets/encrypted-app-secrets-store';
import type { ServerHost } from './host/types';
import { generateSecrets, type LocalServerSecrets } from './secret-values';

/**
 * A stored bundle that will not parse is not the same as no bundle at all, and
 * the two callers below have to tell them apart: a reader shows nothing, while
 * the loader must refuse to mint replacements.
 */
type StoredSecrets =
  | { kind: 'missing' }
  | { kind: 'present'; secrets: LocalServerSecrets }
  | { kind: 'unreadable'; cause: unknown };

async function readStoredSecrets(host: Pick<ServerHost, 'secretsKey'>): Promise<StoredSecrets> {
  let existing: string | null;
  try {
    existing = await encryptedAppSecretsStore.getSecret(host.secretsKey);
  } catch (cause) {
    if (!(cause instanceof UndecryptableSecretError)) throw cause;
    return { kind: 'unreadable', cause };
  }
  if (!existing) return { kind: 'missing' };
  try {
    return { kind: 'present', secrets: JSON.parse(existing) as LocalServerSecrets };
  } catch (cause) {
    return { kind: 'unreadable', cause };
  }
}

/**
 * `dbRuntimePassword` did not exist before switch-core split its database
 * connection into an owner role and a restricted runtime role, so a bundle
 * stored before that split parses as `LocalServerSecrets` with that one field
 * missing. Filling it in is safe in a way regenerating the bundle is not:
 * nothing on the existing Postgres volume was ever created with it, since the
 * runtime role did not exist yet either. `init-db` creates that role and
 * `ALTER ROLE`s its password idempotently on every start (see
 * `deploy/local/standalone-docker-compose.yml`), so whatever value lands here
 * simply becomes the role's password on the next start, the same way a
 * freshly generated bundle's would.
 */
function withRuntimePassword(secrets: LocalServerSecrets): {
  secrets: LocalServerSecrets;
  migrated: boolean;
} {
  if (secrets.dbRuntimePassword) return { secrets, migrated: false };
  return {
    secrets: { ...secrets, dbRuntimePassword: generateSecrets().dbRuntimePassword },
    migrated: true,
  };
}

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
  const stored = await readStoredSecrets(host);
  if (stored.kind === 'present') {
    const { secrets, migrated } = withRuntimePassword(stored.secrets);
    if (migrated)
      await encryptedAppSecretsStore.setSecret(host.secretsKey, JSON.stringify(secrets));
    return secrets;
  }
  if (stored.kind === 'unreadable') {
    throw new Error(
      `The stored credentials for this managed server are unreadable. Generating replacements ` +
        `would lock the stack out of the Postgres volume its first password created, so this ` +
        `stops instead: reset the stack to start from fresh credentials, which deletes its data.`,
      { cause: stored.cause }
    );
  }

  const fresh = generateSecrets();
  await encryptedAppSecretsStore.setSecret(host.secretsKey, JSON.stringify(fresh));
  return fresh;
}

/**
 * The host's stored secret bundle, or null when none is stored or the stored
 * one does not parse.
 *
 * The read-only half of {@link loadOrCreateSecrets}, for callers that want to
 * *display* or inspect the credentials rather than run the stack. Generating a
 * bundle as a side effect of reading would mint credentials that match no
 * running deployment, which is exactly the fiction a reader must not be shown.
 * A missing `dbRuntimePassword` is backfilled in memory for callers that expect
 * the full shape, but — unlike {@link loadOrCreateSecrets} — not persisted: a
 * reader must not mutate stored state, so the value shown here can differ from
 * the one the next real start assigns and persists.
 */
export async function readSecrets(
  host: Pick<ServerHost, 'secretsKey'>
): Promise<LocalServerSecrets | null> {
  const stored = await readStoredSecrets(host);
  return stored.kind === 'present' ? withRuntimePassword(stored.secrets).secrets : null;
}

/** Drop the host's secret bundle so the next start generates fresh credentials.
 * Only safe to call after the data volumes have been destroyed (reset). */
export async function clearSecrets(host: Pick<ServerHost, 'secretsKey'>): Promise<void> {
  await encryptedAppSecretsStore.deleteSecret(host.secretsKey);
}
