import {
  type Column,
  fields,
  heading,
  indent,
  jsonDocument,
  type Style,
  table,
} from './cli-output';

export type AgentLine = {
  id: string;
  name: string;
  provider: string;
  desiredState: string;
  revision: number;
  appliedRevision: number | null;
  process: string;
  reason: string | null;
  detail: string | null;
};

export type LocalStatus = {
  dataDir: string;
  /** Set when every agent runs as a user of its own. */
  agentUsers: { agentsDir: string; controllerUnit: string } | null;
  /** Null when this data directory is not enrolled. */
  controller: {
    id: string;
    name: string;
    server: string;
    enrolledAt: string;
    secretStore: string;
    relayPort: number | null;
    revokedAt: string | null;
    credentialMissing: boolean;
  } | null;
  assignment:
    | { kind: 'none' }
    | { kind: 'unreadable'; detail: string }
    | { kind: 'cached'; revision: number; agents: AgentLine[] };
};

export const ENROLL_HINT =
  'Run switch-agent-controller enroll --server <agent-bridge-url> --code <code>, with a code from the Machines page.';

const FAILED_PROCESSES = ['failed', 'crashed'];
const WAITING_PROCESSES = ['pending', 'starting', 'stopping'];

function paintProcess(cell: string, line: AgentLine, style: Style): string {
  if (line.process === 'running') return style.green(cell);
  if (FAILED_PROCESSES.includes(line.process)) return style.red(cell);
  if (WAITING_PROCESSES.includes(line.process)) return style.yellow(cell);
  return style.dim(cell);
}

const AGENT_COLUMNS: Column<AgentLine>[] = [
  { header: 'AGENT', cell: (line) => line.name },
  { header: 'PROVIDER', cell: (line) => line.provider },
  { header: 'DESIRED', cell: (line) => line.desiredState },
  { header: 'PROCESS', cell: (line) => line.process, paint: paintProcess },
  { header: 'REVISION', cell: (line) => String(line.revision) },
  { header: 'APPLIED', cell: (line) => String(line.appliedRevision ?? 'never') },
];

function agentLines(agents: AgentLine[], style: Style): string[] {
  const rows = table(style, AGENT_COLUMNS, agents);
  const lines = [rows[0] ?? ''];
  agents.forEach((agent, index) => {
    lines.push(rows[index + 1] ?? '', style.dim(`  ID: ${agent.id}`));
    const why = [agent.reason ? `[${agent.reason}]` : '', agent.detail ?? '']
      .filter(Boolean)
      .join(' ');
    if (why) {
      const failed = FAILED_PROCESSES.includes(agent.process);
      lines.push(`  ${failed ? style.red(why) : style.dim(why)}`);
    }
  });
  return lines;
}

/** What `status` prints: the machine, the controller and its agents, in sections. */
export function formatLocalStatus(status: LocalStatus, style: Style): string {
  const machine: [string, string][] = [['Data directory', status.dataDir]];
  if (status.agentUsers)
    machine.push([
      'Agents run as',
      `each a user of its own, in ${status.agentUsers.agentsDir} (${status.agentUsers.controllerUnit})`,
    ]);
  const out = [heading(style, 'Machine'), ...indent(fields(machine), 2)];
  const { controller } = status;
  if (!controller) {
    out.push('', style.red('Not enrolled.'), ENROLL_HINT);
    return out.join('\n');
  }
  const details: [string, string][] = [
    ['ID', controller.id],
    ['Name', controller.name],
    ['Server', controller.server],
    ['Enrolled at', controller.enrolledAt],
    ['Secret store', controller.secretStore],
    [
      'Relay',
      controller.relayPort === null
        ? 'never started'
        : `http://127.0.0.1:${controller.relayPort} (where agents were last pointed)`,
    ],
  ];
  if (controller.revokedAt) details.push(['Revoked at', controller.revokedAt]);
  else if (controller.credentialMissing)
    details.push([
      'Credential',
      'not in this data directory (missing, or handed over at run time)',
    ]);
  out.push('', heading(style, 'Controller'), ...indent(fields(details), 2));
  const { assignment } = status;
  if (assignment.kind === 'none')
    out.push(
      '',
      heading(style, 'Agents'),
      '  Assignment not pulled yet; the controller pulls it when it first runs.'
    );
  else if (assignment.kind === 'unreadable')
    out.push(
      '',
      heading(style, 'Agents'),
      `  Assignment saved by an earlier version and not readable by this one (${assignment.detail}); pulled again when the controller next runs.`
    );
  else {
    out.push(
      '',
      heading(style, `Agents (assignment revision ${assignment.revision})`),
      ...(assignment.agents.length === 0
        ? ['  None assigned to this machine.']
        : indent(agentLines(assignment.agents, style), 2))
    );
  }
  return out.join('\n');
}

/** The same facts for a script. */
export function localStatusJson(status: LocalStatus): string {
  return jsonDocument({ enrolled: status.controller !== null, ...status });
}
