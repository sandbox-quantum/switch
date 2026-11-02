import { createHash, randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from './log';
import { proxiedUpstreamSend } from './proxy-transport';

/**
 * The provider gateway: what each managed agent's AI CLI uses as its provider
 * base URL, on a loopback port, with an opaque token minted here for each
 * agent (`swpg_…`).
 *
 * The real provider login never enters the agent's processes. The CLI sends
 * its opaque token where it would send the login; the gateway checks it,
 * swaps in the agent's real credential, and streams the call to the provider
 * and the answer back. A token works only for its own agent's login, only on
 * the routes that provider needs, and stops working the moment the login is
 * withdrawn. Nothing about a call is logged but the agent, the provider, the
 * route, the status, the size and the time: never a header value or a body.
 *
 * The same shape as the local relay (`relay.ts`), which does this for
 * Switch's own API.
 */

/** Every token the gateway mints starts with this. */
export const GATEWAY_TOKEN_PREFIX = 'swpg_';

/** `/t/<token>/<path>`: a base URL that carries the agent's token, for a CLI that sends none. */
const TOKEN_IN_PATH = /^\/t\/(swpg_[A-Za-z0-9_-]{20,})(\/.*)$/;

/** The base URL a CLI that sends no credential of its own is given. */
export function baseUrlWithToken(endpoint: string, token: string): string {
  return `${endpoint}/t/${token}`;
}

/** The provider APIs the gateway fronts. */
export type GatewayProvider = 'anthropic' | 'openai' | 'vertex';

/**
 * How one agent's calls reach its provider: where to, and the credential to
 * add. `credential` is asked on every call, so a login that refreshes (Vertex
 * access tokens) or changes is picked up without a new token for the agent.
 */
export type GatewayRoute = {
  provider: GatewayProvider;
  /**
   * The provider's API base, exactly as `upstreamFor` gives it, e.g.
   * `https://api.anthropic.com`. Anything else is refused by `mint`,
   * `register` and `update`.
   */
  upstream: string;
  /** The header to send and its value: never logged. */
  credential: () => Promise<{ header: string; value: string }>;
  /** Vertex only: the one project and region this login may call. */
  vertex?: { project: string; region: string };
};

export type GatewayLimits = {
  /** A request body larger than this is refused (413). */
  maxBodyBytes: number;
  /** Calls in flight for one agent at once; past it, 429. */
  maxConcurrentPerAgent: number;
  /** Calls one agent may start in any 60 s; past it, 429. */
  maxPerMinutePerAgent: number;
  /** An upstream call idle this long, either way, is ended. */
  idleTimeoutMs: number;
};

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = {
  maxBodyBytes: 32 * 1024 * 1024,
  maxConcurrentPerAgent: 8,
  maxPerMinutePerAgent: 240,
  idleTimeoutMs: 5 * 60 * 1000,
};

/** Sends one request upstream; replaced in tests. */
export type UpstreamSend = (
  url: URL,
  options: { method: string; headers: OutgoingHttpHeaders; timeoutMs: number }
) => Promise<{
  request: NodeJS.WritableStream & { destroy(error?: Error): void };
  response: Promise<IncomingMessage>;
}>;

export type GatewayDeps = {
  log: Logger;
  limits?: Partial<GatewayLimits>;
  send?: UpstreamSend;
  now?: () => number;
  /**
   * The box's daily call cap (`gateway-usage.ts`): counts each admitted call,
   * or returns the seconds until it resets when the day's calls are used up.
   */
  cap?: { take(): number | null };
};

/** The routes each provider's CLI needs, and nothing else. */
const ROUTES: Record<GatewayProvider, { method: string; path: RegExp; name: string }[]> = {
  anthropic: [
    { method: 'POST', path: /^\/v1\/messages$/, name: 'messages' },
    { method: 'POST', path: /^\/v1\/messages\/count_tokens$/, name: 'count_tokens' },
  ],
  openai: [
    { method: 'POST', path: /^\/v1\/responses$/, name: 'responses' },
    { method: 'POST', path: /^\/v1\/chat\/completions$/, name: 'chat_completions' },
    { method: 'GET', path: /^\/v1\/models$/, name: 'models' },
  ],
  vertex: [
    {
      method: 'POST',
      path: /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/anthropic\/models\/[^/]+:(streamRawPredict|rawPredict|countTokens)$/,
      name: 'vertex_predict',
    },
  ],
};

/** The one host each provider's calls may go to. Vertex's depends on the login's region. */
const PROVIDER_HOSTS: Record<Exclude<GatewayProvider, 'vertex'>, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
};

