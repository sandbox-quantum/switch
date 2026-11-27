import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { warmOverControlPort } from './control-port';

const TOKEN = 'a-control-token-of-enough-length';
let dir: string;
let server: Server;
let received: unknown[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'control-port-'));
  received = [];
  server = createServer((socket) => {
    createInterface({ input: socket }).on('line', (line) => {
      const message = JSON.parse(line) as { token?: string; id?: number };
      if (message.token === TOKEN) socket.write(`${JSON.stringify({ authenticated: true })}\n`);
      else {
        received.push(message);
        socket.write(`${JSON.stringify({ id: message.id, ok: true, value: 'session-1' })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function controlFile(content: unknown): string {
  const path = join(dir, 'control.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

it('sends warm for the room over the port its control file names', async () => {
  const { port } = server.address() as { port: number };
  await warmOverControlPort(controlFile({ port, token: TOKEN }), 'room-a');
  expect(received).toEqual([{ id: 0, warm: { roomId: 'room-a' } }]);
});

it('refuses a control file that is a symlink or names more than a port and a token', async () => {
  const { port } = server.address() as { port: number };
  const real = controlFile({ port, token: TOKEN, host: 'elsewhere' });
  await expect(warmOverControlPort(real, 'room-a')).rejects.toThrow();
  const link = join(dir, 'linked.json');
  symlinkSync(controlFile({ port, token: TOKEN }), link);
  await expect(warmOverControlPort(link, 'room-a')).rejects.toThrow('is a link');
  expect(received).toEqual([]);
});

it('reports a control file it cannot read without repeating any of it', async () => {
  const secret = 'SECRET-FROM-ANOTHER-FILE';
  const garbage = join(dir, 'control.json');
  writeFileSync(garbage, `not json ${secret}`);
  const error = await warmOverControlPort(garbage, 'room-a').catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('is not JSON');
  expect((error as Error).message).not.toContain(secret);

  writeFileSync(garbage, JSON.stringify({ port: secret, token: secret }));
  const shaped = await warmOverControlPort(garbage, 'room-a').catch((e: Error) => e);
  expect((shaped as Error).message).toContain('(at port)');
  expect((shaped as Error).message).not.toContain(secret);
});

it('refuses an oversized control file, and a FIFO without waiting on it', async () => {
  const big = join(dir, 'big.json');
  writeFileSync(big, ' '.repeat(5000));
  await expect(warmOverControlPort(big, 'room-a')).rejects.toThrow('larger than');
  if (process.platform !== 'win32') {
    const fifo = join(dir, 'fifo.json');
    execFileSync('mkfifo', [fifo]);
    await expect(warmOverControlPort(fifo, 'room-a')).rejects.toThrow('not a regular file');
  }
  expect(received).toEqual([]);
});
