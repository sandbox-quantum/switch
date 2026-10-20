import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { err, ok, type Result } from '@switch-console/shared';
import { BrowserWindow, session as electronSession, shell } from 'electron';
import { z } from 'zod';
import { appReturnUrl, bringToFront } from '@main/app/deeplinks';
import { LOCAL_SERVER_ADMIN_EMAIL } from '@main/core/managed-switch-server/constants';
import { managedServerSecretsKey } from '@main/core/managed-switch-server/host/host-for-server';
import { readSecrets } from '@main/core/managed-switch-server/secrets';
import { log } from '@main/lib/logger';
import {
  dashboardOrigin,
  type SignupResult,
  type SwitchServer,
  type SwitchUser,
} from '@shared/core/switch-servers/switch-servers';
import { consoleIdentityHeaders } from './console-identity';
import { keepSeparateDashboard } from './server-address';
import { getSessionCookie, setSessionCookie } from './servers-store';

const SWITCH_AUTH_COOKIE = 'switch_auth';
/** Where switch-core's identity provider returns a browser sign-in. */
const OIDC_CALLBACK_PATH = '/auth/oidc/callback';
const OIDC_LOGIN_TIMEOUT_MS = 300_000;

export type LoginError =
  | { kind: 'invalid_credentials'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'failed'; message: string };

function gatewayUrl(server: SwitchServer, path: string): string {
  return `${server.url}/gateway${path}`;
}

/**
 * The same path on the origin the server's web pages are served from. Browser
 * sign-in starts there: the server keeps the OIDC state in a cookie on the host
 * the flow starts on, and an older server's identity provider returns to its
 * dashboard's host, so starting anywhere else loses the state. Where Console
 * has no dashboard address for such a server, the sign-in window follows the
 * server to that host itself (see {@link callbackHostHop}).
 */
function webGatewayUrl(server: SwitchServer, path: string): string {
  return `${dashboardOrigin(server)}/gateway${path}`;
}

/**
 * Where to restart a browser sign-in that the server is sending to an identity
 * provider which will return it to another host, or null to let it go on.
 *
 * Asked of the first redirect that leaves the host the sign-in started on: the
 * server's own, on its way to the provider, carrying the `redirect_uri` the
 * provider will return to. The flow's state is in a cookie on the starting
 * host, so a return to a different one would find none. A current server makes
 * that hop itself before this point; an older one, whose dashboard is on a host
 * of its own, does not. Hostnames only, as cookies do. Nothing later is asked,
 * so a page on the provider's side cannot steer it, and only a return to a
 * Switch sign-in callback counts: a proxy with a sign-in of its own in front of
 * the dashboard returns somewhere else, and is left to run.
 */
export function callbackHostHop(startUrl: string, redirectUrl: string): string | null {
  const start = new URL(startUrl);
  let callback: URL;
  try {
    const redirectUri = new URL(redirectUrl).searchParams.get('redirect_uri');
    if (redirectUri === null) return null;
    callback = new URL(redirectUri);
  } catch {
    return null;
  }
  if (callback.protocol !== 'https:' && callback.protocol !== 'http:') return null;
  if (!callback.pathname.endsWith(OIDC_CALLBACK_PATH)) return null;
  return callback.hostname === start.hostname ? null : callback.origin;
}

/** Pull the `switch_auth` value out of the response's Set-Cookie headers. */
export function extractAuthCookie(setCookies: string[]): string | null {
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

export type SignupError =
  | { kind: 'disabled'; message: string }
  | { kind: 'email_taken'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'failed'; message: string };

type TransportError = { kind: 'failed'; message: string };

async function postCredentials(
  server: SwitchServer,
  path: string,
  body: Record<string, string>
): Promise<Result<Response, TransportError>> {
  const identity = await consoleIdentityHeaders(server);
  try {
    return ok(
      await fetch(gatewayUrl(server, path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...identity },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      })
    );
  } catch (cause) {
    return err({
      kind: 'failed',
      message: `Could not reach ${server.url}. Check that the address is right and that the server is running. (${cause instanceof Error ? cause.message : String(cause)})`,
    });
  }
}

/** A failing gateway may answer with an HTML error page rather than a
 * sentence; unbounded, that lands in the form as a wall of markup. */