/** A Vertex region with its own host, e.g. `us-east5`, `europe-west1`, `northamerica-northeast1`. */
const VERTEX_REGION = /^[a-z]+-[a-z]+[0-9]+$/;

/**
 * The only upstream a provider's route may name: https, on that provider's
 * host, with no port, path or user. For Vertex, the host of the login's own
 * region, and the global host for `global`.
 */
export function upstreamFor(
  provider: GatewayProvider,
  vertex?: { project: string; region: string }
): string {
  if (provider !== 'vertex') return `https://${PROVIDER_HOSTS[provider]}`;
  if (!vertex) throw new Error('A Vertex route needs its project and region.');
  if (vertex.region === 'global') return 'https://aiplatform.googleapis.com';
  if (!VERTEX_REGION.test(vertex.region)) throw new Error('This is not a Vertex AI region.');
  return `https://${vertex.region}-aiplatform.googleapis.com`;
}

function checkRoute(route: GatewayRoute): void {
  if (route.upstream !== upstreamFor(route.provider, route.vertex))
    throw new Error(`The provider gateway sends ${route.provider} calls only to its own API host.`);
}

/**
 * The request headers passed on, for each provider: what its CLI needs for
 * the call to work, and nothing else. Everything not listed is dropped, so
 * nothing the agent sets can choose another account, organisation, project or
 * billing target (`openai-organization`, `openai-project`,
 * `x-goog-user-project`), and no credential or cookie gets through.
 */
const COMMON_REQUEST = [
  'accept',
  'accept-encoding',
  'content-length',
  'content-type',
  'user-agent',
];
const REQUEST_HEADERS: Record<GatewayProvider, ReadonlySet<string>> = {
  anthropic: new Set([...COMMON_REQUEST, 'anthropic-version', 'anthropic-beta', 'x-app']),
  openai: new Set([...COMMON_REQUEST, 'openai-beta', 'originator', 'session_id']),
  vertex: new Set([...COMMON_REQUEST, 'anthropic-version', 'anthropic-beta', 'x-app']),
};
/** The SDKs' own descriptive headers (language, version, retry count): allowed for every provider. */
const SDK_HEADER = /^x-stainless-[a-z0-9-]{1,40}$/;

/** The query parameters passed on, for each provider, with their allowed values. All else is dropped. */
const QUERY: Record<GatewayProvider, Record<string, readonly string[]>> = {
  anthropic: { beta: ['true'] },
  openai: {},
  vertex: { alt: ['sse', 'json'] },
};

/** Response headers never passed back. */
const DROPPED_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
]);

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly retryAfterS?: number
  ) {
    super(reason);
  }
}

type AgentState = {
  route: GatewayRoute;
  tokenHash: string;
  inFlight: number;
  started: number[];
  /** A probe's token only: when it stops, and the calls it has left. */
  probe?: { expiresAt: number; callsLeft: number };
};

