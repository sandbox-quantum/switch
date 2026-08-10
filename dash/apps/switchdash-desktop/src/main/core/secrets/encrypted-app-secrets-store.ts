import { eq } from 'drizzle-orm';
import { safeStorage } from 'electron';
import { db as appDb } from '@main/db/client';
import { appSecrets } from '@main/db/schema';

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
      throw new Error(
        `Stored secret '${key}' exists but could not be decrypted. On macOS and Linux the ` +
          `encryption key lives in an OS keychain entry named after the application, so a build ` +
          `whose product name changed is handed a different key and cannot read secrets written ` +
          `by the previous one. Whatever owns this secret has to write it again; for a managed ` +
          `Switch server that means resetting the stack, which deletes its data.`,
        { cause }
      );
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
