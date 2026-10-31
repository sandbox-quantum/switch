import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  LogRedactor,
  pipeRedactedLogs,
  Redactions,
  redactSecrets,
  redactText,
  ShapeLineRedactor,
  tokenForms,
} from './redaction';

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

describe('token shapes in logs', () => {
  const token = `ghs_${'A1b2C3d4E5'.repeat(3)}xyz789`;

  it('redacts a GitHub token split over chunks, line by line', () => {
    const shapes = new ShapeLineRedactor();
    const line = Buffer.from(`push to https://x-access-token:${token}@github.com — ✓\nnext`);
    const chunks = [line.subarray(0, 40), line.subarray(40, 41), line.subarray(41)];

    const output = Buffer.concat([...chunks.map((chunk) => shapes.push(chunk)), shapes.finish()]);

    expect(output.toString()).toBe(
      'push to https://x-access-token:[REDACTED]@github.com — ✓\nnext'
    );
  });

  it('never cuts a long line through a token that runs on into the next chunk', () => {
    const shapes = new ShapeLineRedactor();
    // The line passes the limit inside the token, which ends in the next chunk.
    const before = Buffer.from(`${'a'.repeat(64 * 1024 - 10)} ${token.slice(0, 20)}`);
    const after = Buffer.from(`${token.slice(20)} done\n`);
    const output = Buffer.concat([shapes.push(before), shapes.push(after), shapes.finish()]);
    expect(output.toString()).toBe(`${'a'.repeat(64 * 1024 - 10)} [REDACTED] done\n`);
  });

  it('writes an unended line once it is long, still redacted', () => {
    const shapes = new ShapeLineRedactor();
    const long = Buffer.from(`${'é'.repeat(40_000)} ${token} `);
    const written = shapes.push(long);
    expect(written.length).toBeGreaterThan(0);
    expect(Buffer.concat([written, shapes.finish()]).toString()).toBe(
      `${'é'.repeat(40_000)} [REDACTED] `
    );
  });
});

describe('tokens no exact value catches', () => {
  // Synthetic: the shape of a GitHub installation token, not a real one.
  const installation = `ghs_${'A1b2C3d4E5'.repeat(3)}xyz789`;

  it('redacts a GitHub token this process never issued, in each form', () => {
    const redactions = new Redactions();
    const [, , basic] = tokenForms(installation);

    expect(redactions.text(`git push https://x-access-token:${installation}@github.com/o/r`)).toBe(
      'git push https://x-access-token:[REDACTED]@github.com/o/r'
    );
    expect(redactions.value({ header: `Basic ${basic}`, n: 1 })).toEqual({
      header: 'Basic [REDACTED]',
      n: 1,
    });
  });

  it('redacts a GitHub token glued to what precedes it, as escaped or encoded text has it', () => {
    const redactions = new Redactions();
    expect(redactions.text(`{"out":"done\\n${installation}"}`)).toBe('{"out":"done\\n[REDACTED]"}');
    expect(redactions.text(`url=https%3A%2F%2Fx-access-token%3A${installation}%40github.com`)).toBe(
      'url=https%3A%2F%2Fx-access-token%3A[REDACTED]%40github.com'
    );
  });

  it('redacts what is left of a GitHub token cut short', () => {
    const redactions = new Redactions();
    expect(redactions.text(`git push https://x-access-token:${installation.slice(0, 20)}…`)).toBe(
      'git push https://x-access-token:[REDACTED]…'
    );
  });

  it('leaves prose that merely starts like a token', () => {
    const redactions = new Redactions();
    expect(redactions.text('ghost_writer gh_cli ghs_ab and gho_')).toBe(
      'ghost_writer gh_cli ghs_ab and gho_'
    );
    expect(redactions.text('laughs_total highs_and_lows weighs_more')).toBe(
      'laughs_total highs_and_lows weighs_more'
    );
  });

  it('does not hold back a long run that only looks like a token', () => {
    const shapes = new ShapeLineRedactor();
    const written = shapes.push(Buffer.from(`ghs_${'a'.repeat(200 * 1024)}`));
    expect(written.length).toBeGreaterThan(0);
    // All but the last line-tail was written, not held.
    expect(shapes.finish().length).toBeLessThanOrEqual(256);
  });

  it('redacts the cut-off start of an issued token at the end of a title', () => {
    const redactions = new Redactions();
    const token = 'synthetic-issued-token-with-no-shape-0123456789';
    redactions.add(token);
    // How the Claude adapter cuts a command title, through the token.
    const title = `curl -H "Authorization: Bearer ${token.slice(0, 39)}…`;

    const shown = redactions.value({ title }).title;

    expect(shown).toBe('curl -H "Authorization: Bearer [REDACTED]…');
    // The same cut without the ellipsis, as OpenCode's.
    expect(redactions.text(title.slice(0, -1))).toBe('curl -H "Authorization: Bearer [REDACTED]');
  });

  it('leaves a title whose end shares only a few characters with a token', () => {
    const redactions = new Redactions();
    redactions.add('synthetic-issued-token');
    expect(redactions.text('see the synth…')).toBe('see the synth…');
  });
});

