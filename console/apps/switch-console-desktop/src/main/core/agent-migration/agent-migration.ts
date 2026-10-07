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
    (probed?.kind === 'stopped' && probed.code === 3);
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
        : `${sshHost}’s controller is not running. Start it again from the host’s page.`
    );
  if (remote?.kind === 'error')
    return refuse(`Switch could not be asked about ${sshHost}’s controller: ${remote.message}`);
  if (remote?.kind === 'ok' && remote.controller?.state !== 'online')
    return refuse(
      `${sshHost}’s controller has not reached Switch yet. Wait until the host’s page shows it Running.`
    );
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
  startConsoleWatcher: async (agent) => {
    await autoSessionWatcher.bringUp(agent.id, 'explicit');
  },
  handoff: (agent, request) => runHandoff(machineScript(agent), request),
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
});

const AUTO_MIGRATION_INTERVAL_MS = 60_000;
let autoMigrationTimer: NodeJS.Timeout | null = null;

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
}

export function stopAutoMigration(): void {
  if (autoMigrationTimer) clearInterval(autoMigrationTimer);
  autoMigrationTimer = null;
}
