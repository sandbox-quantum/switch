import type { AdvancedConfigValue } from '@switch-console/plugins/agents';
import { z } from 'zod';
import type { KnownAgentType } from '@main/core/agents/known-agent-type';
import {
  managedServerHostBlocked,
  managedServerStoppedPhase,
  noteManagedServerUnanswered,
} from '@main/core/managed-switch-server/managed-server-status';
import { assertedTenant } from '@main/core/workspaces/asserted-tenant';
import { cloudLaunchSchema, cloudMachineSchema } from '@shared/core/cloud-agents/cloud-agents';
import type { AdvancedConfigField } from '@shared/core/managed-agents/managed-agents';
import { ManagedServerStoppedError } from '@shared/core/managed-switch-server/managed-switch-server';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { HostUnreachableError } from '@shared/core/remote-hosts/reachability';
import type {
  ClaudeCredentialKind,
  ClaudeConnection,
} from '@shared/core/switch-servers/claude-credential';
import type {
  CloudLaunchConfiguration,
  CloudLaunchInput,
} from '@shared/core/switch-servers/cloud-launch';
import {
  type ConnectionCatalogEntry,
  connectionCatalogSchema,
  serviceConnectionsSchema,
} from '@shared/core/switch-servers/connection-catalog';
import {
  gitHubConnectionSchema,
  gitHubFlowSchema,
} from '@shared/core/switch-servers/github-connection';
import { policyNamesOwner } from '@shared/core/switch-servers/owner-policy';
import { cloudProviderConnectionSchema } from '@shared/core/switch-servers/provider-credential';
import {
  SERVICE_CALLBACK_PATH,
  type ServiceFlowStart,
  serviceFlowSchema,
  serviceFlowStartSchema,
} from '@shared/core/switch-servers/service-connection';
import {
  type ServiceGrants,
  serviceGrantWarningSchema,
  serviceGrantsSchema,
} from '@shared/core/switch-servers/service-grants';
import type {
  AddressingPolicy,
  BridgeConfigField,
  BridgeDirectoryUser,
  DeleteBridgeResult,
  LinkedIdentity,
  RemoteAgentRoom,
  RemoteAgentSummary,
  RemoteBridge,
  RemoteBridgeType,
  RemoteExternalUser,
  RemoteRoomDetail,
  RemoteRoomGroup,
  RemoteRoomRole,
  RemoteRoomSummary,
  SwitchAuthConfig,
  SwitchServer,
  SwitchServerDeclaration,
  SwitchUser,
} from '@shared/core/switch-servers/switch-servers';
import type {
  Invitation,
  InvitationEmailDelivery,
  JoinableWorkspaces,
  PendingInvitations,
  WorkspaceJoinDomains,
} from '@shared/core/workspaces/invitations';
import type { WorkspaceRole } from '@shared/core/workspaces/workspaces';
import { extractAuthCookie, reauthenticateManagedServer, refreshSession } from './auth';
import { consoleIdentityHeaders } from './console-identity';
import { getSessionCookie, setSessionCookie } from './servers-store';

/** The gateway management API is mounted under `/gateway` on the server. */
function gatewayUrl(server: SwitchServer, path: string): string {
  return `${server.gatewayUrl}/gateway${path}`;
}

/** Renew the session once the stored JWT is within this window of its `exp`, so
 * an active client refreshes before the token dies rather than after a 401. */
const SESSION_REFRESH_LEEWAY_MS = 60 * 60 * 1000;

/**
 * Read the `exp` (as ms since epoch) out of a JWT without verifying it — we only
 * need the expiry to decide when to renew; the gateway still verifies the
 * signature on every call. Returns null if the token is malformed or carries no
 * numeric `exp`, in which case we skip proactive renewal and let the call fall
 * through to the normal 401 path.
 */
function decodeJwtExpMs(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Read the `tenant_id` claim out of a JWT without verifying it. Returns null
 * for a malformed token, and for a session that has selected no tenant — the
 * gateway mints the claim as null until `/tenants/{id}/switch` is called.
 *
 * Unverified is the right level here: the claim only ever *selects* which
 * workspace a call is scoped to, and the gateway re-checks membership against
 * a live row on every request, so nothing this reads can grant access. It is
 * read to know whether the selection already matches the workspace being
 * addressed, or whether a switch has to happen first.
 */
export function decodeJwtTenantId(jwt: string): string | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      tenant_id?: unknown;
    };
    return typeof payload.tenant_id === 'string' ? payload.tenant_id : null;
  } catch {
    return null;
  }
}

/** Dedupe concurrent renewals per server so a burst of authenticated calls
 * triggers at most one refresh round-trip (and one cookie write). */
const inflightRefresh = new Map<string, Promise<string | null>>();

/**
 * Given the stored JWT, return the token to attach: the same JWT if it is not
 * near expiry, otherwise a freshly renewed one (falling back to the current
 * token if renewal did not succeed — the call then 401s and the caller prompts
 * a sign-in).
 */
async function renewIfExpiring(server: SwitchServer, jwt: string): Promise<string> {
  const expMs = decodeJwtExpMs(jwt);
  if (expMs === null || expMs - Date.now() > SESSION_REFRESH_LEEWAY_MS) {
    return jwt;
  }
  let pending = inflightRefresh.get(server.id);
  if (!pending) {
    pending = refreshSession(server, jwt).finally(() => inflightRefresh.delete(server.id));
    inflightRefresh.set(server.id, pending);
  }
  const renewed = await pending;
  return renewed ?? jwt;
}

export type GatewayErrorKind = 'unauthorized' | 'http' | 'network';

/** Raised for any failed gateway call. `kind === 'unauthorized'` means the
 * stored session is missing or rejected (401) — the caller should prompt a
 * re-login rather than retrying. */
export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    message: string,
    readonly status?: number,
    /** The gateway's own explanation, unwrapped from the FastAPI `{"detail":…}`
     * envelope. Present only when the body carried one. Prefer this over
     * `message` when showing a failure to the user: `message` is prefixed with
     * the raw status line, which reads as noise in a form. */
    readonly detail?: string,
    /** The refusal's machine-readable name, from a body such as
     * `{"detail": …, "code": "worker_waking"}`. Present only when the body
     * carried one. */
    readonly code?: string,
    /** The response body as it came, for a caller that reads an envelope other
     * than FastAPI's (agent management answers `{"error": {...}}`). */
    readonly body?: string,
    /** Whether the refusal says a retry can succeed, from a body such as
     * `{"detail": …, "code": …, "retryable": true}`. Absent when it does not say. */
    readonly retryable?: boolean
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * Unwrap FastAPI's `{"detail": "…"}` error envelope. Returns undefined for any
 * other body shape (an HTML error page, a 422 validation array, empty), leaving
 * the caller with the full status-prefixed message rather than a misleading
 * fragment.
 */
function parseErrorDetail(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    return typeof parsed.detail === 'string' ? parsed.detail : undefined;
  } catch {
    return undefined;
  }
}

