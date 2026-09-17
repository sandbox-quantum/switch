import { join } from 'node:path';
import { app } from 'electron';
import { OS_APP_NAME, USER_DATA_DIR_NAME } from '@shared/app-identity';

app.setName(OS_APP_NAME);

// Several dev builds can run side by side on one machine (one per worktree)
// when each keeps its own userData: the server list, sessions and the local
// database live there. Dev-only, so a packaged app never reads it.
const userDataDirName =
  (import.meta.env.DEV && process.env.SWITCH_CONSOLE_USER_DATA_DIR) || USER_DATA_DIR_NAME;
app.setPath('userData', join(app.getPath('appData'), userDataDirName));
