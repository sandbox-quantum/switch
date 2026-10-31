import { describe, expect, it } from 'vitest';
import { Redactions } from '../host/redaction';
import type { ToolDetailParts } from '../host/tool-detail-buffer';
import { toolDetailText, TOOL_TEXT_CUT } from './tool-detail-text';

const parts = (patch: Partial<ToolDetailParts>): ToolDetailParts => ({
  type: 'command_execution',
  input: null,
  head: '',
  tail: '',
  outputClipped: false,
  exitCode: null,
  ...patch,
});
const key = `sk-${'q'.repeat(24)}`;

describe('toolDetailText', () => {
  const redactions = new Redactions();

  it('shows a shell call as a shell line and its output', () => {
    expect(
      toolDetailText(
        parts({ input: { command: 'npm test' }, head: '42 passed' }),
        redactions,
        false
      )
    ).toBe('Input: $ npm test\nOutput:\n42 passed');
  });

  it('shows another tool arguments as JSON even when one is named command', () => {
    expect(
      toolDetailText(
        parts({ type: 'mcp_tool_call', input: { command: 'deploy' } }),
        redactions,
        false
      )
    ).toBe('Input: {"command":"deploy"}');
  });

  it('shows other arguments as compact JSON and says when the call failed', () => {
    expect(
      toolDetailText(
        parts({ input: { path: 'a.txt' }, head: 'no such file', exitCode: 2 }),
        redactions,
        false
      )
    ).toBe('Input: {"path":"a.txt"}\nOutput (exit 2):\nno such file');
  });

  it('is empty for a call with neither input nor output', () => {
    expect(toolDetailText(parts({}), redactions, false)).toBe('');
  });

  it('masks secrets in input and output', () => {
    const text = toolDetailText(
      parts({
        input: { command: `curl -H "Authorization: Bearer ${key}"` },
        head: `key=${key}`,
      }),
      redactions,
      false
    );
    expect(text).not.toContain(key);
    expect(text).toContain('[REDACTED]');
  });

  it('holds back the last word of output that is still streaming', () => {
    const partial = key.slice(0, 10);
    expect(toolDetailText(parts({ head: `got ${partial}` }), redactions, true)).toBe(
      'Output:\ngot'
    );
    expect(toolDetailText(parts({ head: `got ${partial}` }), redactions, false)).toContain(partial);
  });

  it('keeps a head and a tail of long output with a note, dropping words the cut split', () => {
    const head = `${'a'.repeat(1990)} ${'b'.repeat(40)}`;
    const tail = `${'c'.repeat(40)} ${'d '.repeat(450)}`;
    const text = toolDetailText(parts({ head, tail, outputClipped: true }), redactions, false);
    expect(text).toContain(TOOL_TEXT_CUT);
    expect(text).not.toContain('c'.repeat(40));
    expect(text.length).toBeLessThan(4000);
    expect(text.trimEnd().endsWith('d d')).toBe(true);
  });

  it('does not take a separator-looking line in the output for the cut', () => {
    const output = 'first\n…\nsecond';
    expect(toolDetailText(parts({ head: output }), redactions, false)).toBe(`Output:\n${output}`);
    const tail = `${'x '.repeat(300)}\n…\nlast line`;
    const text = toolDetailText(
      parts({ head: 'start ', tail: ` ${tail}`, outputClipped: true }),
      redactions,
      false
    );
    expect(text.startsWith(`Output:\nstart \n${TOOL_TEXT_CUT}\n`)).toBe(true);
    expect(text.endsWith('last line')).toBe(true);
  });

  it('does not take a clipped input for a clipped output', () => {
    const text = toolDetailText(
      parts({ input: { command: 'x '.repeat(2000) }, head: 'plain\n…\noutput' }),
      redactions,
      false
    );
    expect(text).toContain('Output:\nplain\n…\noutput');
    expect(text).not.toContain(`Output:\nplain\n${TOOL_TEXT_CUT}`);
  });

  it('clips a long input with a note', () => {
    const text = toolDetailText(
      parts({ input: { command: 'x '.repeat(2000) } }),
      redactions,
      false
    );
    expect(text.endsWith(TOOL_TEXT_CUT)).toBe(true);
    expect(text.length).toBeLessThan(1100);
  });

  it('keeps a note for an input that is one unbroken word longer than its room', () => {
    expect(toolDetailText(parts({ input: 'x'.repeat(5000) }), redactions, false)).toBe(
      `Input: ${TOOL_TEXT_CUT}`
    );
  });

  it('keeps a note for output that is one unbroken word longer than its room', () => {
    const text = toolDetailText(
      parts({ head: 'y'.repeat(5000), outputClipped: true }),
      redactions,
      false
    );
    expect(text).toBe(`Output:\n${TOOL_TEXT_CUT}`);
  });

  it('masks a secret that was cut by the buffer before it could be recognised', () => {
    const text = toolDetailText(
      parts({
        head: `log ${key.slice(0, 8)}`,
        tail: `${key.slice(8)} done`,
        outputClipped: true,
      }),
      redactions,
      false
    );
    expect(text).not.toContain(key.slice(8));
    expect(text).not.toContain(key.slice(0, 8));
  });
});