/** The `code` beside `detail` in a coded refusal, or undefined without one. */
function parseErrorCode(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

type FetchOptions = {
  /** Attach the stored `switch_auth` cookie. Off for unauthenticated calls
   * such as `/auth/config`. */
  authenticated: boolean;
  method?: string;
  body?: unknown;
};

/**
 * Resolve the `switch_auth` cookie to attach to an authenticated call, renewing
 * proactively when near expiry. When no session is stored, the managed local
 * server mints one silently (Switch Console holds its admin creds); any other server
 * has no way to authenticate silently, so this raises `unauthorized`.
 */
async function resolveAuthCookie(server: SwitchServer): Promise<string> {
  const stored = await getSessionCookie(server.id);
  if (stored) {
    return renewIfExpiring(server, stored);
  }
  if (server.managed) {
    const minted = await silentLogin(server);
    if (minted) return minted;
  }
  throw new GatewayError('unauthorized', 'Not signed in to this Switch server.');
}

/**
 * Servers whose silent re-login is putting a tenant back, so the switch it makes
 * does not try to re-login its way out of its own 401.
 */
const restoringTenant = new Set<string>();

/**
 * Log a managed server back in silently, and re-select the workspace the calls
 * in flight on it were addressing.
 *
 * A login cookie names no tenant. Handed back on its own it would answer the
 * rest of a workspace-scoped call with the account's default workspace —
 * succeeding, and looking exactly like the answer that was asked for.
 */
async function silentLogin(server: SwitchServer): Promise<string | null> {
  const minted = await reauthenticateManagedServer(server);
  if (!minted) return null;
  const tenantId = assertedTenant(server.id);
  if (tenantId === null || restoringTenant.has(server.id)) return minted;
  restoringTenant.add(server.id);
  try {
    await switchTenant(server, tenantId);
  } finally {
    restoringTenant.delete(server.id);
  }
  // `switchTenant` stores the scoped cookie; the minted one it replaced would
  // send this very call to the wrong workspace.
  return (await getSessionCookie(server.id)) ?? minted;
}

/**
 * One authenticated call to the gateway, answered with whatever it returned:
 * a refusal is the caller's to read, and a streaming body is left open. Only
 * a rejected session is raised, as for every gateway call.
 */
export async function gatewayRequest(
  server: SwitchServer,
  path: string,
  options: FetchOptions & { signal: AbortSignal }
): Promise<Response> {
  // A remote-managed server's gateway is only reachable through the SSH forward.
  // Once the host is known unreachable the forward is dead, so a fetch can only
  // hang for its timeout and then report `Could not reach http://localhost:<port>`
  // — a local address that was never the problem. Fail with the modeled host
  // state instead, at the one point every gateway call passes through.
  const blocked = managedServerHostBlocked(server);
  if (blocked) throw new HostUnreachableError(blocked);

  // Same argument one level down: a managed stack that is stopped has no
  // gateway listening, so every call to it can only time out and report a port
  // that was never the problem — and the session renewal on the way there
  // warns about the same absence a second time. Report the lifecycle state the
  // user is already looking at instead.
  const stopped = managedServerStoppedPhase(server);
  if (stopped) throw new ManagedServerStoppedError(server, stopped);

  const identity = await consoleIdentityHeaders(server);
  const sendOnce = async (cookie: string | null): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json', ...identity };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (cookie) {
      headers.Cookie = `switch_auth=${cookie}`;
    }
    try {
      return await fetch(gatewayUrl(server, path), {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        // We attach the cookie explicitly; don't let the runtime manage a jar.
        redirect: 'manual',
        signal: options.signal,
      });
    } catch (cause) {
      noteManagedServerUnanswered(server);
      throw new GatewayError(
        'network',
        `Could not reach ${server.gatewayUrl}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  };

  const cookie = options.authenticated ? await resolveAuthCookie(server) : null;
  let response = await sendOnce(cookie);

  // Reactive silent re-auth for the managed local server: a 401 means the token
  // is dead (e.g. the app reopened after the stack outlived it past the TTL).
  // We hold its admin creds, so re-login and retry the call once rather than
  // bouncing the user to a sign-in screen for a password they never saw.
  if (response.status === 401 && options.authenticated && server.managed) {
    const renewed = await silentLogin(server);
    if (renewed) {
      response = await sendOnce(renewed);
    }
  }

  if (response.status === 401) {
    throw new GatewayError('unauthorized', 'Switch session expired — please sign in again.', 401);
  }
  return response;
}

/** The `retryable` beside `detail` in a coded refusal, or undefined without one. */
function parseErrorRetryable(body: string): boolean | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { retryable?: unknown };
    return typeof parsed.retryable === 'boolean' ? parsed.retryable : undefined;
  } catch {
    return undefined;
  }
}

export async function gatewayFetch(
  server: SwitchServer,
  path: string,
  options: FetchOptions
): Promise<Response> {
  const response = await gatewayRequest(server, path, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new GatewayError(
      'http',
      `Switch gateway returned ${response.status}${body ? `: ${body}` : ''}`,
      response.status,
      parseErrorDetail(body),
      parseErrorCode(body),
      body,
      parseErrorRetryable(body)
    );
  }
  return response;
}

export async function fetchAuthConfig(server: SwitchServer): Promise<SwitchAuthConfig> {
  const res = await gatewayFetch(server, '/auth/config', { authenticated: false });
  const json = (await res.json()) as {
    password_login_enabled: boolean;
    oidc_enabled: boolean;
    oidc_provider_label: string | null;
    signup_enabled?: boolean;
  };
  return {
    passwordLoginEnabled: json.password_login_enabled,
    oidcEnabled: json.oidc_enabled,
    oidcProviderLabel: json.oidc_provider_label,
    signupEnabled: json.signup_enabled === true,
  };
}

type ServerDeclarationJson = {
  version: string | null;
  contracts: Record<string, { speaks: number; accepts: number }>;
};

type UserResponseJson = {
  id: string;
  name: string;
  email: string;
  role: string;
  server?: ServerDeclarationJson | null;
};

/**
 * A server declaration, or null when this server did not make one.
 *
 * Validated rather than trusted: a malformed block reads as *unknown* instead
 * of a half-populated declaration, because a version we invented is worse than
 * one we admit we do not have (CHOO-1865).
 */
function mapServerDeclaration(raw: unknown): SwitchServerDeclaration | null {
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = raw as Partial<ServerDeclarationJson>;
  if (typeof candidate.contracts !== 'object' || candidate.contracts === null) return null;
  const version = typeof candidate.version === 'string' ? candidate.version : null;
  return { version, contracts: candidate.contracts };
}

function mapUser(json: UserResponseJson): SwitchUser {
  return {
    id: json.id,
    name: json.name,
    email: json.email,
    role: json.role,
    server: mapServerDeclaration(json.server ?? null),
  };
}

export async function fetchMe(server: SwitchServer): Promise<SwitchUser> {
  const res = await gatewayFetch(server, '/auth/me', { authenticated: true });
  return mapUser((await res.json()) as UserResponseJson);
}

/** A tenant the signed-in user belongs to, as `GET /tenants` reports it. */
export type RemoteTenant = {
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
};

function mapRole(raw: unknown): WorkspaceRole {
  if (raw === 'owner' || raw === 'admin' || raw === 'member') return raw;
  throw new GatewayError('http', `Switch server reported an unknown workspace role: ${raw}`);
}

/**
 * The tenants the signed-in user belongs to. Answered without a tenant being
 * selected on the session, which is what makes it the entry point: a user with
 * several memberships has none selected until they pick one.
 */
export async function fetchTenants(server: SwitchServer): Promise<RemoteTenant[]> {
  const res = await gatewayFetch(server, '/tenants', { authenticated: true });
  const json = (await res.json()) as Array<{
    id: string;
    slug: string;
    name: string;
    role: string;
  }>;
  return json.map((t) => ({ id: t.id, slug: t.slug, name: t.name, role: mapRole(t.role) }));
}

/**
 * Create a workspace on this server, owned by the signed-in user.
 *
 * The gateway derives the slug from the name and refuses a name whose slug is
 * already taken, so the caller shows that refusal rather than retrying under a
 * name the user did not choose.
 */
export async function createTenant(server: SwitchServer, name: string): Promise<RemoteTenant> {
  const res = await gatewayFetch(server, '/tenants', {
    authenticated: true,
    method: 'POST',
    body: { name },
  });
  const json = (await res.json()) as { id: string; slug: string; name: string; role: string };
  return { id: json.id, slug: json.slug, name: json.name, role: mapRole(json.role) };
}

/**
 * Select a tenant for this server's session, persisting the re-minted cookie.
 *
 * One session holds one selected tenant, so this is what makes a call scoped to
 * a particular workspace rather than to whichever one was picked last. The
 * gateway verifies membership before it mints, so a refusal here is a real
 * answer — it is raised rather than swallowed, because the alternative is
 * issuing the caller's next request against somebody else's workspace.
 */
export async function switchTenant(server: SwitchServer, tenantId: string): Promise<void> {
  const res = await gatewayFetch(server, `/tenants/${encodeURIComponent(tenantId)}/switch`, {
    authenticated: true,
    method: 'POST',
  });
  const cookie = extractAuthCookie(res.headers.getSetCookie());
  if (!cookie) {
    throw new GatewayError(
      'http',
      `${server.name} accepted the workspace selection but returned no session cookie.`
    );
  }
  await setSessionCookie(server.id, cookie);
}

/**
 * Accept an invitation to a workspace, joining it.
 *
 * The token goes in the body, never the path: it is a bearer credential. The
 * gateway answers with a session cookie scoped to the workspace joined, which
 * is kept for the same reason `switchTenant` keeps its own — the next call made
 * for that workspace has to reach it, not whichever one was selected before.
 *
 * Accepting an invitation to a workspace the account is already in is not an
 * error: the gateway returns the existing membership and spends nothing.
 */
export async function acceptInvitation(server: SwitchServer, token: string): Promise<RemoteTenant> {
  const res = await gatewayFetch(server, '/invitations/accept', {
    authenticated: true,
    method: 'POST',
    body: { token },
  });
  return joinedTenant(server, res);
}

/**
 * Accept an invitation addressed to the signed-in account, by id.
 *
 * Answers exactly as {@link acceptInvitation} does, session cookie included:
 * the server switches the session into the workspace it joined.
 */
export async function acceptPendingInvitation(
  server: SwitchServer,
  tenantId: string,
  invitationId: string
): Promise<RemoteTenant> {
  const res = await gatewayFetch(server, '/invitations/mine/accept', {
    authenticated: true,
    method: 'POST',
    body: { tenant_id: tenantId, invitation_id: invitationId },
  });
  return joinedTenant(server, res);
}

type PendingInvitationJson = {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  role: string;
  expires_at: string;
  invited_by: string;
  created_at: string;
};

/**
 * The invitations addressed to the signed-in account, in workspaces it is not in.
 *
 * A 404 is a server from before the route existed, and is answered as
 * `unsupported` rather than raised: the account is signed in and the rest of
 * the server works, so it is a feature the server lacks, not a failure. Every
 * other refusal is raised.
 */
export async function fetchPendingInvitations(server: SwitchServer): Promise<PendingInvitations> {
  let res: Response;
  try {
    res = await gatewayFetch(server, '/invitations/mine', { authenticated: true });
  } catch (cause) {
    if (cause instanceof GatewayError && cause.status === 404) return { kind: 'unsupported' };
    throw cause;
  }
  const json = (await res.json()) as PendingInvitationJson[];
  return {
    kind: 'listed',
    invitations: json.map((i) => ({
      id: i.id,
      tenantId: i.tenant_id,
      workspaceName: i.tenant_name,
      role: mapRole(i.role),
      expiresAt: isoTimestamp(i.expires_at),
      invitedBy: i.invited_by,
    })),
  };
}

async function joinedTenant(server: SwitchServer, res: Response): Promise<RemoteTenant> {
  const json = (await res.json()) as { id: string; slug: string; name: string; role: string };
  const cookie = extractAuthCookie(res.headers.getSetCookie());
  if (!cookie) {
    throw new GatewayError(
      'http',
      `${server.name} accepted the invitation but returned no session cookie.`
    );
  }
  await setSessionCookie(server.id, cookie);
  return { id: json.id, slug: json.slug, name: json.name, role: mapRole(json.role) };
}

type InvitationJson = {
  id: string;
  role: string;
  email: string | null;
  expires_at: string;
  uses_remaining: number;
  revoked_at: string | null;
  created_at: string;
};

/**
 * A gateway timestamp as ISO 8601.
 *
 * The invitation routes write Python's `str(datetime)`, with a space where ISO
 * has a `T`. Normalised here so every reader downstream can hand it to `Date`;
 * one that still does not parse is raised, since showing an expiry of "Invalid
 * Date" would leave an admin unable to tell a live invitation from a dead one.
 */
function isoTimestamp(raw: string): string {
  const parsed = new Date(raw.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) {
    throw new GatewayError('http', `Switch server reported an unreadable timestamp: ${raw}`);
  }
  return parsed.toISOString();
}

function mapInvitation(json: InvitationJson): Invitation {
  return {
    id: json.id,
    role: mapRole(json.role),
    email: json.email,
    expiresAt: isoTimestamp(json.expires_at),
    usesRemaining: json.uses_remaining,
    revokedAt: json.revoked_at === null ? null : isoTimestamp(json.revoked_at),
    createdAt: isoTimestamp(json.created_at),
  };
}

function mapDelivery(raw: unknown): InvitationEmailDelivery {
  // A server older than e-mailed invitations leaves the field out. Refusing it
  // would lose the link of an invitation the server has already made.
  if (raw === undefined) return 'unsupported';
  if (raw === 'sent' || raw === 'not_configured' || raw === 'failed' || raw === 'not_requested') {
    return raw;
  }
  throw new GatewayError('http', `Switch server reported an unknown e-mail delivery: ${raw}`);
}

/**
 * The workspaces open to the domain of the signed-in account's address.
 *
 * A server without the route answers 404, which is read as unable to say
 * rather than as none.
 */
export async function fetchJoinableWorkspaces(server: SwitchServer): Promise<JoinableWorkspaces> {
  let res: Response;
  try {
    res = await gatewayFetch(server, '/joinable-tenants', { authenticated: true });
  } catch (cause) {
    if (cause instanceof GatewayError && cause.status === 404) return { kind: 'unsupported' };
    throw cause;
  }
  const json = (await res.json()) as { tenant_id: string; tenant_name: string; domain: string }[];
  return {
    kind: 'listed',
    workspaces: json.map((w) => ({
      tenantId: w.tenant_id,
      workspaceName: w.tenant_name,
      domain: w.domain,
    })),
  };
}

/**
 * Join a workspace open to the account's domain, and switch the session into
 * it — the same scoped cookie accepting an invitation stores.
 */
export async function joinWorkspaceByDomain(
  server: SwitchServer,
  tenantId: string
): Promise<RemoteTenant> {
  const res = await gatewayFetch(server, `/joinable-tenants/${encodeURIComponent(tenantId)}/join`, {
    authenticated: true,
    method: 'POST',
  });
  return joinedTenant(server, res);
}

function joinDomainsPath(tenantId: string): string {
  return `/tenants/${encodeURIComponent(tenantId)}/join-domains`;
}

/** The domains a workspace is open to. Admins and owners only. */
export async function fetchJoinDomains(
  server: SwitchServer,
  tenantId: string
): Promise<WorkspaceJoinDomains> {
  let res: Response;
  try {
    res = await gatewayFetch(server, joinDomainsPath(tenantId), { authenticated: true });
  } catch (cause) {
    if (cause instanceof GatewayError && cause.status === 404) return { kind: 'unsupported' };
    throw cause;
  }
  const json = (await res.json()) as {
    domains: { domain: string }[];
    own_domain: string;
    own_domain_refusal: string | null;
  };
  return {
    kind: 'listed',
    domains: json.domains.map((d) => d.domain),
    ownDomain: json.own_domain,
    ownDomainRefusal: json.own_domain_refusal,
  };
}

export async function addJoinDomain(
  server: SwitchServer,
  tenantId: string,
  domain: string
): Promise<void> {
  await gatewayFetch(server, joinDomainsPath(tenantId), {
    authenticated: true,
    method: 'POST',
    body: { domain },
  });
}

export async function removeJoinDomain(
  server: SwitchServer,
  tenantId: string,
  domain: string
): Promise<void> {
  await gatewayFetch(server, `${joinDomainsPath(tenantId)}/${encodeURIComponent(domain)}`, {
    authenticated: true,
    method: 'DELETE',
  });
}

function invitationsPath(tenantId: string): string {
  return `/tenants/${encodeURIComponent(tenantId)}/invitations`;
}

/** Every invitation to a workspace, revoked and spent ones included. Admins and owners only. */
export async function fetchInvitations(
  server: SwitchServer,
  tenantId: string
): Promise<Invitation[]> {
  const res = await gatewayFetch(server, invitationsPath(tenantId), { authenticated: true });
  return ((await res.json()) as InvitationJson[]).map(mapInvitation);
}

/**
 * Mint an invitation to a workspace, and e-mail it when it names an address
 * and the server has mail set up.
 *
 * The token comes back once, here, and never again: the server stores a hash.
 */
export async function createInvitation(
  server: SwitchServer,
  tenantId: string,
  params: {
    role: WorkspaceRole;
    email: string | null;
    expiresInHours: number;
    usesRemaining: number;
  }
): Promise<{ invitation: Invitation; token: string; emailDelivery: InvitationEmailDelivery }> {
  const res = await gatewayFetch(server, invitationsPath(tenantId), {
    authenticated: true,
    method: 'POST',
    body: {
      role: params.role,
      email: params.email,
      expires_in_hours: params.expiresInHours,
      uses_remaining: params.usesRemaining,
    },
  });
  const json = (await res.json()) as InvitationJson & { token: string; email_delivery?: string };
  return {
    invitation: mapInvitation(json),
    token: json.token,
    emailDelivery: mapDelivery(json.email_delivery),
  };
}

export async function revokeInvitation(
  server: SwitchServer,
  tenantId: string,
  invitationId: string
): Promise<Invitation> {
  const res = await gatewayFetch(
    server,
    `${invitationsPath(tenantId)}/${encodeURIComponent(invitationId)}`,
    { authenticated: true, method: 'DELETE' }
  );
  return mapInvitation((await res.json()) as InvitationJson);
}

/**
 * Whether this server e-mails an invitation that names an address, or only
 * mints the link for the admin to send.
 *
 * Null on a server older than e-mailed invitations: one without the session
 * route answers 404, and one with it but without the field predates the
 * feature. Neither sends an e-mail.
 */
export async function fetchInviteEmailEnabled(server: SwitchServer): Promise<boolean | null> {
  let res: Response;
  try {
    res = await gatewayFetch(server, '/auth/session', { authenticated: true });
  } catch (cause) {
    if (cause instanceof GatewayError && cause.status === 404) return null;
    throw cause;
  }
  const json = (await res.json()) as { invite_email_enabled?: unknown };
  if (json.invite_email_enabled === undefined) return null;
  if (typeof json.invite_email_enabled !== 'boolean') {
    throw new GatewayError(
      'http',
      `${server.name} reported an unreadable invite_email_enabled: ${String(json.invite_email_enabled)}`
    );
  }
  return json.invite_email_enabled;
}

/** Options for `registerKnownAgent`, matching the gateway's
 * `RegisterKnownAgentRequest.options`. The gateway validates these against the
 * options schema of the `agent_type` being registered and ignores keys that type
 * does not declare (Codex has no channel, so it drops `channels_enabled`). */
export type RegisterKnownAgentOptions = {
  channels_enabled: boolean;
  repo_dir?: string;
  /** When true, the agent registers with the `auto_session` connection model:
   * Switch Console watches its rooms and auto-spawns a session on notification. */
  auto_session?: boolean;
};

/** The new agent's id and freshly-minted API key (the `agent` token the
 * connector authenticates with). The key is a secret — keep it in the main
 * process; never pass it to the renderer. */
export type RegisteredAgent = {
  id: string;
  apiKey: string;
};

/**
 * Register a new known agent of `agentType` on `server`, owned by the signed-in
 * user (session-authed `POST /gateway/agents/register`). Returns the new agent id
 * and its API key. A 409 (name already taken) and 400 (invalid name) surface
 * as `GatewayError` with the matching `status` so the caller can react.
 */
export async function registerKnownAgent(
  server: SwitchServer,
  params: {
    name: string;
    description: string;
    options: RegisterKnownAgentOptions;
    /** Gateway known-agent type. Required — derive it from the provider via
     * `knownAgentTypeForProvider` rather than letting a call site fall back to
     * Claude Code's shape by omission (CHOO-1436). */
    agentType: KnownAgentType;
    /** The agent's icon, or null to leave it unset and let the fallback draw
     * one. Required rather than optional so a create flow states which it
     * means instead of dropping the user's choice by forgetting the field. */
    iconUrl: string | null;
    /** The label chat platforms render the agent under, or null to leave it
     * unset and be shown under `name`. Required rather than optional for the
     * same reason as `iconUrl`: the create form holds a label the user typed,
     * and an omitted field would drop it without saying so. */
    displayName: string | null;
  }
): Promise<RegisteredAgent> {
  const res = await gatewayFetch(server, '/agents/register', {
    authenticated: true,
    method: 'POST',
    body: {
      agent_type: params.agentType,
      name: params.name,
      description: params.description,
      options: params.options,
      icon_url: params.iconUrl,
      display_name: params.displayName,
      overwrite: false,
    },
  });
  const json = (await res.json()) as { id: string; api_key: string };
  return { id: json.id, apiKey: json.api_key };
}

/** The gateway's wire shape for an agent, as `AgentSummary` and the `AgentDetail`
 * superset both send it. Fields the gateway added later are optional here so an
 * older server still parses. */
type AgentSummaryJson = {
  id: string;
  name: string;
  display_name?: string | null;
  description: string;
  connector_type: string;
  owner_id?: string | null;
  owner_name: string | null;
  known_agent_type: string | null;
  known_agent_options?: Record<string, unknown> | null;
  addressing_policy?: AddressingPolicy | null;
  icon_url?: string | null;
  created_at: string;
};

/** Single place the agent wire shape becomes a `RemoteAgentSummary`. Every
 * endpoint returning an agent goes through here, so a new field cannot reach
 * one caller and silently miss another. */
function toRemoteAgentSummary(json: AgentSummaryJson): RemoteAgentSummary {
  return {
    id: json.id,
    name: json.name,
    displayName: json.display_name ?? null,
    description: json.description,
    connectorType: json.connector_type,
    ownerId: json.owner_id ?? null,
    ownerName: json.owner_name,
    knownAgentType: json.known_agent_type,
    knownAgentOptions: json.known_agent_options ?? null,
    addressingPolicy: json.addressing_policy ?? null,
    iconUrl: json.icon_url ?? null,
    createdAt: json.created_at,
  };
}

export async function fetchAgents(server: SwitchServer): Promise<RemoteAgentSummary[]> {
  const res = await gatewayFetch(server, '/agents', { authenticated: true });
  const json = (await res.json()) as AgentSummaryJson[];
  return json.map(toRemoteAgentSummary);
}

/**
 * Fetch one agent's registered detail by id (`GET /agents/{id}`, which returns
 * the gateway `AgentDetail` — a superset of `AgentSummary`). Used to resolve an
 * agent's registered Switch name for display. A 404 surfaces as a `GatewayError`
 * so callers can distinguish "not on this server" from other failures.
 */
export async function fetchAgentDetail(
  server: SwitchServer,
  agentId: string
): Promise<RemoteAgentSummary> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
  });
  return toRemoteAgentSummary((await res.json()) as AgentSummaryJson);
}

/**
 * Whether `agentId` is a registered agent on `server`. Used to verify the user's
 * chosen server actually owns the agent before linking it. A 404 from the
 * gateway means "not this server" (returned as false); an unauthorized error
 * propagates so the caller can prompt a sign-in.
 */
export async function agentExistsOnServer(server: SwitchServer, agentId: string): Promise<boolean> {
  try {
    await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, { authenticated: true });
    return true;
  } catch (cause) {
    if (cause instanceof GatewayError && cause.kind === 'http' && cause.status === 404) {
      return false;
    }
    throw cause;
  }
}

export async function fetchAgentRooms(
  server: SwitchServer,
  agentId: string
): Promise<RemoteAgentRoom[]> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
  });
  const json = (await res.json()) as {
    rooms?: Array<{
      room_id: string;
      room_name: string;
      archived: boolean;
      status: string;
      room_role: string | null;
    }>;
  };
  return (json.rooms ?? []).map((r) => ({
    roomId: r.room_id,
    roomName: r.room_name,
    archived: r.archived,
    status: r.status,
    roomRole: r.room_role,
  }));
}

/**
 * Fetch an agent's scoped addressing policy (CHOO-1585) from `GET /agents/{id}`.
 * Returns null when the agent is open (no policy set).
 */
export async function fetchAddressingPolicy(
  server: SwitchServer,
  agentId: string
): Promise<AddressingPolicy | null> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
  });
  const json = (await res.json()) as {
    addressing_policy?: AddressingPolicy | null;
  };
  return json.addressing_policy ?? null;
}

/**
 * Whether the signed-in user owns an agent here whose addressing policy admits
 * its owner — the only case in which having claimed no messaging account costs
 * them anything (CHOO-2137).
 *
 * Both halves of the answer are on the agent list — `GET /agents` carries each
 * agent's `owner_id` and its policy — so this costs that list and `/auth/me`,
 * however many agents the user owns.
 *
 * A server too old to report the policy on the list leaves every agent reading
 * as open, so the warning stays quiet. That is the same answer as owning no
 * restricted agent, and the safe direction for a warning to be wrong in.
 */
export async function ownsOwnerAddressedAgent(server: SwitchServer): Promise<boolean> {
  const [me, agents] = await Promise.all([fetchMe(server), fetchAgents(server)]);
  return agents.some(
    (agent) => agent.ownerId === me.id && policyNamesOwner(agent.addressingPolicy)
  );
}

/**
 * Set (or clear, with `policy = null`) an agent's addressing policy
 * (`PUT /agents/{id}/addressing-policy`). Only the agent's owner (or an admin)
 * may change it; a non-owner request surfaces as a `GatewayError`.
 */
export async function updateAddressingPolicy(
  server: SwitchServer,
  agentId: string,
  policy: AddressingPolicy | null
): Promise<void> {
  await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}/addressing-policy`, {
    authenticated: true,
    method: 'PUT',
    body: { policy },
  });
}

/**
 * An agent's "can manage agents" capability, and whether the server runs agent
 * management at all (with it off the capability does nothing, and is not worth
 * showing). The capability lets the agent list its owner's machines and managed
 * agents and create managed agents on them.
 */
export async function fetchAgentManagementAccess(
  server: SwitchServer,
  agentId: string
): Promise<{ available: boolean; canManageAgents: boolean }> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
  });
  const json = (await res.json()) as { can_manage_agents?: boolean };
  let available = true;
  try {
    await managementFetch(server, '/controllers', { authenticated: true });
  } catch (error) {
    if (!(error instanceof AgentManagementUnavailableError)) throw error;
    available = false;
  }
  return { available, canManageAgents: json.can_manage_agents === true };
}

