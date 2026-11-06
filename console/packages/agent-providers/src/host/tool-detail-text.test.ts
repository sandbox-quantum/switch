import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mapCodexItem } from '../codex/item-mapping';
import type { ProviderItem, ProviderRuntimeEvent } from '../events';
import { ToolDetailBuffer, type ToolDetailParts } from './tool-detail-buffer';
import { envKnownValues, hostKnownValues } from './tool-detail-known-values';
import {
  buildRegistry,
  containsKnownForm,
  MARKER,
  norm,
  type Registry,
} from './tool-detail-redaction';
import {
  composeToolIoText,
  type Cutter,
  cutToBudget,
  inputText,
  NOTE_NOT_AVAILABLE,
  TOOL_IO_BUDGET,
  toolIoText,
} from './tool-detail-text';

// The exhaustive tests loop over thousands of buffers; a busy runner must not fail them.
const EXHAUSTIVE_TIMEOUT_MS = 60_000;

// Every secret below is synthetic and put together at run time.
const ESC = '\x1b';
const ZW = '\u200b';
const BS = '\b';
const EMOJI = '\u{1f600}';
const github = (prefix: string) => `gh${prefix}_${'A'.repeat(10)}${'B'.repeat(26)}`;

const TOO_LARGE_INPUT = 'Input — too large to show safely in chat.';
const noWholeLine = (label = 'Output') =>
  `${label} — clipped (more than 8,192 characters), with no whole line at its start or its end to show; nothing is shown. People with access to this agent's Switch Console can open it there.`;
const CLIPPED_NOTE = /^Output — clipped: first ([\d,]+) and last ([\d,]+) characters shown; .+$/m;
const PEM_MARKER = '[REDACTED_PEM_BLOCK]';
const NOT_REPORTED_INPUT = 'Input — not reported by the provider';
const NOT_REPORTED_OUTPUT = 'Output — not reported by the provider';
const OUTPUT_START_HIDDEN =
  'Output — a terminal control sequence terminator was found in the tail; the tail up to it is not shown';
const KEY_NOTE = 'Output — lines that look like part of a private key are not shown';
/** `result` without the note on lines that look like part of a private key, when it has it. */
const withoutKeyNote = (result: string) => result.replace(`\n\n${KEY_NOTE}`, '');

const base = { eventId: 'e', provider: 'codex', sessionId: 's', createdAt: '' } as const;

/** A detail as the buffer reads one call alone; an output given is kept whole as its head. */
function detail(fields: Partial<ToolDetailParts>): ToolDetailParts {
  const output = fields.output ?? null;
  const inputClipped = fields.inputClipped ?? false;
  const outputClipped = fields.outputClipped ?? false;
  return {
    itemId: 'item',
    type: 'tool_call',
    toolName: null,
    input: null,
    truncated: inputClipped || outputClipped,
    exitCode: null,
    head: output ?? '',
    tail: '',
    hasOutput: output !== null,
    ...fields,
    output,
    inputClipped,
    outputClipped,
  };
}

/** A detail whose output the buffer clipped: `head` and `tail` kept, the middle dropped. */
function clipped(head: string, tail: string, fields: Partial<ToolDetailParts> = {}) {
  return detail({
    input: { a: 1 },
    ...fields,
    output: `${head}\n…\n${tail}`,
    head,
    tail,
    hasOutput: true,
    outputClipped: true,
  });
}

/** What a real buffer keeps for `item`, then its output `deltas`, read alone as the host reads it. */
function viaBuffer(item: ProviderItem, deltas: readonly string[] = []): ToolDetailParts {
  const buffer = new ToolDetailBuffer();
  const started: ProviderRuntimeEvent = { ...base, type: 'item.started', turnId: 't', item };
  buffer.ingest(started, 'epoch');
  for (const delta of deltas)
    buffer.ingest({ ...base, type: 'item.delta', turnId: 't', itemId: item.id, delta }, 'epoch');
  const kept = buffer.detail('epoch', 't', JSON.stringify(['t', item.id]));
  if (!kept) throw new Error('The buffer kept nothing.');
  return kept;
}

function tool(payload: Record<string, unknown> | undefined, text?: string): ProviderItem {
  return { id: 'call', type: 'tool_call', status: 'completed', title: 'tool', payload, text };
}

function registryOf(values: readonly string[] = []): Registry {
  return buildRegistry(values);
}

/** Six characters in a row (a letter or digit among them) of one of `values` in `text`. */
function leaks(text: string, values: readonly string[]): boolean {
  const plain = text.split(MARKER).join('\u0000');
  for (const value of values)
    for (let at = 0; at + 6 <= value.length; at++) {
      const window = value.slice(at, at + 6);
      if (/[\p{L}\p{N}]/u.test(window) && plain.includes(window)) return true;
    }
  return false;
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

describe('parts and what may be clipped', () => {
  const registry = registryOf();

  it('says a bare entry has no detail', () => {
    expect(toolIoText(detail({ truncated: true }), registry)).toBe(NOTE_NOT_AVAILABLE);
  });

  it('says when no output was captured', () => {
    const result = toolIoText(detail({ input: { command: 'mkdir x' } }), registry);
    expect(result).toBe(`Input\n${json({ command: 'mkdir x' })}\n\nOutput — not captured`);
  });

  it('keeps an output of 8,192 code units whole; past it, a one-line output gets only the note', () => {
    const whole = toolIoText(viaBuffer(tool({ a: 1 }, 'x'.repeat(8192))), registry)!;
    expect(whole).toMatch(/^Input\n[^]*\n\nOutput — first [\d,]+ of 8,192 characters shown\nx+$/);
    for (const length of [8193, 20000]) {
      const kept = viaBuffer(tool({ a: 1 }, 'x'.repeat(length)));
      expect(kept.outputClipped).toBe(true);
      expect(toolIoText(kept, registry)).toBe(`Input\n${json({ a: 1 })}\n\n${noWholeLine()}`);
    }
  });

  it('counts the output in UTF-16 code units: 4,096 emoji are 8,192 and whole', () => {
    const result = toolIoText(viaBuffer(tool({ a: 1 }, EMOJI.repeat(4096))), registry)!;
    expect(result).toMatch(/Output — first [\d,]+ of 4,096 characters shown\n/);
    expect(result).not.toContain('too large');
  });

  it('withholds an input the buffer kept as clipped text', () => {
    const fields = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k) => [k, 'x'.repeat(3000)]));
    const kept = viaBuffer(tool(fields));
    expect(typeof kept.input).toBe('string');
    expect(kept.inputClipped).toBe(true);
    expect(toolIoText(kept, registry)).toBe(`${TOO_LARGE_INPUT}\n\nOutput — not captured`);
  });

  it('decides a clipped input by the buffer’s flag alone', () => {
    expect(toolIoText(detail({ input: { a: 1 }, inputClipped: true }), registry)).toBe(
      `${TOO_LARGE_INPUT}\n\nOutput — not captured`
    );
    expect(toolIoText(detail({ input: { a: 1 }, output: 'ok' }), registry)).toBe(
      `Input\n${json({ a: 1 })}\n\nOutput\nok`
    );
  });

  it('withholds an input nested to depth index 6 or 7, not 5', () => {
    const nest = (containers: number): unknown => {
      let value: unknown = 'x';
      for (let at = 0; at < containers; at++) value = { [`l${at}`]: value };
      return value;
    };
    // Deepest container at index 5: whole.
    const five = viaBuffer(tool(nest(6) as Record<string, unknown>, 'ok'));
    expect(five.truncated).toBe(false);
    expect(toolIoText(five, registry)).toBe(`Input\n${json(five.input)}\n\nOutput\nok`);
    // At index 6 and 7 the buffer leaves a `…` leaf at index 6.
    for (const containers of [7, 8]) {
      const deep = viaBuffer(tool(nest(containers) as Record<string, unknown>, 'ok'));
      expect(deep.truncated).toBe(true);
      expect(toolIoText(deep, registry)).toBe(`${TOO_LARGE_INPUT}\n\nOutput\nok`);
    }
    // A container at index 6 the buffer did not clip is shown: only its flag counts.
    expect(toolIoText(detail({ input: nest(7), output: 'ok' }), registry)).toMatch(
      /^Input\n\{\n {2}"l6": \{/
    );
    // A `…` leaf is plain text.
    expect(toolIoText(detail({ input: { a: '…' }, output: 'ok' }), registry)).toBe(
      `Input\n${json({ a: '…' })}\n\nOutput\nok`
    );
  });

  it('shows an input with an array of 100 elements, which the buffer keeps whole; not 101', () => {
    const list = (length: number) => ({ items: Array.from({ length }, (_, at) => at % 10) });
    for (const length of [99, 100]) {
      const kept = viaBuffer(tool(list(length), 'ok'));
      expect(kept.inputClipped).toBe(false);
      const shown = toolIoText(kept, registry)!;
      expect(shown).toMatch(/^Input — first [\d,]+ of [\d,]+ characters shown\n\{/);
      expect(shown.endsWith('\n\nOutput\nok')).toBe(true);
    }
    const cut = viaBuffer(tool(list(101), 'ok'));
    expect(cut.inputClipped).toBe(true);
    expect(toolIoText(cut, registry)).toBe(`${TOO_LARGE_INPUT}\n\nOutput\nok`);
  });

  it('withholds an input string of 3,001 code units, not 3,000, astral ones too', () => {
    const shownOf = (content: string) => toolIoText(viaBuffer(tool({ content }, 'ok')), registry)!;
    expect(shownOf('a'.repeat(3000))).toMatch(/^Input — first [\d,]+ of 3,0\d\d characters shown/);
    expect(shownOf('a'.repeat(3001))).toBe(`${TOO_LARGE_INPUT}\n\nOutput\nok`);
    expect(shownOf(EMOJI.repeat(1500))).not.toContain('too large');
    expect(shownOf(`${EMOJI.repeat(1500)}a`)).toBe(`${TOO_LARGE_INPUT}\n\nOutput\nok`);
    // The buffer keeps a key whole, so a long key is shown, cut to the budget:
    // the input block, its header included, takes at most 500 code points.
    const longKey = viaBuffer(tool({ ['k'.repeat(3001)]: 1 }, 'ok'));
    expect(longKey.inputClipped).toBe(false);
    const shown = toolIoText(longKey, registry)!;
    expect(shown).toMatch(/^Input — first [\d,]+ of 3,0\d\d characters shown\n/);
    expect(codePoints(shown.slice(0, shown.indexOf('\n\nOutput')))).toBeLessThanOrEqual(500);
  });

  it('withholds a secret cut at 3,000 code units after astral characters', () => {
    const secret = ['Zq8', 'Wv3', 'Lm5', 'Tr7'].join('').repeat(5);
    const registry = registryOf(envKnownValues({ DEPLOY_TOKEN: secret }));
    const content = `${EMOJI.repeat(1480)}${secret}`;
    const kept = viaBuffer(tool({ content }, 'ok'));
    const keptContent = (kept.input as { content: string }).content;
    // Fewer than 3,000 code points remain, which a code point count would take as whole.
    expect(codePoints(keptContent)).toBeLessThan(3000);
    const result = toolIoText(kept, registry)!;
    expect(result).toBe(`${TOO_LARGE_INPUT}\n\nOutput\nok`);
    expect(leaks(result, [secret])).toBe(false);
  });

  it('withholds both parts when the entry is clipped by nothing that names a part', () => {
    const result = toolIoText(detail({ input: { a: 1 }, output: 'ok', truncated: true }), registry);
    expect(result).toBe(NOTE_NOT_AVAILABLE);
  });

  it('a natural … leaf at depth 6 is shown: the buffer’s flag tells it from a cut', () => {
    const registry = registryOf(envKnownValues({ API_KEY: ['q7V9', 'Lm2Z'].join('') }));
    const payload = { a: { b: { c: { d: { e: { f: '…' } } } } } };
    const kept = viaBuffer(tool(payload, 'x'.repeat(8193)));
    expect(kept.input).toEqual(payload);
    expect(kept.inputClipped).toBe(false);
    expect(kept.outputClipped).toBe(true);
    expect(toolIoText(kept, registry)).toBe(`Input\n${json(payload)}\n\n${noWholeLine()}`);
  });
});

describe('provider map', () => {
  const registry = registryOf();

  it('shows a Codex command as Input {command, cwd, exitCode} and Output', () => {
    const item = mapCodexItem(
      {
        type: 'commandExecution',
        id: 'c',
        command: 'ls -la',
        cwd: '/work',
        status: 'completed',
        aggregatedOutput: 'total 0\n',
        exitCode: 0,
      },
      'completed'
    );
    expect(toolIoText(viaBuffer(item), registry)).toBe(
      `Input\n${json({ command: 'ls -la', cwd: '/work', exitCode: 0 })}\n\nOutput\ntotal 0\n`
    );
  });

  it('leaves out the input of a Codex file change, which is the same as the output', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new';
    const item = mapCodexItem(
      {
        type: 'fileChange',
        id: 'f',
        status: 'completed',
        changes: [{ path: 'x', kind: 'update', diff }],
      },
      'completed'
    );
    expect(toolIoText(viaBuffer(item), registry)).toBe(`Output\n${diff}`);
  });

  it('masks URL credentials on the - and + lines of a Codex diff', () => {
    const url = `https://reader:${['Qv9L', 'p2Zx'].join('')}@db.example.test/x`;
    const diff = `@@ -1 +1 @@\n-${url}\n+${url}\n`;
    const item = mapCodexItem(
      {
        type: 'fileChange',
        id: 'call',
        status: 'completed',
        changes: [{ path: 'settings.txt', kind: 'update', diff }],
      },
      'completed'
    );
    expect(toolIoText(viaBuffer(item), registryOf([]))).toBe(
      'Output\n@@ -1 +1 @@\n' +
        '-https://[REDACTED_CREDENTIALS]@db.example.test/x\n' +
        '+https://[REDACTED_CREDENTIALS]@db.example.test/x\n'
    );
  });

  it('shows the input of a file change that is not a Codex diff (Claude Write)', () => {
    const input = { file_path: '/work/a.txt', content: 'hello' };
    const result = toolIoText(
      detail({ type: 'file_change', input, output: 'File created successfully' }),
      registry
    );
    expect(result).toBe(`Input\n${json(input)}\n\nOutput\nFile created successfully`);
  });

  it('gives a Codex MCP call its server, no input, and an output only for an error', () => {
    const call = (error: { message?: string } | null) =>
      viaBuffer(
        mapCodexItem(
          {
            type: 'mcpToolCall',
            id: 'm',
            server: 'github',
            tool: 'search',
            status: 'completed',
            error,
          },
          'completed'
        )
      );
    expect(toolIoText(call(null), registry)).toBe(`Server: github\n\n${NOT_REPORTED_INPUT}`);
    expect(toolIoText(call({ message: 'rate limited' }), registry)).toBe(
      `Server: github\n\n${NOT_REPORTED_INPUT}\n\nOutput\nrate limited`
    );
  });

  it('gives a Codex MCP server name the buffer clipped the note, not `Server:`', () => {
    const secret = ['q7Lm', '2Xp9', 'Rt4V'].join('');
    const server = `${'a'.repeat(190)}${'s'.repeat(2811)}`;
    const kept = viaBuffer(
      mapCodexItem(
        { type: 'mcpToolCall', id: 'm', server, tool: 'ping', status: 'completed', error: null },
        'completed'
      )
    );
    expect(kept.truncated).toBe(true);
    const result = toolIoText(kept, registryOf(envKnownValues({ APP_SECRET: secret })));
    expect(result).toBe(TOO_LARGE_INPUT);
    expect(result).not.toContain('Server');
    expect(result).not.toContain(NOT_REPORTED_INPUT);
  });

  it('says when it shortens a Codex MCP server name the buffer kept whole', () => {
    const call = (server: string) =>
      viaBuffer(
        mapCodexItem(
          { type: 'mcpToolCall', id: 'm', server, tool: 'ping', status: 'completed', error: null },
          'completed'
        )
      );
    const long = call('s'.repeat(201));
    expect(long.inputClipped).toBe(false);
    expect(toolIoText(long, registry)).toBe(
      `Server: ${'s'.repeat(200)}\nServer name — first 200 of 201 characters shown\n\n${NOT_REPORTED_INPUT}`
    );
    expect(toolIoText(call('s'.repeat(200)), registry)).toBe(
      `Server: ${'s'.repeat(200)}\n\n${NOT_REPORTED_INPUT}`
    );
  });

  it('masks the MCP server name like any text', () => {
    const secret = ['Qm7v', 'R2Xk', '9pT4'].join('');
    const result = toolIoText(
      detail({ type: 'mcp_tool_call', input: { server: `srv-${secret}` } }),
      registryOf([secret])
    );
    expect(result).toBe(`Server: srv-${MARKER}\n\n${NOT_REPORTED_INPUT}`);
  });

  it('shows the arguments of an MCP call that has them (Claude)', () => {
    const input = { query: 'is:open' };
    expect(
      toolIoText(detail({ type: 'mcp_tool_call', input, output: '3 results' }), registry)
    ).toBe(`Input\n${json(input)}\n\nOutput\n3 results`);
  });

  it('says neither part was reported for a Codex dynamic tool call', () => {
    const item = mapCodexItem(
      { type: 'dynamicToolCall', id: 'd', tool: 'lookup', status: 'completed' },
      'completed'
    );
    expect(toolIoText(viaBuffer(item), registry)).toBe(
      `${NOT_REPORTED_INPUT}\n\n${NOT_REPORTED_OUTPUT}`
    );
  });

  it('labels the text of a Codex collab agent call Prompt', () => {
    const item = mapCodexItem(
      {
        type: 'collabAgentToolCall',
        id: 'a',
        tool: 'spawn_agent',
        status: 'completed',
        senderThreadId: 'thread-1',
        receiverThreadIds: ['thread-2'],
        prompt: 'Review the diff in src/',
      },
      'completed'
    );
    const result = toolIoText(viaBuffer(item), registry);
    expect(result).toBe('Prompt\nReview the diff in src/');
    expect(result).not.toContain('Output');
    const silent = mapCodexItem(
      {
        type: 'collabAgentToolCall',
        id: 'b',
        tool: 'wait',
        status: 'completed',
        senderThreadId: 'thread-1',
        receiverThreadIds: [],
        prompt: null,
      },
      'completed'
    );
    expect(toolIoText(viaBuffer(silent), registry)).toBe('Prompt — not reported by the provider');
  });

  it('shows other subagents and web searches as captured, or says what was not reported', () => {
    const activity = mapCodexItem(
      {
        type: 'subAgentActivity',
        id: 's',
        kind: 'started',
        agentThreadId: 'thread-3',
        agentPath: 'reviewer',
      },
      'started'
    );
    expect(toolIoText(viaBuffer(activity), registry)).toBe(
      `Input\n${json({ kind: 'started', agentThreadId: 'thread-3' })}\n\nOutput — not captured`
    );
    const search = mapCodexItem({ type: 'webSearch', id: 'w', query: 'vitest' }, 'started');
    expect(toolIoText(viaBuffer(search), registry)).toBe(
      `${NOT_REPORTED_INPUT}\n\n${NOT_REPORTED_OUTPUT}`
    );
    expect(
      toolIoText(detail({ type: 'subagent', input: { prompt: 'go' }, output: 'done' }), registry)
    ).toBe(`Input\n${json({ prompt: 'go' })}\n\nOutput\ndone`);
  });
});

