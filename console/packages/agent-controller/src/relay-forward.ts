import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { isRevoked, PROTOCOL_HEADER } from './api';
import { errorMessage, type Logger } from './log';
import type { Forwarder } from './relay';
import { PROTOCOL_VERSION } from './schemas';

/** The headers that describe one hop, not the request, and are never passed on. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/**
 * Request headers the relay sets itself. `Authorization` carries a local
 * token Switch has never seen; the connection id names a connection that
 * exists only here (Switch keeps no per-agent connection for a
 * controller-backed agent); the agent and room are the relay's to say, never
 * the caller's.
 */
const REPLACED = new Set([
  'authorization',
  'x-switch-connection-id',
  'x-switch-agent-id',
  'x-switch-room-id',
  PROTOCOL_HEADER.toLowerCase(),
]);

/**
 * A request body up to this size is read before it is sent, so the request
 * can be sent again once if Switch refuses an access token that went stale
 * early. A larger one, or one of unknown size, is streamed through and not
 * retried.
 */
export const REPLAYABLE_BODY_BYTES = 1024 * 1024;
const ERROR_BODY_BYTES = 64 * 1024;

export type UpstreamAuth = {
  /** The controller's current access token. */
  token: () => Promise<string>;
  /** Switch refused this token; the next `token()` exchanges a new one. */
  invalidate: (token: string) => void;
  /** Switch says the controller is revoked. */
  revoked: () => void;
};

/** Forwards a relayed request to Switch as the controller, acting as the agent. */
export class UpstreamForwarder implements Forwarder {
  constructor(
    private readonly deps: {
      /** The agent bridge URL, without a trailing slash. */
      server: string;
      auth: UpstreamAuth;
      log: Logger;
    }
  ) {}

  async forward(
    req: IncomingMessage,
    res: ServerResponse,
    target: { agentId: string; roomId: string | null; path: string }
  ): Promise<void> {
    const url = new URL(`${this.deps.server}${target.path}`);
    const method = req.method ?? 'GET';
    const length = req.headers['content-length'];
    const size = length === undefined ? null : Number(length);
    const bodyless =
      method === 'GET' || method === 'HEAD' || (size === 0 && !req.headers['transfer-encoding']);
    let buffered: Buffer | null = null;
    if (!bodyless && size !== null && Number.isSafeInteger(size) && size <= REPLAYABLE_BODY_BYTES)
      buffered = await readAll(req, REPLAYABLE_BODY_BYTES);
    const replayable = bodyless || buffered !== null;
    const headers = forwardedHeaders(req.headers, target);
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.deps.auth.token();
      } catch (error) {
        if (isRevoked(error)) {
          this.deps.auth.revoked();
          return refuse(res, 401, 'This agents controller has been revoked.');
        }
        return refuse(
          res,
          502,
          `The agents controller could not get an access token from Switch: ${errorMessage(error)}`
        );
      }
      let upstream: IncomingMessage;
      try {
        upstream = await send(
          url,
          method,
          { ...headers, authorization: `Bearer ${token}` },
          bodyless ? null : (buffered ?? req),
          res
        );
      } catch (error) {
        if (res.headersSent || res.destroyed) {
          res.destroy();
          return;
        }
        return refuse(
          res,
          502,
          `The agents controller could not reach Switch: ${errorMessage(error)}`
        );
      }
      if (upstream.statusCode === 401) {
        const text = (await readAll(upstream, ERROR_BODY_BYTES)).toString('utf8');
        const code = errorCode(text);
        if (code === 'controller_revoked') this.deps.auth.revoked();
        else {
          this.deps.auth.invalidate(token);
          if (attempt === 0 && replayable) continue;
        }
        res.writeHead(401, responseHeaders(upstream.headers, false));
        res.end(text);
        return;
      }
      res.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream.headers, true));
      try {
        await pipeline(upstream, res);
      } catch (error) {
        this.deps.log.debug('A relayed response ended early', {
          path: url.pathname,
          error: errorMessage(error),
        });
      }
      return;
    }
  }
}

function forwardedHeaders(
  incoming: IncomingHttpHeaders,
  target: { agentId: string; roomId: string | null }
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name) || REPLACED.has(name)) continue;
    headers[name] = value;
  }
  headers['x-switch-agent-id'] = target.agentId;
  if (target.roomId) headers['x-switch-room-id'] = target.roomId;
  headers[PROTOCOL_HEADER] = String(PROTOCOL_VERSION);
  return headers;
}

function responseHeaders(incoming: IncomingHttpHeaders, keepLength: boolean): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (!keepLength && name === 'content-length') continue;
    headers[name] = value;
  }
  return headers;
}

/**
 * Sends one request to Switch and resolves with its response once the head
 * arrives. A stream body is piped, not read into memory. The request is torn
 * down if the local caller goes away first.
 */
function send(
  url: URL,
  method: string,
  headers: OutgoingHttpHeaders,
  body: Buffer | IncomingMessage | null,
  caller: ServerResponse
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method,
      headers: body instanceof Buffer ? { ...headers, 'content-length': body.length } : headers,
    });
    const abandon = () => {
      if (!caller.writableFinished) request.destroy(new Error('the local caller went away'));
    };
    caller.once('close', abandon);
    request.once('response', resolve);
    request.once('error', reject);
    if (body === null) request.end();
    else if (body instanceof Buffer) request.end(body);
    else pipeline(body, request).catch(reject);
  });
}

async function readAll(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > limit) throw new Error(`The body is larger than ${limit} bytes.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The code in either envelope Switch answers with. */
function errorCode(text: string): string | null {
  try {
    const body = JSON.parse(text) as {
      error?: { code?: unknown };
      detail?: { code?: unknown } | unknown;
    };
    const code =
      body.error?.code ??
      (typeof body.detail === 'object' && body.detail !== null
        ? (body.detail as { code?: unknown }).code
        : undefined);
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

function refuse(res: ServerResponse, status: number, detail: string): void {
  const text = JSON.stringify({ detail });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}
