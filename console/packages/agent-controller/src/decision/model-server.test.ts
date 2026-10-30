import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ModelServerSpec,
  modelServerArgs,
  modelServerEnv,
  pidFileStaleServers,
  spawnModelServer,
  WARM_UP_PAYLOAD,
  waitHealthy,
} from './model-server';

/**
 * A stand-in llama-server: a tiny Node HTTP server that reads `--port` and
 * its key from `LLAMA_API_KEY` as the real one does, answers `/health` once
 * "loaded", and `/v1/chat/completions` with one token's log-probabilities.
 * It writes its arguments and environment to a file beside it for the test.
 */
const FAKE_SERVER = `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
fs.writeFileSync(path.join(__dirname, 'launched.json'), JSON.stringify({ args, env: process.env }));
if (args[args.indexOf('--model') + 1].endsWith('crash.gguf')) { console.error('ggml_metal: failed to allocate buffer, out of memory'); process.exit(1); }
const started = Date.now();
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/health') {
      res.writeHead(Date.now() - started < 100 ? 503 : 200);
      return res.end('{}');
    }
    if (req.headers.authorization !== 'Bearer ' + process.env.LLAMA_API_KEY) {
      res.writeHead(401);
      return res.end('{"error":{"message":"Invalid API Key"}}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ logprobs: { content: [{ token: 'A', logprob: -0.1 }] } }], echoed: JSON.parse(body).max_tokens }));
  });
}).listen(port, '127.0.0.1');
`;

let dir: string;
let binary: string;

function spec(overrides: Partial<ModelServerSpec> = {}): ModelServerSpec {
  return {
    binary,
    libraryDirs: [join(dir, 'lib')],
    modelFile: join(dir, 'model.gguf'),
    contextSize: 16384,
    parallel: 4,
    gpuLayers: 99,
    threads: null,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-server-'));
  binary = join(dir, 'llama-server');
  writeFileSync(binary, FAKE_SERVER);
  chmodSync(binary, 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the model server’s command line and environment', () => {
  it('listens on loopback only, with no web UI, slots endpoint, prompt cache in RAM or network', () => {
    const args = modelServerArgs(spec(), 41234);
    expect(args.join(' ')).toContain('--host 127.0.0.1 --port 41234');
    expect(args).toEqual(
      expect.arrayContaining(['--no-webui', '--no-slots', '--offline', '--cache-ram', '0'])
    );
    expect(args.join(' ')).toContain('--ctx-size 16384 --parallel 4 --n-gpu-layers 99');
    expect(args).not.toContain('--threads');
    expect(args).not.toContain('--verbose');
    expect(args).not.toContain('--log-file');
    expect(args.join(' ')).not.toContain('api-key');
    expect(modelServerArgs(spec({ gpuLayers: 0, threads: 7 }), 1).join(' ')).toContain(
      '--n-gpu-layers 0 --threads 7'
    );
  });

  it('hands the key in its environment, with nothing of the controller’s but the basics', () => {
    const env = modelServerEnv(spec(), 'launch-key', {
      PATH: '/usr/bin',
      HOME: '/home/someone',
      ANTHROPIC_API_KEY: 'placeholder-provider-key',
      SWITCH_CONTROLLER_DATA_DIR: '/data',
    });
    expect(env).toEqual({
      LLAMA_API_KEY: 'launch-key',
      PATH: '/usr/bin',
      HOME: '/home/someone',
      LD_LIBRARY_PATH: join(dir, 'lib'),
    });
  });
});

// The fake model server is a Node script run through its shebang, which
// Windows can't execute, and the catalogue offers no llama.cpp build for
// Windows, so a Windows controller never spawns one.
describe.skipIf(process.platform === 'win32')('spawnModelServer', () => {
  it('starts it on a free loopback port with a key for this launch, health-checks it and stops it', async () => {
    const launch = spawnModelServer({ PATH: process.env.PATH, ANTHROPIC_API_KEY: 'not-passed' });
    const server = await launch(spec());
    try {
      await waitHealthy({
        fetch,
        server,
        timeoutMs: 10_000,
        intervalMs: 20,
        signal: new AbortController().signal,
      });
      const launched = JSON.parse(readFileSync(join(dir, 'launched.json'), 'utf8')) as {
        args: string[];
        env: Record<string, string>;
      };
      expect(launched.args).toContain(String(server.port));
      expect(launched.args.join(' ')).not.toContain(server.apiKey);
      expect(launched.env.LLAMA_API_KEY).toBe(server.apiKey);
      expect(launched.env.ANTHROPIC_API_KEY).toBeUndefined();

      const refused = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify(WARM_UP_PAYLOAD),
      });
      expect(refused.status).toBe(401);
      const answered = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${server.apiKey}` },
        body: JSON.stringify(WARM_UP_PAYLOAD),
      });
      expect(answered.status).toBe(200);
      expect(((await answered.json()) as { echoed: number }).echoed).toBe(1);

      const second = await launch(spec());
      expect(second.apiKey).not.toBe(server.apiKey);
      await second.stop();
    } finally {
      await server.stop();
    }
    expect(await server.exited).toMatchObject({ signal: 'SIGTERM', outOfMemory: false });
  });

  it('tells an out-of-memory end from what it last printed, and waitHealthy says it ended', async () => {
    const server = await spawnModelServer({ PATH: process.env.PATH })(
      spec({ modelFile: join(dir, 'crash.gguf') })
    );
    const crashed = await waitHealthy({
      fetch,
      server,
      timeoutMs: 10_000,
      intervalMs: 20,
      signal: new AbortController().signal,
    })
      .catch((error: unknown) => error)
      .finally(() => server.stop());
    expect(String(crashed)).toContain('exited with code 1, out of memory');
    expect(await server.exited).toEqual({ code: 1, signal: null, outOfMemory: true });
  });
});

describe('a model server an earlier run left', () => {
  it('is stopped when the process recorded still runs that binary, and left alone otherwise', async () => {
    const file = join(dir, 'model-server.pid');
    const killed: number[] = [];
    const stale = (command: string) =>
      pidFileStaleServers({
        file,
        run: async () => command,
        kill: (pid) => void killed.push(pid),
      });
    await stale('').record(4242, '/data/decision/runtime/b1/llama-server');
    await stale('/data/decision/runtime/b1/llama-server --model x\n').stopStale();
    expect(killed).toEqual([4242]);

    await stale('').record(4243, '/data/decision/runtime/b1/llama-server');
    await stale('/usr/bin/something-else\n').stopStale();
    expect(killed).toEqual([4242]);
    await stale('').stopStale();
    expect(killed).toEqual([4242]);
  });
});
