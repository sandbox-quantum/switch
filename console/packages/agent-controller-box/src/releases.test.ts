import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneReleases, throughCurrent } from './releases';

describe.skipIf(process.platform === 'win32')('throughCurrent', () => {
  it('reaches a file of the release through current, and leaves one outside it alone', () => {
    expect(
      throughCurrent(
        '/data/releases',
        '/home/me/.local',
        '/home/me/.local/lib/node_modules/switch-agent-controller/dist/cli.js'
      )
    ).toBe('/data/releases/current/lib/node_modules/switch-agent-controller/dist/cli.js');
    expect(throughCurrent('/data/releases', '/home/me/.local', '/opt/shared-host.mjs')).toBe(
      '/opt/shared-host.mjs'
    );
    expect(throughCurrent('/data/releases', '/home/me/.local', '/home/me/.localother/x')).toBe(
      '/home/me/.localother/x'
    );
  });
});

describe.skipIf(process.platform === 'win32')('pruneReleases', () => {
  it('keeps dev builds as releases, and clears what an interrupted install of one left', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prune-'));
    try {
      const made = [
        '0.31.1-dev.3.gaaaaaaa',
        '0.31.1-dev.4.gbbbbbbb',
        '0.31.1-dev.5.gccccccc',
        '0.31.1-dev.6.gddddddd.partial',
      ];
      made.forEach((name, index) => {
        mkdirSync(join(dir, name));
        utimesSync(join(dir, name), 1000 + index, 1000 + index);
      });
      symlinkSync(join(dir, '0.31.1-dev.5.gccccccc'), join(dir, 'current'));
      await pruneReleases(dir, []);
      expect(readdirSync(dir).sort()).toEqual([
        '0.31.1-dev.4.gbbbbbbb',
        '0.31.1-dev.5.gccccccc',
        'current',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
