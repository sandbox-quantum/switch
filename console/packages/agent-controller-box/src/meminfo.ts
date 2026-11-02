import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMINFO_MAX_BYTES } from './schemas';

/**
 * The box's own memory figures from `/proc/meminfo`, for the status report.
 *
 * Inside gVisor, Node's `freemem()` and `totalmem()` say little about what the
 * agents really hold: page cache counts as used, and the host's view counts
 * shared code once per process. `AnonPages` is the memory the box's processes
 * hold themselves, and `Cached` is what the kernel could give back. The cost
 * model and the live page read these two; nothing in the controller acts on
 * them.
 */

const KIB = 1024;

export interface MeminfoReading {
  /** `AnonPages`: memory the box's processes hold themselves, in bytes. */
  anon: number;
  /** `Cached`: the page cache, in bytes. */
  cached: number;
}

/**
 * Reads `AnonPages` and `Cached` from the text of `/proc/meminfo`. Null when
 * either is missing, not a whole number of kB, or out of range, so a strange
 * file never reaches the report.
 */
export function parseMeminfo(text: string): MeminfoReading | null {
  const field = (name: string): number | null => {
    const match = new RegExp(`^${name}:[ \\t]+(\\d{1,16}) kB$`, 'm').exec(text);
    if (!match) return null;
    const bytes = Number(match[1]) * KIB;
    return Number.isSafeInteger(bytes) && bytes <= MEMINFO_MAX_BYTES ? bytes : null;
  };
  const anon = field('AnonPages');
  const cached = field('Cached');
  if (anon === null || cached === null) return null;
  return { anon, cached };
}

/** The reading from `procRoot/meminfo`, or null where there is none (macOS, Windows) or it cannot be read. */
export async function readMeminfo(procRoot = '/proc'): Promise<MeminfoReading | null> {
  try {
    return parseMeminfo(await readFile(join(procRoot, 'meminfo'), 'utf8'));
  } catch {
    return null;
  }
}
