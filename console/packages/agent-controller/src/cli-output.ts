import { stripVTControlCharacters } from 'node:util';
import type { Check, CheckStatus } from './doctor';
import type { Identity } from './store';

export type StatusView = {
  version: string;
  platform: string;
  dataDir: string;
  identity: Identity | null;
  agentUsers: { directory: string; count: number; unit: string } | null;
  secretStore: string;
  relayPort: number | null;
  revokedAt: string | null;
  credential: 'present' | 'missing' | 'not-checked';
  assignment: {
    state: 'none' | 'unreadable' | 'ready';
    revision: number | null;
    detail: string | null;
  };
  agents: {
    id: string;
    name: string;
    provider: string;
    desired: string;
    revision: number;
    appliedRevision: number | null;
    process: string;
    reason: string | null;
    detail: string | null;
    observationProblem: string | null;
  }[];
};

const MARK = { ok: '[OK]', warn: '[WARN]', fail: '[FAIL]', info: '[INFO]' };
const COLOR = { ok: 32, warn: 33, fail: 31, info: 36 };

/** Values from providers and servers must not become terminal commands. */
export function plain(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export class CliOutput {
  private readonly color: boolean;

  constructor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv) {
    this.color = stream.isTTY === true && env.NO_COLOR === undefined && env.TERM !== 'dumb';
  }

  heading(text: string): string {
    const safe = plain(text);
    return this.color ? `\u001b[1m${safe}\u001b[0m` : safe;
  }

  result(status: keyof typeof MARK, text: string): string {
    const mark = this.color ? `\u001b[${COLOR[status]}m${MARK[status]}\u001b[0m` : MARK[status];
    return `${mark}${' '.repeat(7 - MARK[status].length)}${plain(text)}`;
  }

  message(status: keyof typeof MARK, text: string, notes: string[]): string {
    return [
      this.result(status, text),
      ...notes.flatMap((note) => note.split('\n').map((line) => `  ${plain(line)}`)),
      '',
    ].join('\n');
  }

  section(title: string, rows: [string, string][]): string {
    const width = Math.max(0, ...rows.map(([key]) => plain(key).length));
    return [
      this.heading(title),
      ...rows.map(([key, value]) => `  ${plain(key).padEnd(width)}  ${plain(value)}`),
    ].join('\n');
  }

  help(usage: string): string {
    return usage.replace(/^(Usage:.*|[A-Z][^\n]*:|  [a-z][^\n]*|Exit codes:.*)$/gm, (line) =>
      this.heading(line)
    );
  }
}

export function checkSummary(checks: Check[]): Record<CheckStatus, number> {
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) summary[check.status]++;
  return summary;
}

export function formatDoctor(checks: Check[], output: CliOutput): string {
  const groups: [string, Check[]][] = [
    [
      'Machine',
      checks.filter((c) =>
        ['Node', 'Platform', 'Shared host', 'Agent users', 'Service', 'Version'].includes(c.name)
      ),
    ],
    ['Connection', checks.filter((c) => ['Enrollment', 'Credential', 'Server'].includes(c.name))],
    [
      'Providers',
      checks.filter(
        (c) =>
          ![
            'Node',
            'Platform',
            'Shared host',
            'Agent users',
            'Service',
            'Version',
            'Enrollment',
            'Credential',
            'Server',
          ].includes(c.name)
      ),
    ],
  ];
  const sections = groups
    .filter(([, items]) => items.length)
    .map(([title, items]) => {
      const width = Math.max(...items.map((c) => plain(c.name).length));
      return [
        output.heading(title),
        ...items.map(
          (c) =>
            `  ${output.result(c.status, plain(c.name).padEnd(width))}  ${plain(c.detail)}${c.fix ? `\n         Fix: ${plain(c.fix)}` : ''}`
        ),
      ].join('\n');
    });
  const summary = checkSummary(checks);
  sections.push(
    `${summary.ok} ok, ${summary.warn} warning${summary.warn === 1 ? '' : 's'}, ${summary.fail} failed`
  );
  return sections.join('\n\n');
}

export function formatStatus(view: StatusView, output: CliOutput): string {
  const sections = [
    output.section('Machine', [
      ['Version', view.version],
      ['Platform', view.platform],
      ['Data directory', view.dataDir],
      [
        'Agent isolation',
        view.agentUsers
          ? `${view.agentUsers.count} users in ${view.agentUsers.directory} (${view.agentUsers.unit})`
          : 'current user',
      ],
    ]),
  ];
  if (!view.identity) {
    sections.push(
      output.result('warn', 'Not enrolled.'),
      '  Fix: switch-agent-controller enroll --server <url> --code <code> (code from the Machines page)'
    );
    return sections.join('\n\n');
  }
  sections.push(
    output.section('Connection', [
      ['Controller', `${view.identity.controllerId} ("${view.identity.name}")`],
      ['Server', view.identity.server],
      ['Enrolled at', view.identity.enrolledAt],
      ['Secret store', view.secretStore],
      [
        'Relay',
        view.relayPort === null
          ? 'never started'
          : `http://127.0.0.1:${view.relayPort} (last configured address)`,
      ],
    ])
  );
  if (view.revokedAt)
    sections.push(
      output.result('fail', `Revoked at ${view.revokedAt}. Enroll this machine again.`)
    );
  else if (view.credential === 'missing')
    sections.push(
      output.result(
        'warn',
        'Credential missing or handed over at run time. Run doctor to check enrollment.'
      )
    );
  if (view.assignment.state !== 'ready') {
    sections.push(
      output.result(
        view.assignment.state === 'none' ? 'info' : 'warn',
        view.assignment.state === 'none'
          ? 'Assignment not pulled yet. Start the controller with switch-agent-controller run.'
          : `Saved assignment is unreadable (${view.assignment.detail}); it will be pulled again when the controller runs.`
      )
    );
  } else {
    sections.push(
      output.section('Assignment', [
        ['Revision', String(view.assignment.revision)],
        ['Agents', String(view.agents.length)],
      ])
    );
    sections.push(
      output.section('Providers in assignment', [
        ['Names', [...new Set(view.agents.map((a) => a.provider))].join(', ') || 'none'],
      ])
    );
    if (!view.agents.length) sections.push(output.heading('Agents') + '\n  No agents assigned.');
    for (const agent of view.agents) {
      sections.push(
        output.section(`Agent: ${agent.name}`, [
          ['ID', agent.id],
          ['Provider', agent.provider],
          ['Desired', agent.desired],
          ['Revision', `${agent.revision} (applied ${agent.appliedRevision ?? 'never'})`],
          ['Process', `${agent.process}${agent.reason ? ` [${agent.reason}]` : ''}`],
          ...(agent.detail ? [['Detail', agent.detail] as [string, string]] : []),
        ])
      );
      if (agent.observationProblem) sections.push(output.result('warn', agent.observationProblem));
    }
  }
  sections.push('For readiness checks and fixes: switch-agent-controller doctor');
  return sections.join('\n\n');
}