describe('secret shape redaction', () => {
  // Built from parts so no literal here is, or looks like, a real credential.
  const fill = (character: string, count: number) => character.repeat(count);
  const shapes: Record<string, string> = {
    'an OpenAI or Anthropic key': `sk-${fill('a', 24)}`,
    'a Slack token': `xoxb-${fill('1', 12)}-${fill('b', 12)}`,
    'an AWS access key id': `AKIA${fill('A', 16)}`,
    'a Google API key': `AIza${fill('b', 35)}`,
    'a GitLab token': `glpat-${fill('c', 22)}`,
    'a Hugging Face token': `hf_${fill('d', 24)}`,
    'a Stripe key': `sk_test_${fill('e', 20)}`,
    'an npm token': `npm_${fill('f', 32)}`,
    'a JWT': `eyJ${fill('a', 12)}.eyJ${fill('b', 12)}.${fill('c', 12)}`,
  };

  it.each(Object.entries(shapes))('masks %s', (_name, secret) => {
    const output = redactSecrets(`before ${secret} after`);
    expect(output).toBe('before [REDACTED] after');
  });

  it('masks a PEM private key whole, and one cut short', () => {
    const whole = `-----BEGIN RSA PRIVATE KEY-----\n${fill('A', 64)}\n-----END RSA PRIVATE KEY-----`;
    expect(redactSecrets(`key:\n${whole}\nnext`)).toBe('key:\n[REDACTED]\nnext');
    expect(redactSecrets(`-----BEGIN PRIVATE KEY-----\n${fill('A', 20)}`)).toBe('[REDACTED]');
  });

  it('masks the password in a connection string and keeps the rest', () => {
    expect(redactSecrets('postgres://app:hunter2@db.example.test:5432/app')).toBe(
      'postgres://app:[REDACTED]@db.example.test:5432/app'
    );
    expect(redactSecrets('https://example.test/path')).toBe('https://example.test/path');
  });

  it('masks bearer and authorization credentials', () => {
    expect(redactSecrets(`Authorization: Bearer ${fill('x', 20)}`)).toBe(
      'Authorization: [REDACTED]'
    );
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: [REDACTED]');
    expect(redactSecrets(`curl -H "bearer ${fill('y', 20)}"`)).toBe('curl -H "bearer [REDACTED]"');
  });

  it('masks values assigned to secret-looking names, in env, flags and JSON', () => {
    expect(redactSecrets('API_KEY=abc123 PASSWORD: hunter2; client_secret = "s3cret"')).toBe(
      'API_KEY=[REDACTED] PASSWORD: [REDACTED]; client_secret = "[REDACTED]"'
    );
    expect(redactSecrets('{"access_token":"abc","name":"x"}')).toBe(
      '{"access_token":"[REDACTED]","name":"x"}'
    );
    expect(redactSecrets('AWS_SECRET_ACCESS_KEY=abc')).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED]');
  });

  it('leaves ordinary text and near misses alone', () => {
    for (const text of [
      'max_tokens: 100',
      'the task-force (sk-short) laughs_total',
      'tokenizer=bpe',
      'ask-for-help-in-the-channel-please',
    ])
      expect(redactSecrets(text)).toBe(text);
  });

  it('Redactions.detail masks issued tokens, GitHub shapes and other shapes together', () => {
    const redactions = new Redactions();
    redactions.add('issued-service-token-value');
    const github = `ghp_${fill('a', 36)}`;
    expect(
      redactions.detail(`a issued-service-token-value b ${github} c sk-${fill('z', 20)}`)
    ).toBe('a [REDACTED] b [REDACTED] c [REDACTED]');
  });
});
