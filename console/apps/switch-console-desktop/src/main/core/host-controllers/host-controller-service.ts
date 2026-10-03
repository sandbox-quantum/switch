import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type {
  HostControllerEnrollment,
  HostControllerOverview,
  HostControllerPhase,
  HostControllerProcess,
  HostControllerRemote,
  HostControllerStateEvent,
  HostSupervision,
} from '@shared/core/host-controllers/host-controllers';
import {
  ENROLL_SCRIPT,
  enrollResultSchema,
  MIN_NODE,
  nodeIsNewEnough,
  PREPARE_SCRIPT,
  type PrepareResult,
  prepareResultSchema,
  START_SCRIPT,
  STATUS_SCRIPT,
  statusResultSchema,
  STOP_SCRIPT,
  SUPERVISOR_SCRIPT,
  systemdUnit,
} from './host-scripts';

/** What Console keeps about a host's controller. Nothing secret: the credential stays on the host. */
export type HostControllerRecord = {
  sshHost: string;
  serverId: string;
  controllerId: string;
  workspaceId: string;
  name: string;
  supervision: HostSupervision;
  /** The controller's data directory on the host, `~/`-relative. */
  dataDir: string;
  /** The controller bundle and shared-host bundle it runs, absolute on the host. */
  bundle: string;
  sharedHost: string;
  /** The host's Node, and the PATH the controller finds provider CLIs on. */
  node: string;
  path: string;
  enrolledAt: string;
};

export interface HostControllerRecords {
  all(): Promise<HostControllerRecord[]>;
  get(sshHost: string, serverId: string): Promise<HostControllerRecord | null>;
  set(record: HostControllerRecord): Promise<void>;
  delete(sshHost: string, serverId: string): Promise<void>;
}

/** A connection to the host: `node -e` there, and a file copied there. */
export interface HostShell {
  script(script: string, args: string[]): Promise<string>;
  upload(localPath: string, remotePath: string): Promise<void>;
  close(): void;
}

export interface HostManagementPort {
  /** A one-time enrollment code, through the signed-in session of the workspace. */
  enrollmentCode(workspaceId: string): Promise<string>;
  /** The server's agent bridge URL as Console has it, or null for a server it no longer knows. */
  serverApiUrl(serverId: string): Promise<string | null>;
  read(workspaceId: string, controllerId: string | null): Promise<HostControllerRemote>;
  revoke(workspaceId: string, controllerId: string): Promise<'revoked' | 'already_gone'>;
}

export type HostControllerLog = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

export type HostControllerDeps = {
  shell: (sshHost: string) => Promise<HostShell>;
  records: HostControllerRecords;
  management: HostManagementPort;
  bundles: {
    /** This build's controller bundle, and its SHA-256. */
    controller: () => Promise<{ path: string; hash: string }>;
    /** This build's shared-host bundle on the host, deployed if it is not there. */
    sharedHost: (sshHost: string) => Promise<string>;
  };
  /** The Console agents moved onto this host's controller for the server, by name. */
  movedAgents: (sshHost: string, serverId: string) => Promise<string[]>;
  emit: (event: HostControllerStateEvent) => void;
  log: HostControllerLog;
  now: () => number;
};

/** Where the controller keeps its state on the host, for one server. */
export function hostControllerDataDir(serverId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(serverId) || serverId.includes('..'))
    throw new Error(`The server id '${serverId}' cannot name a directory.`);
  return `~/.local/state/switch/agent-controller/console-${serverId}`;
}

export function hostControllerUnit(serverId: string): string {
  return `switch-agent-controller-${serverId}.service`;
}

/** The controller connects over https, or plain http to a loopback address only. */
export function serverUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${url} is not a URL.`;
  }
  if (parsed.protocol === 'https:') return null;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'http:' && loopback) return null;
  return `The agents controller connects to Switch only over https (or plain http to the host itself), and this server's address is ${url}.`;
}

function key(sshHost: string, serverId: string): string {
  return JSON.stringify([sshHost, serverId]);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseLast<T>(stdout: string, parse: (value: unknown) => T): T {
  return parse(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));
}