/**
 * Turn an agent's "can manage agents" capability on or off
 * (`PUT /agents/{id}/can-manage-agents`). Only the agent's owner may; anyone
 * else's request surfaces as a `GatewayError`.
 */
export async function updateCanManageAgents(
  server: SwitchServer,
  agentId: string,
  enabled: boolean
): Promise<void> {
  await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}/can-manage-agents`, {
    authenticated: true,
    method: 'PUT',
    body: { enabled },
  });
}

/**
 * One page of the icons the server generates for an agent called `name`
 * (`GET /agents/icon-choices`): page 0 leads with the one an agent of that
 * name gets when nobody picks an icon.
 */
export async function fetchAgentIconChoices(
  server: SwitchServer,
  name: string,
  page: number
): Promise<string[]> {
  const query = new URLSearchParams({ name, page: String(page) });
  const res = await gatewayFetch(server, `/agents/icon-choices?${query.toString()}`, {
    authenticated: true,
  });
  return ((await res.json()) as { choices: string[] }).choices;
}

/**
 * Set (or clear, with `iconUrl = null`) an agent's icon (`PUT /agents/{id}/icon`).
 * Only the agent's owner (or an admin) may change it; a non-owner request
 * surfaces as a `GatewayError`, as does a URL the gateway rejects — it accepts
 * public `https` only, so a link to a private address comes back as a 400.
 *
 * Returns the agent as the gateway now holds it, so a caller can refresh from
 * the server's answer rather than assuming the value it sent was stored.
 */
export async function updateAgentIcon(
  server: SwitchServer,
  agentId: string,
  iconUrl: string | null
): Promise<RemoteAgentSummary> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}/icon`, {
    authenticated: true,
    method: 'PUT',
    body: { icon_url: iconUrl },
  });
  return toRemoteAgentSummary((await res.json()) as AgentSummaryJson);
}

/** Change an agent's description (`PUT /gateway/agents/{id}/description`). Returns the agent as the server now holds it. */
export async function updateAgentDescription(
  server: SwitchServer,
  agentId: string,
  description: string
): Promise<RemoteAgentSummary> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}/description`, {
    authenticated: true,
    method: 'PUT',
    body: { description },
  });
  return toRemoteAgentSummary((await res.json()) as AgentSummaryJson);
}

/**
 * Set (or clear, with `displayName = null`) an agent's display name
 * (`PUT /agents/{id}/display-name`). Only the agent's owner (or an admin) may
 * change it; a refusal surfaces as a `GatewayError`.
 */
export async function updateAgentDisplayName(
  server: SwitchServer,
  agentId: string,
  displayName: string | null
): Promise<RemoteAgentSummary> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}/display-name`, {
    authenticated: true,
    method: 'PUT',
    body: { display_name: displayName },
  });
  return toRemoteAgentSummary((await res.json()) as AgentSummaryJson);
}

/** List a server's room groups (`GET /room-groups`), for the addressing-rule
 * room-group selector. */
export async function fetchRoomGroups(server: SwitchServer): Promise<RemoteRoomGroup[]> {
  const res = await gatewayFetch(server, '/room-groups', { authenticated: true });
  const json = (await res.json()) as Array<{ id: string; name: string }>;
  return json.map((g) => ({ id: g.id, name: g.name }));
}

/** The gateway `BridgeDetail` wire shape, as returned by list, create, and
 * update. One shape and one mapper for all three, so a field cannot reach one
 * endpoint's response and miss another. */
type BridgeJson = {
  bridge_id: string;
  bridge_type: string;
  display_name: string;
  status: string;
  is_default?: boolean;
  home_url?: string | null;
  // Both absent on a server predating the capability — defaulting each to
  // true reproduces how every bridge behaved before it existed: any platform
  // could be asked to create a channel, and none had it withheld.
  channel_creation_supported?: boolean;
  channel_creation_enabled?: boolean;
  // Absent on a server predating Telegram, where every bridge had a directory.
  directory_search_supported?: boolean;
};

function mapBridge(b: BridgeJson): RemoteBridge {
  const channelCreationSupported = b.channel_creation_supported ?? true;
  const channelCreationEnabled = b.channel_creation_enabled ?? true;
  return {
    id: b.bridge_id,
    type: b.bridge_type,
    displayName: b.display_name,
    status: b.status,
    isDefault: b.is_default ?? false,
    homeUrl: b.home_url ?? null,
    channelCreationSupported,
    canCreateChannels: channelCreationSupported && channelCreationEnabled,
    directorySearchSupported: b.directory_search_supported ?? true,
  };
}

/**
 * List the collaboration bridges configured on a server (`GET /collaborations`).
 * Returns every bridge regardless of status — callers that need a usable one
 * (room creation) filter on `status === 'active'` themselves, so they can tell
 * "no bridges at all" apart from "the bridge is down".
 */
export async function fetchBridges(server: SwitchServer): Promise<RemoteBridge[]> {
  const res = await gatewayFetch(server, '/collaborations', { authenticated: true });
  const json = (await res.json()) as BridgeJson[];
  return json.map(mapBridge);
}

/**
 * The messaging platforms this deployment has its own app for, which a
 * workspace can install with the platform's OAuth consent screen instead of
 * registering an app and pasting its tokens. Empty on a deployment that
 * registered none.
 *
 * A 404 is a server from before the route existed; it has no app to install
 * either, so it answers empty rather than failing the connect dialog.
 */
export async function fetchInstallablePlatforms(server: SwitchServer): Promise<string[]> {
  let res: Response;
  try {
    res = await gatewayFetch(server, '/messaging-apps', { authenticated: true });
  } catch (cause) {
    if (cause instanceof GatewayError && cause.status === 404) return [];
    throw cause;
  }
  const json = (await res.json()) as { platforms: string[] };
  return json.platforms;
}

