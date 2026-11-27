import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listeningInode, portIsHosts, spawnedSupervision } from './launcher-spawn';

let dir: string;
let proc: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'launcher-spawn-'));
  proc = join(dir, 'proc');
  mkdirSync(join(proc, 'net'), { recursive: true });
  // Port 0x1F90 (8080) listening, inode 555; port 8081 connected, not listening.
  writeFileSync(
    join(proc, 'net', 'tcp'),
    [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  2000        0 555 1',
      '   1: 0100007F:1F91 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  2000        0 556 1',
    ].join('\n')
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function proc_(pid: number, ppid: number, sockets: string[]) {
  mkdirSync(join(proc, String(pid), 'fd'), { recursive: true });
  writeFileSync(join(proc, String(pid), 'stat'), `${pid} (node) S ${ppid} 1 1 0 -1`);
  sockets.forEach((target, fd) => symlinkSync(target, join(proc, String(pid), 'fd', String(fd))));
}

describe('the control port check', () => {
  it('finds only a listening socket on the port', async () => {
    expect(await listeningInode(proc, 8080)).toBe('555');
    expect(await listeningInode(proc, 8081)).toBeNull();
    expect(await listeningInode(proc, 9999)).toBeNull();
  });

  it('accepts the port when the spawned host or its own child holds it, and nobody else', async () => {
    proc_(10, 1, ['/dev/null']); // the spawned host
    proc_(11, 10, ['socket:[555]']); // its worker, serving the control port
    expect(await portIsHosts(proc, 10, 8080)).toBe(true);
    // A tool elsewhere holding it: not the host's.
    rmSync(join(proc, '11'), { recursive: true });
    proc_(30, 1, ['socket:[555]']);
    expect(await portIsHosts(proc, 10, 8080)).toBe(false);
    // Nothing listening there at all.
    expect(await portIsHosts(proc, 10, 9999)).toBe(false);
  });
});

describe('the spawn', () => {
  it('records the host pid from its own spawn and writes a fresh 32-byte key on fd 3', async () => {
    const root = join(dir, 'root');
    mkdirSync(root);
    const keyPipe = new PassThrough();
    const written: Buffer[] = [];
    keyPipe.on('data', (chunk: Buffer) => written.push(chunk));
    let options: { stdio?: unknown; env?: Record<string, string>; detached?: boolean } = {};
    const recorded: [string, number, Buffer][] = [];
    const supervision = spawnedSupervision({
      agentId: 'agent-x',
      bundlePath: '/b.mjs',
      env: { SWITCH_HUB_TICKETS: '1' },
      spawned: (agentId, pid, key) => void recorded.push([agentId, pid, key]),
      spawn: ((_cmd: string, _args: string[], given: typeof options) => {
        options = given;
        const child = Object.assign(new EventEmitter(), {
          pid: 4242,
          stdio: [null, null, null, keyPipe],
          unref: () => {},
        });
        setImmediate(() => child.emit('spawn'));
        return child;
      }) as never,
    });
    await supervision.start({ root, configPath: join(root, 'config.json'), watcher: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]![0]).toBe('agent-x');
    expect(recorded[0]![1]).toBe(4242);
    expect(recorded[0]![2]).toHaveLength(32);
    expect(Buffer.concat(written)).toEqual(recorded[0]![2]);
    expect((options.stdio as unknown[])[3]).toBe('pipe');
    expect(options.env?.SWITCH_HUB_TICKETS).toBe('1');
    expect(options.detached).toBe(true);
    // A second launch gets a different key.
    await supervision.start({ root, configPath: join(root, 'config.json'), watcher: true });
    expect(recorded[1]![2].equals(recorded[0]![2])).toBe(false);
  });
});
