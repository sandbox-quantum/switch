import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { ...logged, child: () => logged } }));

const { dropProviderConfigs, initializeDatabase } = await import('./initialize');

const SECRET = 'sk-ant-api03-PLACEHOLDER';

let dir: string;
let file: string;
let db: Database.Database;

function upsertSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

/** Saves provider settings the way a user editing them several times left them. */
function saveProviderSettingsRepeatedly(): void {
  for (let edit = 0; edit < 6; edit++) {
    for (let i = 0; i < 40; i++)
      upsertSetting(`filler-${i}`, 'v'.repeat(20 + ((i * 37 + edit * 11) % 300)));
    upsertSetting(
      'providerConfigs',
      JSON.stringify({
        claude: {
          env: { ANTHROPIC_API_KEY: `${SECRET}-EDIT${edit}`, PAD: 'p'.repeat(edit * 150) },
          extraArgs: '--verbose',
        },
        codex: { env: { 'not a name': 'x' } },
      })
    );
    if (edit % 2) db.pragma('wal_checkpoint(TRUNCATE)');
  }
}

function filesHoldSecret(): boolean {
  return [file, `${file}-wal`].some(
    (path) => existsSync(path) && readFileSync(path).includes(Buffer.from(SECRET))
  );
}

const savedRow = () =>
  db.prepare(`SELECT value FROM app_settings WHERE key = 'providerConfigs'`).get();
const scrubMarker = () =>
  db.prepare(`SELECT value FROM kv WHERE key = 'provider_configs_scrub'`).get();

beforeEach(async () => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'switch-console-provider-configs-'));
  file = join(dir, 'switchdash.db');
  db = new Database(file);
  await initializeDatabase(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('dropping the saved provider settings', () => {
  it('leaves no copy of a saved value in the database or its WAL', async () => {
    saveProviderSettingsRepeatedly();
    expect(filesHoldSecret()).toBe(true);

    await initializeDatabase(db);

    expect(savedRow()).toBeUndefined();
    expect(scrubMarker()).toBeUndefined();
    expect(filesHoldSecret()).toBe(false);
    expect(logged.error).not.toHaveBeenCalled();
    expect(logged.warn).toHaveBeenCalledWith(expect.any(String), {
      event: 'provider_settings_dropped',
      providers: [
        {
          provider: 'claude',
          envNames: ['ANTHROPIC_API_KEY', 'PAD'],
          otherEnvEntries: 0,
          extraArgs: true,
        },
        { provider: 'codex', envNames: [], otherEnvEntries: 1, extraArgs: false },
      ],
    });
    expect(JSON.stringify(logged.warn.mock.calls)).not.toContain(SECRET);
  });

  it('says so and tries again on the next launch when the WAL cannot be checkpointed', () => {
    saveProviderSettingsRepeatedly();
    const reader = new Database(file);
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM app_settings').get();
    db.pragma('busy_timeout = 0');

    dropProviderConfigs(db);

    expect(savedRow()).toBeUndefined();
    expect(scrubMarker()).toEqual({ value: 'pending' });
    expect(logged.error).toHaveBeenCalledWith(
      expect.stringContaining('write-ahead log'),
      expect.objectContaining({ event: 'provider_settings_scrub_failed', stage: 'checkpoint' })
    );

    reader.exec('COMMIT');
    reader.close();
    logged.warn.mockClear();
    dropProviderConfigs(db);

    expect(scrubMarker()).toBeUndefined();
    expect(filesHoldSecret()).toBe(false);
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it('does nothing on a database that never saved any', () => {
    upsertSetting('theme', '"emdark"');

    dropProviderConfigs(db);

    expect(logged.warn).not.toHaveBeenCalled();
    expect(logged.error).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT value FROM app_settings WHERE key = 'theme'`).get()).toEqual({
      value: '"emdark"',
    });
  });
});
