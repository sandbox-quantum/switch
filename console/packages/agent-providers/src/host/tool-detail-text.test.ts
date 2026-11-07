import { describe, expect, it } from 'vitest';
import { Redactions } from './redaction';
import type { HostToolDetail } from './tool-detail-buffer';
import { TOOL_DETAIL_LIMIT, TOOL_INPUT_PREVIEW, toolDetailText } from './tool-detail-text';

// Built from pieces so no whole key shape is ever written in the source.
const key = () => 'AK' + 'IA' + 'Q7'.repeat(8);

function detail(overrides: Partial<HostToolDetail>): HostToolDetail {
  return {
    itemId: 'call',
    type: 'command_execution',
    toolName: 'Bash',
    input: { command: 'ls -la' },
    output: 'total 0',
    outputCut: null,
    truncated: false,
    exitCode: 0,
    ...overrides,
  };
}

/** An output as the buffer leaves it when it drops the middle. */
const cut = (head: string, tail: string): Partial<HostToolDetail> => ({
  output: `${head}\n…\n${tail}`,
  outputCut: head.length,
  truncated: true,
});

const lines = (count: number, width: number) =>
  Array.from(
    { length: count },
    (_, at) => `${String(at).padStart(4, '0')} ${'w'.repeat(width)}`
  ).join('\n');

describe('what a room is shown of a tool call', () => {
  it('shows the input, the output and how it exited', () => {
    expect(toolDetailText(detail({}), null)).toBe(
      'Input:\n{\n  "command": "ls -la"\n}\n\nOutput:\ntotal 0\n\nExit code: 0'
    );
  });

  it('leaves out the parts the call does not have', () => {
    expect(toolDetailText(detail({ input: null, output: null, exitCode: null }), null)).toBe('');
  });

  it('removes a token this host issued and anything shaped like a secret', () => {
    const redactions = new Redactions();
    redactions.add('xxxxxxxxxxxxxxxx');
    const text = toolDetailText(
      detail({
        input: { command: 'curl -H "Authorization: Bearer xxxxxxxxxxxxxxxx" api' },
        output: `AWS_ACCESS_KEY_ID=${key()}\nexport DB_PASSWORD=hunter22`,
      }),
      redactions
    );
    expect(text).not.toContain('xxxxxxxxxxxxxxxx');
    expect(text).not.toContain(key());
    expect(text).not.toContain('hunter22');
    expect(text).toContain('DB_PASSWORD=[REDACTED]');
  });

  it('keeps the whole detail within its limit, and the input within its own', () => {
    const text = toolDetailText(
      detail({ input: { command: lines(40, 30) }, output: lines(400, 40) }),
      null
    );
    expect(text.length).toBeLessThanOrEqual(TOOL_DETAIL_LIMIT);
    const input = text.slice(0, text.indexOf('\n\nOutput:'));
    expect(input.length).toBeLessThanOrEqual('Input:\n'.length + TOOL_INPUT_PREVIEW + 60);
    expect(text).toMatch(/more characters not shown\.\n\nExit code: 0$/);
  });

  it('cuts a long output at the end of a line and says how much is left out', () => {
    const output = lines(400, 40);
    const text = toolDetailText(detail({ input: null, output, exitCode: null }), null);
    const shown = text.replace('Output:\n', '');
    const [kept, note] = shown.split('\n… ');
    expect(output.startsWith(kept!)).toBe(true);
    expect(output[kept!.length]).toBe('\n');
    expect(note).toBe(`${output.length - kept!.length} more characters not shown.`);
  });

  it('shows only a note for a long output that is one line', () => {
    const output = 'x'.repeat(TOOL_DETAIL_LIMIT * 2);
    const text = toolDetailText(detail({ input: null, output, exitCode: null }), null);
    expect(text).toBe(`Output:\n\n… ${output.length} more characters not shown.`);
  });

  it('drops the partial line at each of the buffer cuts, and keeps the whole lines around them', () => {
    const secret = key();
    const output = cut(
      `first line\nhead ${secret.slice(0, 9)}`,
      `${secret.slice(9)} tail\nlast line`
    );
    const text = toolDetailText(detail({ input: null, ...output, exitCode: null }), null);
    expect(text).toBe('Output:\nfirst line\n… part of this was not kept …\nlast line');
  });

  it('shows a note where the buffer cut a string in the input', () => {
    const secret = key();
    const input = { command: `echo ${secret.slice(0, 12)}…`, cwd: '/repo' };
    const text = toolDetailText(
      detail({ input, output: null, truncated: true, exitCode: null }),
      null
    );
    expect(text).not.toContain(secret.slice(0, 6));
    expect(text).toContain('"cwd": "/repo"');
    expect(text).toContain('… part of this was not kept …');
  });

  it('masks a private key the buffer cut before its end', () => {
    const pem = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'xxxxxxxxxxxxxxxxxxxxxxxx', 'more key'];
    const output = cut(pem.join('\n'), 'end of the tail\nafter');
    const text = toolDetailText(detail({ input: null, ...output, exitCode: null }), null);
    expect(text).not.toContain('xxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('cuts where the buffer cut, not where the output prints a cut of its own', () => {
    const secret = key();
    const output = cut(
      `log start\n…\nlog middle\nhead ${secret.slice(0, 9)}`,
      `${secret.slice(9)} tail\nlast line`
    );
    const text = toolDetailText(detail({ input: null, ...output, exitCode: null }), null);
    expect(text).not.toContain(secret.slice(0, 6));
    expect(text).not.toContain(secret.slice(9));
    expect(text).toBe(
      'Output:\nlog start\n…\nlog middle\n… part of this was not kept …\nlast line'
    );
  });

  it('keeps an output the buffer did not cut whole, even one that prints a cut', () => {
    const output = 'first\n…\nsecond\nthird';
    const text = toolDetailText(detail({ input: null, output, exitCode: null }), null);
    expect(text).toBe(`Output:\n${output}`);
  });

  it('keeps an input the buffer did not clip whole, even one with an ellipsis in it', () => {
    const input = { command: 'echo "wait…"', note: 'and so on…' };
    const text = toolDetailText(detail({ input, output: null, exitCode: null }), null);
    expect(text).toContain('"command": "echo \\"wait…\\""');
    expect(text).toContain('"note": "and so on…"');
    expect(text).not.toContain('not kept');
  });

  it('shows nothing of an output that is not cut where the buffer says', () => {
    expect(() =>
      toolDetailText(
        detail({ input: null, output: 'no cut here', outputCut: 3, truncated: true }),
        null
      )
    ).toThrow('not cut where its buffer says');
  });
});
