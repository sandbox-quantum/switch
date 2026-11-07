import type { Check, CheckStatus } from './doctor';
import type { Identity } from './store';

type Tone = CheckStatus | 'heading';
const COLOUR: Record<Tone, number> = { ok: 32, warn: 33, fail: 31, heading: 1 };

export function colourEnabled(isTTY: boolean, env: NodeJS.ProcessEnv): boolean {
  return isTTY && env.NO_COLOR === undefined && env.TERM !== 'dumb';
}

export function highlight(text: string, tone: Tone, colour: boolean): string {
  return colour ? `\x1b[${COLOUR[tone]}m${text}\x1b[0m` : text;
}

export function fields(rows: [string, string][]): string {
  const width = Math.max(0, ...rows.map(([name]) => name.length));
  return rows.map(([name, value]) => `  ${`${name}:`.padEnd(width + 1)}  ${value}`).join('\n');
}

export function checksOutput(checks: Check[], colour: boolean): string {
  const width = Math.max(0, ...checks.map((check) => check.name.length));
  const marks: Record<CheckStatus, string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };
  return checks
    .map(
      (check) =>
        `  ${highlight(marks[check.status].padEnd(4), check.status, colour)}  ${check.name.padEnd(width)}  ${check.detail}`
    )
    .join('\n');
}

export type LocalStatus = {
  dataDir: string;
  identity: Identity | null;
  secretStore: string;
  relayPort: number | null;
  revokedAt: string | null;
  credentialPresent: boolean | null;
  separateUsers: { agentsDir: string; controllerUnit: string } | null;
  assignment: {
    kind: 'none' | 'unreadable' | 'saved';
    detail: string | null;
    revision: number | null;
  };
  agents: {
    id: string;
    name: string;
    provider: string;
    desiredState: string;
    revision: number;
    appliedRevision: number | null;
    process: string;
    reason: string | null;
    detail: string | null;
    observationError: string | null;
    unit: string | null;
  }[];
};

export function statusOutput(status: LocalStatus, colour: boolean): string {
  const rows: [string, string][] = [['Data directory', status.dataDir]];
  if (status.separateUsers)
    rows.push([
      'Agents',
      `each as a user of its own, in ${status.separateUsers.agentsDir} (${status.separateUsers.controllerUnit})`,
    ]);
  if (!status.identity)
    return `${highlight('Controller', 'heading', colour)}\n${fields(rows)}\n\n${highlight('WARN', 'warn', colour)}  Not enrolled. Run: switch-agent-controller enroll --server <url> --code <code>`;
  rows.push(
    ['Controller', `${status.identity.controllerId} ("${status.identity.name}")`],
    ['Server', status.identity.server],
    ['Enrolled at', status.identity.enrolledAt],
    ['Secret store', status.secretStore],
    [
      'Relay',
      status.relayPort === null
        ? 'never started'
        : `http://127.0.0.1:${status.relayPort} (where agents were last pointed)`,
    ]
  );
  if (status.revokedAt) rows.push(['Revoked at', status.revokedAt]);
  else if (!status.credentialPresent)
    rows.push(['Credential', 'not in this data directory (missing, or handed over at run time)']);
  rows.push([
    'Assignment',
    status.assignment.kind === 'saved'
      ? `revision ${status.assignment.revision}, ${status.agents.length} agent(s)`
      : status.assignment.kind === 'unreadable'
        ? `saved by an earlier version and not readable by this one (${status.assignment.detail}); pulled again when the controller next runs`
        : 'not pulled yet',
  ]);
  const sections = [`${highlight('Controller', 'heading', colour)}\n${fields(rows)}`];
  for (const agent of status.agents) {
    const tone =
      agent.process === 'failed' || agent.process === 'crashed'
        ? 'fail'
        : agent.process === 'running' || agent.process === 'stopped'
          ? 'ok'
          : 'warn';
    sections.push(
      `${highlight(`${agent.name} (${agent.id})`, 'heading', colour)}\n${fields([
        ['Provider', agent.provider],
        ['Desired', agent.desiredState],
        ['Revision', `${agent.revision} (applied: ${agent.appliedRevision ?? 'never'})`],
        [
          'State',
          agent.observationError
            ? `${agent.unit}; the rest needs the agents' group (${agent.observationError})`
            : `${highlight(agent.process, tone, colour)}${agent.reason ? ` [${agent.reason}]` : ''}${agent.detail ? `: ${agent.detail}` : ''}`,
        ],
      ])}`
    );
  }
  return sections.join('\n\n');
}
