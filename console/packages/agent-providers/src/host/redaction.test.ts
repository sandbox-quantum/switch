import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LogRedactor, pipeRedactedLogs, Redactions, redactText, tokenForms } from './redaction';

function redactChunks(chunks: Buffer[], values: string[]): Buffer {
  const redactor = new LogRedactor(() => values);
  return Buffer.concat([...chunks.map((chunk) => redactor.push(chunk)), redactor.finish()]);
}

describe('log redaction', () => {
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

    expect(redactText('before abcdef after', ['abc', 'abcdef'])).toBe(expected);
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
    const redactor = new LogRedactor(() => [secret]);

    const emitted = redactor.push(input);
    const tail = redactor.finish();

    expect(emitted.length).toBe(input.length - Buffer.byteLength(secret) + 1);
    expect(tail.length).toBe(Buffer.byteLength(secret) - 1);
    expect(Buffer.concat([emitted, tail]).equals(input)).toBe(true);
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

    await pipeRedactedLogs([stream], file, () => [secret]);

    const persisted = Buffer.concat(writes);
    expect(persisted.toString()).toBe('failure: [REDACTED]; retry [REDACTED]');
    expect(persisted.includes(Buffer.from(secret))).toBe(false);
  });
});

describe('values added as they are issued', () => {
  it('scrubs a value from every chunk written after it was added', () => {
    const values: string[] = [];
    const redactor = new LogRedactor(() => values);
    const before = redactor.push(Buffer.from('early synthetic-issued '));
    values.push('synthetic-issued');
    const after = Buffer.concat([
      redactor.push(Buffer.from('later synthetic-iss')),
      redactor.push(Buffer.from('ued done')),
      redactor.finish(),
    ]);
    expect(before.toString()).toBe('early synthetic-issued ');
    expect(after.toString()).toBe('later [REDACTED] done');
  });

  it('scrubs an issued token in each form it can be written in, through any JSON value', () => {
    const redactions = new Redactions();
    expect(redactions.value({ body: 'nothing yet' })).toEqual({ body: 'nothing yet' });
    redactions.add('synthetic-a/b+c');
    const [raw, encoded, basic] = tokenForms('synthetic-a/b+c');
    expect(encoded).toBe('synthetic-a%2Fb%2Bc');
    expect(Buffer.from(basic!, 'base64').toString()).toBe('x-access-token:synthetic-a/b+c');
    expect(
      redactions.value({
        body: `token ${raw}`,
        nested: [{ url: `https://x-access-token:${encoded}@github.com` }, 3, null, true],
        header: `Basic ${basic}`,
      })
    ).toEqual({
      body: 'token [REDACTED]',
      nested: [{ url: 'https://x-access-token:[REDACTED]@github.com' }, 3, null, true],
      header: 'Basic [REDACTED]',
    });
    expect(redactions.text(`log ${raw}`)).toBe('log [REDACTED]');
  });
});

it('says how much of a text could still turn into a value', () => {
  const redactions = new Redactions();
  expect(redactions.unfinished('anything')).toBe(0);
  redactions.add('synthetic-token');
  expect(redactions.unfinished('see synth')).toBe(5);
  expect(redactions.unfinished('see synthetic-token')).toBe(0);
  expect(redactions.unfinished('nothing here.')).toBe(0);
  // Every token's base64 form starts with that of `x-access-token:`.
  expect(redactions.unfinished('nothing here')).toBe(1);
});
