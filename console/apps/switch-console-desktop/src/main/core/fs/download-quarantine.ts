import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { log } from '@main/lib/logger';
import { PRODUCT_NAME } from '@shared/app-identity';

const execFileAsync = promisify(execFile);

/**
 * The quarantine record a browser writes on macOS: flags `0081` (downloaded,
 * not yet approved; what Chrome writes), the time in hex seconds, the app that
 * saved it, and an event id. Gatekeeper checks a file carrying it the first
 * time it is opened.
 */
function quarantineRecord(now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000).toString(16);
  return `0081;${seconds};${PRODUCT_NAME};${randomUUID().toUpperCase()}`;
}

/** Zone 3 is the Internet zone: SmartScreen and Office's Protected View check what carries it. */
const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n';

/**
 * Mark a file Console saved from a room as downloaded from the internet, so
 * the OS checks it before it first runs it, as it would a file a browser
 * saved: `com.apple.quarantine` on macOS, the `Zone.Identifier` stream on
 * Windows. Linux has no such mark.
 *
 * A failure is logged rather than thrown: the file is already saved where the
 * person chose, and losing the save over the mark is worse than a saved file
 * the log says went unmarked.
 */
export async function markDownloaded(filePath: string): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      await execFileAsync(
        '/usr/bin/xattr',
        ['-w', 'com.apple.quarantine', quarantineRecord(new Date()), filePath],
        { timeout: 15_000 }
      );
    } else if (process.platform === 'win32') {
      await writeFile(`${filePath}:Zone.Identifier`, ZONE_IDENTIFIER);
    }
  } catch (error) {
    log.warn('fs: could not mark a saved attachment as downloaded; the OS will not check it', {
      event: 'download_mark_failed',
      platform: process.platform,
      path: filePath,
      error: String((error as Error)?.message ?? error),
    });
  }
}