/**
 * Start installing the deployment's app for `platform` into the workspace the
 * session is bound to. Returns the platform's consent URL, which must be
 * opened in a real browser: the platform refuses to render it in a frame, and
 * the server finishes the install on its own public callback, so nothing comes
 * back to Switch Console but the new bridge.
 */
export async function beginMessagingAppInstall(
  server: SwitchServer,
  platform: string
): Promise<string> {
  const res = await gatewayFetch(
    server,
    `/messaging-apps/${encodeURIComponent(platform)}/install`,
    { authenticated: true, method: 'POST' }
  );
  const json = (await res.json()) as { authorize_url: string };
  return json.authorize_url;
}

/** Field names that hold a credential and must be masked on input. Mirrors the
 * operator dashboard's `isSecretField`, widened to catch `*_private_key` (the
 * Teams bridge's Graph encryption key), which its bare `api_key` alternation
 * misses. */
const SECRET_FIELD_RE = /token|password|secret|api[_-]?key|private[_-]?key|credential/i;

/** JSON Schema as Pydantic's `model_json_schema()` emits it for a bridge config. */
type BridgeConfigSchemaProperty = {
  title?: string;
  description?: string;
  format?: string;
  type?: string;
  default?: unknown;
  /** Pydantic emits `bool | None` as `anyOf: [{type:"boolean"},{type:"null"}]`
   * rather than a top-level `type`, so look through it. */
  anyOf?: Array<{ type?: string }>;
};

type BridgeConfigSchema = {
  properties?: Record<string, BridgeConfigSchemaProperty>;
  required?: string[];
};

function primitiveType(prop: BridgeConfigSchemaProperty): string | undefined {
  if (prop.type) return prop.type;
  return prop.anyOf?.find((variant) => variant.type && variant.type !== 'null')?.type;
}

function humanizeFieldKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function toConfigFields(schema: BridgeConfigSchema): BridgeConfigField[] {
  const required = new Set(schema.required ?? []);
  // Object key order follows the Pydantic model's field order, which puts the
  // required credentials before the optional tuning knobs — worth preserving,
  // so the form reads the way the platform's setup docs do.
  return Object.entries(schema.properties ?? {}).map(([key, prop]) => {
    const kind = primitiveType(prop) === 'boolean' ? 'boolean' : 'string';
    const fallback = kind === 'boolean' ? false : null;
    return {
      key,
      label: prop.title ?? humanizeFieldKey(key),
      description: prop.description ?? null,
      required: required.has(key),
      secret: prop.format === 'password' || SECRET_FIELD_RE.test(key),
      kind,
      default:
        typeof prop.default === 'string' || typeof prop.default === 'boolean'
          ? prop.default
          : fallback,
    };
  });
}

/**
 * The bridge types a server can register, with the credential fields each needs
 * (`GET /collaborations/types`).
 *
 * The field list is the server's to define — switch-core derives it from the
 * adapter's own config model — so the attach form is generated from this rather
 * than hard-coded per platform. A server running a newer switch-core that adds
 * a bridge type, or a field to an existing one, works without an app release.
 *
 * Fields carry their primitive type, because they are no longer all strings:
 * the Slack bridge's agent-user-groups toggle is a boolean, and the server
 * rejects an empty string as one rather than coercing it.
 */
export async function fetchBridgeTypes(server: SwitchServer): Promise<RemoteBridgeType[]> {
  const res = await gatewayFetch(server, '/collaborations/types', { authenticated: true });
  const json = (await res.json()) as Array<{
    key: string;
    config_schema: BridgeConfigSchema;
    channel_creation_supported?: boolean;
    directory_search_supported?: boolean;
  }>;
  return json.map((t) => ({
    key: t.key,
    fields: toConfigFields(t.config_schema ?? {}),
    // Absent on a server predating the capability — every platform could be
    // registered to create channels before it existed, so default true.
    channelCreationSupported: t.channel_creation_supported ?? true,
    directorySearchSupported: t.directory_search_supported ?? true,
  }));
}

/**
 * Register a collaboration bridge on `server` (admin-only
 * `POST /collaborations`), optionally making it the default for new rooms.
 *
 * The server validates the credentials against the adapter's config model,
 * mints the bridge's Matrix client, persists it and **starts the adapter
 * immediately** — there is no stack restart and no config file to write, so
 * live sessions and connected agents are unaffected.
 *
 * `connectionConfig` holds platform credentials. Do not log it, do not return
 * it to the renderer, and do not fold it into an error message: `GatewayError`
 * quotes the *response* body only, never the request.
 */
export async function createBridge(
  server: SwitchServer,
  params: {
    bridgeType: string;
    displayName: string;
    connectionConfig: Record<string, string | boolean>;
    setAsDefault: boolean;
    channelCreationEnabled: boolean;
  }
): Promise<RemoteBridge> {
  const res = await gatewayFetch(server, '/collaborations', {
    authenticated: true,
    method: 'POST',
    body: {
      bridge_type: params.bridgeType,
      display_name: params.displayName,
      connection_config: params.connectionConfig,
      set_as_default: params.setAsDefault,
      channel_creation_enabled: params.channelCreationEnabled,
    },
  });
  return mapBridge((await res.json()) as BridgeJson);
}

/**
 * Edit an existing bridge's operator-controlled switches
 * (admin-only `PATCH /collaborations/{id}`). Only fields present in `params`
 * are sent, so an unset one is left unchanged rather than reset — the gateway
 * treats the request the same way.
 *
 * Posting `channelCreationEnabled: true` for a platform whose adapter cannot
 * create channels at all returns 400 with a message naming the platform;
 * callers map that like any other rejected edit rather than a bridge-specific
 * case.
 */
export async function updateBridge(
  server: SwitchServer,
  bridgeId: string,
  params: { channelCreationEnabled?: boolean }
): Promise<RemoteBridge> {
  const res = await gatewayFetch(server, `/collaborations/${encodeURIComponent(bridgeId)}`, {
    authenticated: true,
    method: 'PATCH',
    body: { channel_creation_enabled: params.channelCreationEnabled },
  });
  return mapBridge((await res.json()) as BridgeJson);
}

/**
 * Disconnect a collaboration bridge from `server` (admin-only
 * `DELETE /collaborations/{id}`).
 *
 * **This deletes every Switch room on the bridge before removing it**, along
 * with the conversations in them. It is the most destructive call on the
 * gateway's collaboration router, not a pause that can be undone by attaching
 * the platform again, and the caller is responsible for saying so before it is
 * made.
 *
 * Recoverable failures are mapped so the caller can name them: a non-admin gets
 * `forbidden`, and a bridge that is already gone gets `not-found` rather than a
 * success. Anything else — a rejected adapter shutdown, an unexpected 500 —
 * still throws, so a delete that did not happen can never read as one that did.
 */
export async function deleteBridge(
  server: SwitchServer,
  bridgeId: string
): Promise<DeleteBridgeResult> {
  try {
    await gatewayFetch(server, `/collaborations/${encodeURIComponent(bridgeId)}`, {
      authenticated: true,
      method: 'DELETE',
    });
    return { kind: 'deleted' };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      if (cause.kind === 'http' && cause.status === 403) return { kind: 'forbidden' };
      if (cause.kind === 'http' && cause.status === 404) return { kind: 'not-found' };
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}

/** The gateway `IdentityClaimant` wire shape. */
type IdentityClaimantJson = {
  user_id: string;
  user_name: string;
};

/** The gateway `ExternalUserSummary` wire shape. */
type ExternalUserSummaryJson = {
  id: string;
  bridge_id: string;
  external_user_id: string;
  external_username: string;
  claimed_by?: IdentityClaimantJson[];
};

/**
 * Union of external (bridged human) users across every bridge on the server
 * (`GET /collaborations`, then each bridge's `/users`). The addressing policy's
 * `users` dimension keys off these ExternalUser ids.
 */
export async function fetchAllExternalUsers(server: SwitchServer): Promise<RemoteExternalUser[]> {
  const bridges = await fetchBridges(server);
  const byId = new Map<string, RemoteExternalUser>();
  for (const bridge of bridges) {
    const res = await gatewayFetch(
      server,
      `/collaborations/${encodeURIComponent(bridge.id)}/users`,
      { authenticated: true }
    );
    const users = (await res.json()) as ExternalUserSummaryJson[];
    for (const u of users) byId.set(u.id, { id: u.id, username: u.external_username });
  }
  return [...byId.values()];
}

/**
 * Search one bridge's own user directory (`GET /collaborations/{id}/directory`).
 *
 * This asks the messaging platform rather than Switch's record of who has
 * spoken, which is what lets someone claim their account in a workspace they
 * have never posted in. A platform with no searchable directory answers 501 and
 * a stopped bridge 409; both surface as a `GatewayError` the caller maps onto
 * something it can say out loud rather than an empty result list.
 */
export async function searchBridgeDirectory(
  server: SwitchServer,
  bridgeId: string,
  query: string
): Promise<{ users: BridgeDirectoryUser[]; note: string | null }> {
  const res = await gatewayFetch(
    server,
    `/collaborations/${encodeURIComponent(bridgeId)}/directory?query=${encodeURIComponent(query)}`,
    { authenticated: true }
  );
  type DirectoryUserJson = {
    external_user_id: string;
    username: string;
    display_name: string;
    email?: string | null;
    known_external_user_id?: string | null;
    claimed_by?: IdentityClaimantJson[];
  };
  // A switch-core predating the known-accounts fallback returns the bare array
  // and refuses the search outright when the platform has no directory. Both
  // shapes read the same here; the older one simply never carries a note.
  const json = (await res.json()) as
    | DirectoryUserJson[]
    | { source?: string; note?: string | null; users?: DirectoryUserJson[] };
  const rows = Array.isArray(json) ? json : (json.users ?? []);
  return {
    note: Array.isArray(json) ? null : (json.note ?? null),
    users: rows.map((u) => ({
      externalUserId: u.external_user_id,
      username: u.username,
      displayName: u.display_name,
      email: u.email ?? null,
      knownExternalUserId: u.known_external_user_id ?? null,
      claimedBy: (u.claimed_by ?? []).map((c) => ({ userId: c.user_id, userName: c.user_name })),
    })),
  };
}

/**
 * Claim a platform identity for the signed-in user
 * (`POST /collaborations/{id}/identities`). `user_id` is deliberately omitted:
 * Switch Console only ever claims on behalf of whoever is signed in, and
 * claiming for someone else is an admin action that belongs in the operator
 * dashboard. Claims are not exclusive, so an account someone else has already
 * claimed is claimed normally; a 409 means only that the bridge is stopped and
 * an unseen account cannot be provisioned, and surfaces as a `GatewayError`
 * with that status.
 */
export async function claimBridgeIdentity(
  server: SwitchServer,
  bridgeId: string,
  params: { externalUserId: string; username: string }
): Promise<ExternalUserSummaryJson> {
  const res = await gatewayFetch(
    server,
    `/collaborations/${encodeURIComponent(bridgeId)}/identities`,
    {
      authenticated: true,
      method: 'POST',
      body: { external_user_id: params.externalUserId, username: params.username },
    }
  );
  return (await res.json()) as ExternalUserSummaryJson;
}

/**
 * Drop one claim on a platform account
 * (`DELETE /collaborations/{id}/identities/{rowId}`). `externalUserRowId` is
 * the `ExternalUser` row id, not the platform's id.
 *
 * Several users can hold a claim on the same account, so `userId` says whose
 * to drop; anyone else's is left standing. Null falls back to the server's
 * default — the caller — which is what the app wants when the signed-in user's
 * id has not been read from the server yet. Releasing someone else's claim is
 * admin-only server-side.
 */
export async function releaseBridgeIdentity(
  server: SwitchServer,
  bridgeId: string,
  externalUserRowId: string,
  userId: string | null
): Promise<void> {
  const query = userId === null ? '' : `?user_id=${encodeURIComponent(userId)}`;
  await gatewayFetch(
    server,
    `/collaborations/${encodeURIComponent(bridgeId)}/identities/${encodeURIComponent(externalUserRowId)}${query}`,
    { authenticated: true, method: 'DELETE' }
  );
}

/**
 * The messaging accounts the signed-in user has claimed
 * (`GET /auth/me/identities`). An agent whose policy names its owner is
 * unreachable by that owner on any bridge missing from this list, so this is
 * what the addressing UI checks before letting a policy seal an agent off.
 */
export async function fetchMyIdentities(server: SwitchServer): Promise<LinkedIdentity[]> {
  const res = await gatewayFetch(server, '/auth/me/identities', { authenticated: true });
  const json = (await res.json()) as Array<{
    id: string;
    bridge_id: string;
    bridge_display_name: string;
    bridge_type: string;
    external_user_id: string;
    external_username: string;
  }>;
  return json.map((i) => ({
    id: i.id,
    bridgeId: i.bridge_id,
    bridgeDisplayName: i.bridge_display_name,
    bridgeType: i.bridge_type,
    externalUserId: i.external_user_id,
    externalUsername: i.external_username,
  }));
}

/** A subagent registered via the bulk endpoint. `apiKey` is a secret — keep it
 * in the main process (write it to the subagent's settings file); never pass it
 * to the renderer. */
export type BulkRegisteredSubagent = {
  agentName: string;
  name: string;
  id: string;
  apiKey: string;
};

/**
 * Register Claude Code subagents under a parent agent on `server`
 * (session-authed `POST /gateway/agents/register-known-bulk`). The signed-in
 * user must own the parent. A 409 (one or more names already exist) surfaces as
 * a `GatewayError` with status 409 so the caller can offer to overwrite.
 */
export async function registerSubagentsBulk(
  server: SwitchServer,
  params: {
    parentAgentId: string;
    subagents: { agentName: string; description: string }[];
    /** Register every subagent with the `auto_session` connection model, so a
     * watcher auto-spawns a session when the subagent is addressed. */
    autoSession: boolean;
    overwrite?: boolean;
  }
): Promise<BulkRegisteredSubagent[]> {
  const res = await gatewayFetch(server, '/agents/register-known-bulk', {
    authenticated: true,
    method: 'POST',
    body: {
      agent_type: 'claude-code',
      parent_agent_id: params.parentAgentId,
      options: params.autoSession ? { auto_session: true } : {},
      subagents: params.subagents.map((s) => ({
        subagent_name: s.agentName,
        description: s.description,
      })),
      overwrite: params.overwrite ?? false,
    },
  });
  const json = (await res.json()) as {
    results: Array<{ subagent_name: string; name: string; id: string; api_key: string }>;
  };
  return json.results.map((r) => ({
    agentName: r.subagent_name,
    name: r.name,
    id: r.id,
    apiKey: r.api_key,
  }));
}

/**
 * Delete an agent on `server` (session-authed `DELETE /agents/{agentId}`). Used
 * to deregister a subagent's child identity when it is removed from Switch Console.
 * The signed-in user must own the agent.
 */
export async function deleteAgent(server: SwitchServer, agentId: string): Promise<void> {
  await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
    method: 'DELETE',
  });
}

