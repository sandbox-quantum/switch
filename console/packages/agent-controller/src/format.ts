import { PROVIDERS } from './schemas';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export type MarkType = 'ok' | 'warn' | 'fail' | 'info';

/**
 * Determines whether color escape sequences should be emitted.
 * Respects NO_COLOR (https://no-color.org/) and FORCE_COLOR conventions,
 * falling back to stream.isTTY.
 */
export function shouldUseColor(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return true;
  return Boolean(stream.isTTY);
}

export const colors = {
  bold: (s: string, enabled = true) => (enabled ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string, enabled = true) => (enabled ? `\x1b[2m${s}\x1b[0m` : s),
  red: (s: string, enabled = true) => (enabled ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string, enabled = true) => (enabled ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string, enabled = true) => (enabled ? `\x1b[33m${s}\x1b[0m` : s),
  blue: (s: string, enabled = true) => (enabled ? `\x1b[34m${s}\x1b[0m` : s),
  magenta: (s: string, enabled = true) => (enabled ? `\x1b[35m${s}\x1b[0m` : s),
  cyan: (s: string, enabled = true) => (enabled ? `\x1b[36m${s}\x1b[0m` : s),
  gray: (s: string, enabled = true) => (enabled ? `\x1b[90m${s}\x1b[0m` : s),
};

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

export function padVisible(str: string, targetLength: number, padChar = ' '): string {
  const currentLength = visibleLength(str);
  if (currentLength >= targetLength) return str;
  return str + padChar.repeat(targetLength - currentLength);
}

/**
 * Returns a 4-character status mark, optionally ANSI colorized.
 * Guaranteed visible length is always 4 characters so column alignment stays exact.
 */
export function formatMark(type: MarkType, useColor = false): string {
  switch (type) {
    case 'ok':
      return useColor ? colors.green('ok  ') : 'ok  ';
    case 'warn':
      return useColor ? colors.yellow('warn') : 'warn';
    case 'fail':
      return useColor ? colors.red(colors.bold('FAIL')) : 'FAIL';
    case 'info':
      return useColor ? colors.cyan('info') : 'info';
  }
}

export type TableColumn = {
  header: string;
  minWidth?: number;
};

export function formatTable(
  columns: (string | TableColumn)[],
  rows: (string | number | null | undefined)[][],
  options: { indent?: string; useColor?: boolean } = {}
): string {
  const indent = options.indent ?? '';
  const useColor = options.useColor ?? false;

  const parsedCols: TableColumn[] = columns.map((col) =>
    typeof col === 'string' ? { header: col } : col
  );

  const widths = parsedCols.map((col, colIdx) => {
    let max = Math.max(visibleLength(col.header), col.minWidth ?? 0);
    for (const row of rows) {
      const val = row[colIdx] != null ? String(row[colIdx]) : '';
      const len = visibleLength(val);
      if (len > max) max = len;
    }
    return max;
  });

  const headerLine =
    indent +
    parsedCols
      .map((col, i) => {
        const text = padVisible(col.header, widths[i]!);
        return useColor ? colors.bold(colors.dim(text)) : text;
      })
      .join('  ');

  const formattedRows = rows.map((row) => {
    return (
      indent +
      parsedCols
        .map((_, i) => {
          const val = row[i] != null ? String(row[i]) : '';
          return padVisible(val, widths[i]!);
        })
        .join('  ')
    );
  });

  return [headerLine, ...formattedRows].join('\n');
}

export function formatKeyValue(
  entries: [string, string | number | null | undefined][],
  options: { indent?: string; minKeyWidth?: number; useColor?: boolean } = {}
): string {
  const indent = options.indent ?? '  ';
  const useColor = options.useColor ?? false;
  const valid = entries.filter(([, val]) => val !== undefined && val !== null);
  const maxKeyLen = Math.max(
    options.minKeyWidth ?? 0,
    ...valid.map(([key]) => visibleLength(key))
  );

  return valid
    .map(([key, val]) => {
      const paddedKey = padVisible(key + ':', maxKeyLen + 1);
      const styledKey = useColor ? colors.dim(paddedKey) : paddedKey;
      return `${indent}${styledKey}  ${val}`;
    })
    .join('\n');
}

