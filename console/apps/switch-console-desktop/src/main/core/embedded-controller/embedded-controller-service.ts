import { MovedAgentsHereError } from '@shared/core/agent-migration/agent-migration';
import type {
  EmbeddedControllerEnrollment,
  EmbeddedControllerOverview,
  EmbeddedControllerPhase,
  EmbeddedControllerRemote,
  EmbeddedControllerStateEvent,
} from '@shared/core/embedded-controller/embedded-controller';
import {
  credentialSecretKey,
  type EnrollmentRecord,
  type EnrollmentRecords,
} from './controller-files';
import {
  type ControllerBackoff,
  type ControllerLaunch,
  type ControllerLogLevel,
  ControllerSupervisor,
  type SpawnController,
} from './controller-supervisor';

export type ControllerPlatform = { os: string; arch: string; os_version: string };

/** The server side, through the signed-in session of a workspace. */
export interface ManagementPort {
  /** Enrolls this Console in the workspace; says which server and agent bridge that is. */
  enroll(
    workspaceId: string,
    body: { name: string; platform: ControllerPlatform; version: string }
  ): Promise<{ serverId: string; apiUrl: string; controllerId: string; credential: string }>;
  /** The controller's state and the agents placed on it; with no controller, only whether management is there. */
  read(workspaceId: string, controllerId: string | null): Promise<EmbeddedControllerRemote>;
  /** Revokes it. `already_gone` when the server no longer knows it. */
  revoke(workspaceId: string, controllerId: string): Promise<'revoked' | 'already_gone'>;
}

export interface SecretsPort {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export interface ControllerFilesPort {
  dataDir(serverId: string): string;
  turnOffWatchers(dataDir: string): Promise<number>;
  wipeIdentity(dataDir: string): Promise<void>;
}

export type ServiceLog = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

export type EmbeddedControllerDeps = {
  platform: NodeJS.Platform;
  /** This machine as it enrolls: its host name and platform. */
  machine: () => { name: string; platform: ControllerPlatform };
  records: EnrollmentRecords;
  /** The server's API URL as Console has it now, or null for a server Console no longer knows. */
  serverApiUrl: (serverId: string) => Promise<string | null>;
  secrets: SecretsPort;
  management: ManagementPort;
  files: ControllerFilesPort;
  bundles: { controller: () => string; sharedHost: () => string };
  /** The controller bundle's own version (`--version`), which also proves it runs here. */
  controllerVersion: (bundle: string) => Promise<string>;
  spawn: SpawnController;
  /** The binary the controller runs on: Electron's, as Node. */
  execPath: string;
  env: () => NodeJS.ProcessEnv;
  emit: (event: EmbeddedControllerStateEvent) => void;
  log: ServiceLog;
  /** Where the controller's own log lines go. */
  controllerLine: (serverId: string, level: ControllerLogLevel, line: string) => void;
  now: () => number;
  backoff: ControllerBackoff;
  /** How long a revoked controller is given to stop its agents and exit by itself. */
  revokeGraceMs: number;
  /** How long a controller asked to stop (SIGTERM) is given before SIGKILL. */
  stopTimeoutMs: number;
  /** The Console agents moved onto this computer's controller for the server, by name. */
  movedAgents: (serverId: string) => Promise<string[]>;
};

export const WINDOWS_UNSUPPORTED =
  'Managed agents run through the shared host, which needs macOS or Linux. This computer runs Windows.';

type Runner = { supervisor: ControllerSupervisor; phase: EmbeddedControllerPhase };

/**
 * "Run managed agents on this computer", per signed-in Switch server: enrolls
 * this Console as an agents controller of kind `console`, keeps its credential
 * in the encrypted secrets store, and runs the agent-controller CLI as a
 * child process for as long as it is on.
 *
 * Agents created in Console itself are not involved: only the managed agents
 * the server places on this machine run through it.
 */
export class EmbeddedControllerService {
  private readonly runners = new Map<string, Runner>();
  /** Phases of servers with no runner: enrolling, stopping, removed, a failure before a start. */
  private readonly phases = new Map<string, EmbeddedControllerPhase>();
  /** Servers with an enable or disable in flight, so two cannot interleave. */
  private readonly busy = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: EmbeddedControllerDeps) {}

  get unsupportedReason(): string | null {
    return this.deps.platform === 'win32' ? WINDOWS_UNSUPPORTED : null;
  }

  /** Starts the controller of every server this Console is enrolled with. */
  async initialize(): Promise<void> {
    const records = await this.deps.records.all();
    for (const [serverId, record] of Object.entries(records)) {
      if (record.kind === 'removed') {
        this.setPhase(serverId, { kind: 'removed', at: record.at });
        continue;
      }
      if (this.unsupportedReason) {
        this.setPhase(serverId, { kind: 'error', message: this.unsupportedReason });
        continue;
      }
      this.startRunner(serverId);
    }
  }

