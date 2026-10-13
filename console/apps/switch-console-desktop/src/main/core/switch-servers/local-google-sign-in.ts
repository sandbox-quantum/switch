import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where `gcloud auth application-default login` writes this computer's Google sign-in. */
export function localGoogleCredentialsPath(): string {
  const config =
    process.env.CLOUDSDK_CONFIG ||
    (process.platform === 'win32' && process.env.APPDATA
      ? join(process.env.APPDATA, 'gcloud')
      : join(homedir(), '.config', 'gcloud'));
  return join(config, 'application_default_credentials.json');
}

const MAX_BYTES = 16384;

/** This computer's Google application-default sign-in, as its file holds it. */
export async function readLocalGoogleCredentials(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        'This computer has no Google sign-in. Run `gcloud auth application-default login` on this computer first.'
      );
    throw new Error(
      `Could not read this computer's Google sign-in at ${path}. Check its permissions.`
    );
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error(`This computer's Google sign-in at ${path} is not a JSON file under 16 KiB.`);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES)
      throw new Error(`This computer's Google sign-in at ${path} is too large.`);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await file.close();
  }
}
