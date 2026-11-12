import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { Fetch } from '../api';
import type { Catalogue, CatalogueModel, RuntimeBuild } from '../decision/catalogue';
import { decisionLayout } from '../decision/local-setting';
import type {
  LaunchModelServer,
  ModelServerExit,
  ModelServerHandle,
  ModelServerSpec,
  StaleServers,
} from '../decision/model-server';
import {
  DecisionRuntime,
  type DecisionRuntimeDeps,
  type DecisionTiming,
  type Extract,
} from '../decision/runtime';
import { silentLogger } from '../log';
import type { DecisionStatus } from '../schemas';

/** A decision block as an Apple Silicon machine with nothing assigned reports it. */
export const OFF_DECISION_STATUS: DecisionStatus = {
  hardware: { accelerator: 'apple_silicon', memory_bytes: 16 * 1024 ** 3 },
  offered: [
    {
      model: 'qwen3.5-4b-q4_k_m',
      label: 'Qwen3.5-4B',
      kind: 'llamacpp',
      runtime: 'llamacpp-metal',
      download_bytes: 2_757_401_575,
      speed: 'fast',
    },
  ],
  state: 'off',
  model: null,
  applied_revision: null,
  restarts_10m: 0,
  since: '2026-01-01T00:00:00.000Z',
};

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Bytes standing in for a model's weights or a build's archive. */
export function fakeBytes(seed: string, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (seed.charCodeAt(i % seed.length) + i) % 256;
  return bytes;
}

/**
 * A catalogue of one small model and one archive per build, with real
 * checksums of the bytes `downloads` serves at their (placeholder) URLs.
 */
export function testCatalogue(): {
  catalogue: Catalogue;
  model: CatalogueModel;
  files: Map<string, Buffer>;
} {
  const weights = fakeBytes('weights', 200_000);
  const archive = fakeBytes('archive', 20_000);
  const files = new Map<string, Buffer>([
    ['https://models.example.org/test-model.gguf', weights],
    ['https://builds.example.org/llama-test.tar.gz', archive],
  ]);
  const build = (runtime: RuntimeBuild['runtime'], gpuLayers: number): RuntimeBuild => ({
    runtime,
    version: 'b1',
    archives: [
      {
        url: 'https://builds.example.org/llama-test.tar.gz',
        sha256: sha256(archive),
        bytes: archive.length,
      },
    ],
    binary: 'llama-b1/llama-server',
    libraryDirs: ['llama-b1'],
    gpuLayers,
  });
  const model: CatalogueModel = {
    id: 'test-model',
    label: 'Test Model',
    kind: 'llamacpp',
    file: {
      url: 'https://models.example.org/test-model.gguf',
      sha256: sha256(weights),
      bytes: weights.length,
    },
    contextSize: 16384,
    parallel: 4,
    minMemoryBytes: 8 * 1024 ** 3,
  };
  return {
    catalogue: {
      models: [model],
      builds: {
        'macos-arm64-metal': build('llamacpp-metal', 99),
        'linux-x64-cpu': build('llamacpp-cpu', 0),
        'linux-x64-cuda': build('llamacpp-cuda', 99),
      },
    },
    model,
    files,
  };
}

/**
 * Serves `files` at their URLs as a download server would, honouring range
 * requests; every other URL goes to the real fetch (the fake model servers
 * on loopback). `cutAfter` ends the next response for a URL after that many
 * bytes, once, as a dropped connection does.
 */
export class FakeDownloads {
  readonly requests: { url: string; range: string | null }[] = [];
  readonly cutAfter = new Map<string, number>();
  /** Served instead of the file's bytes, for a corrupted download. */
  readonly corrupt = new Set<string>();
  ignoreRanges = false;

  constructor(private readonly files: Map<string, Buffer>) {}

  readonly fetch: Fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const file = this.files.get(url);
    if (!file) return fetch(input, init);
    const headers = new Headers(init?.headers);
    const range = headers.get('range');
    this.requests.push({ url, range });
    let bytes = this.corrupt.has(url) ? Buffer.from(file).fill(7) : file;
    let status = 200;
    const from = range?.match(/^bytes=(\d+)-$/);
    if (from && !this.ignoreRanges) {
      const start = Number(from[1]);
      if (start >= bytes.length) return new Response(null, { status: 416 });
      bytes = bytes.subarray(start);
      status = 206;
    }
    const cut = this.cutAfter.get(url);
    if (cut !== undefined) {
      this.cutAfter.delete(url);
      const head = bytes.subarray(0, cut);
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return controller.error(new Error('connection reset'));
          sent = true;
          controller.enqueue(new Uint8Array(head));
        },
      });
      return new Response(body, { status });
    }
    return new Response(new Uint8Array(bytes), { status });
  };
}

