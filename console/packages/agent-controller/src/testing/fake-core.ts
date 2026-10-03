import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  AgentCursor,
  Assignment,
  Operation,
  OperationResult,
  ReasonCode,
  StatusReport,
} from '../schemas';

type Recorded = {
  method: string;
  path: string;
  search: string;
  headers: IncomingMessage['headers'];
  body: unknown;
  /** Bytes in the body, for the routes that only count them. */
  bytes: number;
};

type StreamConnection = {
  id: string;
  generation: number;
  cursors: Record<string, AgentCursor>;
  superseded: boolean;
};

/**
 * A stand-in for the Management routes and the controller stream a
 * controller calls, and for the agent routes its relay forwards to, on a
 * loopback port, holding just enough state to answer them. Every value is a
 * placeholder.
 */
export class FakeCore {
  readonly controllerId = 'controller-1';
  credential = 'controller-credential-placeholder';
  enrollmentCode = 'enrollment-code-placeholder';
  tokenLifetimeMs = 60 * 60 * 1000;
  reportWithinS = 60;
  heartbeatIntervalS = 0.05;
  revoked = false;
  assignment: Assignment = { revision: 0, agents: [] };
  /** Each agent's rooms, as `agent.attached` carries them. */
  readonly rooms = new Map<string, string[]>();
  /** Each agent's buffer head, where an agent opened at `"head"` starts. */
  readonly heads = new Map<string, number>();
  readonly requests: Recorded[] = [];
  readonly statusReports: StatusReport[] = [];
  readonly operations = new Map<string, Operation & { state: string }>();
  readonly results = new Map<string, OperationResult>();
  readonly opens: Record<string, AgentCursor>[] = [];
  readonly beats: Record<string, number>[] = [];
  /** The `placements` each open and each beat carried, in order. */
  readonly openPlacements: Record<string, string[]>[] = [];
  readonly beatPlacements: Record<string, string[]>[] = [];
  /** Answers the next request to a path with this, once. */
  readonly scripted: { method: string; path: string; status: number; body: unknown }[] = [];
  /** What `GET .../media` sends, in these chunks; `waitBetween` holds back all but the first. */
  mediaChunks: Buffer[] = [Buffer.from('media-bytes')];
  waitBetweenChunks: Promise<void> | null = null;
  /** Bytes of an upload received so far. */
  uploadReceived = 0;
  private readonly tokens = new Set<string>();
  private issued = 0;
  private generations = 0;
  private current: StreamConnection | null = null;
  private readonly connections = new Map<string, StreamConnection>();
  private readonly streams = new Map<ServerResponse, StreamConnection>();
  private server: Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: { code: 'internal', message: String(error), retryable: true } })
        );
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const stream of this.streams.keys()) stream.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  get tokensIssued(): number {
    return this.issued;
  }

  /** Makes every token issued so far unacceptable, as a server restart with a new secret would. */
  expireTokens(): void {
    this.tokens.clear();
  }

  setAssignment(assignment: Assignment): void {
    this.assignment = assignment;
  }

  get streamCount(): number {
    return this.streams.size;
  }

  get connection(): StreamConnection | null {
    return this.current;
  }

  push(event: string, data: unknown): void {
    for (const stream of this.streams.keys())
      stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** An agent's domain event on the controller stream, as Switch wraps it. */
  pushEvent(agentId: string, seq: number, event: Record<string, unknown>): void {
    this.heads.set(agentId, Math.max(seq, this.heads.get(agentId) ?? 0));
    this.push('agent.event', { agent_id: agentId, seq, event: { ...event, sequence: seq } });
  }

  /** Ends the open streams; the connection itself lives on. */
  closeStreams(): void {
    for (const stream of this.streams.keys()) stream.end();
    this.streams.clear();
  }

  /** Forgets the connection, as a lapsed heartbeat would: the next attach or beat is a 404. */
  forgetConnection(): void {
    if (this.current) this.connections.delete(this.current.id);
    this.current = null;
    this.closeStreams();
  }

  revoke(): void {
    this.revoked = true;
    this.push('credential.revoked', {});
  }

  addOperation(operation: Operation): void {
    this.operations.set(operation.id, { ...operation, state: 'pending' });
  }

  /** The agents bound here: every running agent assigned to this controller. */
  private bound(): string[] {
    return this.assignment.agents
      .filter((entry) => entry.desired_state === 'running')
      .map((entry) => entry.agent_id)
      .sort();
  }

  private refuse(
    res: ServerResponse,
    status: number,
    code: ReasonCode | string,
    retryable = false
  ) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code, message: `refused: ${code}`, retryable } }));
  }

  private json(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const method = req.method ?? 'GET';
    const upload = method === 'POST' && /^\/agents\/[^/]+\/rooms\/[^/]+\/media$/.test(url.pathname);
    let body: unknown = null;
    let bytes = 0;
    const recorded: Recorded = {
      method,
      path: url.pathname,
      search: url.search,
      headers: req.headers,
      body,
      bytes,
    };
    this.requests.push(recorded);
    if (upload) {
      // Counted as it arrives, never held: the relay must stream it.
      this.uploadReceived = 0;
      for await (const chunk of req) {
        this.uploadReceived += (chunk as Buffer).length;
        recorded.bytes = this.uploadReceived;
      }
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      bytes = raw.length;
      const text = raw.toString('utf8');
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      recorded.body = body;
      recorded.bytes = bytes;
    }

    const scripted = this.scripted.findIndex((s) => s.method === method && s.path === url.pathname);
    if (scripted !== -1) {
      const [entry] = this.scripted.splice(scripted, 1);
      if (entry!.body === null) {
        res.writeHead(entry!.status);
        res.end();
      } else this.json(res, entry!.status, entry!.body);
      return;
    }

    const base = `/v1/management/controllers/${this.controllerId}`;
    const streamBase = `/v1/controllers/${this.controllerId}`;
    if (method === 'POST' && url.pathname === '/v1/management/controllers/enroll') {
      const proof = (body as { proof?: { code?: string } }).proof;
      if (proof?.code !== this.enrollmentCode)
        return this.refuse(res, 400, 'enrollment_code_invalid');
      return this.json(res, 201, { controller_id: this.controllerId, credential: this.credential });
    }
    if (method === 'POST' && url.pathname === `${base}/token`) {
      if (this.revoked) return this.refuse(res, 401, 'controller_revoked');
      if ((body as { credential?: string }).credential !== this.credential)
        return this.refuse(res, 401, 'invalid_credential');
      const token = `access-token-${++this.issued}`;
      this.tokens.add(token);
      return this.json(res, 200, {
        access_token: token,
        expires_at: new Date(Date.now() + this.tokenLifetimeMs).toISOString(),
      });
    }

    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (this.revoked) return this.refuse(res, 401, 'controller_revoked');
    if (!this.tokens.has(bearer)) return this.refuse(res, 401, 'token_expired', true);

    if (method === 'POST' && url.pathname === `${streamBase}/connection`) {
      const cursors = (body as { cursors: Record<string, AgentCursor> }).cursors;
      this.opens.push(cursors);
      this.openPlacements.push((body as { placements: Record<string, string[]> }).placements);
      if (this.current) {
        this.current.superseded = true;
        for (const [stream, connection] of this.streams)
          if (connection === this.current) {
            stream.write(
              `event: evicted\ndata: ${JSON.stringify({ code: 'taken_over', reason: 'another connection of this controller took over' })}\n\n`
            );
            stream.end();
          }
      }
      const connection: StreamConnection = {
        id: `stream-connection-${this.connections.size + 1}`,
        generation: ++this.generations,
        cursors,
        superseded: false,
      };
      this.connections.set(connection.id, connection);
      this.current = connection;
      return this.json(res, 201, {
        connection_id: connection.id,
        generation: connection.generation,
        heartbeat_interval_s: this.heartbeatIntervalS,
        agents: this.bound(),
      });
    }
    if (method === 'GET' && url.pathname === `${streamBase}/events`) {
      const connection = this.connections.get(url.searchParams.get('connection_id') ?? '');
      if (!connection) return this.refuse(res, 404, 'unknown_connection');
      if (connection.superseded) return this.refuse(res, 409, 'taken_over');
      if (Number(url.searchParams.get('generation')) !== connection.generation)
        return this.refuse(res, 409, 'stale_generation');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const frame = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      frame('connection_state', {
        controller_id: this.controllerId,
        assignment_revision: this.assignment.revision,
        report_within_s: this.reportWithinS,
        connection_id: connection.id,
        generation: connection.generation,
        heartbeat_interval_s: this.heartbeatIntervalS,
      });
      // Every bound agent is attached afresh on each stream, from where the
      // connection was opened.
      for (const agentId of this.bound()) {
        const cursor = connection.cursors[agentId];
        frame('agent.attached', {
          agent_id: agentId,
          from_seq: typeof cursor === 'number' ? cursor : (this.heads.get(agentId) ?? 0),
          rooms: this.rooms.get(agentId) ?? [],
        });
      }
      this.streams.set(res, connection);
      res.on('close', () => this.streams.delete(res));
      return;
    }
    if (method === 'POST' && url.pathname === `${streamBase}/connection/beat`) {
      const beat = body as {
        connection_id: string;
        generation: number;
        cursors: Record<string, number>;
      };
      const connection = this.connections.get(beat.connection_id);
      if (!connection) return this.refuse(res, 404, 'unknown_connection');
      if (connection.superseded) return this.refuse(res, 409, 'taken_over');
      if (beat.generation !== connection.generation)
        return this.refuse(res, 409, 'stale_generation');
      this.beats.push(beat.cursors);
      this.beatPlacements.push((body as { placements: Record<string, string[]> }).placements);
      return this.json(res, 200, { agents: this.bound() });
    }
    if (method === 'GET' && url.pathname === `${base}/assignment`) {
      const etag = `"${this.assignment.revision}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      return this.json(res, 200, this.assignment, { ETag: etag });
    }
    if (method === 'PUT' && url.pathname === `${base}/status`) {
      this.statusReports.push(body as StatusReport);
      return this.json(res, 200, {
        assignment_revision: this.assignment.revision,
        report_within_s: this.reportWithinS,
      });
    }
    if (method === 'GET' && url.pathname === `${base}/operations`) {
      return this.json(res, 200, {
        operations: [...this.operations.values()]
          .filter((operation) => operation.state === 'pending')
          .map(({ state: _state, ...operation }) => operation),
      });
    }
    const operation = url.pathname.match(
      /^\/v1\/management\/operations\/([^/]+)\/(claim|progress|result)$/
    );
    if (method === 'POST' && operation) {
      const entry = this.operations.get(decodeURIComponent(operation[1]!));
      if (!entry) return this.refuse(res, 404, 'not_found');
      if (operation[2] === 'claim') {
        if (entry.state === 'cancelled') return this.refuse(res, 410, 'cancelled');
        if (entry.state !== 'pending') return this.refuse(res, 409, 'already_claimed');
        entry.state = 'claimed';
        entry.lease_expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const { state: _state, ...claimed } = entry;
        return this.json(res, 200, claimed);
      }
      if (operation[2] === 'result') {
        const result = body as OperationResult;
        this.results.set(entry.id, result);
        entry.state = result.outcome;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // Acting as an agent: the agent comes from the header, and must be bound here.
    const actingAs = req.headers['x-switch-agent-id'];
    if (url.pathname.startsWith('/agents/') || url.pathname.startsWith('/agent-sessions/')) {
      if (
        typeof actingAs !== 'string' ||
        !this.assignment.agents.some((entry) => entry.agent_id === actingAs)
      )
        return this.refuse(res, 403, 'not_assigned');
      const media = url.pathname.match(/^\/agents\/([^/]+)\/rooms\/([^/]+)\/media$/);
      if (media && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        for (const [index, chunk] of this.mediaChunks.entries()) {
          if (index > 0 && this.waitBetweenChunks) await this.waitBetweenChunks;
          res.write(chunk);
        }
        res.end();
        return;
      }
      if (media && method === 'POST')
        return this.json(res, 200, { event_id: '$uploaded', received: this.uploadReceived });
      if (method === 'GET' && url.pathname === `/agents/${actingAs}/ops`)
        return this.json(res, 200, {
          operations: {
            post_message: { description: 'Post a message.', input_schema: { type: 'object' } },
          },
        });
      const op = url.pathname.match(/^\/agents\/([^/]+)\/ops\/([^/]+)$/);
      if (op && method === 'POST')
        return this.json(res, 200, {
          result: {
            operation: op[2],
            arguments: body,
            room_id: req.headers['x-switch-room-id'] ?? null,
          },
        });
      return this.json(res, 200, { ok: true, path: url.pathname });
    }
    if (url.pathname.startsWith('/v1/management/controllers/') && !url.pathname.startsWith(base))
      return this.refuse(res, 403, 'forbidden');
    return this.refuse(res, 404, 'not_found');
  }
}
