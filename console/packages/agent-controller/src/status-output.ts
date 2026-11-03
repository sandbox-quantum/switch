import { heading, PLAIN, type Paint, paint, rows, type Style, table } from './output';

/** One assigned agent as `status` shows it, read from local state only. */
export type AgentStatusView = {
  id: string;
  name: string;
  provider: string;
  desired: string;
  revision: number;
  /** The revision this machine last applied, or null when it never has. */
  applied: number | null;
  process: string;
  reason: string | null;
  detail: string | null;
  /** Said instead of the process when this shell cannot read it (separate users). */
  unreadable: string | null;
};

/** Everything `status` reports, so the text and `--json` say the same thing. */
export type StatusView = {
  dataDir: string;
  separateUsers: { agentsDir: string; controllerUnit: string } | null;
  controller: {
    id: string;
    name: string;
    server: string;
    enrolledAt: string;
    secretStore: string;
    /** Where agents were last pointed, or null when the relay never started. */
    relay: string | null;
    revokedAt: string | null;
    /** False when this data directory holds no credential (missing, or handed over at run time). */
    credential: boolean;
  } | null;
  assignment:
    | { state: 'not-pulled' }
    | { state: 'unreadable'; detail: string }
    | { state: 'pulled'; revision: number; agents: AgentStatusView[] }
    | null;
};

const STATE_COLOR: Record<string, Paint> = {
  running: 'green',
  stopped: 'dim',
  failed: 'red',
  crashed: 'red',
};

function agentState(agent: AgentStatusView): string {
  if (agent.unreadable) return agent.unreadable;
  return `${agent.process}${agent.reason ? ` [${agent.reason}]` : ''}${agent.detail ? `: ${agent.detail}` : ''}`;
}

/** The status as sections a person scans: machine, controller, then a table of agents. */
export function formatStatus(view: StatusView, style: Style = PLAIN): string {
  const machine: [string, string][] = [['Data directory', view.dataDir]];
  if (view.separateUsers)
    machine.push([
      'Agents run',
      `each as a user of its own, in ${view.separateUsers.agentsDir} (${view.separateUsers.controllerUnit})`,
    ]);
  const out = [heading(style, 'Machine'), ...rows(machine)];
  const { controller } = view;
  if (!controller) {
    out.push(
      '',
      `${paint(style, 'red', 'Not enrolled.')} Enroll with a code from the Machines page:`,
      '  switch-agent-controller enroll --server <url> --code <code>'
    );
    return out.join('\n');
  }
  const identity: [string, string][] = [
    ['ID', controller.id],
    ['Name', controller.name],
    ['Server', controller.server],
    ['Enrolled at', controller.enrolledAt],
    ['Secret store', controller.secretStore],
    [
      'Relay',
      controller.relay === null
        ? 'never started'
        : `${controller.relay} (where agents were last pointed)`,
    ],
  ];
  if (controller.revokedAt)
    identity.push(['Revoked at', paint(style, 'red', controller.revokedAt)]);
  else if (!controller.credential)
    identity.push([
      'Credential',
      paint(style, 'yellow', 'not in this data directory (missing, or handed over at run time)'),
    ]);
  out.push('', heading(style, 'Controller'), ...rows(identity));

  const { assignment } = view;
  if (!assignment || assignment.state === 'not-pulled') {
    out.push('', heading(style, 'Agents'), '  Assignment not pulled yet.');
    return out.join('\n');
  }
  if (assignment.state === 'unreadable') {
    out.push(
      '',
      heading(style, 'Agents'),
      `  The assignment was saved by an earlier version and this one cannot read it (${assignment.detail}). It is pulled again when the controller next runs.`
    );
    return out.join('\n');
  }
  const count = assignment.agents.length;
  out.push(
    '',
    heading(
      style,
      `Agents (revision ${assignment.revision}, ${count} agent${count === 1 ? '' : 's'})`
    )
  );
  if (!count) {
    out.push('  None assigned to this machine.');
    return out.join('\n');
  }
  const body = assignment.agents.map((agent) => [
    agent.name,
    agent.id,
    agent.provider,
    agent.desired,
    `${agent.applied ?? 'never'}/${agent.revision}`,
    paint(style, STATE_COLOR[agent.process] ?? 'yellow', agentState(agent)),
  ]);
  out.push(...table(style, ['NAME', 'ID', 'PROVIDER', 'DESIRED', 'APPLIED', 'STATE'], body));
  return out.join('\n');
}

export function statusJson(view: StatusView): string {
  return JSON.stringify(view, null, 2);
}
