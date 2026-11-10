import { userInfo } from 'node:os';
import { execCommand } from '@main/core/app/utils';

/** The OS account's full name (`id -F` on macOS), else its username; null when neither is readable. */
export async function osUserFullName(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const fullName = (await execCommand('id -F', { timeout: 5_000 })).trim();
      if (fullName) return fullName;
    } catch {
      // Fall through to the username.
    }
  }
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}
