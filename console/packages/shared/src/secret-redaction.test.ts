import { describe, expect, it } from 'vitest';
import { redactSecrets } from './secret-redaction';

// Built from pieces so no whole key shape is ever written in the source.
const fake = (prefix: string, length: number) => prefix + 'Z9x'.repeat(length).slice(0, length);

describe('redactSecrets', () => {
  it.each([
    ['export DATABASE_PASSWORD=hunter22', 'hunter22', 'export DATABASE_PASSWORD='],
    ['{"api_key": "xxxxxxxxxxxx", "region": "eu"}', 'xxxxxxxxxxxx', '"region": "eu"'],
    ['client_secret: s3cr3tvalue', 's3cr3tvalue', 'client_secret:'],
    ['GITHUB_TOKEN="abc12345"', 'abc12345', 'GITHUB_TOKEN="'],
    ['psql --password hunter22 -h db', 'hunter22', 'psql --password '],
    ["tool --token='abcdefgh' --verbose", 'abcdefgh', '--verbose'],
    ['Authorization: Bearer abc.def.ghi123', 'abc.def.ghi123', 'Authorization:'],
    ['curl -H "Authorization: Basic xxxxxxxxxxxx"', 'xxxxxxxxxxxx', 'curl -H'],
    ['token is Bearer 0123456789abcdef', '0123456789abcdef', 'token is Bearer'],
    ['postgres://app:pa55word@db.example.com:5432/app', 'pa55word', 'db.example.com'],
    [
      'AWS_SECRET_ACCESS_KEY=placeholder-value-123',
      'placeholder-value-123',
      'AWS_SECRET_ACCESS_KEY=',
    ],
    ['access_key: xxxxxxxxxxxx', 'xxxxxxxxxxxx', 'access_key:'],
  ])('replaces the value and keeps its name: %s', (input, secret, kept) => {
    const output = redactSecrets(input);
    expect(output).not.toContain(secret);
    expect(output).toContain(kept);
  });

  it.each([
    ['password="my secret value"', 'password="[REDACTED]"'],
    ["PASSWORD='correct horse battery staple'", "PASSWORD='[REDACTED]'"],
    ['export SECRET_KEY="s3cr3t with spaces" && run', 'export SECRET_KEY="[REDACTED]" && run'],
    ['mysql --password "pa ss word" -u root', 'mysql --password "[REDACTED]" -u root'],
    ['password="cut before it clo\nnext line', 'password="[REDACTED]\nnext line'],
  ])('replaces a quoted value whole, spaces and all: %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('replaces keys known by their prefix wherever they appear', () => {
    const keys = [
      fake('sk-ant-', 40),
      fake('sk-proj-', 40),
      fake('xoxb-', 30),
      fake('AKIA', 16).toUpperCase(),
      fake('ASIA', 16).toUpperCase(),
      fake('AIza', 35),
      fake('glpat-', 20),
      fake('npm_', 36),
      fake('sk_live_', 24),
      fake('ghp_', 36),
    ];
    for (const key of keys) expect(redactSecrets(`key ${key} end`)).not.toContain(key);
  });

  it('takes a flag only where one starts, and its value only from the same line', () => {
    const text = 'xoxb-redacted-example-token\nnext line stays';
    expect(redactSecrets(text)).toContain('next line stays');
  });

  it('leaves alone what only looks like it names a secret', () => {
    const ordinary = [
      'max_tokens: 4096',
      '"tokens": 4096',
      'token_count = 12',
      'const tokenizer = createTokenizer()',
      'Use the token from the header.',
      'passwordless sign-in is on',
      'see https://example.com/docs/auth',
      'git@github.com:org/repo.git',
    ];
    for (const text of ordinary) expect(redactSecrets(text)).toBe(text);
  });
});
