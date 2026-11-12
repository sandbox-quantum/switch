import type { Check, CheckStatus } from './doctor';
import type { MappedAgentProcess } from './status';

export interface ColorOptions {
  color?: boolean;
}

export function isColorEnabled(stream: NodeJS.WritableStream = process.stdout): boolean {
  if (process.env.NO_COLOR && process.env.NO_COLOR !== '') return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean((stream as { isTTY?: boolean }).isTTY);
}

export const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function style(text: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${text}${ansi.reset}` : text;
}

export const c = {
  bold: (t: string, enabled = true) => style(t, ansi.bold, enabled),
  dim: (t: string, enabled = true) => style(t, ansi.dim, enabled),
  green: (t: string, enabled = true) => style(t, ansi.green, enabled),
  yellow: (t: string, enabled = true) => style(t, ansi.yellow, enabled),
  red: (t: string, enabled = true) => style(t, ansi.red, enabled),
  cyan: (t: string, enabled = true) => style(t, ansi.cyan, enabled),
  gray: (t: string, enabled = true) => style(t, ansi.gray, enabled),
};

export const SYMBOLS = {
  ok: '✔',
  warn: '⚠',
  fail: '✖',
  bullet: '•',
  arrow: '→',
};

export function mark(status: CheckStatus, color = false): string {
  switch (status) {
    case 'ok':
      return color ? `${c.green(SYMBOLS.ok, true)} ${c.green('ok  ', true)}` : `${SYMBOLS.ok} ok  `;
    case 'warn':
      return color ? `${c.yellow(SYMBOLS.warn, true)} ${c.yellow('warn', true)}` : `${SYMBOLS.warn} warn`;
    case 'fail':
      return color ? `${c.red(SYMBOLS.fail, true)} ${c.red('FAIL', true)}` : `${SYMBOLS.fail} FAIL`;
  }
}

export function section(title: string, color = false): string {
  const line = c.bold(title, color);
  const border = c.dim('─'.repeat(Math.max(40, title.length + 4)), color);
  return `\n${line}\n${border}`;
}

export interface StatusAgentEntry {
  id: string;
  name: string;
  provider: string;
  desiredState: string;
  revision: number;
  appliedRevision: number | 'never';
  mapped: MappedAgentProcess;
  unreadableSummary?: string | null;
}

export interface StatusDocument {
  controller: {
    id: string | null;
    name: string | null;
    server: string | null;
    enrolledAt: string | null;
    revokedAt: string | null;
    dataDir: string;
    secretStore: string;
    relayPort: number | null;
    separateUsers?: {
      agentsDir: string;
      unit: string;
    } | null;
    credentialPresent: boolean;
  };
  assignment: {
    status: 'none' | 'unreadable' | 'ready';
    revision?: number;
    agentsCount?: number;
    detail?: string;
  };
  agents: StatusAgentEntry[];
}

export function formatStatusDocument(doc: StatusDocument, opts: ColorOptions = {}): string {
  const color = opts.color ?? isColorEnabled(process.stdout);
  const lines: string[] = [];

  // Machine / Controller Header
  lines.push(section('Controller Machine', color));
  lines.push(`  ${c.dim('Data directory:', color).padEnd(color ? 25 : 16)} ${doc.controller.dataDir}`);

  if (doc.controller.separateUsers) {
    lines.push(
      `  ${c.dim('Multi-user:', color).padEnd(color ? 25 : 16)} Each agent as separate user in ${doc.controller.separateUsers.agentsDir} (${doc.controller.separateUsers.unit})`
    );
  }

  if (!doc.controller.id) {
    lines.push(`  ${c.yellow(SYMBOLS.warn + ' Status:', color).padEnd(color ? 25 : 16)} ${c.yellow('Not enrolled.', color)}`);
    return lines.join('\n');
  }

  lines.push(
    `  ${c.dim('Controller ID:', color).padEnd(color ? 25 : 16)} ${c.bold(doc.controller.id, color)} ("${doc.controller.name}")`
  );
  lines.push(`  ${c.dim('Server:', color).padEnd(color ? 25 : 16)} ${doc.controller.server}`);
  lines.push(`  ${c.dim('Enrolled at:', color).padEnd(color ? 25 : 16)} ${doc.controller.enrolledAt}`);
  lines.push(`  ${c.dim('Secret store:', color).padEnd(color ? 25 : 16)} ${doc.controller.secretStore}`);
  lines.push(
    `  ${c.dim('Relay endpoint:', color).padEnd(color ? 25 : 16)} ${
      doc.controller.relayPort === null
        ? 'never started'
        : `http://127.0.0.1:${doc.controller.relayPort} (loopback relay)`
    }`
  );

  if (doc.controller.revokedAt) {
    lines.push(`  ${c.red('Revoked at:', color).padEnd(color ? 25 : 16)} ${c.red(doc.controller.revokedAt, color)}`);
  } else if (!doc.controller.credentialPresent) {
    lines.push(
      `  ${c.yellow('Credential:', color).padEnd(color ? 25 : 16)} ${c.yellow('Not in data directory (missing or passed via stdin)', color)}`
    );
  }

  // Assignments / Agents
  lines.push(section('Assigned Agents', color));
  if (doc.assignment.status === 'none') {
    lines.push(`  ${c.dim('No assignment pulled yet from server.', color)}`);
    return lines.join('\n');
  }
  if (doc.assignment.status === 'unreadable') {
    lines.push(
      `  ${c.yellow('Assignment unreadable:', color)} ${doc.assignment.detail} (will re-pull on next run)`
    );
    return lines.join('\n');
  }

  lines.push(
    `  ${c.dim(`Revision ${doc.assignment.revision}, ${doc.assignment.agentsCount} agent(s) configured`, color)}\n`
  );

  if (doc.agents.length === 0) {
    lines.push(`  ${c.dim('No agents assigned to this machine.', color)}`);
  } else {
    for (const ag of doc.agents) {
      const stateMark =
        ag.mapped.process === 'running'
          ? c.green(SYMBOLS.ok, color)
          : ag.mapped.process === 'failed' || ag.mapped.process === 'crashed'
            ? c.red(SYMBOLS.fail, color)
            : c.yellow(SYMBOLS.bullet, color);

      lines.push(`  ${stateMark} ${c.bold(ag.name, color)} ${c.dim(`(${ag.id})`, color)}`);
      lines.push(
        `      ${c.dim('Provider:', color)} ${ag.provider}   ${c.dim('Desired:', color)} ${ag.desiredState}   ${c.dim('Revision:', color)} ${ag.revision} (applied ${ag.appliedRevision})`
      );

      const procDetail = ag.unreadableSummary
        ? `${ag.unreadableSummary}`
        : `${ag.mapped.process}${ag.mapped.reason ? ` [${ag.mapped.reason}]` : ''}${ag.mapped.detail ? `: ${ag.mapped.detail}` : ''}`;
      lines.push(`      ${c.dim('Status:', color)}   ${procDetail}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function formatDoctorChecks(checks: Check[], opts: ColorOptions = {}): string {
  const color = opts.color ?? isColorEnabled(process.stdout);
  const width = Math.max(...checks.map((c) => c.name.length), 10);

  const lines = checks.map((chk) => {
    const m = mark(chk.status, color);
    const name = c.bold(chk.name.padEnd(width), color);
    return `${m}  ${name}  ${chk.detail}`;
  });

  const okCount = checks.filter((c) => c.status === 'ok').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;
  const failCount = checks.filter((c) => c.status === 'fail').length;

  const summaryParts: string[] = [];
  if (okCount > 0) summaryParts.push(c.green(`${okCount} ok`, color));
  if (warnCount > 0) summaryParts.push(c.yellow(`${warnCount} warning${warnCount > 1 ? 's' : ''}`, color));
  if (failCount > 0) summaryParts.push(c.red(`${failCount} failure${failCount > 1 ? 's' : ''}`, color));

  lines.push('\n' + c.dim('─'.repeat(45), color));
  lines.push(`Summary: ${summaryParts.join(', ')}`);

  return lines.join('\n');
}

export function formatEnrollSuccess(
  enrolled: { controllerId: string; name: string; server: string; dataDir: string },
  opts: ColorOptions = {}
): string {
  const color = opts.color ?? isColorEnabled(process.stdout);
  const lines = [
    `\n${c.green(SYMBOLS.ok, color)} ${c.bold('Enrolled successfully as controller', color)} ${c.cyan(enrolled.controllerId, color)} ("${enrolled.name}")`,
    `  ${c.dim('Server:', color)}   ${enrolled.server}`,
    `  ${c.dim('Data dir:', color)} ${enrolled.dataDir}`,
    '',
    `${c.bold('Next steps:', color)}`,
    `  ${c.cyan('•', color)} Run as a service:    ${c.bold('switch-agent-controller install-service', color)}`,
    `  ${c.cyan('•', color)} Or run interactively: ${c.bold('switch-agent-controller run', color)}`,
    `  ${c.cyan('•', color)} Verify system health: ${c.bold('switch-agent-controller doctor', color)}`,
  ];
  return lines.join('\n');
}
