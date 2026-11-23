import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Writes a CLI for a test that runs `script` with this Node, and returns the
 * path to start it by: an executable script with a shebang on macOS and Linux,
 * or a `.cmd` beside the script on Windows, the way npm installs one there.
 */
export async function writeNodeCli(dir: string, name: string, script: string): Promise<string> {
  if (process.platform !== 'win32') {
    const path = join(dir, name);
    await writeFile(path, `#!${process.execPath}\n${script}`, { mode: 0o700 });
    return path;
  }
  await writeFile(join(dir, `${name}.js`), script);
  const path = join(dir, `${name}.cmd`);
  await writeFile(path, `@ECHO off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`);
  return path;
}
