import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildRegistry,
  containsKnownForm,
  isMarker,
  MARKER,
  markerRangesOf,
  norm,
  normShown,
  redactShown,
  redactText,
} from './tool-detail-redaction';

// Every secret below is synthetic and put together at run time.
const ESC = '\x1b';
const ZW = '\u200b';
const github = (prefix: string) => `gh${prefix}_${'A'.repeat(10)}${'B'.repeat(26)}`;

const shown = (raw: string, values: readonly string[] = []) =>
  redactText(raw, buildRegistry(values)).text;

describe('norm', () => {
  it('removes control sequences and invisible characters, and ends every line with \\n', () => {
    const raw = `a${ESC}[31mb${ESC}]0;title\x07c\x00d\x7fe\x85f\u202eg${ZW}h\r\ni\rj\tk`;
    expect(norm(raw)).toBe('abcdefgh\ni\nj\tk');
  });

  it('removes the same controls written as escaped text', () => {
    // `\u009b` starts a CSI sequence, as a real U+009B does.
    const raw = String.raw`a\u001b[31mb\x1b[0mc\u0007d\x1be\u009b1mf\u000ag\nh`;
    expect(norm(raw)).toBe(String.raw`abcdef\u000ag\nh`);
  });

  it('removes escaped OSC strings up to BEL or ST, and escaped C1 CSI and OSC', () => {
    expect(norm(String.raw`a\u001b]0;title\u0007b\x1b]8;;x\x1b\\c\u001b]2;t\u009cd`)).toBe('abcd');
    expect(norm(String.raw`a\u009b31mb\u009d0;t\u0007c`)).toBe('abc');
    expect(norm(`a\\u001b]0;t\\u0007b`)).toBe('ab');
    // A string written as escaped text ends only at a terminator written so
    // too, and one opened by the character itself only at a real one.
    expect(normShown(`a\\u001b]0;t\x07b`)).toEqual({ text: 'a', unterminated: true });
    expect(normShown(`a${ESC}]0;t\\x07b`)).toEqual({ text: 'a', unterminated: true });
    expect(normShown(`a${ESC}]0;t\\x07b\x07c`)).toEqual({ text: 'ac', unterminated: false });
    // `\x9d` is not read as an opener: `\xXX` stands for a control only for ESC.
    const c1 = String.raw`a\x9d0;b`;
    expect(normShown(c1)).toEqual({ text: c1, unterminated: false });
    // Python and Go print only ESC as `\xXX`; `\x07` stays as written.
    expect(norm(String.raw`a\x07b`)).toBe(String.raw`a\x07b`);
  });

  it('removes bidi and zero-width characters written as \\uXXXX', () => {
    const raw = String.raw`ab\u200bc\u202Ed\u2060e\uFEFFf\u0041g\u200ah`;
    // `\u0041` and `\u200a` (a hair space) are neither: they stay as written.
    expect(norm(raw)).toBe(String.raw`abcdef\u0041g\u200ah`);
    expect(norm(`ab${ZW}cd`)).toBe('abcd');
  });

  it('says when an OSC string with no terminator hid the rest of the text', () => {
    for (const opener of [
      `${ESC}]`,
      '\x9d',
      String.raw`\u001b]`,
      String.raw`\x1b]`,
      String.raw`\\u001b]`,
    ])
      expect(normShown(`kept ${opener}0;title and the rest`), opener).toEqual({
        text: 'kept ',
        unterminated: true,
      });
    expect(normShown(`kept ${ESC}]0;title\x07 and the rest`)).toEqual({
      text: 'kept  and the rest',
      unterminated: false,
    });
    expect(normShown(`kept ${ESC}]0;title\x07`)).toEqual({ text: 'kept ', unterminated: false });
  });
});

