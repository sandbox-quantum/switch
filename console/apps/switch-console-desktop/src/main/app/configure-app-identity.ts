import { join } from 'node:path';
import { app } from 'electron';
import { OS_APP_NAME } from '@shared/app-identity';
import { userDataDirName } from './user-data-dir';

app.setName(OS_APP_NAME);
app.setPath('userData', join(app.getPath('appData'), userDataDirName()));