  async overview(
    serverId: string,
    workspaceId: string | null
  ): Promise<EmbeddedControllerOverview> {
    const record = await this.deps.records.get(serverId);
    const enrollment = record?.kind === 'enrolled' ? enrollmentOf(record) : null;
    const askIn = enrollment?.workspaceId ?? workspaceId;
    const [remote, movedAgents] = await Promise.all([
      askIn ? this.deps.management.read(askIn, enrollment?.controllerId ?? null) : null,
      this.deps.movedAgents(serverId),
    ]);
    return {
      serverId,
      unsupportedReason: this.unsupportedReason,
      enrollment,
      phase: this.phaseOf(serverId, record),
      remote,
      movedAgents,
    };
  }

  /** Turns it on: enrolls through the signed-in session of `workspaceId`, then starts the controller. */
  async enable(serverId: string, workspaceId: string): Promise<void> {
    if (this.unsupportedReason) throw new Error(this.unsupportedReason);
    await this.exclusive(serverId, async () => {
      const existing = await this.deps.records.get(serverId);
      if (existing?.kind === 'enrolled')
        throw new Error('This computer already runs managed agents for this server.');
      this.setPhase(serverId, { kind: 'enrolling' });
      try {
        const bundle = this.deps.bundles.controller();
        this.deps.bundles.sharedHost();
        const version = await this.deps.controllerVersion(bundle);
        const machine = this.deps.machine();
        const enrolled = await this.deps.management.enroll(workspaceId, {
          name: machine.name,
          platform: machine.platform,
          version,
        });
        if (enrolled.serverId !== serverId) {
          await this.revokeQuietly(workspaceId, enrolled.controllerId);
          throw new Error('That workspace belongs to another server.');
        }
        try {
          await this.deps.secrets.setSecret(credentialSecretKey(serverId), enrolled.credential);
          await this.deps.files.wipeIdentity(this.deps.files.dataDir(serverId));
          await this.deps.records.set(serverId, {
            kind: 'enrolled',
            controllerId: enrolled.controllerId,
            server: enrolled.apiUrl,
            name: machine.name,
            workspaceId,
            enrolledAt: new Date(this.deps.now()).toISOString(),
          });
        } catch (error) {
          // Enrolled but not kept: revoke it rather than leave a machine nobody can run.
          await this.deps.secrets.deleteSecret(credentialSecretKey(serverId)).catch(() => {});
          await this.revokeQuietly(workspaceId, enrolled.controllerId);
          throw error;
        }
        this.deps.log.info('Enrolled this computer as an agents controller', {
          serverId,
          controllerId: enrolled.controllerId,
        });
      } catch (error) {
        this.setPhase(serverId, { kind: 'off' });
        throw error;
      }
      this.phases.delete(serverId);
      this.startRunner(serverId);
    });
  }

  /**
   * Turns it off: revokes the controller on the server, lets it stop its
   * agents and exit, then forgets the credential and the identity. A revoke
   * the server refuses leaves everything running, and says why. Refused, with
   * nothing changed, while it runs agents moved from this Console: Switch
   * keeps an agent on its controller after the controller is removed, where
   * nothing would run it.
   */
  async disable(serverId: string): Promise<void> {
    const moved = await this.deps.movedAgents(serverId);
    if (moved.length)
      throw new MovedAgentsHereError(
        `This computer runs ${moved.join(', ')} for this Console. Bring them back with Stop managing (or Bring all back) before turning it off.`,
        moved
      );
    await this.turnOff(serverId);
  }

  private async turnOff(serverId: string): Promise<void> {
    await this.exclusive(serverId, async () => {
      const record = await this.deps.records.get(serverId);
      if (record?.kind !== 'enrolled') {
        await this.forget(serverId);
        return;
      }
      const before = this.phaseOf(serverId, record);
      this.setRunnerPhase(serverId, { kind: 'stopping' });
      try {
        const outcome = await this.deps.management.revoke(record.workspaceId, record.controllerId);
        if (outcome === 'already_gone')
          this.deps.log.warn('The server no longer knew this computer’s controller', {
            serverId,
            controllerId: record.controllerId,
          });
      } catch (error) {
        this.setRunnerPhase(serverId, before);
        throw error;
      }
      await this.retire(serverId);
      await this.forget(serverId);
      this.deps.log.info('This computer no longer runs managed agents for the server', {
        serverId,
      });
    });
  }