/**
 * An SSH host as a machine, per Switch server: installs the headless agents
 * controller there next to the shared-host bundle, enrolls it with a one-time
 * code Console fetches through its own signed-in session, and keeps it
 * running — under a systemd user unit where one can outlive Console's SSH
 * session (lingering on), otherwise under a detached supervisor of the same
 * kind the sidecar runs under. Turning it off revokes it first.
 */
export class HostControllerService {
  private readonly phases = new Map<string, HostControllerPhase>();

  constructor(private readonly deps: HostControllerDeps) {}

  async overview(
    sshHost: string,
    serverId: string,
    workspaceId: string | null
  ): Promise<HostControllerOverview> {
    const record = await this.deps.records.get(sshHost, serverId);
    const askIn = record?.workspaceId ?? workspaceId;
    const [process, remote, movedAgents] = await Promise.all([
      record ? this.process(record) : Promise.resolve(null),
      askIn
        ? this.deps.management.read(askIn, record?.controllerId ?? null)
        : Promise.resolve(null),
      this.deps.movedAgents(sshHost, serverId),
    ]);
    return {
      sshHost,
      serverId,
      enrollment: record ? enrollmentOf(record) : null,
      phase: this.phases.get(key(sshHost, serverId)) ?? { kind: 'off' },
      process,
      remote,
      movedAgents,
    };
  }

  /** The record of an enrolled host, for whoever places agents on it. */
  record(sshHost: string, serverId: string): Promise<HostControllerRecord | null> {
    return this.deps.records.get(sshHost, serverId);
  }

  /** Whether the controller process runs on the host now. */
  async process(record: HostControllerRecord): Promise<HostControllerProcess> {
    let shell: HostShell;
    try {
      shell = await this.deps.shell(record.sshHost);
    } catch (error) {
      return { kind: 'unknown', reason: message(error) };
    }
    try {
      const status = parseLast(
        await shell.script(STATUS_SCRIPT, [
          JSON.stringify({
            supervision: record.supervision,
            unit: hostControllerUnit(record.serverId),
            dataDir: record.dataDir,
          }),
        ]),
        (value) => statusResultSchema.parse(value)
      );
      return status.running
        ? { kind: 'running' }
        : { kind: 'stopped', state: status.state, code: status.code, log: status.log };
    } catch (error) {
      return { kind: 'unknown', reason: message(error) };
    } finally {
      shell.close();
    }
  }

  /** Installs, enrolls and starts the controller on the host, for the server. */
  async enable(sshHost: string, serverId: string, workspaceId: string): Promise<void> {
    await this.exclusive(sshHost, serverId, async () => {
      if (await this.deps.records.get(sshHost, serverId))
        throw new Error(`${sshHost} already runs managed agents for this server.`);
      this.setPhase(sshHost, serverId, { kind: 'installing', step: 'Checking the host…' });
      const server = await this.deps.management.serverApiUrl(serverId);
      if (server === null) throw new Error('Console no longer knows this Switch server.');
      const urlProblem = serverUrlProblem(server);
      if (urlProblem) throw new Error(urlProblem);
      const shell = await this.deps.shell(sshHost);
      let enrolled: HostControllerRecord | null = null;
      try {
        const { prepared, bundle } = await this.deploy(shell, sshHost, serverId);
        this.setPhase(sshHost, serverId, { kind: 'installing', step: 'Enrolling the host…' });
        const code = await this.deps.management.enrollmentCode(workspaceId);
        const dataDir = hostControllerDataDir(serverId);
        const outcome = parseLast(
          await shell.script(ENROLL_SCRIPT, [
            JSON.stringify({
              node: prepared.execPath,
              bundle,
              server,
              code,
              name: prepared.hostname,
              dataDir,
            }),
          ]),
          (value) => enrollResultSchema.parse(value)
        );
        if (!outcome.ok) throw new Error(`The host could not be enrolled: ${outcome.reason}`);
        if (!outcome.controllerId)
          throw new Error('The controller enrolled, but did not say which controller it is.');
        enrolled = {
          sshHost,
          serverId,
          controllerId: outcome.controllerId,
          workspaceId,
          name: prepared.hostname,
          supervision: prepared.systemd ? 'systemd' : 'detached',
          dataDir,
          bundle,
          sharedHost: await this.deps.bundles.sharedHost(sshHost),
          node: prepared.execPath,
          path: prepared.path,
          enrolledAt: new Date(this.deps.now()).toISOString(),
        };
        await this.deps.records.set(enrolled);
        this.setPhase(sshHost, serverId, { kind: 'installing', step: 'Starting the controller…' });
        await this.start(shell, enrolled, prepared.home);
        this.deps.log.info('Installed the agents controller on an SSH host', {
          sshHost,
          serverId,
          controllerId: enrolled.controllerId,
          supervision: enrolled.supervision,
        });
      } catch (error) {
        if (enrolled) await this.abandon(shell, enrolled);
        throw error;
      } finally {
        shell.close();
      }
    });
  }

