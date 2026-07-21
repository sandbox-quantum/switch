import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@switchdash/shared';
import { BrowserWindow, session as electronSession } from 'electron';
import { LOCAL_SERVER_ADMIN_EMAIL } from '@main/core/managed-switch-server/constants';
import { managedServerSecretsKey } from '@main/core/managed-switch-server/host/host-for-server';
import { loadOrCreateSecrets } from '@main/core/managed-switch-server/secrets';
import { log } from '@main/lib/logger';
import type { SwitchServer, SwitchUser } from '@shared/core/switch-servers/switch-servers';
import { getSessionCookie, setSessionCookie } from './servers-store';

const SWITCH_AUTH_COOKIE = 'switch_auth';
const OIDC_LOGIN_TIMEOUT_MS = 300_000;

export type LoginError =
  | { kind: 'invalid_credentials'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'failed'; message: string };

function gatewayUrl(server: SwitchServer, path: string): string {
  return `${server.gatewayUrl}/gateway${path}`;
}

/** Pull the `switch_auth` value out of the response's Set-Cookie headers. */
function extractAuthCookie(setCookies: string[]): string | null {
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === SWITCH_AUTH_COOKIE) {
      return pair.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * Password login: POST credentials to the gateway, read the `switch_auth`
 * cookie off the response, and persist it encrypted. The gateway is a real
 * HTTP server, so doing this from the main process avoids the renderer's
 * cross-origin cookie restrictions entirely.
 */
export async function passwordLogin(
  server: SwitchServer,
  email: string,
  password: string
): Promise<Result<SwitchUser, LoginError>> {
  let response: Response;
  try {
    response = await fetch(gatewayUrl(server, '/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    return err({
      kind: 'failed',
      message: `Could not reach ${server.gatewayUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  if (response.status === 401) {
    return err({ kind: 'invalid_credentials', message: 'Invalid email or password.' });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return err({
      kind: 'failed',
      message: `Login failed (${response.status})${detail ? `: ${detail}` : ''}`,
    });
  }

  const jwt = extractAuthCookie(response.headers.getSetCookie());
  if (!jwt) {
    return err({
      kind: 'failed',
      message: 'Login succeeded but the gateway did not return a session cookie.',
    });
  }

  await setSessionCookie(server.id, jwt);
  const user = (await response.json()) as SwitchUser;
  return ok(user);
}

/**
 * Silent session renewal: exchange a still-valid `switch_auth` cookie for a
 * fresh one via `POST /auth/refresh`, persisting the new cookie with the same
 * encrypted per-server storage login uses. Provider-agnostic — the gateway
 * re-mints from the session, so it renews password and OIDC sessions alike
 * without replaying either login flow.
 *
 * Returns the new JWT, or `null` when renewal did not happen: a network failure
 * (transient — keep using the current token, retry next call) or a rejection
 * (the session is already expired/revoked, so the triggering call will 401 and
 * the caller falls back to interactive sign-in). Best-effort by design: it
 * never throws, so proactive renewal cannot break the call that triggered it.
 */
export async function refreshSession(
  server: SwitchServer,
  currentJwt: string
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(gatewayUrl(server, '/auth/refresh'), {
      method: 'POST',
      headers: { Accept: 'application/json', Cookie: `${SWITCH_AUTH_COOKIE}=${currentJwt}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    log.warn('Switch session renewal could not reach the gateway; keeping current token', {
      server: server.id,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }

  if (!response.ok) {
    log.warn('Switch session renewal was rejected; will fall back to sign-in once expired', {
      server: server.id,
      status: response.status,
    });
    return null;
  }

  const jwt = extractAuthCookie(response.headers.getSetCookie());
  if (!jwt) {
    log.warn('Switch session renewal succeeded but returned no cookie', { server: server.id });
    return null;
  }

  await setSessionCookie(server.id, jwt);
  return jwt;
}

/**
 * Silent re-login for the managed local server. switchdash generated that
 * server's admin password, so when its session is missing or expired we can
 * sign in again with no user interaction — the local server is meant to be
 * always signed in. Persists the fresh cookie (via `passwordLogin`) and returns
 * it for immediate reuse, or `null` when re-login failed (the caller then falls
 * back to the normal sign-in path). No-op for non-managed servers, whose
 * credentials switchdash does not hold.
 */
export async function reauthenticateManagedServer(server: SwitchServer): Promise<string | null> {
  if (!server.managed) return null;
  const secrets = await loadOrCreateSecrets({ secretsKey: managedServerSecretsKey(server) });
  const result = await passwordLogin(
    server,
    LOCAL_SERVER_ADMIN_EMAIL,
    secrets.gatewayAdminPassword
  );
  if (!result.success) {
    log.warn('Managed Switch server silent re-login failed; falling back to sign-in', {
      server: server.id,
      error: result.error,
    });
    return null;
  }
  return getSessionCookie(server.id);
}

/**
 * OIDC login: the gateway is the OIDC client, so we ride its server-mediated
 * flow in an embedded window — open `/auth/oidc/login`, let the gateway + IdP
 * complete the dance and set the `switch_auth` cookie, then read that cookie
 * out of the window's isolated session and persist it. httponly does not block
 * `cookies.get` because that is a main-process API, not `document.cookie`.
 */
export async function oidcLogin(server: SwitchServer): Promise<Result<true, LoginError>> {
  // A per-attempt partition keeps one server's IdP cookies from leaking into
  // another's and starts every login from a clean slate.
  const partition = `switch-oidc:${server.id}:${randomUUID()}`;
  const ses = electronSession.fromPartition(partition, { cache: false });

  const win = new BrowserWindow({
    width: 520,
    height: 720,
    title: `Sign in to ${server.name}`,
    autoHideMenuBar: true,
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true },
  });

  return new Promise<Result<true, LoginError>>((resolve) => {
    let settled = false;
    const finish = (result: Result<true, LoginError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(err({ kind: 'failed', message: 'OIDC sign-in timed out.' }));
    }, OIDC_LOGIN_TIMEOUT_MS);

    const tryCapture = async () => {
      if (settled) return;
      const cookies = await ses.cookies.get({ name: SWITCH_AUTH_COOKIE });
      const cookie = cookies[0];
      if (cookie?.value) {
        await setSessionCookie(server.id, cookie.value);
        finish(ok(true));
      }
    };

    // The cookie is set right before the gateway's final redirect to the SPA,
    // so check after each navigation rather than guessing a landing URL.
    win.webContents.on('did-navigate', () => void tryCapture());
    win.webContents.on('did-redirect-navigation', () => void tryCapture());
    win.webContents.on('did-frame-finish-load', () => void tryCapture());

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(err({ kind: 'cancelled', message: 'Sign-in window was closed.' }));
      }
    });

    void win.loadURL(gatewayUrl(server, '/auth/oidc/login')).catch((cause) => {
      finish(err({ kind: 'failed', message: `Could not open sign-in page: ${cause.message}` }));
    });
  });
}
