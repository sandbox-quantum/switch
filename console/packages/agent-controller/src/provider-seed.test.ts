import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from './log';
import { readProviderSeed, writeProviderSeed } from './provider-seed';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-seed-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('provider checks handed to the controller', () => {
  it('reads back what was written', async () => {
    const seed = [
      {
        status: {
          provider: 'claude',
          installed: true,
          version: '2.1.0',
          auth: 'ok' as const,
          auth_source: 'local' as const,
          checked_at: '2026-10-19T10:00:00.000Z',
        },
        path: '/usr/local/bin/claude',
      },
    ];
    await writeProviderSeed(join(dir, 'seed.json'), seed);
    expect(await readProviderSeed(join(dir, 'seed.json'), silentLogger)).toEqual(seed);
  });

  it('is empty when there is no file, or it cannot be read', async () => {
    expect(await readProviderSeed(join(dir, 'missing.json'), silentLogger)).toEqual([]);
    writeFileSync(join(dir, 'bad.json'), '{"providers": [{"status": {}}]}');
    expect(await readProviderSeed(join(dir, 'bad.json'), silentLogger)).toEqual([]);
  });
});
