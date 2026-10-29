import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';
import { defaultDbFilePath, resolveDefaultUserDataPath } from './src/main/db/default-path';

// The dev database `pnpm dev` uses, never the installed app's: stable and Canary
// share `switchdash`, and a schema pushed or migrated into it from a branch
// leaves the installed app unable to open it.
function resolveDbUrl(): string {
  const explicit = process.env.SWITCHDASH_DB_FILE?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  return defaultDbFilePath(resolveDefaultUserDataPath('switchdash-dev'));
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
