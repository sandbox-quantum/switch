import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { composeFilePath } from './paths';
import composeYaml from './resources/standalone-docker-compose.pinned.yml?raw';

/** The standalone compose bundled into the app (pinned to
 * COMPATIBLE_SWITCH_VERSION), inlined at build time. */
export function bundledComposeYaml(): string {
  return composeYaml;
}

/** Write the bundled compose to disk so `docker compose -f <path>` can run it,
 * returning the path. Docker cannot read a file inside the packaged app bundle,
 * so it is materialised into the user-data dir on every start (cheap, and keeps
 * the on-disk copy in lockstep with the app version). */
export async function materialiseComposeFile(): Promise<string> {
  const path = composeFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, composeYaml, 'utf8');
  return path;
}