/** Unpacks a fake archive: makes the binary the build names. */
export const fakeExtract: Extract = async (_archive, dir) => {
  const binary = join(dir, 'llama-b1', 'llama-server');
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, '#!/bin/sh\n', { mode: 0o755 });
};

type Answer = { status: number; body: unknown; delayMs: number };

/**
 * llama-server as the runtime sees it: a loopback HTTP server that answers
 * `/health` (503 while `loading`) and `/v1/chat/completions` only with its
 * key. `crash` ends it as a crashed process would.
 */
export class FakeModelServer implements ModelServerHandle {
  readonly apiKey: string;
  readonly pid = null;
  port = 0;
  loading = false;
  readonly completions: { authorization: string | undefined; body: unknown }[] = [];
  answer: Answer = {
    status: 200,
    body: {
      choices: [
        { index: 0, logprobs: { content: [{ token: 'A', logprob: -0.01, top_logprobs: [] }] } },
      ],
    },
    delayMs: 0,
  };
  stopped = false;
  readonly exited: Promise<ModelServerExit>;
  private finish!: (exit: ModelServerExit) => void;
  private server: Server | null = null;

  constructor(
    readonly spec: ModelServerSpec,
    index: number
  ) {
    this.apiKey = `test-key-${index}`;
    this.exited = new Promise((resolve) => (this.finish = resolve));
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.close();
    this.finish({ code: null, signal: 'SIGTERM', outOfMemory: false });
  }

  async crash(exit: Partial<ModelServerExit> = {}): Promise<void> {
    await this.close();
    this.finish({ code: 1, signal: null, outOfMemory: false, ...exit });
  }

  private async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.url === '/health') {
      res.writeHead(this.loading ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: this.loading ? 'loading model' : 'ok' }));
      return;
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${this.apiKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }));
      return;
    }
    this.completions.push({
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    const answer = this.answer;
    if (answer.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    if (res.destroyed) return;
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  }
}

/** Launches a `FakeModelServer` for each start, recording them. */
export class FakeLauncher {
  readonly servers: FakeModelServer[] = [];
  /** Applied to each server before it starts. */
  configure: (server: FakeModelServer) => void = () => {};
  failWith: Error | null = null;

  readonly launch: LaunchModelServer = async (spec) => {
    if (this.failWith) throw this.failWith;
    const server = new FakeModelServer(spec, this.servers.length + 1);
    this.configure(server);
    await server.start();
    this.servers.push(server);
    return server;
  };

  get last(): FakeModelServer | undefined {
    return this.servers.at(-1);
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.servers.map((server) => server.stop()));
  }
}

export const noStaleServers: StaleServers = {
  record: async () => {},
  clear: async () => {},
  stopStale: async () => {},
};

export const FAST_DECISION_TIMING: DecisionTiming = {
  healthTimeoutMs: 5_000,
  healthIntervalMs: 10,
  crashBackoffMs: [10, 20, 40],
  crashLimit: 3,
  crashWindowMs: 10 * 60 * 1000,
  downloadRetryMs: 20,
  downloadRetryMaxMs: 80,
  diskRetryMs: 20,
  stallTimeoutMs: 2_000,
};

/** A runtime on an Apple Silicon Mac with 16 GB, downloading from `downloads` and launching fakes. */
export function testDecisionRuntime(
  dataDir: string,
  overrides: Partial<DecisionRuntimeDeps> = {}
): DecisionRuntime {
  const { catalogue, files } = testCatalogue();
  return new DecisionRuntime({
    layout: decisionLayout(dataDir),
    catalogue,
    platform: 'darwin',
    arch: 'arm64',
    totalMemory: 16 * 1024 ** 3,
    cpuThreads: 4,
    run: async (command, args) => {
      if (command === 'sysctl' && args.includes('hw.optional.arm64')) return '1\n';
      if (command === 'sysctl') return 'Apple M4 Pro\n';
      throw new Error(`${command}: not found`);
    },
    fetch: new FakeDownloads(files).fetch,
    launch: new FakeLauncher().launch,
    stale: noStaleServers,
    extract: fakeExtract,
    diskFree: async () => 100 * 1024 ** 3,
    override: null,
    log: silentLogger,
    now: Date.now,
    onChange: () => {},
    timing: FAST_DECISION_TIMING,
    ...overrides,
  });
}