/** How long a probe token works, and how many calls it may make. */
export const PROBE_LIFETIME_MS = 2 * 60 * 1000;
export const PROBE_MAX_CALLS = 5;
/** Probes are kept apart from agents: an agent id never starts with this. */
const PROBE_KEY = 'probe:';
const PROBE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class ProviderGateway {
  private server: Server | null = null;
  private port = 0;
  private ready = false;
  private readonly sockets = new Set<Socket>();
  private readonly agents = new Map<string, AgentState>();
  private readonly byToken = new Map<string, string>();
  private readonly limits: GatewayLimits;
  private readonly send: UpstreamSend;
  private readonly now: () => number;
  /** When each (agent, reason) refusal was last logged: once a minute, with a count. */
  private readonly refusalsSaid = new Map<string, { at: number; count: number }>();
  private refusedTotal = 0;

  constructor(private readonly deps: GatewayDeps) {
    this.limits = { ...DEFAULT_GATEWAY_LIMITS, ...deps.limits };
    this.send = deps.send ?? proxiedUpstreamSend();
    this.now = deps.now ?? Date.now;
  }

  /** Listens on 127.0.0.1, on a port the system picks. */
  async start(): Promise<number> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        // The error's kind only: its message could quote the request.
        this.deps.log.error('The provider gateway failed a request', { error: errorKind(error) });
        if (!res.headersSent) answer(res, 500, 'The provider gateway failed this request.');
        else res.destroy();
      });
    });
    server.on('upgrade', (_req, socket) => {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  /** The base URL an agent's CLI is given. */
  get endpoint(): string {
    if (!this.server) throw new Error('The provider gateway is not listening.');
    return `http://127.0.0.1:${this.port}`;
  }

  /** Unknown tokens are told to retry (503) until this is called. */
  setReady(): void {
    this.ready = true;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // -- Agents ---------------------------------------------------------------

  /**
   * Fronts `route` for the agent and returns the opaque token its CLI is given.
   * A new token replaces any the agent had.
   */
  mint(agentId: string, route: GatewayRoute): string {
    if (agentId.startsWith(PROBE_KEY)) throw new Error('A probe token comes from mintProbe.');
    checkRoute(route);
    const token = `${GATEWAY_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.forget(agentId);
    const tokenHash = hashToken(token);
    this.agents.set(agentId, { route, tokenHash, inFlight: 0, started: [] });
    this.byToken.set(tokenHash, agentId);
    return token;
  }

  /**
   * Fronts `route` for the agent with a token it already holds (read back
   * from its credentials file after a controller restart), so a running agent
   * host keeps working.
   */
  register(agentId: string, token: string, route: GatewayRoute): void {
    if (agentId.startsWith(PROBE_KEY)) throw new Error('A probe token is never registered again.');
    checkRoute(route);
    this.forget(agentId);
    const tokenHash = hashToken(token);
    this.agents.set(agentId, { route, tokenHash, inFlight: 0, started: [] });
    this.byToken.set(tokenHash, agentId);
  }

  /** The agent's login changed: later calls use `route`, with the same token. */
  update(agentId: string, route: GatewayRoute): boolean {
    checkRoute(route);
    const state = this.agents.get(agentId);
    if (!state || state.probe) return false;
    state.route = route;
    return true;
  }

  /** The login was withdrawn, or the agent left: its token stops working at once. */
  forget(agentId: string): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    this.byToken.delete(state.tokenHash);
    this.agents.delete(agentId);
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /** For the machine report: agents fronted now, and calls refused since start. */
  counts(): { agents: number; refused: number } {
    let agents = 0;
    for (const state of this.agents.values()) if (!state.probe) agents += 1;
    return { agents, refused: this.refusedTotal };
  }

  // -- Probes ---------------------------------------------------------------

  /**
   * A token for one provider probe (the test prompt run when a login is
   * checked): it works for `PROBE_LIFETIME_MS`, for at most `PROBE_MAX_CALLS`
   * calls, on `route`'s provider routes only, and is never renewed. Call
   * `forgetProbe` when the probe ends; an expired or used-up probe also
   * stops by itself.
   */
  mintProbe(probeId: string, route: GatewayRoute): string {
    if (!PROBE_ID.test(probeId)) throw new Error('A probe id is 1 to 64 letters, digits, - or _.');
    checkRoute(route);
    this.sweepProbes();
    const key = `${PROBE_KEY}${probeId}`;
    if (this.agents.has(key)) throw new Error('This probe already has a token.');
    const token = `${GATEWAY_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const tokenHash = hashToken(token);
    this.agents.set(key, {
      route,
      tokenHash,
      inFlight: 0,
      started: [],
      probe: { expiresAt: this.now() + PROBE_LIFETIME_MS, callsLeft: PROBE_MAX_CALLS },
    });
    this.byToken.set(tokenHash, key);
    return token;
  }

  /** The probe ended: its token stops working at once. */
  forgetProbe(probeId: string): void {
    this.forget(`${PROBE_KEY}${probeId}`);
  }

  /** Probes still holding a token, expired ones dropped first. */
  probes(): number {
    this.sweepProbes();
    let probes = 0;
    for (const state of this.agents.values()) if (state.probe) probes += 1;
    return probes;
  }

  private sweepProbes(): void {
    const now = this.now();
    for (const [key, state] of [...this.agents])
      if (state.probe && now >= state.probe.expiresAt) this.forget(key);
  }

  // -- HTTP -----------------------------------------------------------------

  private authenticate(req: IncomingMessage, fromPath: string | null): string {
    const bearer = req.headers.authorization ?? '';
    const fromBearer = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : '';
    const apiKey = header(req.headers, 'x-api-key') ?? '';
    const token = fromPath ?? (fromBearer.startsWith(GATEWAY_TOKEN_PREFIX) ? fromBearer : apiKey);
    const agentId = token.startsWith(GATEWAY_TOKEN_PREFIX)
      ? this.byToken.get(hashToken(token))
      : undefined;
    if (agentId) {
      const probe = this.agents.get(agentId)?.probe;
      if (probe && this.now() >= probe.expiresAt) {
        this.forget(agentId);
        throw new Refusal(401, 'probe_expired');
      }
      return agentId;
    }
    if (!this.ready) throw new Refusal(503, 'starting', 1);
    throw new Refusal(401, 'unknown_token');
  }

  private route(state: AgentState, method: string, path: string): string {
    for (const allowed of ROUTES[state.route.provider]) {
      if (allowed.method !== method) continue;
      const match = allowed.path.exec(path);
      if (!match) continue;
      if (state.route.provider === 'vertex') {
        const bound = state.route.vertex;
        if (!bound || match[1] !== bound.project || match[2] !== bound.region)
          throw new Refusal(403, 'vertex_project');
      }
      return allowed.name;
    }
    throw new Refusal(403, 'route');
  }

  private admit(state: AgentState): void {
    const now = this.now();
    state.started = state.started.filter((at) => now - at < 60_000);
    if (state.inFlight >= this.limits.maxConcurrentPerAgent)
      throw new Refusal(429, 'concurrency', 1);
    if (state.started.length >= this.limits.maxPerMinutePerAgent) {
      const wait = Math.ceil((60_000 - (now - state.started[0]!)) / 1000);
      throw new Refusal(429, 'rate', Math.max(1, wait));
    }
    if (state.probe && state.probe.callsLeft <= 0) throw new Refusal(401, 'probe_used');
    // Last, so a call refused for any other reason isn't counted against the day.
    const resetsInS = this.deps.cap?.take() ?? null;
    if (resetsInS !== null) throw new Refusal(429, 'daily_cap', resetsInS);
    if (state.probe) state.probe.callsLeft -= 1;
    state.started.push(now);
    state.inFlight += 1;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = this.now();
    const raw = req.url ?? '';
    const method = req.method ?? 'GET';
    let agentId: string | null = null;
    let provider: GatewayProvider | null = null;
    let routeName = 'unmatched';
    let admitted: AgentState | null = null;
    try {
      if (!raw.startsWith('/') || raw.startsWith('//')) throw new Refusal(400, 'not_origin_form');
      const url = new URL(raw, 'http://gateway.invalid');
      if (/%2f|%5c/i.test(raw.split('?')[0]!)) throw new Refusal(403, 'route');
      // A CLI that sends no credential of its own (Claude Code on Vertex with
      // its own auth skipped) is given a base URL carrying its token instead.
      const inPath = TOKEN_IN_PATH.exec(url.pathname);
      const path = inPath ? inPath[2]! : url.pathname;
      agentId = this.authenticate(req, inPath ? inPath[1]! : null);
      const state = this.agents.get(agentId)!;
      provider = state.route.provider;
      routeName = this.route(state, method, path);
      const length = header(req.headers, 'content-length');
      if (length !== null && Number(length) > this.limits.maxBodyBytes)
        throw new Refusal(413, 'body_too_large');
      this.admit(state);
      admitted = state;
      const route = state.route;
      let credential: { header: string; value: string };
      try {
        credential = await route.credential();
      } catch {
        // A fixed reason, never the error: a failed exchange could quote a credential.
        this.deps.log.warn('The provider gateway could not get an agent’s credential', {
          agentId,
          provider,
          reason: 'credential_unavailable',
        });
        throw new Refusal(502, 'credential');
      }
      const status = await this.forward(req, res, {
        url: new URL(`${route.upstream}${path}${keptQuery(route.provider, url.searchParams)}`),
        method,
        headers: requestHeaders(route.provider, req.headers, credential),
      });
      this.deps.log.debug('Provider call', {
        agentId,
        provider,
        route: routeName,
        status,
        ms: this.now() - started,
      });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      this.refused(agentId, provider, routeName, error);
      if (!res.headersSent) answer(res, error.status, describe(error), error.retryAfterS);
      else res.destroy();
    } finally {
      if (admitted) admitted.inFlight -= 1;
    }
  }

  /** Streams the call upstream and the answer back; resolves with the status sent. */
  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    target: { url: URL; method: string; headers: OutgoingHttpHeaders }
  ): Promise<number> {
    let upstream: Awaited<ReturnType<UpstreamSend>>;
    try {
      upstream = await this.send(target.url, {
        method: target.method,
        headers: target.headers,
        timeoutMs: this.limits.idleTimeoutMs,
      });
    } catch {
      throw new Refusal(502, 'upstream_unreachable');
    }
    const abandon = () => {
      if (!res.writableFinished) upstream.request.destroy(new Error('the agent went away'));
    };
    res.once('close', abandon);
    const body = pipeline(req, limitBytes(this.limits.maxBodyBytes), upstream.request).catch(
      (error: unknown) => {
        upstream.request.destroy(error instanceof Error ? error : new Error(String(error)));
        return error;
      }
    );
    let response: IncomingMessage;
    try {
      response = await upstream.response;
    } catch {
      const sent = await body;
      if (sent instanceof BodyTooLarge) throw new Refusal(413, 'body_too_large');
      throw new Refusal(502, 'upstream_failed');
    }
    res.writeHead(response.statusCode ?? 502, responseHeaders(response.headers));
    try {
      await pipeline(response, res);
    } catch (error) {
      this.deps.log.debug('A provider answer ended early', { error: errorKind(error) });
    }
    return response.statusCode ?? 502;
  }

  private refused(
    agentId: string | null,
    provider: GatewayProvider | null,
    route: string,
    refusal: Refusal
  ): void {
    this.refusedTotal += 1;
    const key = `${agentId ?? '-'}:${refusal.reason}`;
    const now = this.now();
    const said = this.refusalsSaid.get(key);
    if (said && now - said.at < 60_000) {
      said.count += 1;
      return;
    }
    this.refusalsSaid.set(key, { at: now, count: 0 });
    this.deps.log.warn('The provider gateway refused a call', {
      agentId,
      provider,
      route,
      status: refusal.status,
      reason: refusal.reason,
      sinceLastSaid: said?.count ?? 0,
    });
  }
}

class BodyTooLarge extends Error {}

function limitBytes(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      seen += chunk.length;
      if (seen > max) done(new BodyTooLarge(`The request body is larger than ${max} bytes.`));
      else done(null, chunk);
    },
  });
}

