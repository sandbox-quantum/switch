import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openCodeConsoleCredentialSchema } from '../opencode/console-credential';

const exec = promisify(execFile);
interface Database {
  prepare(sql: string): {
    run(...values: unknown[]): unknown;
    get(): Record<string, unknown> | undefined;
  };
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => Database;
};

export async function importOpenCodeConsole(
  dataHome: string,
  env: Record<string, string>,
  binaryPath: string,
  credential: string
) {
  const input = openCodeConsoleCredentialSchema.parse(JSON.parse(credential));
  const directory = join(dataHome, 'opencode');
  const marker = join(directory, '.switch-console-credential');
  for (const path of [dataHome, directory, join(directory, 'opencode.db'), marker]) {
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error('OpenCode sign-in storage must not be a symbolic link.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const fingerprint = createHash('sha256').update(credential).digest('hex');
  try {
    if (
      (await readFile(marker, 'utf8')) === fingerprint &&
      (await lstat(join(directory, 'opencode.db'))).isFile()
    )
      return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await exec(binaryPath, ['db', 'SELECT 1', '--format', 'json'], {
      env,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error('Could not initialize OpenCode console sign-in storage.');
  }
  const path = join(directory, 'opencode.db');
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN');
    const a = input.account;
    db.prepare(`INSERT OR REPLACE INTO account
      (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      a.id,
      a.email,
      a.url,
      a.access_token,
      a.refresh_token,
      a.token_expiry,
      a.time_created,
      a.time_updated
    );
    db.prepare(
      'INSERT OR REPLACE INTO account_state (id, active_account_id, active_org_id) VALUES (1, ?, ?)'
    ).run(a.id, input.organization);
    db.exec('COMMIT');
  } catch {
    throw new Error('Could not import OpenCode console sign-in.');
  } finally {
    db.close();
  }
  await chmod(path, 0o600);
  await writeFile(marker, fingerprint, { mode: 0o600 });
}

export function exportOpenCodeConsole(dataHome: string): string {
  const db = new DatabaseSync(join(dataHome, 'opencode', 'opencode.db'));
  try {
    const row = db
      .prepare(`SELECT a.*, s.active_org_id FROM account a
      JOIN account_state s ON a.id = s.active_account_id WHERE s.id = 1`)
      .get();
    return JSON.stringify(
      openCodeConsoleCredentialSchema.parse({
        format: 'switch-opencode-console-v1',
        account: row,
        organization: row?.active_org_id,
      })
    );
  } catch {
    throw new Error('Could not read the verified OpenCode console sign-in.');
  } finally {
    db.close();
  }
}