describe('registry', () => {
  it('takes each line of six characters or more as a base, without PEM armor', () => {
    const value = 'line-one-secret\nabc\n-----BEGIN PRIVATE KEY-----\nMIIsecretline';
    expect(buildRegistry([value]).bases).toEqual([value, 'line-one-secret', 'MIIsecretline']);
  });

  it('takes a line of exactly six characters as a base, not one of five', () => {
    const six = ['Ab3', 'dE6'].join('');
    const value = [['q7Lm', '2Xp9', 'Rt4V'].join(''), six, 'Zz9y1'].join('\n');
    const registry = buildRegistry([value]);
    expect(registry.bases).toContain(six);
    expect(registry.bases).not.toContain('Zz9y1');
    expect(redactText(`code: ${six}\n`, registry).text).toBe(`code: ${MARKER}\n`);
  });

  it('takes no line without a letter or a digit as a base', () => {
    const value = 'first-line-x9\n' + ' '.repeat(8) + '\nsecond-line-y7';
    expect(buildRegistry([value]).bases).not.toContain(' '.repeat(8));
    const detail = JSON.stringify({ a: { b: { c: { d: 1 } } } }, null, 2);
    expect(shown(detail, [value])).toBe(detail);
  });

  it('takes a value without the white space around it as a base too', () => {
    const value = ` ${['spacey', 'token', '12345'].join('-')}\n`;
    expect(buildRegistry([value]).bases).toContain(value.trim());
    expect(shown(`t=${value.trim()}`, [value])).toBe(`t=${MARKER}`);
    expect(buildRegistry([' \n ']).bases).toEqual([' \n ']);
  });

  it('leaves out a value that is a whole marker, and keeps one that is part of a marker', () => {
    expect(buildRegistry([MARKER, '[REDACTED_GITHUB_TOKEN]']).bases).toEqual([]);
    const parts = ['REDACTED', 'EDACTE', 'GITHUB_TOKEN', '_CREDENTIALS'];
    const registry = buildRegistry(parts);
    expect(registry.bases).toEqual(parts);
    expect(redactText('the REDACTED word', registry).text).toBe(`the ${MARKER} word`);
  });

  it('drops a form that is empty after norm', () => {
    expect(buildRegistry([`${ESC}[31m${ESC}[0m`]).forms).not.toContain('');
  });

  it('has the raw, normalized, JSON-escaped and URL-encoded forms, longest first', () => {
    const value = 'p@ss w/rd+' + 'Zq9xLm7T';
    const { forms } = buildRegistry([value]);
    expect(forms).toEqual(
      expect.arrayContaining([value, encodeURIComponent(value), 'p%40ss+w%2frd%2bZq9xLm7T'])
    );
    const lines = ['first-Line-A1', 'second-Line-B2'].join('\n');
    expect(buildRegistry([lines]).forms).toContain(String.raw`first-Line-A1\nsecond-Line-B2`);
    const lengths = forms.map((form) => form.length);
    expect(lengths).toEqual([...lengths].sort((left, right) => right - left));
  });
});

