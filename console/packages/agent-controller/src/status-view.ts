import { type Mark, heading, mark, type Output, paint, rows } from './format';

/** One assigned agent, as `status` reads it from local state. */
export type AgentStatusView = {
  id: string;
  name: string;
  provider: string;
  desiredState: string;
  revision: number;
  appliedRevision: number | null;
  /** The contract's process state (`running`, `failed`…), or null when it could not be read. */
  process: string | null;
  reason: string | null;
  detail: string | null;
  /**
   * What systemd says of an agent run as a user of its own, when the rest of
   * its state needs the agents' group to read.
   */
  unit: string | null;
};

export type AssignmentView =
  | { state: 'not-pulled' }
  | { state: 'unreadable'; detail: string }
  | { state: 'pulled'; revision: number; agents: AgentStatusView[] };

export type ControllerView = {
  id: string;
  name: string;
  server: string;
  enrolledAt: string;
  secretStore: string;
  /** Where agents were last pointed, or null when the relay never started. */
  relayPort: number | null;
  revokedAt: string | null;
  /**
   * False when no credential is in this data directory (missing, or handed
   * over at run time); null when the controller is revoked and it was not looked for.
   */
  credentialStored: boolean | null;
  assignment: AssignmentView;
};

/** Everything `status` prints, so the text and `--json` cannot say different things. */
export type StatusView = {
  dataDir: string;
  /** Set when every agent runs as a Linux user of its own. */
  separateUsers: { agentsDir: string; controllerUnit: string } | null;
  /** Null when this data directory is not enrolled. */
  controller: ControllerView | null;
};

/** How a process state reads at a glance: healthy, on its way, or needing a look. */
export function processMark(process: string | null): Mark {
  if (process === 'running' || process === 'stopped') return 'ok';
  if (process === 'failed' || process === 'crashed' || process === null) return 'fail';
  return 'warn';
}

function agentLines(out: Output, agent: AgentStatusView): string[] {
  const applied = agent.appliedRevision ?? 'never';
  const state = agent.unit
    ? agent.unit
    : `${paint(out, 'bold', agent.process ?? 'unknown')}${agent.reason ? ` [${agent.reason}]` : ''}`;
  const lines = [
    `  ${mark(out, agent.unit ? 'warn' : processMark(agent.process))}  ${paint(out, 'bold', agent.name)} ${paint(out, 'dim', `(${agent.id})`)}`,
    `        ${state}, ${agent.provider}, desired ${agent.desiredState}, revision ${agent.revision}, applied ${applied}`,
  ];
  if (agent.detail) lines.push(`        ${paint(out, 'dim', agent.detail)}`);
  return lines;
}

/** `status` as text: Machine, Controller and Agents sections, aligned. */
export function formatStatus(out: Output, view: StatusView): string {
  const machine: Array<[string, string]> = [['Data directory', view.dataDir]];
  if (view.separateUsers)
    machine.push([
      'Agents run',
      `each as a user of its own, in ${view.separateUsers.agentsDir} (${view.separateUsers.controllerUnit})`,
    ]);
  const lines = [heading(out, 'Machine'), ...rows(out, machine), ''];
  const controller = view.controller;
  if (!controller) {
    lines.push(
      heading(out, 'Controller'),
      `  ${mark(out, 'fail')}  Not enrolled.`,
      `        ${paint(out, 'dim', 'Fix: switch-agent-controller enroll --server <url> --code <code>, with a code from the Machines page.')}`
    );
    return lines.join('\n');
  }
  const details: Array<[string, string]> = [
    ['Controller', `${controller.id} ("${controller.name}")`],
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
  // The hosted machine's boot tells a revoked controller by `Revoked at:` in this output.
  if (controller.revokedAt) details.push(['Revoked at', paint(out, 'red', controller.revokedAt)]);
  else if (controller.credentialStored === false)
    details.push([
      'Credential',
      'not in this data directory (missing, or handed over at run time)',
    ]);
  lines.push(heading(out, 'Controller'), ...rows(out, details), '');

  const assignment = controller.assignment;
  if (assignment.state === 'not-pulled') {
    lines.push(heading(out, 'Agents'), '  Assignment not pulled yet.');
  } else if (assignment.state === 'unreadable') {
    lines.push(
      heading(out, 'Agents'),
      `  ${mark(out, 'warn')}  Assignment saved by an earlier version and not readable by this one (${assignment.detail}); pulled again when the controller next runs.`
    );
  } else {
    const count = assignment.agents.length;
    lines.push(
      `${heading(out, 'Agents')} ${paint(out, 'dim', `(revision ${assignment.revision}, ${count} ${count === 1 ? 'agent' : 'agents'})`)}`
    );
    if (count === 0) lines.push('  None assigned to this machine.');
    for (const agent of assignment.agents) lines.push(...agentLines(out, agent));
  }
  return lines.join('\n');
}

/** `status --json`: the same view, for scripts. */
export function statusJson(view: StatusView): string {
  return JSON.stringify(view, null, 2);
}
