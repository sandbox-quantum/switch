import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the plugin's `tool.call` handler sends, before Amp runs the tool. */
export interface AmpToolCallRequest {
  threadId: string;
  toolUseID: string;
  tool: string;
  input: Record<string, unknown>;
  /** The shell command, when the tool runs one, as Amp's own helper reads it. */
  command: string | null;
}

/** Switch's answer: run it, refuse it, or ask again (the answer is still being decided). */
export type AmpToolDecision =
  | { status: 'allow' }
  | { status: 'reject'; message: string }
  | { status: 'pending' };

export type AmpControlCommand = { kind: 'none' } | { kind: 'cancel'; threadId: string };

export type AmpAgentEndStatus = 'done' | 'error' | 'cancelled';

/** One session's side of the plugin protocol. */
export interface AmpPluginSessionHandler {
  ready(): void;
  sessionStart(threadId: string): void;
  agentStart(threadId: string, messageId: string, message: string | undefined): void;
  agentEnd(threadId: string, messageId: string, status: AmpAgentEndStatus): void;
  toolCall(request: AmpToolCallRequest): Promise<AmpToolDecision>;
  toolCallWait(toolUseID: string): Promise<AmpToolDecision>;
  /** Resolves with the next command for the plugin, or `none` after a while. */
  control(): Promise<AmpControlCommand>;
  cancelled(threadId: string, ok: boolean, error: string | undefined): void;
}

const BODY_LIMIT = 4 * 1024 * 1024;

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * The loopback HTTP endpoint the session's Amp plugin talks to. One per
 * adapter; each session is told apart by the random token in its environment,
 * sent back as a bearer token. Nothing but the plugin knows the port or the
 * token, and the endpoint listens on the loopback interface only.
 */
export class AmpPluginBridge {
  private server: Server | null = null;
  private readonly handlers = new Map<string, AmpPluginSessionHandler>();
  private endpointUrl: string | null = null;

  /** The endpoint to give a plugin, listening by the time this resolves. */
  async endpoint(): Promise<string> {
    if (this.endpointUrl) return this.endpointUrl;
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        const status = error instanceof RequestError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent)
          response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: message }));
      });
    });
    // A decision can take as long as a person takes; the plugin asks again
    // every DECISION_WAIT, so no request is held past the server's limits.
    server.requestTimeout = 120_000;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 65_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const { port } = server.address() as AddressInfo;
    this.endpointUrl = `http://127.0.0.1:${port}`;
    return this.endpointUrl;
  }

  register(token: string, handler: AmpPluginSessionHandler): void {
    this.handlers.set(token, handler);
  }

  unregister(token: string): void {
    this.handlers.delete(token);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.endpointUrl = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') throw new RequestError(405, 'POST only');
    const authorization = request.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const handler = token ? this.handlers.get(token) : undefined;
    if (!handler) throw new RequestError(401, 'unknown session token');
    const body = await readJson(request);
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const result = await this.dispatch(handler, path, body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  }

  private async dispatch(
    handler: AmpPluginSessionHandler,
    path: string,
    body: Record<string, unknown>
  ): Promise<unknown> {
    switch (path) {
      case '/ready':
        handler.ready();
        return {};
      case '/session-start':
        handler.sessionStart(text(body, 'threadId'));
        return {};
      case '/agent-start':
        handler.agentStart(
          text(body, 'threadId'),
          text(body, 'messageId'),
          typeof body.message === 'string' ? body.message : undefined
        );
        return {};
      case '/agent-end': {
        const status = body.status;
        if (status !== 'done' && status !== 'error' && status !== 'cancelled')
          throw new RequestError(400, 'agent-end status must be done, error or cancelled');
        handler.agentEnd(text(body, 'threadId'), text(body, 'messageId'), status);
        return {};
      }
      case '/tool-call':
        return handler.toolCall({
          threadId: text(body, 'threadId'),
          toolUseID: text(body, 'toolUseID'),
          tool: text(body, 'tool'),
          input:
            typeof body.input === 'object' && body.input !== null && !Array.isArray(body.input)
              ? (body.input as Record<string, unknown>)
              : {},
          command: typeof body.command === 'string' ? body.command : null,
        });
      case '/tool-call/wait':
        return handler.toolCallWait(text(body, 'toolUseID'));
      case '/control':
        return handler.control();
      case '/cancelled':
        handler.cancelled(
          text(body, 'threadId'),
          body.ok === true,
          typeof body.error === 'string' ? body.error : undefined
        );
        return {};
      default:
        throw new RequestError(404, `unknown route ${path}`);
    }
  }
}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new RequestError(400, `${key} must be a string`);
  return value;
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new RequestError(413, 'request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          return reject(new RequestError(400, 'request body must be a JSON object'));
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new RequestError(400, 'request body is not JSON'));
      }
    });
    request.on('error', reject);
  });
}
