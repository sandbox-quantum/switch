/**
 * drizzle-kit `push`, `migrate` and `studio` open the database the config
 * names. Defaulting to the installed app's `switchdash` folder let a schema
 * from a branch land in the database stable and Canary open (CHOO-3384), and
 * ignoring a worktree's own data folder does the same to every other dev
 * worktree, which share `switchdash-dev`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CURRENT_DB_FILENAME } from './default-path';

const appDir = fileURLToPath(new URL('../../..', import.meta.url));

beforeEach(() => {
  vi.stubEnv('SWITCHDASH_DB_FILE', '');
  vi.stubEnv('SWITCH_CONSOLE_USER_DATA_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function configuredUrl(): Promise<string> {
  const { default: config } = await import('../../../drizzle.config');
  return (config as { dbCredentials: { url: string } }).dbCredentials.url;
}

it("opens the dev database by default, never the installed app's", async () => {
  const url = await configuredUrl();

  expect(url.endsWith(join('switchdash-dev', CURRENT_DB_FILENAME))).toBe(true);
});

// drizzle-kit loads the config outside the Vite build, where DEV is unset, so
// USER_DATA_DIR_NAME is `switchdash`: a config built on it passes every test
// here under Vitest and opens the installed app's database. Only drizzle-kit's
// own loader shows it.
it('opens the dev database when drizzle-kit itself loads the config', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'drizzle-config-'));
  try {
    const probe = join(scratch, 'probe.config.ts');
    writeFileSync(
      probe,
      `import config from ${JSON.stringify(join(appDir, 'drizzle.config.ts').replaceAll('\\', '/'))};\n` +
        `console.log('DB_URL=' + config.dbCredentials.url);\n` +
        `export default config;\n`
    );
    const bin = join(dirname(createRequire(import.meta.url).resolve('drizzle-kit')), 'bin.cjs');

    // `check` reads the migrations folder and never opens the database.
    const run = spawnSync(process.execPath, [bin, 'check', `--config=${probe}`], {
      cwd: appDir,
      encoding: 'utf8',
      env: { ...process.env, SWITCHDASH_DB_FILE: '', SWITCH_CONSOLE_USER_DATA_DIR: '' },
    });

    const url = /^DB_URL=(.*)$/m.exec(run.stdout)?.[1];
    expect(url, run.stderr || run.stdout).toBeDefined();
    expect(url!.endsWith(join('switchdash-dev', CURRENT_DB_FILENAME))).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);

it("opens the worktree's own data folder when SWITCH_CONSOLE_USER_DATA_DIR names one", async () => {
  vi.stubEnv('SWITCH_CONSOLE_USER_DATA_DIR', 'switchdash-wt1');

  const url = await configuredUrl();

  expect(url.endsWith(join('switchdash-wt1', CURRENT_DB_FILENAME))).toBe(true);
});

it('refuses a SWITCH_CONSOLE_USER_DATA_DIR that is a path, as the app does', async () => {
  vi.stubEnv('SWITCH_CONSOLE_USER_DATA_DIR', '../elsewhere');

  await expect(configuredUrl()).rejects.toThrow(
    /SWITCH_CONSOLE_USER_DATA_DIR must be a folder name/
  );
});

it('opens SWITCHDASH_DB_FILE when it is set, over SWITCH_CONSOLE_USER_DATA_DIR', async () => {
  vi.stubEnv('SWITCHDASH_DB_FILE', '/tmp/scratch/switchdash.db');
  vi.stubEnv('SWITCH_CONSOLE_USER_DATA_DIR', 'switchdash-wt1');

  expect(await configuredUrl()).toBe(resolve('/tmp/scratch/switchdash.db'));
});