describe('the input, normalized then serialized', () => {
  it('serializes every string and key as norm shows it, as JSON.stringify writes it', () => {
    const input = {
      command: `a${ESC}[31mb${ZW}c${BS}d`,
      [`k${ZW}ey`]: [1, true, null, 'x\ny', String.raw`e\u001b[0mf`, `${EMOJI}\ud800`],
      empty: {},
      none: [],
    };
    expect(inputText(input)).toBe(
      json({
        command: 'abcd',
        key: [1, true, null, 'x\ny', 'ef', `${EMOJI}\ud800`],
        empty: {},
        none: [],
      })
    );
  });

  it('masks the union of overlapping values in the input', () => {
    const result = toolIoText(
      detail({ input: { command: 'abcdefXYZuvwxyz12' } }),
      registryOf(['abcdefXYZ', 'XYZuvwxyz12'])
    );
    expect(result).toBe(`Input\n${json({ command: MARKER })}\n\nOutput — not captured`);
  });

  it('masks a value split by what norm removes, in a string and in a key', () => {
    const secret = ['Qm7v', 'R2Xk', '9pT4'].join('');
    const registry = registryOf([secret]);
    for (const split of [
      `${ESC}[31m`,
      `${ESC}]0;title\x07`,
      ZW,
      BS,
      '\f',
      String.raw`\u001b[31m`,
      String.raw`\x1b[0m`,
      String.raw`\u001b]0;t\u0007`,
      String.raw`\u200b`,
    ]) {
      const value = `${secret.slice(0, 6)}${split}${secret.slice(6)}`;
      expect(toolIoText(detail({ input: { command: value } }), registry), split).toBe(
        `Input\n${json({ command: MARKER })}\n\nOutput — not captured`
      );
      expect(toolIoText(detail({ input: { [value]: 1 } }), registry), split).toBe(
        `Input\n${json({ [MARKER]: 1 })}\n\nOutput — not captured`
      );
    }
  });

  it('masks a multi-line value split by a backspace, JSON-escaped in the input', () => {
    const lines = ['first-Line-A1', 'second-Line-B2'].join('\n');
    const input = { text: `${lines.slice(0, 3)}${BS}${lines.slice(3)}` };
    expect(toolIoText(detail({ input }), registryOf([lines]))).toBe(
      `Input\n${json({ text: MARKER })}\n\nOutput — not captured`
    );
  });

  it('masks a token split by a zero-width character or a backspace, registered or not', () => {
    const token = github('p');
    for (const split of [ZW, BS]) {
      const input = { command: `echo ${token.slice(0, 14)}${split}${token.slice(14)}` };
      expect(toolIoText(detail({ input }), registryOf([token]))).toBe(
        `Input\n${json({ command: `echo ${MARKER}` })}\n\nOutput — not captured`
      );
      expect(toolIoText(detail({ input }), registryOf())).toBe(
        `Input\n${json({ command: 'echo [REDACTED_GITHUB_TOKEN]' })}\n\nOutput — not captured`
      );
    }
  });
});

describe('one masking from the union of ranges', () => {
  const other = ['Other', 'Secret', 'Q7'].join('');
  const openai = ['sk', '-', 'A'.repeat(24)].join('');

  it('a known value that is a key name does not hide the value the patterns find', () => {
    const registry = registryOf(envKnownValues({ APP_PASSWORD: 'password' }));
    const result = toolIoText(detail({ output: `{"password":"${other}"}` }), registry);
    expect(result).toBe(`${NOT_REPORTED_INPUT}\n\nOutput\n{"${MARKER}":"${MARKER}"}`);
  });

  it('a known value that is a header name does not hide its credential', () => {
    const registry = registryOf(['Authorization']);
    const result = toolIoText(detail({ output: `Authorization: Bearer ${other}\n` }), registry);
    expect(result).toBe(`${NOT_REPORTED_INPUT}\n\nOutput\n${MARKER}: ${MARKER}\n`);
  });

  it('a known value overlapping a pattern hit is masked with it, once', () => {
    const registry = registryOf([`${openai.slice(10)} tail`]);
    const result = toolIoText(detail({ output: `use ${openai} tail end` }), registry);
    expect(result).toBe(`${NOT_REPORTED_INPUT}\n\nOutput\nuse ${MARKER} end`);
  });

  it('masks a token on the next line of an input string, after a newline or a tab', () => {
    for (const space of ['\n', '\t']) {
      const command = `cat <<'EOF'${space}${openai}${space}EOF`;
      const result = toolIoText(detail({ input: { command }, output: 'safe' }), registryOf());
      expect(result, JSON.stringify(space)).not.toBeNull();
      expect(result!).not.toContain(openai);
      expect(result!).toBe(
        `Input\n${json({ command: command.replace(openai, '[REDACTED_OPENAI_KEY]') })}\n\nOutput\nsafe`
      );
    }
  });

  it('masks a token after a newline in an output', () => {
    const result = toolIoText(detail({ output: `done\n${openai}\n` }), registryOf());
    expect(result).toBe(`${NOT_REPORTED_INPUT}\n\nOutput\ndone\n[REDACTED_OPENAI_KEY]\n`);
  });

  it('masks a key and value of the input that only read as a pair once serialized', () => {
    const result = toolIoText(detail({ input: { password: other } }), registryOf());
    expect(result).toBe(`Input\n${json({ password: MARKER })}\n\nOutput — not captured`);
  });

  it('masks a known value written by Python json.dumps with non-ASCII escaped', () => {
    const secret = ['p\u00e4ss', 'Zq9vX2kLmN4pR7sT'].join('');
    const printed = `printed: "${'p\\u00e4ss'}Zq9vX2kLmN4pR7sT"\n`;
    const result = toolIoText(detail({ output: printed }), registryOf([secret]));
    expect(result).toBe(`${NOT_REPORTED_INPUT}\n\nOutput\nprinted: "${MARKER}"\n`);
  });
});

describe('one masking for the input too', () => {
  const other = ['Other', 'Secret', 'Q7'].join('');
  const openai = ['sk', '-', 'A'.repeat(24)].join('');
  const knownPassword = () => registryOf(envKnownValues({ APP_PASSWORD: 'password' }));
  const MARKER_TEXT = /\[REDACTED(?:_[A-Z]+)*\]/;

  /** `input` with every string and key as norm shows it, as the input is serialized. */
  const normalized = (input: unknown): unknown => {
    if (typeof input === 'string') return norm(input);
    if (Array.isArray(input)) return input.map(normalized);
    if (typeof input !== 'object' || input === null) return input;
    return Object.fromEntries(
      Object.entries(input).map(([key, each]) => [norm(key), normalized(each)])
    );
  };

  /**
   * The masked input is `JSON.stringify` of the normalized input outside the
   * masked ranges: each marker stands for some text of at least one character,
   * and everything between the markers is the serialized text as it is.
   */
  const expectSerializedOutsideMarkers = (input: unknown, registry: Registry) => {
    const reference = json(normalized(input));
    const masked = inputText(input, registry);
    const literals = masked.split(MARKER_TEXT);
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const shape = new RegExp(`^${literals.map(escape).join('[\\s\\S]+?')}$`);
    expect(reference, masked).toMatch(shape);
    return masked;
  };

  it('a known value that is a key name does not hide the value the key/value pattern finds', () => {
    const subject = detail({ input: { password: other }, output: 'safe' });
    const result = toolIoText(subject, knownPassword());
    expect(result).toBe(`Input\n${json({ [MARKER]: MARKER })}\n\nOutput\nsafe`);
    expect(leaks(result!, [other])).toBe(false);
  });

  it('masks the value of a known key nested in arrays and objects', () => {
    const input = { outer: [{ password: other }] };
    const result = toolIoText(detail({ input, output: 'safe' }), knownPassword());
    expect(result).toBe(`Input\n${json({ outer: [{ [MARKER]: MARKER }] })}\n\nOutput\nsafe`);
    expect(leaks(result!, [other])).toBe(false);
  });

  it('masks the credential of an Authorization key, known or not', () => {
    const input = { Authorization: `Bearer ${other}` };
    for (const [registry, key] of [
      [registryOf(['Authorization']), MARKER],
      [registryOf(), 'Authorization'],
    ] as const) {
      const result = toolIoText(detail({ input, output: 'safe' }), registry);
      expect(result, key).toBe(`Input\n${json({ [key]: MARKER })}\n\nOutput\nsafe`);
      expect(leaks(result!, [other])).toBe(false);
    }
  });

  it('still masks a token on the next line of a heredoc, with a known key beside it', () => {
    for (const space of ['\n', '\t']) {
      const command = `cat <<'EOF'${space}${openai}${space}EOF`;
      const input = { command, password: other };
      const result = toolIoText(detail({ input, output: 'safe' }), knownPassword());
      const shown = { command: command.replace(openai, '[REDACTED_OPENAI_KEY]'), [MARKER]: MARKER };
      expect(result, JSON.stringify(space)).toBe(`Input\n${json(shown)}\n\nOutput\nsafe`);
      expect(leaks(result!, [openai, other])).toBe(false);
    }
  });

  it('moves a range found in a decoded string onto its JSON escapes', () => {
    const secret = ['Zq9v', 'X2kL', 'mN4p'].join('');
    const input = { text: `a"b\\${secret}\n\u0001${EMOJI}\ud800`, [`k"${secret}`]: 1 };
    expect(inputText(input, registryOf([secret]))).toBe(
      json({ text: `a"b\\${MARKER}\n${EMOJI}\ud800`, [`k"${MARKER}`]: 1 })
    );
    // A value split by what norm removes, and a value with a line break in it.
    const lines = ['first-Line-A1', 'second-Line-B2'].join('\n');
    const split = `${secret.slice(0, 5)}${ZW}${secret.slice(5)}`;
    expect(inputText({ a: split, b: `x ${lines} y` }, registryOf([secret, lines]))).toBe(
      json({ a: MARKER, b: `x ${MARKER} y` })
    );
  });

  it('is JSON.stringify of the normalized input outside the masked ranges', () => {
    const secret = ['Zq9v', 'X2kL', 'mN4p'].join('');
    const registry = registryOf([secret, ...envKnownValues({ APP_PASSWORD: 'password' })]);
    const cases: unknown[] = [
      { password: other },
      { outer: [{ password: other }, null, 1.5, true, [], {}] },
      { Authorization: `Bearer ${other}`, token: openai },
      { command: `cat <<'EOF'\n${openai}\nEOF`, cwd: '/w' },
      { [`k${ZW}ey`]: `a${ESC}[31m"${secret}"\\${BS}`, n: -0, e: 1e21, list: [undefined, 'x'] },
      [`${EMOJI}\ud800${secret}\udc00`, { password: `${secret}\t${openai}` }],
      { 'api-key': `${other}\r\n${secret}`, nested: { deeper: { secret: other } } },
      `top ${secret} level`,
      { plain: 'nothing to mask', count: 3 },
    ];
    let masked = 0;
    for (const input of cases) {
      const text = expectSerializedOutsideMarkers(input, registry);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(other);
      expect(text).not.toContain(openai);
      if (MARKER_TEXT.test(text)) masked++;
    }
    expect(masked).toBe(cases.length - 1);
  });
});

describe('the output, normalized', () => {
  it('says when an OSC string with no terminator hid the rest of a part', () => {
    const hidden = (label: string) =>
      `${label} — a terminal control sequence with no end hid the rest; it is not shown`;
    const registry = registryOf();
    const output = `before\n${ESC}]0;${'x'.repeat(8000)}`;
    expect(toolIoText(viaBuffer(tool({ a: 1 }, output)), registry)).toBe(
      `Input\n${json({ a: 1 })}\n\nOutput\nbefore\n\n\n${hidden('Output')}`
    );
    expect(toolIoText(detail({ input: { a: 1 }, output: `${ESC}]0;title` }), registry)).toBe(
      `Input\n${json({ a: 1 })}\n\nOutput\n\n\n${hidden('Output')}`
    );
    const input = { command: String.raw`printf 'a\x1b]0;title' && echo done` };
    expect(toolIoText(detail({ input, output: 'a' }), registry)).toBe(
      `Input\n${json({ command: "printf 'a" })}\n\n${hidden('Input')}\n\nOutput\na`
    );
    const tail = `x\nshown-line\n${ESC}]0;rest`;
    const preview = toolIoText(clipped('head-line\nh', tail), registry)!;
    expect(preview.endsWith(`\n…\nshown-line\n\n\n${hidden('Output')}`)).toBe(true);
    expect(toolIoText(detail({ input: { a: 1 }, output: `a${ESC}]0;t\x07b` }), registry)).toBe(
      `Input\n${json({ a: 1 })}\n\nOutput\nab`
    );
  });

  it('masks a registered token split by a CSI sequence', () => {
    const token = github('s');
    const output = `${token.slice(0, 14)}${ESC}[0m${token.slice(14)}`;
    const result = toolIoText(detail({ input: { a: 1 }, output }), registryOf([token]))!;
    expect(result).toBe(`Input\n${json({ a: 1 })}\n\nOutput\n${MARKER}`);
  });

  it('masks overlapping registered values whole', () => {
    const result = toolIoText(
      detail({ input: { a: 1 }, output: 'AAAA-12345678-BBBBBBBB' }),
      registryOf(['AAAA-12345678', '12345678-BBBBBBBB'])
    );
    expect(result).toBe(`Input\n${json({ a: 1 })}\n\nOutput\n${MARKER}`);
  });

  it('masks a whole env value a pattern would cut at the control sequence', () => {
    const value = `corp-${'gh'}p_AbCd1234EfGh5678IjKl9012MnOp3456QrSt-eu1`;
    const cut = value.indexOf('QrSt') + 1;
    const output = `${value.slice(0, cut)}${ESC}[0m${value.slice(cut)}`;
    const result = toolIoText(
      detail({ input: { a: 1 }, output }),
      registryOf(envKnownValues({ DEPLOY_KEY: value }))
    )!;
    expect(result).toBe(`Input\n${json({ a: 1 })}\n\nOutput\n${MARKER}`);
    expect(result).not.toContain('rSt-eu1');
  });

  it('masks a value split by \\u200b or \\u202e written as text, and by a real U+200B', () => {
    const secret = ['aB1cD', '2eF3g'].join('');
    const registry = registryOf(envKnownValues({ APP_SECRET: secret }));
    const run = (output: string) =>
      toolIoText(
        viaBuffer(
          mapCodexItem(
            {
              type: 'commandExecution',
              id: 'c',
              command: 'printf hello',
              cwd: '/w',
              status: 'completed',
              aggregatedOutput: output,
              exitCode: 0,
            },
            'completed'
          )
        ),
        registry
      );
    const shownInput = json({ command: 'printf hello', cwd: '/w', exitCode: 0 });
    for (const separator of [String.raw`\u200b`, String.raw`\u202E`, ZW]) {
      const result = run(`${secret.slice(0, 5)}${separator}${secret.slice(5)}`);
      expect(result, separator).toBe(`Input\n${shownInput}\n\nOutput\n${MARKER}`);
      expect(leaks(result!, [secret]), separator).toBe(false);
    }
  });

  it('masks JSON-escaped and URL-encoded forms of a known value in the output', () => {
    const password = ['p@ss w/rd+', 'Zq9x', 'Lm7T'].join('');
    const lines = ['first-Line-A1', 'second-Line-B2'].join('\n');
    const registry = registryOf([password, lines]);
    const output = `${JSON.stringify({ text: lines })}\nurl=${encodeURIComponent(password)}&x=1\n`;
    expect(toolIoText(detail({ input: { a: 1 }, output }), registry)).toBe(
      `Input\n${json({ a: 1 })}\n\nOutput\n{"text":"${MARKER}"}\nurl=${MARKER}&x=1\n`
    );
  });

  it('masks `Authorization: Bot <token>` and an `xapp-` token in a detail', () => {
    const tail = ['Zq9x', 'Lm7T', 'Wd4K', 'p9Lx', '2Rm7', 'Tq5V', 'Hq'].join('');
    const bot = ['MTk4NjIy', 'NDgzNDcx', 'OTI1MjQ4'].join('') + '.Cl2FMQ.' + tail;
    const app = ['xapp', '1', 'A0123456789', '1234567890123', tail].join('-');
    const result = toolIoText(
      detail({
        input: { command: `curl -H "Authorization: Bot ${bot}" https://discord.example` },
        output: `SLACK_APP_TOKEN=${app}\nok\n`,
      }),
      registryOf()
    )!;
    expect(result).not.toBeNull();
    expect(result).not.toContain(bot);
    expect(result).not.toContain(app);
    expect(result).not.toContain(tail);
    expect(result).toContain('Authorization: [REDACTED]');
  });
});

