import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { exportOpenCodeConsole, importOpenCodeConsole } from './opencode-console';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
let root: string;
let cli: string;
const value = {
  format: 'switch-opencode-console-v1',
  account: {
    id: 'fixture-account',
    email: 'fixture@example.com',
    url: 'https://example.com',
    access_token: 'placeholder-access',
    refresh_token: 'placeholder-refresh',
    token_expiry: 1,
    time_created: 1,
    time_updated: 1,
  },
  organization: 'fixture-org',
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opencode-console-'));
  cli = join(root, 'fixture-cli');
  await writeFile(
    cli,
    `#!${process.execPath}
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(require('node:path').join(process.env.XDG_DATA_HOME, 'opencode/opencode.db'));
db.exec('CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY,email TEXT,url TEXT,access_token TEXT,refresh_token TEXT,token_expiry INTEGER,time_created INTEGER,time_updated INTEGER); CREATE TABLE IF NOT EXISTS account_state (id INTEGER PRIMARY KEY,active_account_id TEXT,active_org_id TEXT)');
db.close();`,
    { mode: 0o700 }
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it('imports only the account, preserves native refresh, and accepts a replaced credential', async () => {
  const env = { XDG_DATA_HOME: root };
  await importOpenCodeConsole(root, env, cli, JSON.stringify(value));
  expect(JSON.parse(exportOpenCodeConsole(root))).toEqual(value);
  const db = new DatabaseSync(join(root, 'opencode/opencode.db'));
  db.prepare('UPDATE account SET access_token = ?').run('placeholder-refreshed');
  db.close();
  await importOpenCodeConsole(root, env, cli, JSON.stringify(value));
  expect(JSON.parse(exportOpenCodeConsole(root)).account.access_token).toBe(
    'placeholder-refreshed'
  );
  const replaced = {
    ...value,
    account: { ...value.account, access_token: 'placeholder-replaced' },
  };
  await importOpenCodeConsole(root, env, cli, JSON.stringify(replaced));
  expect(JSON.parse(exportOpenCodeConsole(root))).toEqual(replaced);
  expect(await readFile(join(root, 'opencode/.switch-console-credential'), 'utf8')).not.toContain(
    'placeholder'
  );
});
it('rejects malformed exports before starting the CLI', async () => {
  await expect(
    importOpenCodeConsole(root, {}, '/missing-cli', JSON.stringify({ format: value.format }))
  ).rejects.toThrow();
});
