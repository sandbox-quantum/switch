import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  controllerSessionsDir,
  dataLayout,
  defaultDataDir,
  agentWorkspace,
  ensureDataDir,
  isSafeSegment,
  serverWorkspacesDir,
} from './paths';

describe('defaultDataDir', () => {
  it('follows each OS’s convention', () => {
    expect(defaultDataDir({ platform: 'darwin', env: {}, home: '/Users/a' })).toBe(
      join('/Users/a', 'Library', 'Application Support', 'Switch', 'agent-controller')
    );
    expect(defaultDataDir({ platform: 'linux', env: {}, home: '/home/a' })).toBe(
      join('/home/a', '.local', 'state', 'switch', 'agent-controller')
    );
    expect(
      defaultDataDir({ platform: 'linux', env: { XDG_STATE_HOME: '/state' }, home: '/home/a' })
    ).toBe(join('/state', 'switch', 'agent-controller'));
    expect(
      defaultDataDir({ platform: 'linux', env: { XDG_STATE_HOME: 'relative' }, home: '/home/a' })
    ).toBe(join('/home/a', '.local', 'state', 'switch', 'agent-controller'));
  });
});

describe('ensureDataDir', () => {
  it.skipIf(process.platform === 'win32')(
    'creates the directory owner-only, and tightens an existing one',
    async () => {
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
    }
  );

  it.runIf(process.platform === 'win32')(
    'gives the directory to this user and the system alone on Windows',
    async () => {
      const base = mkdtempSync(join(tmpdir(), 'controller-paths-'));
      try {
        const dir = join(base, 'data');
        await ensureDataDir(dir);
        const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
        const acl = execFileSync(icacls, [dir], { encoding: 'utf8' });
        expect(acl).toContain('NT AUTHORITY\\SYSTEM:(OI)(CI)(F)');
        expect(acl).not.toMatch(/BUILTIN\\Users|Everyone|Authenticated Users/);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
    30_000
  );
});

describe('dataLayout', () => {
  it('keeps server-supplied names to one path segment', () => {
    const layout = dataLayout('/data');
    expect(layout.agentCredentials('agent-1')).toBe(
      join('/data', 'agents', 'agent-1', 'credentials.json')
    );
    expect(layout.watcherRoot('agent-1')).toBe(join('/data', 'watchers', 'agent-1'));
    expect(serverWorkspacesDir('http://localhost:8000')).toBe(
      join(homedir(), '.switch', 'agents', 'localhost-8000')
    );
    expect(serverWorkspacesDir('https://switch.example.com/')).toBe(
      join(homedir(), '.switch', 'agents', 'switch.example.com')
    );
    expect(agentWorkspace('/home/me/.switch/agents/localhost-8000', 'scout')).toBe(
      join('/home/me/.switch/agents/localhost-8000', 'scout')
    );
    expect(() => agentWorkspace('/w', '../escape')).toThrow(/cannot be used/);
    expect(() => layout.watcherRoot('../x')).toThrow(/cannot be used as a directory name/);
    expect(() => agentWorkspace('/w', 'a/b')).toThrow();
    for (const bad of ['', '.', '..', '.hidden', 'a/b', 'a..b'])
      expect(isSafeSegment(bad)).toBe(false);
    expect(isSafeSegment('00000000-0000-4000-8000-0000000000a1')).toBe(true);
  });
});

describe('controllerSessionsDir', () => {
  function base(): string {
    const dir = mkdtempSync(join(tmpdir(), 'controller-sessions-'));
    roots.push(dir);
    return dir;
  }
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("leaves a controller on the default data directory, or Console's, on the user's folder", async () => {
    const dataDir = base();
    expect(await controllerSessionsDir({ dataDir, named: false, runByConsole: false })).toBeNull();
    expect(await controllerSessionsDir({ dataDir, named: true, runByConsole: true })).toBeNull();
    expect(existsSync(join(dataDir, 'sdk-sessions'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    "keeps a fresh named data directory's sessions in it, made private",
    async () => {
      const dataDir = base();
      const dir = join(dataDir, 'sdk-sessions');
      expect(await controllerSessionsDir({ dataDir, named: true, runByConsole: false })).toBe(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      // Once there, it stays there, agents run or not.
      mkdirSync(join(dataDir, 'watchers'));
      expect(await controllerSessionsDir({ dataDir, named: true, runByConsole: false })).toBe(dir);
    }
  );

  it('leaves a named data directory that ran agents before on the folder its sessions are in', async () => {
    const dataDir = base();
    mkdirSync(join(dataDir, 'watchers', 'agent-1'), { recursive: true });
    expect(await controllerSessionsDir({ dataDir, named: true, runByConsole: false })).toBeNull();
    expect(existsSync(join(dataDir, 'sdk-sessions'))).toBe(false);
  });
});
