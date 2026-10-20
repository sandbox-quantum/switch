import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openCodeConsoleCredentialSchema } from '@switch-console/agent-providers';
import Database from 'better-sqlite3';

export function localOpenCodeDatabasePath(): string {
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'opencode',
    'opencode.db'
  );
}

export function readOpenCodeConsole(path: string): string | null {
  if (!existsSync(path)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('account', 'account_state')"
      )
      .all();
    if (tables.length !== 2) return null;
    const row = db
      .prepare(`SELECT a.*, s.active_org_id FROM account a
      JOIN account_state s ON a.id = s.active_account_id WHERE s.id = 1`)
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    if (!row.active_org_id) throw new Error('Choose an organization with opencode console switch.');
    const credential = JSON.stringify(
      openCodeConsoleCredentialSchema.parse({
        format: 'switch-opencode-console-v1',
        account: row,
        organization: row.active_org_id,
      })
    );
    if (Buffer.byteLength(credential) > 16384) throw new Error();
    return credential;
  } catch {
    throw new Error(
      'Could not read the active OpenCode console account. Run opencode console login and select an organization.'
    );
  } finally {
    db?.close();
  }
}
