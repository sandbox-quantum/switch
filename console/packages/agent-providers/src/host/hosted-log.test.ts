import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { HostedLogRedactor, pipeRedactedHostedLogs, redactHostedText } from './hosted-log';

function redactChunks(chunks: Buffer[], values: string[]): Buffer {
  const redactor = new HostedLogRedactor(values.map((value) => Buffer.from(value)));
  return Buffer.concat([...chunks.map((chunk) => redactor.push(chunk)), redactor.finish()]);
}

describe('hosted log redaction', () => {
  it('redacts a repeated secret when the final occurrence crosses the output boundary', () => {
    const secret = 'provider-secret';
    const output = redactChunks(
      [Buffer.from(`${secret}--provider-se`), Buffer.from('cret')],
      [secret]
    );

    expect(output.toString()).toBe('[REDACTED]--[REDACTED]');
    expect(output.includes(Buffer.from(secret))).toBe(false);
  });

  it('prefers the longest match when one secret is a prefix of another', () => {
    const expected = 'before [REDACTED] after';

    expect(redactHostedText('before abcdef after', ['abc', 'abcdef'])).toBe(expected);
    expect(
      redactChunks(
        [Buffer.from('before abc'), Buffer.from('def after')],
        ['abc', 'abcdef']
      ).toString()
    ).toBe(expected);
  });

  it('redacts a UTF-8 secret split at every byte boundary', () => {
    const secret = 'tøk🔐en';
    const input = Buffer.from(`before ${secret} after`);
    const chunks = Array.from(input, (byte) => Buffer.from([byte]));

    const output = redactChunks(chunks, [secret]);

    expect(output.toString()).toBe('before [REDACTED] after');
    expect(output.includes(Buffer.from(secret))).toBe(false);
  });

  it('keeps pending raw data bounded by the longest secret', () => {
    const secret = 's'.repeat(64);
    const input = Buffer.alloc(1024 * 1024, 'a');
    const redactor = new HostedLogRedactor([Buffer.from(secret)]);

    const emitted = redactor.push(input);
    const tail = redactor.finish();

    expect(emitted.length).toBe(input.length - Buffer.byteLength(secret) + 1);
    expect(tail.length).toBe(Buffer.byteLength(secret) - 1);
    expect(Buffer.concat([emitted, tail])).toEqual(input);
  });

  it('writes only redacted bytes to the diagnostic sink', async () => {
    const writes: Buffer[] = [];
    const file = {
      write: async (value: Uint8Array) => {
        writes.push(Buffer.from(value));
      },
    } as unknown as FileHandle;
    const secret = 'switch-secret-value';
    const stream = Readable.from([
      Buffer.from('failure: switch-se'),
      Buffer.from('cret-value; retry switch-secret-value'),
    ]);

    await pipeRedactedHostedLogs([stream], file, [secret]);

    const persisted = Buffer.concat(writes);
    expect(persisted.toString()).toBe('failure: [REDACTED]; retry [REDACTED]');
    expect(persisted.includes(Buffer.from(secret))).toBe(false);
  });
});