function requestHeaders(
  provider: GatewayProvider,
  incoming: IncomingHttpHeaders,
  credential: { header: string; value: string }
): OutgoingHttpHeaders {
  const allowed = REQUEST_HEADERS[provider];
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || !(allowed.has(name) || SDK_HEADER.test(name))) continue;
    headers[name] = value;
  }
  headers[credential.header.toLowerCase()] = credential.value;
  return headers;
}

/** The query string passed on: only the provider's own parameters, with allowed values. */
function keptQuery(provider: GatewayProvider, params: URLSearchParams): string {
  const allowed = QUERY[provider];
  const kept = new URLSearchParams();
  for (const [name, value] of params)
    if (Object.hasOwn(allowed, name) && allowed[name]!.includes(value)) kept.append(name, value);
  const text = kept.toString();
  return text ? `?${text}` : '';
}

/** What kind of error it was, for a log line: its code or class, never its message. */
function errorKind(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  return error instanceof Error ? error.constructor.name : 'unknown';
}

function responseHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || DROPPED_RESPONSE.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return text ? text : null;
}

function describe(refusal: Refusal): string {
  switch (refusal.reason) {
    case 'starting':
      return 'The agents controller is starting; retry in a moment.';
    case 'unknown_token':
      return 'This token is not one the agents controller issued, or its login was withdrawn.';
    case 'daily_cap':
      return 'This account has reached its daily AI limit. It resets at 00:00 UTC.';
    case 'probe_expired':
    case 'probe_used':
      return 'This probe token has expired or been used up.';
    case 'route':
    case 'vertex_project':
      return 'The provider gateway does not forward this call.';
    case 'body_too_large':
      return 'The request is larger than the provider gateway allows.';
    case 'concurrency':
    case 'rate':
      return 'Too many calls from this agent at once; retry shortly.';
    case 'credential':
      return 'The agents controller could not get this agent’s provider login.';
    case 'upstream_unreachable':
    case 'upstream_failed':
      return 'The agents controller could not reach the provider.';
    default:
      return 'The provider gateway refused this call.';
  }
}

function answer(res: ServerResponse, status: number, detail: string, retryAfterS?: number): void {
  const text = JSON.stringify({ type: 'error', error: { type: 'gateway_error', message: detail } });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    ...(retryAfterS === undefined ? {} : { 'Retry-After': String(retryAfterS) }),
  });
  res.end(text);
}
