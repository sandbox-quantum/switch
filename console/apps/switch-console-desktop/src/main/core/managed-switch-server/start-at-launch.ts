import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const START_AT_LAUNCH_FILE = 'start-at-launch.json';

/**
 * Whether the server on this computer starts when Switch Console opens.
 *
 * It runs only while the app does, so it is stopped at every quit and started
 * again at the next launch — unless it was stopped from the app, which this
 * remembers so that a Stop is not undone by quitting and reopening. A server
 * that has never said either way (one set up before this was recorded) starts.
 */
export async function readStartAtLaunch(dir: string): Promise<boolean> {
  const file = path.join(dir, START_AT_LAUNCH_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  const parsed = JSON.parse(text) as { startAtLaunch?: unknown };
  if (typeof parsed.startAtLaunch !== 'boolean') {
    throw new Error(`${file} does not say whether the server starts at launch.`);
  }
  return parsed.startAtLaunch;
}

export async function writeStartAtLaunch(dir: string, startAtLaunch: boolean): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, START_AT_LAUNCH_FILE),
    `${JSON.stringify({ startAtLaunch }, null, 2)}\n`
  );
}
