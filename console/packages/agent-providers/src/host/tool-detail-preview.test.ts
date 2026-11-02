import { describe, expect, it } from 'vitest';
import { Redactions } from './redaction';
import { TOOL_INPUT_STRING_LIMIT, type ToolDetailParts } from './tool-detail-buffer';
import { TOOL_DETAIL_INPUT, TOOL_DETAIL_PREVIEW, toolDetailPreview } from './tool-detail-preview';

// Every secret-shaped fixture is assembled at runtime, so no scanner reads the
// source as holding a real one.
const GITHUB = ['ghp', 'A'.repeat(36)].join('_');
const SESSION_TOKEN = ['synthetic', 'session', 'token', '0123456789'].join('-');

function parts(overrides: Partial<ToolDetailParts>): ToolDetailParts {
  return {
    input: null,
    head: '',
    tail: '',
    outputClipped: false,
    hasOutput: false,
    exitCode: null,
    ...overrides,
  };
}

function withSessionToken(): Redactions {
  const redactions = new Redactions();
  redactions.add(SESSION_TOKEN);
  return redactions;
}

describe('a tool call preview', () => {
  it('shows a command as the command, then what it printed', () => {
    expect(
      toolDetailPreview(
        parts({ input: { command: 'pytest -q' }, head: '12 passed', hasOutput: true }),
        null
      )
    ).toBe('$ pytest -q\n12 passed');
  });

  it('shows other arguments as they were given, and a failing exit code', () => {
    expect(
      toolDetailPreview(parts({ input: { path: 'src/app.py', limit: 20 }, exitCode: 2 }), null)
    ).toBe('{"path":"src/app.py","limit":20}\nexit code 2');
  });

  it('is nothing for a call nothing is held of', () => {
    expect(toolDetailPreview(parts({}), null)).toBeNull();
  });
});

describe('redaction', () => {
  it('masks credentials by pattern in the input and the output', () => {
    const preview = toolDetailPreview(
      parts({
        input: { command: `curl -H "Authorization: Bearer ${GITHUB}" api` },
        head: `{"token": "${GITHUB}"}`,
        hasOutput: true,
      }),
      null
    );
    expect(preview).not.toContain(GITHUB);
    expect(preview).toContain('[REDACTED');
  });

  it('masks the password in a connection string, and keeps the rest of it', () => {
    const password = ['hunter', '2', 'x'].join('');
    const preview = toolDetailPreview(
      parts({ input: { command: `psql postgres://app:${password}@db.example.test/app` } }),
      null
    );
    expect(preview).toBe('$ psql postgres://[REDACTED_CREDENTIALS]@db.example.test/app');
  });

  it('masks the exact values the session was handed, in every form', () => {
    const preview = toolDetailPreview(
      parts({
        input: { command: 'printenv' },
        head: `SWITCH=${SESSION_TOKEN}\n${encodeURIComponent(SESSION_TOKEN)}`,
        hasOutput: true,
      }),
      withSessionToken()
    );
    expect(preview).not.toContain(SESSION_TOKEN);
    expect(preview).toContain('[REDACTED]');
  });
});

describe('a clipped output', () => {
  it('drops the line each cut ran through, so a secret split by a cut leaves nothing', () => {
    // The buffer kept the token's first half at the end of the head and its
    // second half at the start of the tail: neither half matches anything.
    const half = Math.floor(SESSION_TOKEN.length / 2);
    const preview = toolDetailPreview(
      parts({
        input: { command: 'cat log' },
        head: `first line\nsecond line\nauth ${SESSION_TOKEN.slice(0, half)}`,
        tail: `${SESSION_TOKEN.slice(half)} accepted\nlast line`,
        outputClipped: true,
        hasOutput: true,
      }),
      withSessionToken()
    );
    expect(preview).toBe(
      '$ cat log\nfirst line\nsecond line\n… (the middle of the output was not kept) …\nlast line'
    );
    expect(preview).not.toContain(SESSION_TOKEN.slice(0, 6));
    expect(preview).not.toContain(SESSION_TOKEN.slice(-6));
  });

  it('redacts each kept part on its own', () => {
    const preview = toolDetailPreview(
      parts({
        head: `token=${GITHUB}\nmore\n`,
        tail: `cut\nsecret: ${GITHUB}\nend`,
        outputClipped: true,
        hasOutput: true,
      }),
      null
    );
    expect(preview).not.toContain(GITHUB);
    expect(preview).toContain('(the middle of the output was not kept)');
  });

  it('still gets a preview when a part has no whole line left', () => {
    expect(
      toolDetailPreview(
        parts({ head: 'x'.repeat(50), tail: 'y'.repeat(50), outputClipped: true, hasOutput: true }),
        null
      )
    ).toBe('… (the middle of the output was not kept) …');
  });
});