describe('known values', () => {
  const secret = ['Qm7v', 'R2Xk', '9pT4', 'zz'].join('');

  it('masks overlapping values together, every occurrence', () => {
    expect(shown('abcdefXYZuvwxyz12', ['abcdefXYZ', 'XYZuvwxyz12'])).toBe(MARKER);
    expect(shown('AAAA-12345678-BBBBBBBB', ['AAAA-12345678', '12345678-BBBBBBBB'])).toBe(MARKER);
    expect(shown(`${secret} and ${secret}`, [secret])).toBe(`${MARKER} and ${MARKER}`);
  });

  it('masks a value split by what norm removes, real or written as escaped text', () => {
    const splits = [
      `${ESC}[1m`,
      `${ESC}]0;title\x07`,
      `${ESC}]8;;x${ESC}\\`,
      ESC,
      ZW,
      '\u202e',
      '\x7f',
      String.raw`\u001b[31m`,
      String.raw`\x1b[0m`,
      String.raw`\u001b]0;t\u0007`,
      String.raw`\u200b`,
      String.raw`\u202E`,
      String.raw`\u0007`,
    ];
    for (const split of splits)
      expect(shown(`a ${secret.slice(0, 6)}${split}${secret.slice(6)} b`, [secret]), split).toBe(
        `a ${MARKER} b`
      );
  });

  it('masks a multi-line value seen as one of its lines, whole and JSON-escaped', () => {
    const lines = ['first-Line-A1', 'second-Line-B2'].join('\n');
    expect(shown('see second-Line-B2 ok', [lines])).toBe(`see ${MARKER} ok`);
    expect(shown(`${lines}\n`, [lines])).toBe(`${MARKER}\n`);
    expect(shown(JSON.stringify({ text: lines }), [lines])).toBe(`{"text":"${MARKER}"}`);
  });

  it('masks URL-encoded variants', () => {
    const password = 'p@ss w/rd+' + 'Zq9xLm7T';
    for (const form of [
      encodeURIComponent(password),
      'p%40ss%20w/rd%2BZq9xLm7T', // urllib.parse.quote
      'p%40ss+w%2Frd%2BZq9xLm7T', // urllib.parse.quote_plus
      'p%40ss%20w%2frd%2bZq9xLm7T', // lower-case hex
    ])
      expect(shown(`url=${form}&x=1`, [password]), form).toBe(`url=${MARKER}&x=1`);
  });

  it('masks a known value before the patterns run, so it gets the plain marker', () => {
    const token = github('p');
    expect(shown(`use ${token} now`, [token])).toBe(`use ${MARKER} now`);
    expect(shown(`use ${token} now`)).toBe('use [REDACTED_GITHUB_TOKEN] now');
  });

  it('masks a whole value a pattern would cut at the control sequence', () => {
    const value = `corp-${'gh'}p_AbCd1234EfGh5678IjKl9012MnOp3456QrSt-eu1`;
    const cut = value.indexOf('QrSt') + 1;
    expect(shown(`${value.slice(0, cut)}${ESC}[0m${value.slice(cut)}`, [value])).toBe(MARKER);
  });
});

describe('shared patterns', () => {
  const secret = 'Zq9' + 'xLm7T'.repeat(5);

  it('masks `Authorization: Bot <token>`, which leaked before', () => {
    const token = ['MTk4NjIy', 'NDgzNDcx', 'OTI1MjQ4'].join('') + '.Cl2FMQ.' + secret;
    const masked = shown(`curl -H "Authorization: Bot ${token}" https://discord.example`);
    expect(masked).not.toContain(token);
    expect(masked).not.toContain(secret);
    expect(masked).toContain('Authorization: [REDACTED]');
  });

  it('masks an `xapp-` Slack app token, which leaked before', () => {
    const token = ['xapp', '1', 'A0123456789', '1234567890123', secret].join('-');
    expect(shown(`SLACK_APP=${token}\n`)).toBe('SLACK_APP=[REDACTED_SLACK_TOKEN]\n');
  });

  it('masks Authorization Bearer and Basic, keyed values and JSON keys', () => {
    expect(shown(`Authorization: Bearer ${secret}`)).toBe('Authorization: [REDACTED]');
    const basic = Buffer.from('user:' + secret).toString('base64');
    expect(shown(`Authorization: Basic ${basic}`)).toBe('Authorization: [REDACTED]');
    expect(shown(`DB_PASSWORD=${secret} next`)).toBe('DB_PASSWORD=[REDACTED] next');
    expect(shown(JSON.stringify({ password: secret }, null, 2))).toBe(
      '{\n  "password": "[REDACTED]"\n}'
    );
  });

  it('masks URL credentials, a PEM block and the token prefixes', () => {
    expect(shown(`git clone https://deploy:${secret}@git.example.test/r.git`)).toBe(
      'git clone https://[REDACTED_CREDENTIALS]@git.example.test/r.git'
    );
    const pem = ['-----BEGIN ', 'PRIVATE KEY-----\nMII', secret, '\n-----END ', 'PRIVATE KEY-----'];
    expect(shown(`${pem.join('')}\nafter`)).toBe('[REDACTED_PEM_BLOCK]\nafter');
    for (const [token, label] of [
      ['AKIA' + 'Q7'.repeat(8), 'AWS_KEY'],
      ['sk-ant-' + 'x'.repeat(40), 'ANTHROPIC_KEY'],
      ['sk-proj-' + 'y'.repeat(40), 'OPENAI_KEY'],
      ['glpat-' + 'g'.repeat(20), 'GITLAB_TOKEN'],
      ['gh' + 'p_' + 'P'.repeat(36), 'GITHUB_TOKEN'],
    ] as const)
      expect(shown(`use ${token} now`)).toBe(`use [REDACTED_${label}] now`);
  });

  it('masks an unregistered token split by a zero-width character, as norm shows it', () => {
    const token = github('p');
    expect(shown(`echo ${token.slice(0, 14)}${ZW}${token.slice(14)} done`)).toBe(
      'echo [REDACTED_GITHUB_TOKEN] done'
    );
  });
});