describe('budget and header', () => {
  const registry = registryOf();

  it('cuts the input at its last newline within 500 code points', () => {
    const input = { lines: Array.from({ length: 60 }, (_, at) => `line number ${at}`) };
    const result = toolIoText(detail({ input, output: 'ok' }), registry)!;
    const [head, body] = [result.split('\n')[0]!, result.slice(result.indexOf('\n') + 1)];
    const shown = body.slice(0, body.indexOf('\n\nOutput'));
    const count = (text: string) => codePoints(text).toLocaleString('en-US');
    expect(head).toBe(`Input — first ${count(shown)} of ${count(json(input))} characters shown`);
    expect(codePoints(shown)).toBeLessThanOrEqual(500);
    expect(json(input).startsWith(shown)).toBe(true);
    expect(json(input)[shown.length]).toBe('\n');
  });

  it('shows a long one-line field from its start, not only `{`', () => {
    const input = { content: 'abcdefghij'.repeat(60) };
    const result = toolIoText(detail({ input, output: 'ok' }), registry)!;
    const block = result.slice(0, result.indexOf('\n\nOutput'));
    const body = block.slice(block.indexOf('\n') + 1);
    // Room is kept for the longest header, `first 619 of 619`, within 500 code points.
    const total = codePoints(json(input));
    const longest = `Input — first ${total} of ${total} characters shown\n`;
    expect(result.split('\n')[0]).toBe(
      `Input — first ${500 - codePoints(longest)} of ${total} characters shown`
    );
    expect(body.startsWith('{\n  "content": "abcdefghij')).toBe(true);
    expect(codePoints(body)).toBe(500 - codePoints(longest));
    expect(codePoints(block)).toBeLessThanOrEqual(500);
    expect(json(input).startsWith(body)).toBe(true);
  });

  it('keeps the whole input block, header and notes, within 500 code points', () => {
    // A long string: the header is in the budget, not added to it.
    const long = toolIoText(detail({ input: { a: 'x'.repeat(1000) }, output: 'ok' }), registry)!;
    const longBlock = long.slice(0, long.indexOf('\n\nOutput'));
    expect(longBlock).toMatch(/^Input — first [\d,]+ of 1,013 characters shown\n\{\n {2}"a": "x/);
    expect(codePoints(longBlock)).toBeLessThanOrEqual(500);
    expect(codePoints(longBlock)).toBeGreaterThan(480);
    // A string an OSC opener with no end hides the rest of: its note is in the budget too.
    const note = 'Input — a terminal control sequence with no end hid the rest; it is not shown';
    const input = { a: 'x'.repeat(1000), b: `shown ${ESC}]0;hidden` };
    const hidden = toolIoText(detail({ input, output: 'ok' }), registry)!;
    const hiddenBlock = hidden.slice(0, hidden.indexOf('\n\nOutput'));
    expect(hiddenBlock.endsWith(`\n\n${note}`)).toBe(true);
    expect(codePoints(hiddenBlock)).toBeLessThanOrEqual(500);
    expect(hidden).not.toContain('hidden');
    // The whole detail stays within its own budget.
    expect(codePoints(hidden)).toBeLessThanOrEqual(TOOL_IO_BUDGET);
  });

  it('cuts at the last newline only when it keeps half the budget', () => {
    const late = `abcdef\n${'c'.repeat(20)}`;
    expect(cutToBudget(late, [], 10)).toEqual({ text: 'abcdef', markerRanges: [] });
    const early = `ab\n${'c'.repeat(20)}`;
    expect(cutToBudget(early, [], 10)).toEqual({ text: early.slice(0, 10), markerRanges: [] });
    const astral = `a\n${EMOJI.repeat(20)}`;
    expect(cutToBudget(astral, [], 6).text).toBe(`a\n${EMOJI.repeat(4)}`);
  });

  it('cuts the output to the whole budget with its true count', () => {
    const output = 'abcdefghij'.repeat(621);
    const result = toolIoText(detail({ input: { a: 1 }, output }), registry)!;
    expect(codePoints(result)).toBeLessThanOrEqual(TOOL_IO_BUDGET);
    expect(codePoints(result)).toBeGreaterThan(TOOL_IO_BUDGET - 60);
    const match = /\n\nOutput — first ([\d,]+) of 6,210 characters shown\n(a[a-j]*)$/.exec(result);
    expect(match).not.toBeNull();
    expect(Number(match![1]!.replace(/,/g, ''))).toBe(match![2]!.length);
  });

  it('cuts at a code point boundary', () => {
    const result = toolIoText(detail({ input: { a: 1 }, output: EMOJI.repeat(3000) }), registry)!;
    expect(codePoints(result)).toBeLessThanOrEqual(TOOL_IO_BUDGET);
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    expect(result).not.toMatch(lone);
    expect(result).toMatch(/Output — first [\d,]+ of 3,000 characters shown/);
  });

  it('never cuts inside a marker', () => {
    expect(cutToBudget(`abc${MARKER}def`, [[3, 13]], 8)).toEqual({ text: 'abc', markerRanges: [] });
    expect(cutToBudget(`abc${MARKER}def`, [[3, 13]], 14)).toEqual({
      text: `abc${MARKER}d`,
      markerRanges: [[3, 13]],
    });
    const secret = ['Qm7v', 'R2Xk', '9pT4'].join('');
    for (let fill = 1880; fill < 1960; fill++) {
      const output = `${'a'.repeat(fill)}${secret}${'b'.repeat(100)}`;
      const result = toolIoText(detail({ output, input: { a: 1 } }), registryOf([secret]))!;
      expect(result.split(MARKER).join(''), String(fill)).not.toContain('[');
      expect(leaks(result, [secret])).toBe(false);
    }
  });

  it('shows a whole output that fits with its plain header, and cuts one that does not', () => {
    const registry = registryOf(envKnownValues({ APP_SECRET: ['q7Lm', '2Xp9', 'Rt4V'].join('') }));
    const run = (output: string) =>
      toolIoText(
        viaBuffer(
          mapCodexItem(
            {
              type: 'commandExecution',
              id: 'c',
              command: 'ls',
              cwd: '/w',
              status: 'completed',
              aggregatedOutput: output,
              exitCode: 0,
            },
            'completed'
          )
        ),
        registry
      );
    const fits = `${'L'.repeat(1910)}RESULT-OK!`;
    const expected = `Input\n${json({ command: 'ls', cwd: '/w', exitCode: 0 })}\n\nOutput\n${fits}`;
    expect(codePoints(expected)).toBe(1988);
    expect(run(fits)).toBe(expected);
    // Over the budget by one with the plain header: cut, under the longer header.
    const over = `${'L'.repeat(1923)}RESULT-OK!`;
    const cut = run(over)!;
    expect(cut).toMatch(/\n\nOutput — first [\d,]+ of 1,933 characters shown\nL+$/);
    expect(codePoints(cut)).toBeLessThanOrEqual(TOOL_IO_BUDGET);
  });
});

describe('a clipped output: a preview of its head and tail', () => {
  const registry = registryOf();
  const armor = (word: 'BEGIN' | 'END') => `-----${word} ${'RSA PRIV'}${'ATE KEY'}-----`;
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  /** Synthetic key lines of 64 characters, the same on every run. */
  const keyLines = (count: number, seed: number) => {
    let state = seed >>> 0;
    return Array.from({ length: count }, () =>
      Array.from({ length: 64 }, () => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return B64[(state >>> 16) & 63];
      }).join('')
    );
  };
  /** The preview's head and tail as shown, and the counts its note gives. */
  const previewOf = (result: string) => {
    const match = CLIPPED_NOTE.exec(result);
    if (!match) throw new Error(`No clipped note in: ${result.slice(0, 200)}`);
    const body = withoutKeyNote(result).slice(match.index + match[0].length + 1);
    const [head, tail] = body.split(/^…$/m) as [string, string | undefined];
    return {
      first: Number(match[1]!.replace(/,/g, '')),
      last: Number(match[2]!.replace(/,/g, '')),
      head: head.replace(/\n$/, ''),
      tail: (tail ?? '').replace(/^\n/, ''),
    };
  };

  it('masks the armor and key lines of a key open at the head’s cut, under a note, and shows a tail of ordinary lines', () => {
    const key = keyLines(130, 1);
    const output = `safe-head\n${armor('BEGIN')}\n${key.join('\n')}\n${armor('END')}\n${'tail-ok\n'.repeat(400)}`;
    const kept = viaBuffer(tool({ a: 1 }, output));
    expect(kept.outputClipped).toBe(true);
    // The block opens in the head and closes in the dropped middle; the tail
    // holds no line of it, so it is shown.
    expect(kept.head).toContain(armor('BEGIN'));
    expect(kept.head + kept.tail).not.toContain(armor('END'));
    const result = toolIoText(kept, registry)!;
    const shown = previewOf(result);
    expect(shown.head).toBe(`safe-head\n${PEM_MARKER}`);
    expect(shown.tail).toMatch(/^(?:tail-ok\n)+$/);
    expect(result.endsWith(`\n\n${KEY_NOTE}`)).toBe(true);
    expect(leaks(result, key)).toBe(false);
  });

  it('masks a PEM block that closes in the tail without its start, through its END', () => {
    const key = keyLines(60, 2);
    const output = `${'head-ok\n'.repeat(1000)}${armor('BEGIN')}\n${key.join('\n')}\n${armor('END')}\nafter-ok\n`;
    const kept = viaBuffer(tool({ a: 1 }, output));
    expect(kept.outputClipped).toBe(true);
    expect(kept.tail).toContain(armor('END'));
    expect(kept.head + kept.tail).not.toContain(armor('BEGIN'));
    const result = toolIoText(kept, registry)!;
    expect(result.endsWith(`\n…\n${PEM_MARKER}\nafter-ok\n\n\n${KEY_NOTE}`)).toBe(true);
    expect(leaks(result, key)).toBe(false);
  });

  it('masks a whole PEM block inside the head whole, and shows the lines around it', () => {
    const key = keyLines(8, 3);
    const output = `start\n${armor('BEGIN')}\n${key.join('\n')}\n${armor('END')}\nsafe-head-line\n${'fill-line\n'.repeat(900)}`;
    const result = toolIoText(viaBuffer(tool({ a: 1 }, output)), registry)!;
    expect(result).toContain(`\nstart\n${PEM_MARKER}\nsafe-head-line\nfill-line\n`);
    expect(leaks(result, key)).toBe(false);
  });

  it('masks a cut key’s tail from its start through its private END, a short line and a public block nested in it too', () => {
    const exposed = ['EXPOSED', 'MATERIAL', '123'].join('');
    const word = (kind: string, name: string) => `-----${kind} ${name}-----`;
    const priv = ['PRIV', 'ATE KEY'].join('');
    const output =
      `safe\n${word('BEGIN', priv)}\n` +
      'Ab9qW'.repeat(1800) +
      `\n${exposed}\n${word('BEGIN', 'PUBLIC KEY')}\nabc\n` +
      `${word('END', 'PUBLIC KEY')}\n${word('END', priv)}\ndone\n`;
    const kept = viaBuffer(
      mapCodexItem(
        {
          type: 'commandExecution',
          id: 'c',
          command: 'printf probe',
          cwd: '/tmp',
          status: 'completed',
          aggregatedOutput: output,
          exitCode: 0,
        },
        'completed'
      )
    );
    expect(kept.outputClipped).toBe(true);
    const result = toolIoText(kept, registryOf())!;
    expect(result).not.toContain(exposed);
    expect(result).not.toContain('abc');
    const { head, tail } = previewOf(result);
    expect(head).toBe(`safe\n${PEM_MARKER}`);
    // The private END has no BEGIN in the tail: everything before it is masked,
    // the short line and the public block inside the key with it.
    expect(tail).toBe(`${PEM_MARKER}\ndone\n`);
    expect(result).toContain(KEY_NOTE);
  });

  it('masks a key’s BEGIN to the head’s end past a public block nested in it, and the tail through a lone END, keeping the ordinary lines', () => {
    const key = keyLines(3, 4);
    const pub = (kind: string) => `-----${kind} PUBLIC KEY-----`;
    const head = `safe-1\n${armor('BEGIN')}\n${key[0]}\n${pub('BEGIN')}\n${key[1]}\n${pub('END')}\n${key[2]}\n`;
    const result = toolIoText(clipped(head, `x\nsafe-2\n${armor('END')}\nsafe-3\n`), registry)!;
    const shown = previewOf(result);
    // The public END does not close the private BEGIN: the head is masked from
    // it to its end. The tail's private END has no BEGIN: masked from its start.
    expect(shown.head).toBe(`safe-1\n${PEM_MARKER}`);
    expect(shown.tail).toBe(`${PEM_MARKER}\nsafe-3\n`);
    expect(leaks(result, key)).toBe(false);
  });

  it('masks a cut key’s lines, whole blocks whole, and a key line away from the cut, keeping the lines between', () => {
    const key = keyLines(8, 5);
    const block = (lines: string[]) => `${armor('BEGIN')}\n${lines.join('\n')}\n${armor('END')}`;
    const head = `h-1\n${block(key.slice(0, 2))}\nh-2\n${armor('BEGIN')}\n${key[2]}\n`;
    const tail = `${key[3]}\n${key[4]}\n${armor('END')}\nt-1\n${block(key.slice(5, 7))}\nt-2\n${key[7]}\n`;
    const result = toolIoText(clipped(head, tail), registry)!;
    const shown = previewOf(result);
    expect(shown.head).toBe(`h-1\n${PEM_MARKER}\nh-2\n${PEM_MARKER}`);
    expect(shown.tail).toBe(`${PEM_MARKER}\nt-1\n${PEM_MARKER}\nt-2\n${PEM_MARKER}\n`);
    expect(leaks(result, key)).toBe(false);
  });

  it('drops a secret cut mid-line at the head’s end and at the tail’s start, registered or not', () => {
    const secret = ['Zq8W', 'v3Lm', '5Tr7', 'Xk2P'].join('');
    const head = `safe-1\nkey=${secret.slice(0, 7)}`;
    const subject = clipped(head, `${secret.slice(7)} rest\nsafe-2\n`);
    for (const known of [registryOf(), registryOf([secret])]) {
      const result = toolIoText(subject, known)!;
      expect(result).toBe(
        `Input\n${json({ a: 1 })}\n\nOutput — clipped: first 6 and last 7 characters shown; the middle was not kept\nsafe-1\n…\nsafe-2\n`
      );
      expect(leaks(result, [secret])).toBe(false);
    }
  });

  describe('a cut inside an OSC string', () => {
    const probe = ['audit', 'Only', 'Alpha', 'Beta', '98765'].join('');
    /** An OSC string opened in the head, its terminator in the tail. */
    const raw =
      'safe\n' +
      'x'.repeat(6200) +
      `password=${ESC}]` +
      'a'.repeat(2200) +
      `\nignored\x07${probe}\nend\n`;
    const e6 = clipped(raw.slice(0, 6144), raw.slice(-2048), { input: null });
    // Dropping lines past the one the cut went through is said, not silent: the
    // tail held a terminator, so the note says it was found, not that a sequence hid the rest.
    const noted = `\n\n${OUTPUT_START_HIDDEN}`;

    it('drops a tail through the line that ends the cut string, registered or not, and says so', () => {
      for (const known of [registryOf(), registryOf([probe])]) {
        const result = toolIoText(e6, known)!;
        expect(result).not.toBeNull();
        const { head, tail } = previewOf(result);
        expect(head).toBe('safe');
        expect(tail).toBe(`end\n${noted}`);
        expect(result).not.toContain('ignored');
        expect(leaks(result, [probe])).toBe(false);
      }
    });

    it('drops a tail through a terminator written as escaped text or as ST, and says so', () => {
      for (const terminator of ['\\u0007', '\\x07', `${ESC}\\`, '\\u001b\\\\', '\x9c']) {
        const tail = `aaa\nbody${terminator}${probe}\nsafe-2\n`;
        const { tail: shown } = previewOf(toolIoText(clipped('h-1\nh', tail), registry)!);
        expect(shown, JSON.stringify(terminator)).toBe(`safe-2\n${noted}`);
      }
      // A terminator in the line the cut went through drops nothing more: no note.
      const first = previewOf(toolIoText(clipped('h-1\nh', 'a\x07b\nsafe-2\n'), registry)!);
      expect(first.tail).toBe('safe-2\n');
    });

    it('leaves a tail whose strings open in it, or with no string at all, as before', () => {
      const plain = previewOf(toolIoText(clipped('h-1\nh', 'cut\nline-1\nline-2\n'), registry)!);
      expect(plain.tail).toBe('line-1\nline-2\n');
      const whole = `cut\nline-1 ${ESC}]0;title\x07shown\nline-2 \x07bell\n`;
      const titled = previewOf(toolIoText(clipped('h-1\nh', whole), registry)!);
      expect(titled.tail).toBe('line-1 shown\nline-2 bell\n');
    });

    it('drops a head from an OSC string it opens and does not terminate', () => {
      for (const opener of [`${ESC}]`, '\\u001b]', '\x9d']) {
        const head = `h-1\nh-2 ${ESC}]0;t\x07ok\nh-3 ${opener}0;${probe}\nmore\npartial`;
        const { head: shown } = previewOf(toolIoText(clipped(head, 'x\nt-1\n'), registry)!);
        expect(shown, JSON.stringify(opener)).toBe('h-1\nh-2 ok');
      }
    });
  });

  it('masks an unclosed quoted password value to its line end', () => {
    const probe = ['audit', 'Only', 'Alpha', 'Beta', '98765'].join('');
    for (const quote of ['\\"', '"', "'"]) {
      const result = toolIoText(detail({ output: `password=${quote}${probe}\nnext\n` }), registry)!;
      expect(result, quote).toBe(
        `${NOT_REPORTED_INPUT}\n\nOutput\npassword=${quote}${MARKER}\nnext\n`
      );
      expect(leaks(result, [probe])).toBe(false);
    }
  });

  it('shows the side that keeps a whole line, and only the note when neither does', () => {
    expect(toolIoText(clipped('partial', 'cut\nlast\n'), registry)).toBe(
      `Input\n${json({ a: 1 })}\n\nOutput — clipped: first 0 and last 5 characters shown; the middle was not kept\n…\nlast\n`
    );
    expect(toolIoText(clipped('first\ncut', 'cut'), registry)).toBe(
      `Input\n${json({ a: 1 })}\n\nOutput — clipped: first 5 and last 0 characters shown; the middle was not kept\nfirst\n…`
    );
    expect(toolIoText(clipped('one line', 'no newline'), registry)).toBe(
      `Input\n${json({ a: 1 })}\n\n${noWholeLine()}`
    );
    // As the Codex collab prompt, under its own label.
    const prompt = clipped('one', 'line', { type: 'subagent', input: { senderThreadId: 't1' } });
    expect(toolIoText(prompt, registry)).toBe(noWholeLine('Prompt'));
  });

  it('masks a multi-line known value whose middle lines land in the tail, line by line', () => {
    const lines = keyLines(50, 4).map((line, at) => `cfg-${at}-${line.slice(0, 40)}`);
    const known = registryOf([lines.join('\n')]);
    const output = `${'head-ok\n'.repeat(1000)}${lines.join('\n')}\nend-ok\n`;
    const kept = viaBuffer(tool({ a: 1 }, output));
    expect(kept.outputClipped).toBe(true);
    // The value starts in the dropped middle: only its later lines are kept.
    expect(kept.tail).not.toContain(lines[0]);
    expect(kept.tail).toContain(lines.at(-1));
    const result = toolIoText(kept, known)!;
    const { tail } = previewOf(result);
    expect(tail).toMatch(new RegExp(`^(?:${MARKER.replace(/[[\]]/g, '\\$&')}\\n)+end-ok\\n$`));
    expect(containsKnownForm(result, known)).toBe(false);
    for (const line of lines) expect(result).not.toContain(line.slice(-20));
  });

  it('masks a shared-pattern token whole inside the head and inside the tail', () => {
    const token = github('p');
    const output = `first-ok\ntoken ${token}\n${'fill-line\n'.repeat(900)}last ${token}\nend-ok\n`;
    const result = toolIoText(viaBuffer(tool({ a: 1 }, output)), registry)!;
    const { head, tail } = previewOf(result);
    expect(head.startsWith('first-ok\ntoken [REDACTED_GITHUB_TOKEN]\nfill-line')).toBe(true);
    expect(tail.endsWith('last [REDACTED_GITHUB_TOKEN]\nend-ok\n')).toBe(true);
    expect(result).not.toContain(token.slice(4));
  });

  it('splits the budget so neither part crowds out the other, at line ends', () => {
    const rows = Array.from({ length: 1500 }, (_, at) => `row-${String(at).padStart(4, '0')}`);
    const output = `${rows.join('\n')}\n`;
    const result = toolIoText(viaBuffer(tool({ a: 1 }, output)), registry)!;
    expect(codePoints(result)).toBeLessThanOrEqual(TOOL_IO_BUDGET);
    expect(codePoints(result)).toBeGreaterThan(TOOL_IO_BUDGET - 120);
    const { first, last, head, tail } = previewOf(result);
    expect(first).toBe(codePoints(head));
    expect(last).toBe(codePoints(tail));
    expect(first).toBeGreaterThan(850);
    expect(last).toBeGreaterThan(850);
    expect(Math.abs(first - last)).toBeLessThan(20);
    expect(output.startsWith(`${head}\n`)).toBe(true);
    expect(output.endsWith(tail)).toBe(true);
    expect(tail.startsWith('row-')).toBe(true);
    // A short head leaves the rest of the room to the tail.
    const short = previewOf(toolIoText(clipped('only-line\npartial', output), registry)!);
    expect(short.head).toBe('only-line');
    expect(short.last).toBeGreaterThan(1700);
    expect(output.endsWith(short.tail)).toBe(true);
  });
});

describe('final check on the text returned', () => {
  const secret = ['Hq7L', 'z2Wx', '9Pd4', 'Rt6N'].join('');
  const registry = registryOf(envKnownValues({ API_TOKEN: secret }));
  const output = `${'line\n'.repeat(500)}token ${secret} end`;
  const subject = detail({ output, truncated: false });

  it('passes with the real cutter', () => {
    const result = toolIoText(subject, registry)!;
    expect(result).not.toBeNull();
    expect(leaks(result, [secret])).toBe(false);
  });

  it('gives null when a faulty cutter cuts inside a marker', () => {
    const insideMarker: Cutter = (text, markerRanges) => {
      const marker = markerRanges[0];
      if (!marker) return { text, markerRanges: [...markerRanges] };
      return { text: text.slice(0, marker[0] + 4), markerRanges: [...markerRanges] };
    };
    const tail = detail({ output: `token ${secret} end`, input: null });
    expect(composeToolIoText(tail, registry, insideMarker)).toBeNull();
  });

  it('gives null when a faulty cutter appends masked text again', () => {
    const appending: Cutter = (text, markerRanges, budget) => {
      const cut = cutToBudget(text, markerRanges, budget - 20);
      return { text: `${cut.text}${secret}`, markerRanges: cut.markerRanges };
    };
    expect(composeToolIoText(subject, registry, appending)).toBeNull();
  });
});

describe('the search view in a detail and in the final check', () => {
  const secret = ['Hq7L', 'z2Wx', '9Pd4', 'Rt6N'].join('');
  const registry = registryOf(envKnownValues({ API_TOKEN: secret }));
  const shy = (value: string) => Array.from(value).join('\u00ad');

  it('masks a known value interleaved with soft hyphens or spelled as escapes, in the input and the output', () => {
    const spelled = `${secret.slice(0, 4)}\\x7f${secret.slice(4)}`;
    for (const value of [
      shy(secret),
      spelled,
      `${secret.slice(0, 4)}\\\\u200b${secret.slice(4)}`,
    ]) {
      const input = toolIoText(detail({ input: { command: `echo ${value}` } }), registry);
      expect(input, value).toBe(
        `Input\n${json({ command: `echo ${MARKER}` })}\n\nOutput — not captured`
      );
      const output = toolIoText(detail({ output: `got ${value}\n` }), registry);
      expect(output, value).toBe(`${NOT_REPORTED_INPUT}\n\nOutput\ngot ${MARKER}\n`);
    }
  });

  it('gives null when a faulty cutter appends the value interleaved with soft hyphens', () => {
    const appending: Cutter = (text, markerRanges, budget) => {
      const cut = cutToBudget(text, markerRanges, budget - 40);
      return { text: `${cut.text}${shy(secret)}`, markerRanges: cut.markerRanges };
    };
    expect(composeToolIoText(detail({ output: 'ok\n' }), registry, appending)).toBeNull();
  });

  it('masks a session value TOKEN and a Basic password GITHUB, and gives our marker to a token whose marker holds them', () => {
    const basic = Buffer.from('deploy:GITHUB').toString('base64');
    const values = [
      'TOKEN',
      ...hostKnownValues({
        env: {},
        mcpServers: {
          a: { transport: 'http', url: 'https://x', headers: { Authorization: `Basic ${basic}` } },
        },
      }),
    ];
    expect(values).toContain('GITHUB');
    const known = registryOf(values);
    expect(toolIoText(detail({ output: 'TOKEN and GITHUB\n' }), known)).toBe(
      `${NOT_REPORTED_INPUT}\n\nOutput\n${MARKER} and ${MARKER}\n`
    );
    expect(toolIoText(detail({ output: `use ${github('p')} now` }), known)).toBe(
      `${NOT_REPORTED_INPUT}\n\nOutput\nuse ${MARKER} now`
    );
  });
});

describe('time', () => {
  it('stays linear on an adversarial 20,000-character input', () => {
    const registry = registryOf([
      'aaaaaa',
      ...envKnownValues({ API_KEY: 'aaaaaaaaaaaaaaaa', X_TOKEN: 'ghp_' + 'a'.repeat(36) }),
    ]);
    const fill = (unit: string, size: number) =>
      unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    for (const unit of [
      'a',
      'ghp_',
      'sk-',
      'eyJ',
      'password=',
      '--token ',
      'a://',
      '-----BEGIN A-----',
      '\\u001b[',
      `${ESC}[`,
      `a${ZW}`,
      `a${BS}`,
      'Authorization: Bearer ',
    ]) {
      const input = Object.fromEntries(
        Array.from({ length: 8 }, (_, at) => [`k${at}`, fill(unit, 2500)])
      );
      const subject = detail({ input, output: fill(unit, 8192) });
      const started = performance.now();
      toolIoText(subject, registry);
      expect(performance.now() - started, unit).toBeLessThan(1000);
    }
  });
});

describe('liveness with a realistic environment', () => {
  // Synthetic, put together at run time.
  const password = ['Ns3H', 'k8Qz', '6Fv1'].join('');
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/user',
    SHELL: '/bin/bash',
    PWD: '/home/user/project',
    OLDPWD: '/home/user',
    LANG: 'en_US.UTF-8',
    GIT_AUTHOR_NAME: 'Ada Lovelace',
    GIT_COMMITTER_EMAIL: 'ada@example.test',
    GOOGLE_APPLICATION_CREDENTIALS: '/home/user/project/service-account.json',
    KEYCLOAK_URL: 'https://kc.example/realms/x',
    SSH_AUTH_SOCK: '/tmp/ssh-XXXX/agent.42',
    DATABASE_URL: `postgres://postgres:${password}@db/app`,
    ANTHROPIC_API_KEY: ['sk-ant-', 'Qm7vR2Xk9pT4', 'Hq7Lz2Wx9Pd4', 'Rt6N'].join(''),
    // A known value that contains a header word.
    DEPLOY_TOKEN: ['Output', 'Qm7v', 'R2Xk', 'Input'].join('-'),
  };
  const registry = registryOf(envKnownValues(env));

  const command = (line: string, output: string) =>
    viaBuffer(
      mapCodexItem(
        {
          type: 'commandExecution',
          id: 'c',
          command: line,
          cwd: env.PWD,
          status: 'completed',
          aggregatedOutput: output,
          exitCode: 0,
        },
        'completed'
      )
    );

  const verbatim = (line: string, output: string) =>
    `Input\n${json({ command: line, cwd: env.PWD, exitCode: 0 })}\n\nOutput\n${norm(output)}`;

  it('shows ls, git status, cat package.json and psql -U postgres as they are, after norm', () => {
    const packageJson = {
      name: '@example/project',
      version: '1.4.2',
      scripts: { test: 'vitest', build: 'tsc -b' },
      dependencies: { zod: '^3.23.8' },
    };
    const cases: [string, string][] = [
      [
        'ls -la',
        'total 16\ndrwxr-xr-x 4 user user 4096 Oct 31 10:00 .\ndrwxr-xr-x 9 user user 4096 Oct 31 09:00 ..\n-rw-r--r-- 1 user user  512 Oct 31 10:00 package.json\n',
      ],
      [
        'git status',
        `On branch main\nChanges not staged for commit:\n\t${ESC}[31mmodified:   src/index.ts${ESC}[m\r\n\nno changes added to commit (use "git add")\n`,
      ],
      ['cat package.json', `${json(packageJson)}\n`],
      [
        'psql -U postgres -h db app',
        'psql: error: connection to server at "db" (10.0.0.5), port 5432 failed: FATAL:  role "postgres" does not exist\n',
      ],
      ['pwd', `${env.PWD}\n`],
      ['git log -1 --format=%an', `${env.GIT_AUTHOR_NAME}\n`],
    ];
    for (const [line, output] of cases)
      expect(toolIoText(command(line, output), registry), line).toBe(verbatim(line, output));
  });

  it('a known value containing `Output` does not drop a normal detail', () => {
    const result = toolIoText(command('ls', 'a.txt\n'), registry);
    expect(result).toBe(verbatim('ls', 'a.txt\n'));
    expect(containsKnownForm(result!, registry)).toBe(false);
  });

  it('shows a `Bearer $TOKEN` line as it is but for the variable, with the JSON escapes kept', () => {
    // The shared pattern takes any word after `Authorization: Bearer` as the
    // credential, a variable reference included; it stops at the escaping
    // backslash, so the input stays valid JSON.
    const line = 'curl -H "Authorization: Bearer $TOKEN" https://api.example.test/v1';
    const shown = `curl -H "Authorization: ${MARKER}" https://api.example.test/v1`;
    const result = toolIoText(command(line, '{"ok":true}\n'), registry);
    expect(result).toBe(verbatim(shown, '{"ok":true}\n'));
    expect(result).toContain(`\\"Authorization: ${MARKER}\\" https://`);
    expect(result).not.toContain('$TOKEN');
  });

  it('still masks the real secrets', () => {
    const output = `ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY}\nlogin postgres:${password}\n`;
    const result = toolIoText(command('env', output), registry);
    expect(result).toBe(verbatim('env', `ANTHROPIC_API_KEY=${MARKER}\nlogin ${MARKER}\n`));
  });
});

