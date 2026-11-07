import { markCell, type Mark, type Printer } from './output';
import type { ProcessState } from './schemas';

/**
 * `status --json` on stdout, and nothing else on it. The shape is stable:
 * fields are added, never renamed or dropped, so a script may read it across
 * controller versions.
 *
 * - `schema`         — this document's name and version.
 * - `version`        — the controller that read the state.
 * - `dataDir`        — the directory the state was read from.
 * - `enrolled`       — whether the directory holds an identity; it matches the
 *                      exit code (0 / 1), which has not changed.
 * - `controller`     — the identity, or null when there is none.
 * - `secretStore`    — where the credential is kept, or null when not enrolled.
 * - `credential`     — "present" when this directory holds one, "absent" when
 *                      it does not (handed over at run time, or removed),
 *                      "revoked" when the server took the enrollment back.
 * - `revokedAt`      — when it was revoked, or null.
 * - `relay`          — the URL agents were last pointed at, or null.
 * - `separateUsers`  — the setup running every agent as a Linux user of its
 *                      own, or null when agents run as this user.
 * - `assignment`     — "none" before the first pull, "unreadable" for one
 *                      saved by an older controller, otherwise the agents.
 * - `agents[]`       — `id`, `name`, `provider`, `desiredState`, `revision`,
 *                      `appliedRevision` (null when never applied), `process`
 *                      (the contract's process state), `reason` and `detail`
 *                      (both null when there is nothing to say).
 */
export type StatusDocument = {
  schema: 'switch-agent-controller/status@1';
  version: string;
  dataDir: string;
  enrolled: boolean;
  controller: { id: string; name: string; server: string; enrolledAt: string } | null;
  secretStore: string | null;
  credential: 'present' | 'absent' | 'revoked' | null;
  revokedAt: string | null;
  relay: string | null;
  separateUsers: { agentsDir: string; controllerUnit: string } | null;
  assignment:
    | { state: 'none' }
    | { state: 'unreadable'; detail: string }
    | { state: 'saved'; revision: number; agents: StatusAgent[] };
};

export type StatusAgent = {
  id: string;
  name: string;
  provider: string;
  desiredState: string;
  revision: number;
  appliedRevision: number | null;
  process: ProcessState | 'unknown';
  reason: string | null;
  detail: string | null;
};

/** The mark an agent's process state carries: what a reader should look at first. */
export function agentMark(agent: StatusAgent): Mark {
  if (agent.process === 'crashed' || agent.process === 'failed') return 'fail';
  if (agent.process === 'running') return 'ok';
  if (agent.process === 'stopped') return agent.desiredState === 'stopped' ? 'ok' : 'warn';
  return 'warn';
}

export function renderStatus(printer: Printer, document: StatusDocument): void {
  printer.title(
    document.controller
      ? `switch-agent-controller status: ${document.controller.name}`
      : 'switch-agent-controller status'
  );
  printer.heading('Machine');
  printer.fields([
    { label: 'Data directory', value: document.dataDir },
    { label: 'Controller', value: `switch-agent-controller ${document.version}` },
    ...(document.separateUsers
      ? [
          {
            label: 'Agent runtime',
            value: `each agent as a user of its own, in ${document.separateUsers.agentsDir} (${document.separateUsers.controllerUnit})`,
          },
        ]
      : []),
  ]);
  if (!document.controller) {
    printer.blank();
    printer.line(printer.paint('Not enrolled.', 'yellow'));
    printer.line(
      `  ${printer.paint('Fix:', 'cyan')} switch-agent-controller enroll --server <url> --code <code>`
    );
    return;
  }
  printer.heading('Controller');
  printer.fields([
    { label: 'Id', value: document.controller.id },
    { label: 'Name', value: document.controller.name },
    { label: 'Server', value: document.controller.server },
    { label: 'Enrolled', value: document.controller.enrolledAt },
    { label: 'Secret store', value: document.secretStore ?? 'unknown' },
    { label: 'Credential', value: credentialValue(printer, document) },
    {
      label: 'Relay',
      value: document.relay
        ? `${document.relay} (where agents were last pointed)`
        : 'never started',
    },
  ]);
  renderAgents(printer, document);
}

function credentialValue(printer: Printer, document: StatusDocument): string {
  if (document.credential === 'revoked')
    return printer.paint(`revoked at ${document.revokedAt}; enroll this machine again`, 'red');
  if (document.credential === 'absent')
    return printer.paint(
      'not in this data directory (handed over at run time, or removed)',
      'yellow'
    );
  return printer.paint('present', 'green');
}

function renderAgents(printer: Printer, document: StatusDocument): void {
  const { assignment } = document;
  if (assignment.state === 'none') {
    printer.heading('Agents');
    printer.note('not pulled yet; the controller pulls one when it next runs');
    return;
  }
  if (assignment.state === 'unreadable') {
    printer.heading('Agents');
    printer.note(
      `saved by an earlier version and not readable by this one (${assignment.detail}); pulled again when the controller next runs`
    );
    return;
  }
  printer.heading(
    `Agents (assignment revision ${assignment.revision}, ${assignment.agents.length} assigned)`
  );
  if (assignment.agents.length === 0) {
    printer.note('none assigned to this machine');
    return;
  }
  printer.table([
    [
      { text: '', style: null },
      { text: 'AGENT', style: 'dim' },
      { text: 'ID', style: 'dim' },
      { text: 'PROVIDER', style: 'dim' },
      { text: 'WANTED', style: 'dim' },
      { text: 'STATE', style: 'dim' },
      { text: 'REVISION', style: 'dim' },
      { text: 'DETAIL', style: 'dim' },
    ],
    ...assignment.agents.map((agent) => [
      markCell(agentMark(agent)),
      { text: agent.name, style: 'bold' as const },
      { text: agent.id, style: 'dim' as const },
      agent.provider,
      agent.desiredState,
      agent.process,
      `${agent.revision} (applied ${agent.appliedRevision ?? 'never'})`,
      agentDetail(agent),
    ]),
  ]);
}

function agentDetail(agent: StatusAgent): string {
  const reason = agent.reason ? `[${agent.reason}] ` : '';
  return `${reason}${agent.detail ?? ''}`.trim();
}