export function formatSectionTitle(title: string, useColor = false): string {
  return useColor ? colors.bold(title) : title;
}

// -----------------------------------------------------------------------------
// Doctor formatting
// -----------------------------------------------------------------------------

export type FormattedCheck = {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
};

export type CheckCategory = 'machine' | 'enrollment' | 'providers';

export function categorizeCheck(name: string): CheckCategory {
  if (['Enrollment', 'Credential', 'Server'].includes(name)) return 'enrollment';
  if ((PROVIDERS as readonly string[]).includes(name) || name === 'Providers') return 'providers';
  return 'machine';
}

export function formatDoctorChecks(
  checks: FormattedCheck[],
  options: { useColor?: boolean; sections?: boolean } = {}
): string {
  const useColor = options.useColor ?? false;
  const sections = options.sections ?? true;

  if (!sections) {
    const width = Math.max(...checks.map((c) => c.name.length));
    return checks
      .map((check) => {
        const mark = formatMark(check.status, useColor);
        const namePadded = check.name.padEnd(width);
        const line = `${mark}  ${namePadded}  ${check.detail}`;
        if ((check.status === 'warn' || check.status === 'fail') && check.fix) {
          const indent = ' '.repeat(mark.length + 2 + width + 2);
          const fixLabel = useColor ? colors.cyan('Fix:') : 'Fix:';
          return `${line}\n${indent}${fixLabel} ${check.fix}`;
        }
        return line;
      })
      .join('\n');
  }

  const groups: Record<CheckCategory, { title: string; checks: FormattedCheck[] }> = {
    machine: { title: 'Machine', checks: [] },
    enrollment: { title: 'Enrollment & Server', checks: [] },
    providers: { title: 'Providers', checks: [] },
  };

  for (const check of checks) {
    groups[categorizeCheck(check.name)].checks.push(check);
  }

  // Width is computed across all checks so names in all sections align to the same column
  const width = Math.max(...checks.map((c) => c.name.length));

  const out: string[] = [];

  for (const key of ['machine', 'enrollment', 'providers'] as const) {
    const group = groups[key];
    if (group.checks.length === 0) continue;

    if (out.length > 0) out.push('');
    out.push(formatSectionTitle(group.title, useColor));

    for (const check of group.checks) {
      const mark = formatMark(check.status, useColor);
      const namePadded = check.name.padEnd(width);
      const line = `  ${mark}  ${namePadded}  ${check.detail}`;
      if ((check.status === 'warn' || check.status === 'fail') && check.fix) {
        const indent = ' '.repeat(2 + 4 + 2 + width + 2);
        const fixLabel = useColor ? colors.cyan('Fix:') : 'Fix:';
        out.push(`${line}\n${indent}${fixLabel} ${check.fix}`);
      } else {
        out.push(line);
      }
    }
  }

  return out.join('\n');
}

// -----------------------------------------------------------------------------
// Status formatting
// -----------------------------------------------------------------------------

export type StatusAgentRow = {
  name: string;
  agentId: string;
  provider: string;
  desiredState: string;
  process: string;
  reason?: string | null;
  detail?: string | null;
  appliedRevision: number | string;
};

export type ControllerStatusData = {
  dataDir: string;
  enrolled: boolean;
  controllerId?: string;
  name?: string;
  server?: string;
  enrolledAt?: string;
  secretStore?: string;
  relay?: string | null;
  revokedAt?: string | null;
  credentialMissing?: boolean;
  separateUsers?: { agentsDir: string; unit: string } | null;
  assignment?: {
    kind: 'none' | 'unreadable' | 'saved';
    revision?: number;
    unreadableDetail?: string;
    agents?: StatusAgentRow[];
  };
};

