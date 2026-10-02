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

export const sqlite = new Database(databasePath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });
