import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadNodeSqlite } from '../node-sqlite';

type Env = Record<string, string | undefined>;

/**
 * The folder OpenCode keeps its data in when started with `env`: the home it
 * resolves is `HOME` on POSIX and `USERPROFILE` on Windows, as Node's and
 * Bun's `homedir()` do.
 */
export function opencodeDataHome(env: Env): string {
  if (env.XDG_DATA_HOME) return env.XDG_DATA_HOME;
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
  return join(home, '.local', 'share');
}

function sharedDatabasePath(env: Env): string {
  return join(opencodeDataHome(env), 'opencode', 'opencode.db');
}

/**
 * The database OpenCode 1 uses when started with `env`, which is where its
 * sessions and its OpenCode console account live: `OPENCODE_DB` when set,
 * otherwise the shared `opencode.db`, unless OpenCode Desktop 2 has migrated
 * that, in which case OpenCode 1 gets its own beside it.
 */
export function opencodeV1DatabasePath(env: Env): string {
  if (env.OPENCODE_DB) return env.OPENCODE_DB;
  const shared = sharedDatabasePath(env);
  if (existsSync(shared) && isOpenCodeDesktopV2Database(shared))
    return join(opencodeDataHome(env), 'opencode-v1', 'opencode.db');
  return shared;
}

/**
 * The environment that points OpenCode 1 at its own database once OpenCode
 * Desktop 2 has migrated the shared one (renaming `session` to `session_v2`),
 * which OpenCode 1 refuses to open (`Database is not empty and has no session
 * table`). Sessions and the OpenCode console account are kept in the
 * database, so they do not carry over; that is announced once, when the new
 * database is set up. `auth.json` stays shared.
 */
export function opencodeV1DatabaseEnv(env: Env): Record<string, string> {
  if (env.OPENCODE_DB) return {};
  const shared = sharedDatabasePath(env);
  const own = opencodeV1DatabasePath(env);
  if (own === shared) return {};
  if (!existsSync(own)) {
    mkdirSync(join(own, '..'), { recursive: true });
    console.warn(
      `OpenCode Desktop 2 has migrated ${shared}, which OpenCode 1 cannot open, so OpenCode 1 now uses ${own}. ` +
        'Sessions from before cannot be resumed, and an OpenCode console account must be signed in again with opencode console login.'
    );
  }
  return { OPENCODE_DB: own };
}

/** True when `path` is a database OpenCode Desktop 2 has migrated. */
export function isOpenCodeDesktopV2Database(path: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync } = loadNodeSqlite();
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    const names = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name))
    );
    return names.has('session_v2') && !names.has('session');
  } catch (error) {
    throw new Error(
      `Could not check whether OpenCode Desktop 2 has migrated ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  } finally {
    db?.close();
  }
}