describe('search view', () => {
  const secret = ['Qm7v', 'R2Xk', '9pT4', 'zz'].join('');
  /** `char` as JSON with non-ASCII escaped writes it: each UTF-16 unit as `\uXXXX`. */
  const spell = (char: string) =>
    [...Array(char.length).keys()]
      .map((unit) => `\\u${char.charCodeAt(unit).toString(16).padStart(4, '0')}`)
      .join('');
  const interleaved = (value: string, split: string) => Array.from(value).join(split);

  it('masks a known value interleaved with characters a reader does not see, raw or escaped', () => {
    const registry = buildRegistry([secret]);
    for (const char of ['\u00ad', '\u034f', '\u3164', '\ufe0f', '\u{e0020}', '\u180b'])
      for (const split of [char, spell(char)]) {
        const result = redactText(`a ${interleaved(secret, split)} b`, registry).text;
        expect(result, split).toBe(`a ${MARKER} b`);
        expect(containsKnownForm(result, registry), split).toBe(false);
      }
    expect(spell('\u{e0020}')).toBe(String.raw`\udb40\udc20`);
    for (const split of [String.raw`\u00AD`, String.raw`\uDB40\uDC20`])
      expect(shown(`a ${interleaved(secret, split)} b`, [secret]), split).toBe(`a ${MARKER} b`);
  });

  it('masks whole source units when a value ends on a character of two code units', () => {
    const value = ['Zq9', 'xLm7T', '\u{1f600}'].join('');
    const registry = buildRegistry([value]);
    const raw = `a ${interleaved(value, '\u00ad')} b`;
    expect(redactText(raw, registry)).toEqual({ text: `a ${MARKER} b`, markerRanges: [[2, 12]] });
    const spelled = `a ${value.slice(0, -2)}\u00ad${spell('\u{1f600}')}\ufe0f b`;
    // The variation selector after the value is not part of it and stays.
    expect(shown(spelled, [value])).toBe(`a ${MARKER}\ufe0f b`);
  });

  it('neither hides nor moves what a real double backslash shows', () => {
    const path = String.raw`C:\\Users\\`;
    expect(shown(`${path}x`, [secret])).toBe(`${path}x`);
    expect(shown(`${path}${interleaved(secret, '\u00ad')}\\new`, [secret])).toBe(
      `${path}${MARKER}\\new`
    );
  });

  it('masks a known value split by \\xXX, spelled whole as escapes, or split by a double escape', () => {
    const value = ['sek', 'Ret7', 'Qm2x'].join('');
    const registry = buildRegistry([value]);
    for (const raw of [
      `${value.slice(0, 3)}\\x7f${value.slice(3)}`,
      `${value.slice(0, 3)}\\x00${value.slice(3)}`,
      Array.from(value).map(spell).join(''),
      `${value.slice(0, 3)}\\\\u200b${value.slice(3)}`,
    ]) {
      const result = redactText(`a ${raw} b`, registry).text;
      expect(result, raw).toBe(`a ${MARKER} b`);
      expect(containsKnownForm(result, registry), raw).toBe(false);
    }
  });

  it('masks a whole surrogate pair spelled as escapes, and keeps a lone one as written', () => {
    const value = ['Zq9', '\u{1f600}', 'xLm7T'].join('');
    const registry = buildRegistry([value]);
    expect(shown(`a Zq9${spell('\u{1f600}')}xLm7T b`, [value])).toBe(`a ${MARKER} b`);
    expect(redactText(`a Zq9${spell('\u{1f600}')}xLm7T b`, registry).markerRanges).toEqual([
      [2, 12],
    ]);
    const lone = String.raw`a Zq9\ud83dxLm7T b`;
    expect(shown(lone, [value])).toBe(lone);
  });

  it('masks a shared-pattern token split by a soft hyphen', () => {
    const token = github('p');
    expect(shown(`echo ${token.slice(0, 14)}\u00ad${token.slice(14)} done`)).toBe(
      'echo [REDACTED_GITHUB_TOKEN] done'
    );
  });

  it('shows text with no secret in it as it is, escapes and unseen characters kept', () => {
    for (const text of [
      'printf("\\x00");',
      'const s = "\\u0041BC";',
      'ok \u2714\ufe0f done \u{1f44d}\ufe0f',
      String.raw`dir C:\x\new`,
      String.raw`a\\u200bb`,
    ])
      expect(shown(text, [secret]), text).toBe(norm(text));
  });

  it('keeps a value that is part of a marker in the registry, and masks it', () => {
    expect(shown('export TOKEN here', ['TOKEN'])).toBe(`export ${MARKER} here`);
    expect(shown('pass GITHUB here', ['GITHUB'])).toBe(`pass ${MARKER} here`);
    const registry = buildRegistry(['GITHUB', 'TOKEN']);
    // `[REDACTED_GITHUB_TOKEN]` would show both values: the token gets our marker.
    const result = redactText(`use ${github('p')} now`, registry).text;
    expect(result).toBe(`use ${MARKER} now`);
    expect(containsKnownForm(result, registry)).toBe(false);
  });
});

