import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { pushTicketUntilTaken } from './control-port-box';

const TOKEN = 'a-control-token-of-enough-length';
/** The host's confirmation of a ticket: 64 hex, as the control client checks. */
const TAKEN_MAC = 'f'.repeat(64);
let dir: string;
let server: Server;
let received: unknown[];
let connections: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'control-port-'));
  received = [];
  connections = 0;
  server = createServer((socket) => {
    connections++;
    createInterface({ input: socket }).on('line', (line) => {
      const message = JSON.parse(line) as { token?: string; id?: number };
      if (message.token === TOKEN) socket.write(`${JSON.stringify({ authenticated: true })}\n`);
      else {
        received.push(message);
        const value = 'hubTicket' in message ? TAKEN_MAC : 'session-1';
        socket.write(`${JSON.stringify({ id: message.id, ok: true, value })}\n`);
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

function serverPort(): number {
  return (server.address() as { port: number }).port;
}

it('waits past a control file a dead host left, and hands the ticket to the new host once it writes its own (1 Nov defect)', async () => {
  const own = serverPort();
  // The previous pod's host left its file naming a port that is no longer anyone's.
  const file = controlFile({ port: 40999, token: TOKEN });
  setTimeout(() => writeFileSync(file, JSON.stringify({ port: own, token: TOKEN })), 150);
  const outcome = await pushTicketUntilTaken({
    controlFile: file,
    ticket: 'ticket-1',
    mac: 'mac-1',
    ownsPort: async (port) => port === own,
    taken: (answer) => answer === TAKEN_MAC,
    deadlineMs: 3_000,
    retryMs: 20,
  });
  expect(outcome).toBe('taken');
  expect(connections).toBe(1);
});

it('never hands the ticket to a port that is not the host’s own, even inside the retry window', async () => {
  // A live port, but another process's: the check refuses it on every attempt.
  const file = controlFile({ port: serverPort(), token: TOKEN });
  const outcome = await pushTicketUntilTaken({
    controlFile: file,
    ticket: 'ticket-1',
    mac: 'mac-1',
    ownsPort: async () => false,
    taken: () => true,
    deadlineMs: 200,
    retryMs: 20,
  });
  expect(outcome).toBe('wrong_port');
  expect(connections).toBe(0);
  expect(received).toEqual([]);
});
