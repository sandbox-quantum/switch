import { execFile } from 'node:child_process';
import { join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { agentLaunchConfig } from '@main/core/agents/agent-launch-config';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { resolveWorkdirFsFor } from '@main/core/agents/agent-workdir-fs';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { getAgents } from '@main/core/agents/getAgents';
import { agentSettingsRelativePath } from '@main/core/agents/switch-settings-paths';
import { writeNeutralAgentSettingsFs } from '@main/core/agents/write-switch-settings';
import { hostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import {
  embeddedControllerDataDir,
  embeddedControllerService,
} from '@main/core/embedded-controller/embedded-controllers';
import { locationManager } from '@main/core/locations/location-manager';
import { resolveSessionEnv } from '@main/core/locations/location-runtime-factory';
import { locationTransport } from '@main/core/locations/location-transport';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { listHostSessionsFor } from '@main/core/sdk-host/host-sessions';
import { stopLocalSessionsOf } from '@main/core/sdk-host/local-host';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import {
  listAutoSessionSubagents,
  listStoppedControllerAgentIds,
} from '@main/core/switch-rooms/auto-session-store';
import { autoSessionWatcher } from '@main/core/switch-rooms/auto-session-watcher';
import { parseSwitchAgentCredentials } from '@main/core/switch-rooms/switch-credentials';
import {
  AgentManagementUnavailableError,
  deleteManagedAgent,
  fetchAgentDetail,
  fetchManagedAgent,
  fetchManagementControllers,
  fetchMe,
  managementErrorMessage,
  putManagedAgent,
  revealAgentApiKey,
  setManagedAgentDesiredState,
} from '@main/core/switch-servers/gateway-client';
import { withReachableWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { agentMigrationChannel } from '@shared/events/agentMigrationEvents';
import {
  AgentMigrationService,
  type MigrationAgent,
  type MigrationCredentialsPort,
  type MigrationMachinePort,
  type MigrationManagementPort,
  type SubagentRef,
  type TargetLookup,
} from './agent-migration-service';
import {
  credentialsStashKey,
  deleteManagedAgentRecord,
  getManagedAgentRecord,
  listManagedAgentRecords,
  managedRecordFor,
  setManagedAgentRecord,
} from './managed-agents-store';
import { buildManagedDefinition, definitionBody } from './managed-definition';
import { type MachineScript, runHandoff } from './session-handoff';

const execute = promisify(execFile);

function toMigrationAgent(
  agent: Agent,
  location: { dir: string; sshHost: string | null }
): MigrationAgent {
  return {
    id: agent.id,
    name: agent.name,
    providerId: agent.providerId,
    switchAgentId: agent.switchAgentId,
    workspaceId: agent.workspaceId,
    serverId: agent.serverId,
    dir: location.dir,
    sshHost: location.sshHost,
  };
}

async function migrationAgent(agentId: string): Promise<MigrationAgent | null> {
  const agent = await getAgentById(agentId);
  if (!agent) return null;
  return toMigrationAgent(agent, await getAgentLocation(agent));
}

async function requireRow(agentId: string): Promise<Agent> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`Agent ${agentId} does not exist.`);
  return agent;
}

/** The Switch identity in a credentials file, or null when there is no file. */
async function identityInFile(agent: MigrationAgent, slug: string): Promise<string | null> {
  const workdir = await resolveWorkdirFsFor(agent.sshHost, agent.dir);
  try {
    const raw = await workdir.fs.read(agentSettingsRelativePath(slug));
    if (raw === null) return null;
    const env = (JSON.parse(raw) as { env?: { SWITCH_AGENT_ID?: unknown } }).env;
    return typeof env?.SWITCH_AGENT_ID === 'string' && env.SWITCH_AGENT_ID
      ? env.SWITCH_AGENT_ID
      : null;
  } finally {
    workdir.close();
  }
}

/** `node -e` on the agent's machine: Electron's binary as Node here, the host's Node over SSH. */
function machineScript(agent: MigrationAgent): MachineScript {
  if (!agent.sshHost)
    return async (script, args) =>
      (
        await execute(process.execPath, ['-e', script, ...args], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
        })
      ).stdout;
  return async (script, args) => {
    const { ctx } = await connectRemoteAgent(await requireRow(agent.id));
    try {
      return (await ctx.exec('node', ['-e', script, ...args])).stdout;
    } finally {
      ctx.dispose();
    }
  };
}