describe('a clipped input string', () => {
  it('drops the word the clip ran through', () => {
    const half = Math.floor(SESSION_TOKEN.length / 2);
    const command = `${'a '.repeat((TOOL_INPUT_STRING_LIMIT - half) / 2)}${SESSION_TOKEN}`;
    const clipped = `${command.slice(0, TOOL_INPUT_STRING_LIMIT)}…`;
    const preview = toolDetailPreview(parts({ input: { command: clipped } }), withSessionToken());
    expect(preview).not.toContain(SESSION_TOKEN.slice(0, 6));
    // Far past the input's share, so it ends with that cut's note.
    expect(preview).toMatch(/\[input cut, \d+ more characters\]$/);
  });
});

describe('the size', () => {
  const notedLeft = (text: string, what: string) => {
    const found = new RegExp(`\\[${what} cut, (\\d+) more characters\\]`).exec(text);
    return found ? Number(found[1]) : null;
  };

  it('fits the whole preview in its size, the output saying how much it left out', () => {
    const preview = toolDetailPreview(
      parts({ head: 'z'.repeat(TOOL_DETAIL_PREVIEW * 2), hasOutput: true }),
      null
    )!;
    expect(preview.length).toBeLessThanOrEqual(TOOL_DETAIL_PREVIEW);
    const left = notedLeft(preview, 'output');
    expect(left).not.toBeNull();
    expect(preview.indexOf('\n[output cut') + left!).toBe(TOOL_DETAIL_PREVIEW * 2);
  });

  it('gives the input at most its share, with a note of its own, and the output the rest', () => {
    const preview = toolDetailPreview(
      parts({
        input: { command: 'a'.repeat(2000) },
        head: 'b'.repeat(4000),
        hasOutput: true,
      }),
      null
    )!;
    const [input] = preview.split('\n[input cut');
    expect(input!.length).toBeLessThan(TOOL_DETAIL_INPUT);
    expect(notedLeft(preview, 'input')).not.toBeNull();
    expect(notedLeft(preview, 'output')).not.toBeNull();
    expect(preview.length).toBeLessThanOrEqual(TOOL_DETAIL_PREVIEW);
  });

  it('leaves a short input and output whole, with no note', () => {
    const preview = toolDetailPreview(
      parts({ input: { command: 'ls' }, head: 'a.txt', hasOutput: true }),
      null
    );
    expect(preview).toBe('$ ls\na.txt');
  });
});

describe('a private key split by a cut', () => {
  // Assembled so no scanner reads the fixture as a key.
  const BEGIN = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const END = ['-----END', 'PRIVATE KEY-----'].join(' ');
  const BODY = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7'];

  it('is masked to the end of the head when the cut fell inside it', () => {
    const preview = toolDetailPreview(
      parts({
        head: `reading key\n${BEGIN}\n${BODY[0]}\n${BODY[1]}\npartial`,
        tail: 'cut\nafter',
        outputClipped: true,
        hasOutput: true,
      }),
      null
    )!;
    for (const line of BODY) expect(preview).not.toContain(line);
    expect(preview).toContain('reading key\n[REDACTED_PEM_BLOCK]');
  });

  it('is masked from the start of the tail when it closes there', () => {
    const preview = toolDetailPreview(
      parts({
        head: 'before\ncut',
        tail: `partial\n${BODY[0]}\n${BODY[1]}\n${END}\nafter the key`,
        outputClipped: true,
        hasOutput: true,
      }),
      null
    )!;
    for (const line of BODY) expect(preview).not.toContain(line);
    expect(preview).toContain('[REDACTED_PEM_BLOCK]\nafter the key');
  });

  it('is masked in an input string the buffer clipped inside it', () => {
    const key = `${BEGIN}\n${BODY[0]}\n${BODY[1]}\n`;
    const content = `${key}${'q '.repeat(TOOL_INPUT_STRING_LIMIT)}`;
    const clipped = `${content.slice(0, TOOL_INPUT_STRING_LIMIT)}…`;
    const preview = toolDetailPreview(parts({ input: { path: 'k.pem', content: clipped } }), null)!;
    for (const line of BODY) expect(preview).not.toContain(line);
    expect(preview).toContain('[REDACTED_PEM_BLOCK]');
  });

  it('is left to the whole-block pattern when no cut ran through it', () => {
    const preview = toolDetailPreview(
      parts({ head: `${BEGIN}\n${BODY[0]}\n${END}\ndone`, hasOutput: true }),
      null
    );
    expect(preview).toBe('[REDACTED_PEM_BLOCK]\ndone');
  });
});
