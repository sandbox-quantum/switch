import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataLayout, defaultDataDir, ensureDataDir, isSafeSegment } from './paths';

describe('defaultDataDir', () => {
  it('follows each OS’s convention', () => {
    expect(defaultDataDir({ platform: 'darwin', env: {}, home: '/Users/a' })).toBe(
      '/Users/a/Library/Application Support/Switch/agent-controller'
    );
    expect(defaultDataDir({ platform: 'linux', env: {}, home: '/home/a' })).toBe(
      '/home/a/.local/state/switch/agent-controller'
    );
    expect(
      defaultDataDir({ platform: 'linux', env: { XDG_STATE_HOME: '/state' }, home: '/home/a' })
    ).toBe('/state/switch/agent-controller');
    expect(
      defaultDataDir({ platform: 'linux', env: { XDG_STATE_HOME: 'relative' }, home: '/home/a' })
    ).toBe('/home/a/.local/state/switch/agent-controller');
  });
});

describe('ensureDataDir', () => {
  it('creates the directory owner-only, and tightens an existing one', async () => {
    const base = mkdtempSync(join(tmpdir(), 'controller-paths-'));
    try {
      const fresh = join(base, 'a', 'b');
      await ensureDataDir(fresh);
      expect(statSync(fresh).mode & 0o777).toBe(0o700);
      const loose = join(base, 'loose');
      mkdirSync(loose, { mode: 0o755 });
      await ensureDataDir(loose);
      expect(statSync(loose).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('dataLayout', () => {
  it('keeps server-supplied names to one path segment', () => {
    const layout = dataLayout('/data');
    expect(layout.agentCredentials('agent-1')).toBe('/data/agents/agent-1/credentials.json');
    expect(layout.watcherRoot('agent-1')).toBe('/data/watchers/agent-1');
    expect(layout.workspace('scout')).toBe('/data/workspaces/scout');
    expect(() => layout.watcherRoot('../x')).toThrow(/cannot be used as a directory name/);
    expect(() => layout.workspace('a/b')).toThrow();
    for (const bad of ['', '.', '..', '.hidden', 'a/b', 'a..b'])
      expect(isSafeSegment(bad)).toBe(false);
    expect(isSafeSegment('00000000-0000-4000-8000-0000000000a1')).toBe(true);
  });
});