/**
 * Export a room's configuration as YAML (`GET /rooms/{roomId}/yaml`). Returns
 * the raw YAML text, in the shape `POST /rooms/from-yaml` accepts, so the
 * exported file round-trips through import unchanged.
 *
 * Each section can be dropped via its boolean toggles (default: all included).
 */
export async function exportRoomYaml(
  server: SwitchServer,
  roomId: string,
  sections?: {
    agents?: boolean;
    users?: boolean;
    references?: boolean;
    docs?: boolean;
    roles?: boolean;
  }
): Promise<string> {
  const params = new URLSearchParams();
  if (sections?.agents === false) params.set('agents', 'false');
  if (sections?.users === false) params.set('users', 'false');
  if (sections?.references === false) params.set('references', 'false');
  if (sections?.docs === false) params.set('docs', 'false');
  if (sections?.roles === false) params.set('roles', 'false');
  const query = params.toString();
  const path = `/rooms/${encodeURIComponent(roomId)}/yaml${query ? `?${query}` : ''}`;
  const res = await gatewayFetch(server, path, { authenticated: true });
  return res.text();
}

/** The result of provisioning a room from a YAML template. */
export type TemplateProvisionResult = {
  roomId: string;
  roomName: string;
  failedAttachments: Array<{ kind: string; id: string; error: string }>;
};

/** The result of provisioning a room group from a YAML template. */
export type GroupProvisionResult = {
  groupId: string;
  groupName: string;
  rooms: TemplateProvisionResult[];
  /** Rooms or links that could not be created. The others were. */
  errors: Array<Record<string, unknown> & { error: string }>;
};

export type ProvisionFromTemplateResult =
  | ({ kind: 'room' } & TemplateProvisionResult)
  | ({ kind: 'group' } & GroupProvisionResult);

type RoomJson = {
  room_id: string;
  room_name: string;
  failed_attachments?: Array<{ kind: string; id: string; error: string }>;
};

function toRoomResult(json: RoomJson): TemplateProvisionResult {
  return {
    roomId: json.room_id,
    roomName: json.room_name,
    failedAttachments: json.failed_attachments ?? [],
  };
}

/**
 * Create a room, or a group of rooms, from a YAML template
 * (`POST /rooms/from-yaml`). Sends the template as a JSON body with the YAML
 * text and any user-supplied inputs. The server parses the template,
 * interpolates inputs, and provisions everything in one call; the document's
 * shape decides which result comes back.
 *
 * A 400 carries a `detail` naming the bad input; the caller maps it back to
 * the form field.
 */
export async function createRoomFromTemplate(
  server: SwitchServer,
  yamlText: string,
  inputs: Record<string, string | number | boolean>,
  /** The template's display name, so the run it starts says where it came from. */
  templateName?: string
): Promise<ProvisionFromTemplateResult> {
  const res = await gatewayFetch(server, '/rooms/from-yaml', {
    authenticated: true,
    method: 'POST',
    body: { yaml: yamlText, inputs, ...(templateName ? { template_name: templateName } : {}) },
  });
  const json = (await res.json()) as
    | RoomJson
    | {
        group_id: string;
        group_name: string;
        rooms?: RoomJson[];
        errors?: Array<Record<string, unknown> & { error: string }>;
      };
  if ('group_id' in json) {
    return {
      kind: 'group',
      groupId: json.group_id,
      groupName: json.group_name,
      rooms: (json.rooms ?? []).map(toRoomResult),
      errors: json.errors ?? [],
    };
  }
  return { kind: 'room', ...toRoomResult(json) };
}

// ── Template runs ───────────────────────────────────────────────────────────

/** `paused` waits for its owner to continue it; `stopped` refuses further
 * agent room creation for good. */
export type TemplateRunState = 'running' | 'paused' | 'stopped';

/** One room of a run, the root included. */
export type TemplateRunRoom = {
  id: string;
  name: string;
  /** Null for the root room. */
  parentRoomId: string | null;
  /** Null when a person created the room. */
  createdByAgentId: string | null;
  createdByAgentName: string | null;
  templateName: string | null;
  createdAt: string;
  archived: boolean;
};

/**
 * A chain of rooms that started in one room a person made: every room an
 * agent created from there, and every room those rooms' agents created.
 */
export type TemplateRun = {
  rootRoomId: string;
  rootRoomName: string;
  /** The person who made the root room, or the agent that did. */
  startedByName: string | null;
  /** The first template used in the run. */
  templateName: string | null;
  startedAt: string;
  lastActivityAt: string;
  state: TemplateRunState;
  /** An agent is mid-turn in one of the run's rooms right now. */
  working: boolean;
  /** Why the run is paused or stopped, as a sentence. */
  reason: string | null;
  /** Who stopped or continued it. Null when the server paused it. */
  changedByName: string | null;
  /** The room a paused request would have repeated. */
  pausedRepeatOf: string | null;
  /** Whether the signed-in user may stop or continue it. */
  canControl: boolean;
  /** In creation order, the root first. */
  rooms: TemplateRunRoom[];
};

type TemplateRunRoomJson = {
  id: string;
  name: string;
  parent_room_id: string | null;
  created_by_agent_id: string | null;
  created_by_agent_name: string | null;
  template_name: string | null;
  created_at: string;
  archived: boolean;
};

type TemplateRunJson = {
  root_room_id: string;
  root_room_name: string;
  started_by_name: string | null;
  template_name: string | null;
  started_at: string;
  last_activity_at: string;
  state: TemplateRunState;
  working?: boolean;
  reason: string | null;
  changed_by_name: string | null;
  paused_repeat_of: string | null;
  can_control: boolean;
  rooms: TemplateRunRoomJson[];
};

function toTemplateRun(json: TemplateRunJson): TemplateRun {
  return {
    rootRoomId: json.root_room_id,
    rootRoomName: json.root_room_name,
    startedByName: json.started_by_name ?? null,
    templateName: json.template_name,
    startedAt: json.started_at,
    lastActivityAt: json.last_activity_at,
    state: json.state,
    working: json.working ?? false,
    reason: json.reason,
    changedByName: json.changed_by_name,
    pausedRepeatOf: json.paused_repeat_of,
    canControl: json.can_control,
    rooms: (json.rooms ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      parentRoomId: r.parent_room_id,
      createdByAgentId: r.created_by_agent_id,
      createdByAgentName: r.created_by_agent_name,
      templateName: r.template_name,
      createdAt: r.created_at,
      archived: r.archived,
    })),
  };
}

/**
 * The runs the signed-in user may see, newest activity first
 * (`GET /template-runs`). Null when the server does not support the endpoint
 * (404): a server from before runs were recorded.
 */
export async function fetchTemplateRuns(server: SwitchServer): Promise<TemplateRun[] | null> {
  try {
    const res = await gatewayFetch(server, '/template-runs', { authenticated: true });
    const json = (await res.json()) as TemplateRunJson[];
    return json.map(toTemplateRun);
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Stop or continue a run (`POST /template-runs/{root}/stop` or `/continue`).
 * The server answers 403 when the user may not control it, 404 for an unknown
 * run and 409 for one already stopped; the `detail` says which.
 */
export async function changeTemplateRun(
  server: SwitchServer,
  rootRoomId: string,
  action: 'stop' | 'continue'
): Promise<TemplateRun> {
  const res = await gatewayFetch(
    server,
    `/template-runs/${encodeURIComponent(rootRoomId)}/${action}`,
    { authenticated: true, method: 'POST' }
  );
  return toTemplateRun((await res.json()) as TemplateRunJson);
}

// ── Stored templates (template registry) ────────────────────────────────────

export type StoredTemplateSummary = {
  id: string;
  name: string;
  description: string;
  kind: string;
  creator: string;
  /** The owner's user id, so the Console can mark the signed-in user's own templates. */
  ownerId: string | null;
  /** Starts at 1 and goes up by one each time the document is changed. */
  version: number;
  /** `private` is seen by its owner and admins only. */
  readVisibility: TemplateVisibility;
  /** `public` lets anyone who can read it change it. */
  writeVisibility: TemplateVisibility;
  /** Whether the signed-in user may change the document, as the server judges
   * it. Null when the server does not say. */
  canEdit: boolean | null;
  /** Whether the signed-in user may remove it or change who uses it: the
   * owner, or an admin of the workspace. Null when the server does not say. */
  canManage: boolean | null;
};

export type TemplateVisibility = 'public' | 'private';

export type StoredTemplateDetail = StoredTemplateSummary & {
  definition: string;
};

type RegistryTemplateSummary = {
  id: string;
  owner_id: string;
  owner_name: string | null;
  name: string;
  description: string;
  kind: string;
  version?: number;
  read_visibility?: TemplateVisibility;
  write_visibility?: TemplateVisibility;
  can_edit?: boolean;
  can_manage?: boolean;
};

function toSummary(t: RegistryTemplateSummary): StoredTemplateSummary {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    kind: t.kind,
    creator: t.owner_name ?? t.owner_id,
    ownerId: t.owner_id,
    // A server that does not report versions is read as being on the first.
    version: t.version ?? 1,
    // A server without visibility fields shares every template and lets its
    // owner or an admin change it, which is what these defaults say.
    readVisibility: t.read_visibility ?? 'public',
    writeVisibility: t.write_visibility ?? 'private',
    canEdit: t.can_edit ?? null,
    canManage: t.can_manage ?? null,
  };
}

/** The templates the signed-in user may see, optionally narrowed by kind or
 * by a search over name and description. */
export async function fetchTemplates(
  server: SwitchServer,
  filter: { kind?: string; q?: string } = {}
): Promise<StoredTemplateSummary[]> {
  const params = new URLSearchParams();
  if (filter.kind) params.set('kind', filter.kind);
  if (filter.q) params.set('q', filter.q);
  const qs = params.size > 0 ? `?${params}` : '';
  const res = await gatewayFetch(server, `/templates${qs}`, {
    authenticated: true,
  });
  const json = (await res.json()) as RegistryTemplateSummary[];
  return json.map(toSummary);
}

/** Store a template document on the server's registry (`POST /templates`). */
export async function createTemplate(
  server: SwitchServer,
  params: {
    name: string;
    description: string;
    kind: string;
    content: string;
    readVisibility?: TemplateVisibility;
    writeVisibility?: TemplateVisibility;
  }
): Promise<StoredTemplateDetail> {
  const { readVisibility, writeVisibility, ...rest } = params;
  const res = await gatewayFetch(server, '/templates', {
    authenticated: true,
    method: 'POST',
    body: {
      ...rest,
      // Left out when unset: a server without visibility refuses unknown fields.
      ...(readVisibility ? { read_visibility: readVisibility } : {}),
      ...(writeVisibility ? { write_visibility: writeVisibility } : {}),
    },
  });
  const t = (await res.json()) as RegistryTemplateSummary & { content: string };
  return { ...toSummary(t), definition: t.content };
}

/** Change a stored template (`PATCH /templates/{id}`). The server answers
 * 404 for a template the caller may not read, 403 for one they may not
 * edit, and 409 when the owner already has a template by the new name. */
export async function updateTemplate(
  server: SwitchServer,
  templateId: string,
  changes: {
    name?: string;
    description?: string;
    /** The listing label, sent when an edit changed the document's shape. */
    kind?: string;
    content?: string;
    readVisibility?: TemplateVisibility;
    writeVisibility?: TemplateVisibility;
  }
): Promise<StoredTemplateDetail> {
  const { readVisibility, writeVisibility, ...rest } = changes;
  const res = await gatewayFetch(server, `/templates/${encodeURIComponent(templateId)}`, {
    authenticated: true,
    method: 'PATCH',
    body: {
      ...rest,
      ...(readVisibility ? { read_visibility: readVisibility } : {}),
      ...(writeVisibility ? { write_visibility: writeVisibility } : {}),
    },
  });
  const t = (await res.json()) as RegistryTemplateSummary & { content: string };
  return { ...toSummary(t), definition: t.content };
}

/** Remove a template from the server's registry (`DELETE /templates/{id}`). */
export async function deleteTemplate(server: SwitchServer, templateId: string): Promise<void> {
  await gatewayFetch(server, `/templates/${encodeURIComponent(templateId)}`, {
    authenticated: true,
    method: 'DELETE',
  });
}

export async function fetchTemplateDetail(
  server: SwitchServer,
  templateId: string
): Promise<StoredTemplateDetail> {
  const res = await gatewayFetch(server, `/templates/${encodeURIComponent(templateId)}`, {
    authenticated: true,
  });
  const t = (await res.json()) as RegistryTemplateSummary & { content: string };
  return { ...toSummary(t), definition: t.content };
}

/**
 * Fetch the JSON Schema describing a valid room template. Returns null when
 * the server does not support the endpoint (404): older servers without
 * `params:` support.
 */
export async function fetchTemplateSchema(
  server: SwitchServer
): Promise<Record<string, unknown> | null> {
  try {
    const res = await gatewayFetch(server, '/rooms/template-schema', {
      authenticated: true,
    });
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404) return null;
    throw e;
  }
}

