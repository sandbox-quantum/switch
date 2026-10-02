import { LOCAL_SERVER_ADMIN_EMAIL } from '@main/core/managed-switch-server/constants';
import { getSessionCookie, listServers } from '@main/core/switch-servers/servers-store';

/**
 * Email domains whose accounts are the company's own staff. Their usage is
 * internal: real, but not adoption, and product needs to tell the two apart.
 */
export const INTERNAL_EMAIL_DOMAINS: readonly string[] = ['sandboxaq.com', 'sandboxquantum.com'];

/**
 * Whether the person using this installation is staff, as the `flint_internal`
 * resource attribute: `true`, `false`, or `unknown` when no account says. Only
 * this travels; the address it was read from never leaves the machine.
 */
export type TelemetryInternal = 'true' | 'false' | 'unknown';

export function isInternalEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return INTERNAL_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * From the accounts this installation is signed in with. Any staff account
 * makes it internal; otherwise any real account makes it external. The
 * account a server Console runs for the user is a fixed local address that
 * says nothing about the person, so it does not count.
 */
export function internalFrom(emails: readonly (string | null)[]): TelemetryInternal {
  const real = emails.filter(
    (email): email is string =>
      email !== null && email.includes('@') && email.toLowerCase() !== LOCAL_SERVER_ADMIN_EMAIL
  );
  if (real.some(isInternalEmail)) return 'true';
  return real.length > 0 ? 'false' : 'unknown';
}

/**
 * The `email` claim of a gateway session, read without verifying it. That is
 * enough here: the token was issued to this app by the server, and the result
 * only labels usage data.
 */
export function emailFromJwt(jwt: string): string | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

/** From every server this installation holds a session for. */
export async function currentInternalFlag(): Promise<TelemetryInternal> {
  const servers = await listServers();
  const emails = await Promise.all(
    servers.map(async (server) => {
      const jwt = await getSessionCookie(server.id);
      return jwt === null ? null : emailFromJwt(jwt);
    })
  );
  return internalFrom(emails);
}
