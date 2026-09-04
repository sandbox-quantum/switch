import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * That the runtime dies when its host does.
 *
 * A host stops needing this process in more ways than it can tell it so, and
 * only one of them is an orderly shutdown. The others — killed, crashed,
 * force-quit — leave stdin at EOF and nothing else, and for a long time nothing
 * was listening for that: the SDK's stdio transport binds only 'data' and
 * 'error', so `transport.onclose` never fired and the heartbeat, the lease
 * renewal and the reconnect loop ran on against a host that was gone. They
 * accumulated in the hundreds on a developer machine before anyone looked.
 *
 * So these assert on the manner of death, not on tidiness: that it exits, that
 * it exits *promptly*, and that it takes its published port with it.
 */

const PKG_ROOT = join(import.meta.dirname, '..');
const BIN = join(PKG_ROOT, 'dist', 'bin.mjs');
const SOURCE = readFileSync(join(import.meta.dirname, 'bin.ts'), 'utf8');

/**
 * Generous next to the intended promptness — the exit is immediate — and well
 * inside the per-test timeout, so a regression fails as "still running after
 * 3s" rather than as a bare timeout that says nothing about what broke.
 */
const EXIT_DEADLINE_MS = 3_000;

/** The startup path talks to a local server and loads its operations first. */
const HANDSHAKE_DEADLINE_MS = 20_000;

const TEST_TIMEOUT_MS = 30_000;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'shutdown-test', version: '0' },
  },
};

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

type Running = { child: ChildProcess; root: string; stdout: () => string };

/** A live server in a throwaway HOME, past the handshake and serving. */
async function serving(): Promise<Running> {
  const endpoint = await opsServer();
  const root = mkdtempSync(join(tmpdir(), 'switch-runtime-shutdown-'));
  sandboxes.push(root);

  const child = spawn(process.execPath, [BIN], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      SWITCH_API_ENDPOINT: endpoint,
      SWITCH_API_TOKEN: 'tok-shutdown',
      SWITCH_AGENT_ID: 'agent-shutdown',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.push(child);

  let out = '';
  child.stdout!.on('data', (c: Buffer) => {
    out += c.toString();
  });
  // Drained rather than ignored: an unread stderr pipe fills and would itself
  // stall the child, which is the condition under test in another guise.
  child.stderr!.on('data', () => {});

  const run = { child, root, stdout: () => out };
  child.stdin!.write(`${JSON.stringify(INITIALIZE)}\n`);
  await responseWithin(run, 1, HANDSHAKE_DEADLINE_MS);
  child.stdin!.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
  );
  return run;
}

function responseWithin(run: Running, id: number, ms: number): Promise<void> {
  const seek = (): boolean =>
    run
      .stdout()
      .split('\n')
      .some((line) => {
        if (!line.trim()) return false;
        try {
          return (JSON.parse(line) as { id?: number }).id === id;
        } catch {
          return false;
        }
      });

  return new Promise((resolve, reject) => {
    if (seek()) return resolve();
    const timer = setTimeout(() => reject(new Error(`no response to ${id} within ${ms}ms`)), ms);
    run.child.stdout!.on('data', () => {
      if (seek()) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/**
 * How the child died, as a string an assertion can read back.
 *
 * `still running` rather than a rejection: the regression is a process that
 * never exits, and naming it that way makes the failure message the diagnosis.
 */
function exitWithin(child: ChildProcess, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still running'), ms);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? `signal ${signal}` : `exit ${code}`);
    });
  });
}

/** Where the runtime advertises its hook port, keyed by the host's pid. */
function sessionDir(root: string): string {
  return join(root, '.switch', 'sessions', String(process.pid));
}

describe.skipIf(!existsSync(BIN))('the runtime outliving its host', () => {
  it(
    'exits when stdin closes without an orderly shutdown',
    async () => {
      const run = await serving();

      // Exactly what a killed host leaves behind: EOF on stdin, no `close()`.
      run.child.stdin!.end();

      expect(await exitWithin(run.child, EXIT_DEADLINE_MS)).toBe('exit 0');
    },
    TEST_TIMEOUT_MS
  );

  // Node terminates on an unhandled SIGTERM anyway, so what the handler buys is
  // the cleanup on the way out — assert that, not merely that it died.
  it(
    'shuts down cleanly on SIGTERM rather than dying where it stands',
    async () => {
      const run = await serving();
      await new Promise((r) => setTimeout(r, 500));

      run.child.kill('SIGTERM');

      expect(await exitWithin(run.child, EXIT_DEADLINE_MS)).toBe('exit 0');
      expect(existsSync(sessionDir(run.root))).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'takes its published port file with it',
    async () => {
      const run = await serving();
      // The port is published from the listen callback, which may not have run yet.
      await new Promise((r) => setTimeout(r, 500));

      run.child.stdin!.end();
      await exitWithin(run.child, EXIT_DEADLINE_MS);

      expect(existsSync(sessionDir(run.root))).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'does not stay alive on the hook listener alone',
    async () => {
      const run = await serving();
      await new Promise((r) => setTimeout(r, 500));

      // The listener is bound by now. If it were still holding the event loop,
      // closing stdin would leave the process up.
      run.child.stdin!.end();
      expect(await exitWithin(run.child, EXIT_DEADLINE_MS)).toBe('exit 0');
    },
    TEST_TIMEOUT_MS
  );
});

/**
 * The reparenting watchdog fires on a 30s cadence, which is longer than a test
 * should wait and longer than the harness above can stage. Read the source for
 * it instead — enough to catch its removal, which is the regression that
 * matters.
 */
describe('the reparenting watchdog', () => {
  it('compares the live parent against the one recorded at startup', () => {
    expect(SOURCE).toContain('process.ppid !== SESSION_PPID');
  });

  it('does not itself hold the event loop open', () => {
    const watchdog = SOURCE.slice(SOURCE.indexOf('PARENT_CHECK_INTERVAL_MS'));
    expect(watchdog).toMatch(/\.unref\(\)/);
  });

  it('shuts down rather than only logging', () => {
    const watchdog = SOURCE.slice(
      SOURCE.indexOf('setInterval(() => {'),
      SOURCE.indexOf('PARENT_CHECK_INTERVAL_MS)')
    );
    expect(watchdog).toContain('shutdown(');
  });
});

/**
 * Every trigger is a case the others miss, so losing one is a silent narrowing
 * of the fix rather than a test failure somewhere else.
 */
describe('the shutdown triggers', () => {
  it.each([
    ['the transport closing', "transport.onclose = () => shutdown('transport closed')"],
    ['stdin ending', "process.stdin.on('end'"],
    ['stdin closing', "process.stdin.on('close'"],
    ['a broken stdout', "process.stdout.on('error'"],
    ['a broken stderr', "process.stderr.on('error'"],
  ])('shuts down on %s', (_name, snippet) => {
    expect(SOURCE).toContain(snippet);
  });

  it('handles the termination signals', () => {
    expect(SOURCE).toContain("['SIGTERM', 'SIGINT', 'SIGHUP']");
  });

  it('treats EPIPE as the host being gone rather than an error to log', () => {
    const handler = SOURCE.slice(SOURCE.indexOf("process.on('uncaughtException'"));
    expect(handler.slice(0, handler.indexOf('});'))).toContain('EPIPE');
  });

  it('runs the shutdown work once however many triggers fire', () => {
    const body = SOURCE.slice(SOURCE.indexOf('function shutdown('));
    expect(body.slice(0, body.indexOf('\n}'))).toContain('if (shuttingDown) return;');
  });
});
