import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { spawnProvider, stopProvider } from '../provider-process';

export interface StdioTransportOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Maximum allowed bytes for an individual newline-delimited message frame.
   * Defaults to 16 MiB (16 * 1024 * 1024 bytes).
   */
  maxFrameBytes?: number;
  /**
   * Maximum bytes kept in the diagnostic stderr tail ring buffer.
   * Defaults to 8 KiB (8192 bytes).
   */
  stderrTailLimit?: number;
}

/**
 * Supervised stdio transport for the official Model Context Protocol (MCP) SDK.
 *
 * Conforms to the official `Transport` interface from `@modelcontextprotocol/sdk/shared/transport.js`.
 *
 * Key guarantees:
 * 1. Bounded byte-level message framing: Enforces `maxFrameBytes` strictly per individual message
 *    (delimiter-to-delimiter), preventing unbounded heap growth from giant frames.
 * 2. Continuous non-blocking stream drainage: Consumes stdout continuously without pausing stream flow,
 *    preventing operating-system pipe buffer deadlocks.
 * 3. Deterministic serialized writes: Writes to child stdin are sequenced through a FIFO queue,
 *    respecting backpressure drain events and rejecting pending writes deterministically on close.
 * 4. Process supervision: Binds to SWITCH's `spawnProvider` and `stopProvider` lifecycle mechanisms.
 */
export class SupervisedStdioTransport implements Transport {
  private child: ChildProcess | null = null;
  private readonly maxFrameBytes: number;
  private readonly stderrTailLimit: number;
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private decoder = new StringDecoder('utf8');
  private isStarted = false;
  private isClosed = false;
  private stderrTail = '';