/** mulberry32: small, seeded, the same on every run. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe('random cases through a real buffer', () => {
  /** The known values a case registers its secret as. */
  function valuesOf(source: 'env' | 'mcp' | 'session' | 'pattern', secret: string): string[] {
    if (source === 'session') return [secret];
    if (source === 'pattern') return [];
    if (source === 'env') return hostKnownValues({ env: { DEPLOY_TOKEN: secret }, mcpServers: {} });
    const headers = { 'X-Api-Key': secret };
    return hostKnownValues({
      env: {},
      mcpServers: { docs: { transport: 'http', url: 'https://x', headers } },
    });
  }

  it(
    'shows no whole known value form and keeps the safe part, over 600 cases',
    () => {
      const next = random(803);
      const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
      const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
      const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const removed = [
        ZW,
        `${ESC}[0m`,
        `${ESC}]0;t\x07`,
        ESC,
        '\x07',
        BS,
        '\u202e',
        '\u2060',
        '\x7f',
      ];
      const escaped = [
        String.raw`\u001b[31m`,
        String.raw`\x1b[0m`,
        String.raw`\u0007`,
        String.raw`\u200b`,
        String.raw`\u001b]0;t\u0007`,
      ];
      // Token families a shared pattern knows, with how many characters follow the prefix.
      const families: [string, number, number][] = [
        ['gh' + 'p_', 36, 44],
        ['sk-' + 'ant-', 20, 40],
        ['gl' + 'pat-', 20, 40],
        ['xo' + 'xb-', 15, 40],
      ];
      const outcomes = { masked: 0, labelled: 0, clipped: 0 };
      for (let index = 0; index < 600; index++) {
        const source = pick(['env', 'mcp', 'session', 'pattern'] as const);
        let secret: string;
        if (source === 'pattern') {
          const [prefix, low, high] = pick(families);
          secret = prefix;
          for (let at = int(low, high); at > 0; at--)
            secret += ALPHABET[int(0, ALPHABET.length - 1)];
        } else {
          secret = '';
          for (let at = int(16, 44); at > 0; at--) secret += ALPHABET[int(0, ALPHABET.length - 1)];
        }
        const registry = registryOf(valuesOf(source, secret));
        const perturbation = pick(['plain', 'split', 'escaped', 'astral'] as const);
        const where = pick(['input', 'output'] as const);
        const split = int(1, secret.length - 1);
        const head = secret.slice(0, split);
        const tail = secret.slice(split);
        let text = secret;
        if (perturbation === 'split') text = `${head}${pick(removed)}${tail}`;
        if (perturbation === 'escaped') text = `${head}${pick(escaped)}${tail}`;
        const live = `live-${index}-ok`;
        let payload: Record<string, unknown>;
        let output: string;
        if (where === 'input') {
          const limit = 3000;
          const before =
            perturbation === 'astral'
              ? EMOJI.repeat(Math.max(0, Math.floor((limit - int(0, secret.length)) / 2)))
              : 'run ';
          payload = pick([
            { command: `${before}${text} --flag`, cwd: '/w' },
            { env: { [text]: 'value' }, cwd: '/w' },
            { args: ['a', { nested: `${before}${text}` }] },
          ]);
          output = `${live}\n${'done\n'.repeat(int(0, 5))}`;
        } else {
          const limit = 8192;
          const before =
            perturbation === 'astral'
              ? EMOJI.repeat(Math.floor((limit - int(-10, secret.length + 10)) / 2))
              : 'line\n'.repeat(int(0, 30));
          payload = { command: `echo ${live}`, cwd: '/w', exitCode: 0 };
          output = `${before}${text}\n${'tail\n'.repeat(int(0, 5))}`;
        }
        const deltas: string[] = [];
        let cursor = 0;
        while (cursor < output.length) {
          const size = int(1, 600);
          deltas.push(output.slice(cursor, cursor + size));
          cursor += size;
        }
        const item: ProviderItem = {
          id: 'call',
          type: 'command_execution',
          status: 'in_progress',
          title: 'call',
          payload,
        };
        const kept = viaBuffer(item, deltas);
        const result = toolIoText(kept, registry);
        const label = `case ${index}: ${source} ${perturbation} ${where}`;
        expect(result, label).not.toBeNull();
        expect(containsKnownForm(result!, registryOf([secret])), label).toBe(false);
        expect(result!, label).not.toContain(secret);
        expect(result!, label).toContain(live);
        if (result!.includes('too large') || result!.includes('— clipped')) outcomes.clipped++;
        else if (result!.includes('[REDACTED_')) outcomes.labelled++;
        else if (result!.includes(MARKER)) outcomes.masked++;
      }
      // The cases reach each way a secret is kept from the text.
      expect(outcomes.masked).toBeGreaterThan(150);
      expect(outcomes.labelled).toBeGreaterThan(50);
      expect(outcomes.clipped).toBeGreaterThan(10);
    },
    EXHAUSTIVE_TIMEOUT_MS
  );
});