  /** Starts the controller again, on this build's bundle; its agents keep running meanwhile. */
  async restart(sshHost: string, serverId: string): Promise<void> {
    await this.exclusive(sshHost, serverId, async () => {
      const record = await this.deps.records.get(sshHost, serverId);
      if (!record) throw new Error(`${sshHost} does not run managed agents for this server.`);
      this.setPhase(sshHost, serverId, { kind: 'installing', step: 'Starting the controller…' });
      const shell = await this.deps.shell(sshHost);
      try {
        const { prepared, bundle } = await this.deploy(shell, sshHost, serverId);
        await this.stopOn(shell, record, { turnOff: false, wipe: false });
        const updated: HostControllerRecord = {
          ...record,
          bundle,
          sharedHost: await this.deps.bundles.sharedHost(sshHost),
          node: prepared.execPath,
          path: prepared.path,
          supervision: prepared.systemd ? 'systemd' : 'detached',
        };
        await this.deps.records.set(updated);
        await this.start(shell, updated, prepared.home);
      } finally {
        shell.close();
      }
    });
  }

  /**
   * Revokes the controller in Switch, then stops it on the host, turns off the
   * agents it ran and removes its identity there. A revoke Switch refuses
   * changes nothing. With `force`, a host that cannot be reached after the
   * revoke is forgotten anyway: revoked, its controller stops its agents and
   * exits as soon as it hears.
   */
  async disable(sshHost: string, serverId: string, options: { force: boolean }): Promise<void> {
    await this.exclusive(sshHost, serverId, async () => {
      const record = await this.deps.records.get(sshHost, serverId);
      if (!record) return;
      const moved = await this.deps.movedAgents(sshHost, serverId);
      if (moved.length)
        throw new Error(
          `${sshHost} runs ${moved.join(', ')} for this Console. Bring them back with Stop managing (or Bring all back) first.`
        );
      this.setPhase(sshHost, serverId, { kind: 'removing' });
      const outcome = await this.deps.management.revoke(record.workspaceId, record.controllerId);
      if (outcome === 'already_gone')
        this.deps.log.warn('Switch no longer knew the controller on an SSH host', {
          sshHost,
          serverId,
        });
      try {
        const shell = await this.deps.shell(sshHost);
        try {
          await this.stopOn(shell, record, { turnOff: true, wipe: true });
        } finally {
          shell.close();
        }
      } catch (error) {
        if (!options.force)
          throw new Error(
            `The controller on ${sshHost} was removed from Switch, but could not be cleaned up on the host: ${message(error)} Turn it off again once the host is reachable.`,
            { cause: error }
          );
        this.deps.log.warn('Could not clean up a revoked controller on an unreachable host', {
          sshHost,
          serverId,
          error: message(error),
        });
      }
      await this.deps.records.delete(sshHost, serverId);
      this.deps.log.info('Removed the agents controller from an SSH host', { sshHost, serverId });
    });
  }

  /** The host is being removed from Console: its controllers go first. */
  async forgetHost(sshHost: string): Promise<void> {
    for (const record of await this.deps.records.all())
      if (record.sshHost === sshHost) await this.disable(sshHost, record.serverId, { force: true });
  }

