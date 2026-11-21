import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_MARKER_ENV } from '@switch-console/agent-providers-box';
import { afterEach, describe, expect, it } from 'vitest';
import { OwnerMarkers } from './owner-marker';
import { connectionIsHost, holdsSocket, socketInode } from './peer-check';

const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (local: string, remote: string, state: string, inode: string, uid = 1000) =>
  `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 20 4 30 10 -1`;

const markers = new OwnerMarkers(Buffer.alloc(32, 1));
const AGENT = 'agent-1';
const ROOT = '/data/agents/agent-1/watcher';
const BUNDLE = '/opt/switch/shared-host-daemon.mjs';
const PEER = 0xd431;
const RELAY = 0x1f90;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type FakeProcess = {
  pid: number;
  ppid: number;
  start: number;
  argv: string[];
  marker?: string | null;
  uid?: number;
  /** Socket inodes it holds. */
  sockets?: string[];
  exe?: string;
};

/** A `/proc` with these processes and one established connection from PEER to RELAY. */
async function fakeProc(processes: FakeProcess[], socket = { inode: '333', uid: 1000 }) {
  const proc = await mkdtemp(join(tmpdir(), 'peer-proc-'));
  roots.push(proc);
  await mkdir(join(proc, 'net'));
  await writeFile(
    join(proc, 'net', 'tcp'),
    [
      HEADER,
      row('0100007F:1F90', '00000000:0000', '0A', '111'),
      row('0100007F:1F90', '0100007F:D431', '01', '222'),
      row('0100007F:D431', '0100007F:1F90', '01', socket.inode, socket.uid),
    ].join('\n')
  );
  for (const p of processes) {
    const dir = join(proc, String(p.pid));
    await mkdir(join(dir, 'fd'), { recursive: true });
    await writeFile(
      join(dir, 'status'),
      `Name:\tnode\nTgid:\t${p.pid}\nUid:\t${p.uid ?? 1000}\t${p.uid ?? 1000}\t0\t0\n`
    );
    const fields = ['S', String(p.ppid), ...Array<string>(17).fill('0'), String(p.start)];
    await writeFile(join(dir, 'stat'), `${p.pid} (node) ${fields.join(' ')}\n`);
    const marker = p.marker === undefined ? markers.markerFor(AGENT) : p.marker;
    await writeFile(
      join(dir, 'environ'),
      marker === null ? 'PATH=/bin\0' : `PATH=/bin\0${OWNER_MARKER_ENV}=${marker}\0`
    );
    await writeFile(join(dir, 'cmdline'), `${p.argv.join('\0')}\0`);
    await symlink(p.exe ?? '/usr/bin/node', join(dir, 'exe'));
    for (const [i, inode] of (p.sockets ?? []).entries())
      await symlink(`socket:[${inode}]`, join(dir, 'fd', String(10 + i)));
  }
  return proc;
}

const supervisor = (over: Partial<FakeProcess> = {}): FakeProcess => ({
  pid: 10,
  ppid: 1,
  start: 100,
  argv: ['node', BUNDLE, ROOT, `${ROOT}/config.json`, '--watch-supervise'],
  ...over,
});
const worker = (over: Partial<FakeProcess> = {}): FakeProcess => ({
  pid: 11,
  ppid: 10,
  start: 110,
  argv: ['node', BUNDLE, ROOT, `${ROOT}/config.json`, '--watch-worker'],
  ...over,
});
/** A session host and its provider CLI under the worker. */
const sessionTree: FakeProcess[] = [
  {
    pid: 12,
    ppid: 11,
    start: 120,
    argv: ['node', '/opt/switch/session-host.mjs', '/data/sessions/abc'],
  },
  { pid: 13, ppid: 12, start: 130, argv: ['claude', '--print'] },
];

const check = (proc: string) =>
  connectionIsHost(AGENT, ROOT, PEER, RELAY, markers, { procRoot: proc, self: 1 });

describe('the hub peer check: reading /proc', () => {
  it('finds the established socket from the peer port to the relay port', () => {
    const table = [
      HEADER,
      row('0100007F:1F90', '00000000:0000', '0A', '111'),
      row('0100007F:1F90', '0100007F:D431', '01', '222'),
      row('0100007F:D431', '0100007F:1F90', '01', '333'),
    ].join('\n');
    expect(socketInode(table, PEER, RELAY)).toBe('333');
    expect(socketInode(table, PEER + 1, RELAY)).toBeNull();
  });

  it('ignores a socket that is not established, and an inode of 0', () => {
    const table = [
      HEADER,
      row('0100007F:D431', '0100007F:1F90', '06', '333'),
      row('0100007F:D431', '0100007F:1F90', '01', '0'),
    ].join('\n');
    expect(socketInode(table, PEER, RELAY)).toBeNull();
  });

  it('takes only loopback connections', () => {
    const table = [HEADER, row('0A00000A:D431', '0100007F:1F90', '01', '333')].join('\n');
    expect(socketInode(table, PEER, RELAY)).toBeNull();
    const mapped = [
      HEADER,
      row(
        '0000000000000000FFFF00000100007F:D431',
        '0000000000000000FFFF00000100007F:1F90',
        '01',
        '555'
      ),
    ].join('\n');
    expect(socketInode(mapped, PEER, RELAY)).toBe('555');
  });

  it('reads IPv6 rows', () => {
    const table = [
      HEADER,
      row(
        '00000000000000000000000001000000:D431',
        '00000000000000000000000001000000:1F90',
        '01',
        '444'
      ),
    ].join('\n');
    expect(socketInode(table, PEER, RELAY)).toBe('444');
  });

  it('holdsSocket looks in that process’s descriptors only', async () => {
    const proc = await fakeProc([worker({ sockets: ['333'] })]);
    expect(await holdsSocket(11, '333', proc)).toBe(true);
    expect(await holdsSocket(12, '333', proc)).toBe(false);
  });
});

