/**
 * Terminal output formatting, ANSI styling, table alignment, and NO_COLOR support.
 * Zero external dependencies: ships as part of the standalone agent controller bundle.
 */

// eslint-disable-next-line no-control-regex
export const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

/**
 * Checks whether colors and styles should be used on the given stream.
 * Respects:
 * - NO_COLOR (any defined value disables color: https://no-color.org)
 * - NODE_DISABLE_COLORS=1
 * - FORCE_COLOR (any value other than '0' forces color)
 * - stream.isTTY
 */
export function isColorSupported(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.NODE_DISABLE_COLORS === '1') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY);
}

export const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
} as const;

export function style(text: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${text}${ansi.reset}` : text;
}

export function createColors(enabled: boolean) {
  return {
    bold: (t: string) => style(t, ansi.bold, enabled),
    dim: (t: string) => style(t, ansi.dim, enabled),
    green: (t: string) => style(t, ansi.green, enabled),
    yellow: (t: string) => style(t, ansi.yellow, enabled),
    red: (t: string) => style(t, ansi.red, enabled),
    cyan: (t: string) => style(t, ansi.cyan, enabled),
    blue: (t: string) => style(t, ansi.blue, enabled),
    magenta: (t: string) => style(t, ansi.magenta, enabled),
    gray: (t: string) => style(t, ansi.gray, enabled),
  };
}

export function formatSection(title: string, options: { color?: boolean } = {}): string {
  const useColor = options.color ?? false;
  const colors = createColors(useColor);
  return useColor ? colors.bold(colors.cyan(title)) : title;
}

export function formatKeyValue(
  pairs: [string, string | undefined | null][],
  options: { indent?: string; color?: boolean } = {}
): string {
  const indent = options.indent ?? '';
  const useColor = options.color ?? false;
  const colors = createColors(useColor);

  const activePairs = pairs.filter(
    (p): p is [string, string] => p[1] !== undefined && p[1] !== null && p[1] !== ''
  );
  if (activePairs.length === 0) return '';

  const maxLabelWidth = Math.max(...activePairs.map(([label]) => visibleLength(label)));

  return activePairs
    .map(([label, value]) => {
      const paddedLabel = (label + ':').padEnd(maxLabelWidth + 1);
      const styledLabel = useColor ? colors.dim(paddedLabel) : paddedLabel;
      return `${indent}${styledLabel}  ${value}`;
    })
    .join('\n');
}

export function formatTable(
  headers: string[],
  rows: (string | undefined)[][],
  options: { indent?: string; color?: boolean } = {}
): string {
  const indent = options.indent ?? '';
  const useColor = options.color ?? false;
  const colors = createColors(useColor);

  const colWidths: number[] = headers.map((h) => visibleLength(h));
  for (const row of rows) {
    for (let i = 0; i < headers.length; i++) {
      const cell = row[i] ?? '';
      const len = visibleLength(cell);
      if (len > (colWidths[i] ?? 0)) {
        colWidths[i] = len;
      }
    }
  }

  const padCell = (cell: string, width: number): string => {
    const vlen = visibleLength(cell);
    return cell + ' '.repeat(Math.max(0, width - vlen));
  };

  const headerLine =
    indent +
    headers
      .map((h, i) =>
        useColor ? colors.bold(padCell(h, colWidths[i]!)) : padCell(h, colWidths[i]!)
      )
      .join('  ');

  const rowLines = rows.map((row) => {
    return indent + headers.map((_, i) => padCell(row[i] ?? '', colWidths[i]!)).join('  ');
  });

  return [headerLine, ...rowLines].join('\n');
}

export function formatProcessStatus(process: string, useColor: boolean): string {
  const colors = createColors(useColor);
  if (!useColor) return process;
  switch (process) {
    case 'running':
      return `${colors.green('✔')} ${colors.green('running')}`;
    case 'stopped':
      return `${colors.gray('•')} ${colors.gray('stopped')}`;
    case 'starting':
      return `${colors.yellow('▲')} ${colors.yellow('starting')}`;
    case 'stopping':
      return `${colors.yellow('▲')} ${colors.yellow('stopping')}`;
    case 'pending':
      return `${colors.yellow('▲')} ${colors.yellow('pending')}`;
    case 'failed':
      return `${colors.red('✖')} ${colors.red('failed')}`;
    case 'crashed':
      return `${colors.red('✖')} ${colors.red('crashed')}`;
    default:
      return process;
  }
}

/**
 * Maps contract and operational reason codes to clear actionable remediation advice.
 */
export function reasonFix(reason?: string, detail?: string): string | null {
  if (
    detail &&
    /rejected the agent credentials|credentials belong to a different agent/i.test(detail)
  ) {
    return 'The agent credentials were rejected by the relay. Restart the agent or verify server credentials.';
  }
  switch (reason) {
    case 'provider_not_installed':
      return 'Install the provider CLI and verify it is on PATH for this user.';
    case 'provider_login_missing':
      return 'Sign in with the provider CLI (e.g. auth login) or configure API keys in --env-file.';
    case 'provider_login_expired':
      return 'The provider sign-in expired. Re-authenticate or update credentials.';
    case 'provider_version_unsupported':
      return 'Upgrade the provider CLI to a supported version.';
    case 'invalid_credential':
      return 'Re-enroll the machine or supply a valid credential.';
    case 'taken_over':
      return 'Restart the agent to reclaim its connection from the other client.';
    case 'controller_revoked':
      return 'Re-enroll this machine with a fresh enrollment code from Switch.';
    case 'crash_loop':
      return 'Check the agent logs for crash details and review required environment variables.';
    case 'repo_clone_failed':
      return 'Check git authentication, SSH keys, and network access to the repository.';
    case 'disk_full':
      return 'Free up disk space on the volume hosting the data directory.';
    case 'out_of_memory':
      return 'Increase system memory or reduce concurrent sessions.';
    case 'internal':
      return 'Check the controller logs (SWITCH_CONTROLLER_LOG_LEVEL=debug) for details.';
    default:
      return null;
  }
}