describe('search view: spellings, backslashes and markers', () => {
  const secret = ['Qm7v', 'R2Xk', '9pT4', 'zz'].join('');
  const SHY = '\u00ad';
  const hex = (char: string, digits: number) =>
    char.charCodeAt(0).toString(16).padStart(digits, '0');
  const interleaved = (value: string, split: string) => Array.from(value).join(split);

  it('reads a spelling with an unseen character after the backslash or inside the hex', () => {
    const registry = buildRegistry([secret]);
    const afterSlash = (char: string) => `\\${SHY}u${hex(char, 4)}`;
    const insideHex = (char: string) => `\\u00${SHY}${hex(char, 4).slice(2)}`;
    for (const spell of [afterSlash, insideHex]) {
      const raw = `a ${secret.slice(0, 4)}${spell(secret[4]!)}${secret.slice(5)} b`;
      const result = redactText(raw, registry).text;
      expect(result, raw).toBe(`a ${MARKER} b`);
      expect(containsKnownForm(result, registry), raw).toBe(false);
      expect(shown(`a ${Array.from(secret).map(spell).join('')} b`, [secret])).toBe(
        `a ${MARKER} b`
      );
    }
  });

  it('reads a spelling with any number of unseen characters inside it', () => {
    const registry = buildRegistry([secret]);
    const password = ['opaque', 'PASS', '803'].join('');
    for (const count of [8, 9, 50, 5000]) {
      const unseen = SHY.repeat(count);
      const raw = `a \\${unseen}u${unseen}00${unseen}${hex(secret[0]!, 2)}${secret.slice(1)} b`;
      const result = redactText(raw, registry).text;
      expect(result, String(count)).toBe(`a ${MARKER} b`);
      expect(containsKnownForm(raw, registry), String(count)).toBe(true);
      const url = shown(`postgres:\\u${unseen}002f/user:${password}@db.example/test`);
      expect(url, String(count)).not.toContain(password);
    }
  });

  it('reads JSON’s escaped solidus as `/`, so URL credentials written with it are found', () => {
    const password = ['unkn0', 'wnpw'].join('');
    const raw = `{"url":"postgres:\\/\\/bob:${password}@h\\/db"}`;
    const result = shown(raw);
    expect(result).not.toContain(password);
    expect(result).toContain('[REDACTED_CREDENTIALS]');
    expect(result.endsWith('h\\/db"}')).toBe(true);
    expect(shown(String.raw`see a\/b and c:\/d`)).toBe(String.raw`see a\/b and c:\/d`);
  });

  it('masks a value with a backslash in it interleaved with soft hyphens', () => {
    const value = ['C:', '\\Us', 'ers\\', 'Adm9x'].join('');
    const registry = buildRegistry([value]);
    const result = redactText(`dir ${interleaved(value, SHY)} ok`, registry).text;
    expect(result).toBe(`dir ${MARKER} ok`);
    expect(containsKnownForm(result, registry)).toBe(false);
  });

  it('keeps a backslash that starts no spelling, so a path is not glued together', () => {
    const text = String.raw`dir C:\Users\file`;
    expect(shown(text, [['C:', 'Users'].join('')])).toBe(text);
  });

  it('shows a double-escaped removed character as nothing, and masks what it split', () => {
    const value = ['sek', 'ret'].join('');
    const raw = String.raw`sek\\u200bret`;
    expect(norm(raw)).toBe(value);
    expect(shown(`a ${raw} b`, [value])).toBe(`a ${MARKER} b`);
    expect(norm(String.raw`a\\x1b[31mb`)).toBe('ab');
  });

  it('reads a double-escaped surrogate pair, as a character and as a separator', () => {
    const value = ['sek', 'ret', '\u{1f600}'].join('');
    const registry = buildRegistry([value]);
    const raw = String.raw`a sekret\\ud83d\\ude00 b`;
    const result = redactText(raw, registry);
    expect(result.text).toBe(`a ${MARKER} b`);
    expect(result.markerRanges).toEqual([[2, 12]]);
    expect(containsKnownForm(result.text, registry)).toBe(false);
    const tag = String.raw`\\udb40\\udc20`;
    expect(shown(`a ${interleaved(secret, tag)} b`, [secret])).toBe(`a ${MARKER} b`);
  });

  it('passes over interlinear annotation characters', () => {
    const token = github('p');
    expect(shown(`echo ${interleaved(token, '\ufff9')} done`)).toBe(
      'echo [REDACTED_GITHUB_TOKEN] done'
    );
    for (const char of ['\ufff9', '\ufffa', '\ufffb'])
      expect(shown(`a ${interleaved(secret, char)} b`, [secret]), char).toBe(`a ${MARKER} b`);
  });

  it('never cuts a marker already in the text', () => {
    const registry = buildRegistry(['TOKEN', 'GITHUB']);
    const text = 'see [REDACTED_GITHUB_TOKEN] and TOKEN';
    const result = redactText(text, registry);
    expect(result.text).toBe(`see [REDACTED_GITHUB_TOKEN] and ${MARKER}`);
    expect(result.markerRanges).toEqual([
      [4, 27],
      [32, 42],
    ]);
    expect(containsKnownForm(result.text, registry)).toBe(false);
  });

  it('gives our marker to a token whose labelled marker holds a known value', () => {
    expect(shown(`use ${github('p')} now`, ['GITHUB'])).toBe(`use ${MARKER} now`);
    expect(shown(`use ${github('p')} now`, ['GITLAB'])).toBe('use [REDACTED_GITHUB_TOKEN] now');
  });

  it('masks a shared-pattern token written whole as escapes, with its labelled marker', () => {
    const token = github('p');
    const spelled = Array.from(token)
      .map((char, at) => (at % 2 ? `\\u${hex(char, 4)}` : `\\x${hex(char, 2)}`))
      .join('');
    expect(shown(`echo ${spelled} done`)).toBe('echo [REDACTED_GITHUB_TOKEN] done');
  });
});

