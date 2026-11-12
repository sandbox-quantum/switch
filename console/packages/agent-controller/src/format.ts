
export type OutputStatus = 'ok' | 'warn' | 'fail';

type OutputStream = {
  isTTY?: boolean;
};

type AnsiColor = 'green' | 'yellow' | 'red' | 'cyan';

const ANSI: Record<AnsiColor, string> = {
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
};

const RESET = '\u001b[0m';

/** Colours are enabled only for interactive terminals without NO_COLOR. */
export function supportsColor(
  stream: OutputStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return stream.isTTY === true && env.NO_COLOR === undefined;
}

/** Applies ANSI colour only when the destination supports it. */
export function colorize(
  value: string,
  color: AnsiColor,
  enabled = supportsColor()
): string {
  return enabled ? `${ANSI[color]}${value}${RESET}` : value;
}

/** Consistent status labels across CLI commands. */
export function formatStatusMark(
  status: OutputStatus,
  enabled = supportsColor()
): string {
  const labels: Record<OutputStatus, string> = {
    ok: 'OK',
    warn: 'WARN',
    fail: 'FAIL',
  };

  const colors: Record<OutputStatus, AnsiColor> = {
    ok: 'green',
    warn: 'yellow',
    fail: 'red',
  };

  return colorize(labels[status], colors[status], enabled);
}

/** Formats aligned key-value rows. */
export function formatKeyValueRows(
  rows: readonly { label: string; value: string }[],
  indent = ''
): string {
  const width = Math.max(0, ...rows.map((row) => row.label.length));

  return rows
    .map(({ label, value }) => `${indent}${label.padEnd(width)}  ${value}`)
    .join('\n');
}

/** Formats a titled section with consistently indented content. */
export function formatSection(title: string, lines: readonly string[]): string {
  return [title, ...lines.map((line) => `  ${line}`)].join('\n');
}
