import { join } from 'node:path';
import { app } from 'electron';
import { OS_APP_NAME, USER_DATA_DIR_NAME } from '@shared/app-identity';

app.setName(OS_APP_NAME);
app.setPath('userData', join(app.getPath('appData'), USER_DATA_DIR_NAME));
