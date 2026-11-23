import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** What Windows answers while another process has the file open. */
const SHARING_VIOLATIONS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const SHARING_WAIT_MS = 5_000;

/**
 * Renames `from` over `to`. On Windows a rename onto a file another process
 * has open — a reader of the same record, an antivirus scan — is refused for
 * as long as it stays open, so it is tried again for a few seconds before
 * the refusal is passed on.
 */
export async function replaceFile(from: string, to: string): Promise<void> {
  if (process.platform !== 'win32') return rename(from, to);
  const deadline = Date.now() + SHARING_WAIT_MS;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      return await rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!SHARING_VIOLATIONS.has(code) || Date.now() > deadline) throw error;
    }
    await delay(wait);
  }
}
