/**
 * Migration 0047 — preserves an agreement to share usage data across the change
 * of default that would otherwise silently revoke it.
 *
 * Settings rows hold only the fields that differed from the default when they
 * were written, so an agreement given while sharing defaulted to on was stored
 * as an `askedAt` with no `enabled` at all. Once the default is off, that row
 * reads as a refusal — and `askedAt` stops the prompt ever asking again.
 *
 * The test applies the committed SQL to an isolated `app_settings` table and
 * checks each shape of row that can exist: the one that must be repaired, and
 * the ones that already say what they mean and must be left untouched.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../drizzle/0047_materialise_telemetry_consent.sql'
  ),
  'utf8'
);

describe('migration 0047: materialise telemetry consent', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  function seed(key: string, value: Record<string, unknown>): void {
    db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)`).run(
      key,
      JSON.stringify(value)
    );
  }

  function stored(key: string): Record<string, unknown> {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    if (!row) throw new Error(`no row for ${key}`);
    return JSON.parse(row.value) as Record<string, unknown>;
  }

  function applyMigration(): void {
    for (const stmt of MIGRATION_SQL.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed) db.exec(trimmed);
    }
  }

  it('restores the agreement that the old default left unwritten', () => {
    seed('telemetry', { askedAt: 1_700_000_000_000 });

    applyMigration();

    expect(stored('telemetry')).toEqual({ askedAt: 1_700_000_000_000, enabled: true });
  });

  it('writes a real boolean, not a number sqlite would hand back as 1', () => {
    seed('telemetry', { askedAt: 1_700_000_000_000 });

    applyMigration();

    expect(stored('telemetry').enabled).toBe(true);
  });

  it('leaves a refusal alone', () => {
    seed('telemetry', { enabled: false, askedAt: 1_700_000_000_000 });

    applyMigration();

    expect(stored('telemetry')).toEqual({ enabled: false, askedAt: 1_700_000_000_000 });
  });

  it('leaves an agreement that was already written out alone', () => {
    seed('telemetry', { enabled: true, askedAt: 1_700_000_000_000 });

    applyMigration();

    expect(stored('telemetry')).toEqual({ enabled: true, askedAt: 1_700_000_000_000 });
  });

  it('does not answer for someone who was never asked', () => {
    // No `askedAt` means the prompt is still to come, and the gate refuses
    // until it has been. Inventing an agreement here would skip it entirely.
    seed('telemetry', { enabled: false });

    applyMigration();

    expect(stored('telemetry')).toEqual({ enabled: false });
  });

  it('touches no other setting', () => {
    seed('notifications', { askedAt: 1_700_000_000_000 });

    applyMigration();

    expect(stored('notifications')).toEqual({ askedAt: 1_700_000_000_000 });
  });

  it('is safe to run on a database that has no telemetry row', () => {
    expect(() => applyMigration()).not.toThrow();
  });
});