describe('the hub peer check: proving the host by the process tree', () => {
  it('proves the agent’s worker under its supervisor', async () => {
    const proc = await fakeProc([supervisor(), worker({ sockets: ['333'] }), ...sessionTree]);
    expect(await check(proc)).toBe(true);
  });

  it('proves it while the launcher is still above the supervisor', async () => {
    const proc = await fakeProc([
      {
        pid: 9,
        ppid: 2,
        start: 90,
        argv: ['node', BUNDLE, ROOT, `${ROOT}/template.json`, '--ensure-watch', 'false'],
      },
      // The controller: no marker.
      { pid: 2, ppid: 1, start: 10, argv: ['node', 'controller.mjs'], marker: null },
      supervisor({ ppid: 9 }),
      worker({ sockets: ['333'] }),
    ]);
    expect(await check(proc)).toBe(true);
  });

  it('refuses a tool under the provider CLI, even one that names the root', async () => {
    const proc = await fakeProc([
      supervisor(),
      worker(),
      ...sessionTree,
      {
        pid: 14,
        ppid: 13,
        start: 140,
        argv: ['node', BUNDLE, ROOT, '--watch-worker'],
        sockets: ['333'],
      },
    ]);
    expect(await check(proc)).toBe(false);
  });

  it('refuses a tool that detached and built a tree of its own', async () => {
    const proc = await fakeProc([
      supervisor(),
      worker(),
      ...sessionTree,
      // Reparented to pid 1, looking like a supervisor, with a "worker" under it.
      { pid: 20, ppid: 1, start: 200, argv: ['node', BUNDLE, ROOT, 'x', '--watch-supervise'] },
      {
        pid: 21,
        ppid: 20,
        start: 210,
        argv: ['node', BUNDLE, ROOT, 'x', '--watch-worker'],
        sockets: ['333'],
      },
    ]);
    expect(await check(proc)).toBe(false);
  });

  it('refuses a holder that is another program than its supervisor', async () => {
    const otherExe = await fakeProc([
      supervisor(),
      worker({ exe: '/usr/bin/python3', sockets: ['333'] }),
    ]);
    expect(await check(otherExe)).toBe(false);
    const otherScript = await fakeProc([
      supervisor(),
      worker({ argv: ['node', '/tmp/tool.js', ROOT, '--watch-worker'], sockets: ['333'] }),
    ]);
    expect(await check(otherScript)).toBe(false);
  });

  it('refuses a holder with no supervisor above it', async () => {
    const proc = await fakeProc([worker({ ppid: 1, sockets: ['333'] })]);
    expect(await check(proc)).toBe(false);
  });

  it('refuses a holder whose command line only names a path under the root', async () => {
    const proc = await fakeProc([
      supervisor(),
      worker({ argv: ['node', BUNDLE, `${ROOT}/sessions`, '--watch-worker'], sockets: ['333'] }),
    ]);
    expect(await check(proc)).toBe(false);
  });

  it('refuses a holder without the agent’s marker, or with another agent’s', async () => {
    const unmarked = await fakeProc([supervisor(), worker({ marker: null, sockets: ['333'] })]);
    expect(await check(unmarked)).toBe(false);
    const other = await fakeProc([
      supervisor(),
      worker({ marker: markers.markerFor('agent-2'), sockets: ['333'] }),
    ]);
    expect(await check(other)).toBe(false);
  });

  it('refuses another agent’s host socket, whole tree and all', async () => {
    const theirs = markers.markerFor('agent-2');
    const proc = await fakeProc([
      supervisor({ marker: theirs }),
      worker({ marker: theirs, sockets: ['333'] }),
    ]);
    // Even with agent-2's tree naming agent-1's root, agent-1 is not proved by it.
    expect(await check(proc)).toBe(false);
  });

  it('follows a host restart: the new worker is proved, the old pid holds nothing', async () => {
    const proc = await fakeProc([supervisor(), worker({ pid: 15, start: 150, sockets: ['333'] })]);
    expect(await check(proc)).toBe(true);
    expect(await holdsSocket(11, '333', proc)).toBe(false);
  });

  it('refuses when the socket belongs to another uid', async () => {
    const proc = await fakeProc([supervisor(), worker({ sockets: ['333'] })], {
      inode: '333',
      uid: 2000,
    });
    expect(await check(proc)).toBe(false);
  });

  it('refuses when no process holds the socket, or there is no such connection', async () => {
    const nobody = await fakeProc([supervisor(), worker()]);
    expect(await check(nobody)).toBe(false);
    const proc = await fakeProc([supervisor(), worker({ sockets: ['333'] })]);
    expect(
      await connectionIsHost(AGENT, ROOT, PEER + 1, RELAY, markers, { procRoot: proc, self: 1 })
    ).toBe(false);
  });

  it('a host record a tool rewrote proves nothing: no file is read for the pid', async () => {
    const proc = await fakeProc([
      supervisor(),
      worker(),
      ...sessionTree,
      { pid: 14, ppid: 13, start: 140, argv: ['node', BUNDLE, ROOT], sockets: ['333'] },
    ]);
    // Whatever shared-owner.lock says, the holder is found from /proc and its tree is checked.
    await writeFile(join(proc, 'shared-owner.lock'), JSON.stringify({ pid: 14 }));
    expect(await check(proc)).toBe(false);
  });
});

