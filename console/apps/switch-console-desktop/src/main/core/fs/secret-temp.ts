import { randomUUID } from 'node:crypto';

/**
 * A secret write puts the content in a temporary `<file>.<uuid>` beside the
 * file and renames it into place. A write cut off before the rename (the app
 * killed, the SSH connection dropped) leaves that copy behind holding the same
 * secret, so deleting the file removes those copies with it.
 */
export function secretTempPath(file: string): string {
  return `${file}.${randomUUID()}`;
}

/**
 * What follows the file's name in a temporary copy's name, as a regular
 * expression source. It is written without backslashes so it can be embedded
 * in a script run on a host.
 */
export const SECRET_TEMP_SUFFIX =
  '^[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

const suffix = new RegExp(SECRET_TEMP_SUFFIX);

/** Whether `entry`, a name in a directory, is a temporary copy of the file `name` there. */
export function isSecretTempOf(entry: string, name: string): boolean {
  return entry.startsWith(name) && suffix.test(entry.slice(name.length));
}
