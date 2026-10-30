import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '../transport/stdio-json-rpc';
import { FakePi } from './fake-pi';

const processes: FakePi[] = [];

vi.mock('node:child_process', () => ({
  spawn: () => {
    const pi = new FakePi();
    processes.push(pi);
    return pi;
  },
}));

const { PiCommandError, PiRpcClient } = await import('./rpc-client');

function client() {
  const records: unknown[] = [];
  const exits: string[] = [];
  const rpc = new PiRpcClient({
    command: 'pi',
    args: ['--mode', 'rpc'],
    cwd: '/work',
    env: {},
    logger: noopLogger,
    onRecord: (record) => records.push(record),
    onExit: (reason) => exits.push(reason),
  });
  const pi = processes.at(-1);
  if (!pi) throw new Error('fake pi was not spawned');
  return { rpc, pi, records, exits };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('PiRpcClient', () => {
  beforeEach(() => {
    processes.length = 0;
  });

  it('resolves a command with its response data, matched by id', async () => {
    const { rpc, pi } = client();
    pi.answer('get_state', { sessionId: 'abc' });
    expect(await rpc.command('get_state')).toEqual({ sessionId: 'abc' });
    expect(pi.sent('get_state')[0]?.id).toMatch(/^switch-\d+$/);
  });

  it('rejects a refused command with its error', async () => {
    const { rpc, pi } = client();
    pi.refuse('set_model', 'Model not found: x/y');
    await expect(rpc.command('set_model', { provider: 'x', modelId: 'y' })).rejects.toEqual(
      new PiCommandError('set_model', 'Model not found: x/y')
    );
  });

  it('splits records on LF alone, so U+2028 and U+2029 inside a string stay in it', async () => {
    const { pi, records } = client();
    pi.stdout.write(`${JSON.stringify({ type: 'message_update', delta: 'a b c' })}\n`);
    await tick();
    expect(records).toEqual([{ type: 'message_update', delta: 'a b c' }]);
  });

  it('accepts CRLF, and records split across chunks, inside a character too', async () => {
    const { pi, records } = client();
    const bytes = Buffer.from(`${JSON.stringify({ type: 'agent_start', text: 'é✓' })}\r\n`, 'utf8');
    const middle = bytes.indexOf(Buffer.from('✓')) + 1;
    pi.stdout.write(bytes.subarray(0, middle));
    pi.stdout.write(bytes.subarray(middle));
    await tick();
    expect(records).toEqual([{ type: 'agent_start', text: 'é✓' }]);
  });

  it('passes a line that is not JSON over without stopping', async () => {
    const { pi, records } = client();
    pi.stdout.write('not json\n{"type":"agent_end"}\n');
    await tick();
    expect(records).toEqual([{ type: 'agent_end' }]);
  });

  it('rejects what is outstanding when pi exits, and reports the exit once', async () => {
    const { rpc, pi, exits } = client();
    pi.hold('abort');
    const pending = rpc.command('abort');
    await tick();
    pi.exit(1, null);
    await expect(pending).rejects.toThrow(/pi exited \(code 1, signal null\) while awaiting abort/);
    expect(exits).toEqual(['pi exited (code 1, signal null)']);
    expect(rpc.isAlive).toBe(false);
    await expect(rpc.command('get_state')).rejects.toThrow(/pi is gone/);
  });

  it('writes a record that needs no response, and closes stdin to stop', async () => {
    const { rpc, pi } = client();
    rpc.send({ type: 'extension_ui_response', id: 'ui-1', value: 'accept' });
    await tick();
    expect(pi.sent('extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'ui-1', value: 'accept' },
    ]);
    await rpc.dispose();
    expect(pi.stdin.writableEnded).toBe(true);
  });
});
