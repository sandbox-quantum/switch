import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import { ConfigurationError } from './errors';
import type { Logger } from './log';
import {
  type AgentCursor,
  type Assignment,
  assignmentSchema,
  type ControllerConnection,
  controllerBeatResponseSchema,
  controllerConnectionResponseSchema,
  credentialRotateResponseSchema,
  type EnrollRequest,
  type EnrollResponse,
  enrollResponseSchema,
  errorEnvelopeSchema,
  type Operation,
  operationListSchema,
  type OperationResult,
  operationSchema,
  PROTOCOL_VERSION,
  type Provider,
  repositoryCredentialSchema,
  type StatusReport,
  type StatusResponse,
  statusResponseSchema,
  type TokenResponse,
  tokenResponseSchema,
} from './schemas';

export const PROTOCOL_HEADER = 'Switch-Controller-Protocol';
/** What this controller declares itself as when it opens the controller stream. */
export const CONTROLLER_CLIENT = 'switch-agent-controller';

export type Fetch = typeof fetch;

export const HOST_INSTANCE_HEADER = 'X-Switch-Host-Instance-Id';
export const HOST_BOOT_HEADER = 'X-Switch-Host-Boot-Id';

/**
 * A fetch that names the cloud instance and boot it runs on in every request,
 * which the server requires before it exchanges a cloud controller's
 * credential for a token.
 */
export function withHostIdentity(
  fetchImpl: Fetch,
  host: { instanceId: string; bootId: string }
): Fetch {
  return (input, init) => {
    const merged = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => merged.set(name, value));
    merged.set(HOST_INSTANCE_HEADER, host.instanceId);
    merged.set(HOST_BOOT_HEADER, host.bootId);
    return fetchImpl(input, { ...init, headers: merged });
  };
}

/**
 * A refusal from the server, read from its `{"error": {code, message,
 * retryable}}` envelope. A response without one is still an error: it gets a
 * code describing what came back instead.
 */
export class ControllerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterS: number | null
  ) {
    super(message);
    this.name = 'ControllerApiError';
  }
}

export function isRevoked(error: unknown): boolean {
  return error instanceof ControllerApiError && error.code === 'controller_revoked';
}

/** Another instance of this controller took its stream connection over: terminal for this one. */
export function isTakenOver(error: unknown): boolean {
  return error instanceof ControllerApiError && error.code === 'taken_over';
}

/**
 * The agent bridge URL as given to `enroll`, checked and without a trailing
 * slash. The controller's relay forwards every agent's calls to it with the
 * controller's own token, so it gets the rule the session host applies to
 * its endpoint: HTTPS, or plain HTTP to a loopback server only.
 */
export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(
      `'${raw}' is not a URL. Pass the Switch agent bridge URL, e.g. https://switch.example.com.`
    );
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new ConfigurationError(
      `The server URL must use https (plain http is accepted only for a loopback server): ${raw}`
    );
  if (url.username || url.password || url.search || url.hash)
    throw new ConfigurationError(
      'The server URL must not contain credentials, a query or a fragment.'
    );
  return url.href.replace(/\/+$/, '');
}

async function failure(response: Response): Promise<ControllerApiError> {
  const text = await response.text().catch(() => '');
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const envelope = errorEnvelopeSchema.safeParse(body);
  if (envelope.success) {
    const { code, message, retryable, retry_after_s } = envelope.data.error;
    return new ControllerApiError(response.status, code, message, retryable, retry_after_s ?? null);
  }
  const retryable = response.status >= 500 || response.status === 429;
  // The agent bridge's own refusals: `{"detail": {code, message}}`, as its
  // connection routes answer.
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'object' && detail !== null) {
    const { code, message } = detail as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && code)
      return new ControllerApiError(
        response.status,
        code,
        typeof message === 'string' ? message : text.slice(0, 300),
        retryable,
        null
      );
  }
  return new ControllerApiError(
    response.status,
    retryable ? 'internal' : 'unexpected_response',
    `HTTP ${response.status} without an error envelope${text ? `: ${text.slice(0, 300)}` : ''}`,
    retryable,
    null
  );
}