function boundedBody(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Read the `switch_auth` cookie off a successful auth response and persist it. */
async function persistSessionCookie(
  server: SwitchServer,
  response: Response,
  action: string
): Promise<Result<true, TransportError>> {
  const jwt = extractAuthCookie(response.headers.getSetCookie());
  if (!jwt) {
    return err({
      kind: 'failed',
      message: `${action} succeeded but the gateway did not return a session cookie.`,
    });
  }
  await setSessionCookie(server.id, jwt);
  return ok(true);
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
  const posted = await postCredentials(server, '/auth/login', { email, password });
  if (!posted.success) return posted;
  const response = posted.data;

  if (response.status === 401) {
    return err({ kind: 'invalid_credentials', message: 'Invalid email or password.' });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return err({
      kind: 'failed',
      message: `${server.url} rejected the sign-in with HTTP ${response.status}. That is a problem on the server, not with your credentials.${
        detail ? ` (${boundedBody(detail)})` : ''
      }`,
    });
  }

  const stored = await persistSessionCookie(server, response, 'Login');
  if (!stored.success) return stored;
  const user = (await response.json()) as SwitchUser;
  return ok(user);
}

const validationIssueSchema = z.object({
  loc: z.array(z.union([z.string(), z.number()])),
  msg: z.string(),
});

/**
 * The gateway's refusal as a sentence: its string `detail` as written, or a
 * FastAPI 422 validation array rendered one issue per field. Null when the
 * body carries neither.
 */
function signupRefusal(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const detail = (parsed as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return detail;
  const issues = z.array(validationIssueSchema).safeParse(detail);
  if (!issues.success || issues.data.length === 0) return null;
  return issues.data
    .map(({ loc, msg }) => {
      const field = String(loc[loc.length - 1] ?? '').replace(/_/g, ' ');
      const stripped = msg.replace(/^Value error, /, '');
      const text = /[.!?]$/.test(stripped) ? stripped : `${stripped}.`;
      return field ? `${field[0].toUpperCase()}${field.slice(1)}: ${text}` : text;
    })
    .join(' ');
}

const SIGNUP_REFUSAL_KIND: Partial<Record<number, SignupError['kind']>> = {
  400: 'invalid',
  403: 'disabled',
  409: 'email_taken',
  422: 'invalid',
  429: 'rate_limited',
};

const signupMachineSchema = z.object({
  status: z.enum(['starting', 'unavailable']),
  reason: z.string().nullable(),
});

/**
 * Self sign-up: create an account and come away signed in, its cookie stored
 * exactly as a password login stores one. The response also says whether the
 * server began warming the new account's cloud machine.
 */
export async function signup(
  server: SwitchServer,
  params: { email: string; password: string; displayName?: string }
): Promise<Result<SignupResult, SignupError>> {
  const posted = await postCredentials(server, '/auth/signup', {
    email: params.email,
    password: params.password,
    ...(params.displayName ? { display_name: params.displayName } : {}),
  });
  if (!posted.success) return posted;
  const response = posted.data;

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const refusal = signupRefusal(body);
    const kind = SIGNUP_REFUSAL_KIND[response.status];
    if (kind && refusal) return err({ kind, message: refusal });
    return err({
      kind: 'failed',
      message: `${server.url} rejected the sign-up with HTTP ${response.status}.${
        body ? ` (${refusal ?? boundedBody(body)})` : ''
      }`,
    });
  }

  const stored = await persistSessionCookie(server, response, 'Sign-up');
  if (!stored.success) return stored;
  const { machine, ...user } = (await response.json()) as SwitchUser & { machine: unknown };
  const parsedMachine = signupMachineSchema.safeParse(machine);
  if (!parsedMachine.success) {
    log.warn('Switch sign-up response carried no readable machine status', {
      server: server.id,
      error: parsedMachine.error.message,
    });
    return ok({
      user,
      machine: {
        status: 'unavailable',
        reason: 'The server did not say whether your cloud machine is starting.',
      },
    });
  }
  return ok({ user, machine: parsedMachine.data });
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
      headers: {
        Accept: 'application/json',
        Cookie: `${SWITCH_AUTH_COOKIE}=${currentJwt}`,
        ...(await consoleIdentityHeaders(server)),
      },
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
 * Silent re-login for a managed server. Switch Console holds that server's
 * admin password, so when its session is missing or expired we can sign in
 * again with no user interaction — a managed server is meant to be always
 * signed in. Persists the fresh cookie (via `passwordLogin`) and returns it for
 * immediate reuse, or `null` when re-login failed (the caller then falls back
 * to the normal sign-in path). No-op for non-managed servers, whose
 * credentials Switch Console does not hold.
 *
 * Reads the stored credentials and never makes them: minted ones would match no
 * running stack, and would then be kept as though they were the stack's.
 */
export async function reauthenticateManagedServer(server: SwitchServer): Promise<string | null> {
  if (!server.managed) return null;
  const secrets = await readSecrets({ secretsKey: managedServerSecretsKey(server) });
  if (secrets === null) {
    log.warn('Managed Switch server has no stored credentials to sign in with', {
      server: server.id,
    });
    return null;
  }
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
export async function oidcLogin(
  server: SwitchServer,
  provider: string | null,
  browserHandoff: boolean
): Promise<Result<true, LoginError>> {
  return browserHandoff ? oidcBrowserLogin(server, provider) : oidcWindowLogin(server, provider);
}

/** Where the system browser comes back to, on this computer's loopback address. */
const HANDOFF_PATH = '/switch-sign-in';

/** The browser sign-in under way for each server, so a new attempt or a cancel ends it. */
const browserLogins = new Map<string, () => void>();

/** Gives up the browser sign-in under way for `server`, if there is one. */
export function cancelOidcLogin(serverId: string): void {
  browserLogins.get(serverId)?.();
}

/**
 * OIDC login in the system browser: the person signs in where their accounts
 * already are, rather than in a window of this app with nothing remembered.
 *
 * A listener on 127.0.0.1 takes the browser back. The gateway sends it there
 * with a one-time code instead of a cookie this app could not read, and the
 * code is traded for the session with the verifier only this attempt holds
 * (its SHA-256 went out as the challenge), so a code seen by anything else on
 * the way is no use to it.
 */
async function oidcBrowserLogin(
  server: SwitchServer,
  provider: string | null
): Promise<Result<true, LoginError>> {
  cancelOidcLogin(server.id);
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const callbackOrigin = await browserCallbackHost(server);
  const startOrigin = callbackOrigin ?? dashboardOrigin(server);

  const result = await new Promise<Result<true, LoginError>>((resolve) => {
    let settled = false;
    let port = 0;
    const page = (status: number, text: string, res: ServerResponse, returnUrl: string | null) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
      // The scheme link is what reliably puts the person back in the app: the
      // OS brings its handler forward, where the app asking for focus may only
      // flash in the taskbar.
      const back = returnUrl
        ? `<meta http-equiv="refresh" content="0;url=${returnUrl}"><p><a href="${returnUrl}" style="display:inline-block;margin-top:1rem;padding:.6rem 1.2rem;border-radius:.5rem;background:#111;color:#fff;text-decoration:none">Open Switch Console</a></p>`
        : '';
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Switch</title><body style="font-family:system-ui;padding:3rem;text-align:center"><p>${text}</p>${back}</body>`
      );
    };
    const listener = createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      } catch {
        page(400, 'Invalid sign-in response.', res, null);
        return;
      }
      const code = url.searchParams.get('code');
      if (
        settled ||
        req.method !== 'GET' ||
        url.pathname !== HANDOFF_PATH ||
        url.searchParams.get('state') !== state ||
        !code ||
        code.length > 4096
      ) {
        page(
          400,
          'This sign-in was not started by this Switch Console. Start it again from the app.',
          res,
          null
        );
        return;
      }
      void exchange(code).then((result) => {
        page(
          result.success ? 200 : 400,
          result.success
            ? 'Signed in. You can close this tab.'
            : 'Sign-in could not be completed. Go back to Switch Console and try again.',
          res,
          appReturnUrl()
        );
        bringToFront();
        finish(result);
      });
    });

    const exchange = async (code: string): Promise<Result<true, LoginError>> => {
      const posted = await postCredentials(server, '/auth/oidc/exchange', { code, verifier });
      if (!posted.success) return posted;
      if (!posted.data.ok)
        return err({
          kind: 'failed',
          message: `${server.url} refused the sign-in with HTTP ${posted.data.status}. Try again.`,
        });
      return persistSessionCookie(server, posted.data, 'Sign-in');
    };

    const finish = (result: Result<true, LoginError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browserLogins.delete(server.id);
      listener.close();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish(err({ kind: 'failed', message: 'Sign-in timed out. Try again.' })),
      OIDC_LOGIN_TIMEOUT_MS
    );
    browserLogins.set(server.id, () =>
      finish(err({ kind: 'cancelled', message: 'Sign-in was cancelled.' }))
    );

    listener.on('error', (cause) =>
      finish(err({ kind: 'failed', message: `Could not wait for the browser: ${cause.message}` }))
    );
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      port = typeof address === 'object' && address ? address.port : 0;
      const query = new URLSearchParams({
        return_to: `http://127.0.0.1:${port}${HANDOFF_PATH}`,
        state,
        challenge,
      });
      if (provider !== null) query.set('provider', provider);
      // Started where the server's web pages are, for the reason
      // `webGatewayUrl` gives; the code is traded on the server's own address.
      shell.openExternal(`${startOrigin}/gateway/auth/oidc/login?${query}`).catch((cause) =>
        finish(
          err({
            kind: 'failed',
            message: `Could not open your browser: ${cause instanceof Error ? cause.message : String(cause)}`,
          })
        )
      );
    });
  });

  if (result.success && callbackOrigin !== null) await keepCallbackHost(server, callbackOrigin);
  return result;
}