async function resolveThisComputer(agent: MigrationAgent): Promise<TargetLookup> {
  const serverId = agent.serverId!;
  const overview = await embeddedControllerService.overview(serverId, agent.workspaceId);
  const display = {
    kind: 'this-computer' as const,
    serverId,
    machineName: overview.enrollment?.name ?? null,
  };
  const refuse = (blocker: string, canEnable = false): TargetLookup => ({
    display,
    target: null,
    blocker,
    canEnable,
  });
  if (overview.unsupportedReason) return refuse(overview.unsupportedReason);
  const remote = overview.remote;
  if (remote?.kind === 'unavailable')
    return refuse(
      'This server does not have agent management turned on, so it cannot run agents on machines.'
    );
  if (!overview.enrollment)
    return refuse(
      'Turn on “Run managed agents on this computer” for this server first: the agent moves onto this computer’s controller.',
      remote?.kind === 'ok'
    );
  if (overview.phase.kind !== 'running')
    return refuse(
      `This computer’s controller is not running (${overview.phase.kind.replaceAll('_', ' ')}). See “This computer as a machine” on the server’s page.`
    );
  if (remote?.kind === 'error')
    return refuse(`Switch could not be asked about this computer’s controller: ${remote.message}`);
  if (remote?.kind === 'ok' && remote.controller?.state !== 'online')
    return refuse(
      'This computer’s controller has not reached Switch yet. Wait until the server’s page shows it Running.'
    );
  const dataDir = embeddedControllerDataDir(serverId);
  return {
    display,
    target: {
      display,
      controllerId: overview.enrollment.controllerId,
      workspaceId: overview.enrollment.workspaceId,
      watcherRoot: (switchAgentId) => join(dataDir, 'watchers', switchAgentId),
      credentialsPath: (switchAgentId) =>
        join(dataDir, 'agents', switchAgentId, 'credentials.json'),
    },
    blocker: null,
    canEnable: false,
  };
}

/** Where an agent on an SSH host moves to. Set by the SSH host controllers once they exist. */
let resolveSshHost: (agent: MigrationAgent) => Promise<TargetLookup> = async (agent) => ({
  display: { kind: 'ssh-host', sshHost: agent.sshHost!, machineName: null },
  target: null,
  blocker: 'Agents on SSH hosts cannot move to a managed machine yet.',
  canEnable: false,
});

export function setSshHostTargetResolver(
  resolve: (agent: MigrationAgent) => Promise<TargetLookup>
): void {
  resolveSshHost = resolve;
}

function managementFailure(what: string, error: unknown): Error {
  return new Error(`${what}: ${managementErrorMessage(error)}`, { cause: error });
}

const management: MigrationManagementPort = {
  eligibility: (workspaceId, switchAgentId) =>
    withReachableWorkspaceSession(workspaceId, async (server) => {
      try {
        await fetchManagementControllers(server);
      } catch (error) {
        if (error instanceof AgentManagementUnavailableError)
          return { management: false, owner: null, ownedByMe: false };
        throw error;
      }
      const [me, detail] = await Promise.all([
        fetchMe(server),
        fetchAgentDetail(server, switchAgentId),
      ]);
      return {
        management: true,
        owner: detail.ownerName,
        ownedByMe: detail.ownerId !== null && detail.ownerId === me.id,
      };
    }),
  adopt: async (workspaceId, switchAgentId, body) => {
    try {
      await withReachableWorkspaceSession(workspaceId, (server) =>
        putManagedAgent(server, switchAgentId, body)
      );
    } catch (error) {
      throw managementFailure('Switch did not take the agent', error);
    }
  },
  setDesiredState: async (workspaceId, switchAgentId, desiredState) => {
    try {
      await withReachableWorkspaceSession(workspaceId, (server) =>
        setManagedAgentDesiredState(server, switchAgentId, desiredState)
      );
    } catch (error) {
      throw managementFailure('Switch did not start the agent on its machine', error);
    }
  },
  release: async (workspaceId, switchAgentId) => {
    try {
      return await withReachableWorkspaceSession(workspaceId, (server) =>
        deleteManagedAgent(server, switchAgentId)
      );
    } catch (error) {
      throw managementFailure('Switch did not stop managing the agent', error);
    }
  },
  read: (workspaceId, switchAgentId) =>
    withReachableWorkspaceSession(workspaceId, async (server) => {
      const managed = await fetchManagedAgent(server, switchAgentId);
      if (!managed) return null;
      return {
        controllerId: managed.controllerId,
        desiredState: managed.desiredState,
        actual: managed.status,
      };
    }),
};

