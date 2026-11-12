import { describe, expect, it } from 'vitest';
import { Redactions } from './redaction';
import type { ToolDetailParts } from './tool-detail-buffer';
import {
  OUTPUT_MIDDLE_DROPPED,
  TOOL_DETAIL_INPUT,
  TOOL_DETAIL_PREVIEW,
  toolDetailPreview,
} from './tool-detail-preview';

const redactions = new Redactions();
const redact = (text: string) => redactions.toolDetail(text);

function parts(overrides: Partial<ToolDetailParts>): ToolDetailParts {
  return { input: null, head: '', tail: '', outputClipped: false, hasOutput: false, ...overrides };
}

describe('a tool call’s preview', () => {
  it('shows what the call was given and what it gave back, redacted', () => {
    const preview = toolDetailPreview(
      parts({
        input: { command: 'psql postgres://app:synthetic-pass@db.example.com/app -c "select 1"' },
        head: 'DATABASE_PASSWORD=synthetic-password-value\n(1 row)',
        hasOutput: true,
      }),
      redact
    );

    expect(preview).toBe(
      'Input: {"command":"psql postgres://app:[REDACTED]@db.example.com/app -c \\"select 1\\""}\n' +
        'Output:\nDATABASE_PASSWORD=[REDACTED]\n(1 row)'
    );
  });

  it('leaves nothing of a secret the dropped middle of a clipped output cut through', () => {
    const preview = toolDetailPreview(
      parts({
        head: 'first line\nexport API_TOKEN=synthetic-secr',
        tail: 'et-value-0123\nlast line',
        outputClipped: true,
        hasOutput: true,
      }),
      redact
    );

    expect(preview).toBe(`Output:\nfirst line\n${OUTPUT_MIDDLE_DROPPED}\nlast line`);
  });

  it('drops an end that is all one cut line rather than show part of it', () => {
    const preview = toolDetailPreview(
      parts({ head: 'x'.repeat(10), tail: 'y'.repeat(10), outputClipped: true, hasOutput: true }),
      redact
    );

    expect(preview).toBe(`Output:\n${OUTPUT_MIDDLE_DROPPED}`);
  });

  it('is cut to its size, note included, saying how much was left out', () => {
    const preview = toolDetailPreview(
      parts({ head: 'z'.repeat(TOOL_DETAIL_PREVIEW + 100), hasOutput: true }),
      redact
    );

    expect(Array.from(preview ?? '')).toHaveLength(TOOL_DETAIL_PREVIEW);
    const kept = preview?.split('\n…')[0] ?? '';
    const dropped = 'Output:\n'.length + TOOL_DETAIL_PREVIEW + 100 - kept.length;
    expect(preview?.endsWith(`\n… ${dropped} more characters not shown`)).toBe(true);
  });

  it('cuts a long input to its own share, so the output still shows', () => {
    const preview = toolDetailPreview(
      parts({ input: 'q'.repeat(TOOL_DETAIL_INPUT * 3), head: 'the result', hasOutput: true }),
      redact
    );

    const [input, output] = preview?.split('\nOutput:\n') ?? [];
    expect(Array.from(input ?? '')).toHaveLength('Input: '.length + TOOL_DETAIL_INPUT);
    expect(input).toMatch(/\n… \d+ more characters not shown$/);
    expect(output).toBe('the result');
  });

  it('never grows past its size where the count in its note gains a digit', () => {
    for (let over = 1; over <= 200; over++) {
      const preview = toolDetailPreview(
        parts({ head: 'z'.repeat(TOOL_DETAIL_PREVIEW + over), hasOutput: true }),
        redact
      );
      expect(Array.from(preview ?? '').length).toBeLessThanOrEqual(TOOL_DETAIL_PREVIEW);
    }
  });

  it('is nothing for a call with neither input nor output', () => {
    expect(toolDetailPreview(parts({}), redact)).toBeNull();
  });
});
