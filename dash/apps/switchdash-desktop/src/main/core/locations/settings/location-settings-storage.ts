import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { locationSettings as projectSettingsTable } from '@main/db/schema';

export type StoredLocationSettings = {
  baseSettingsJson: string;
  shareableSettingsJson: string;
  legacyConfigMigratedAt: string | null;
};

export interface ProjectSettingsStorage {
  get(locationId: string): Promise<StoredLocationSettings | undefined>;
  insertIfMissing(locationId: string, settings: StoredLocationSettings): Promise<void>;
  update(locationId: string, settings: Partial<StoredLocationSettings>): Promise<void>;
}

export class ProjectSettingsRepository implements ProjectSettingsStorage {
  async get(locationId: string): Promise<StoredLocationSettings | undefined> {
    const row = db
      .select()
      .from(projectSettingsTable)
      .where(eq(projectSettingsTable.locationId, locationId))
      .get();
    if (!row) return undefined;
    return {
      baseSettingsJson: row.baseSettingsJson,
      shareableSettingsJson: row.shareableSettingsJson,
      legacyConfigMigratedAt: row.legacyConfigMigratedAt,
    };
  }

  async insertIfMissing(locationId: string, settings: StoredLocationSettings): Promise<void> {
    await db
      .insert(projectSettingsTable)
      .values({
        locationId,
        baseSettingsJson: settings.baseSettingsJson,
        shareableSettingsJson: settings.shareableSettingsJson,
        legacyConfigMigratedAt: settings.legacyConfigMigratedAt,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .onConflictDoNothing();
  }

  async update(locationId: string, settings: Partial<StoredLocationSettings>): Promise<void> {
    await db
      .update(projectSettingsTable)
      .set({
        ...settings,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(projectSettingsTable.locationId, locationId));
  }
}