/**
 * The host an older server's identity provider returns a browser sign-in to,
 * when Console has no dashboard address for it and that host is another; null
 * otherwise. The system browser cannot be watched the way the sign-in window is
 * (see {@link callbackHostHop}), so the server's first answer to a sign-in is
 * read here instead. A current server makes that hop itself, and its answer
 * names no identity provider.
 */
async function browserCallbackHost(server: SwitchServer): Promise<string | null> {
  if (server.dashboardUrl !== null) return null;
  const startUrl = gatewayUrl(server, '/auth/oidc/login');
  let location: string | null;
  try {
    const response = await fetch(startUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    location = response.headers.get('location');
  } catch (cause) {
    log.warn('switch-servers: could not ask where the server’s sign-in returns to', {
      server: server.id,
      error: String(cause),
    });
    return null;
  }
  return location === null ? null : callbackHostHop(startUrl, new URL(location, startUrl).href);
}

/** Keep the host a sign-in was followed to as the server's dashboard address.
 * Signed in either way, so a failure to record it is only noted. */
async function keepCallbackHost(server: SwitchServer, callbackOrigin: string): Promise<void> {
  await keepSeparateDashboard(server, callbackOrigin).catch((error: unknown) => {
    log.warn('switch-servers: could not keep the host the sign-in returned to', {
      server: server.id,
      callbackOrigin,
      error: String(error),
    });
  });
}

async function oidcWindowLogin(
  server: SwitchServer,
  provider: string | null
): Promise<Result<true, LoginError>> {
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

  const login =
    provider === null
      ? '/auth/oidc/login'
      : `/auth/oidc/login?${new URLSearchParams({ provider })}`;
  const startUrl = webGatewayUrl(server, login);
  // Set when the window follows the server to the host its identity provider
  // returns to; see `callbackHostHop`.
  let callbackOrigin: string | null = null;

  const result = await new Promise<Result<true, LoginError>>((resolve) => {
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

    let leftStartHost = false;
    win.webContents.on('will-redirect', (details) => {
      if (leftStartHost || !details.isMainFrame) return;
      if (new URL(details.url).hostname === new URL(startUrl).hostname) return;
      leftStartHost = true;
      const hop = callbackHostHop(startUrl, details.url);
      if (hop === null) return;
      details.preventDefault();
      callbackOrigin = hop;
      void win.loadURL(`${hop}/gateway${login}`).catch((cause) => {
        finish(err({ kind: 'failed', message: `Could not open sign-in page: ${cause.message}` }));
      });
    });

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(err({ kind: 'cancelled', message: 'Sign-in window was closed.' }));
      }
    });

    void win.loadURL(startUrl).catch((cause) => {
      // Cancelled by the hop above, which has loaded the sign-in elsewhere.
      if (callbackOrigin !== null) return;
      finish(err({ kind: 'failed', message: `Could not open sign-in page: ${cause.message}` }));
    });
  });

  // Where the server's sign-in returns is where an older server keeps its dashboard.
  if (result.success && callbackOrigin !== null) await keepCallbackHost(server, callbackOrigin);
  return result;
}
