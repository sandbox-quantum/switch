import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { isOpenCodeDesktopV2Database, opencodeV1DatabaseEnv } from './v1-database';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-v1-db-'));
  dirs.push(dir);
  return dir;
}

function database(home: string, sql: string): string {
  const path = join(home, 'opencode', 'opencode.db');
  mkdirSync(join(home, 'opencode'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
  return path;
}

describe('opencodeV1DatabaseEnv', () => {
  it('points OpenCode 1 at its own database when Desktop 2 has migrated the shared one', () => {
    const home = dataHome();
    database(home, 'CREATE TABLE session_v2 (id text)');
    const env = opencodeV1DatabaseEnv({ XDG_DATA_HOME: home });
    expect(env.OPENCODE_DB).toBe(join(home, 'opencode-v1', 'opencode.db'));
    expect(isOpenCodeDesktopV2Database(join(home, 'opencode', 'opencode.db'))).toBe(true);
  });

  it('leaves a database OpenCode 1 created alone', () => {
    const home = dataHome();
    database(home, 'CREATE TABLE session (id text)');
    expect(opencodeV1DatabaseEnv({ XDG_DATA_HOME: home })).toEqual({});
  });

  it('does nothing when there is no database yet, or a database was already chosen', () => {
    const home = dataHome();
    expect(opencodeV1DatabaseEnv({ XDG_DATA_HOME: home })).toEqual({});
    database(home, 'CREATE TABLE session_v2 (id text)');
    expect(
      opencodeV1DatabaseEnv({ XDG_DATA_HOME: home, OPENCODE_DB: join(home, 'chosen.db') })
    ).toEqual({});
  });
});