const machine: MigrationMachinePort = {
  sessions: async (agent, switchAgentIds) =>
    (await listHostSessionsFor(agent.id, switchAgentIds)).map((session) => ({
      sessionId: session.sessionId,
      switchAgentId: session.agentId,
      busy:
        session.status !== 'stopped' &&
        session.connectivity === 'online' &&
        (session.status === 'running' || session.pendingRequestIds.length > 0),
    })),
  stopConsoleWatchers: async (agent, subagents) => {
    await autoSessionWatcher.stopForAgent(agent.id);
    for (const subagent of subagents)
      await autoSessionWatcher.stopForSubagent(agent.id, subagent.name);
    // On an SSH host a session is the sidecar watcher's child and stopped
    // with it; here Console supervises each one itself.
    if (agent.sshHost) return;
    for (const switchAgentId of [agent.switchAgentId!, ...subagents.map((s) => s.switchAgentId)])
      await stopLocalSessionsOf(switchAgentId);
  },
  startConsoleWatchers: async (agent, subagents) => {
    await autoSessionWatcher.bringUp(agent.id, 'explicit');
    for (const subagent of subagents)
      await autoSessionWatcher.startForSubagent(agent.id, subagent.name);
  },
  handoff: (agent, request) => runHandoff(machineScript(agent), request),
  consoleCredentialsPath: (agent, slug) =>
    (agent.sshHost ? posix.join : join)(agent.dir, agentSettingsRelativePath(slug)),
};

const credentialsLog = { warn: (...input: unknown[]) => log.warn('agent-migration:', ...input) };

const credentials: MigrationCredentialsPort = {
  stash: async (agent, identity) => {
    const relPath = agentSettingsRelativePath(identity.slug);
    const workdir = await resolveWorkdirFsFor(agent.sshHost, agent.dir);
    try {
      const raw = await workdir.fs.read(relPath);
      if (raw === null) return false;
      const parsed = parseSwitchAgentCredentials(raw, credentialsLog);
      if (!parsed)
        throw new Error(
          `${relPath} does not hold complete Switch credentials, so it is left as it is.`
        );
      if (parsed.agentId !== identity.switchAgentId)
        throw new Error(
          `${relPath} names Switch agent ${parsed.agentId}, not ${identity.switchAgentId}; it is left as it is.`
        );
      await encryptedAppSecretsStore.setSecret(
        credentialsStashKey(agent.id, identity.switchAgentId),
        JSON.stringify({ endpoint: parsed.apiEndpoint, token: parsed.token })
      );
      await workdir.fs.delete(relPath);
      return true;
    } finally {
      workdir.close();
    }
  },
  restore: async (agent, identity) => {
    const key = credentialsStashKey(agent.id, identity.switchAgentId);
    if ((await identityInFile(agent, identity.slug)) === identity.switchAgentId) {
      await encryptedAppSecretsStore.deleteSecret(key);
      return;
    }
    const kept = await encryptedAppSecretsStore.getSecret(key);
    let endpoint: string;
    let token: string;
    if (kept) {
      ({ endpoint, token } = JSON.parse(kept) as { endpoint: string; token: string });
    } else {
      const row = await requireRow(agent.id);
      if (!row.apiEndpoint || !agent.workspaceId)
        throw new Error(
          `The credentials of ${identity.slug} were not kept, and the agent has no Switch endpoint to fetch them for.`
        );
      log.warn(
        'agent-migration: the kept credentials are gone; revealing the agent’s key from Switch',
        {
          agentId: agent.id,
          switchAgentId: identity.switchAgentId,
        }
      );
      endpoint = row.apiEndpoint;
      token = await withReachableWorkspaceSession(agent.workspaceId, async (server) =>
        revealAgentApiKey(server, (await fetchAgentDetail(server, identity.switchAgentId)).name)
      );
    }
    const workdir = await resolveWorkdirFsFor(agent.sshHost, agent.dir);
    try {
      await writeNeutralAgentSettingsFs(workdir.fs, {
        slug: identity.slug,
        apiEndpoint: endpoint,
        apiToken: token,
        agentId: identity.switchAgentId,
        expectedAgentId: identity.switchAgentId,
      });
    } finally {
      workdir.close();
    }
    await encryptedAppSecretsStore.deleteSecret(key);
  },
};

