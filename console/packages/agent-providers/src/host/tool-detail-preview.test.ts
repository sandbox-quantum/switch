import { describe, expect, it } from 'vitest';
import { Redactions } from './redaction';
import type { ToolDetailParts } from './tool-detail-buffer';
import { TOOL_DETAIL_PREVIEW, toolDetailPreview } from './tool-detail-preview';

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

    expect(preview).toBe('Output:\nfirst line\n…\nlast line');
  });

  it('drops an end that is all one cut line rather than show part of it', () => {
    const preview = toolDetailPreview(
      parts({ head: 'x'.repeat(10), tail: 'y'.repeat(10), outputClipped: true, hasOutput: true }),
      redact
    );

    expect(preview).toBe('Output:\n…');
  });

  it('is cut to its size, saying how much was left out', () => {
    const preview = toolDetailPreview(
      parts({ head: 'z'.repeat(TOOL_DETAIL_PREVIEW + 100), hasOutput: true }),
      redact
    );

    const dropped = 'Output:\n'.length + 100;
    expect(preview?.endsWith(`\n… ${dropped} more characters not shown`)).toBe(true);
  });

  it('is nothing for a call with neither input nor output', () => {
    expect(toolDetailPreview(parts({}), redact)).toBeNull();
  });
});