  /** Starts a controller that stopped for good (an error, or another copy took over) again. */
  async restart(serverId: string): Promise<void> {
    const record = await this.deps.records.get(serverId);
    if (record?.kind !== 'enrolled')
      throw new Error('This computer is not enrolled to run managed agents for this server.');
    if (this.unsupportedReason) throw new Error(this.unsupportedReason);
    const runner = this.runners.get(serverId);
    if (runner?.supervisor.running) return;
    if (runner) runner.supervisor.start();
    else this.startRunner(serverId);
  }

  /**
   * The server's API URL changed in Console. A controller that is running, or
   * waiting to start again, is stopped and started with the new `--server`,
   * which also moves the identity in its data directory to it. One that is
   * off, or stopped for good, takes the new URL when it next starts.
   */
  async followServerApiUrl(serverId: string): Promise<void> {
    const runner = this.runners.get(serverId);
    if (!runner || this.disposed || this.busy.has(serverId)) return;
    if (runner.phase.kind !== 'running' && runner.phase.kind !== 'restarting') return;
    this.deps.log.info('The server’s API URL changed; restarting this computer’s controller', {
      serverId,
    });
    await runner.supervisor.stop(this.deps.stopTimeoutMs);
    if (this.disposed || this.runners.get(serverId) !== runner) return;
    runner.supervisor.start();
  }

  /** Clears the "removed from Switch" notice. */
  async dismiss(serverId: string): Promise<void> {
    const record = await this.deps.records.get(serverId);
    if (record?.kind !== 'removed') return;
    await this.deps.records.delete(serverId);
    this.setPhase(serverId, { kind: 'off' });
  }

  /**
   * The server is being removed from Console: turn it off, and if the server
   * cannot be told, stop and forget it here anyway. The controller then stays
   * listed on the server until someone removes it there.
   */
  async forgetServer(serverId: string): Promise<void> {
    try {
      await this.turnOff(serverId);
    } catch (error) {
      this.deps.log.warn(
        'Could not revoke this computer’s controller while removing its server; remove it from the Machines page',
        { serverId, error: error instanceof Error ? error.message : String(error) }
      );
      await this.retire(serverId);
      await this.forget(serverId);
    }
    this.phases.delete(serverId);
  }

  /** Stops every controller (SIGTERM) at quit, and with it its agents and their sessions. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(
      [...this.runners.values()].map((runner) => runner.supervisor.stop(this.deps.stopTimeoutMs))
    );
  }

  private startRunner(serverId: string): void {
    if (this.disposed) return;
    const runner: Runner = {
      phase: { kind: 'off' },
      supervisor: new ControllerSupervisor({
        spawn: this.deps.spawn,
        launch: () => this.launchFor(serverId),
        onPhase: (phase) => this.setRunnerPhase(serverId, phase),
        onFinal: (exit) => void this.onFinal(serverId, exit),
        onLine: (level, line) => this.deps.controllerLine(serverId, level, line),
        now: this.deps.now,
        backoff: this.deps.backoff,
      }),
    };
    this.runners.set(serverId, runner);
    this.phases.delete(serverId);
    runner.supervisor.start();
  }

  private async launchFor(serverId: string): Promise<ControllerLaunch> {
    const record = await this.followedRecord(serverId);
    let credential: string | null;
    try {
      credential = await this.deps.secrets.getSecret(credentialSecretKey(serverId));
    } catch (error) {
      throw new Error(
        `The credential for this computer could not be read: ${error instanceof Error ? error.message : String(error)} Turn it off and on again to enroll afresh.`
      );
    }
    if (!credential)
      throw new Error(
        'The credential for this computer is missing. Turn it off and on again to enroll afresh.'
      );
    return {
      executable: this.deps.execPath,
      args: [
        this.deps.bundles.controller(),
        'run',
        '--data-dir',
        this.deps.files.dataDir(serverId),
        '--controller-id',
        record.controllerId,
        '--server',
        record.server,
        '--name',
        record.name,
        '--credential-stdin',
        '--shared-host-bundle',
        this.deps.bundles.sharedHost(),
      ],
      env: {
        ...this.deps.env(),
        ELECTRON_RUN_AS_NODE: '1',
        SWITCH_CONTROLLER_LOG_LEVEL: 'info',
      },
      credential,
    };
  }

  /**
   * The enrollment, at the server's API URL as it is now. The URL a controller
   * was enrolled at is not where it must connect for ever: an edited server
   * moves it, and so does a managed stack started on other ports.
   */
  private async followedRecord(
    serverId: string
  ): Promise<Extract<EnrollmentRecord, { kind: 'enrolled' }>> {
    const record = await this.deps.records.get(serverId);
    if (record?.kind !== 'enrolled')
      throw new Error('This computer is not enrolled to run managed agents for this server.');
    const apiUrl = await this.deps.serverApiUrl(serverId);
    if (apiUrl === null)
      throw new Error(
        'Console no longer knows this Switch server, so it cannot say where to connect.'
      );
    if (apiUrl === record.server) return record;
    const moved = { ...record, server: apiUrl };
    await this.deps.records.set(serverId, moved);
    this.deps.log.info('This computer’s controller follows its server to a new API URL', {
      serverId,
      from: record.server,
      to: apiUrl,
    });
    return moved;
  }

