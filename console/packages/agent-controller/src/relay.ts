import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { HUB_PATH } from '@switch-console/agent-providers';
import { errorMessage, type Logger } from './log';

/**
 * The controller's local relay: what each managed agent's host uses as
 * `SWITCH_API_ENDPOINT`, on a loopback port, with a token minted here for each
 * agent.
 *
 * Every call an agent host makes is forwarded to Switch with the controller's
 * access token, the agent named in `X-Switch-Agent-Id`, and the calling
 * session's room in `X-Switch-Room-Id`. No agent holds a Switch credential.
 *
 * An agent host in a process of its own hears its events on the controller's
 * hub, at `/hub` on this same port (`HubSocket`). The relay serves no event
 * stream and no connection of its own: Switch holds one connection, the
 * controller's, for every agent on this machine.
 */

/** Every token the relay mints starts with this, which tells it apart from a Switch credential. */
export const RELAY_TOKEN_PREFIX = 'swlr_';

/** Where a request that is not the hub goes. */
export interface Forwarder {
  forward(
    req: IncomingMessage,
    res: ServerResponse,
    target: { agentId: string; roomId: string | null; path: string }
  ): Promise<void>;
}

/** Where the hub's upgrades go, with the agent the token named. */
export interface HubEndpoint {
  accept(agentId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): Promise<void>;
}