export function formatStatusReport(
  data: ControllerStatusData,
  options: { useColor?: boolean } = {}
): string {
  const useColor = options.useColor ?? false;
  const out: string[] = [];

  // Machine / System section
  if (data.separateUsers) {
    out.push(formatSectionTitle('Machine', useColor));
    out.push(
      formatKeyValue(
        [
          ['Data directory', data.dataDir],
          [
            'Agents',
            `each as a user of its own, in ${data.separateUsers.agentsDir} (${data.separateUsers.unit})`,
          ],
        ],
        { useColor }
      )
    );
    out.push('');
  }

  // Controller section
  out.push(formatSectionTitle('Controller', useColor));

  if (!data.enrolled) {
    const mark = formatMark('warn', useColor);
    out.push(
      formatKeyValue(
        [
          ['Data directory', data.dataDir],
          ['Status', `${mark}  Not enrolled`],
          ['Fix', 'Run switch-agent-controller enroll --server <url> --code <code>'],
        ],
        { useColor }
      )
    );
    return out.join('\n');
  }

  const controllerEntries: [string, string | number | null | undefined][] = [
    ['Data directory', data.dataDir],
    ['ID', data.controllerId],
    ['Name', data.name],
    ['Server', data.server],
    ['Enrolled at', data.enrolledAt],
    ['Secret store', data.secretStore],
    ['Relay', data.relay ?? 'never started'],
  ];

  if (data.revokedAt) {
    controllerEntries.push([
      'Revocation',
      `${formatMark('fail', useColor)}  Revoked at ${data.revokedAt} (enroll again)`,
    ]);
  } else if (data.credentialMissing) {
    controllerEntries.push([
      'Credential',
      `${formatMark('warn', useColor)}  not in this data directory (missing, or handed over at run time)`,
    ]);
  }

  out.push(formatKeyValue(controllerEntries, { useColor }));
  out.push('');

  // Agents section
  const assignment = data.assignment;
  if (!assignment || assignment.kind === 'none') {
    out.push(formatSectionTitle('Agents', useColor));
    out.push('  Assignment: not pulled yet');
  } else if (assignment.kind === 'unreadable') {
    out.push(formatSectionTitle('Agents', useColor));
    out.push(
      `  Assignment: saved by an earlier version and not readable (${assignment.unreadableDetail}); pulled again when controller next runs`
    );
  } else {
    const agents = assignment.agents ?? [];
    const countDesc = `${agents.length} agent${agents.length === 1 ? '' : 's'} assigned, revision ${assignment.revision}`;
    out.push(formatSectionTitle(`Agents (${countDesc})`, useColor));

    if (agents.length === 0) {
      out.push('  No agents assigned.');
    } else {
      const tableRows = agents.map((agent) => {
        let statusDisplay = agent.process;
        if (useColor) {
          if (agent.process === 'running') statusDisplay = colors.green(agent.process);
          else if (agent.process === 'stopped') statusDisplay = colors.dim(agent.process);
          else statusDisplay = colors.red(agent.process);
        }

        const detailParts: string[] = [];
        if (agent.appliedRevision !== undefined) {
          detailParts.push(`applied rev ${agent.appliedRevision}`);
        }
        if (agent.reason) {
          detailParts.push(`[${agent.reason}]`);
        }
        if (agent.detail) {
          detailParts.push(agent.detail);
        }

        return [
          agent.name,
          agent.agentId,
          agent.provider,
          agent.desiredState,
          statusDisplay,
          detailParts.join(' '),
        ];
      });

      out.push(
        formatTable(
          ['NAME', 'ID', 'PROVIDER', 'DESIRED', 'STATUS', 'DETAIL'],
          tableRows,
          { indent: '  ', useColor }
        )
      );
    }
  }

  return out.join('\n');
}

// -----------------------------------------------------------------------------
// Enroll formatting
// -----------------------------------------------------------------------------

