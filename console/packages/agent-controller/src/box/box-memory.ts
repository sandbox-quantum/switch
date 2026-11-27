import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readUsage } from '@switch-console/agent-providers/box';
import type { ProcReader } from './owner-marker';

/**
 * Box only: reading memory. The box's own reading is what the box valve parks
 * idle sessions and refuses new ones by; a process's anonymous bytes are what
 * a split box's launcher counts for each agent and for strangers in its
 * `measure`, the link's heartbeat.
 */

const KIB = 1024;

/**
 * The anonymous memory a process holds, from its `/proc/<pid>/smaps`: the sum
 * of every mapping's `Anonymous` line. Inside gVisor there is no
 * `smaps_rollup`, `Pss` equals `Rss`, and `VmRSS` counts shared code once per
 * process (over 2x high on box A, 27 Oct); `Anonymous` summed reads about
 * 15-20% above the box's own AnonPages, an upper estimate.
 */
export function anonymousBytes(smaps: string): number {
  let total = 0;
  for (const match of smaps.matchAll(/^Anonymous:\s+(\d+) kB$/gm)) total += Number(match[1]) * KIB;
  return total;
}

/**
 * The most of a `smaps` the launcher reads. It grows with a process's mappings,
 * so a runaway (or a process making thousands of small mappings on purpose)
 * can pass it; that process is then measured from its `status` instead.
 */
export const SMAPS_MAX = 16 * 1024 * 1024;

/**
 * `anonymousBytes` of a `smaps` file, read a chunk at a time through `reader`,
 * never whole. Past `maxBytes`, `complete` is false and `bytes` is what was
 * read before it.
 */
export async function anonymousBytesIn(
  reader: ProcReader,
  path: string,
  maxBytes = SMAPS_MAX
): Promise<{ bytes: number; complete: boolean }> {
  let bytes = 0;
  const add = (line: Buffer, start: number, end: number) => {
    const kib = anonymousKiB(line, start, end);
    if (kib !== null) bytes += kib * KIB;
  };
  try {
    await reader.eachLineBytes(path, add, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EFBIG') return { bytes, complete: false };
    throw error;
  }
  return { bytes, complete: true };
}

const ANONYMOUS_KEY = Buffer.from('Anonymous:', 'latin1');
const KB_SUFFIX = Buffer.from(' kB', 'latin1');
const SPACE = 0x20;
const TAB = 0x09;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;

/**
 * The kB of an `Anonymous:` line (`Anonymous:` and spaces, digits, ` kB`), read
 * from its bytes without a string, or null for any other line.
 */
export function anonymousKiB(line: Buffer, start: number, end: number): number | null {
  if (end - start < ANONYMOUS_KEY.length + 1 + KB_SUFFIX.length) return null;
  if (
    line.compare(ANONYMOUS_KEY, 0, ANONYMOUS_KEY.length, start, start + ANONYMOUS_KEY.length) !== 0
  )
    return null;
  let at = start + ANONYMOUS_KEY.length;
  const spaced = at;
  while (at < end && (line[at] === SPACE || line[at] === TAB)) at++;
  if (at === spaced) return null;
  let kib = 0;
  const digits = at;
  while (at < end && line[at]! >= DIGIT_0 && line[at]! <= DIGIT_9) {
    kib = kib * 10 + (line[at]! - DIGIT_0);
    at++;
  }
  if (at === digits || end - at !== KB_SUFFIX.length) return null;
  return line.compare(KB_SUFFIX, 0, KB_SUFFIX.length, at, end) === 0 ? kib : null;
}

/** The fields of `/proc/meminfo` the box's reading uses, in bytes; null when one is missing. */
export function boxMemoryFromMeminfo(
  meminfo: string
): { anon: number; shmem: number; total: number } | null {
  const field = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(meminfo);
    return match ? Number(match[1]) * KIB : null;
  };
  const anon = field('AnonPages');
  const shmem = field('Shmem');
  const total = field('MemTotal');
  if (anon === null || shmem === null || total === null) return null;
  return { anon, shmem, total };
}

/**
 * The box's memory as the box valve judges it: gVisor's AnonPages plus Shmem
 * (memory held as files in RAM, `/dev/shm` among them, which no process's
 * `Anonymous` shows), or the cgroup reading the box-full gate uses when that
 * is higher. Null when neither can be read.
 */
export async function readBoxMemory(
  options: { procRoot?: string; cgroupUsage?: () => Promise<number | null> } = {}
): Promise<BoxReading | null> {
  let fromMeminfo: { anon: number; shmem: number } | null = null;
  let used: number | null = null;
  try {
    const meminfo = await readFile(join(options.procRoot ?? '/proc', 'meminfo'), 'utf8');
    fromMeminfo = boxMemoryFromMeminfo(meminfo);
    // A meminfo without AnonPages or Shmem still says what is in use; under
    // gVisor it is the only reading that sees the whole pod.
    if (fromMeminfo === null) used = usedFromMeminfo(meminfo);
  } catch {
    // Read from the cgroup alone.
  }
  const fromCgroup = (await (options.cgroupUsage ?? readUsage)()) ?? null;
  if (fromMeminfo === null) {
    if (used !== null) {
      const cgroupWins = fromCgroup !== null && fromCgroup > used;
      return {
        bytes: cgroupWins ? fromCgroup : used,
        shmem: null,
        source: cgroupWins ? 'cgroup' : 'meminfo_used',
      };
    }
    return fromCgroup === null ? null : { bytes: fromCgroup, shmem: null, source: 'cgroup' };
  }
  const inside = fromMeminfo.anon + fromMeminfo.shmem;
  const cgroupWins = fromCgroup !== null && fromCgroup > inside;
  return {
    bytes: cgroupWins ? fromCgroup : inside,
    shmem: fromMeminfo.shmem,
    source: cgroupWins ? 'cgroup' : 'meminfo',
  };
}

/** `MemTotal − MemAvailable` from `/proc/meminfo`, in bytes, or null when either is missing. */
export function usedFromMeminfo(meminfo: string): number | null {
  const field = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(meminfo);
    return match ? Number(match[1]) * KIB : null;
  };
  const total = field('MemTotal');
  const available = field('MemAvailable');
  if (total === null || available === null) return null;
  return Math.max(0, total - available);
}

/** The box's reading, and the part of it held as files in RAM, when known. */
export interface BoxReading {
  bytes: number;
  shmem: number | null;
  /**
   * Which reading won: `meminfo` (AnonPages + Shmem), `meminfo_used`
   * (MemTotal − MemAvailable, when those two are missing) or `cgroup`. Under
   * gVisor only a meminfo source sees the whole pod.
   */
  source?: 'meminfo' | 'meminfo_used' | 'cgroup';
}
