import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * OpenCode Desktop 2 migrates the shared `opencode.db` and renames `session`
 * to `session_v2`. OpenCode 1, which is what Switch runs, then refuses to
 * open it (`Database is not empty and has no session table`). Credentials in
 * `auth.json` stay in the shared data directory; only the database file moves.
 */
export function opencodeV1DatabaseEnv(
  env: Record<string, string | undefined>
): Record<string, string> {
  if (env.OPENCODE_DB) return {};
  const shared = join(opencodeDataHome(env), 'opencode', 'opencode.db');
  if (!existsSync(shared) || !isOpenCodeDesktopV2Database(shared)) return {};
  const dir = join(opencodeDataHome(env), 'opencode-v1');
  mkdirSync(dir, { recursive: true });
  return { OPENCODE_DB: join(dir, 'opencode.db') };
}

function opencodeDataHome(env: Record<string, string | undefined>): string {
  if (env.XDG_DATA_HOME) return env.XDG_DATA_HOME;
  const home =
    process.platform === 'win32'
      ? env.USERPROFILE || env.HOME || homedir()
      : env.HOME || env.USERPROFILE || homedir();
  return join(home, '.local', 'share');
}

/** True when `path` is a database OpenCode Desktop 2 has migrated. */
export function isOpenCodeDesktopV2Database(path: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const names = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) =>
          row && typeof row === 'object' && 'name' in row ? String(row.name) : ''
        )
    );
    return names.has('session_v2') && !names.has('session');
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
