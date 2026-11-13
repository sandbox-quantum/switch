import { stripVTControlCharacters } from 'node:util';

export type OutputStyle = { color: boolean };

export function outputStyle(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): OutputStyle {
  return { color: stream.isTTY === true && env.NO_COLOR === undefined && env.TERM !== 'dumb' };
}

/** Terminal controls in names and diagnostics must not become commands to the terminal. */
export function plain(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\n+$/, '');
}

export function heading(text: string, style: OutputStyle): string {
  const label = plain(text).replace(/\n/g, ' ');
  return style.color ? `\x1b[1;36m${label}\x1b[0m` : label;
}

export function fields(rows: readonly (readonly [string, string])[]): string {
  const clean = rows.map(([label, value]) => [plain(label).replace(/\n/g, ' '), plain(value)]);
  const width = Math.max(0, ...clean.map(([label]) => label.length));
  return clean
    .map(([label, value]) => {
      const [first, ...rest] = value.split('\n');
      const continuation = ' '.repeat(width + 4);
      return [
        `  ${`${label}:`.padEnd(width + 2)}${first}`,
        ...rest.map((line) => `${continuation}${line}`),
      ].join('\n');
    })
    .join('\n');
}

const MARKS = { ok: '[OK]', warn: '[WARN]', fail: '[ERROR]', info: '[INFO]' } as const;
const COLORS = { ok: 32, warn: 33, fail: 31, info: 36 } as const;

export function notice(
  status: 'ok' | 'warn' | 'fail' | 'info',
  text: string,
  style: OutputStyle
): string {
  const mark = MARKS[status];
  const [first, ...rest] = plain(text).split('\n');
  const label = style.color ? `\x1b[${COLORS[status]}m${mark}\x1b[0m` : mark;
  return [`${label} ${first}`, ...rest.map((line) => `${' '.repeat(mark.length + 1)}${line}`)].join(
    '\n'
  );
}