describe('random clipped outputs through a real buffer', () => {
  it(
    'drops every piece of a secret a cut crosses and masks each known value kept, over 600 cases',
    () => {
      const next = random(8031);
      const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
      const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
      const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const word = (length: number) => {
        let text = '';
        for (let at = 0; at < length; at++) text += ALPHABET[int(0, ALPHABET.length - 1)];
        return text;
      };
      const HEAD = 6 * 1024;
      const TAIL = 2 * 1024;
      // Cases whose tail is shown from its first whole line: without the drop,
      // the piece of the secret before it would have been shown as well.
      let tailShownWhole = 0;
      for (let index = 0; index < 600; index++) {
        // Not registered and not token-shaped: only dropping the cut line keeps them out.
        const across = [word(int(16, 40)), word(int(16, 40))] as const;
        const known = word(int(16, 40));
        const values = hostKnownValues({ env: { DEPLOY_TOKEN: known }, mcpServers: {} });
        const registry = registryOf(values);
        const astral = next() < 0.5;
        const filler = () =>
          astral && next() < 0.8
            ? EMOJI.repeat(int(1, 20))
            : `${pick(['ok', 'line', 'done', 'step'])} ${int(0, 999)}`;
        const knownLine = () => {
          const split = int(1, known.length - 1);
          const between = pick(['', ZW, `${ESC}[0m`, BS]);
          return `token ${known.slice(0, split)}${between}${known.slice(split)}`;
        };

        // The head: a safe line, maybe a known value, then lines up to the cut.
        let output = `safe-${index}-ok\n`;
        if (next() < 0.5) output += `${knownLine()}\n`;
        const k = int(1, across[0].length - 1);
        const lead = int(0, 60);
        // A short head keeps one whole line, so the tail gets nearly all the room.
        const shortHead = next() < 0.5;
        while (!shortHead && output.length < HEAD - k - lead - 60) output += `${filler()}\n`;
        // Pad so the secret starts `k` code units before the head's cut.
        const gap = HEAD - k - lead - output.length;
        output += shortHead ? 'g'.repeat(gap) : `${'g'.repeat(gap - 1)}\n`;
        output += `${'q'.repeat(lead)}${across[0]} rest\n`;
        // The middle, which the buffer drops.
        for (let line = int(0, 200); line > 0; line--) output += `${filler()}\n`;
        // The tail's cut, `k2` code units into the second secret.
        const k2 = int(1, across[1].length - 1);
        output += `${'r'.repeat(int(0, 60))}${across[1]}`;
        const room = TAIL - (across[1].length - k2);
        const end = `tail-${index}-ok\n`;
        const closing = next() < 0.5 ? `${knownLine()}\n${end}` : end;
        let after = ` rest\nfirst-${index}\n`;
        while (after.length < room - closing.length - 60) after += `${filler()}\n`;
        after += `${'z'.repeat(room - closing.length - after.length - 1)}\n${closing}`;
        output += after;

        const deltas: string[] = [];
        let cursor = 0;
        while (cursor < output.length) {
          const size = int(1, 600);
          deltas.push(output.slice(cursor, cursor + size));
          cursor += size;
        }
        // A Codex file change shows only its output, which then has all the room.
        const fileChange = next() < 0.5;
        const item: ProviderItem = {
          id: 'call',
          type: fileChange ? 'file_change' : 'command_execution',
          status: 'in_progress',
          title: 'call',
          payload: fileChange
            ? { changes: [{ path: 'x', kind: 'update' }] }
            : { command: `echo ${index}`, cwd: '/w' },
        };
        const kept = viaBuffer(item, deltas);
        const label = `case ${index}: astral=${astral} short=${shortHead} file=${fileChange}`;
        // The cuts fall where the case put them: inside each secret.
        expect(kept.outputClipped, label).toBe(true);
        expect(kept.head.endsWith(across[0].slice(0, k)), label).toBe(true);
        expect(kept.tail.startsWith(across[1].slice(k2)), label).toBe(true);
        const result = toolIoText(kept, registry);
        expect(result, label).not.toBeNull();
        expect(codePoints(result!), label).toBeLessThanOrEqual(TOOL_IO_BUDGET);
        expect(result!, label).toMatch(CLIPPED_NOTE);
        expect(containsKnownForm(result!, registryOf([known, ...across])), label).toBe(false);
        expect(leaks(result!, [...across, known]), label).toBe(false);
        expect(result!, label).toContain(`safe-${index}-ok`);
        expect(result!, label).toContain(end);
        if (result!.includes(`\n…\nfirst-${index}\n`)) tailShownWhole++;
      }
      expect(tailShownWhole).toBeGreaterThan(30);
    },
    EXHAUSTIVE_TIMEOUT_MS
  );
});

describe('a private key with one armor line in an input string or a server name', () => {
  const registry = registryOf();
  const kind = ['PRIV', 'ATE KEY'].join('');
  const lines = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj'];

  it('masks an input string from a lone BEGIN to its end, and from its start to a lone END', () => {
    const begin = inputText({
      path: 'key.pem',
      content: `-----BEGIN ${kind}-----\n${lines.join('\n')}`,
    });
    expect(begin).toBe(json({ path: 'key.pem', content: PEM_MARKER }));
    const end = inputText({ content: `${lines.join('\n')}\n-----END ${kind}-----\nok`, path: 'k' });
    expect(end).toBe(json({ content: `${PEM_MARKER}\nok`, path: 'k' }));
    const escaped = inputText({ content: `x\n-----\\u0042EGIN OPENSSH ${kind}-----\n${lines[0]}` });
    expect(escaped).toBe(json({ content: `x\n${PEM_MARKER}` }));
  });

  it('masks every key-material label, and leaves other labels alone', () => {
    for (const label of [
      kind,
      `RSA ${kind}`,
      `EC ${kind}`,
      `ENCRYPTED ${kind}`,
      `PGP ${kind} BLOCK`,
    ]) {
      const output = `-----BEGIN ${label}-----\n${lines[0]}`;
      expect(toolIoText(detail({ output }), registry), label).toBe(
        `${NOT_REPORTED_INPUT}\n\nOutput\n${PEM_MARKER}`
      );
    }
    for (const label of ['LOG', 'CERTIFICATE', 'PUBLIC KEY']) {
      const output = `-----BEGIN ${label}-----\n${lines[0]}`;
      expect(toolIoText(detail({ output }), registry), label).toBe(
        `${NOT_REPORTED_INPUT}\n\nOutput\n${output}`
      );
      const input = { content: `${lines[0]}\n-----END ${label}-----` };
      expect(inputText(input), label).toBe(json(input));
    }
  });

  it('masks a server name with a lone BEGIN, and says when an OSC string hid its rest', () => {
    const call = (server: string) =>
      viaBuffer(
        mapCodexItem(
          { type: 'mcpToolCall', id: 'm', server, tool: 'ping', status: 'completed', error: null },
          'completed'
        )
      );
    expect(toolIoText(call(`srv -----BEGIN ${kind}----- ${lines[0]}`), registry)).toBe(
      `Server: srv ${PEM_MARKER}\n\n${NOT_REPORTED_INPUT}`
    );
    const hidden =
      'Server name — a terminal control sequence with no end hid the rest; it is not shown';
    expect(toolIoText(call(`public${ESC}]0;hidden`), registry)).toBe(
      `Server: public\n${hidden}\n\n${NOT_REPORTED_INPUT}`
    );
    expect(toolIoText(call(`public${ESC}]0;title\x07-name`), registry)).toBe(
      `Server: public-name\n\n${NOT_REPORTED_INPUT}`
    );
    const long = toolIoText(call(`${'s'.repeat(201)}${ESC}]0;hidden`), registry)!;
    expect(long).toBe(
      `Server: ${'s'.repeat(200)}\nServer name — first 200 of 201 characters shown\n${hidden}\n\n${NOT_REPORTED_INPUT}`
    );
  });
});

/** Every run of 12 code units in `text`, to look a key line's pieces up in. */
function piecesOf(text: string): Set<string> {
  const pieces = new Set<string>();
  for (let at = 0; at + 12 <= text.length; at++) pieces.add(text.slice(at, at + 12));
  return pieces;
}

/** Whether 12 code units in a row of any of `lines` are in `shown` (`piecesOf`). */
function showsAnyOf(shown: Set<string>, lines: readonly string[]): boolean {
  return lines.some((line) => {
    for (let at = 0; at + 12 <= line.length; at++)
      if (shown.has(line.slice(at, at + 12))) return true;
    return false;
  });
}