export async function fetchRoomRoles(
  server: SwitchServer,
  roomId: string
): Promise<RemoteRoomRole[]> {
  const res = await gatewayFetch(server, `/rooms/${encodeURIComponent(roomId)}/roles`, {
    authenticated: true,
  });
  const json = (await res.json()) as Array<{
    name: string;
    instructions: string;
    exclusive: boolean;
    held_by?: string[];
  }>;
  return json.map((r) => ({
    name: r.name,
    instructions: r.instructions,
    exclusive: r.exclusive,
    heldBy: r.held_by ?? [],
  }));
}

/** The gateway `RoomSummary` wire shape. `RoomDetail` (returned by create) is a
 * superset, so the same mapper serves both. */
type RoomSummaryJson = {
  id: string;
  name: string;
  description: string;
  channel_type: string | null;
  agent_count: number;
  bridge_display_name: string | null;
  bridge_type?: string | null;
  external_channel_url?: string | null;
  owner_id?: string | null;
  archived: boolean;
  created_at: string;
};

function mapRoomSummary(r: RoomSummaryJson): RemoteRoomSummary {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    channelType: r.channel_type,
    agentCount: r.agent_count,
    bridgeDisplayName: r.bridge_display_name,
    bridgeType: r.bridge_type ?? null,
    externalChannelUrl: r.external_channel_url ?? null,
    ownerId: r.owner_id ?? null,
    archived: r.archived,
    createdAt: r.created_at,
  };
}

export async function fetchRooms(server: SwitchServer): Promise<RemoteRoomSummary[]> {
  const res = await gatewayFetch(server, '/rooms', { authenticated: true });
  const json = (await res.json()) as RoomSummaryJson[];
  return json.map(mapRoomSummary);
}

/** The gateway `RoomDetail` wire shape — `RoomSummary` plus the fields only a
 * single-room read carries. */
type RoomDetailJson = RoomSummaryJson & {
  instructions?: string | null;
  agent_ids?: string[];
  connected_user_names?: string[];
};

function mapRoomDetail(r: RoomDetailJson): RemoteRoomDetail {
  return {
    ...mapRoomSummary(r),
    instructions: r.instructions ?? null,
    agentIds: r.agent_ids ?? [],
    connectedUserNames: r.connected_user_names ?? [],
  };
}

/** One room in full (`GET /rooms/{id}`) — what its configuration page reads. */
export async function fetchRoomDetail(
  server: SwitchServer,
  roomId: string
): Promise<RemoteRoomDetail> {
  const res = await gatewayFetch(server, `/rooms/${encodeURIComponent(roomId)}`, {
    authenticated: true,
  });
  return mapRoomDetail((await res.json()) as RoomDetailJson);
}

/**
 * Switch agent ids that are members of a room. One call for the whole room,
 * rather than asking every candidate agent what it belongs to. Connecting to a
 * room is only meaningful for an agent already in it, so this is what scopes the
 * agent picker when starting a session from a room.
 */
export async function fetchRoomAgentIds(server: SwitchServer, roomId: string): Promise<string[]> {
  return (await fetchRoomDetail(server, roomId)).agentIds;
}

/**
 * Change a room's own settings (`PATCH /rooms/{id}`). Requires write access to
 * the room; the gateway returns the room as it now stands, so the caller reads
 * back what was actually stored rather than assuming its own input landed.
 *
 * A field left out is left alone. An empty string is a real value and clears the
 * field — that is how a description or a set of instructions is removed.
 */
export async function updateRoom(
  server: SwitchServer,
  roomId: string,
  changes: { description?: string; instructions?: string }
): Promise<RemoteRoomDetail> {
  const res = await gatewayFetch(server, `/rooms/${encodeURIComponent(roomId)}`, {
    authenticated: true,
    method: 'PATCH',
    body: changes,
  });
  return mapRoomDetail((await res.json()) as RoomDetailJson);
}

/**
 * Add agents to an existing room (`POST /rooms/{id}/agents`). Requires write
 * access to the room. Agents already in the room are ignored server-side, so
 * this is safe to call with a set that overlaps the current membership.
 */
export async function addRoomAgents(
  server: SwitchServer,
  roomId: string,
  agentIds: string[]
): Promise<void> {
  await gatewayFetch(server, `/rooms/${encodeURIComponent(roomId)}/agents`, {
    authenticated: true,
    method: 'POST',
    body: { agent_ids: agentIds },
  });
}

/**
 * Remove one agent from a room (`DELETE /rooms/{id}/agents/{agentId}`). Requires
 * write access. This is membership only — the agent itself, its credentials and
 * its sessions are untouched; it simply stops being in this room.
 */
export async function removeRoomAgent(
  server: SwitchServer,
  roomId: string,
  agentId: string
): Promise<void> {
  await gatewayFetch(
    server,
    `/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`,
    { authenticated: true, method: 'DELETE' }
  );
}

/**
 * Delete a room outright (`DELETE /rooms/{id}`), taking its history and its
 * bridged channel with it.
 *
 * The gateway decides who may: its owner, or an admin. Switch Console hides the
 * action from anyone else, but that is a courtesy — a refusal here is the
 * authoritative answer and is surfaced rather than swallowed.
 */
export async function deleteRoom(server: SwitchServer, roomId: string): Promise<void> {
  await gatewayFetch(server, `/rooms/${encodeURIComponent(roomId)}`, {
    authenticated: true,
    method: 'DELETE',
  });
}

/**
 * Create a room on `server` (session-authed `POST /gateway/rooms`), owned by the
 * signed-in user. Provisioning stays entirely server-side — this is the same
 * endpoint the operator web app posts to.
 *
 * `bridgeId` is required by Switch Console even though the gateway allows an
 * unbridged room: a room with no messaging app attached is unreachable for the
 * humans it is being created for. `channel_type` is always `channel_public` for
 * now; the gateway demands the field whenever a new channel is provisioned.
 *
 * Failures throw `GatewayError` — see `createRoomOnServer` for the mapping onto
 * a user-facing result.
 */
export async function createRoom(
  server: SwitchServer,
  params: {
    name: string;
    description: string;
    instructions?: string;
    bridgeId: string;
    agentIds: string[];
  }
): Promise<RemoteRoomSummary> {
  const res = await gatewayFetch(server, '/rooms', {
    authenticated: true,
    method: 'POST',
    body: {
      name: params.name,
      description: params.description,
      instructions: params.instructions?.trim() ? params.instructions : null,
      bridge_id: params.bridgeId,
      channel_type: 'channel_public',
      agent_ids: params.agentIds,
    },
  });
  return mapRoomSummary((await res.json()) as RoomSummaryJson);
}

async function readClaudeConnection(response: Response): Promise<ClaudeConnection> {
  const value: unknown = await response.json();
  if (typeof value === 'object' && value !== null && 'status' in value) {
    if (value.status === 'not_connected') return { status: 'not_connected' };
    if (
      value.status === 'connected' &&
      'kind' in value &&
      (value.kind === 'api-key' || value.kind === 'setup-token') &&
      'verified_at' in value &&
      typeof value.verified_at === 'string' &&
      Number.isFinite(Date.parse(value.verified_at))
    ) {
      return { status: 'connected', kind: value.kind, verified_at: value.verified_at };
    }
  }
  throw new GatewayError('http', 'The server returned an invalid Claude connection status.');
}

export async function getClaudeConnection(server: SwitchServer): Promise<ClaudeConnection> {
  const response = await gatewayFetch(server, '/provider-connections/claude', {
    authenticated: true,
  });
  return readClaudeConnection(response);
}

export async function createCloudLaunch(
  server: SwitchServer,
  input: CloudLaunchInput & { definition: string }
) {
  if (new URL(server.gatewayUrl).protocol !== 'https:')
    throw new Error('Cloud agents require an HTTPS Switch server.');
  return cloudLaunchSchema.parse(
    await (
      await gatewayFetch(server, '/hosted-launches', {
        authenticated: true,
        method: 'POST',
        body: input,
      })
    ).json()
  );
}

const cloudConfigurationSchema = z.object({
  description: z.string(),
  instructions: z.string(),
  definition_attributes: z.record(z.string(), z.unknown()),
});

export async function getCloudLaunchConfiguration(
  server: SwitchServer,
  requestId: string
): Promise<CloudLaunchConfiguration> {
  return cloudConfigurationSchema.parse(
    await (
      await gatewayFetch(
        server,
        `/hosted-launches/${encodeURIComponent(requestId)}/configuration`,
        { authenticated: true }
      )
    ).json()
  ) as CloudLaunchConfiguration;
}

/** Replace a launch's instructions and definition; Core applies them at the agent's next start. */
export async function updateCloudLaunchConfiguration(
  server: SwitchServer,
  requestId: string,
  body: Omit<CloudLaunchConfiguration, 'description'> & { definition: string }
): Promise<CloudLaunchConfiguration> {
  return cloudConfigurationSchema.parse(
    await (
      await gatewayFetch(
        server,
        `/hosted-launches/${encodeURIComponent(requestId)}/configuration`,
        { authenticated: true, method: 'PUT', body }
      )
    ).json()
  ) as CloudLaunchConfiguration;
}

export async function cloudLifecycle(
  server: SwitchServer,
  requestId: string,
  action: 'stop' | 'start' | 'restart' | 'remove' | 'retry',
  revision: number
) {
  return cloudLaunchSchema.extend({ access_warning: z.string().nullable().optional() }).parse(
    await (
      await gatewayFetch(server, `/hosted-launches/${encodeURIComponent(requestId)}/lifecycle`, {
        authenticated: true,
        method: 'POST',
        body: { action, revision },
      })
    ).json()
  );
}

export async function cloudMachineLifecycle(
  server: SwitchServer,
  machineId: string,
  action: 'stop' | 'start' | 'retry',
  revision: number
) {
  return z.object({ machine: cloudMachineSchema }).parse(
    await (
      await gatewayFetch(server, `/hosted-machines/${encodeURIComponent(machineId)}/lifecycle`, {
        authenticated: true,
        method: 'POST',
        body: { action, revision },
      })
    ).json()
  ).machine;
}

/**
 * Claim and start the signed-in user's cloud machine so it is warm before an
 * agent needs it. Idempotent on the server. A refusal (409 none free, 503 not
 * offered) is raised with the server's own explanation.
 */
export async function ensureCloudMachine(server: SwitchServer) {
  let response: Response;
  try {
    response = await gatewayFetch(server, '/hosted-machines/ensure', {
      authenticated: true,
      method: 'POST',
    });
  } catch (error) {
    if (error instanceof GatewayError && error.detail) throw new Error(error.detail);
    throw error;
  }
  return cloudMachineSchema.parse(await response.json());
}

export async function connectClaude(
  server: SwitchServer,
  kind: ClaudeCredentialKind,
  credential: string
): Promise<ClaudeConnection> {
  if (new URL(server.gatewayUrl).protocol !== 'https:') {
    throw new GatewayError('http', 'Claude credentials require an HTTPS Switch server.');
  }
  const response = await gatewayFetch(server, '/provider-connections/claude', {
    authenticated: true,
    method: 'PUT',
    body: { kind, credential },
  });
  return readClaudeConnection(response);
}

export async function disconnectClaude(server: SwitchServer): Promise<void> {
  await gatewayFetch(server, '/provider-connections/claude', {
    authenticated: true,
    method: 'DELETE',
  });
}

/**
 * The services the signed-in person can connect, and their connection to
 * each: from `/service-connections`, or the older catalog a server from
 * before service connections answers instead.
 */
