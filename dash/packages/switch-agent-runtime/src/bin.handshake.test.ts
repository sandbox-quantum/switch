import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The server's behaviour up to `initialize`, exercised as a real subprocess.
 *
 * A host that spawns this over stdio sees one symptom for every startup
 * failure — the connection closing before the handshake — and does not show
 * the child's stderr, so "no credentials", "endpoint unreachable" and "server
 * is broken" are indistinguishable from outside. The distinction is only
 * visible here, which is why these cases assert on the *manner* of failure
 * (exits, promptly, saying why) and not merely that it failed.
 *
 * `bin.ts` reads its config at module scope and exits from it, so it cannot be
 * imported: the only honest test spawns the built artifact.
 */

const PKG_ROOT = join(import.meta.dirname, '..');
const BIN = join(PKG_ROOT, 'dist', 'bin.mjs');

/** Well under Codex's own budget: a startup failure must resolve far sooner. */
const DEADLINE_MS = 20_000;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'handshake-test', version: '0' },
  },
};

type Running = { child: ChildProcess; stdout: () => string; stderr: () => string };

const running: ChildProcess[] = [];
const servers: http.Server[] = [];
const sandboxes: string[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
  for (const server of servers.splice(0)) server.close();
  for (const dir of sandboxes.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A just-killed child may still hold a file open; the OS reclaims tmp.
    }
  }
});

/** An endpoint serving the operation list the runtime loads before serving. */
async function opsServer(): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ operations: {} }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

/** An endpoint that accepts the connection and then never answers. */
async function blackHoleServer(): Promise<string> {
  const server = http.createServer(() => {
    // Deliberately no response: the runtime must give up on its own.
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

/**
 * A throwaway `HOME` and working directory for one spawn.
 *
 * Credential resolution reads `./.switch/agents/` and `~/.switch/agents/`, so
 * the runner's own `HOME` would let whatever the developer happens to have
 * configured decide whether these tests pass — and on a machine with a real
 * agent provisioned, the no-credentials case would find one. Both roots are
 * therefore empty and per-spawn.
 */
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'switch-runtime-test-'));
  sandboxes.push(dir);
  return dir;
}

function start(env: Record<string, string>): Running {
  const root = sandbox();
  const child = spawn(process.execPath, [BIN], {
    cwd: root,
    // A fixed environment, as a host gives it: nothing leaks in from this runner.
    env: { PATH: process.env.PATH ?? '', HOME: root, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.push(child);

  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => {
    out += c.toString();
  });
  child.stderr.on('data', (c: Buffer) => {
    err += c.toString();
  });
  return { child, stdout: () => out, stderr: () => err };
}

/** Resolve with the exit code, or reject if the process outlives the deadline. */
function exitWithin(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process still running after ${ms}ms`)), ms);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Resolve with the JSON-RPC response to `initialize`. */
function responseWithin(run: Running, ms: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no initialize response within ${ms}ms`)), ms);
    run.child.stdout!.on('data', () => {
      for (const line of run.stdout().split('\n')) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as { id?: number };
          if (message.id === 1) {
            clearTimeout(timer);
            resolve(message as Record<string, unknown>);
          }
        } catch {
          // Partial line; wait for the rest.
        }
      }
    });
  });
}

describe.skipIf(!existsSync(BIN))('the Switch runtime as a host spawns it', () => {
  it('answers initialize when its credentials are present', async () => {
    const endpoint = await opsServer();
    const run = start({
      SWITCH_API_ENDPOINT: endpoint,
      SWITCH_API_TOKEN: 'tok-123',
      SWITCH_AGENT_ID: 'agent-1',
    });
    run.child.stdin!.write(`${JSON.stringify(INITIALIZE)}\n`);

    const response = (await responseWithin(run, DEADLINE_MS)) as {
      result?: { protocolVersion?: string; serverInfo?: { name?: string } };
    };

    expect(response.result?.protocolVersion).toBeTruthy();
    expect(response.result?.serverInfo?.name).toBeTruthy();
  });

  it('exits rather than hanging when the host forwarded it no credentials', async () => {
    // The failure this whole change exists to fix: a host that forwards nothing
    // leaves the runtime blind, and exiting is what makes that legible.
    const run = start({});
    run.child.stdin!.write(`${JSON.stringify(INITIALIZE)}\n`);

    expect(await exitWithin(run.child, DEADLINE_MS)).not.toBe(0);
    for (const name of ['SWITCH_API_ENDPOINT', 'SWITCH_API_TOKEN', 'SWITCH_AGENT_ID']) {
      expect(run.stderr()).toContain(name);
    }
    expect(run.stdout()).toBe('');
  });

  it(
    'exits rather than hanging when Switch never answers',
    async () => {
      const endpoint = await blackHoleServer();
      const run = start({
        SWITCH_API_ENDPOINT: endpoint,
        SWITCH_API_TOKEN: 'tok-123',
        SWITCH_AGENT_ID: 'agent-1',
      });
      run.child.stdin!.write(`${JSON.stringify(INITIALIZE)}\n`);

      expect(await exitWithin(run.child, DEADLINE_MS)).not.toBe(0);
      expect(run.stderr()).toContain(endpoint);
    },
    // Must outlast the runtime's own fetch bound, which is the thing under test.
    DEADLINE_MS + 5_000
  );

  it('names the endpoint it could not reach, not just that it failed', async () => {
    const run = start({
      SWITCH_API_ENDPOINT: 'http://127.0.0.1:1',
      SWITCH_API_TOKEN: 'tok-123',
      SWITCH_AGENT_ID: 'agent-1',
    });

    expect(await exitWithin(run.child, DEADLINE_MS)).not.toBe(0);
    expect(run.stderr()).toMatch(/cannot reach Switch at http:\/\/127\.0\.0\.1:1/);
  });
});