export type RelayDeps = {
  log: Logger;
  /** The room of a call for an agent, from the calling session's placement. */
  roomFor: (agentId: string, sessionId: string | null) => string | null;
  forwarder: Forwarder;
  hub: HubEndpoint;
};

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown
  ) {
    super(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The agent protocol's own connection routes, which an agent host from before
 * the hub still calls. Refused rather than forwarded: Switch refuses them to a
 * controller, and the agent host is restarted onto the hub.
 */
const CONNECTION_ROUTE = /^\/agents\/[^/]+\/(events|connection\/[^/]+)$/;
/** The prefixes forwarded to Switch. Anything else, the management routes above all, stays here. */
const FORWARDED = /^\/(agents\/[^/]+\/.+|agent-sessions\/.+|sessions\/.+|version|health)$/;
/** `/agents/<segment>/...` routes whose segment is not an agent. */
const AGENTLESS_SEGMENTS = new Set(['rooms', 'feature-flags']);

export class LocalRelay {
  private server: Server | null = null;
  private port = 0;
  private readonly sockets = new Set<Socket>();
  private readonly tokens = new Map<string, string>();
  private readonly tokenOf = new Map<string, string>();
  private ready = false;

  constructor(private readonly deps: RelayDeps) {}

  /** Listens on 127.0.0.1: on `preferredPort` when it is free, so running agent hosts find it again. */
  async start(preferredPort: number | null): Promise<number> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.deps.log.error('The relay failed a request', {
          path: req.url,
          error: errorMessage(error),
        });
        if (!res.headersSent) this.send(res, 500, { detail: errorMessage(error) });
        else res.destroy();
      });
    });
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    try {
      await listen(preferredPort ?? 0);
    } catch (error) {
      if (preferredPort === null || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE')
        throw error;
      this.deps.log.warn(
        'The relay port the agents were given is taken; using a new one. Running agents are restarted to pick it up.',
        { port: preferredPort }
      );
      await listen(0);
    }
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  get endpoint(): string {
    if (!this.server) throw new Error('The relay is not listening.');
    return `http://127.0.0.1:${this.port}`;
  }

  /** Where an agent host in a process of its own hears its events. */
  get hubUrl(): string {
    if (!this.server) throw new Error('The relay is not listening.');
    return `ws://127.0.0.1:${this.port}${HUB_PATH}`;
  }

  /**
   * Stops serving. The hub's agent hosts are told the controller is
   * restarting, and keep retrying until it is back: they outlive it.
   */
  async close(): Promise<void> {
    await this.deps.hub.close();
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Unknown tokens are told to retry (503) until this is called: right after
   * a restart an agent host can reach the relay before the controller has read
   * back its token, and a 401 would stop it for good.
   */
  setReady(): void {
    this.ready = true;
  }

  // -- Agents and tokens ------------------------------------------------------

  /** Accepts `token` for the agent, replacing any token it had. */
  register(agentId: string, token: string): void {
    const previous = this.tokenOf.get(agentId);
    if (previous) this.tokens.delete(previous);
    const hash = hashToken(token);
    this.tokens.set(hash, agentId);
    this.tokenOf.set(agentId, hash);
  }

  /** A new token for the agent, replacing any it had. */
  mint(agentId: string): string {
    const token = `${RELAY_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.register(agentId, token);
    return token;
  }

  isRegistered(agentId: string, token: string): boolean {
    return this.tokenOf.get(agentId) === hashToken(token);
  }

  /** Forgets the agent: its token stops working. */
  unregister(agentId: string): void {
    const hash = this.tokenOf.get(agentId);
    if (hash) this.tokens.delete(hash);
    this.tokenOf.delete(agentId);
  }

  // -- HTTP -------------------------------------------------------------------

  /** The agent a request's bearer token names, or the refusal for one it does not. */
  private authenticate(req: IncomingMessage): string | HttpRefusal {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const agentId = token ? this.tokens.get(hashToken(token)) : undefined;
    if (agentId) return agentId;
    if (!this.ready)
      return new HttpRefusal(503, 'The agents controller is starting; retry in a moment.');
    return new HttpRefusal(
      401,
      'This token is not one the agents controller issued, or its agent is no longer assigned to this machine.'
    );
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    const refuse = (status: number, reason: string) => {
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (path !== HUB_PATH) return refuse(404, 'Not Found');
    const agentId = this.authenticate(req);
    if (agentId instanceof HttpRefusal)
      return refuse(
        agentId.status,
        agentId.status === 503 ? 'Service Unavailable' : 'Unauthorized'
      );
    this.deps.hub.accept(agentId, req, socket, head);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? '';
    if (!raw.startsWith('/') || raw.startsWith('//'))
      return this.send(res, 400, { detail: 'The relay serves origin-form paths only.' });
    const url = new URL(raw, 'http://relay.invalid');
    const agentId = this.authenticate(req);
    if (agentId instanceof HttpRefusal)
      return this.send(res, agentId.status, { detail: agentId.detail });
    try {
      if (CONNECTION_ROUTE.test(url.pathname))
        throw new HttpRefusal(
          410,
          `The agents controller no longer serves the agent connection; its agent hosts hear their events on ${HUB_PATH}. Restart the agent host.`
        );
      this.checkForwardable(url, raw, agentId);
      await this.deps.forwarder.forward(req, res, {
        agentId,
        roomId: this.deps.roomFor(agentId, header(req, 'x-switch-session-id')),
        path: `${url.pathname}${url.search}`,
      });
    } catch (error) {
      if (!(error instanceof HttpRefusal)) throw error;
      this.send(res, error.status, { detail: error.detail });
    }
  }

  private checkForwardable(url: URL, raw: string, agentId: string): void {
    const rawPath = raw.split('?')[0]!;
    if (/%2f|%5c/i.test(rawPath) || !FORWARDED.test(url.pathname))
      throw new HttpRefusal(404, `The agents controller does not relay ${url.pathname}.`);
    const segment = /^\/agents\/([^/]+)\//.exec(url.pathname)?.[1];
    if (segment === undefined) return;
    const named = decodeURIComponent(segment);
    if (named !== agentId && !AGENTLESS_SEGMENTS.has(named))
      throw new HttpRefusal(403, `authenticated as agent ${agentId}, not ${named}`);
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }
}

function header(req: Pick<IncomingMessage, 'headers'>, name: string): string | null {
  const value = req.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return text ? text : null;
}