async function subagentsOf(agent: MigrationAgent): Promise<SubagentRef[]> {
  const refs: SubagentRef[] = [];
  for (const subagent of await listAutoSessionSubagents()) {
    if (subagent.parentAgentId !== agent.id) continue;
    const switchAgentId = await identityInFile(agent, subagent.name);
    if (!switchAgentId) {
      log.warn('agent-migration: a watched subagent has no credentials file; it cannot move', {
        agentId: agent.id,
        subagent: subagent.name,
      });
      continue;
    }
    refs.push({ name: subagent.name, switchAgentId });
  }
  return refs;
}

async function parentOf(agent: MigrationAgent): Promise<MigrationAgent | null> {
  const row = await requireRow(agent.id);
  for (const subagent of await listAutoSessionSubagents()) {
    if (subagent.name !== agent.name || subagent.parentAgentId === agent.id) continue;
    const parent = await getAgentById(subagent.parentAgentId);
    if (parent && parent.locationId === row.locationId)
      return toMigrationAgent(parent, await getAgentLocation(parent));
  }
  return null;
}

async function buildDefinition(agent: MigrationAgent, subagent: SubagentRef | null) {
  const row = await requireRow(agent.id);
  const location = await getAgentLocation(row);
  const transport = locationTransport(location);
  const launch = await agentLaunchConfig(agent.id);
  const opened = await locationManager.openLocation(location);
  if (!opened.success)
    throw new Error(`Cannot read the location’s settings: ${JSON.stringify(opened.error)}`);
  const env = await resolveSessionEnv(
    { id: 'agent-migration', title: 'Room session' },
    { path: location.dir, fs: opened.data.fs },
    opened.data.settings
  );
  const selection = await hostDependencyStore.getSelection(
    transport.kind === 'ssh' ? transport.connectionId : 'local',
    agent.providerId
  );
  let subagentDefinition: { name: string; body: string | null } | null = null;
  if (subagent) {
    const repoAgents = getPlugin(agent.providerId).behavior.repoAgents;
    let body: string | null = null;
    if (repoAgents) {
      const workdir = await resolveWorkdirFsFor(agent.sshHost, agent.dir);
      try {
        const text = await workdir.fs.read(repoAgents.definitionPath(subagent.name));
        body = text === null ? null : definitionBody(text) || null;
      } finally {
        workdir.close();
      }
    }
    subagentDefinition = { name: subagent.name, body };
  }
  return buildManagedDefinition({
    providerId: agent.providerId,
    specialization: launch.specialization,
    providerDefinition: launch.definition !== undefined,
    autoApprove: row.autoApprove,
    directory: location.dir,
    stoppedByHand: (await listStoppedControllerAgentIds()).includes(agent.id),
    shellSetup: !!env.shellSetup,
    chosenBinary:
      selection?.kind === 'pinned'
        ? selection.realpath
        : selection?.kind === 'path'
          ? selection.path
          : null,
    subagentDefinition,
  });
}

export const agentMigrationService = new AgentMigrationService({
  agents: {
    get: migrationAgent,
    list: async () => {
      const agents: MigrationAgent[] = [];
      for (const agent of await getAgents())
        agents.push(toMigrationAgent(agent, await getAgentLocation(agent)));
      return agents;
    },
    subagentsOf,
    parentOf,
    stoppedByHand: async (agentId) => (await listStoppedControllerAgentIds()).includes(agentId),
  },
  definitions: { build: buildDefinition },
  targets: {
    resolve: (agent) => (agent.sshHost ? resolveSshHost(agent) : resolveThisComputer(agent)),
  },
  management,
  machine,
  credentials,
  store: {
    list: listManagedAgentRecords,
    get: getManagedAgentRecord,
    forIdentity: managedRecordFor,
    set: setManagedAgentRecord,
    delete: deleteManagedAgentRecord,
  },
  emit: (event) => events.emit(agentMigrationChannel, event),
  log: {
    info: (message, fields) => log.info(message, { event: 'agent_migration', ...fields }),
    warn: (message, fields) => log.warn(message, { event: 'agent_migration', ...fields }),
    error: (message, fields) => log.error(message, { event: 'agent_migration', ...fields }),
  },
  now: Date.now,
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
  pollMs: 2_000,
  turnWaitMs: 15 * 60_000,
  controllerStopWaitMs: 60_000,
});
