import { execFile } from 'node:child_process';
import { join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { resolveAgentControllerBundlePath } from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import { agentLaunchConfig } from '@main/core/agents/agent-launch-config';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { resolveWorkdirFsFor } from '@main/core/agents/agent-workdir-fs';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { deleteAgent } from '@main/core/agents/deleteAgent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { getAgents } from '@main/core/agents/getAgents';
import { agentSettingsRelativePath } from '@main/core/agents/switch-settings-paths';
import { writeNeutralAgentSettingsFs } from '@main/core/agents/write-switch-settings';
import { hostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import {
  embeddedControllerDataDir,
  embeddedControllerService,
} from '@main/core/embedded-controller/embedded-controllers';
import { featureFlagsService } from '@main/core/feature-flags/feature-flags';
import { hostControllerDataDir } from '@main/core/host-controllers/host-controller-service';
import { hostControllerService } from '@main/core/host-controllers/host-controllers';
import { locationManager } from '@main/core/locations/location-manager';
import { resolveSessionEnv } from '@main/core/locations/location-runtime-factory';
import { locationTransport } from '@main/core/locations/location-transport';
import { connectionHealth } from '@main/core/sdk-host/connection-health';
import { listHostSessionsFor } from '@main/core/sdk-host/host-sessions';
import { stopLocalSessionsOf } from '@main/core/sdk-host/local-host';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { listStoppedControllerAgentIds } from '@main/core/switch-rooms/auto-session-store';
import { autoSessionWatcher } from '@main/core/switch-rooms/auto-session-watcher';
import { parseSwitchAgentCredentials } from '@main/core/switch-rooms/switch-credentials';
import { postRoomMessage } from '@main/core/switch-rooms/switch-room-client';
import {
  AgentManagementUnavailableError,
  deleteManagedAgent,
  fetchAgentDetail,
  fetchManagedAgent,
  fetchManagementControllers,
  fetchMe,
  GatewayError,
  managementErrorMessage,
  putManagedAgent,
  revealAgentApiKey,
  setManagedAgentDesiredState,
  updateManagedAgent,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { withReachableWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { agentMigrationChannel } from '@shared/events/agentMigrationEvents';
import {
  AgentMigrationService,
  type MachineHealth,
  type MigrationAgent,
  type MigrationCredentialsPort,
  type MigrationMachinePort,
  type MigrationManagementPort,
  type TargetLookup,
} from './agent-migration-service';
import { deleteFiles, readFiles, stopWatchers } from './host-batch';
import {
  credentialsStashKey,
  deleteManagedAgentRecord,
  getManagedAgentRecord,
  listManagedAgentRecords,
  managedRecordFor,
  setManagedAgentRecord,
} from './managed-agents-store';
import { buildManagedDefinition } from './managed-definition';
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

/** A machine for a Switch server: this computer, or an SSH host. */
export type MachineRef = { serverId: string; workspaceId: string | null; sshHost: string | null };

/** Whether the machine can take a managed agent now, and the controller to place it on. */
export function resolveMachine(machine: MachineRef): Promise<TargetLookup> {
  return machine.sshHost
    ? resolveSshHost(machine.sshHost, machine.serverId, machine.workspaceId)
    : resolveThisComputer(machine.serverId, machine.workspaceId);
}

async function resolveThisComputer(
  serverId: string,
  workspaceId: string | null
): Promise<TargetLookup> {
  const overview = await embeddedControllerService.overview(serverId, workspaceId);
  const display = {
    kind: 'this-computer' as const,
    serverId,
    machineName: overview.enrollment?.name ?? null,
  };
  const revoked = overview.remote?.kind === 'ok' && overview.remote.controller?.state === 'revoked';
  const controller: TargetLookup['controller'] = overview.enrollment
    ? {
        controllerId: overview.enrollment.controllerId,
        state: revoked ? 'removed' : overview.phase.kind === 'running' ? 'running' : 'stopped',
      }
    : null;
  const refuse = (blocker: string, canEnable = false): TargetLookup => ({
    display,
    target: null,
    blocker,
    canEnable,
    controller,
  });
  if (overview.unsupportedReason) return refuse(overview.unsupportedReason);
  const remote = overview.remote;
  if (remote?.kind === 'unavailable')
    return refuse(
      'This server does not have agent management turned on, so it cannot run agents on machines.'
    );
  if (!overview.enrollment)
    return refuse(
      'Turn on “Run managed agents on this computer” for this server first: managed agents run on this computer’s controller.',
      remote?.kind === 'ok'
    );
  if (overview.phase.kind !== 'running')
    return refuse(
      `This computer’s controller is not running (${overview.phase.kind.replaceAll('_', ' ')}); Console starts it again on its next check.`
    );
  if (remote?.kind === 'error')
    return refuse(`Switch could not be asked about this computer’s controller: ${remote.message}`);
  if (remote?.kind === 'ok' && remote.controller?.state !== 'online')
    return refuse('This computer’s controller has not reached Switch yet.');
  const dataDir = embeddedControllerDataDir(serverId);
  return {
    display,
    target: {
      display,
      controllerId: overview.enrollment.controllerId,
      workspaceId: overview.enrollment.workspaceId,
      watcherRoot: (switchAgentId) => join(dataDir, 'watchers', switchAgentId),
    },
    blocker: null,
    canEnable: false,
    controller,
  };
}

async function resolveSshHost(
  sshHost: string,
  serverId: string,
  workspaceId: string | null
): Promise<TargetLookup> {
  const overview = await hostControllerService.overview(sshHost, serverId, workspaceId);
  const display = {
    kind: 'ssh-host' as const,
    sshHost,
    serverId,
    machineName: overview.enrollment?.name ?? null,
  };
  const probed = overview.process;
  const revoked =
    (overview.remote?.kind === 'ok' && overview.remote.controller?.state === 'revoked') ||
    (probed?.kind === 'stopped' && (probed.code === 3 || probed.code === 6));
  const controller: TargetLookup['controller'] = overview.enrollment
    ? {
        controllerId: overview.enrollment.controllerId,
        state: revoked
          ? 'removed'
          : probed?.kind === 'running'
            ? 'running'
            : probed?.kind === 'unknown'
              ? 'unknown'
              : 'stopped',
      }
    : null;
  const refuse = (blocker: string, canEnable = false): TargetLookup => ({
    display,
    target: null,
    blocker,
    canEnable,
    controller,
  });
  const remote = overview.remote;
  if (remote?.kind === 'unavailable')
    return refuse(
      'This server does not have agent management turned on, so it cannot run agents on machines.'
    );
  if (!overview.enrollment)
    return refuse(
      `Make ${sshHost} a machine for this server first: managed agents run on the agents controller Console installs there.`,
      remote?.kind === 'ok'
    );
  if (overview.phase.kind === 'installing' || overview.phase.kind === 'removing')
    return refuse(`${sshHost} is being set up or removed as a machine.`);
  if (overview.process?.kind !== 'running')
    return refuse(
      overview.process?.kind === 'unknown'
        ? `Console cannot tell whether ${sshHost}’s controller runs: ${overview.process.reason}`
        : `${sshHost}’s controller is not running; Console starts it again on its next check.`
    );
  if (remote?.kind === 'error')
    return refuse(`Switch could not be asked about ${sshHost}’s controller: ${remote.message}`);
  if (remote?.kind === 'ok' && remote.controller?.state !== 'online')
    return refuse(`${sshHost}’s controller has not reached Switch yet.`);
  const dataDir = hostControllerDataDir(serverId);
  return {
    display,
    target: {
      display,
      controllerId: overview.enrollment.controllerId,
      workspaceId: overview.enrollment.workspaceId,
      watcherRoot: (switchAgentId) => posix.join(dataDir, 'watchers', switchAgentId),
    },
    blocker: null,
    canEnable: false,
    controller,
  };
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
      let detail;
      try {
        detail = await fetchAgentDetail(server, switchAgentId);
      } catch (error) {
        if (error instanceof GatewayError && error.kind === 'http' && error.status === 404)
          return { management: true, owner: null, ownedByMe: false, gone: true };
        throw error;
      }
      const me = await fetchMe(server);
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
  place: async (workspaceId, switchAgentId, controllerId) => {
    try {
      await withReachableWorkspaceSession(workspaceId, (server) =>
        updateManagedAgent(server, switchAgentId, { definition: null, controllerId })
      );
    } catch (error) {
      throw managementFailure(
        'Switch did not place the agent on its machine’s new controller',
        error
      );
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

/** What a room is told when a move cuts the agent's turn there off. */
const TURN_CUT_NOTE =
  'Moved to a managed machine mid-task, so this request was cut off. Please send it again.';

const machine: MigrationMachinePort = {
  roomsMidTurn: async (agent) => {
    const busy = (await listHostSessionsFor(agent.id, [agent.switchAgentId!])).filter(
      (session) =>
        session.status !== 'stopped' &&
        session.connectivity === 'online' &&
        (session.status === 'running' || session.pendingRequestIds.length > 0)
    );
    if (!busy.length) return [];
    const { placements } = await connectionHealth(agent.serverId!);
    const rooms = new Set<string>();
    for (const session of busy) {
      const roomId = placements[session.sessionId];
      if (roomId) rooms.add(roomId);
    }
    return [...rooms];
  },
  tellTurnsCut: async (agent, roomIds) => {
    const relPath = agentSettingsRelativePath(agent.name);
    const workdir = await resolveWorkdirFsFor(agent.sshHost, agent.dir);
    let raw: string | null;
    try {
      raw = await workdir.fs.read(relPath);
    } finally {
      workdir.close();
    }
    const creds = raw === null ? null : parseSwitchAgentCredentials(raw, credentialsLog);
    if (!creds)
      return roomIds.map((roomId) => ({
        roomId,
        reason: `${relPath} holds no Switch credentials to post with.`,
      }));
    const untold: { roomId: string; reason: string }[] = [];
    for (const roomId of roomIds)
      try {
        await postRoomMessage(creds, roomId, TURN_CUT_NOTE);
      } catch (error) {
        untold.push({ roomId, reason: error instanceof Error ? error.message : String(error) });
      }
    return untold;
  },
  stopConsoleWatcher: async (agent) => {
    await autoSessionWatcher.stopForAgent(agent.id);
    // On an SSH host a session is the sidecar watcher's child and stopped
    // with it; here Console supervises each one itself.
    if (agent.sshHost) return;
    await stopLocalSessionsOf(agent.switchAgentId!);
  },
  stopConsoleWatchers: async (agents) => {
    const outcomes = new Map<string, string | null>();
    const first = agents[0];
    if (!first) return outcomes;
    if (!first.sshHost) {
      for (const agent of agents)
        try {
          await machine.stopConsoleWatcher(agent);
          outcomes.set(agent.id, null);
        } catch (error) {
          outcomes.set(agent.id, error instanceof Error ? error.message : String(error));
        }
      return outcomes;
    }
    for (const agent of agents) autoSessionWatcher.forgetRetries(agent.id);
    const stopped = await stopWatchers(
      machineScript(first),
      agents.map((agent) => agent.switchAgentId!),
      { waitMs: 20_000, killWaitMs: 5_000 }
    );
    for (const agent of agents)
      outcomes.set(
        agent.id,
        agent.switchAgentId! in stopped
          ? (stopped[agent.switchAgentId!] ?? null)
          : 'The host did not report on its watcher.'
      );
    return outcomes;
  },
  startConsoleWatcher: async (agent) => {
    await autoSessionWatcher.bringUp(agent.id, 'explicit');
  },
  handoff: (agent, request) => runHandoff(machineScript(agent), request),
};

const credentialsLog = { warn: (...input: unknown[]) => log.warn('agent-migration:', ...input) };

/**
 * Keeps the token of an agent's credentials file in the encrypted secrets
 * store, refusing a file that is incomplete or names another agent. The
 * caller removes the file once this returns.
 */
async function keepCredentials(
  agent: MigrationAgent,
  identity: { slug: string; switchAgentId: string },
  raw: string
): Promise<void> {
  const relPath = agentSettingsRelativePath(identity.slug);
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
}

const credentials: MigrationCredentialsPort = {
  stash: async (agent, identity) => {
    const relPath = agentSettingsRelativePath(identity.slug);
    const workdir = await resolveWorkdirFsFor(agent.sshHost, agent.dir);
    try {
      const raw = await workdir.fs.read(relPath);
      if (raw === null) return false;
      await keepCredentials(agent, identity, raw);
      await workdir.fs.delete(relPath);
      return true;
    } finally {
      workdir.close();
    }
  },
  stashMany: async (items) => {
    const outcomes = new Map<string, boolean | Error>();
    const first = items[0];
    if (!first) return outcomes;
    if (!first.agent.sshHost) {
      for (const { agent, identity } of items)
        try {
          outcomes.set(agent.id, await credentials.stash(agent, identity));
        } catch (error) {
          outcomes.set(agent.id, error instanceof Error ? error : new Error(String(error)));
        }
      return outcomes;
    }
    const run = machineScript(first.agent);
    const pathOf = (item: (typeof items)[number]) =>
      posix.join(item.agent.dir, agentSettingsRelativePath(item.identity.slug));
    const files = await readFiles(run, items.map(pathOf));
    const kept: string[] = [];
    for (const item of items) {
      const raw = files[pathOf(item)] ?? null;
      if (raw === null) {
        outcomes.set(item.agent.id, false);
        continue;
      }
      try {
        await keepCredentials(item.agent, item.identity, raw);
        kept.push(pathOf(item));
        outcomes.set(item.agent.id, true);
      } catch (error) {
        outcomes.set(item.agent.id, error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (kept.length) await deleteFiles(run, kept);
    return outcomes;
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

async function buildDefinition(agent: MigrationAgent) {
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
  return buildManagedDefinition({
    providerId: agent.providerId,
    name: agent.name,
    specialization: launch.specialization,
    providerDefinition: launch.definition,
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
  });
}

let localControllerProtocol: Promise<string> | null = null;

/** The controller protocol this Console's agents controller speaks, as the bundle reports it. */
function controllerProtocol(): Promise<string> {
  localControllerProtocol ??= execute(
    process.execPath,
    [resolveAgentControllerBundlePath(), '--protocol'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15_000 }
  ).then(({ stdout }) => {
    const protocol = stdout.trim();
    if (!protocol) throw new Error('The agents controller did not report its protocol.');
    return protocol;
  });
  localControllerProtocol.catch(() => {
    localControllerProtocol = null;
  });
  return localControllerProtocol;
}

/**
 * Why the server cannot take this Console's controller, or null when it can.
 * A server that does not speak the controller's protocol refuses every call
 * it makes, enrollment first, with HTTP 426.
 */
async function controllerRefusal(serverId: string): Promise<string | null> {
  const server = await getServer(serverId);
  if (!server) throw new Error('Console no longer knows this Switch server.');
  const protocol = await controllerProtocol();
  const response = await fetch(`${server.apiUrl}/v1/management/controllers/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Switch-Controller-Protocol': protocol },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 426) return null;
  const accepts = response.headers.get('switch-controller-protocol-accepts');
  return `${server.name} accepts agents controller protocol ${accepts ?? 'older than this Console’s'}, but this Console’s controller speaks ${protocol}. Upgrade the server to move agents onto it.`;
}

/** Repairs the controller an agent's machine runs for its server; see `AgentMigrationDeps.targets.heal`. */
async function healMachine(agent: MigrationAgent): Promise<MachineHealth> {
  const serverId = agent.serverId!;
  const refusal = await controllerRefusal(serverId);
  if (refusal) return { kind: 'incompatible', reason: refusal };
  if (agent.sshHost) {
    const sshHost = agent.sshHost;
    const record = await hostControllerService.record(sshHost, serverId);
    if (!record) return { kind: 'not-set-up' };
    const overview = await hostControllerService.overview(sshHost, serverId, record.workspaceId);
    const { process: running, remote } = overview;
    if (running?.kind === 'unknown')
      throw new Error(
        `Console cannot tell whether ${sshHost}’s controller runs: ${running.reason}`
      );
    if (remote?.kind === 'error')
      throw new Error(`Switch could not be asked about ${sshHost}’s controller: ${remote.message}`);
    const gone =
      (remote?.kind === 'ok' &&
        (remote.controller === null || remote.controller.state === 'revoked')) ||
      (running?.kind === 'stopped' && (running.code === 3 || running.code === 6));
    if (gone) {
      log.warn('Switch revoked or forgot an SSH host’s controller; enrolling it again', {
        event: 'agent_migration',
        sshHost,
        serverId,
        controllerId: record.controllerId,
      });
      await hostControllerService.enrollAgain(sshHost, serverId);
      return { kind: 'changed' };
    }
    const outdated = await hostControllerService.outdated(record);
    if (running?.kind !== 'running' || outdated) {
      log.info('Starting an SSH host’s controller again', {
        event: 'agent_migration',
        sshHost,
        serverId,
        reason: outdated ? 'older build' : 'not running',
      });
      await hostControllerService.restart(sshHost, serverId);
      return { kind: 'changed' };
    }
    return { kind: 'unchanged' };
  }
  const overview = await embeddedControllerService.overview(serverId, agent.workspaceId);
  if (overview.unsupportedReason)
    return { kind: 'incompatible', reason: overview.unsupportedReason };
  if (!overview.enrollment) return { kind: 'not-set-up' };
  const remote = overview.remote;
  if (remote?.kind === 'error')
    throw new Error(
      `Switch could not be asked about this computer’s controller: ${remote.message}`
    );
  if (
    remote?.kind === 'ok' &&
    (remote.controller === null || remote.controller.state === 'revoked')
  ) {
    log.warn('Switch revoked or forgot this computer’s controller; enrolling it again', {
      event: 'agent_migration',
      serverId,
      controllerId: overview.enrollment.controllerId,
    });
    await embeddedControllerService.enrollAgain(serverId);
    return { kind: 'changed' };
  }
  if (overview.phase.kind === 'taken_over')
    throw new Error(
      'Another copy of this computer’s controller connected to Switch and took over, so this one is not started again.'
    );
  if (overview.phase.kind === 'update_required')
    throw new Error(
      'This Switch server needs a newer agents controller than this Console carries. Update Switch Console, then try again.'
    );
  if (overview.phase.kind !== 'running' && overview.phase.kind !== 'restarting') {
    await embeddedControllerService.restart(serverId);
    return { kind: 'changed' };
  }
  return { kind: 'unchanged' };
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
    stoppedByHand: async (agentId) => (await listStoppedControllerAgentIds()).includes(agentId),
    forget: (agentId) =>
      deleteAgent(agentId, {
        deleteInSwitch: false,
        removeProvisionedFiles: false,
        trigger: 'server_teardown',
      }),
  },
  definitions: { build: buildDefinition },
  targets: {
    resolve: (agent) =>
      resolveMachine({
        serverId: agent.serverId!,
        workspaceId: agent.workspaceId,
        sshHost: agent.sshHost,
      }),
    enable: async (agent) => {
      if (!agent.serverId || !agent.workspaceId)
        throw new Error(`${agent.name} is not on a Switch workspace.`);
      if (agent.sshHost)
        await hostControllerService.enable(agent.sshHost, agent.serverId, agent.workspaceId);
      else await embeddedControllerService.enable(agent.serverId, agent.workspaceId);
    },
    heal: (agent) => healMachine(agent),
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
  sleep: (ms) => delay(ms),
  pollMs: 2_000,
  controllerStopWaitMs: 60_000,
  machineReadyWaitMs: 180_000,
  unmanageableRecheckMs: 15 * 60_000,
  minRetryMs: 60_000,
  maxRetryMs: 15 * 60_000,
  healIntervalMs: 5 * 60_000,
});

const AUTO_MIGRATION_INTERVAL_MS = 60_000;
let autoMigrationTimer: NodeJS.Timeout | null = null;
// Agents asked about while their server had agent management off are not asked
// again for a while; a server turning it on is the moment to ask at once.
let stopFollowingFlags: (() => void) | null = null;

function migrateEverythingLogged(): void {
  agentMigrationService.migrateEverything().catch((error: unknown) => {
    log.error('The automatic move to managed agents failed', {
      event: 'agent_migration',
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Moves every agent that can be managed onto a controller, now and then every
 * minute, so agents created, linked or brought online later move too.
 */
export function startAutoMigration(): void {
  if (autoMigrationTimer) return;
  migrateEverythingLogged();
  autoMigrationTimer = setInterval(migrateEverythingLogged, AUTO_MIGRATION_INTERVAL_MS);
  stopFollowingFlags = featureFlagsService.subscribe((state) => {
    if (!state.flags.agent_management) return;
    agentMigrationService.recheckAll();
    migrateEverythingLogged();
  });
}

export function stopAutoMigration(): void {
  if (autoMigrationTimer) clearInterval(autoMigrationTimer);
  autoMigrationTimer = null;
  stopFollowingFlags?.();
  stopFollowingFlags = null;
}
