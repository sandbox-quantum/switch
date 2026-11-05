import { afterEach, expect, it, vi } from 'vitest';
import { noopLogger } from '../transport/stdio-json-rpc';
import type { PiEvent, PiUiRequest } from './protocol';
import { PiRpcClient, PiRpcError } from './rpc';

let client: PiRpcClient | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await client?.dispose();
  client = null;
});

/** A client of a Node script standing in for Pi. */
function start(
  script: string,
  overrides: Partial<ConstructorParameters<typeof PiRpcClient>[0]> = {}
) {
  const events: PiEvent[] = [];
  const requests: PiUiRequest[] = [];
  const exits: string[] = [];
  client = new PiRpcClient({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: {},
    logger: noopLogger,
    onEvent: (event) => events.push(event),
    onUiRequest: (request) => requests.push(request),
    onExit: (reason) => exits.push(reason),
    ...overrides,
  });
  return { client, events, requests, exits };
}

/** Answers each command with `data` echoing what it was asked. */
const ECHO = `
  process.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().split('\\n').filter(Boolean)) {
      const { id, type, ...rest } = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id, type: 'response', command: type, success: true, data: { type, ...rest } }) + '\\n');
    }
  });`;

it('correlates each response with the command that carries its id', async () => {
  const { client } = start(ECHO);
  const [first, second] = await Promise.all([
    client.request('prompt', { message: 'one' }),
    client.request('get_state'),
  ]);
  expect(first).toEqual({ type: 'prompt', message: 'one' });
  expect(second).toEqual({ type: 'get_state' });
});

it('rejects a command Pi answers with success false', async () => {
  const { client } = start(`
    process.stdin.on('data', (chunk) => {
      const { id, type } = JSON.parse(chunk.toString());
      process.stdout.write(JSON.stringify({ id, type: 'response', command: type, success: false, error: 'Model not found' }) + '\\n');
    });`);
  const failure = await client.request('set_model').catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(PiRpcError);
  expect(failure).toMatchObject({ command: 'set_model', message: 'Model not found' });
});

it('splits records on LF alone, so U+2028 and U+2029 stay inside their strings', async () => {
  const { events } = start(`
    const text = 'a\\u2028b\\u2029c';
    process.stdout.write(JSON.stringify({ type: 'message_update', text }) + '\\n');
    process.stdout.write('{"type":"agent_start"}\\r\\n');
    setInterval(() => {}, 1000);`);
  await vi.waitFor(() => expect(events).toHaveLength(2));
  expect(events[0]).toEqual({ type: 'message_update', text: 'a b c' });
  // A CRLF line end is accepted.
  expect(events[1]).toEqual({ type: 'agent_start' });
});

it('reads a record that arrives in pieces, even in the middle of a character', async () => {
  const { events } = start(`
    const bytes = Buffer.from(JSON.stringify({ type: 'message_update', text: 'héllo €' }) + '\\n');
    const cut = bytes.indexOf(0xc3) + 1;
    process.stdout.write(bytes.subarray(0, cut));
    setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50);
    setInterval(() => {}, 1000);`);
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(events[0]).toEqual({ type: 'message_update', text: 'héllo €' });
});

it('routes extension requests apart from session events, and ignores what is not JSON', async () => {
  const warn = vi.fn();
  const { events, requests } = start(
    `
    process.stdout.write('not json\\n');
    process.stdout.write('{"type":"extension_ui_request","id":"u1","method":"select","title":"T","options":["a"]}\\n');
    process.stdout.write('{"type":"agent_start"}\\n');
    setInterval(() => {}, 1000);`,
    { logger: { ...noopLogger, warn } }
  );
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(requests).toEqual([
    { type: 'extension_ui_request', id: 'u1', method: 'select', title: 'T', options: ['a'] },
  ]);
  expect(warn).toHaveBeenCalledWith('provider process emitted a line that is not JSON', {
    line: 'not json',
  });
});

it('writes an extension response as a record of its own, with no command id', async () => {
  const { client, events } = start(`
    process.stdin.on('data', (chunk) => {
      process.stdout.write(JSON.stringify({ type: 'echoed', line: chunk.toString().trim() }) + '\\n');
    });`);
  client.respond({ type: 'extension_ui_response', id: 'u1', value: 'Allow once' });
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(events[0]).toEqual({
    type: 'echoed',
    line: '{"type":"extension_ui_response","id":"u1","value":"Allow once"}',
  });
});

it('fails the commands waiting when the process exits, and refuses later ones', async () => {
  const { client, exits } = start(`process.stdin.once('data', () => process.exit(3));`);
  await expect(client.request('prompt')).rejects.toThrow(
    'provider process exited (code 3, signal null) while awaiting prompt'
  );
  expect(exits).toEqual(['provider process exited (code 3, signal null)']);
  expect(client.isAlive).toBe(false);
  await expect(client.request('get_state')).rejects.toThrow('process is gone');
});

it('times out a command without resending it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { client } = start('setInterval(() => {}, 1000)');
  const rejected = expect(client.request('get_state', {}, 5000)).rejects.toThrow(
    'outcome is unknown and it was not resent'
  );
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
});

it('interrupts a process whose line never ends', async () => {
  const { exits } = start(
    "process.stdout.write('x'.repeat(17 * 1024 * 1024)); setInterval(() => {}, 1000)"
  );
  await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 15_000 });
  expect(exits[0]).toContain('exceeds 16 MiB');
}, 20_000);

it('quotes what the process wrote to stderr', async () => {
  const { client } = start(
    "process.stderr.write('Extension failed to load'); setInterval(() => {}, 1000)"
  );
  await vi.waitFor(() => expect(client.stderr).toBe('Extension failed to load'));
});

it('asks the process to finish by closing its input', async () => {
  const { client } = start(
    "process.stdin.on('end', () => process.exit(0)); process.stdin.resume()"
  );
  await client.dispose();
  expect(client.isAlive).toBe(false);
});
