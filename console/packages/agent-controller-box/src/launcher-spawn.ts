import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  detachedSupervision,
  PUSH_KEY_BYTES,
  type Supervision,
} from '@switch-console/agent-providers-box';
import type { SpawnRecorder } from './launcher';

/**
 * On a split box, how the launcher starts an agent's host itself, so it knows the
 * host's pid from its own spawn, and hands it this launch's
 * push key on an inherited pipe, fd 3. The host reads the key before
 * anything else and closes the pipe; nothing else ever sees it.
 */
export function spawnedSupervision(input: {
  agentId: string;
  /** The shared-host bundle the supervisor runs. */
  bundlePath: string;
  /** Added to this process's environment: the launch's marker, and the tickets flag. */
  env: Record<string, string>;
  spawned: SpawnRecorder;
  /** Overrides `child_process.spawn` (tests). */
  spawn?: typeof nodeSpawn;
}): Supervision {
  const detached = detachedSupervision(input.bundlePath);
  return {
    build: input.bundlePath,
    links: null,
    stop: detached.stop,
    start: async ({ root, configPath, watcher }) => {
      const log = await open(join(root, 'supervisor.log'), 'a', 0o600);
      try {
        const key = randomBytes(PUSH_KEY_BYTES);
        const child = (input.spawn ?? nodeSpawn)(
          process.execPath,
          [input.bundlePath, root, configPath, watcher ? '--watch-supervise' : '--supervise'],
          {
            detached: true,
            stdio: ['ignore', log.fd, log.fd, 'pipe'],
            env: { ...process.env, ...input.env },
          }
        );
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        if (!child.pid) throw new Error('The agent host started with no process id.');
        input.spawned(input.agentId, child.pid, key);
        const pipe = child.stdio[3] as NodeJS.WritableStream | null;
        pipe?.on('error', () => {});
        pipe?.end(key);
        child.unref();
      } finally {
        await log.close();
      }
    },
  };
}

/**
 * The socket inode listening on loopback `port`, from `/proc/net/tcp` and
 * `tcp6`, or null. Read from the launcher's own view of the shared network.
 */
export async function listeningInode(procRoot: string, port: number): Promise<string | null> {
  const wanted = port.toString(16).toUpperCase().padStart(4, '0');
  for (const table of ['tcp', 'tcp6']) {
    let text: string;
    try {
      text = await readFile(join(procRoot, 'net', table), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const local = fields[1]!;
      const state = fields[3];
      // 0A is LISTEN.
      if (state === '0A' && local.split(':')[1] === wanted && /^\d+$/.test(fields[9]!))
        return fields[9]!;
    }
  }
  return null;
}

/**
 * Whether the spawned host, or one of its direct children (its worker serves
 * the control port), holds the socket listening on `port`.
 * Only processes whose parent is the host count, so a tool elsewhere listening
 * on the port the file names is never taken for the host.
 */
export async function portIsHosts(
  procRoot: string,
  hostPid: number,
  port: number
): Promise<boolean> {
  const inode = await listeningInode(procRoot, port);
  if (inode === null) return false;
  const target = `socket:[${inode}]`;
  const candidates = [hostPid];
  for (const name of await readdir(procRoot).catch(() => [] as string[])) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const stat = await readFile(join(procRoot, name, 'stat'), 'utf8').catch(() => null);
    if (stat === null) continue;
    // The fields after the command name, which ends at the last ')'.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(after[1]) === hostPid) candidates.push(Number(name));
  }
  for (const pid of candidates) {
    const fds = await readdir(join(procRoot, String(pid), 'fd')).catch(() => [] as string[]);
    for (const fd of fds) {
      const link = await readlink(join(procRoot, String(pid), 'fd', fd)).catch(() => null);
      if (link === target) return true;
    }
  }
  return false;
}