async function parsed<S extends z.ZodType>(response: Response, schema: S): Promise<z.infer<S>> {
  const body: unknown = await response.json();
  const result = schema.safeParse(body);
  if (!result.success)
    throw new ControllerApiError(
      response.status,
      'invalid_response',
      `The server's response to ${response.url || 'a request'} does not match the controller protocol: ${result.error.message}`,
      false,
      null
    );
  return result.data;
}

function headers(extra: Record<string, string>): Record<string, string> {
  return {
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    Accept: 'application/json',
    ...extra,
  };
}

/** Public: authenticates through the enrollment code in the body. */
export async function enroll(
  fetchImpl: Fetch,
  server: string,
  body: EnrollRequest
): Promise<EnrollResponse> {
  const response = await fetchImpl(`${server}/v1/management/controllers/enroll`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await failure(response);
    // Every Switch refusal on this route has an envelope. A bare 404 is a
    // server with no such route at all: most often the gateway's own page
    // address, which serves the dashboard and not the agent API.
    if (response.status === 404 && error.code === 'unexpected_response')
      throw new ControllerApiError(
        404,
        'not_switch_api',
        `${server} has no enrollment route (HTTP 404 without a Switch error), so it is probably not the Switch API URL. Use the address the Switch API is reached on (the server's GATEWAY_PUBLIC_URL, shown in the gateway's Add machine dialog), not the gateway page's address.`,
        false,
        null
      );
    throw error;
  }
  return parsed(response, enrollResponseSchema);
}

/** Public: authenticates through the credential in the body. */
export async function exchangeToken(
  fetchImpl: Fetch,
  server: string,
  controllerId: string,
  credential: string
): Promise<TokenResponse> {
  const response = await fetchImpl(
    `${server}/v1/management/controllers/${encodeURIComponent(controllerId)}/token`,
    {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ credential }),
    }
  );
  if (!response.ok) throw await failure(response);
  return parsed(response, tokenResponseSchema);
}

/** The shortest lifetime a token is treated as having, so a skewed clock cannot spin. */
const MIN_LIFETIME_MS = 30_000;

const MISMATCH_FIRST_WAIT_MS = 1_000;
const MISMATCH_MAX_WAIT_MS = 30_000;

/**
 * The server does not yet (or no longer) know this instance as the machine's:
 * it is still starting, or was replaced. Waiting is the only answer, and
 * running agents meanwhile could duplicate the replacement's.
 */
export function isInstanceMismatch(error: unknown): boolean {
  return error instanceof ControllerApiError && error.code === 'instance_mismatch';
}

/**
 * The controller's access token: exchanged from the credential on first use,
 * and again once 80% of its lifetime has passed or when the server refuses it.
 * Concurrent callers share one exchange.
 */
export class AccessTokens {
  private current: { token: string; refreshAt: number } | null = null;
  private exchanging: Promise<string> | null = null;

  constructor(
    private readonly deps: {
      fetch: Fetch;
      server: string;
      controllerId: string;
      credential: () => Promise<string>;
      now: () => number;
      log: Logger;
    }
  ) {}

  async get(): Promise<string> {
    if (this.current && this.deps.now() < this.current.refreshAt) return this.current.token;
    this.exchanging ??= this.exchange().finally(() => {
      this.exchanging = null;
    });
    return this.exchanging;
  }

  /** Drops the token the server just refused, so the next `get` exchanges again. */
  invalidate(token: string): void {
    if (this.current?.token === token) this.current = null;
  }