  // Serialized write queue for backpressure management
  private writeQueue: Array<{
    payload: Buffer;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private isWriting = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string;

  constructor(private readonly options: StdioTransportOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? 16 * 1024 * 1024;
    this.stderrTailLimit = options.stderrTailLimit ?? 8192;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get isRunning(): boolean {
    return this.isStarted && !this.isClosed;
  }

  async start(): Promise<void> {
    if (this.isStarted) throw new Error('Transport already started');
    this.isStarted = true;

    try {
      this.child = spawnProvider(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (spawnError) {
      this.isClosed = true;
      throw new Error(`Failed to spawn child process: ${String(spawnError)}`);
    }

    const { stdout, stderr, stdin } = this.child;
    if (!stdout || !stderr || !stdin) {
      this.isClosed = true;
      throw new Error('Child process spawned without functional stdio pipes');
    }

    // Continuous unpaused stdout reading with per-message bounded framing
    stdout.on('data', (chunk: Buffer) => this.handleStdoutChunk(chunk));
    stdout.on('error', (err) => this.handleFatalError(new Error(`stdout error: ${err.message}`)));

    // Continuous stderr ring buffer drain
    stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-this.stderrTailLimit);
    });
    stderr.on('error', (err) => this.handleFatalError(new Error(`stderr error: ${err.message}`)));

    // Stdin drain listener for serialized write queue
    stdin.on('drain', () => {
      this.isWriting = false;
      this.drainWriteQueue();
    });
    stdin.on('error', (err) => this.handleFatalError(new Error(`stdin error: ${err.message}`)));

    this.child.on('error', (err) =>
      this.handleFatalError(new Error(`Child process error: ${err.message}`))
    );
    this.child.on('exit', () => {
      this.isClosed = true;
      this.cleanupResources();
      this.onclose?.();
    });
  }

  private handleStdoutChunk(chunk: Buffer): void {
    if (this.isClosed) return;

    let chunkOffset = 0;
    while (chunkOffset < chunk.length) {
      const newlineIndex = chunk.indexOf(10, chunkOffset); // 0x0A = '\n'

      if (newlineIndex === -1) {
        // No newline in remaining chunk slice; accumulate into buffer
        const remainingBytes = chunk.length - chunkOffset;
        if (this.bufferedBytes + remainingBytes > this.maxFrameBytes) {
          this.handleFatalError(
            new Error(
              `FRAME_OVERFLOW_ERROR: Message frame exceeded limit of ${this.maxFrameBytes} bytes`
            )
          );
          return;
        }
        const slice = chunk.subarray(chunkOffset);
        this.chunks.push(slice);
        this.bufferedBytes += slice.length;
        chunkOffset = chunk.length;
      } else {
        // Newline found: complete one message frame
        const finalSliceBytes = newlineIndex - chunkOffset;
        if (this.bufferedBytes + finalSliceBytes > this.maxFrameBytes) {
          this.handleFatalError(
            new Error(
              `FRAME_OVERFLOW_ERROR: Message frame exceeded limit of ${this.maxFrameBytes} bytes`
            )
          );
          return;
        }

        let fullMessageBuffer: Buffer;
        if (this.chunks.length === 0) {
          fullMessageBuffer = chunk.subarray(chunkOffset, newlineIndex);
        } else {
          this.chunks.push(chunk.subarray(chunkOffset, newlineIndex));
          fullMessageBuffer = Buffer.concat(this.chunks);
          this.chunks = [];
          this.bufferedBytes = 0;
        }

        chunkOffset = newlineIndex + 1; // Advance past '\n'

        // Strip trailing CR (0x0D) if present
        if (
          fullMessageBuffer.length > 0 &&
          fullMessageBuffer[fullMessageBuffer.length - 1] === 13
        ) {
          fullMessageBuffer = fullMessageBuffer.subarray(0, fullMessageBuffer.length - 1);
        }

        if (fullMessageBuffer.length === 0) continue; // Skip empty lines

        // Decode UTF-8 string cleanly across byte boundaries
        const lineText = this.decoder.write(fullMessageBuffer);
        try {
          const message = JSON.parse(lineText) as JSONRPCMessage;
          this.onmessage?.(message);
        } catch (parseError) {
          this.onerror?.(
            new Error(`MALFORMED_JSON_RPC: Could not parse frame: ${String(parseError)}`)
          );
        }
      }
    }
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.isClosed || !this.child?.stdin?.writable) {
      throw new Error('Transport is closed; send rejected');
    }

    const payload = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');

    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push({ payload, resolve, reject });
      this.drainWriteQueue();
    });
  }

  private drainWriteQueue(): void {
    if (this.isWriting || this.isClosed || this.writeQueue.length === 0) return;

    const item = this.writeQueue.shift()!;
    this.isWriting = true;

    try {
      const canAcceptMore = this.child!.stdin!.write(item.payload, (err) => {
        if (err) {
          item.reject(new Error(`stdin write error: ${err.message}`));
          this.handleFatalError(err);
        } else {
          item.resolve();
        }
      });

      if (canAcceptMore) {
        this.isWriting = false;
        // Schedule next write microtask to preserve order and determinism
        queueMicrotask(() => this.drainWriteQueue());
      }
    } catch (writeErr) {
      this.isWriting = false;
      const errorObj = writeErr instanceof Error ? writeErr : new Error(String(writeErr));
      item.reject(errorObj);
      this.handleFatalError(errorObj);
    }
  }

  private handleFatalError(error: Error): void {
    this.onerror?.(error);
    this.close().catch(() => {});
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    // Reject all pending send promises deterministically
    while (this.writeQueue.length > 0) {
      const item = this.writeQueue.shift()!;
      item.reject(new Error('Transport is closed; send rejected'));
    }

    if (this.child) {
      try {
        this.child.stdin?.end();
        stopProvider(this.child, 'SIGTERM');
      } catch {}
      this.child = null;
    }

    this.cleanupResources();
    this.onclose?.();
  }

  private cleanupResources(): void {
    this.chunks = [];
    this.bufferedBytes = 0;
    this.decoder.end();
  }
}
