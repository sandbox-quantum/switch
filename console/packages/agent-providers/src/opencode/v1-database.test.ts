import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isOpenCodeDesktopV2Database,
  opencodeV1DatabaseEnv,
  opencodeV1DatabasePath,
} from './v1-database';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const own = join(home, 'opencode-v1', 'opencode.db');
    expect(opencodeV1DatabaseEnv({ XDG_DATA_HOME: home })).toEqual({ OPENCODE_DB: own });
    expect(existsSync(join(home, 'opencode-v1'))).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('cannot be resumed');
    expect(isOpenCodeDesktopV2Database(join(home, 'opencode', 'opencode.db'))).toBe(true);
  });

  it('announces the move only while OpenCode 1 has no database of its own', () => {
    const home = dataHome();
    database(home, 'CREATE TABLE session_v2 (id text)');
    const own = join(home, 'opencode-v1', 'opencode.db');
    mkdirSync(join(home, 'opencode-v1'));
    writeFileSync(own, '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(opencodeV1DatabaseEnv({ XDG_DATA_HOME: home })).toEqual({ OPENCODE_DB: own });
    expect(warn).not.toHaveBeenCalled();
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

  it('says why when the shared database cannot be read', () => {
    const home = dataHome();
    mkdirSync(join(home, 'opencode'));
    writeFileSync(join(home, 'opencode', 'opencode.db'), 'not a database');
    expect(() => opencodeV1DatabaseEnv({ XDG_DATA_HOME: home })).toThrow(
      /Could not check whether OpenCode Desktop 2 has migrated .*opencode\.db/
    );
  });
});

describe('opencodeV1DatabasePath', () => {
  it('is the database OpenCode 1 reads its console account from', () => {
    const home = dataHome();
    const shared = join(home, 'opencode', 'opencode.db');
    expect(opencodeV1DatabasePath({ XDG_DATA_HOME: home })).toBe(shared);
    database(home, 'CREATE TABLE session_v2 (id text)');
    expect(opencodeV1DatabasePath({ XDG_DATA_HOME: home })).toBe(
      join(home, 'opencode-v1', 'opencode.db')
    );
    expect(opencodeV1DatabasePath({ XDG_DATA_HOME: home, OPENCODE_DB: '/chosen.db' })).toBe(
      '/chosen.db'
    );
  });
});