/** A real process tree, as the shared daemon makes one: supervisor, worker, session host, CLI tool. */
const TREE_SCRIPT = `
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const [role, port, root] = process.argv.slice(2);
const self = (r, args) => spawn(process.execPath, [__filename, r, port, ...args], { stdio: ['ignore', 'inherit', 'ignore'] });
const say = (line) => process.stdout.write(line + '\\n');
const fds = () => fs.readdirSync('/proc/self/fd').map((fd) => { try { return fs.readlinkSync('/proc/self/fd/' + fd); } catch { return ''; } }).filter((t) => t.startsWith('socket:'));
if (role === 'sup') {
  // Restarts its worker when it exits, as the real supervisor does.
  const run = () => self('worker', [root]).on('exit', run);
  run();
} else if (role === 'worker') {
  const s = net.connect(Number(port), '127.0.0.1', () => {
    say('worker ' + process.pid + ' ' + s.localPort);
    self('session', []);
  });
} else if (role === 'session') {
  // A session host: its arguments don't name the agent's root. Its CLI's tool claims to.
  self('tool', [root]);
} else if (role === 'tool') {
  say('toolfds ' + fds().join(','));
  const s = net.connect(Number(port), '127.0.0.1', () => say('tool ' + process.pid + ' ' + s.localPort));
}
setInterval(() => {}, 30000);
`;

describe.runIf(process.platform === 'linux')('the hub peer check on this machine', () => {
  it('proves the real host, refuses its tool and another agent, and follows a host restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'peer-tree-'));
    roots.push(dir);
    const script = join(dir, 'tree.cjs');
    await writeFile(script, TREE_SCRIPT);
    const accepted: Socket[] = [];
    const server = createServer((socket) => accepted.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const env = { ...process.env, [OWNER_MARKER_ENV]: markers.markerFor(AGENT) };
    const sup = spawn(process.execPath, [script, 'sup', String(port), ROOT], {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines: string[] = [];
    let buffered = '';
    sup.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const parts = buffered.split('\n');
      buffered = parts.pop()!;
      lines.push(...parts);
    });
    const line = async (prefix: string, after = 0) => {
      for (let i = 0; i < 500; i++) {
        const found = lines.slice(after).find((l) => l.startsWith(prefix));
        if (found) return found.split(' ');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no ${prefix} line`);
    };
    const prove = (agentId: string, peer: number) =>
      connectionIsHost(agentId, ROOT, peer, port, markers);
    try {
      const [, workerPid, workerPort] = await line('worker ');
      const [, , toolPort] = await line('tool ');
      const [, toolFds] = await line('toolfds ');
      // The worker's own connection is its host's.
      expect(await prove(AGENT, Number(workerPort))).toBe(true);
      // The tool did not inherit the worker's socket: proved from its own /proc/self/fd.
      const workerSocket = socketInode(
        await readFile('/proc/net/tcp', 'utf8'),
        Number(workerPort),
        port
      );
      expect(workerSocket).not.toBeNull();
      expect((toolFds ?? '').split(',')).not.toContain(`socket:[${workerSocket}]`);
      // The tool's own connection, with the agent's token and claiming the root: refused.
      expect(await prove(AGENT, Number(toolPort))).toBe(false);
      // Another agent's token with this agent's host socket: refused.
      expect(await prove('agent-2', Number(workerPort))).toBe(false);
      // The host restarts: the old connection proves nothing, the new one does.
      const seen = lines.length;
      process.kill(Number(workerPid), 'SIGKILL');
      const [, , newPort] = await line('worker ', seen);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await prove(AGENT, Number(workerPort))).toBe(false);
      expect(await prove(AGENT, Number(newPort))).toBe(true);
    } finally {
      process.kill(-sup.pid!, 'SIGKILL');
      for (const socket of accepted) socket.destroy();
      server.close();
    }
  });
});
