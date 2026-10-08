import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  controllerDataDir,
  defaultWorkspacePath,
  serverWorkspacesDir,
  EnrollmentFile,
  turnOffWatchers,
  wipeControllerIdentity,
} from './controller-files';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'embedded-controller-files-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('EnrollmentFile', () => {
  it('keeps one record per server in an owner-only file, and survives concurrent changes', async () => {
    const file = new EnrollmentFile(() => join(dir, 'nested', 'state.json'));
    expect(await file.all()).toEqual({});
    await Promise.all([
      file.set('server-1', {
        kind: 'enrolled',
        controllerId: 'c-1',
        server: 'https://a.example.com',
        name: 'box',
        workspaceId: 'w-1',
        enrolledAt: '2026-01-01T00:00:00Z',
      }),
      file.set('server-2', { kind: 'removed', controllerId: 'c-2', at: '2026-01-02T00:00:00Z' }),
    ]);
    expect(Object.keys(await file.all()).sort()).toEqual(['server-1', 'server-2']);
    expect(statSync(join(dir, 'nested', 'state.json')).mode & 0o777).toBe(0o600);
    await file.delete('server-1');
    expect(await file.get('server-1')).toBeNull();
    expect((await file.get('server-2'))?.kind).toBe('removed');
  });

  it('fails loud on a file it cannot read', async () => {
    writeFileSync(join(dir, 'state.json'), '{"version":2}');
    await expect(new EnrollmentFile(() => join(dir, 'state.json')).all()).rejects.toThrow();
  });
});

describe('controller data directory', () => {
  it('is one directory per server, and refuses an id that could leave it', () => {
    expect(controllerDataDir('/base', 'server-1')).toBe('/base/servers/server-1');
    expect(() => controllerDataDir('/base', '../escape')).toThrow(/cannot name a directory/);
    expect(defaultWorkspacePath('/home/me/.switch/agents', 'pm-agent')).toBe(
      '/home/me/.switch/agents/pm-agent'
    );
    expect(defaultWorkspacePath('/home/me/.switch/agents', '../escape')).toBeNull();
    expect(serverWorkspacesDir('/home/me', 'http://localhost:8000')).toBe(
      '/home/me/.switch/agents/localhost-8000'
    );
    expect(defaultWorkspacePath('/home/me/.switch/agents', '')).toBeNull();
  });

  it('turns off every watcher, and forgets the identity but not the work', async () => {
    const data = join(dir, 'servers', 'server-1');
    for (const agent of ['agent-1', 'agent-2']) {
      mkdirSync(join(data, 'watchers', agent), { recursive: true });
      mkdirSync(join(data, 'agents', agent), { recursive: true });
      writeFileSync(join(data, 'agents', agent, 'credentials.json'), '{}');
    }
    writeFileSync(join(data, 'watchers', 'agent-1', 'watch.json'), '{"enabled":true,"spawn":true}');
    for (const name of ['controller.db', 'controller.db-wal', 'controller.db-shm'])
      writeFileSync(join(data, name), '');
    mkdirSync(join(data, 'workspaces', 'scout'), { recursive: true });
    writeFileSync(join(data, 'workspaces', 'scout', 'notes.md'), 'work');

    expect(await turnOffWatchers(data)).toBe(2);
    for (const agent of ['agent-1', 'agent-2'])
      expect(JSON.parse(readFileSync(join(data, 'watchers', agent, 'watch.json'), 'utf8'))).toEqual(
        { enabled: false, spawn: false }
      );
    await wipeControllerIdentity(data);
    expect(readdirSync(data).sort()).toEqual(['watchers', 'workspaces']);
    expect(readFileSync(join(data, 'workspaces', 'scout', 'notes.md'), 'utf8')).toBe('work');
    expect(await turnOffWatchers(join(dir, 'missing'))).toBe(0);
  });
});