describe('random PEM blocks and OSC strings, cut by the tool and by a real buffer', () => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const SHY = '­';
  const kind = ['PRIV', 'ATE KEY'].join('');
  const KEY_LABELS = [
    kind,
    `RSA ${kind}`,
    `EC ${kind}`,
    `DSA ${kind}`,
    `OPENSSH ${kind}`,
    `ENCRYPTED ${kind}`,
    `PGP ${kind} BLOCK`,
  ];
  const OTHER_LABELS = [
    'LOG',
    'CERTIFICATE',
    'PUBLIC KEY',
    'X509 CRL',
    'PGP MESSAGE',
    'TEST REPORT',
  ];

  /** A seeded case maker: numbers, picks, base64 lines, armor lines in one of four spellings. */
  function maker(seed: number) {
    const next = random(seed);
    const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
    const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
    const base64 = (length: number) => {
      let text = '';
      for (let at = 0; at < length; at++) text += B64[int(0, 63)];
      return text;
    };
    const armor = (word: 'BEGIN' | 'END', label: string) => {
      const hex = word.charCodeAt(0).toString(16);
      const spelling = pick(['plain', 'plain', 'u', 'x', 'shy'] as const);
      if (spelling === 'u') return `-----\\u00${hex}${word.slice(1)} ${label}-----`;
      if (spelling === 'x') return `-----\\x${hex}${word.slice(1)} ${label}-----`;
      const line = `${word} ${label}`;
      const at = spelling === 'shy' ? int(1, line.length - 1) : line.length;
      return `-----${line.slice(0, at)}${spelling === 'shy' ? SHY : ''}${line.slice(at)}-----`;
    };
    /** `output` as deltas of random sizes, through a real buffer. */
    const kept = (output: string) => {
      const deltas: string[] = [];
      for (let cursor = 0; cursor < output.length;) {
        const size = int(1, 900);
        deltas.push(output.slice(cursor, cursor + size));
        cursor += size;
      }
      const item: ProviderItem = {
        id: 'call',
        type: 'command_execution',
        status: 'in_progress',
        title: 'call',
        payload: { command: 'cat key.pem', cwd: '/w' },
      };
      return viaBuffer(item, deltas);
    };
    return { next, int, pick, base64, armor, kept };
  }

  // Each random case runs on a fixed list of seeds, so a result does not hang on one.
  const SEEDS = [9031, 9034, 9035, 9036];

  it.each(SEEDS)(
    'shows no line of a private key the tool or the buffer cut, and the ordinary lines around it, over 300 cases (seed %i)',
    (seed) => {
      const { next, int, pick, base64, armor, kept } = maker(seed);
      const counts = {
        tested: 0,
        clipped: 0,
        whole: 0,
        prefixShown: 0,
        suffixShown: 0,
        beginNotInHead: 0,
      };
      for (let index = 0; index < 300; index++) {
        const label = pick(KEY_LABELS);
        const key = Array.from({ length: int(1, 160) }, () => base64(64));
        // Up to about 7,800 code units, past the head the buffer keeps (6,144),
        // so the buffer cuts `BEGIN` too, or drops it with the middle; sometimes
        // as one long line.
        const prefix =
          next() < 0.2
            ? [`pre ${index} ${'w'.repeat(int(5000, 7000))}`]
            : Array.from({ length: int(0, 650) }, (_, n) => `pre ${index} ${n}`);
        const suffix = Array.from({ length: int(0, 300) }, (_, n) => `post ${index} ${n}`);
        const [begin, end] = [armor('BEGIN', label), armor('END', label)];
        const all = [...prefix, begin, ...key, end, ...suffix];
        // The tool keeps all of it, its first lines (no END), or its last lines (no BEGIN).
        const cut = pick(['whole', 'first', 'last'] as const);
        const lines =
          cut === 'first'
            ? all.slice(0, prefix.length + 1 + int(0, key.length))
            : cut === 'last'
              ? all.slice(prefix.length + 1 + int(0, key.length - 1))
              : all;
        const output = `${lines.join('\n')}${next() < 0.5 ? '\n' : ''}`;
        const detail = kept(output);
        // Every case counts: a key whose armor lines the buffer drops or cuts
        // may still have its body lines in the head or the tail.
        counts.tested++;
        const beginAt = cut === 'last' ? -1 : output.indexOf(begin);
        if (detail.outputClipped && beginAt !== -1 && beginAt + begin.length > detail.head.length)
          counts.beginNotInHead++;
        const name = `case ${index}: ${label} cut=${cut} clipped=${detail.outputClipped}`;
        const result = toolIoText(detail, registryOf());
        expect(result, name).not.toBeNull();
        expect(showsAnyOf(piecesOf(result!), key), name).toBe(false);
        if (detail.outputClipped) counts.clipped++;
        if (cut === 'whole') counts.whole++;
        if (prefix.length > 0 && cut !== 'last' && result!.includes(`\n${prefix[0]}\n`))
          counts.prefixShown++;
        if (
          suffix.length > 0 &&
          cut !== 'first' &&
          withoutKeyNote(result!).endsWith(suffix.at(-1)!)
        )
          counts.suffixShown++;
        // A clipped output keeps its ordinary first and last lines, whatever the key between them.
        if (detail.outputClipped && cut !== 'last' && prefix.length > 1)
          expect(result!, name).toContain(`\n${prefix[0]}\n`);
        if (detail.outputClipped && cut !== 'first' && suffix.length > 0)
          expect(withoutKeyNote(result!).trimEnd().endsWith(suffix.at(-1)!), name).toBe(true);
        // A whole block in an output the buffer kept whole leaves what is around it.
        if (cut === 'whole' && !detail.outputClipped && suffix.length > 0 && output.length < 1500)
          expect(result!, name).toContain(suffix.at(-1)!);
      }
      expect(counts.tested).toBe(300);
      expect(counts.clipped).toBeGreaterThan(60);
      expect(counts.beginNotInHead).toBeGreaterThan(20);
      expect(counts.whole).toBeGreaterThan(60);
      // Masking does not take everything: the lines around a key are still shown.
      expect(counts.prefixShown).toBeGreaterThan(60);
      expect(counts.suffixShown).toBeGreaterThan(30);
    },
    EXHAUSTIVE_TIMEOUT_MS
  );

  it.each([9032, 9000, 9001, 9002])(
    'masks nothing past a lone armor line of another label and shows its body lines, over 200 cases (seed %i)',
    (seed) => {
      const { next, int, pick, base64, armor, kept } = maker(seed);
      const counts = { lastShown: 0, nextShown: 0, bodyShown: 0 };
      for (let index = 0; index < 200; index++) {
        const label = pick(OTHER_LABELS);
        const begins = next() < 0.5;
        const line = armor(begins ? 'BEGIN' : 'END', label);
        // A short start puts the armor line where the shown head reaches it.
        const before = Array.from(
          { length: next() < 0.5 ? int(0, 30) : int(0, 600) },
          (_, n) => `before ${index} ${n}`
        );
        // Base64 under 40 characters: no key line, which a preview would mask whatever the label.
        const body = Array.from({ length: int(1, 40) }, () => base64(int(4, 39)));
        const after = Array.from({ length: int(1, 600) }, (_, n) => `after ${index} ${n}`);
        const output = begins
          ? [...before, line, ...body, ...after].join('\n')
          : [...before, ...body, line, ...after].join('\n');
        const detail = kept(output);
        const name = `case ${index}: ${line} clipped=${detail.outputClipped}`;
        const result = toolIoText(detail, registryOf());
        expect(result, name).not.toBeNull();
        expect(result!, name).not.toContain(PEM_MARKER);
        // A clipped output's last line is in its preview's tail.
        if (detail.outputClipped) {
          expect(result!.endsWith(after.at(-1)!), name).toBe(true);
          counts.lastShown++;
        }
        // The line after the armor line, wherever it is shown, is shown with it.
        if (result!.includes(`${line}\n`)) {
          expect(result!, name).toContain(`${line}\n${begins ? body[0] : after[0]}`);
          counts.nextShown++;
        }
        // The body lines, when the shown text reaches them, are shown as they are.
        if (result!.includes(`\n${body.join('\n')}\n`)) counts.bodyShown++;
      }
      expect(counts.lastShown).toBeGreaterThan(40);
      expect(counts.nextShown).toBeGreaterThan(40);
      expect(counts.bodyShown).toBeGreaterThan(40);
    },
    EXHAUSTIVE_TIMEOUT_MS
  );

  it(
    'shows nothing an OSC string with no end hides, and says so, over 200 cases',
    () => {
      const { next, int, pick, kept } = maker(9033);
      const HEAD = 6 * 1024;
      const TAIL = 2 * 1024;
      const NOTE = 'Output — a terminal control sequence with no end hid the rest; it is not shown';
      const counts = { open: 0, noted: 0, headOpened: 0, afterShown: 0, tailHidden: 0 };
      for (let index = 0; index < 200; index++) {
        const escaped = next() < 0.4;
        const opener = escaped ? pick(['\\u001b]', '\\x1b]']) : pick([`${ESC}]`, '\x9d']);
        // A string ends at a terminator written as its opener is.
        const terminator = escaped
          ? pick(['\\u0007', '\\x07', '\\u001b\\\\'])
          : pick(['\x07', `${ESC}\\`, '\x9c']);
        const terminated = next() < 0.5;
        // Where the string opens: in what the buffer keeps as its head, or as its tail.
        const where = pick(['head', 'tail', 'short'] as const);
        const lines = int(1, next() < 0.5 ? 40 : 1200);
        const body = Array.from({ length: lines }, (_, n) => `hid ${index} ${n}`).join('\n');
        const after = Array.from({ length: int(1, 200) }, (_, n) => `vis ${index} ${n}`).join('\n');
        const rest = `${opener}0;${body}${terminated ? `${terminator}\n${after}\n` : ''}`;
        let output: string;
        if (where === 'short') output = `start ${index}\n${rest.slice(0, int(10, 1200))}`;
        else if (where === 'head') {
          const lead = int(0, HEAD - 400);
          output = `start ${index}\n${'s'.repeat(lead)}\n${rest}`;
          if (output.indexOf(opener) + opener.length > HEAD - 4) continue;
        } else {
          const lead = 'm\n'.repeat(int(HEAD, HEAD + 3000) / 2);
          output = `start ${index}\n${lead}${rest}`;
          if (output.length - output.lastIndexOf(opener) > TAIL - 4) continue;
        }
        // A string cut off by the case's own slicing never ends.
        const ends = where !== 'short' ? terminated : output.includes(`${terminator}\n`);
        const detail = kept(output);
        const name = `case ${index}: ${where} escaped=${escaped} ends=${ends} clipped=${detail.outputClipped}`;
        const result = toolIoText(detail, registryOf());
        expect(result, name).not.toBeNull();
        expect(result!, name).not.toMatch(new RegExp(`hid ${index} `));
        const lastShown = result!.endsWith(`vis ${index} ${after.split('\n').length - 1}\n`);
        const opened = output.indexOf(opener);
        const endsInHead =
          ends && output.indexOf(terminator, opened) + terminator.length <= detail.head.length;
        if (!ends) {
          counts.open++;
          expect(result!, name).toContain(NOTE);
          counts.noted++;
          if (where === 'head' && detail.outputClipped) counts.headOpened++;
        } else if (where === 'head' && detail.outputClipped && !endsInHead) {
          // The head leaves it open at its cut: the whole tail is hidden, and said so.
          expect(result!, name).toContain(NOTE);
          expect(result!, name).not.toMatch(new RegExp(`vis ${index} `));
          counts.tailHidden++;
        } else if (detail.outputClipped && lastShown) counts.afterShown++;
      }
      expect(counts.open).toBeGreaterThan(50);
      expect(counts.headOpened).toBeGreaterThan(10);
      expect(counts.tailHidden).toBeGreaterThan(5);
      expect(counts.afterShown).toBeGreaterThan(10);
    },
    EXHAUSTIVE_TIMEOUT_MS
  );
});

describe('a private key, and ordinary lines, at every position of the buffer’s cuts', () => {
  const HEAD = 6 * 1024;
  const TAIL = 2 * 1024;
  const kind = ['PRIV', 'ATE KEY'].join('');
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  /** `count` lines of `length` base64 characters, the same on every run. */
  const base64Lines = (count: number, seed: number, length = 64) => {
    let state = seed >>> 0;
    return Array.from({ length: count }, () =>
      Array.from({ length }, () => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return B64[(state >>> 16) & 63];
      }).join('')
    );
  };
  // A key of 21 lines: its two armor lines, 18 full lines and a shorter last one.
  const body = [...base64Lines(18, 21), `${base64Lines(1, 22, 30)[0]}==`];
  const key = [`-----BEGIN RSA ${kind}-----`, ...body, `-----END RSA ${kind}-----`];
  /**
   * Ordinary lines `word 0`, `word 1`…, `length` code units in all, the last
   * ending in `\n`. `quiet` lines carry colour resets a terminal does not
   * show, so a head or tail of them is short once shown and the preview shows
   * all of it, the lines next to its cut too.
   */
  const linesOf = (length: number, word: string, quiet = false) => {
    const reset = quiet ? `${ESC}[0m`.repeat(20) : '';
    let text = '';
    for (let n = 0; length - text.length > 120; n++) text += `${word} ${n}${reset}\n`;
    const left = length - text.length;
    return left > 0 ? `${text}${'.'.repeat(left - 1)}\n` : text;
  };
  const lastLineOf = (text: string) => norm(text).trimEnd().split('\n').at(-1)!;
  /** The key as the tool printed it: all of it, its first `k` lines (no END), or its last (no BEGIN). */
  const printed: [string, string[]][] = [
    ['cat', key],
    ...[2, 3, 11, 20].map((k): [string, string[]] => [`head -n ${k}`, key.slice(0, k)]),
    ...[2, 3, 11, 20].map((k): [string, string[]] => [`tail -n ${k}`, key.slice(-k)]),
  ];
  const run = (output: string) => {
    const kept = viaBuffer(tool({ a: 1 }, output));
    if (!kept.outputClipped) throw new Error('The case was not clipped.');
    return { kept, result: toolIoText(kept, registryOf()) };
  };

  it(
    'shows no piece of a key line for a head cut at every position of its first three lines',
    () => {
      let cases = 0;
      let masked = 0;
      let lastLineBoundary = 0;
      for (const [name, lines] of printed) {
        const text = `${lines.join('\n')}\n`;
        const span = lines.slice(0, 3).reduce((sum, line) => sum + line.length + 1, 0);
        for (let into = 0; into <= span; into++) {
          const before = linesOf(HEAD - into, 'before', true);
          const after = linesOf(TAIL + 200, 'after', true);
          const { kept, result } = run(`${before}${text}${after}`);
          const label = `${name}, head cut ${into} into the key`;
          expect(kept.head.length, label).toBe(before.length + into);
          expect(result, label).not.toBeNull();
          // The documented limit: a key whose BEGIN the tool dropped (`tail -n 2`,
          // `tail -n 3`), with its END not whole in the head, shows its shorter
          // last line, under 40 characters with no armor line in the head; never
          // a piece of a full line.
          const short = body.at(-1)!;
          const noBegin = !lines[0]!.startsWith('-----BEGIN');
          const shortEnd = text.indexOf(`${short}\n`) + short.length + 1;
          if (noBegin && lines.includes(short) && into >= shortEnd && into < text.length) {
            expect(showsAnyOf(piecesOf(result!), body.slice(0, -1)), label).toBe(false);
            expect(result!, label).toContain(`\n${short}\n…`);
            lastLineBoundary++;
          } else expect(showsAnyOf(piecesOf(result!), body), label).toBe(false);
          if (noBegin && into === text.length) {
            // The whole END with no BEGIN: the head is masked from its start through it.
            expect(result!, label).toContain(`the middle was not kept\n${PEM_MARKER}\n…\n`);
            expect(result!, label).not.toContain('\nbefore 0\n');
          } else {
            // Every ordinary line of the head shows.
            expect(result!, label).toContain('\nbefore 0\n');
            expect(result!, label).toContain(`\n${lastLineOf(before)}\n`);
          }
          // Every ordinary line of the tail shows.
          expect(withoutKeyNote(result!).endsWith(`\n${lastLineOf(after)}\n`), label).toBe(true);
          if (result!.includes(PEM_MARKER)) {
            expect(result!.endsWith(`\n\n${KEY_NOTE}`), label).toBe(true);
            masked++;
          }
          cases++;
        }
      }
      expect(cases).toBeGreaterThan(1000);
      expect(masked).toBeGreaterThan(400);
      // `tail -n 2` and `tail -n 3`: the head's cut right after the short line, or anywhere in END.
      expect(lastLineBoundary).toBe(2 * (key.at(-1)!.length + 1));
    },
    EXHAUSTIVE_TIMEOUT_MS
  );

  it(
    'shows no piece of a key line for a tail cut at every position of its last three lines',
    () => {
      let cases = 0;
      let lastLineBoundary = 0;
      for (const [name, lines] of printed) {
        const text = `${lines.join('\n')}\n`;
        const span = lines.slice(-3).reduce((sum, line) => sum + line.length + 1, 0);
        for (let back = 0; back <= span; back++) {
          const before = linesOf(HEAD + 600, 'before');
          // All of the tail is shown, so the lines next to its cut are seen.
          const after = linesOf(TAIL - back, 'after', true);
          const { kept, result } = run(`${before}${text}${after}`);
          const label = `${name}, tail cut ${back} before the key's end`;
          expect(kept.tail.length, label).toBe(TAIL);
          expect(kept.tail.startsWith(text.slice(text.length - back)), label).toBe(true);
          expect(result, label).not.toBeNull();
          expect(result!, label).toContain('\nbefore 0\n');
          expect(withoutKeyNote(result!).endsWith(`\n${lastLineOf(after)}\n`), label).toBe(true);
          if (back > 0) expect(result!, label).toContain('\nafter 0\n');
          if (result!.includes(PEM_MARKER))
            expect(result!.endsWith(`\n\n${KEY_NOTE}`), label).toBe(true);
          // The documented limit: a key whose END the tool dropped (`head -n 20`)
          // and whose BEGIN is in the dropped middle shows its shorter last line,
          // under 40 characters with no armor line in the tail, once it is whole
          // after the line the cut went through; never a piece of a full line.
          const short = body.at(-1)!;
          if (lines.at(-1) === short && back >= short.length + 2) {
            expect(showsAnyOf(piecesOf(result!), body.slice(0, -1)), label).toBe(false);
            expect(result!, label).toContain(`\n${short}\n`);
            lastLineBoundary++;
          } else expect(showsAnyOf(piecesOf(result!), body), label).toBe(false);
          cases++;
        }
      }
      expect(cases).toBeGreaterThan(1000);
      // `head -n 20`: every tail cut that keeps the short line whole after the dropped one.
      const last3 = key.slice(-4, -1).reduce((sum, line) => sum + line.length + 1, 0);
      expect(lastLineBoundary).toBe(last3 - body.at(-1)!.length - 1);
    },
    EXHAUSTIVE_TIMEOUT_MS
  );

  it(
    'shows no piece of a full key line, each line prefixed as a diff, a log, `cat -n` or `grep -n` prints it, for a head or a tail cut at every position of its first or last three lines',
    () => {
      let cases = 0;
      for (const prefix of ['-', 'app-1 | -', '    12\t', 'key.pem:12:']) {
        for (const [name, plain] of printed) {
          const lines = plain.map((line) => `${prefix}${line}`);
          const text = `${lines.join('\n')}\n`;
          const headSpan = lines.slice(0, 3).reduce((sum, line) => sum + line.length + 1, 0);
          for (let into = 0; into <= headSpan; into++) {
            const before = linesOf(HEAD - into, 'before', true);
            const { result } = run(`${before}${text}${linesOf(TAIL + 200, 'after', true)}`);
            const label = `${JSON.stringify(prefix)} ${name}, head cut ${into} into the key`;
            expect(result, label).not.toBeNull();
            expect(showsAnyOf(piecesOf(result!), body.slice(0, -1)), label).toBe(false);
            // A whole END with no BEGIN masks the head from its start; otherwise the head's lines show.
            if (!plain[0]!.startsWith('-----BEGIN') && into === text.length)
              expect(result!, label).toContain(`the middle was not kept\n${PEM_MARKER}\n…\n`);
            else expect(result!, label).toContain(`\n${lastLineOf(before)}\n`);
            cases++;
          }
          const tailSpan = lines.slice(-3).reduce((sum, line) => sum + line.length + 1, 0);
          for (let back = 0; back <= tailSpan; back++) {
            const after = linesOf(TAIL - back, 'after', true);
            const { result } = run(`${linesOf(HEAD + 600, 'before')}${text}${after}`);
            const label = `${JSON.stringify(prefix)} ${name}, tail cut ${back} before the key's end`;
            expect(result, label).not.toBeNull();
            expect(showsAnyOf(piecesOf(result!), body.slice(0, -1)), label).toBe(false);
            expect(withoutKeyNote(result!).endsWith(`\n${lastLineOf(after)}\n`), label).toBe(true);
            cases++;
          }
        }
      }
      expect(cases).toBeGreaterThan(4000);
    },
    EXHAUSTIVE_TIMEOUT_MS
  );

  /** Ordinary lines that must show next to a cut: no key line, and no armor of a key. */
  const ordinary = [
    ...Array.from({ length: 80 }, (_, n) => '-'.repeat(n + 1)),
    '-----BEGIN LOG-----------',
    'BEGIN LOG-----------',
    '-----END LOG-----',
    '-- ',
    '-----BEGIN CERTIFICATE-----',
    // A sha256 digest in hex, and base64 lines under 40 characters.
    base64Lines(1, 7, 64)[0]!
      .replace(/[^a-f0-9]/gi, '0')
      .toLowerCase(),
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
    base64Lines(1, 8, 39)[0]!,
    // A filler of one character repeated, which no key writes.
    'x'.repeat(64),
    // A digest in hex of both cases, paths with `.`, `-` or `_`, a lockfile
    // line, test results.
    'aB12cD34'.repeat(8),
    '/usr/share/doc/python3.12/examples/Tools/scripts/summarize',
    'console/packages/agent-providers/src/host/tool-detail-text.ts',
    'node_modules/switch_console/agent_providers/dist/index',
    '"resolved": "https://registry.npmjs.org/vitest/-/vitest-3.2.4.tgz",',
    'FAILED: actual diagnostic of the build',
    'PASSED',
  ];

  it(
    'documented cost: a lockfile `integrity` line is masked whole at every position of a head or a tail cut; the lines next to it show',
    () => {
      // Public base64 of a key line's alphabet and length cannot be told from one,
      // whatever is before it on the line.
      const line = `integrity: sha512-${base64Lines(1, 9, 86)[0]!}==`;
      let cases = 0;
      const headBlock = `${line}\nnext line\n`;
      for (let into = line.length + 1; into < headBlock.length; into++) {
        const { result } = run(
          `${linesOf(HEAD - into, 'before', true)}${headBlock}${linesOf(TAIL + 200, 'after', true)}`
        );
        const label = `head cut ${into} into it`;
        expect(result!, label).not.toContain(line.slice(20, 40));
        expect(result!, label).toContain(`\n${PEM_MARKER}\n…\n`);
        expect(result!.endsWith(`\n\n${KEY_NOTE}`), label).toBe(true);
        cases++;
      }
      const tailBlock = `prev line\n${line}\nnext line\n`;
      for (let back = line.length + 12; back <= tailBlock.length; back++) {
        const { result } = run(
          `${linesOf(HEAD + 600, 'before')}${tailBlock}${linesOf(TAIL - back, 'after', true)}`
        );
        const label = `tail cut ${back} before its end`;
        expect(result!, label).not.toContain(line.slice(20, 40));
        expect(result!, label).toContain(`\n${PEM_MARKER}\nnext line\nafter 0\n`);
        cases++;
      }
      expect(cases).toBeGreaterThan(10);
    },
    EXHAUSTIVE_TIMEOUT_MS
  );

  it(
    'shows ordinary lines at every position of a head cut, the line before them and in them',
    () => {
      let cases = 0;
      for (const line of ordinary) {
        const block = `${line}\nnext line\n`;
        for (let into = 0; into <= block.length; into++) {
          const before = linesOf(HEAD - into, 'before', true);
          const after = linesOf(TAIL + 200, 'after', true);
          const { result } = run(`${before}${block}${after}`);
          const label = `${JSON.stringify(line)}, head cut ${into} into it`;
          expect(result, label).not.toBeNull();
          expect(result!, label).not.toContain(PEM_MARKER);
          expect(result!, label).toContain('\nbefore 0\n');
          expect(result!, label).toContain(`\n${lastLineOf(before)}\n`);
          // The line itself, when it is the head's last whole line.
          if (into > line.length && into < block.length)
            expect(result!, label).toContain(`\n${line}\n…\n`);
          expect(result!.endsWith(`\n${lastLineOf(after)}\n`), label).toBe(true);
          cases++;
        }
      }
      expect(cases).toBeGreaterThan(4000);
    },
    EXHAUSTIVE_TIMEOUT_MS
  );

  it(
    'shows ordinary lines at every position of a tail cut, the line before them and in them',
    () => {
      let cases = 0;
      for (const line of ordinary) {
        const block = `prev line\n${line}\n`;
        for (let back = 1; back <= block.length; back++) {
          const before = linesOf(HEAD + 600, 'before');
          const after = linesOf(TAIL - back, 'after', true);
          const { kept, result } = run(`${before}${block}${after}`);
          const label = `${JSON.stringify(line)}, tail cut ${back} before its end`;
          expect(kept.tail.startsWith(block.slice(block.length - back)), label).toBe(true);
          expect(result, label).not.toBeNull();
          expect(result!, label).not.toContain(PEM_MARKER);
          expect(result!, label).toContain('\nbefore 0\n');
          expect(result!, label).toContain('\nafter 0\n');
          // The line itself, when it is the tail's first whole line.
          if (back > line.length + 1) expect(result!, label).toContain(`…\n${line}\n`);
          expect(result!.endsWith(`\n${lastLineOf(after)}\n`), label).toBe(true);
          cases++;
        }
      }
      expect(cases).toBeGreaterThan(4000);
    },
    EXHAUSTIVE_TIMEOUT_MS
  );

  describe('key lines with no lower-case letter (the reviewers’ own)', () => {
    // A key line need not mix cases: it is base64, at least 40 characters, not only hex digits.
    const keyLines = Array.from(
      { length: 20 },
      (_, index) => `KEYLINE${String(index).padStart(4, '0')}${'Q'.repeat(53)}`
    );

    it(
      'shows none of them at every position of a head cut, with no armor line in the head',
      () => {
        // `tail -n 21 key.pem`: its END is in the middle the buffer drops.
        const text = `${[...keyLines, `-----END ${kind}-----`].join('\n')}\n`;
        const span = keyLines.slice(0, 3).reduce((sum, line) => sum + line.length + 1, 0);
        let cases = 0;
        let masked = 0;
        for (let into = 0; into <= span; into++) {
          const before = linesOf(HEAD - into, 'before', true);
          const after = linesOf(TAIL + 200, 'after', true);
          const { result } = run(`${before}${text}${after}`);
          const label = `head cut ${into} into the key lines`;
          expect(result, label).not.toBeNull();
          expect(result!, label).not.toContain('KEYLINE');
          expect(showsAnyOf(piecesOf(result!), keyLines), label).toBe(false);
          expect(result!, label).toContain('\nbefore 0\n');
          expect(withoutKeyNote(result!).endsWith(`\n${lastLineOf(after)}\n`), label).toBe(true);
          if (into > keyLines[0]!.length) {
            expect(result!, label).toContain(`\n${PEM_MARKER}\n…\n`);
            masked++;
          }
          cases++;
        }
        expect(cases).toBe(span + 1);
        expect(masked).toBeGreaterThan(100);
      },
      EXHAUSTIVE_TIMEOUT_MS
    );

    it(
      'shows none of them at every position of a tail cut, with no armor line in the tail',
      () => {
        // `head -n 21 key.pem`: its BEGIN is in the middle the buffer drops.
        const text = `${[`-----BEGIN ${kind}-----`, ...keyLines].join('\n')}\n`;
        const span = keyLines.slice(-3).reduce((sum, line) => sum + line.length + 1, 0);
        let cases = 0;
        let masked = 0;
        for (let back = 0; back <= span; back++) {
          const before = linesOf(HEAD + 600, 'before');
          const after = linesOf(TAIL - back, 'after', true);
          const { kept, result } = run(`${before}${text}${after}`);
          const label = `tail cut ${back} before the key lines' end`;
          expect(kept.tail.startsWith(text.slice(text.length - back)), label).toBe(true);
          expect(result, label).not.toBeNull();
          expect(result!, label).not.toContain('KEYLINE');
          expect(showsAnyOf(piecesOf(result!), keyLines), label).toBe(false);
          expect(result!, label).toContain('\nbefore 0\n');
          expect(withoutKeyNote(result!).endsWith(`\n${lastLineOf(after)}\n`), label).toBe(true);
          if (back > keyLines[0]!.length + 1) {
            // Each whole key line is masked as a line of its own.
            expect(result!, label).toMatch(/…\n(?:\[REDACTED_PEM_BLOCK\]\n)+after 0\n/);
            masked++;
          }
          cases++;
        }
        expect(cases).toBe(span + 1);
        expect(masked).toBeGreaterThan(100);
      },
      EXHAUSTIVE_TIMEOUT_MS
    );
  });

  it('shows a C1 opener written `\\x9d` in a server name as text, as the normalization does', () => {
    const call = viaBuffer(
      mapCodexItem(
        {
          type: 'mcpToolCall',
          id: 'm',
          server: 'public\\x9d0;hidden',
          tool: 'ping',
          status: 'completed',
          error: null,
        },
        'completed'
      )
    );
    expect(toolIoText(call, registryOf())).toBe(
      `Server: public\\x9d0;hidden\n\n${NOT_REPORTED_INPUT}`
    );
  });
});