  private async exchange(): Promise<string> {
    const credential = await this.deps.credential();
    let issuedAt = this.deps.now();
    let response: TokenResponse;
    for (let wait = MISMATCH_FIRST_WAIT_MS; ; wait = Math.min(wait * 2, MISMATCH_MAX_WAIT_MS)) {
      issuedAt = this.deps.now();
      try {
        response = await exchangeToken(
          this.deps.fetch,
          this.deps.server,
          this.deps.controllerId,
          credential
        );
        break;
      } catch (error) {
        if (!isInstanceMismatch(error)) throw error;
        const retryAfter = (error as ControllerApiError).retryAfterS;
        const waitMs =
          retryAfter === null ? wait : Math.min(retryAfter * 1000, MISMATCH_MAX_WAIT_MS);
        this.deps.log.warn(
          'The server does not recognise this instance as the machine’s yet; retrying the token exchange.',
          { waitMs, message: (error as ControllerApiError).message }
        );
        await delay(waitMs);
      }
    }
    const expiresAt = Date.parse(response.expires_at);
    if (Number.isNaN(expiresAt))
      throw new ControllerApiError(
        200,
        'invalid_response',
        `The token's expires_at '${response.expires_at}' is not a time.`,
        false,
        null
      );
    let lifetime = expiresAt - issuedAt;
    if (lifetime < MIN_LIFETIME_MS) {
      this.deps.log.warn(
        'The access token expires sooner than expected; check this machine’s clock. Refreshing it every 30 s meanwhile.',
        { expiresAt: response.expires_at, localTime: new Date(issuedAt).toISOString() }
      );
      lifetime = MIN_LIFETIME_MS;
    }
    this.current = { token: response.access_token, refreshAt: issuedAt + lifetime * 0.8 };
    return response.access_token;
  }
}

export type AssignmentPull =
  | { kind: 'unchanged' }
  | { kind: 'changed'; assignment: Assignment; etag: string | null };

/** The routes a controller calls with its access token. */
export class ControllerClient {
  constructor(
    private readonly deps: {
      fetch: Fetch;
      server: string;
      controllerId: string;
      /** This controller's version, declared when the stream connection opens. */
      version: string;
      tokens: AccessTokens;
    }
  ) {}

  private get base(): string {
    return `${this.deps.server}/v1/management`;
  }

  private get controllerPath(): string {
    return `${this.base}/controllers/${encodeURIComponent(this.deps.controllerId)}`;
  }

  /**
   * One authenticated request. A 401 other than `controller_revoked` means the
   * token went stale early (a server restart with a new secret, a clock jump),
   * so the credential is exchanged once more and the request retried once.
   */
  async request(
    url: string,
    init: {
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
    accept: (status: number) => boolean = (status) => status >= 200 && status < 300
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.deps.tokens.get();
      const response = await this.deps.fetch(url, {
        method: init.method,
        headers: headers({
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        }),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
      });
      if (accept(response.status)) return response;
      const error = await failure(response);
      if (response.status === 401 && error.code !== 'controller_revoked' && attempt === 0) {
        this.deps.tokens.invalidate(token);
        continue;
      }
      throw error;
    }
  }

  async rotateCredential(): Promise<string> {
    const response = await this.request(`${this.controllerPath}/credential/rotate`, {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
    });
    return (await parsed(response, credentialRotateResponseSchema)).credential;
  }

  async assignment(etag: string | null): Promise<AssignmentPull> {
    const response = await this.request(
      `${this.controllerPath}/assignment`,
      { method: 'GET', headers: etag ? { 'If-None-Match': etag } : {} },
      (status) => status === 200 || status === 304
    );
    if (response.status === 304) return { kind: 'unchanged' };
    return {
      kind: 'changed',
      etag: response.headers.get('ETag'),
      assignment: await parsed(response, assignmentSchema),
    };
  }

