import { describe, expect, it } from 'vitest';
import {
  redactSecrets,
  redactUrlCredentials,
  SECRET_PATTERNS,
  secretRanges,
  URL_CREDENTIALS_PATTERN,
} from './redaction';

/**
 * Credential-shaped fixtures are assembled at runtime so no literal in the
 * repo looks like a secret to push protection or a secret scanner.
 */
const join = (...parts: string[]) => parts.join('');
const BASIC_CREDENTIAL = Buffer.from(join('alice', ':', 'open-', 'sesame')).toString('base64');
const SPACED = join('alpha', ' beta', ' gamma');
const GITHUB_TOKEN = join('ghp', '_', 'a'.repeat(36));
const DB_PASSWORD = join('s3', 'cr3t');

describe('redactSecrets', () => {
  it('redacts the credential of Authorization: Basic, not only the scheme word', () => {
    const redacted = redactSecrets(`Authorization: Basic ${BASIC_CREDENTIAL}`);

    expect(redacted).toBe('Authorization: [REDACTED]');
    expect(redacted).not.toContain(BASIC_CREDENTIAL);
  });

  it.each([
    ['double quotes', `password="${SPACED}"`, 'password="[REDACTED]"'],
    ['single quotes', `password='${SPACED}'`, "password='[REDACTED]'"],
    ['colon separator', `client_secret: "${SPACED}"`, 'client_secret: "[REDACTED]"'],
    ['quoted bearer header', `Authorization: "Bearer ${SPACED}"`, 'Authorization: "[REDACTED]"'],
  ])('redacts a quoted value with spaces (%s) to its closing quote', (_label, input, expected) => {
    const redacted = redactSecrets(`${input} next=kept`);

    expect(redacted).toBe(`${expected} next=kept`);
    expect(redacted).not.toContain('beta');
    expect(redacted).not.toContain('gamma');
  });

  it('redacts a JSON value containing a backslash escape whole', () => {
    // A literal backslash followed by `n`, as JSON.stringify writes a newline.
    const input = JSON.stringify({ password: 'alpha\nbeta', user: 'kept' });
    expect(input).toContain('alpha\\nbeta');

    const redacted = redactSecrets(input);

    expect(redacted).toBe('{"password":"[REDACTED]","user":"kept"}');
    expect(JSON.parse(redacted)).toEqual({ password: '[REDACTED]', user: 'kept' });
  });

  it('redacts a JSON value containing an escaped quote whole', () => {
    const input = JSON.stringify({ api_key: join('alpha"', 'beta'), user: 'kept' });
    expect(input).toContain('alpha\\"beta');

    const redacted = redactSecrets(input);

    expect(redacted).toBe('{"api_key":"[REDACTED]","user":"kept"}');
    expect(redacted).not.toContain('beta');
  });

  it('redacts an escaped value in JSON nested inside a JSON string', () => {
    const inner = JSON.stringify({ password: join('alpha\n', 'be"ta'), user: 'kept' });
    const input = JSON.stringify({ payload: inner });

    const redacted = redactSecrets(input);

    expect(redacted).not.toContain('alpha');
    expect(redacted).not.toContain('ta');
    expect(JSON.parse(JSON.parse(redacted).payload)).toEqual({
      password: '[REDACTED]',
      user: 'kept',
    });
  });

  it('keeps the JSON escape after an unquoted header value inside a JSON string', () => {
    const input = JSON.stringify({
      command: 'curl -H "Authorization: Bearer $TOKEN" https://api.example.test',
    });
    expect(input).toContain('\\"Authorization: Bearer $TOKEN\\"');

    const redacted = redactSecrets(input);

    expect(redacted).toBe(
      '{"command":"curl -H \\"Authorization: [REDACTED]\\" https://api.example.test"}'
    );
    expect(redacted).not.toContain('$TOKEN');
    expect(JSON.parse(redacted)).toEqual({
      command: 'curl -H "Authorization: [REDACTED]" https://api.example.test',
    });
  });

  it('keeps the JSON escape after an unquoted assignment inside a JSON string', () => {
    const input = JSON.stringify({ command: join('echo password=', 'abc"', ' done') });
    expect(input).toContain('password=abc\\"');

    const redacted = redactSecrets(input);

    expect(redacted).toBe('{"command":"echo password=[REDACTED]\\" done"}');
    expect(redacted).not.toContain('abc');
    expect(JSON.parse(redacted)).toEqual({ command: 'echo password=[REDACTED]" done' });
  });

  it.each([
    ['domain account', join('token=domain', '\\', 'abc'), 'token=[REDACTED]'],
    [
      'domain user and pass',
      join('password=domain', '\\', 'user', '\\', 'pass'),
      'password=[REDACTED]',
    ],
    ['leading backslash', join('secret=', '\\', 'abc'), 'secret=[REDACTED]'],
  ])('keeps a backslash inside an unquoted value (%s)', (_label, input, expected) => {
    const redacted = redactSecrets(`${input} next=kept`);

    expect(redacted).toBe(`${expected} next=kept`);
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('user');
    expect(redacted).not.toContain('domain');
  });

  it('redacts an escaped quoted value inside a JSON string to its escaped closing quote', () => {
    const input = JSON.stringify({ command: join('run password="abc', ' def"', ' next=kept') });
    expect(input).toContain('password=\\"abc def\\"');

    const redacted = redactSecrets(input);

    expect(redacted).toBe('{"command":"run password=\\"[REDACTED]\\" next=kept"}');
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('def');
    expect(JSON.parse(redacted)).toEqual({ command: 'run password="[REDACTED]" next=kept' });
  });

  it('redacts an escaped single-quoted value to its escaped closing quote', () => {
    const input = join('password=', "\\'", 'abc def', "\\'", ' next=kept');

    const redacted = redactSecrets(input);

    expect(redacted).toBe("password=\\'[REDACTED]\\' next=kept");
    expect(redacted).not.toContain('abc');
  });

  it('keeps an escaped backslash inside an escaped quoted value', () => {
    const input = JSON.stringify({ command: join('password="domain', '\\', 'user pass" ok') });
    expect(input).toContain('password=\\"domain\\\\user pass\\"');

    const redacted = redactSecrets(input);

    expect(redacted).toBe('{"command":"password=\\"[REDACTED]\\" ok"}');
    expect(redacted).not.toContain('user');
    expect(JSON.parse(redacted)).toEqual({ command: 'password="[REDACTED]" ok' });
  });

  describe('a quoted value with no closing quote on its line', () => {
    const probe = join('audit', 'Only', 'Alpha', 'Beta', '98765');

    it('redacts an unclosed escaped quoted value to the line end', () => {
      const input = join('password=', '\\"', probe);
      const redacted = redactSecrets(input);
      expect(redacted).toBe('password=\\"[REDACTED]');
      expect(redacted).not.toContain(probe);
      expect(secretRanges(input)).toEqual([
        { start: 'password=\\"'.length, end: input.length, marker: '[REDACTED]' },
      ]);
    });

    it('redacts an unclosed plain or single-quoted value to the line end, keeping the next line', () => {
      for (const quote of ['"', "'", "\\'"]) {
        const input = join('run password=', quote, 'abc', ' def', '\nnext=kept');
        const redacted = redactSecrets(input);
        expect(redacted, quote).toBe(`run password=${quote}[REDACTED]\nnext=kept`);
        expect(redacted, quote).not.toContain('abc');
        expect(redacted, quote).not.toContain('def');
      }
      const crlf = redactSecrets(join('token: "', DB_PASSWORD, '\r\nnext'));
      expect(crlf).toBe('token: "[REDACTED]\r\nnext');
    });

    it('stops an unclosed escaped value at the bare quote that ends its JSON string', () => {
      const line = JSON.stringify({ msg: join('login password="', probe), level: 'info' });
      const redacted = redactSecrets(line);
      expect(redacted).not.toContain(probe);
      expect(JSON.parse(redacted)).toEqual({ msg: 'login password="[REDACTED]', level: 'info' });
    });

    it('leaves closed quoted values as they were', () => {
      expect(redactSecrets(join('password="', probe, '" next=kept'))).toBe(
        'password="[REDACTED]" next=kept'
      );
      expect(redactSecrets(join('password=\\"', probe, '\\" next=kept'))).toBe(
        'password=\\"[REDACTED]\\" next=kept'
      );
      expect(redactSecrets(join("password='", probe, "' next=kept"))).toBe(
        "password='[REDACTED]' next=kept"
      );
    });

    it('redacts an unclosed JSON-key value to the line end', () => {
      const cases: [string, string][] = [
        [join('{"password": "', probe), '{"password": "[REDACTED]'],
        [join('\\"password\\":\\"', probe), '\\"password\\":\\"[REDACTED]'],
        [join('"password":\\"', probe), '"password":\\"[REDACTED]'],
        [join('\\"password\\":"', probe), '\\"password\\":"[REDACTED]'],
      ];
      for (const [input, expected] of cases) {
        const redacted = redactSecrets(`${input}\nnext=kept`);
        expect(redacted, input).toBe(`${expected}\nnext=kept`);
        expect(redacted, input).not.toContain(probe);
        expect(secretRanges(input), input).toEqual([
          { start: expected.length - '[REDACTED]'.length, end: input.length, marker: '[REDACTED]' },
        ]);
      }
    });

    it('stops an unclosed escaped JSON-key value at the bare quote of a JSON log line', () => {
      const line = join('{"msg":"{\\"password\\":\\"', probe, '","level":"info"}');
      const redacted = redactSecrets(line);
      expect(redacted).not.toContain(probe);
      expect(JSON.parse(redacted)).toEqual({ msg: '{"password":"[REDACTED]', level: 'info' });
    });

    it('leaves closed JSON-key values as they were', () => {
      const plain = JSON.stringify({ password: probe, user: 'kept' });
      expect(redactSecrets(plain)).toBe('{"password":"[REDACTED]","user":"kept"}');
      const nested = JSON.stringify({ payload: plain });
      expect(JSON.parse(JSON.parse(redactSecrets(nested)).payload)).toEqual({
        password: '[REDACTED]',
        user: 'kept',
      });
      expect(redactSecrets(join('"password":\\"', probe, '\\" next'))).toBe(
        '"password":\\"[REDACTED]\\" next'
      );
      expect(redactSecrets(join('\\"password\\":"', probe, '" next'))).toBe(
        '\\"password\\":"[REDACTED]" next'
      );
    });

    it('redacts an unclosed value on each line of a long text, in linear time', () => {
      const line = (n: number) => join('password="', 'a b'.repeat(n));
      const text = (lines: number) => Array.from({ length: lines }, () => line(50)).join('\n');
      const best = (work: () => unknown) => {
        let fastest = Infinity;
        for (let run = 0; run < 5; run++) {
          const started = performance.now();
          work();
          fastest = Math.min(fastest, performance.now() - started);
        }
        return fastest;
      };
      const small = text(400);
      const large = text(1600);
      const lines = redactSecrets(small).split('\n');
      expect(lines.every((each) => each === 'password="[REDACTED]')).toBe(true);
      best(() => redactSecrets(small));
      const smallTime = best(() => redactSecrets(small));
      const largeTime = best(() => redactSecrets(large));
      expect(largeTime).toBeLessThan(250);
      expect(largeTime / Math.max(smallTime, 1)).toBeLessThan(8);
      const oneLine = `password="${'x'.repeat(80_000)}`;
      const started = performance.now();
      expect(redactSecrets(oneLine)).toBe('password="[REDACTED]');
      expect(performance.now() - started).toBeLessThan(250);
    });
  });

  it('keeps the labelled markers for known token shapes', () => {
    expect(redactSecrets(`token ${GITHUB_TOKEN} used`)).toBe('token [REDACTED_GITHUB_TOKEN] used');
  });

  it('leaves URL credentials to the separate pattern', () => {
    const url = `postgres://app:${DB_PASSWORD}@db.example.com/main`;

    expect(redactSecrets(url)).toBe(url);
    expect(redactUrlCredentials(url)).toBe('postgres://[REDACTED_CREDENTIALS]@db.example.com/main');
  });

  it('exports the pattern lists read-only', () => {
    expect(Object.isFrozen(SECRET_PATTERNS)).toBe(true);
    expect(Object.isFrozen(URL_CREDENTIALS_PATTERN)).toBe(true);
  });

  it('stays fast on 20 000 characters of adversarial input', () => {
    const chunk = 'password="' + '\\"'.repeat(10) + 'a-b_c-' + '"password":"\\' + '\\"x: ';
    const input = chunk.repeat(Math.ceil(20_000 / chunk.length)).slice(0, 20_000);
    const unclosed = `password="${'a'.repeat(19_990)}`;
    const qualifiers = 'a-'.repeat(10_000);
    const escapedUnclosed = `password=\\"${'a\\b'.repeat(6_660)}`;
    const backslashes = `token=${'\\'.repeat(19_990)}`;

    const started = performance.now();
    for (const value of [input, unclosed, qualifiers, escapedUnclosed, backslashes]) {
      redactSecrets(value);
    }
    const elapsed = performance.now() - started;

    expect(input).toHaveLength(20_000);
    expect(elapsed).toBeLessThan(1000);
  });

  it('redacts a token on the next line of a serialized string', () => {
    const secret = join('sk', '-', 'A'.repeat(24));
    for (const space of ['\n', '\t', '\r\n']) {
      const command = `cat <<'EOF'${space}${secret}${space}EOF`;
      const logged = redactSecrets(JSON.stringify({ command }));
      expect(logged, JSON.stringify(space)).not.toContain(secret);
      expect(logged).toContain('[REDACTED_OPENAI_KEY]');
    }
    const output = redactSecrets(JSON.stringify({ output: `done\n${GITHUB_TOKEN}` }));
    expect(output).toBe('{"output":"done\\n[REDACTED_GITHUB_TOKEN]"}');
  });

  it('redacts a keyed value on the next line of a serialized string', () => {
    const logged = redactSecrets(JSON.stringify({ command: `env\npassword=${DB_PASSWORD}` }));
    expect(logged).toBe('{"command":"env\\npassword=[REDACTED]"}');
  });

  it('redacts a key that starts after dashes or inside a qualifier chain', () => {
    expect(redactSecrets(`run --password=${DB_PASSWORD}`)).toBe('run --password=[REDACTED]');
    expect(redactSecrets(`run --db-password=${DB_PASSWORD}`)).toBe('run --db-password=[REDACTED]');
    expect(redactSecrets(`APP_BOT_TOKEN=${DB_PASSWORD}`)).toBe('APP_BOT_TOKEN=[REDACTED]');
    expect(redactSecrets(`my.password=${DB_PASSWORD}`)).toBe('my.password=[REDACTED]');
  });

  it('redacts mixed quoting: a plain key with an escaped value, and the reverse', () => {
    expect(redactSecrets(`{"password":\\"${DB_PASSWORD}\\"}`)).toBe(
      '{"password":\\"[REDACTED]\\"}'
    );
    expect(redactSecrets(`{\\"password\\":"${DB_PASSWORD}"}`)).toBe(
      '{\\"password\\":"[REDACTED]"}'
    );
  });

  it('matches a long qualifier chain in linear time', () => {
    const input = (n: number) => `${'a-'.repeat(n)}!\npassword=${DB_PASSWORD}`;
    const time = (value: string) => {
      let best = Infinity;
      for (let run = 0; run < 5; run++) {
        const started = performance.now();
        redactSecrets(value);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const small = input(10_000);
    const large = input(40_000);
    expect(redactSecrets(large)).toContain('password=[REDACTED]');
    time(small);
    const ratio = time(large) / Math.max(time(small), 0.05);
    expect(ratio).toBeLessThan(8);

    const started = performance.now();
    redactSecrets(large);
    expect(large.length).toBeGreaterThan(80_000);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('PEM blocks and JWTs', () => {
  const PEM_LABEL = '[REDACTED_PEM_BLOCK]';
  const pemEntry = SECRET_PATTERNS.find(([, replacement]) => replacement === PEM_LABEL);
  /** The lazy expression the scan replaces, as the reference for what it finds. */
  const lazy = () => /-----BEGIN[^-\n]{1,40}-----[\s\S]+?-----END[^-\n]{1,40}-----/g;
  const begin = (label: string) => `-----BEGIN ${label}-----`;
  const end = (label: string) => `-----END ${label}-----`;
  const KEY = 'RSA PRIVATE KEY';
  const BODY = join('MIIB', 'ogIBAAJ', 'Bq9vX2k');

  const corpus = [
    `${begin(KEY)}\n${BODY}\n${end(KEY)}`,
    `a ${begin(KEY)}\n${BODY}\n${end(KEY)} b ${begin('X')}\n${BODY}\n${end('X')} c`,
    `${begin(KEY)}\n${BODY}\n`,
    `${begin('A')}\n${begin('B')}\n${BODY}\n${end('B')}\n${end('A')}`,
    `${begin('A')}${end('A')}`,
    `${begin('A')}-${end('A')}`,
    `${begin('A')}\n${end('A')}`,
    `${end('A')}\n${begin('A')}\n${BODY}\n${end('A')}`,
    `-${begin('A')}\n${BODY}\n-${end('A')}-`,
    `${begin('x'.repeat(41))}\n${BODY}\n${end('A')}`,
    `${begin('x'.repeat(40))}\n${BODY}\n${end('y'.repeat(41))}\n${end('A')}`,
    `${begin('A\nB')}\n${BODY}\n${end('A')}`,
    `${begin('A')}\n${BODY}\n${end('A')}\n${begin('B')}\n${BODY}`,
    JSON.stringify({ key: `${begin(KEY)}\n${BODY}\n${end(KEY)}` }),
    '',
    'no armor here',
  ];

  /** A random text of armor lines and their pieces, from a fixed seed. */
  const pieces = [begin('A'), end('A'), '-----BEGIN ', '-----END ', '-----', '-', '\n', 'x', ' '];
  let seed = 7;
  const random = (below: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % below;
  };
  const randomText = () =>
    Array.from({ length: random(12) }, () => pieces[random(pieces.length)]).join('');

  it('finds the PEM blocks the lazy expression found, in redactSecrets and secretRanges', () => {
    if (pemEntry === undefined) throw new Error('No PEM pattern.');
    const [pattern] = pemEntry;
    const reference: [RegExp, string][] = [[lazy(), PEM_LABEL]];
    const texts = [...corpus, ...Array.from({ length: 3000 }, randomText)];
    let matched = 0;
    for (const text of texts) {
      const expected = text.replace(lazy(), PEM_LABEL);
      if (expected !== text) matched++;
      expect(text.replace(pattern, PEM_LABEL), text).toBe(expected);
      expect(secretRanges(text, [pemEntry]), text).toEqual(secretRanges(text, reference));
    }
    // The random texts reach both outcomes, not only texts without a block.
    expect(matched).toBeGreaterThan(100);
    expect(matched).toBeLessThan(texts.length - 100);
    expect(redactSecrets(corpus[0]!)).toBe(PEM_LABEL);
    expect(redactSecrets(corpus[1]!)).toBe(`a ${PEM_LABEL} b ${PEM_LABEL} c`);
    expect(redactSecrets(corpus[2]!)).toBe(corpus[2]);
    expect(redactSecrets(corpus[13]!)).toBe(`{"key":"${PEM_LABEL}"}`);
  });

  it('redacts a JWT at the start of a run, after a separator and after a JSON escape', () => {
    const jwt = join('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJ', 'zdWIiOiIxMjM0In0', '.', 'Sf1KxwRJ');
    for (const before of [
      '',
      ' ',
      '(',
      '"',
      '=',
      '.',
      ':',
      '/',
      '-',
      'foo-',
      '\\n',
      '\\t',
      '\\r',
    ]) {
      expect(redactSecrets(`${before}${jwt} end`), before).toBe(`${before}[REDACTED_JWT] end`);
    }
    expect(redactSecrets(JSON.stringify({ log: `got\n${jwt}` }))).toBe(
      '{"log":"got\\n[REDACTED_JWT]"}'
    );
  });
});

describe('JWTs against the expression the scan stands for', () => {
  const JWT_LABEL = '[REDACTED_JWT]';
  const jwtEntry = SECRET_PATTERNS.find(([, replacement]) => replacement === JWT_LABEL);
  /** The logger's base rule, with the JSON-escape starts, as the reference for what the scan finds. */
  const base = () =>
    /(?:\b|(?<=\\[nrt]))eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
  const SEGMENT = join('hbGci', 'OiJIU');
  const JWT = join('eyJ', SEGMENT, '.', 'eyJ', SEGMENT, '.', SEGMENT);

  const corpus = [
    JWT,
    `-${JWT}`,
    `foo-${JWT}`,
    `foo_${JWT}`,
    `x${JWT}`,
    `${JWT}-`,
    `${JWT}-tail`,
    `${JWT}_`,
    `${JWT}.${JWT}`,
    `${JWT}-${JWT}`,
    `eyJ${SEGMENT}-${JWT}`,
    `eyJ${SEGMENT}-eyJ${SEGMENT}.eyJ${SEGMENT}.${SEGMENT}`,
    `eyJ${SEGMENT}.eyJ${SEGMENT}.-------a`,
    `eyJ${SEGMENT}.eyJ${SEGMENT}.abcdefgh-`,
    `eyJ${SEGMENT}.eyJ${SEGMENT}.abcdefg-`,
    `eyJ${SEGMENT}.eyJ${SEGMENT}.abcdefgh--b-c`,
    `eyJabcdefg.eyJ${SEGMENT}.${SEGMENT}`,
    `eyJ${SEGMENT}.eyJ${SEGMENT}`,
    JSON.stringify({ log: `got\n${JWT}` }),
    JSON.stringify({ log: `got\n-${JWT}\tx${JWT}` }),
    `\\n${JWT}`,
    `\\x${JWT}`,
    '',
    'no token here',
  ];

  /** A random text of JWT pieces and what may stand between them, from a fixed seed. */
  const pieces = [
    'eyJ',
    SEGMENT,
    'abc',
    '.',
    '.',
    '-',
    '_',
    '\\n',
    '\\',
    'n',
    ' ',
    '"',
    `eyJ${SEGMENT}.eyJ${SEGMENT}.`,
    `eyJ${SEGMENT}.`,
    `-eyJ${SEGMENT}`,
  ];
  let seed = 11;
  const random = (below: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % below;
  };
  const randomText = () =>
    Array.from({ length: random(10) }, () => pieces[random(pieces.length)]).join('');

  it('finds the JWTs the base expression found, in redactSecrets and secretRanges', () => {
    if (jwtEntry === undefined) throw new Error('No JWT pattern.');
    const [pattern] = jwtEntry;
    const reference: [RegExp, string][] = [[base(), JWT_LABEL]];
    const texts = [...corpus, ...Array.from({ length: 3000 }, randomText)];
    let matched = 0;
    for (const text of texts) {
      const expected = text.replace(base(), JWT_LABEL);
      if (expected !== text) matched++;
      expect(text.replace(pattern, JWT_LABEL), text).toBe(expected);
      expect(secretRanges(text, [jwtEntry]), text).toEqual(secretRanges(text, reference));
    }
    // The random texts reach both outcomes, not only texts without a token.
    expect(matched).toBeGreaterThan(100);
    expect(matched).toBeLessThan(texts.length - 100);
    expect(redactSecrets(corpus[1]!)).toBe(`-${JWT_LABEL}`);
    expect(redactSecrets(corpus[2]!)).toBe(`foo-${JWT_LABEL}`);
    expect(redactSecrets(corpus[18]!)).toBe(`{"log":"got\\n${JWT_LABEL}"}`);
  });
});

describe('redactUrlCredentials', () => {
  it('redacts the password of a URL with an empty user', () => {
    const url = `redis://:${join('Redis', 'Secret', 'Q7')}@cache:6379/0`;
    expect(redactUrlCredentials(url)).toBe('redis://[REDACTED_CREDENTIALS]@cache:6379/0');
    expect(redactUrlCredentials(`redis://default:${DB_PASSWORD}@cache`)).toBe(
      'redis://[REDACTED_CREDENTIALS]@cache'
    );
  });

  it('redacts a scheme after a space, a bracket, a quote, an equals sign and a JSON escape', () => {
    const url = `https://user:${DB_PASSWORD}@example.com`;
    const redacted = 'https://[REDACTED_CREDENTIALS]@example.com';
    for (const before of ['', 'see ', '(', '"', 'url=', '\\n', '\\t', '\\r']) {
      expect(redactUrlCredentials(`${before}${url}`), before).toBe(`${before}${redacted}`);
    }
    expect(redactUrlCredentials(JSON.stringify({ log: `db\n${url}` }))).toBe(
      `{"log":"db\\n${redacted}"}`
    );
    expect(redactUrlCredentials(`postgres://app:${DB_PASSWORD}@db/main`)).toBe(
      'postgres://[REDACTED_CREDENTIALS]@db/main'
    );
  });

  it('redacts a URL after +, - and . (diff lines, x-https://)', () => {
    const url = `https://reader:${join('Qv9L', 'p2Zx')}@db.example.test/x`;
    const diff = `@@ -1 +1 @@\n-${url}\n+${url}\n`;
    expect(redactUrlCredentials(diff)).toBe(
      '@@ -1 +1 @@\n' +
        '-https://[REDACTED_CREDENTIALS]@db.example.test/x\n' +
        '+https://[REDACTED_CREDENTIALS]@db.example.test/x\n'
    );
    for (const before of ['+', '-', '.', 'x-', 'a+b.']) {
      expect(redactUrlCredentials(`${before}${url}`), before).toBe(
        `${before}https://[REDACTED_CREDENTIALS]@db.example.test/x`
      );
    }
    // The desktop logger's case: a DSN on an added diff line.
    expect(redactUrlCredentials(`+redis://reader:${join('Qv9L', 'p2Zx')}@db/0`)).toBe(
      '+redis://[REDACTED_CREDENTIALS]@db/0'
    );
  });

  it('leaves a :// with no scheme character before it alone', () => {
    const text = `see ://user:${DB_PASSWORD}@host`;
    expect(redactUrlCredentials(text)).toBe(text);
  });
});

describe('scaling on long runs of the scheme, qualifier, PEM and JWT characters', () => {
  const runs = ['a-', 'a.', 'a+'];
  const url = `postgres://app:${DB_PASSWORD}@db`;
  const input = (unit: string, n: number) => `${unit.repeat(n)}!\npassword=${DB_PASSWORD} ${url}`;
  // A BEGIN line repeated with no END, and JWT-shaped runs with no dot.
  const pem = (n: number) => '-----BEGIN PRIVATE KEY-----\n'.repeat(n) + '!';
  const jwt = (n: number) => ('eyJ' + 'a'.repeat(9) + '-').repeat(n) + '!';
  /** Each case: its label, the input for `n`, and the `n` it is measured at (and at 4n). */
  const cases: [string, (n: number) => string, number][] = [
    ...runs.map((unit): [string, (n: number) => string, number] => [
      unit,
      (n) => input(unit, n),
      10_000,
    ]),
    ['PEM', pem, 2_000],
    ['JWT', jwt, 2_000],
    // `://` repeated (after a scheme character, so each one is
    // tried), and one `://:` followed by a long run with no `@`.
    ['://', (n) => 'a' + '://'.repeat(n) + '!', 10_000],
    ['a://:', (n) => 'a://:'.repeat(n) + '!', 10_000],
    ['://:a', (n) => 'a://:' + 'a'.repeat(n) + '!', 10_000],
    // A quoted value that never closes, plain and escaped.
    ['unclosed "', (n) => 'password="' + 'a b\\'.repeat(n), 10_000],
    ['unclosed \\"', (n) => 'password=\\"' + 'a \\\\b'.repeat(n), 10_000],
    // An unclosed JSON-key value, plain and escaped.
    ['unclosed "key":"', (n) => '"password":"' + 'a b\\n'.repeat(n), 10_000],
    ['unclosed \\"key\\":\\"', (n) => '\\"password\\":\\"' + 'a \\\\b'.repeat(n), 10_000],
  ];
  const best = (work: () => unknown) => {
    let fastest = Infinity;
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      work();
      fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
  };
  /** Linear: 4x the input takes well under 16x the time, and the largest case well under a second. */
  const expectLinear = (label: string, work: (value: string) => unknown) => {
    for (const [name, make, n] of cases) {
      const small = make(n);
      const large = make(4 * n);
      best(() => work(small));
      const smallTime = best(() => work(small));
      const largeTime = best(() => work(large));
      expect(largeTime, `${label} on ${name}`).toBeLessThan(250);
      expect(largeTime / Math.max(smallTime, 1), `${label} on ${name}`).toBeLessThan(8);
    }
  };

  it('keeps every secret pattern linear', () => {
    SECRET_PATTERNS.forEach(([pattern, replacement], index) => {
      expectLinear(`SECRET_PATTERNS[${index}]`, (value) =>
        value.replace(pattern, replacement as string)
      );
    });
  });

  it('keeps the URL credentials pattern linear', () => {
    expectLinear('URL_CREDENTIALS_PATTERN', redactUrlCredentials);
    for (const unit of runs) {
      expect(redactUrlCredentials(input(unit, 10_000))).toContain(
        'postgres://[REDACTED_CREDENTIALS]@db'
      );
    }
  });

  it('keeps redactSecrets and secretRanges linear', () => {
    expectLinear('redactSecrets', redactSecrets);
    expectLinear('secretRanges', (value) => secretRanges(value));
    expectLinear('secretRanges with URL credentials', (value) =>
      secretRanges(value, [...SECRET_PATTERNS, URL_CREDENTIALS_PATTERN])
    );
  });
});

describe('secretRanges', () => {
  it('gives the secret part of a keyed value, without the key name, separator and quotes', () => {
    const text = `{"password": "${DB_PASSWORD}"} token=${DB_PASSWORD}`;
    const ranges = secretRanges(text);
    expect(ranges.map(({ start, end }) => text.slice(start, end))).toEqual([
      DB_PASSWORD,
      DB_PASSWORD,
    ]);
    expect(ranges.map(({ marker }) => marker)).toEqual(['[REDACTED]', '[REDACTED]']);
  });

  it('gives a whole token with its label, and URL credentials when asked for them', () => {
    const url = `postgres://app:${DB_PASSWORD}@db`;
    const text = `use ${GITHUB_TOKEN} and ${url}`;
    expect(secretRanges(text)).toEqual([
      { start: 4, end: 4 + GITHUB_TOKEN.length, marker: '[REDACTED_GITHUB_TOKEN]' },
    ]);
    const [credentials] = secretRanges(text, [URL_CREDENTIALS_PATTERN]);
    expect(text.slice(credentials!.start, credentials!.end)).toBe(`app:${DB_PASSWORD}`);
    expect(credentials!.marker).toBe('[REDACTED_CREDENTIALS]');
  });

  it('searches every pattern in the same text', () => {
    const text = `${GITHUB_TOKEN} password=${DB_PASSWORD}`;
    const ranges = secretRanges(text).map(({ start, end }) => text.slice(start, end));
    // The keyed value is found first, as the patterns are ordered.
    expect(ranges).toEqual([DB_PASSWORD, GITHUB_TOKEN]);
  });

  it('leaves out a match inside a range of an earlier pattern, so its label stays', () => {
    const anthropic = join('sk', '-ant-', 'B'.repeat(24));
    expect(secretRanges(`use ${anthropic} now`)).toEqual([
      { start: 4, end: 4 + anthropic.length, marker: '[REDACTED_ANTHROPIC_KEY]' },
    ]);
    const text = `token=${GITHUB_TOKEN}`;
    expect(secretRanges(text)).toEqual([{ start: 6, end: text.length, marker: '[REDACTED]' }]);
  });

  it('leaves out an empty quoted value', () => {
    expect(secretRanges('password=""')).toEqual([]);
  });
});
