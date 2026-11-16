import { join } from 'node:path';
import { app } from 'electron';
import { log } from '@main/lib/logger';
import { makeDirOwnerOnly } from '@main/lib/owner-only-files';
import { OS_APP_NAME } from '@shared/app-identity';
import { userDataDirName } from './user-data-dir';

app.setName(OS_APP_NAME);
app.setPath('userData', join(app.getPath('appData'), userDataDirName()));

// Before anything is written there: the database, the log and the saved
// sign-ins' metadata are for this user alone.
try {
  makeDirOwnerOnly(app.getPath('userData'));
} catch (error) {
  log.warn('Could not make the data folder readable by this user alone', {
    path: app.getPath('userData'),
    error: String(error),
  });
}