  /**
   * The `owner/name` of the repository an agent on this controller works in,
   * as Core answers it while issuing the agent's repository token (the token
   * is not kept: the agent's unit asks for its own).
   */
  async repositoryName(agentId: string): Promise<string> {
    const response = await this.request(`${this.deps.server}/hosted/github-credential`, {
      method: 'POST',
      headers: { 'X-Switch-Agent-Id': agentId, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
    });
    return (await parsed(response, repositoryCredentialSchema)).repository;
  }

  /** The sealed login envelope for a provider, or null when the owner has none. */
  async providerCredential(provider: Provider): Promise<unknown> {
    const response = await this.request(
      `${this.controllerPath}/provider-credentials/${encodeURIComponent(provider)}`,
      { method: 'GET' },
      (status) => status === 200 || status === 404
    );
    if (response.status === 404) {
      const error = await failure(response);
      if (error.code === 'unexpected_response')
        throw new ControllerApiError(
          404,
          'not_supported',
          'The server has no provider-credentials route; it cannot serve sealed logins.',
          false,
          null
        );
      return null;
    }
    return response.json();
  }

  async putStatus(report: StatusReport): Promise<StatusResponse> {
    const response = await this.request(`${this.controllerPath}/status`, {
      method: 'PUT',
      body: report,
    });
    return parsed(response, statusResponseSchema);
  }

  async pendingOperations(): Promise<Operation[]> {
    const response = await this.request(`${this.controllerPath}/operations?state=pending`, {
      method: 'GET',
    });
    return (await parsed(response, operationListSchema)).operations;
  }

  async claimOperation(operationId: string): Promise<Operation> {
    const response = await this.request(
      `${this.base}/operations/${encodeURIComponent(operationId)}/claim`,
      { method: 'POST', headers: { 'Idempotency-Key': `claim-${operationId}` } }
    );
    return parsed(response, operationSchema);
  }

  async operationProgress(operationId: string, message: string): Promise<void> {
    await this.request(`${this.base}/operations/${encodeURIComponent(operationId)}/progress`, {
      method: 'POST',
      body: { message },
    });
  }

  async operationResult(operationId: string, result: OperationResult): Promise<void> {
    await this.request(`${this.base}/operations/${encodeURIComponent(operationId)}/result`, {
      method: 'POST',
      body: result,
      headers: { 'Idempotency-Key': `result-${operationId}` },
    });
  }

  private get streamPath(): string {
    return `${this.deps.server}/v1/controllers/${encodeURIComponent(this.deps.controllerId)}`;
  }

  /**
   * Opens a connection for the controller stream, resuming each agent from its
   * cursor. Opening takes over any connection this controller held before.
   */
  async openConnection(
    cursors: Record<string, AgentCursor>,
    signal: AbortSignal
  ): Promise<ControllerConnection> {
    const response = await this.request(`${this.streamPath}/connection`, {
      method: 'POST',
      body: {
        client: CONTROLLER_CLIENT,
        client_version: this.deps.version,
        cursors,
      },
      signal,
    });
    return parsed(response, controllerConnectionResponseSchema);
  }

  /**
   * Proves the connection alive, and confirms how far each agent's host has
   * read.
   */
  async beat(
    connection: { connectionId: string; generation: number },
    cursors: Record<string, number>,
    signal: AbortSignal
  ): Promise<void> {
    const response = await this.request(`${this.streamPath}/connection/beat`, {
      method: 'POST',
      body: {
        connection_id: connection.connectionId,
        generation: connection.generation,
        cursors,
      },
      signal,
    });
    await parsed(response, controllerBeatResponseSchema);
  }

  /** Attaches the controller stream to an open connection; the caller reads the body. */
  async openEvents(
    connection: { connectionId: string; generation: number },
    signal: AbortSignal
  ): Promise<Response> {
    const query = new URLSearchParams({
      connection_id: connection.connectionId,
      generation: String(connection.generation),
    });
    const response = await this.request(`${this.streamPath}/events?${query}`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!response.body)
      throw new ControllerApiError(
        response.status,
        'invalid_response',
        'The event stream opened with no body.',
        true,
        null
      );
    return response;
  }
}
