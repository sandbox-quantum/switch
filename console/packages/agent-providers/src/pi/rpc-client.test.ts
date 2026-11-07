import { describe, expect, it } from 'vitest';
import { noopLogger } from '../transport/stdio-json-rpc';
import { type PiRecord, PiRpcClient } from './rpc-client';

/**
 * A stand-in for `pi --mode rpc`: it answers `echo` with its payload, after
 * an event whose text holds a line separator; writes a CRLF record for
 * `crlf`, a record split across two writes for `split`, and exits with code
 * 3 for `die`.
 */
const FAKE_PI = `
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\\n')) >= 0) {
    const command = JSON.parse(input.slice(0, end));
    input = input.slice(end + 1);
    const respond = (data) => process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data }) + '\\n');
    if (command.type === 'echo') {
      process.stdout.write(JSON.stringify({ type: 'message_update', delta: 'one\\u2028two' }) + '\\n');
      respond(command.payload);
    } else if (command.type === 'crlf') {
      process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: 'crlf', success: true }) + '\\r\\n');
    } else if (command.type === 'split') {
      const line = JSON.stringify({ id: command.id, type: 'response', command: 'split', success: false, error: 'no' }) + '\\n';
      process.stdout.write(line.slice(0, 10));
      setTimeout(() => process.stdout.write(line.slice(10)), 20);
    } else if (command.type === 'die') {
      process.exit(3);
    }
  }
});
`;

function fakePi() {
  const records: PiRecord[] = [];
  const exits: string[] = [];
  const client = new PiRpcClient(
    {
      command: process.execPath,
      args: ['-e', FAKE_PI],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
    },
    {
      onRecord: (record) => records.push(record),
      onExit: (reason) => exits.push(reason),
      logger: noopLogger,
    }
  );
  return { client, records, exits };
}

describe('Pi RPC over stdio', () => {
  it('splits records at line feeds only, so a line separator inside a string stays in its record', async () => {
    const { client, records } = fakePi();
    try {
      const response = await client.command({ type: 'echo', payload: { text: 'a b' } });
      expect(response).toEqual({ success: true, data: { text: 'a b' } });
      expect(records).toEqual([{ type: 'message_update', delta: 'one two' }]);
    } finally {
      await client.dispose();
    }
  });

  it('reads a record ended with CRLF, and one written in two pieces', async () => {
    const { client } = fakePi();
    try {
      await expect(client.command({ type: 'crlf' })).resolves.toEqual({ success: true });
      await expect(client.command({ type: 'split' })).resolves.toEqual({
        success: false,
        error: 'no',
      });
    } finally {
      await client.dispose();
    }
  });

  it('fails what was still waiting when Pi exits, and says how it exited', async () => {
    const { client, exits } = fakePi();
    await expect(client.command({ type: 'die' })).rejects.toThrow(/code 3.*while awaiting die/);
    expect(exits).toEqual(['Pi exited (code 3, signal null)']);
    expect(client.isAlive).toBe(false);
    await expect(client.command({ type: 'echo' })).rejects.toThrow(
      'Pi is gone; echo was not sent.'
    );
  });
});
