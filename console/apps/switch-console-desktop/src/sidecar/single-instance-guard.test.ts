import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existingSidecarIsHealthy } from './single-instance-guard';

const SLUG = 'test-agent';
const READY_REL = `.switchdash/agents/${SLUG}/sidecar.ready`;

const noop = { info: vi.fn(), warn: vi.fn() };

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'guard-test-'));
  await mkdir(path.join(tmpDir, `.switchdash/agents/${SLUG}`), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function writeReady(overrides: Record<string, unknown> = {}): Promise<void> {
  const line = JSON.stringify({
    event: 'ready',
    port: 99999,
    token: 'test-token',
    pid: 999999999,
    ...overrides,
  });
  return writeFile(path.join(tmpDir, READY_REL), line + '\n');
}

describe('existingSidecarIsHealthy', () => {
  it('returns false when the ready file is missing', async () => {
    expect(await existingSidecarIsHealthy(tmpDir, SLUG, noop)).toBe(false);
  });

  it('returns false when the ready file has a dead PID', async () => {
    // PID 999999999 should not exist on any system.
    await writeReady({ pid: 999999999 });
    expect(await existingSidecarIsHealthy(tmpDir, SLUG, noop)).toBe(false);
  });

  it('returns false when the PID is alive but the port does not respond', async () => {
    // Use our own PID (known alive) with a port nothing is listening on.
    await writeReady({ pid: process.pid, port: 1 });
    // process.pid === our PID is excluded by the self-check, so use ppid.
    await writeReady({ pid: process.ppid, port: 1 });
    expect(await existingSidecarIsHealthy(tmpDir, SLUG, noop)).toBe(false);
  });

  it('returns true when the PID is alive and the port responds OK', async () => {
    // Start a tiny HTTP server that returns 200 on any request.
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('[]');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      await writeReady({ pid: process.ppid, port, token: 'anything' });
      expect(await existingSidecarIsHealthy(tmpDir, SLUG, noop)).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns false when the PID matches the current process (self-detection)', async () => {
    await writeReady({ pid: process.pid });
    expect(await existingSidecarIsHealthy(tmpDir, SLUG, noop)).toBe(false);
  });
});