describe('a private key’s lines in a clipped output, each part read line by line', () => {
  const kind = ['PRIV', 'ATE KEY'].join('');
  const registry = registryOf();
  /** A clipped output through a real buffer, and the text for it. */
  const shownOf = (output: string, known: Registry = registry) => {
    const kept = viaBuffer(tool({ a: 1 }, output));
    if (!kept.outputClipped) throw new Error('The case was not clipped.');
    const result = toolIoText(kept, known);
    if (result === null) throw new Error('No text.');
    return result;
  };
  /** Whether 12 code units in a row of any of `lines` are in `result`. */
  const shows = (result: string, ...lines: string[]) => showsAnyOf(piecesOf(result), lines);

  // Executed inputs of a review, as it built them: 9,000 code units, the
  // buffer keeping `[0, 6144)` and `[6952, 9000)`; `P` starts the tail right
  // after the line its cut goes through, or starts the head.
  const tailOf = (P: string) =>
    `SAFE HEAD\n${'!'.repeat(6942)}${'!'.repeat(2047 - P.length)}\n${P}`;
  const headOf = (P: string) => `${P}\n${'!'.repeat(8989 - P.length)}\nSAFE TAIL`;
  // Key material it used: an Ed25519 seed, lines of RSA, PKCS#8, encrypted
  // PEM, OpenSSH and PGP keys; split so that no scanner reads them as keys.
  const seed = ['pxRWodAVcvFcWwip', 'TdjQemCPpktFOdoU', 'MXgRcz/oW/o='].join('');
  const pkcs8NoDigit = ['IGokzBrHzZWYWtf+lMuk', 'LpeDhyKnubGAWKMNFNXLOoGu'].join('');
  const edWrapped = [
    'MC4CAQAwBQYDK2VwBCIE',
    'IKcUVqHQFXLx\nXFsIqU3Y0Hpgj6ZL',
    'RTnaFDF4EXM/6Fv6',
  ].join('');
  const rsa1 = ['vF7uP0d5/qCQdyDNu4Da4QxhUgAyTA/e', '0kD74qrohTOrID6VHIBxbv5t371OQshf'].join('');
  const rsa8 = ['D97SQPviquiFM6sgPpUcgHFu/m3fvU5C', 'yF8zVD53gGkNwBGTV9fKb7S3Jb04sJUs'].join('');
  const enc1 = ['AMj1clyk7SSNkoEGA5c4xWmmJbi23tDY', 'DVCAfNM7C0FaS5P92fG6JS6NL0wa1MVH'].join('');
  const enc8 = ['omdvToDXrRBsuLAEnzka7j9JpPyGA38Z', '9Izc0erd+1eTzOxdQOv+mFPnWqI9FBXx'].join('');
  const openssh = [
    'AAAECnFFah0BVy8VxbCKlN2NB6YI+mS0U5',
    '2hQxeBFzP+hb+gKojXUcdSSU53GdRTOYBkcy',
  ].join('');
  const pgp = ['dnluNEenGzukHpBPmHbQeEMskyJr3cqh', 'q57OJiDFfLYahhx7oOMAi0LIrmrKutto'].join('');

  it('masks the review’s key lines alone in a tail or a head, a seed and a line with no digit too, and shows the rest', () => {
    for (const P of [seed, pkcs8NoDigit, rsa1, rsa8, enc1, enc8, openssh, pgp]) {
      const tail = shownOf(tailOf(P));
      expect(shows(tail, P), P).toBe(false);
      expect(tail, P).toContain('\nSAFE HEAD\n…\n[REDACTED_PEM_BLOCK]');
      expect(tail.endsWith(`\n\n${KEY_NOTE}`), P).toBe(true);
      const head = shownOf(headOf(P));
      expect(shows(head, P), P).toBe(false);
      expect(withoutKeyNote(head).endsWith('\n…\nSAFE TAIL'), P).toBe(true);
    }
  });

  it('masks a key line under composed and other prefixes: a log of a diff, a diff, `cat -n`, `grep -n`, a field', () => {
    const materials = [rsa1, rsa8, enc1, enc8, openssh, pgp];
    const prefixes = [
      'app-1 | -',
      'app-1 | ',
      'app-1  | +',
      '-',
      '+',
      ' ',
      '     7\t',
      'file.pem:7:',
      '12:',
      'value: ',
      '  tls.key: ',
      '"data": "',
      'app-1 | +     7\t',
      '\\x2d',
    ];
    for (const P of materials)
      for (const prefix of prefixes) {
        const close = prefix.endsWith('"') ? '",' : '';
        const result = shownOf(tailOf(`${prefix}${P}${close}`));
        expect(shows(result, P), `${prefix}${P}`).toBe(false);
        expect(result, prefix).toContain('\nSAFE HEAD\n');
      }
  });

  it('masks a key line written with escapes or split by unseen characters, and a line partly masked by a known value', () => {
    const spelled = rsa1
      .split('')
      .map((char) => `\\x${char.charCodeAt(0).toString(16)}`)
      .join('');
    for (const P of [rsa1.split('').join(ZW), spelled, `${rsa1.slice(0, 12)}­${rsa1.slice(12)}`]) {
      const result = shownOf(tailOf(P));
      expect(shows(result, rsa1), P.slice(0, 20)).toBe(false);
      expect(result).toContain(KEY_NOTE);
    }
    // A registered value inside the line: the line is found before masking, and masked once.
    const known = registryOf(hostKnownValues({ env: { APP_SECRET: 'Da4QxhUg' }, mcpServers: {} }));
    const result = shownOf(tailOf(rsa1), known);
    expect(result).not.toContain('vF7uP0d5');
    expect(result).not.toContain('AyTA/e0kD74q');
    // The line and the value inside it are one range, masked with our marker.
    expect(result).toContain(`\n…\n${MARKER}\n\n${KEY_NOTE}`);
  });

  it('masks a key line away from the cut, after empty lines, and under armor headers', () => {
    const cases = [
      `progress message\n${rsa1}\nfinished normally`,
      `${'\n'.repeat(65)}${rsa1}`,
      `Version: audit\n\n${pgp}`,
      `Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,${'0'.repeat(32)}\n\n${enc1}`,
      `value: ${edWrapped.replace('\n', '')}`,
    ];
    for (const P of cases) {
      const result = shownOf(tailOf(P));
      expect(shows(result, rsa1, pgp, enc1, edWrapped.replace('\n', '')), P.slice(0, 30)).toBe(
        false
      );
      expect(result, P).toContain('\nSAFE HEAD\n');
    }
    // The ordinary lines around a key line stay.
    expect(shownOf(tailOf(cases[0]!))).toContain(
      '\n…\nprogress message\n[REDACTED_PEM_BLOCK]\nfinished normally\n\n'
    );
    expect(shownOf(tailOf(cases[2]!))).toContain('\n…\nVersion: audit\n\n[REDACTED_PEM_BLOCK]');
  });

  it('documented limit: a short base64 line alone, 32-character wraps, base64url and hex are not read as a key', () => {
    // A key's lone shorter last line, a PGP checksum ending, a key wrapped
    // under 40 characters with no 40-character line next to it, and a seed in
    // base64url or hex: a line of text cannot be told from public data of the
    // same shape, so these show.
    const lone = ['fvCLFxZBZf92', 'OWJGvPgXeKw='].join('');
    const pgpEnd = ['qVbp/ptl', 'zM4cQU4='].join('');
    const base64url = ['pxRWodAVcvFcWwip', 'TdjQemCPpktFOdoU', 'MXgRcz_oW_o'].join('');
    const hex = ['a71456a1d01572f15c5b08a94dd8d07a', '608fa64b4539da14317811733fe85bfa'].join('');
    for (const P of [lone, pgpEnd, edWrapped, base64url, hex]) {
      const result = shownOf(tailOf(P));
      expect(result, P).toContain(P);
      expect(result, P).not.toContain(KEY_NOTE);
    }
  });

  describe('a key whose BEGIN the cut splits, each layout of its lines in the tail', () => {
    const L = ['MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYH', 'CAkKCwwNDg8QERITFBUWFxgZGhscHR4f'].join('');
    const M = ['CxwtPk9gcYKTpLXG1+j5ChssPU5fcIGS', 'o7TF1uf4CRorPE1eb4CRorPE1eb3CBkq'].join('');
    const S = ['AwoRGB8mLTQ7QklQ', 'V15lbHN6gYiPlp2k'].join('');
    const Q = (n: number) => `${ESC}[0m`.repeat(Math.floor(n / 4)) + '.'.repeat(n % 4);
    const output = (x: string) =>
      `ok\n${Q(6140)}\n${'discarded log\n'.repeat(300)}-----BEGIN ${kind}----${x}${Q(2048 - x.length - 6)}\ndone\n`;
    const split = (line: string) => `${line.slice(0, 12)}­${line.slice(12)}`;
    const closed: [string, string][] = [
      ['one line of a whole key', `-\n${L}\n`],
      ['a diff', `-\n-${L}\n-${M}\n`],
      ['cat -n', `-\n     2\t${L}\n     3\t${M}\n`],
      ['a log', `-\napp-1 | ${L}\napp-1 | ${M}\n`],
      ['PGP armor headers', `-\nVersion: Example\n\n${L}\n${M}\n`],
      [
        'encrypted PEM headers',
        `-\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0123456789ABCDEF\n\n${L}\n${M}\n`,
      ],
      ['a key away from the cut', `cut\nstatus: reading file\n${L}\n${M}\n`],
      ['split by soft hyphens', `-\n${split(L)}\n${split(M)}\n`],
    ];

    it.each(closed)('%s: no key line shows, the lines around it do', (_, x) => {
      const result = shownOf(output(x));
      expect(shows(result, L, M)).toBe(false);
      expect(result).toContain('\nok\n');
      expect(withoutKeyNote(result).endsWith('\ndone\n')).toBe(true);
      expect(result).toContain(KEY_NOTE);
    });

    it('a documented limit: a 32-character fragment alone after the cut shows', () => {
      const result = shownOf(output(`cut\n${S}\n`));
      expect(result).toContain(`\n${S}\n`);
      expect(result).not.toContain(KEY_NOTE);
    });
  });

  describe('a key cut at the head’s end or the tail’s start', () => {
    const L = ('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/' + 'AbCdEfGhIjKlMnOpQrStUvWxYz01').slice(
      0,
      64
    );

    it('a key in a diff, its BEGIN cut at the head’s end, no END', () => {
      const output = `safe\n${'x'.repeat(6136)}\n------BEGIN ${kind}-----\n${Array(40).fill(`-${L}`).join('\n')}`;
      const result = shownOf(output);
      expect(shows(result, L)).toBe(false);
      expect(result).toContain('the middle was not kept\nsafe\n');
    });

    it('a PGP key, its BEGIN cut at the head’s end, `Version:` and an empty line before its body', () => {
      const output = `safe\n${'x'.repeat(6137)}\n-----BEGIN PGP ${kind} BLOCK-----\nVersion: GnuPG v2\n\n${`${L}\n`.repeat(20)}${'done\n'.repeat(146)}end\n`;
      const result = shownOf(output);
      expect(shows(result, L)).toBe(false);
      expect(withoutKeyNote(result).endsWith('\ndone\nend\n')).toBe(true);
    });

    it('a hex digest and a filler after a key line show; the key line does not', () => {
      const C = '0123456789abcdef'.repeat(4);
      const X = 'x'.repeat(64);
      const tail = (first: string) => `cut\n${first}\n${C}\n${X}\n${'\r\n'.repeat(924)}\n`;
      const result = shownOf(`${'x'.repeat(7500)}${tail(L)}`);
      expect(shows(result, L)).toBe(false);
      expect(result).toContain(`[REDACTED_PEM_BLOCK]\n${C}\n${X}\n`);
      const control = shownOf(`${'x'.repeat(7500)}${tail('z'.repeat(64))}`);
      expect(control).toContain(`\n${C}\n${X}\n`);
      expect(control).not.toContain(KEY_NOTE);
    });

    it('a key the tool cut, each line prefixed as a diff, `cat -n` or a log prints it, the tail cut in its body', () => {
      for (const prefix of ['-', '    12\t', 'app-1  | ']) {
        const key = [`-----BEGIN RSA ${kind}-----`, ...Array(60).fill(L)].map(
          (line) => `${prefix}${line}`
        );
        const output = `${'ok\n'.repeat(2200)}${key.join('\n')}\n`;
        const result = shownOf(output);
        expect(shows(result, L), prefix).toBe(false);
        expect(result, prefix).toContain('the middle was not kept\nok\nok\n');
      }
    });

    it('a key whose END is in the dropped middle leaves a tail of ordinary lines shown', () => {
      const key = Array(40).fill(L).join('\n');
      const output = `${'ok\n'.repeat(2000)}-----BEGIN RSA ${kind}-----\n${key}\n-----END RSA ${kind}-----\n${'test result line\n'.repeat(400)}`;
      const result = shownOf(output);
      expect(shows(result, L)).toBe(false);
      expect(withoutKeyNote(result)).toMatch(/…\n(?:test result line\n)+$/);
    });

    it(
      'an encrypted key the tool cut, the tail starting at every position of its armor, headers and first lines',
      () => {
        const key = [
          `-----BEGIN RSA ${kind}-----`,
          'Proc-Type: 4,ENCRYPTED',
          'DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF',
          '',
          ...Array(25).fill(L),
        ];
        const text = `${key.join('\n')}\n`;
        const span = key.slice(0, 6).reduce((sum, line) => sum + line.length + 1, 0);
        let cases = 0;
        for (let into = 0; into <= span; into++) {
          const tailLength = text.length - into;
          const output = `${'x'.repeat(7000)}\n${text}${'d'.repeat(2048 - tailLength - 1)}\n`;
          const kept = viaBuffer(tool({ a: 1 }, output));
          expect(kept.tail.startsWith(text.slice(into)), String(into)).toBe(true);
          const result = toolIoText(kept, registry)!;
          expect(shows(result, L), String(into)).toBe(false);
          cases++;
        }
        expect(cases).toBe(span + 1);
      },
      EXHAUSTIVE_TIMEOUT_MS
    );
  });

  it('shows ordinary lines next to a masked base64 line: `FAILED`, a test result, a build line', () => {
    const digest = ['pro56MFdgOWFjJbqydzI', 'QDpwweF92oRg50Vg1WXlqyE='].join('');
    const result = shownOf(tailOf(`START BUILD\n${digest}\nFAILED: actual diagnostic`));
    expect(result).toContain(
      '\n…\nSTART BUILD\n[REDACTED_PEM_BLOCK]\nFAILED: actual diagnostic\n\n'
    );
    expect(result.endsWith(`\n\n${KEY_NOTE}`)).toBe(true);
    const words = shownOf(
      tailOf('PASSED\n/home/kamil/work/switch/console/packages/agent/src/host\nok\ndone')
    );
    expect(words).toContain('\n…\nPASSED\n[REDACTED_PEM_BLOCK]\nok\ndone\n\n');
  });

  it('documented cost: public base64, a dotless path or a long identifier of 40 characters or more is masked as a key line', () => {
    // A line of text cannot be told from a key line of the same alphabet and
    // length; the line alone is masked, under the note, and the rest stays.
    const publicData = [
      ['pro56MFdgOWFjJbqydzI', 'QDpwweF92oRg50Vg1WXlqyE='].join(''),
      `+${['VGhpcyBpcyBwdWJsaWMgZml4', 'dHVyZSBkYXRhIGZvciB0aGUgYnVpbGQgMTIzNDUu'].join('')}`,
      'BuildArtifactReleaseCandidate2026LinuxX64Result',
      '/Build42/Release2026/Artifacts/ModuleABC123',
      `  tls.crt: ${'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'.repeat(2)}`,
      '/usr/share/doc/python3/examples/Tools/scripts/sub1',
    ];
    for (const line of publicData) {
      const result = shownOf(tailOf(`before\n${line}\nafter`));
      expect(result, line).toContain('\n…\nbefore\n[REDACTED_PEM_BLOCK]\nafter\n\n');
      expect(result, line).toContain(KEY_NOTE);
    }
  });

  it('documented limit: a whole output of key lines with no armor line is not read as a key (`sed 1d;$d key.pem`)', () => {
    const L = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGhIjKlMnOpQrStUvWxYz';
    const output = `${Array(10).fill(L).join('\n')}\nAbCd==`;
    const result = toolIoText(viaBuffer(tool({ a: 1 }, output)), registry)!;
    expect(result).toContain(L);
    expect(result).not.toContain(KEY_NOTE);
  });

  it('documented limit: a key dumped as text (`openssl pkey -text`) is not read as a key', () => {
    const dump = `privateExponent:\n    00:c3:1a:9f:22:4b:88:10:77:aa:bb:cc:dd:ee:ff:01:23:45\n    67:89:ab:cd:ef:10:32:54:76:98:ba:dc:fe:21:43:65:87:a9\n`;
    const result = shownOf(tailOf(dump));
    expect(result).toContain('00:c3:1a:9f');
    expect(result).not.toContain(KEY_NOTE);
  });
});