describe('markers and the final check', () => {
  it('finds our markers and the labelled ones', () => {
    const text = `a ${MARKER} b [REDACTED_SLACK_TOKEN] c`;
    expect(markerRangesOf(text)).toEqual([
      [2, 12],
      [15, 37],
    ]);
    expect(isMarker(MARKER)).toBe(true);
    expect(isMarker('[REDACTED_PEM_BLOCK]')).toBe(true);
    expect(isMarker('[REDAC')).toBe(false);
    expect(redactShown(text, buildRegistry([])).markerRanges).toEqual(markerRangesOf(text));
  });

  it('finds a whole known value form, not a piece of one', () => {
    const value = ['Qm7v', 'R2Xk', '9pT4'].join('');
    const registry = buildRegistry([value]);
    expect(containsKnownForm(`x ${value} y`, registry)).toBe(true);
    expect(containsKnownForm(`x ${value.slice(1)} y`, registry)).toBe(false);
    expect(containsKnownForm(`x ${MARKER} y`, registry)).toBe(false);
  });

  it('finds a form in the search view, and passes over one inside a marker', () => {
    const value = ['Qm7v', 'R2Xk', '9pT4'].join('');
    const registry = buildRegistry([value, 'TOKEN', 'REDACTED']);
    expect(containsKnownForm(`x ${value.slice(0, 4)}\u00ad${value.slice(4)} y`, registry)).toBe(
      true
    );
    expect(containsKnownForm(`x ${Array.from(value).join('\u{e0020}')} y`, registry)).toBe(true);
    expect(containsKnownForm(`a [REDACTED_GITHUB_TOKEN] ${MARKER} b`, registry)).toBe(false);
    expect(containsKnownForm(`a [REDACTED_GITHUB_TOKEN] TOKEN b`, registry)).toBe(true);
    expect(containsKnownForm(`a [REDACTED_GITHUB_TO\u00adKEN] b`, registry)).toBe(true);
    // Only a marker the masking writes is passed over, not a look-alike.
    const upper = ['HUNT', 'ERTWO'].join('');
    expect(containsKnownForm(`a [REDACTED_${upper}] b`, buildRegistry([upper]))).toBe(true);
    expect(shown(`a [REDACTED_${upper}] b`, [upper])).toBe(`a [REDACTED_${MARKER}] b`);
  });

  it('builds the search view and checks it in linear time', () => {
    const registry = buildRegistry(['aaaaaa', ['Qm7v', 'R2Xk'].join('')]);
    for (const unit of [
      '\\',
      '\\\\u0061',
      '\\x7f',
      '\\ud83d',
      'a\u00ad',
      '\u{e0020}',
      'a\\',
      '\\' + '\u00ad'.repeat(8),
      '\\' + '\u00ad'.repeat(5000),
      '\\u' + '\u00ad'.repeat(500) + '0',
      '\\\u00adu\u00ad0\u00ad0',
      '\\/',
      '\\\\ud83d\u00ad\\\\',
      '\\\\ud83d\\\\u',
      '\ufff9\\',
    ]) {
      const text = unit.repeat(Math.ceil(100_000 / unit.length));
      const started = performance.now();
      containsKnownForm(redactText(text, registry).text, registry);
      expect(performance.now() - started, unit).toBeLessThan(1000);
    }
  });
});

