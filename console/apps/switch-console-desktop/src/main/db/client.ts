import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { resolveDatabasePath } from './path';
import * as schema from './schema';

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;
export type DrizzleTx = Parameters<AppDb['transaction']>[0] extends (tx: infer T) => unknown
  ? T
  : never;

const databasePath = resolveDatabasePath();

/**
 * Whether this installation already had a database before the app opened it:
 * a relaunch or an upgrade, rather than the first launch ever. Read before
 * opening, which creates the file.
 */
export const databaseExistedAtStart = existsSync(databasePath);

// WAL is switched on by initializeDatabase, not here: switching writes to the
// file, and a database from a newer build must be refused before anything does.
export const sqlite = new Database(databasePath);
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });
