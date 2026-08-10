import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDefaultDatabasePath } from './database-file';
import { CURRENT_DB_FILENAME, LEGACY_DB_FILENAMES } from './default-path';

function seedDatabase(path: string, marker: string): void {
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE t (marker TEXT)');
    db.prepare('INSERT INTO t (marker) VALUES (?)').run(marker);
  } finally {
    db.close();
  }
}

function readMarker(path: string): string {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT marker FROM t LIMIT 1').get() as { marker: string }).marker;
  } finally {
    db.close();
  }
}

describe('resolveDefaultDatabasePath (emdash -> switchdash migration)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switch-console-db-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the current switchdash db without copying when it already exists', () => {
    seedDatabase(join(dir, CURRENT_DB_FILENAME), 'current');
    seedDatabase(join(dir, 'emdash4.db'), 'legacy');

    const resolved = resolveDefaultDatabasePath(dir);

    expect(resolved).toBe(join(dir, CURRENT_DB_FILENAME));
    // The pre-existing current DB is kept as-is — the legacy file is ignored.
    expect(readMarker(resolved)).toBe('current');
  });

  it('migrates the newest legacy db forward to switchdash.db', () => {
    seedDatabase(join(dir, 'emdash3.db'), 'v3');
    seedDatabase(join(dir, 'emdash4.db'), 'v4');

    const resolved = resolveDefaultDatabasePath(dir);

    expect(resolved).toBe(join(dir, CURRENT_DB_FILENAME));
    expect(fs.existsSync(resolved)).toBe(true);
    // emdash4.db is newer than emdash3.db, so its data wins.
    expect(readMarker(resolved)).toBe('v4');
    // The legacy file is copied, not moved — it stays put.
    expect(fs.existsSync(join(dir, 'emdash4.db'))).toBe(true);
  });

  it('falls back to an older legacy db when the newest is absent', () => {
    seedDatabase(join(dir, 'emdash3.db'), 'v3');

    const resolved = resolveDefaultDatabasePath(dir);

    expect(readMarker(resolved)).toBe('v3');
  });

  it('creates a fresh path when no current or legacy db exists', () => {
    const resolved = resolveDefaultDatabasePath(dir);

    expect(resolved).toBe(join(dir, CURRENT_DB_FILENAME));
    // Nothing to migrate — no file is created by resolution itself.
    expect(fs.existsSync(resolved)).toBe(false);
  });

  it('clears copied app secrets during migration', () => {
    const legacyPath = join(dir, LEGACY_DB_FILENAMES[0]);
    const db = new Database(legacyPath);
    try {
      db.exec('CREATE TABLE app_secrets (id INTEGER PRIMARY KEY, value TEXT)');
      db.prepare('INSERT INTO app_secrets (value) VALUES (?)').run('secret');
    } finally {
      db.close();
    }

    const resolved = resolveDefaultDatabasePath(dir);

    const copied = new Database(resolved, { readonly: true, fileMustExist: true });
    try {
      const count = copied.prepare('SELECT COUNT(*) AS n FROM app_secrets').get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      copied.close();
    }
  });
});
