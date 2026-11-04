import { DEFAULT_SERVER_URL } from '@shared/app-identity';

/**
 * What the "Server address" box starts with: the address the wizard was given,
 * else the server being fixed, else (only when adding a server) this build's
 * default, which is empty on every build but the hosted agents v2 test build.
 */
export function startingServerUrl(
  initialUrl: string | null,
  existingUrl: string | null,
  isEdit: boolean,
  fallback: string | null = DEFAULT_SERVER_URL
): string {
  return initialUrl ?? existingUrl ?? (isEdit ? '' : (fallback ?? ''));
}