  private async deploy(
    shell: HostShell,
    sshHost: string,
    serverId: string
  ): Promise<{ prepared: PrepareResult; bundle: string }> {
    const local = await this.deps.bundles.controller();
    const bundleName = `agent-controller-${local.hash}.mjs`;
    const prepared = parseLast(
      await shell.script(PREPARE_SCRIPT, [JSON.stringify({ bundleName, hash: local.hash })]),
      (value) => prepareResultSchema.parse(value)
    );
    if (!nodeIsNewEnough(prepared.node))
      throw new Error(
        `${sshHost} runs Node ${prepared.node}; the agents controller needs Node ${MIN_NODE.join('.')} or later on the host.`
      );
    const bundle = posix.join(prepared.directory, bundleName);
    if (!prepared.present) {
      this.setPhase(sshHost, serverId, { kind: 'installing', step: 'Copying the controller…' });
      // Under a temporary name and renamed into place, so nothing starts from half a file.
      const temporary = `${bundle}.${randomUUID()}.tmp`;
      await shell.upload(local.path, temporary);
      await shell.script("require('node:fs').renameSync(process.argv[1],process.argv[2])", [
        temporary,
        bundle,
      ]);
    }
    return { prepared, bundle };
  }

  private async start(shell: HostShell, record: HostControllerRecord, home: string): Promise<void> {
    const absolute = (path: string) =>
      path.startsWith('~/') ? posix.join(home, path.slice(2)) : path;
    const args = {
      node: record.node,
      bundle: record.bundle,
      dataDir: record.dataDir,
      sharedHost: record.sharedHost,
      path: record.path,
    };
    await shell.script(START_SCRIPT, [
      JSON.stringify({
        supervision: record.supervision,
        unit: hostControllerUnit(record.serverId),
        unitText: systemdUnit({
          description: `Switch agents controller (Switch Console, server ${record.serverId})`,
          node: record.node,
          bundle: record.bundle,
          dataDir: absolute(record.dataDir),
          sharedHost: record.sharedHost,
          path: record.path,
        }),
        supervisor: SUPERVISOR_SCRIPT,
        args,
      }),
    ]);
  }

  private async stopOn(
    shell: HostShell,
    record: HostControllerRecord,
    options: { turnOff: boolean; wipe: boolean }
  ): Promise<void> {
    await shell.script(STOP_SCRIPT, [
      JSON.stringify({
        supervision: record.supervision,
        unit: hostControllerUnit(record.serverId),
        dataDir: record.dataDir,
        ...options,
      }),
    ]);
  }

  /** Enrolled but not running: revoke it rather than leave a machine nobody runs. */
  private async abandon(shell: HostShell, record: HostControllerRecord): Promise<void> {
    try {
      await this.deps.management.revoke(record.workspaceId, record.controllerId);
    } catch (error) {
      this.deps.log.error(
        'Could not revoke a controller enrolled on an SSH host that could not be started; remove it from the Machines page',
        { sshHost: record.sshHost, controllerId: record.controllerId, error: message(error) }
      );
    }
    try {
      await this.stopOn(shell, record, { turnOff: true, wipe: true });
    } catch (error) {
      this.deps.log.error('Could not clean up a controller that could not be started', {
        sshHost: record.sshHost,
        error: message(error),
      });
    }
    await this.deps.records.delete(record.sshHost, record.serverId);
  }

  private async exclusive(sshHost: string, serverId: string, task: () => Promise<void>) {
    const id = key(sshHost, serverId);
    const current = this.phases.get(id);
    if (current && current.kind !== 'error')
      throw new Error(`${sshHost} is already being set up or removed for this server.`);
    try {
      await task();
      this.phases.delete(id);
    } catch (error) {
      this.phases.set(id, { kind: 'error', message: message(error) });
      throw error;
    } finally {
      this.deps.emit({ sshHost, serverId });
    }
  }

  private setPhase(sshHost: string, serverId: string, phase: HostControllerPhase): void {
    this.phases.set(key(sshHost, serverId), phase);
    this.deps.emit({ sshHost, serverId });
  }
}

function enrollmentOf(record: HostControllerRecord): HostControllerEnrollment {
  return {
    controllerId: record.controllerId,
    name: record.name,
    workspaceId: record.workspaceId,
    supervision: record.supervision,
    enrolledAt: record.enrolledAt,
  };
}