describe('a clipped head that ends on the start of a sequence', () => {
  const HIDDEN = 'Output — a terminal control sequence with no end hid the rest; it is not shown';
  const CUT_ESCAPE =
    'Output — the head ends on an escape the cut left unreadable; the tail is not shown';

  it('hides the tail when the head colours its text and ends on the ESC of a colour code, and says the escape could not be read', () => {
    // Earlier colour codes do not prove what the escape at the cut began, so
    // the tail of `ls --color` is hidden: a cost of reading the cut safely.
    const real = `${'x'.repeat(14)}\n${`${ESC}[01;34mdir${ESC}[0m\n`.repeat(1000)}`;
    // The same with ESC written as escaped text; the head ends on `\u001b`.
    const spelled = `${'x'.repeat(19)}\n${'\\u001b[31mred\\u001b[0m\n'.repeat(700)}`;
    for (const [output, word] of [
      [real, 'dir'],
      [spelled, 'red'],
    ] as const) {
      const kept = viaBuffer(tool({ a: 1 }, output));
      expect(kept.outputClipped).toBe(true);
      expect(kept.head.endsWith(word === 'dir' ? ESC : '\\u001b'), word).toBe(true);
      const result = toolIoText(kept, registryOf())!;
      expect(result.endsWith(`\n${word}\n…\n\n${CUT_ESCAPE}`), word).toBe(true);
      expect(result, word).not.toContain(HIDDEN);
    }
  });

  it('hides the tail an OSC opener the middle completes would hide, after colour codes too', () => {
    // Colour in the head, ESC at its last index, `]0;` first in the dropped middle.
    const material = ['hidden', 'material'].join(' ');
    const lead = `${ESC}[31mred${ESC}[0m\n`;
    const output = `${lead}${'.'.repeat(6143 - lead.length)}${ESC}]0;${'title\n'.repeat(400)}${material}\n`;
    const kept = viaBuffer(tool({ a: 1 }, output));
    expect(kept.outputClipped).toBe(true);
    expect(kept.head.endsWith(ESC)).toBe(true);
    expect(kept.tail).toContain(material);
    const result = toolIoText(kept, registryOf())!;
    expect(result).not.toContain(material);
    expect(result.endsWith(`\n\n${CUT_ESCAPE}`)).toBe(true);
  });

  it('hides the tail when the head that ends so has no colour, or opens and ends an OSC string', () => {
    const plain = `${'ok\n'.repeat(2047)}ab${ESC}]0;${'hidden\n'.repeat(400)}`;
    const withOsc = `${ESC}]0;title\x07${'x'.repeat(4)}\n${`${ESC}[01;34mdir${ESC}[0m\n`.repeat(1000)}`;
    for (const output of [plain, withOsc]) {
      const kept = viaBuffer(tool({ a: 1 }, output));
      expect(kept.head.endsWith(ESC)).toBe(true);
      const result = toolIoText(kept, registryOf())!;
      expect(result.endsWith(`\n\n${CUT_ESCAPE}`)).toBe(true);
      expect(result).not.toContain('hidden');
    }
    // A head that opens an OSC string and does not end it: that sequence hid the rest.
    const open = toolIoText(
      viaBuffer(tool({ a: 1 }, `ok\n${ESC}]0;${'x'.repeat(9000)}`)),
      registryOf()
    )!;
    expect(open.endsWith(`\nok\n…\n\n${HIDDEN}`)).toBe(true);
    expect(open).not.toContain(CUT_ESCAPE);
  });
});

describe('key material, cut escapes and ordinary lines, through a real buffer whole and in deltas', () => {
  const kind = ['PRIV', 'ATE KEY'].join('');
  const begin = `-----BEGIN ${kind}-----`;
  const end = `-----END ${kind}-----`;
  // A valid Ed25519 private key (PKCS#8 DER, a fixed seed) and its public key,
  // built at run time.
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(Array.from({ length: 32 }, (_, at) => at + 1)),
  ]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const D = der.toString('base64');
  const PUB = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  /** A clipped output of 9,000 code units whose kept tail ends in `tail`. */
  const W = (tail: string) =>
    'safe-head\n'.padEnd(6144, '.') +
    'middle\n'.repeat(400) +
    '.'.repeat(2048 - tail.length) +
    tail;
  /** The text for `output`, given whole and in deltas of 137 code units; both must agree. */
  const shownOf = (output: string, known: Registry = registryOf()) => {
    const whole = viaBuffer(tool({ a: 1 }, output));
    const deltas: string[] = [];
    for (let at = 0; at < output.length; at += 137) deltas.push(output.slice(at, at + 137));
    const streamed = viaBuffer(tool({ a: 1 }), deltas);
    const result = toolIoText(whole, known);
    if (result === null) throw new Error('No text.');
    expect(toolIoText(streamed, known)).toBe(result);
    return { clipped: whole.outputClipped, result };
  };
  const hidesKey = (result: string) => !showsAnyOf(piecesOf(result), [D]);

  it('the key material is valid Ed25519', () => {
    expect(key.asymmetricKeyType).toBe('ed25519');
    expect(D).toHaveLength(64);
  });

  it('hides the key after a public PEM block in a JSON line of the tail', () => {
    const { clipped, result } = shownOf(
      W(`\n${JSON.stringify({ cert: PUB, data: `${begin}\n${D}` })}\ndone\n`)
    );
    expect(clipped).toBe(true);
    expect(hidesKey(result)).toBe(true);
    expect(result).toContain('\nsafe-head\n');
  });

  it('shows `AssertionError` after a masked public digest', () => {
    const digest = createHash('sha256').update('public text').digest('base64');
    const { result } = shownOf(W(`\n${digest}\nAssertionError\n`));
    expect(result).not.toContain(digest);
    expect(result).toContain(`\n${PEM_MARKER}\nAssertionError\n`);
    expect(result.endsWith(`\n\n${KEY_NOTE}`)).toBe(true);
  });

  it('hides the key of a private block with a public block inside, in an output, an input string and a server name', () => {
    const nested = `${begin}\n${PUB}${D}\n${end}`;
    // A whole output.
    const output = toolIoText(
      detail({ input: { a: 1 }, output: `ok\n${nested}\ndone` }),
      registryOf()
    )!;
    expect(hidesKey(output)).toBe(true);
    expect(output).toContain('\nok\n');
    expect(output.endsWith('\ndone')).toBe(true);
    // A clipped output's tail.
    const { result } = shownOf(W(`\n${nested}\ndone\n`));
    expect(hidesKey(result)).toBe(true);
    expect(result).toContain('\ndone\n');
    // An input string, as `inputText` and as the detail.
    expect(hidesKey(inputText({ content: nested }))).toBe(true);
    const input = toolIoText(detail({ input: { content: nested }, output: 'ok' }), registryOf())!;
    expect(hidesKey(input)).toBe(true);
    expect(input.endsWith('\n\nOutput\nok')).toBe(true);
    // A server name.
    const server = toolIoText(
      detail({ type: 'mcp_tool_call', input: { server: nested } }),
      registryOf()
    )!;
    expect(hidesKey(server)).toBe(true);
    expect(server).toMatch(/^Server: /);
  });

  it('hides a key line as `grep -H` and `cat -A` print it, and shows the line after it', () => {
    for (const line of [`(standard input):${D}`, `${D}$`]) {
      const { result } = shownOf(W(`\n${line}\ndone\n`));
      expect(hidesKey(result), line).toBe(true);
      expect(result, line).toContain(`\n${PEM_MARKER}\ndone\n`);
    }
  });

  it('hides every line of a key wrapped in 32 characters after its BEGIN in the tail', () => {
    const { result } = shownOf(W(`\n${begin}\n${D.slice(0, 32)}\n${D.slice(32)}\ndone\n`));
    expect(result).not.toContain(D.slice(0, 32));
    expect(result).not.toContain(D.slice(32));
    expect(result).toContain('\nsafe-head\n');
  });

  it('documented limit: a terminator in the tail drops the tail’s start, plain text too, and the note says a terminator was found', () => {
    const output = `${'ok\n'.repeat(2800)}${'FAILED test_x\n'.repeat(40)}\x07\nafter\n`;
    const { clipped, result } = shownOf(output);
    expect(clipped).toBe(true);
    expect(result).not.toContain('FAILED test_x');
    expect(result.endsWith(`\nafter\n\n\n${OUTPUT_START_HIDDEN}`)).toBe(true);
  });

  it('shows ordinary messages that name a key or carry dashes, in the head and in the tail', () => {
    const lines = [
      `error: no ${kind} in the config`,
      'Rotate key --force',
      'UPDATE KEY --- done',
      `-- ${kind} rotated --`,
    ];
    const text = lines.join('\n');
    const head = shownOf(`${text}\n${'.'.repeat(9000)}\nend\n`).result;
    const tail = shownOf(W(`\n${text}\nend\n`)).result;
    for (const shown of [head, tail]) {
      expect(shown).toContain(`\n${text}\n`);
      expect(shown).not.toContain(PEM_MARKER);
    }
  });

  it('shows `Build42` after a masked public digest', () => {
    const digest = createHash('sha256').update('public build').digest('base64');
    const { result } = shownOf(W(`\n${digest}\nBuild42\n`));
    expect(result).toContain(`\n${PEM_MARKER}\nBuild42\n`);
  });

  it('documented limit: a DCS string is not normalized, so a known value it splits shows in pieces', () => {
    const known = ['sec', 'ret'].join('');
    const output = `value is sec${ESC}Pjunk${ESC}\\ret done`;
    const result = toolIoText(detail({ input: { a: 1 }, output }), registryOf([known]))!;
    expect(result).toContain('sec');
    expect(result).toContain('junk');
    expect(result).toContain('ret done');
  });

  it('keeps the known values, a URL password and ordinary diagnostics as before', () => {
    const known = ['qa', 'Secret', '42'].join('');
    const password = ['opaque', 'PASS', '803'].join('');
    const { result } = shownOf(
      W(
        `\nvalue ${known}\nvalue \\u0071${known.slice(1)}\npostgres://u:${password}@db.example/test\nFAILED: actual diagnostic\n`
      ),
      registryOf([known])
    );
    expect(result).not.toContain(known);
    expect(result).not.toContain(known.slice(1));
    expect(result).not.toContain(password);
    expect(result).toContain('\nFAILED: actual diagnostic\n');
  });
});
