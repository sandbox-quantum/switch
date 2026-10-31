import type { Check, CheckStatus } from './doctor';

/**
 * The marks, alignment and colour the controller's commands share.
 *
 * Colour reaches only a terminal: a pipe or a log file gets the same text
 * with no escape codes, and `NO_COLOR` turns colour off even there
 * (no-color.org: set to anything at all, even empty, it counts).
 */

export type Colors = {
  ok: (text: string) => string;
  warn: (text: string) => string;
  fail: (text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
};

const plain = (text: string) => text;

/** The text back unchanged: pipes, log files, and `NO_COLOR`. */
export const NO_COLORS: Colors = {
  ok: plain,
  warn: plain,
  fail: plain,
  bold: plain,
  dim: plain,
};

const painted = (code: string) => (text: string) => `\u001b[${code}m${text}\u001b[0m`;

/** Green for a pass, yellow for a warning, red for a failure. */
export const ANSI_COLORS: Colors = {
  ok: painted('32'),
  warn: painted('33'),
  fail: painted('31'),
  bold: painted('1'),
  dim: painted('2'),
};

/** Colour for `stream` unless it is not a terminal or NO_COLOR says no. */
export function colorsFor(stream: { isTTY?: boolean }, env: { NO_COLOR?: string }): Colors {
  return stream.isTTY === true && env.NO_COLOR === undefined ? ANSI_COLORS : NO_COLORS;
}

/** One mark column wide: `ok  `, `warn`, `FAIL`, all four characters. */
export const MARK: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

/** The checks `doctor` ran, one to a line, the names in one column. */
export function formatChecks(checks: Check[], colors: Colors = NO_COLORS): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  return checks
    .map(
      (check) =>
        `${colors[check.status](MARK[check.status])}  ${check.name.padEnd(width)}  ${check.detail}`
    )
    .join('\n');
}

/** `doctor --json`: the same checks as one object a script can read. */
export function doctorJson(version: string, nodeVersion: string, checks: Check[]): string {
  return JSON.stringify({ version, node: nodeVersion, checks });
}

/** `Label: value` lines with every label in one column; values stay plain. */
export function renderFields(
  fields: readonly (readonly [string, string])[],
  colors: Colors = NO_COLORS
): string {
  const width = Math.max(...fields.map(([label]) => label.length));
  return fields.map(([label, value]) => `${colors.dim(label.padEnd(width))}  ${value}`).join('\n');
}

/**
 * The usage text with the command names set off. Only the command words are
 * touched, never the explanations; with no colour the text is unchanged.
 */
export function formatUsage(usage: string, colors: Colors = NO_COLORS): string {
  return usage.replace(/^  (\S+)/gm, (_, command: string) => `  ${colors.bold(command)}`);
}
