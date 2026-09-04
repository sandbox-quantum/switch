import crypto from 'node:crypto';
import http from 'node:http';

export interface ControlServerLogger {
  info(...input: unknown[]): void;
  warn(...input: unknown[]): void;
  error(...input: unknown[]): void;
}

export type ControlRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: ControlRouteHandler;
}

/**
 * Localhost-only HTTP server for the Console local control API. Modeled on
 * hook-server.ts: binds 127.0.0.1, OS-assigned port, token-gated via the
 * `x-switch-control-token` header.
 */
export class ControlServer {
  private server: http.Server | null = null;
  private port = 0;
  private token = '';
  private routes: Route[] = [];

  constructor(private readonly log: ControlServerLogger) {}

  /** Register a route. Call before start(). */
  route(method: string, path: string, handler: ControlRouteHandler): void {
    const paramNames: string[] = [];
    const regexStr = path.replace(/:([a-zA-Z]+)/g, (_match, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    this.routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
    });
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.token = crypto.randomUUID();

    this.server = http.createServer((req, res) => {
      if (!this.tokenMatches(req.headers['x-switch-control-token'])) {
        this.log.warn('ControlServer: rejected request with invalid token');
        res.writeHead(403);
        res.end();
        return;
      }

      const url = (req.url ?? '').split('?')[0]!;
      const method = (req.method ?? 'GET').toUpperCase();

      for (const route of this.routes) {
        if (route.method !== method) continue;
        const match = route.pattern.exec(url);
        if (!match) continue;

        let params: Record<string, string>;
        try {
          params = {};
          for (let i = 0; i < route.paramNames.length; i++) {
            params[route.paramNames[i]!] = decodeURIComponent(match[i + 1]!);
          }
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }

        try {
          const result = route.handler(req, res, params);
          if (result instanceof Promise) {
            result.catch((err) => {
              this.log.error('ControlServer: handler error', { error: String(err) });
              if (!res.headersSent) {
                res.writeHead(500);
                res.end();
              }
            });
          }
        } catch (err) {
          this.log.error('ControlServer: handler error', { error: String(err) });
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        this.log.info('ControlServer: started', { port: this.port });
        resolve();
      });
      this.server!.on('error', (err) => {
        this.log.error('ControlServer: failed to start', { error: String(err) });
        reject(err);
      });
    });
  }

  /** Constant-time token check (hash both sides to a fixed length first). */
  private tokenMatches(provided: unknown): boolean {
    if (typeof provided !== 'string' || this.token === '') return false;
    const a = crypto.createHash('sha256').update(provided).digest();
    const b = crypto.createHash('sha256').update(this.token).digest();
    return crypto.timingSafeEqual(a, b);
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
    }
  }

  getPort(): number {
    return this.port;
  }

  getToken(): string {
    return this.token;
  }
}

/** Send a JSON response with explicit Content-Length (not chunked). */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': payload.byteLength,
  });
  res.end(payload);
}

/** Read the full request body as a parsed JSON object. */
export function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body.length > 0 ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
