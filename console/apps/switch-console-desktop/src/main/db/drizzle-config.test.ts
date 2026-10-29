/**
 * drizzle-kit `push`, `migrate` and `studio` open the database the config
 * names. Defaulting to the installed app's `switchdash` folder let a schema
 * from a branch land in the database stable and Canary open (CHOO-3384).
 */
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CURRENT_DB_FILENAME } from './default-path';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function configuredUrl(): Promise<string> {
  const { default: config } = await import('../../../drizzle.config');
  return (config as { dbCredentials: { url: string } }).dbCredentials.url;
}

it("opens the dev database by default, never the installed app's", async () => {
  vi.stubEnv('SWITCHDASH_DB_FILE', '');

  const url = await configuredUrl();

  expect(url.endsWith(join('switchdash-dev', CURRENT_DB_FILENAME))).toBe(true);
});

it('opens SWITCHDASH_DB_FILE when it is set', async () => {
  vi.stubEnv('SWITCHDASH_DB_FILE', '/tmp/scratch/switchdash.db');

  expect(await configuredUrl()).toBe(resolve('/tmp/scratch/switchdash.db'));
});