export function formatEnrollSuccess(
  info: {
    controllerId: string;
    name: string;
    server: string;
    dataDir: string;
    dataDirFlag?: string;
  },
  options: { useColor?: boolean } = {}
): string {
  const useColor = options.useColor ?? false;
  const mark = formatMark('ok', useColor);
  const dataDirArg = info.dataDirFlag ? ` --data-dir ${info.dataDir}` : '';

  const lines: string[] = [
    `${mark}  Enrolled as controller ${info.controllerId} ("${info.name}") on ${info.server}.`,
    '',
    formatKeyValue([['Data directory', info.dataDir]], { useColor }),
    '',
    formatSectionTitle('Next steps:', useColor),
    `  Run as a service:    switch-agent-controller install-service${dataDirArg}`,
    `  Run in this shell:   switch-agent-controller run${dataDirArg}`,
    '',
  ];

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Service install / uninstall formatting
// -----------------------------------------------------------------------------

export function formatServiceInstallSuccess(
  serviceFile: string,
  notes: string[],
  releasesNote: string,
  options: { useColor?: boolean } = {}
): string {
  const useColor = options.useColor ?? false;
  const mark = formatMark('ok', useColor);

  const lines: string[] = [
    `${mark}  Service installed and started: ${serviceFile}`,
  ];

  const allNotes = [...notes, releasesNote].filter(Boolean);
  if (allNotes.length > 0) {
    lines.push('');
    for (const note of allNotes) {
      lines.push(`  • ${note}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function formatSeparateUsersInstallSuccess(
  notes: string[],
  options: { useColor?: boolean } = {}
): string {
  const useColor = options.useColor ?? false;
  const mark = formatMark('ok', useColor);

  const lines: string[] = [
    `${mark}  Agents now run as users of their own.`,
  ];
  if (notes.length > 0) {
    lines.push('');
    for (const note of notes) {
      lines.push(`  • ${note}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function formatServiceUninstallSuccess(
  removed: boolean,
  releasesDirRemoved: string | null,
  options: { useColor?: boolean } = {}
): string {
  const useColor = options.useColor ?? false;
  const mark = removed ? formatMark('ok', useColor) : formatMark('warn', useColor);

  const lines: string[] = [
    removed
      ? `${mark}  Stopped and removed the service.`
      : `${mark}  No service was installed.`,
  ];

  if (releasesDirRemoved) {
    lines.push(`  • Removed the releases installed for itself, in ${releasesDirRemoved}.`);
  }
  lines.push('');
  return lines.join('\n');
}

export function formatSeparateUsersUninstallSuccess(
  notes: string[],
  options: { useColor?: boolean } = {}
): string {
  const useColor = options.useColor ?? false;
  const mark = formatMark('ok', useColor);

  const lines: string[] = [
    `${mark}  Removed the setup for agents as users of their own.`,
  ];
  if (notes.length > 0) {
    lines.push('');
    for (const note of notes) {
      lines.push(`  • ${note}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Update formatting
// -----------------------------------------------------------------------------

export function formatUpdateStatus(
  status:
    | { kind: 'none-published' }
    | { kind: 'latest'; version: string }
    | { kind: 'available'; current: string; latest: string },
  options: { useColor?: boolean } = {}
): string {
  const useColor = options.useColor ?? false;

  switch (status.kind) {
    case 'none-published':
      return `${formatMark('warn', useColor)}  No switch-agent-controller release is published yet.\n`;
    case 'latest':
      return `${formatMark('ok', useColor)}  This is the latest release, ${status.version}.\n`;
    case 'available':
      return [
        `${formatMark('warn', useColor)}  Update available: ${status.latest} (currently running ${status.current}).`,
        '       Install with: switch-agent-controller update',
        '',
      ].join('\n');
  }
}

// -----------------------------------------------------------------------------
// Help formatting
// -----------------------------------------------------------------------------

export function formatHelp(usage: string, options: { useColor?: boolean } = {}): string {
  const useColor = options.useColor ?? false;
  if (!useColor) return usage;

  return usage
    .replace(/^([A-Za-z][A-Za-z0-9 _-]*:)/gm, (match) => colors.bold(colors.cyan(match)))
    .replace(/^(  [a-z][a-z0-9-]+)/gm, (match) => colors.bold(match));
}
