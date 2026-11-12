import { errorMessage } from './log';
import type { DataLayout } from './paths';
import { definitionProblem } from './reconcile';
import { NO_COLORS, renderFields, type Colors } from './report';
import { emptyObservation, observeOnDisk, type AgentRuntime } from './runtime';
import { type AgentAssignment } from './schemas';
import { CONTROLLER_CREDENTIAL, type SecretStore } from './secrets';
import { mapAgentProcess } from './status';
import type { ControllerStore, Identity } from './store';

/** What `status` says about one agent, from local state only. */
export type AgentSnapshot = {
  name: string;
  id: string;
  provider: string;
  desired: string;
  revision: number;
  applied: number | null;
  process: string;
  reason: string | null;
  detail: string | null;
  /** Replaces the process line where a separate-users setup kept part of the
   * answer from this shell: the unit's state, and why the rest is missing. */
  note: string | null;
};

/** Everything `status` reads from the data directory, as one object. */
export type StatusSnapshot = {
  version: string;
  dataDir: string;
  separateUsers: { agentsDir: string; controllerUnit: string } | null;
  identity: Identity | null;
  revokedAt: string | null;
  secretStore: string;
  relayPort: number | null;
  credentialPresent: boolean | null;
  assignment:
    | { kind: 'none' }
    | { kind: 'unreadable'; detail: string }
    | { kind: 'ok'; revision: number; agents: AgentSnapshot[] };
};

/** Reads the data directory the way `status` always has: nothing here starts a
 * controller or talks to the server; whether events flow is the running
 * controller's to know, and this reads only disk. */
export async function collectSnapshot(input: {
  version: string;
  dataDir: string;
  layout: DataLayout;
  store: ControllerStore;
  secrets: SecretStore;
  separateUsers: { agentsDir: string; controllerUnit: string } | null;
  separateRuntime: AgentRuntime | null;
  /** The systemd unit's state for an agent, or null where agents are not
   * separate users; what `status` says about an agent it could not observe. */
  unitSummaryFor: (agentId: string) => Promise<string | null>;
}): Promise<StatusSnapshot> {
  const { store, secrets } = input;
  const identity = store.identity();
  const common = {
    version: input.version,
    dataDir: input.dataDir,
    separateUsers: input.separateUsers,
    identity,
    secretStore: secrets.description,
  };
  if (!identity)
    return {
      ...common,
      revokedAt: null,
      relayPort: null,
      credentialPresent: null,
      assignment: { kind: 'none' },
    };
  const revokedAt = store.revokedAt();
  const credentialPresent = revokedAt ? null : Boolean(await secrets.get(CONTROLLER_CREDENTIAL));
  const cached = store.cachedAssignment();
  if (cached.kind === 'none')
    return {
      ...common,
      revokedAt,
      relayPort: store.relayPort(),
      credentialPresent,
      assignment: cached,
    };
  if (cached.kind === 'unreadable')
    return {
      ...common,
      revokedAt,
      relayPort: store.relayPort(),
      credentialPresent,
      assignment: cached,
    };
  const agents: AgentSnapshot[] = [];
  for (const entry of cached.assignment.agents) {
    agents.push(
      await agentSnapshot(entry, {
        store,
        layout: input.layout,
        separateRuntime: input.separateRuntime,
        unitSummaryFor: input.unitSummaryFor,
      })
    );
  }
  return {
    ...common,
    revokedAt,
    relayPort: store.relayPort(),
    credentialPresent,
    assignment: {
      kind: 'ok',
      revision: cached.assignment.revision,
      agents,
    },
  };
}

async function agentSnapshot(
  entry: AgentAssignment,
  input: {
    store: ControllerStore;
    layout: DataLayout;
    separateRuntime: AgentRuntime | null;
    unitSummaryFor: (agentId: string) => Promise<string | null>;
  }
): Promise<AgentSnapshot> {
  const row = input.store.agent(entry.agent_id);
  let observation = emptyObservation();
  let note: string | null = null;
  if (!definitionProblem(entry)) {
    if (input.separateRuntime) {
      try {
        observation = await input.separateRuntime.observe(entry.agent_id);
      } catch (error) {
        const unreadable = errorMessage(error);
        const unit = await input.unitSummaryFor(entry.agent_id);
        if (unit !== null) note = `${unit}; the rest needs the agents' group (${unreadable})`;
      }
    } else observation = await observeOnDisk(input.layout, entry.agent_id);
  }
  const mapped = mapAgentProcess({
    assignment: entry,
    row,
    observation,
    relayAttached: false,
    nowMs: Date.now(),
  });
  return {
    name: entry.definition.name,
    id: entry.agent_id,
    provider: entry.definition.provider,
    desired: entry.desired_state,
    revision: entry.revision,
    applied: row?.appliedRevision ?? null,
    process: mapped.process,
    reason: mapped.reason ?? null,
    detail: mapped.detail ?? null,
    note,
  };
}

/** `status --json`: the snapshot as one object a script can read. */
export function snapshotJson(snapshot: StatusSnapshot): string {
  return JSON.stringify(snapshot);
}

/** The snapshot as the person running `status` reads it. */
export function formatSnapshot(snapshot: StatusSnapshot, colors: Colors = NO_COLORS): string {
  const fields: (readonly [string, string])[] = [['Data directory:', snapshot.dataDir]];
  if (snapshot.separateUsers)
    fields.push([
      'Agents:',
      `each as a user of its own, in ${snapshot.separateUsers.agentsDir} (${snapshot.separateUsers.controllerUnit})`,
    ]);
  if (!snapshot.identity) return `${renderFields(fields, colors)}\nNot enrolled.`;
  const { identity } = snapshot;
  fields.push(
    ['Controller:', `${identity.controllerId} ("${identity.name}")`],
    ['Server:', identity.server],
    ['Enrolled at:', identity.enrolledAt],
    ['Secret store:', snapshot.secretStore],
    [
      'Relay:',
      snapshot.relayPort === null
        ? 'never started'
        : `http://127.0.0.1:${snapshot.relayPort} (where agents were last pointed)`,
    ]
  );
  if (snapshot.revokedAt) fields.push(['Revoked at:', snapshot.revokedAt]);
  else if (snapshot.credentialPresent === false)
    fields.push([
      'Credential:',
      'not in this data directory (missing, or handed over at run time)',
    ]);
  if (snapshot.assignment.kind === 'none') fields.push(['Assignment:', 'not pulled yet']);
  else if (snapshot.assignment.kind === 'unreadable')
    fields.push([
      'Assignment:',
      `saved by an earlier version and not readable by this one (${snapshot.assignment.detail}); pulled again when the controller next runs`,
    ]);
  else
    fields.push([
      'Assignment:',
      `revision ${snapshot.assignment.revision}, ${snapshot.assignment.agents.length} agent(s)`,
    ]);
  const text = renderFields(fields, colors);
  if (snapshot.assignment.kind !== 'ok' || snapshot.assignment.agents.length === 0) return text;
  const agents = snapshot.assignment.agents.map(
    (agent) =>
      `  ${agent.name} (${agent.id})\n` +
      `    provider ${agent.provider}, desired ${agent.desired}, revision ${agent.revision}, applied ${agent.applied ?? 'never'}\n` +
      `    ${
        agent.note ??
        `${agent.process}${agent.reason ? ` [${agent.reason}]` : ''}${agent.detail ? `: ${agent.detail}` : ''}`
      }`
  );
  return `${text}\n\n${agents.join('\n\n')}`;
}
