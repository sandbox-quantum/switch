import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { log } from '@main/lib/logger';
import { LOCAL_SERVER_PROJECT_NAME } from '../constants';
import { detectDocker, dockerExecutable } from '../docker';
import type { NativeLayout } from './native-paths';
import { runCommand } from './run-command';

/** What an earlier Console wrote to run Mattermost beside a native server. */
const COMPOSE_FILE = 'mattermost-compose.yml';
const SETTINGS_FILE = 'mattermost.json';

/**
 * Remove the containers of a Mattermost an earlier Console ran beside the
 * native server. Its files volume and its database are kept, as user data.
 * The files that ran it go only once its containers are gone, so a failure is
 * tried again at the next start; it never fails the start itself.
 */
export async function removeLegacyMattermost(layout: NativeLayout): Promise<void> {
  const composeFile = path.join(layout.root, COMPOSE_FILE);
  // Kept in the local server's directory, which holds the native layout.
  const settingsFile = path.join(path.dirname(layout.root), SETTINGS_FILE);
  try {
    await stat(composeFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await rm(settingsFile, { force: true });
    return;
  }
  const docker = await detectDocker();
  if (!docker.available) {
    log.warn('local-switch-server: cannot remove the old Mattermost containers without Docker', {
      detail: docker.detail,
    });
    return;
  }
  try {
    await runCommand(
      dockerExecutable(),
      ['compose', '-p', `${LOCAL_SERVER_PROJECT_NAME}-mattermost`, '-f', composeFile, 'down'],
      { cwd: layout.root, env: process.env, onLine: () => {}, timeoutMs: 5 * 60 * 1000 }
    );
  } catch (error) {
    log.warn('local-switch-server: could not remove the old Mattermost containers', {
      error: String(error),
    });
    return;
  }
  await rm(composeFile, { force: true });
  await rm(settingsFile, { force: true });
}