  private async onFinal(serverId: string, exit: 'revoked' | 'taken_over'): Promise<void> {
    if (exit === 'taken_over') {
      this.deps.log.error(
        'Another copy of this computer’s controller connected to Switch and took over; not restarting it',
        { serverId }
      );
      this.setRunnerPhase(serverId, {
        kind: 'taken_over',
        at: new Date(this.deps.now()).toISOString(),
      });
      return;
    }
    if (this.busy.has(serverId)) return;
    const record = await this.deps.records.get(serverId);
    const at = new Date(this.deps.now()).toISOString();
    this.deps.log.warn('Switch removed this computer as a machine; forgetting its credential', {
      serverId,
    });
    this.runners.delete(serverId);
    try {
      await this.deps.secrets.deleteSecret(credentialSecretKey(serverId));
      const dataDir = this.deps.files.dataDir(serverId);
      await this.deps.files.turnOffWatchers(dataDir);
      await this.deps.files.wipeIdentity(dataDir);
      if (record?.kind === 'enrolled')
        await this.deps.records.set(serverId, {
          kind: 'removed',
          controllerId: record.controllerId,
          at,
        });
      this.setPhase(serverId, { kind: 'removed', at });
    } catch (error) {
      this.setPhase(serverId, {
        kind: 'error',
        message: `Switch removed this computer, but its local state could not be cleared: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /** Lets a revoked controller stop its agents and exit; stops it if it does not, and turns its watchers off. */
  private async retire(serverId: string): Promise<void> {
    const runner = this.runners.get(serverId);
    this.runners.delete(serverId);
    if (runner && !(await runner.supervisor.release(this.deps.revokeGraceMs))) {
      this.deps.log.warn('The revoked controller did not exit by itself; stopping it', {
        serverId,
      });
      await runner.supervisor.stop(this.deps.stopTimeoutMs);
    }
    const turnedOff = await this.deps.files.turnOffWatchers(this.deps.files.dataDir(serverId));
    if (turnedOff > 0)
      this.deps.log.info('Turned off the managed agents’ watchers', { serverId, turnedOff });
  }

  private async forget(serverId: string): Promise<void> {
    await this.deps.secrets.deleteSecret(credentialSecretKey(serverId));
    await this.deps.files.wipeIdentity(this.deps.files.dataDir(serverId));
    await this.deps.records.delete(serverId);
    this.setPhase(serverId, { kind: 'off' });
  }

  private async revokeQuietly(workspaceId: string, controllerId: string): Promise<void> {
    try {
      await this.deps.management.revoke(workspaceId, controllerId);
    } catch (error) {
      this.deps.log.error(
        'Could not revoke a controller this computer enrolled but could not keep; remove it from the Machines page',
        { controllerId, error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  private async exclusive(serverId: string, task: () => Promise<void>): Promise<void> {
    if (this.busy.has(serverId))
      throw new Error('This computer is already being turned on or off for this server.');
    this.busy.add(serverId);
    try {
      await task();
    } finally {
      this.busy.delete(serverId);
    }
  }

  private phaseOf(serverId: string, record: EnrollmentRecord | null): EmbeddedControllerPhase {
    const runner = this.runners.get(serverId);
    if (runner) return runner.phase;
    const phase = this.phases.get(serverId);
    if (phase) return phase;
    if (record?.kind === 'removed') return { kind: 'removed', at: record.at };
    return { kind: 'off' };
  }

  private setRunnerPhase(serverId: string, phase: EmbeddedControllerPhase): void {
    const runner = this.runners.get(serverId);
    if (!runner) return this.setPhase(serverId, phase);
    runner.phase = phase;
    this.deps.emit({ serverId, phase });
  }

  private setPhase(serverId: string, phase: EmbeddedControllerPhase): void {
    if (phase.kind === 'off') this.phases.delete(serverId);
    else this.phases.set(serverId, phase);
    this.deps.emit({ serverId, phase });
  }
}

function enrollmentOf(
  record: Extract<EnrollmentRecord, { kind: 'enrolled' }>
): EmbeddedControllerEnrollment {
  return {
    controllerId: record.controllerId,
    name: record.name,
    workspaceId: record.workspaceId,
    enrolledAt: record.enrolledAt,
  };
}
