import { eq } from 'drizzle-orm';
import { safeStorage } from 'electron';
import { db as appDb } from '@main/db/client';
import { appSecrets } from '@main/db/schema';
import { log } from '@main/lib/logger';

/**
 * Raised when a row exists but the OS will not decrypt it.
 *
 * Distinct from "no such secret" because the two demand opposite responses. On
 * macOS and Linux the encryption key lives in an OS keychain entry named after
 * the application, so a build whose product name changed is handed a different
 * key and cannot read what the previous one wrote — while the database, which
 * is deliberately shared across the rename, still holds the rows.
 */
export class UndecryptableSecretError extends Error {
  constructor(
    readonly key: string,
    cause: unknown
  ) {
    super(
      `Stored secret '${key}' exists but could not be decrypted. The OS keychain entry that ` +
        `holds the encryption key is named after the application, so a build whose product name ` +
        `changed cannot read secrets written by the previous one. Whatever owns this secret has ` +
        `to write it again; for a managed Switch server that means resetting the stack, which ` +
        `deletes its data.`,
      { cause }
    );
    this.name = 'UndecryptableSecretError';
  }
}

export class EncryptedAppSecretsStore {
  constructor(
    private readonly db = appDb,
    private readonly safeStorageApi = safeStorage,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async getSecret(key: string): Promise<string | null> {
    const rows = await this.db
      .select({ secret: appSecrets.secret })
      .from(appSecrets)
      .where(eq(appSecrets.key, key))
      .limit(1);

    const secret = rows[0]?.secret;
    if (!secret) {
      return null;
    }

    this.assertSecureStorageAvailable();
    try {
      return this.safeStorageApi.decryptString(Buffer.from(secret, 'base64'));
    } catch (cause) {
      throw new UndecryptableSecretError(key, cause);
    }
  }

  /**
   * The secret, or null when there is none *or* the stored one cannot be
   * decrypted — for callers holding something the app can simply obtain again.
   *
   * A session cookie is the case this exists for: re-authenticating costs a
   * sign-in, so refusing to start over a value nobody can read reports a
   * recoverable state as a broken one. The unreadable row is dropped, because a
   * ciphertext with no key is not data and keeping it fails the same way on
   * every later call. Anything whose loss is destructive — the managed server's
   * own credentials — must keep using {@link getSecret} and fail loud.
   */
  async readRecoverableSecret(key: string): Promise<string | null> {
    try {
      return await this.getSecret(key);
    } catch (error) {
      if (!(error instanceof UndecryptableSecretError)) throw error;
      log.warn('Dropping a stored secret this build cannot decrypt; it must be obtained again', {
        key,
      });
      await this.deleteSecret(key);
      return null;
    }
  }

  async setSecret(key: string, secret: string): Promise<void> {
    this.assertSecureStorageAvailable();
    const encryptedSecret = this.safeStorageApi.encryptString(secret).toString('base64');

    await this.setEncryptedSecret(key, encryptedSecret);
  }

  async setEncryptedSecret(key: string, encryptedSecret: string): Promise<void> {
    await this.db
      .insert(appSecrets)
      .values({
        key: key,
        secret: encryptedSecret,
      })
      .onConflictDoUpdate({ target: appSecrets.key, set: { secret: encryptedSecret } })
      .execute();
  }

  async deleteSecret(key: string): Promise<void> {
    await this.db.delete(appSecrets).where(eq(appSecrets.key, key));
  }

  private assertSecureStorageAvailable(): void {
    if (!this.safeStorageApi.isEncryptionAvailable()) {
      throw new Error('Secure secret storage is unavailable on this system.');
    }

    if (this.platform !== 'linux') {
      return;
    }

    const backend = this.safeStorageApi.getSelectedStorageBackend?.();
    if (backend === 'basic_text') {
      throw new Error(
        'Secure secret storage is unavailable: Linux safeStorage backend is basic_text.'
      );
    }
  }
}

export const encryptedAppSecretsStore = new EncryptedAppSecretsStore();
