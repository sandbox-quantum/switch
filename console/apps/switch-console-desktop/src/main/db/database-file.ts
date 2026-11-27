import fs from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { makeFileOwnerOnly, restrictExistingFilesToOwner } from '@main/lib/owner-only-files';
import { CURRENT_DB_FILENAME, LEGACY_DB_FILENAMES } from './default-path';

/** The files SQLite keeps beside a database, which it creates with the database's own mode. */
const SQLITE_COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'];

/**
 * Makes a database readable by its owner alone before it is opened: the file
 * is created empty (0600) when absent, so SQLite opens that one rather than
 * making its own with the default mode, and an existing one and its
 * companions are narrowed to 0600.
 */
export function makeDatabaseFilesOwnerOnly(databasePath: string): void {
  makeFileOwnerOnly(databasePath);
  restrictExistingFilesToOwner(
    SQLITE_COMPANION_SUFFIXES.map((suffix) => `${databasePath}${suffix}`)
  );
}

function quoteSqliteString(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

export function copySqliteDatabase(sourcePath: string, destinationPath: string): void {
  fs.mkdirSync(dirname(destinationPath), { recursive: true });
  // VACUUM INTO writes into an empty file that exists, keeping its mode.
  makeFileOwnerOnly(destinationPath);

  try {
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      source.pragma('busy_timeout = 5000');
      source.exec(`VACUUM INTO ${quoteSqliteString(destinationPath)}`);
    } finally {
      source.close();
    }
  } catch (error) {
    // Left behind, the file would pass for the current database at the next
    // launch, which would then start empty instead of copying again.
    fs.rmSync(destinationPath, { force: true });
    throw error;
  }
}

function clearCopiedAppSecrets(databasePath: string): void {
  const copied = new Database(databasePath, { fileMustExist: true });
  try {
    copied.pragma('busy_timeout = 5000');
    const hasAppSecretsTable = copied
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get('app_secrets');
    if (hasAppSecretsTable) {
      copied.exec('DELETE FROM app_secrets');
    }
  } finally {
    copied.close();
  }
}

export function resolveDefaultDatabasePath(userDataPath: string): string {
  fs.mkdirSync(userDataPath, { recursive: true });

  const currentPath = join(userDataPath, CURRENT_DB_FILENAME);
  if (fs.existsSync(currentPath)) {
    return currentPath;
  }

  // Migrate forward from the newest pre-rebrand database that exists, so an
  // install upgrading across the emdash->Switch Console rename keeps its data.
  for (const legacyFilename of LEGACY_DB_FILENAMES) {
    const legacyPath = join(userDataPath, legacyFilename);
    if (fs.existsSync(legacyPath)) {
      copySqliteDatabase(legacyPath, currentPath);
      clearCopiedAppSecrets(currentPath);
      break;
    }
  }

  return currentPath;
}
