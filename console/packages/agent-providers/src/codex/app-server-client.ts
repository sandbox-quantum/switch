import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface ProviderLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const noopLogger: ProviderLogger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

export interface AppServerClientOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Complete environment for the child; never merged with `process.env`. */
  env: Record<string, string>;
  logger: ProviderLogger;
  /** Called once when the process goes away, whether or not it was asked to. */
  onExit: (reason: string) => void;
}

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (params: unknown) => Promise<unknown>;

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const STDERR_TAIL_LIMIT = 8_000;

/**
 * Newline-delimited JSON-RPC 2.0 over a child process' stdio. Server-initiated
 * requests (approvals, questions) arrive with both `id` and `method` and are
 * answered on the same channel, which is what separates them from responses.
 */
export class AppServerClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, NotificationHandler[]>();
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private readonly logger: ProviderLogger;
  private readonly onExit: (reason: string) => void;
  private stderrTail = '';
  private nextId = 0;
  private exited = false;

  constructor(options: AppServerClientOptions) {
    this.logger = options.logger;
    this.onExit = options.onExit;
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = this.child.stdout;
    const stderr = this.child.stderr;
    if (!stdout || !stderr) throw new Error('codex app-server was spawned without stdio pipes');

    createInterface({ input: stdout }).on('line', (line) => this.handleLine(line));
    stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_LIMIT);
    });

    this.child.on('error', (error) => this.handleExit(`spawn failed: ${error.message}`));
    this.child.on('exit', (code, signal) =>
      this.handleExit(
        `codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
      )
    );
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) {
      return Promise.reject(new Error(`codex app-server is gone; cannot call ${method}`));
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.exited) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  dispose(): void {
    if (this.exited) return;
    this.child.stdin?.end();
    this.child.kill('SIGTERM');
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.logger.warn('codex app-server emitted a line that is not JSON', { line });
      return;
    }

    if (message.id !== undefined && message.method !== undefined) {
      this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (message.id !== undefined) {
      this.handleResponse(message);
      return;
    }
    if (message.method === undefined) return;

    for (const handler of this.notificationHandlers.get(message.method) ?? []) {
      try {
        handler(message.params);
      } catch (cause) {
        this.logger.error('codex notification handler threw', {
          method: message.method,
          error: String(cause),
        });
      }
    }
  }

  private handleResponse(message: JsonRpcMessage): void {
    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) {
      pending.reject(
        new JsonRpcError(message.error.code, message.error.message, message.error.data)
      );
      return;
    }
    pending.resolve(message.result);
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) {
      this.logger.warn('codex app-server sent an unhandled request', { method });
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unhandled server request ${method}` },
      });
      return;
    }
    handler(params).then(
      (result) => this.write({ jsonrpc: '2.0', id, result }),
      (cause: unknown) =>
        this.write({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: String(cause) },
        })
    );
  }

  private handleExit(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error(`${reason} while awaiting ${pending.method}`));
    }
    this.onExit(reason);
  }
}
