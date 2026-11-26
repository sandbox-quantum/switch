import { readdir, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { listProcesses, type OwnerMarkers, type ProcessEntry, ProcReader } from './owner-marker';

/**
 * Whether a hub connection really comes from the agent's own host process,
 * not from anything else holding the agent's relay token (the valve's
 * trust check). An agent's tools run as the same user as its host and can
 * read its credentials, so the token alone can't tell them apart. The kernel
 * can: a connection's socket is open in the process that made it.
 *
 * Proved from `/proc` alone, never from a file the agent's processes can
 * write (an owner record, health):
 *
 * 1. The socket: the row of `/proc/net/tcp` (or `tcp6`) whose local port is
 *    the connection's peer port and whose remote port is the relay's gives
 *    its inode and its owner's uid. Read a line at a time, capped.
 * 2. Its holder: among the processes carrying the agent's owner marker, the
 *    one whose `/proc/<pid>/fd` holds `socket:[inode]`, running as the
 *    socket's uid.
 * 3. That it is the host, by the process tree: it and every marked ancestor
 *    above it up to the agent's top process (a host's are its supervisor
 *    and the shared daemon) are one program, the same executable running
 *    the same script, each naming the agent's state root as an argument of
 *    its own. A tool is a descendant of a session
 *    host and a provider CLI, whose command lines don't. And the top process
 *    is the agent's oldest marked process: a tool that detaches and makes
 *    a tree of its own starts after the real one, so its top is younger.
 *
 * Where `/proc` can't say (another platform, another user's processes in a
 * separate-user runtime, a file past its cap), the answer is no, and the
 * host stays on its narrower fallback valve.
 *
 * On a box where the agents' tools run as the controller's user this is
 * defence in depth, not a boundary: a process that can attach to the host,
 * or kill the agent's supervisor and stand in for it, gets past it. The fix
 * is separate users per agent (before real users).
 */

/** The most descriptors looked through in one process: a host holds far fewer. */
const MAX_FDS = 4096;
/** The most of `/proc/net/tcp` read: about 100,000 sockets. */
const TCP_TABLE_MAX = 16 * 1024 * 1024;
/** The most of a `cmdline` read (above `execve`'s limit, as `PROC_FILE_MAX`). */
const CMDLINE_MAX = 8 * 1024 * 1024;
const ESTABLISHED = '01';

export type SocketRow = { inode: string; uid: number };

/** One `/proc/net/tcp` line's socket, if it is the connection from `peerPort` to `localPort`. */
export function socketRow(line: string, peerPort: number, localPort: number): SocketRow | null {
  const cols = line.trim().split(/\s+/);
  if (cols.length < 10 || cols[3] !== ESTABLISHED) return null;
  if (portOf(cols[1]!) !== peerPort || portOf(cols[2]!) !== localPort) return null;
  // Both ends on loopback: the relay listens on 127.0.0.1 only.
  if (!isLoopback(cols[1]!) || !isLoopback(cols[2]!)) return null;
  const uid = Number(cols[7]);
  const inode = cols[9]!;
  if (!/^[1-9]\d*$/.test(inode) || !Number.isSafeInteger(uid) || uid < 0) return null;
  return { inode, uid };
}

/** The socket for the connection from `peerPort` to `localPort` in a whole table (for tests). */
export function socketInode(table: string, peerPort: number, localPort: number): string | null {
  for (const line of table.split('\n').slice(1)) {
    const row = socketRow(line, peerPort, localPort);
    if (row) return row.inode;
  }
  return null;
}

/**
 * Whether a `/proc/net/tcp` address is loopback: 127.0.0.0/8 (stored
 * little-endian, so its last byte pair is `7F`), `::1`, or 127/8 mapped
 * into IPv6.
 */
function isLoopback(address: string): boolean {
  const host = address.slice(0, address.lastIndexOf(':')).toUpperCase();
  if (host.length === 8) return host.endsWith('7F');
  if (host === '00000000000000000000000001000000') return true;
  return host.length === 32 && host.startsWith('0000000000000000FFFF0000') && host.endsWith('7F');
}

function portOf(address: string): number {
  const hex = address.slice(address.lastIndexOf(':') + 1);
  return /^[0-9A-Fa-f]{4}$/.test(hex) ? Number.parseInt(hex, 16) : -1;
}

/** Whether process `pid` holds the socket with `inode` open. */
export async function holdsSocket(
  pid: number,
  inode: string,
  procRoot = '/proc'
): Promise<boolean> {
  const dir = join(procRoot, String(pid), 'fd');
  let fds: string[];
  try {
    fds = await readdir(dir);
  } catch {
    return false;
  }
  const wanted = `socket:[${inode}]`;
  for (const fd of fds.slice(0, MAX_FDS)) {
    const target = await readlink(join(dir, fd)).catch(() => null);
    if (target === wanted) return true;
  }
  return false;
}

export type PeerCheckOptions = {
  procRoot?: string;
  /** This process, never a candidate. */
  self?: number;
  reader?: ProcReader;
};

/**
 * Whether the connection from `peerPort` to the relay on `localPort` is held
 * by `agentId`'s host, whose state root is `stateRoot`, proved as above.
 */
export async function connectionIsHost(
  agentId: string,
  stateRoot: string,
  peerPort: number,
  localPort: number,
  markers: OwnerMarkers,
  options: PeerCheckOptions = {}
): Promise<boolean> {
  if (process.platform !== 'linux' && options.procRoot === undefined) return false;
  const procRoot = options.procRoot ?? '/proc';
  const reader = options.reader ?? new ProcReader();
  try {
    const socket = await findSocket(reader, procRoot, peerPort, localPort);
    if (!socket) return false;
    const marked = (
      await listProcesses(markers, [agentId], { procRoot, self: options.self }, reader)
    ).filter((entry) => entry.owner === agentId);
    if (!marked.length) return false;
    const byPid = new Map(marked.map((entry) => [entry.pid, entry]));
    const roots = new Set([stateRoot, resolve(stateRoot)]);
    let holder: ProcessEntry | null = null;
    for (const entry of marked)
      if (await holdsSocket(entry.pid, socket.inode, procRoot)) {
        holder = entry;
        break;
      }
    if (!holder) return false;
    if ((await uidOf(reader, procRoot, holder.pid)) !== socket.uid) return false;
    // The holder and each marked ancestor are one program: the same executable
    // running the same script (the shared-host bundle), naming the state root,
    // and each older than its child.
    let current = holder;
    const program = await programOf(reader, procRoot, current.pid, roots);
    if (!program) return false;
    let ancestors = 0;
    for (let parent = byPid.get(current.ppid); parent; parent = byPid.get(current.ppid)) {
      if (parent.startTicks > current.startTicks) return false;
      const theirs = await programOf(reader, procRoot, parent.pid, roots);
      if (!theirs || theirs.exe !== program.exe || theirs.script !== program.script) return false;
      current = parent;
      if (++ancestors > 16) return false;
    }
    // A host always runs under its supervisor: one with no marked parent is not one.
    if (ancestors === 0) return false;
    // The top is the agent's oldest marked process.
    const oldest = Math.min(...marked.map((entry) => entry.startTicks));
    return current.startTicks === oldest;
  } catch {
    return false;
  } finally {
    reader.settle();
  }
}

async function findSocket(
  reader: ProcReader,
  procRoot: string,
  peerPort: number,
  localPort: number
): Promise<SocketRow | null> {
  for (const table of ['tcp', 'tcp6']) {
    let found: SocketRow | null = null;
    try {
      await reader.eachLine(
        join(procRoot, 'net', table),
        (line) => {
          found ??= socketRow(line, peerPort, localPort);
        },
        TCP_TABLE_MAX
      );
    } catch {
      // Missing, or past its cap: no proof from this table.
    }
    if (found) return found;
  }
  return null;
}

/**
 * What `pid` runs, if it names the state root as one of its own arguments
 * (exactly, never a path under it): its executable and its script (its
 * first argument, an absolute path). Null when it doesn't, or can't be read.
 */
async function programOf(
  reader: ProcReader,
  procRoot: string,
  pid: number,
  roots: Set<string>
): Promise<{ exe: string; script: string } | null> {
  const args = (await reader.read(join(procRoot, String(pid), 'cmdline'), CMDLINE_MAX))
    .toString('utf8')
    .split('\0');
  if (!args.some((arg) => roots.has(arg))) return null;
  // The first argument is taken as the script: the launcher, supervisor and host are all started as
  // `node <bundle> …` with no node flags (`spawn(process.execPath, [bundle, …])`). If a host were ever
  // started with a node flag, this would read the flag instead, and the chain check would refuse it
  // (fail closed). Keep node flags off the agent hosts, as the "no host carries the flag" test checks.
  const script = args[1] ?? '';
  if (!script.startsWith('/')) return null;
  const exe = await readlink(join(procRoot, String(pid), 'exe')).catch(() => null);
  return exe ? { exe, script } : null;
}

async function uidOf(reader: ProcReader, procRoot: string, pid: number): Promise<number | null> {
  const status = await reader.text(join(procRoot, String(pid), 'status'));
  const match = /^Uid:\s*(\d+)/m.exec(status);
  return match ? Number(match[1]) : null;
}