describe('false positives', () => {
  const values = ['sk-' + 'o'.repeat(40)];

  it('leaves hashes, UUIDs and prose about tokens and passwords', () => {
    const sha = createHash('sha1').update('commit').digest('hex');
    for (const text of [
      `commit ${sha}`,
      `request ${randomUUID()} done`,
      'Total token count: 1234',
      'The password policy requires 12 characters.',
      'max_tokens=4096 input_tokens: 12',
      'ghost_writer laughs_total author: Ada',
    ])
      expect(shown(text, values), text).toBe(text);
  });

  it('gives back a part without secrets as norm shows it', () => {
    const raw = `build ok\r\n${ESC}[32m✓ 12 tests passed${ESC}[0m\n\tdone in /home/user/project`;
    const result = redactText(raw, buildRegistry(values));
    expect(result.text).toBe(norm(raw));
    expect(result.markerRanges).toEqual([]);
  });
});

describe('time', () => {
  it('stays linear on adversarial input', () => {
    const registry = buildRegistry(['aaaaaa', 'aaaaaaaaaaaaaaaa', 'ghp_' + 'a'.repeat(36)]);
    const size = 20_000;
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    for (const unit of [
      'a',
      'ghp_',
      'sk-',
      'eyJ',
      'password=',
      'password:"',
      '"password":"',
      String.raw`\"token\":\"`,
      'a://',
      'a://b:',
      '-----BEGIN A-----',
      '\\u001b[',
      `${ESC}]`,
      `${ESC}[`,
      'Authorization: Bearer ',
      `a${ZW}`,
      '1234567:',
    ]) {
      const text = fill(unit);
      const started = performance.now();
      const masked = redactText(text, registry);
      containsKnownForm(masked.text, registry);
      expect(performance.now() - started, unit).toBeLessThan(1500);
    }
  });
});
