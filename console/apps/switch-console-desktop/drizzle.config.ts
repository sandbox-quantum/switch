import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';
import { checkedFolderName, USER_DATA_DIR_ENV } from './src/main/app/user-data-dir';
import { defaultDbFilePath, resolveDefaultUserDataPath } from './src/main/db/default-path';
import { DEV_USER_DATA_DIR_NAME } from './src/shared/app-identity';

// The database `pnpm dev` uses — in the worktree's own data folder when
// SWITCH_CONSOLE_USER_DATA_DIR names one — never the installed app's: stable
// and Canary share `switchdash`, and a schema pushed or migrated into it from a
// branch leaves the installed app unable to open it. Not userDataDirName() or
// USER_DATA_DIR_NAME: outside the Vite build both resolve to `switchdash`.
function resolveDbUrl(): string {
  const explicit = process.env.SWITCHDASH_DB_FILE?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  const named = process.env[USER_DATA_DIR_ENV];
  return defaultDbFilePath(
    resolveDefaultUserDataPath(named ? checkedFolderName(named) : DEV_USER_DATA_DIR_NAME)
  );
}

export default defineConfig({
  schema: './src/main/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: resolveDbUrl(),
  },
  strict: true,
  verbose: true,
});
