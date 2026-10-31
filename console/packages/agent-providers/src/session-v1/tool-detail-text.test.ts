import { describe, expect, it } from 'vitest';
import { Redactions } from '../host/redaction';
import { TOOL_OUTPUT_GAP, type HostToolDetail } from '../host/tool-detail-buffer';
import { toolDetailText, TOOL_TEXT_CUT } from './tool-detail-text';

const detail = (patch: Partial<HostToolDetail>): HostToolDetail => ({
  itemId: 'item',
  type: 'command_execution',
  toolName: null,
  input: null,
  output: null,
  truncated: false,
  exitCode: null,
  ...patch,
});
const key = `sk-${'q'.repeat(24)}`;

describe('toolDetailText', () => {
  const redactions = new Redactions();

  it('shows a command as a shell line and its output', () => {
    expect(
      toolDetailText(
        detail({ input: { command: 'npm test' }, output: '42 passed' }),
        redactions,
        false
      )
    ).toBe('Input: $ npm test\nOutput:\n42 passed');
  });

  it('shows other arguments as compact JSON and says when the call failed', () => {
    expect(
      toolDetailText(
        detail({
          input: { path: 'a.txt' },
          output: 'no such file',
          exitCode: 2,
        }),
        redactions,
        false
      )
    ).toBe('Input: {"path":"a.txt"}\nOutput (exit 2):\nno such file');
  });

  it('is empty for a call with neither input nor output', () => {
    expect(toolDetailText(detail({}), redactions, false)).toBe('');
  });

  it('masks secrets in input and output', () => {
    const text = toolDetailText(
      detail({
        input: { command: `curl -H "Authorization: Bearer ${key}"` },
        output: `key=${key}`,
      }),
      redactions,
      false
    );
    expect(text).not.toContain(key);
    expect(text).toContain('[REDACTED]');
  });

  it('holds back the last word of output that is still streaming', () => {
    const partial = key.slice(0, 10);
    expect(toolDetailText(detail({ output: `got ${partial}` }), redactions, true)).toBe(
      'Output:\ngot'
    );
    expect(toolDetailText(detail({ output: `got ${partial}` }), redactions, false)).toContain(
      partial
    );
  });

  it('keeps a head and a tail of long output with a note, dropping words the cut split', () => {
    const output = `${'a'.repeat(1990)} ${'b'.repeat(40)}${TOOL_OUTPUT_GAP}${'c'.repeat(40)} ${'d '.repeat(450)}`;
    const text = toolDetailText(detail({ output, truncated: true }), redactions, false);
    expect(text).toContain(TOOL_TEXT_CUT);
    expect(text).not.toContain('c'.repeat(40));
    expect(text.length).toBeLessThan(4000);
    expect(text.trimEnd().endsWith('d d')).toBe(true);
  });

  it('clips a long input with a note', () => {
    const text = toolDetailText(
      detail({ input: { command: 'x '.repeat(2000) } }),
      redactions,
      false
    );
    expect(text.endsWith(TOOL_TEXT_CUT)).toBe(true);
    expect(text.length).toBeLessThan(1100);
  });

  it('masks a secret that was cut by the buffer before it could be recognised', () => {
    const head = `log ${key.slice(0, 8)}`;
    const text = toolDetailText(
      detail({
        output: `${head}${TOOL_OUTPUT_GAP}${key.slice(8)} done`,
        truncated: true,
      }),
      redactions,
      false
    );
    expect(text).not.toContain(key.slice(8));
    expect(text).not.toContain(key.slice(0, 8));
  });
});
