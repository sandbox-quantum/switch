import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CONTROLLER_WAIT_MS, connectWhenReady, runLauncher } from './launcher-main';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'launcher-main-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('connects, says hello, and exits 1 when the controller closes the socket', async () => {
  const socketPath = join(dir, 'launcher.sock');
  const lines: string[] = [];
  const server = createServer((socket) => {
    socket.on('data', (chunk) => {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const code = await runLauncher(['--data-dir', join(dir, 'agents'), '--socket', socketPath], {
      bundle: '/nonexistent/bundle.mjs',
      version: '9.9.9',
    });
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'hello', version: '9.9.9' });
  } finally {
    server.close();
  }
});

it('refuses to start without the agents data folder', async () => {
  expect(await runLauncher([], { bundle: 'b', version: 'v' })).toBe(2);
});

it('waits for a controller that starts listening after it, then connects', async () => {
  const socketPath = join(dir, 'late.sock');
  const lines: string[] = [];
  const logged = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const server = createServer((socket) => {
    socket.on('data', (chunk) => {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      socket.end();
    });
  });
  // The controller listens 300 ms after the launcher starts.
  const late = setTimeout(() => server.listen(socketPath), 300);
  try {
    const code = await runLauncher(['--data-dir', join(dir, 'agents'), '--socket', socketPath], {
      bundle: '/nonexistent/bundle.mjs',
      version: '9.9.9',
      controllerWaitMs: 5_000,
    });
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'hello', version: '9.9.9' });
    const events = logged.mock.calls.map((call) => JSON.parse(String(call[0])).event);
    // One line for the wait, however many tries it took, then connected.
    expect(events.filter((e) => e === 'waiting_for_controller')).toHaveLength(1);
    expect(events).toContain('connected');
    expect(events).not.toContain('controller_not_listening');
  } finally {
    clearTimeout(late);
    logged.mockRestore();
    server.close();
  }
});

it('gives up after the wait, logs it once, and exits 1 as before', async () => {
  const logged = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const started = Date.now();
    const code = await runLauncher(
      ['--data-dir', join(dir, 'agents'), '--socket', join(dir, 'never.sock')],
      { bundle: 'b', version: 'v', controllerWaitMs: 400 }
    );
    expect(code).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    const events = logged.mock.calls.map((call) => JSON.parse(String(call[0])).event);
    expect(events).toEqual(['waiting_for_controller', 'controller_not_listening']);
  } finally {
    logged.mockRestore();
  }
});

it('treats a path that is not a socket as not listening yet', async () => {
  const notSocket = join(dir, 'plain-file');
  writeFileSync(notSocket, '');
  const logged = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(await connectWhenReady({ kind: 'path', path: notSocket }, 100, 20)).toBeNull();
  } finally {
    logged.mockRestore();
  }
});

it('waits about 30 s by default', () => {
  expect(CONTROLLER_WAIT_MS).toBe(30_000);
});

it('connects to the controller on loopback with --controller-address, and refuses anything wider', async () => {
  const lines: string[] = [];
  const server = createServer((socket) => {
    socket.on('data', (chunk) => {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const code = await runLauncher(
      ['--data-dir', join(dir, 'agents'), '--controller-address', `127.0.0.1:${port}`],
      { bundle: '/nonexistent/bundle.mjs', version: '9.9.9' }
    );
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'hello', version: '9.9.9' });
  } finally {
    server.close();
  }
  const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    for (const argv of [
      ['--data-dir', join(dir, 'agents'), '--controller-address', '0.0.0.0:7420'],
      [
        '--data-dir',
        join(dir, 'agents'),
        '--controller-address',
        '127.0.0.1:7420',
        '--socket',
        '/x',
      ],
    ])
      expect(await runLauncher(argv, { bundle: 'b', version: 'v', controllerWaitMs: 50 })).toBe(2);
  } finally {
    quiet.mockRestore();
  }
});