export async function getConnectionCatalog(
  server: SwitchServer
): Promise<ConnectionCatalogEntry[]> {
  let response: Response;
  try {
    response = await gatewayFetch(server, '/service-connections', { authenticated: true });
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return getOlderCatalog(server);
    throw error;
  }
  return serviceConnectionsSchema.parse(await response.json()).connections.map((entry) => ({
    slug: entry.slug,
    name: entry.name,
    category: entry.category,
    description: entry.description,
    enabled: entry.enabled,
    auth_type: entry.auth_type,
    connectable: entry.connectable,
    status: !entry.enabled ? 'coming_soon' : entry.status === 'active' ? 'connected' : entry.status,
    unavailable_reason: entry.enabled ? entry.unavailable_reason : null,
    pass_through: entry.pass_through,
    token_lifetime: entry.token_lifetime,
    loopback_ports: entry.loopback_ports,
  }));
}

async function getOlderCatalog(server: SwitchServer): Promise<ConnectionCatalogEntry[]> {
  const response = await gatewayFetch(server, '/provider-connections/catalog', {
    authenticated: true,
  });
  return (
    connectionCatalogSchema
      .parse(await response.json())
      // GitHub was the one service such a server could connect.
      .connections.map((entry) => ({
        ...entry,
        connectable: entry.enabled && entry.slug === 'github',
        unavailable_reason: null,
        pass_through: false,
        token_lifetime: null,
        loopback_ports: null,
      }))
  );
}

/**
 * Whether the server has service connections, which any of its agents can be
 * granted: an older one had connections for its cloud agents alone.
 */
export async function servesServiceConnections(server: SwitchServer): Promise<boolean> {
  try {
    await gatewayFetch(server, '/service-connections', { authenticated: true });
    return true;
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return false;
    throw error;
  }
}

/**
 * An agent's service grants, with any it works without, or null when the
 * gateway answers that it is not the signed-in person's agent (a 404): only
 * its owner sees them. Any other failure is thrown, for the caller to show.
 */
export async function fetchServiceGrants(
  server: SwitchServer,
  agentId: string
): Promise<ServiceGrants | null> {
  let response: Response;
  try {
    response = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}/service-grants`, {
      authenticated: true,
    });
  } catch (cause) {
    if (cause instanceof GatewayError && cause.status === 404) return null;
    throw cause;
  }
  return serviceGrantsSchema.parse(await response.json());
}

/** Create or replace an agent's grant; the warning names access that stays usable a while. */
export async function setServiceGrant(
  server: SwitchServer,
  agentId: string,
  service: string,
  grant: { access: 'read' | 'write' | null; resources: Record<string, unknown> }
): Promise<string | null> {
  // An on/off grant names no level: Switch gives it the connection's.
  const body = grant.access === null ? { resources: grant.resources } : grant;
  const response = await gatewayFetch(
    server,
    `/agents/${encodeURIComponent(agentId)}/service-grants/${encodeURIComponent(service)}`,
    { authenticated: true, method: 'PUT', body }
  );
  return serviceGrantWarningSchema.parse(await response.json()).warning;
}

export async function removeServiceGrant(
  server: SwitchServer,
  agentId: string,
  service: string
): Promise<string | null> {
  const response = await gatewayFetch(
    server,
    `/agents/${encodeURIComponent(agentId)}/service-grants/${encodeURIComponent(service)}`,
    { authenticated: true, method: 'DELETE' }
  );
  return serviceGrantWarningSchema.parse(await response.json()).warning;
}
export async function getGitHubConnection(server: SwitchServer) {
  return gitHubConnectionSchema.parse(
    await (
      await gatewayFetch(server, '/provider-connections/github', { authenticated: true })
    ).json()
  );
}
export async function startGitHubConnection(
  server: SwitchServer,
  input: { port: number; state: string; completion_secret: string }
) {
  if (new URL(server.gatewayUrl).protocol !== 'https:')
    throw new Error('GitHub connections require HTTPS.');
  const value = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{43}$/), url: z.string() }).parse(
    await (
      await gatewayFetch(server, '/provider-connections/github/flows', {
        authenticated: true,
        method: 'POST',
        body: input,
      })
    ).json()
  );
  const url = new URL(value.url);
  if (
    url.origin !== new URL(server.gatewayUrl).origin ||
    url.pathname !== '/gateway/provider-connections/github/authorize' ||
    url.searchParams.get('state') !== value.id ||
    url.username ||
    url.password
  )
    throw new Error('The server returned an invalid GitHub authorization URL.');
  return value;
}
export async function getGitHubFlow(server: SwitchServer, id: string) {
  return gitHubFlowSchema.parse(
    await (
      await gatewayFetch(server, `/provider-connections/github/flows/${encodeURIComponent(id)}`, {
        authenticated: true,
      })
    ).json()
  );
}
export async function confirmGitHubConnection(
  server: SwitchServer,
  id: string,
  completionSecret: string
) {
  const response = await gatewayFetch(
    server,
    `/provider-connections/github/flows/${encodeURIComponent(id)}/confirm`,
    {
      authenticated: true,
      method: 'POST',
      body: { completion_secret: completionSecret },
    }
  );
  if (response.status === 204) return { warning: null };
  return z.object({ warning: z.string().nullable() }).parse(await response.json());
}
export async function completeGitHubConnection(
  server: SwitchServer,
  id: string,
  code: string,
  completionSecret: string
) {
  await gatewayFetch(
    server,
    `/provider-connections/github/flows/${encodeURIComponent(id)}/complete`,
    {
      authenticated: true,
      method: 'POST',
      body: { code, completion_secret: completionSecret },
    }
  );
}
export async function cancelGitHubConnection(server: SwitchServer, id: string) {
  await gatewayFetch(server, `/provider-connections/github/flows/${encodeURIComponent(id)}`, {
    authenticated: true,
    method: 'DELETE',
  });
}
export async function disconnectGitHub(server: SwitchServer) {
  const response = await gatewayFetch(server, '/provider-connections/github', {
    authenticated: true,
    method: 'DELETE',
  });
  if (response.status === 204) return { warning: null };
  return z.object({ warning: z.string().nullable() }).parse(await response.json());
}

const serviceFlows = (service: string) =>
  `/service-connections/${encodeURIComponent(service)}/flows`;

/**
 * Begin signing in to `service` through Switch's generic OAuth flow. The URL
 * the browser is sent to is checked: Core's own authorize step on this server,
 * or the vendor's page returning to this Console's listener with this state.
 */
export async function startServiceConnection(
  server: SwitchServer,
  service: string,
  input: { port: number; state: string; completion_secret: string }
): Promise<ServiceFlowStart> {
  if (new URL(server.gatewayUrl).protocol !== 'https:')
    throw new Error('Service connections require HTTPS.');
  const value = serviceFlowStartSchema.parse(
    await (
      await gatewayFetch(server, serviceFlows(service), {
        authenticated: true,
        method: 'POST',
        body: input,
      })
    ).json()
  );
  const url = new URL(value.url);
  const valid =
    value.id === input.state &&
    !url.username &&
    !url.password &&
    (value.mode === 'core'
      ? url.origin === new URL(server.gatewayUrl).origin &&
        url.pathname === `/gateway${serviceFlows(service)}/authorize` &&
        url.searchParams.get('state') === value.id
      : url.protocol === 'https:' &&
        url.searchParams.get('state') === value.id &&
        url.searchParams.get('redirect_uri') ===
          `http://127.0.0.1:${input.port}${SERVICE_CALLBACK_PATH}`);
  if (!valid) throw new Error('The server returned an invalid sign-in URL.');
  return value;
}
export async function getServiceFlow(server: SwitchServer, service: string, id: string) {
  return serviceFlowSchema.parse(
    await (
      await gatewayFetch(server, `${serviceFlows(service)}/${encodeURIComponent(id)}`, {
        authenticated: true,
      })
    ).json()
  );
}
export async function completeServiceConnection(
  server: SwitchServer,
  service: string,
  id: string,
  code: string,
  completionSecret: string
) {
  await gatewayFetch(server, `${serviceFlows(service)}/${encodeURIComponent(id)}/complete`, {
    authenticated: true,
    method: 'POST',
    body: { code, completion_secret: completionSecret },
  });
}
export async function confirmServiceConnection(
  server: SwitchServer,
  service: string,
  id: string,
  completionSecret: string
) {
  const response = await gatewayFetch(
    server,
    `${serviceFlows(service)}/${encodeURIComponent(id)}/confirm`,
    { authenticated: true, method: 'POST', body: { completion_secret: completionSecret } }
  );
  return z.object({ warning: z.string().nullable() }).parse(await response.json());
}
export async function cancelServiceConnection(server: SwitchServer, service: string, id: string) {
  await gatewayFetch(server, `${serviceFlows(service)}/${encodeURIComponent(id)}`, {
    authenticated: true,
    method: 'DELETE',
  });
}
/** Disconnect `service`: its grants go with it, and what was issued is revoked. */
export async function disconnectService(server: SwitchServer, service: string) {
  const response = await gatewayFetch(
    server,
    `/service-connections/${encodeURIComponent(service)}`,
    { authenticated: true, method: 'DELETE' }
  );
  return z.object({ warning: z.string().nullable() }).parse(await response.json());
}

export async function getCloudProviderConnection(server: SwitchServer, provider: AgentProviderId) {
  return cloudProviderConnectionSchema.parse(
    await (
      await gatewayFetch(server, `/provider-connections/${encodeURIComponent(provider)}`, {
        authenticated: true,
      })
    ).json()
  );
}
export async function connectCloudProvider(
  server: SwitchServer,
  provider: Exclude<AgentProviderId, 'claude'>,
  kind: 'api-key' | 'auth-json',
  credential: string
) {
  if (new URL(server.gatewayUrl).protocol !== 'https:')
    throw new Error('Provider credentials require HTTPS.');
  return cloudProviderConnectionSchema.parse(
    await (
      await gatewayFetch(server, `/provider-connections/${encodeURIComponent(provider)}`, {
        authenticated: true,
        method: 'PUT',
        body: { kind, credential },
      })
    ).json()
  );
}
export async function disconnectCloudProvider(
  server: SwitchServer,
  provider: Exclude<AgentProviderId, 'claude'>
) {
  await gatewayFetch(server, `/provider-connections/${encodeURIComponent(provider)}`, {
    authenticated: true,
    method: 'DELETE',
  });
}

// ── Agent management: controllers and the agents placed on them ─────────────

/**
 * The server does not run agent management: its `/gateway/management` routes
 * are not mounted (`AGENT_MANAGEMENT_ENABLED` is off), so they answer a bare
 * 404 rather than one in the management error envelope.
 */
export class AgentManagementUnavailableError extends Error {
  constructor(server: SwitchServer) {
    super(`${server.name} does not have agent management turned on.`);
    this.name = 'AgentManagementUnavailableError';
  }
}

type ManagementErrorEnvelope = { error: { code: string; message: string } };

function managementEnvelope(body: string | undefined): ManagementErrorEnvelope['error'] | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Partial<ManagementErrorEnvelope>;
    const error = parsed.error;
    return error && typeof error.code === 'string' && typeof error.message === 'string'
      ? { code: error.code, message: error.message }
      : null;
  } catch {
    return null;
  }
}

/** The management reason code a failed call carried, or null when it carried none. */
export function managementErrorCode(error: unknown): string | null {
  return error instanceof GatewayError ? (managementEnvelope(error.body)?.code ?? null) : null;
}

