import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { generateSecrets } from '../secret-values';
import { nativeLayout } from './native-paths';
import { resolvePostgres } from './postgres-binaries';
import { initCluster, pgEnv } from './postgres-cluster';

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function caseInsensitiveDuplicates(env: NodeJS.ProcessEnv): string[] {
  const seen = new Map<string, string>();
  const dups: string[] = [];
  for (const key of Object.keys(env)) {
    const folded = key.toUpperCase();
    const prior = seen.get(folded);
    if (prior !== undefined) dups.push(`${prior}/${key}`);
    else seen.set(folded, key);
  }
  return dups;
}

/** The real initdb, spawned the way Console spawns it (CHOO-4041). Windows
 * only: it downloads the pinned portable PostgreSQL. */
describe.runIf(process.platform === 'win32')('initdb on Windows', () => {
  let root = '';
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('spawns PostgreSQL with no duplicate environment keys', () => {
    const env = pgEnv({ binDir: 'C:\\pg\\bin', major: 17, source: 'downloaded' });
    expect(caseInsensitiveDuplicates(env)).toEqual([]);
  });

  it('creates a cluster', { timeout: 10 * 60 * 1000 }, async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'switch-initdb-'));
    const layout = nativeLayout(root);
    const log = (line: string) => process.stdout.write(`  ${line}\n`);
    const postgres = await resolvePostgres(layout, null, log);
    const secrets = generateSecrets();
    await initCluster(
      postgres,
      layout,
      { owner: secrets.dbPassword, runtime: secrets.dbRuntimePassword },
      log
    );
  });
});
