import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readOpenCodeConsole } from './local-opencode-sign-in';

vi.mock('@main/core/agent-runtime/impl/resolve-agent-executable', () => ({}));
vi.mock('@main/core/dependencies/dependency-managers', () => ({}));
vi.mock('@main/core/dependencies/host-dependency-store', () => ({}));
vi.mock('@main/core/execution-context/local-execution-context', () => ({}));
let root: string;
let path: string;
let db: Database.Database;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opencode-detection-'));
  path = join(root, 'opencode.db');
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE account (id TEXT PRIMARY KEY,email TEXT,url TEXT,access_token TEXT,refresh_token TEXT,token_expiry INTEGER,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE account_state (id INTEGER PRIMARY KEY,active_account_id TEXT,active_org_id TEXT);`);
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});
it('detects a login in the live WAL and exports only the active account', () => {
  expect(readOpenCodeConsole(path)).toBeNull();
  const insert = db.prepare('INSERT INTO account VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run(
    'chosen',
    'fixture@example.com',
    'https://example.com',
    'placeholder-access',
    'placeholder-refresh',
    1,
    1,
    1
  );
  insert.run(
    'other',
    'other@example.com',
    'https://example.com',
    'placeholder-other',
    'placeholder-other',
    1,
    1,
    1
  );
  db.prepare('INSERT INTO account_state VALUES (1, ?, ?)').run('chosen', 'fixture-org');
  const result = readOpenCodeConsole(path)!;
  expect(JSON.parse(result)).toMatchObject({
    format: 'switch-opencode-console-v1',
    organization: 'fixture-org',
    account: { id: 'chosen' },
  });
  expect(result).not.toContain('placeholder-other');
  db.exec('DELETE FROM account_state');
  expect(readOpenCodeConsole(path)).toBeNull();
});
it('reports incomplete accounts without returning secret values', () => {
  db.prepare('INSERT INTO account VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'chosen',
    'fixture@example.com',
    'https://example.com',
    'placeholder-private',
    '',
    1,
    1,
    1
  );
  db.prepare('INSERT INTO account_state VALUES (1, ?, ?)').run('chosen', 'fixture-org');
  expect(() => readOpenCodeConsole(path)).toThrow(
    'Could not read the active OpenCode console account'
  );
});