/** A failed management call, said the way the server explained it where it did. */
export function managementErrorMessage(error: unknown): string {
  if (error instanceof GatewayError) {
    const envelope = managementEnvelope(error.body);
    if (envelope) return envelope.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function managementFetch(
  server: SwitchServer,
  path: string,
  options: FetchOptions
): Promise<Response> {
  try {
    return await gatewayFetch(server, `/management${path}`, options);
  } catch (error) {
    if (
      error instanceof GatewayError &&
      error.status === 404 &&
      managementEnvelope(error.body) === null
    )
      throw new AgentManagementUnavailableError(server);
    throw error;
  }
}

export type ControllerPlatform = { os: string; arch: string; os_version: string };

/** A controller as the owner's list shows it. */
export type ManagementController = {
  id: string;
  name: string;
  /** What its owner says the machine is for; null when none was given. */
  description: string | null;
  kind: string;
  state: 'online' | 'unknown' | 'revoked';
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** Each provider as the controller last reported it; empty before it has reported. */
  providers: ControllerProviderReport[];
  /**
   * The absolute directory the controller makes agents' workspaces in, as it
   * last reported; null before it has, or when it or the server predates it.
   */
  workspacesDir: string | null;
};

/** A provider as a controller reports it: installed, and whether its login works. */
export type ControllerProviderReport = {
  /** The Switch definition provider id (`claude`, `codex`, …). */
  provider: string;
  installed: boolean;
  auth: 'ok' | 'expired' | 'missing' | 'unknown';
};

/** A managed agent as the owner's list shows it. */
export type ManagedAgent = {
  agentId: string;
  name: string;
  displayName: string | null;
  iconUrl: string | null;
  description: string;
  controllerId: string | null;
  desiredState: 'running' | 'stopped';
  revision: number;
  provider: string;
  model: string | null;
  /** The provider's advanced configuration, keyed by its field keys; unset fields are absent. */
  advancedConfig: Record<string, AdvancedConfigValue>;
  instructions: string;
  isolation: 'shared' | 'isolated';
  /**
   * The working directory on its machine. The server fills in the machine's
   * workspace for the agent; null only when the machine has not said where that is.
   */
  directory: string | null;
  autoApprove: boolean;
  status: {
    process: string;
    attached: boolean;
    reason: string | null;
    detail: string | null;
    /** The absolute working directory it runs in; null until the machine resolved one. */
    directory: string | null;
  } | null;
};

type ManagementControllerJson = {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  state: 'online' | 'unknown' | 'revoked';
  last_seen_at: string | null;
  revoked_at: string | null;
  status?: unknown;
  workspaces_dir?: string | null;
};

type ManagedAgentJson = {
  agent_id: string;
  name: string;
  display_name: string | null;
  icon_url?: string | null;
  controller_id: string | null;
  desired_state: 'running' | 'stopped';
  description?: string;
  revision?: number;
  definition: {
    provider?: unknown;
    model?: unknown;
    advanced_config?: unknown;
    instructions?: unknown;
    directory?: unknown;
    auto_approve?: unknown;
    isolation?: unknown;
  } | null;
  status: {
    process: string;
    attached: boolean;
    reason?: string | null;
    detail?: string | null;
    directory?: string | null;
  } | null;
};

/**
 * Enroll this Console as a controller of kind `console`, owned by the
 * signed-in user (`POST /gateway/management/controllers`). The credential is a
 * secret: keep it in the main process and in the encrypted secrets store.
 */
export async function enrollConsoleController(
  server: SwitchServer,
  body: { name: string; platform: ControllerPlatform; version: string }
): Promise<{ controllerId: string; credential: string }> {
  const res = await managementFetch(server, '/controllers', {
    authenticated: true,
    method: 'POST',
    body: { name: body.name, kind: 'console', platform: body.platform, version: body.version },
  });
  const json = (await res.json()) as { controller_id: string; credential: string };
  return { controllerId: json.controller_id, credential: json.credential };
}

/**
 * A one-time code a headless controller enrolls with
 * (`POST /gateway/management/enrollment-codes`): single use, valid for ten
 * minutes. A secret until it is spent.
 */
export async function issueEnrollmentCode(server: SwitchServer): Promise<string> {
  const res = await managementFetch(server, '/enrollment-codes', {
    authenticated: true,
    method: 'POST',
  });
  return ((await res.json()) as { code: string }).code;
}

/** The signed-in user's controllers (`GET /gateway/management/controllers`). */
export async function fetchManagementControllers(
  server: SwitchServer
): Promise<ManagementController[]> {
  const res = await managementFetch(server, '/controllers', { authenticated: true });
  return ((await res.json()) as ManagementControllerJson[]).map((json) => ({
    id: json.id,
    name: json.name,
    description: json.description ?? null,
    kind: json.kind,
    state: json.state,
    lastSeenAt: json.last_seen_at,
    revokedAt: json.revoked_at,
    providers: providerReports(json.status),
    workspacesDir: json.workspaces_dir ?? null,
  }));
}

const PROVIDER_AUTH_STATES: readonly ControllerProviderReport['auth'][] = [
  'ok',
  'expired',
  'missing',
  'unknown',
];

/**
 * The providers in a controller's last status report. An entry that does not
 * say which provider it is, or whether it is installed, is left out; a login
 * state this build does not know reads as `unknown`, never as working.
 */
function providerReports(status: unknown): ControllerProviderReport[] {
  if (!status || typeof status !== 'object') return [];
  const providers = (status as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return [];
  return providers.flatMap((entry: unknown): ControllerProviderReport[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { provider, installed, auth } = entry as Record<string, unknown>;
    if (typeof provider !== 'string' || typeof installed !== 'boolean') return [];
    const known = PROVIDER_AUTH_STATES.find((state) => state === auth);
    return [{ provider, installed, auth: known ?? 'unknown' }];
  });
}

export type { AdvancedConfigValue };

const advancedConfigSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
);

/**
 * A definition's advanced configuration as the server holds it. Absent reads
 * as none set; a value of a shape no field takes is refused rather than
 * dropped, since saving the definition back would lose it.
 */
function advancedConfigOf(agentId: string, value: unknown): Record<string, AdvancedConfigValue> {
  if (value === undefined || value === null) return {};
  const parsed = advancedConfigSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `The server sent an advanced configuration for managed agent ${agentId} that Console cannot read: ${parsed.error.message}`
  );
}

function toManagedAgent(json: ManagedAgentJson): ManagedAgent {
  return {
    agentId: json.agent_id,
    name: json.name,
    displayName: json.display_name,
    iconUrl: json.icon_url ?? null,
    description: json.description ?? '',
    controllerId: json.controller_id,
    desiredState: json.desired_state,
    revision: json.revision ?? 0,
    provider: typeof json.definition?.provider === 'string' ? json.definition.provider : 'unknown',
    model: typeof json.definition?.model === 'string' ? json.definition.model : null,
    advancedConfig: advancedConfigOf(json.agent_id, json.definition?.advanced_config),
    instructions:
      typeof json.definition?.instructions === 'string' ? json.definition.instructions : '',
    isolation: json.definition?.isolation === 'isolated' ? 'isolated' : 'shared',
    directory: typeof json.definition?.directory === 'string' ? json.definition.directory : null,
    autoApprove: json.definition?.auto_approve === true,
    status: json.status
      ? {
          process: json.status.process,
          attached: json.status.attached,
          reason: json.status.reason ?? null,
          detail: json.status.detail ?? null,
          directory: json.status.directory ?? null,
        }
      : null,
  };
}

/** The signed-in user's managed agents (`GET /gateway/management/agents`). */
export async function fetchManagedAgents(server: SwitchServer): Promise<ManagedAgent[]> {
  const res = await managementFetch(server, '/agents', { authenticated: true });
  return ((await res.json()) as ManagedAgentJson[]).map(toManagedAgent);
}

/** One managed agent (`GET /gateway/management/agents/{id}`), or null when it is not managed. */
export async function fetchManagedAgent(
  server: SwitchServer,
  agentId: string
): Promise<ManagedAgent | null> {
  try {
    const res = await managementFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
      authenticated: true,
    });
    return toManagedAgent((await res.json()) as ManagedAgentJson);
  } catch (error) {
    if (managementErrorCode(error) === 'not_found') return null;
    throw error;
  }
}

/**
 * Change a managed agent's settings (`PATCH /gateway/management/agents/{id}`):
 * the definition fields given replace those on the server, the rest stay as the
 * server holds them, including fields this build does not know. Switch checks
 * the result against its machine and refuses it whole.
 */
export async function updateManagedAgent(
  server: SwitchServer,
  agentId: string,
  changes: {
    definition: Record<string, unknown> | null;
    /** Absent leaves the machine as it is. */
    controllerId?: string;
  }
): Promise<void> {
  const path = `/agents/${encodeURIComponent(agentId)}`;
  const body: Record<string, unknown> = {};
  if (changes.definition !== null) {
    const res = await managementFetch(server, path, { authenticated: true });
    const current = ((await res.json()) as { definition: Record<string, unknown> | null })
      .definition;
    if (!current) throw new Error(`The server holds no definition for managed agent ${agentId}.`);
    body.definition = { ...current, ...changes.definition };
  }
  if (changes.controllerId !== undefined) body.controller_id = changes.controllerId;
  if (Object.keys(body).length === 0) return;
  await managementFetch(server, path, { authenticated: true, method: 'PATCH', body });
}

const advancedConfigFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  type: z.enum(['text', 'textarea', 'select', 'list', 'number', 'boolean']),
  help: z.string().nullable(),
  placeholder: z.string().nullable(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).nullable(),
  catalogue: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('model') }),
      z.object({ kind: z.literal('model-variant'), model_field: z.string().min(1) }),
    ])
    .nullable(),
});

const advancedConfigSchemaResponse = z.object({
  providers: z.record(z.string(), z.object({ fields: z.array(advancedConfigFieldSchema) })),
});

/**
 * Each provider's advanced configuration fields, keyed by provider
 * (`GET /gateway/management/advanced-config`): what a managed agent's
 * `advanced_config` is checked against.
 */
export async function fetchAdvancedConfigSchema(
  server: SwitchServer
): Promise<Record<string, AdvancedConfigField[]>> {
  const res = await managementFetch(server, '/advanced-config', { authenticated: true });
  const { providers } = advancedConfigSchemaResponse.parse(await res.json());
  return Object.fromEntries(
    Object.entries(providers).map(([provider, { fields }]) => [
      provider,
      fields.map(
        (field): AdvancedConfigField => ({
          key: field.key,
          label: field.label,
          type: field.type,
          ...(field.help !== null ? { help: field.help } : {}),
          ...(field.placeholder !== null ? { placeholder: field.placeholder } : {}),
          ...(field.options !== null ? { options: field.options } : {}),
          ...(field.catalogue === null
            ? {}
            : field.catalogue.kind === 'model'
              ? { catalogue: { kind: 'model' } }
              : { catalogue: { kind: 'model-variant', modelField: field.catalogue.model_field } }),
        })
      ),
    ])
  );
}

/** The v1 managed agent definition, as `PUT`/`PATCH …/management/agents/{id}` take it. */
export type ManagedAgentDefinitionBody = {
  provider: string;
  model: string | null;
  /** Keyed by the provider's advanced configuration fields; unset fields are absent. */
  advanced_config: Record<string, AdvancedConfigValue>;
  instructions: string;
  auto_approve: boolean;
  directory: string | null;
};

/**
 * Adopt an agent the signed-in user owns onto a controller, or replace its
 * definition and placement (`PUT /gateway/management/agents/{id}`).
 */
export async function putManagedAgent(
  server: SwitchServer,
  agentId: string,
  body: {
    controller_id: string | null;
    desired_state: 'running' | 'stopped';
    definition: ManagedAgentDefinitionBody;
  }
): Promise<void> {
  await managementFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
    method: 'PUT',
    body,
  });
}

/**
 * Register a new agent for the signed-in user and place it on one of their
 * controllers (`POST /gateway/management/agents`). Switch checks the placement
 * before registering anything, so a refusal leaves no agent behind. Returns the
 * new agent's Switch id.
 */
export async function createManagedAgent(
  server: SwitchServer,
  body: {
    name: string;
    description: string;
    display_name: string | null;
    /** Null for the icon the server generates from the name. */
    icon_url: string | null;
    controller_id: string;
    desired_state: 'running' | 'stopped';
    definition: ManagedAgentDefinitionBody;
  }
): Promise<string> {
  const res = await managementFetch(server, '/agents', {
    authenticated: true,
    method: 'POST',
    body,
  });
  return ((await res.json()) as ManagedAgentJson).agent_id;
}

/** Change only a managed agent's desired state (`PATCH /gateway/management/agents/{id}`). */
export async function setManagedAgentDesiredState(
  server: SwitchServer,
  agentId: string,
  desiredState: 'running' | 'stopped'
): Promise<void> {
  await managementFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
    method: 'PATCH',
    body: { desired_state: desiredState },
  });
}

/**
 * Stop managing an agent (`DELETE /gateway/management/agents/{id}`): its
 * controller stops it, and the agent itself stays. `already_gone` when it was
 * not managed.
 */
export async function deleteManagedAgent(
  server: SwitchServer,
  agentId: string
): Promise<'released' | 'already_gone'> {
  try {
    await managementFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
      authenticated: true,
      method: 'DELETE',
    });
    return 'released';
  } catch (error) {
    if (managementErrorCode(error) === 'not_found') return 'already_gone';
    throw error;
  }
}

type ApiKeyJson = { id: string; label: string; type: string };

/**
 * An agent's own API key, revealed through the owner's session
 * (`GET /gateway/api-keys`, then `…/{id}/reveal`). An agent's key is labelled
 * with the agent's name; exactly one key of type `agent` must carry it, since
 * revealing the wrong one would hand this agent another's identity.
 */
export async function revealAgentApiKey(server: SwitchServer, agentName: string): Promise<string> {
  const res = await gatewayFetch(server, '/api-keys', { authenticated: true });
  const matches = ((await res.json()) as ApiKeyJson[]).filter(
    (key) => key.type === 'agent' && key.label === agentName
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length === 0
        ? `Switch lists no API key for agent ${agentName} that you can reveal.`
        : `Switch lists ${matches.length} API keys labelled ${agentName}, so which one is this agent's cannot be told.`
    );
  const revealed = await gatewayFetch(
    server,
    `/api-keys/${encodeURIComponent(matches[0]!.id)}/reveal`,
    {
      authenticated: true,
    }
  );
  return ((await revealed.json()) as { key: string }).key;
}

/**
 * Rename a controller and/or change its description
 * (`PATCH /gateway/management/controllers/{id}`). A key left out is left as it
 * is; `description: null` clears it.
 */
export async function updateManagementController(
  server: SwitchServer,
  controllerId: string,
  changes: { name?: string; description?: string | null }
): Promise<void> {
  await managementFetch(server, `/controllers/${encodeURIComponent(controllerId)}`, {
    authenticated: true,
    method: 'PATCH',
    body: changes,
  });
}

/**
 * Revoke a controller (`DELETE /gateway/management/controllers/{id}`): the
 * server deletes its credential and tells it so on its stream.
 */
export async function revokeManagementController(
  server: SwitchServer,
  controllerId: string
): Promise<void> {
  await managementFetch(server, `/controllers/${encodeURIComponent(controllerId)}`, {
    authenticated: true,
    method: 'DELETE',
  });
}
