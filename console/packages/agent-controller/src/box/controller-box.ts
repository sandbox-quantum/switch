import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { OpenAgentStream } from '@switch-console/agent-providers';
import {
  BoxValve,
  boxCap,
  boxLimitFromEnv,
  CAP_HEADROOM,
  CONTROLLER_RESTING_BYTES,
  type RestartNotice,
  SESSION_ALLOWANCE_BYTES,
  startReserveFromEnv,
  type ValveEvent,
} from '@switch-console/agent-providers/box';
import type { AgentHub } from '../agent-hub';
import type { ControllerClient } from '../api';
import type { FrontLogin } from '../controller';
import { ConfigurationError } from '../errors';
import type { HostTickets } from '../host-tickets';
import type { HubSocket } from '../hub-socket';
import { errorCode, errorMessage, type Logger } from '../log';
import { type DataLayout, dataLayout } from '../paths';
import {
  CREDENTIAL_RESTART_WAIT_MS,
  CredentialRestarts,
  definitionProblem,
  type ReconcileDeps,
  startAgent,
} from '../reconcile';
import type { AgentRuntime } from '../runtime';
import type { Assignment } from '../schemas';
import type { GivenLogin } from '../sealed-logins';
import { noSessionMidTurn, type ProviderStatuses, type StatusCollector } from '../status';
import { LeftoverWatch } from './agent-removal';
import { AgentsDisk } from './agents-disk';
import { readBoxMemory } from './box-memory';
import { valveLimits } from './controller-reserve';
import {
  type GatewayDeps,
  gatewayEnvironment,
  gatewayProbe,
  resolveGateway,
} from './gateway-agents';
import { gatewayPlanFor, VertexTokenCache } from './gateway-logins';
import { DailyCallCap, dailyCalls, usageFile } from './gateway-usage';
import { boxHubValve } from './hub-valve';
import type { LauncherLink, LinkState } from './launcher-link';
import type { LauncherMeasure } from './launcher-measure';
import type { LauncherRunner } from './launcher-runner';
import { LiveEvents, teeLogger } from './live-events';
import { gatherLiveExtras, LiveStatusWriter } from './live-status';
import type { LoginCheck } from './login-check';
import { readMeminfo } from './meminfo';
import { MemorySourceCheck } from './memory-source-check';
import type { OwnerMarkers } from './owner-marker';
import { connectionIsHost } from './peer-check';
import { ProviderGateway } from './provider-gateway';
import { AgentRest, type SweepResult } from './rest';
import { readSplitBoxMemory } from './split-memory';
import type { LaunchGate, ProbeEnv } from './split-runtime';

/**
 * What only a hosted agents box's controller does, on top of the controller
 * every machine runs (`runController`). Loaded only in box mode, through a
 * dynamic import, so desktop and v1 never load it: the box valve, resting
 * agents, the provider gateway, the split box's launcher link
 * and the live status. `runController` calls it at fixed points; each call is
 * where the box copy of the controller did the same inline.
 */

/** Split mode: how often a controller that couldn't listen for the launcher tries the same address again. */
export const LAUNCHER_LISTEN_RETRY_MS = 10_000;
/** When a given login whose sign-in check could not run is tried again: four tries, backing off. */
export const UNCHECKED_RETRY_MS = [15_000, 30_000, 60_000, 120_000] as const;

/** What a box's `main` gives its controller beyond what every controller gets. */
export type BoxControllerDeps = {
  /**
   * How long an agent's sessions must all be parked before its agent host is
   * stopped until its next message; null or absent, agents never rest.
   */
  restAfterMs?: number | null;
  /**
   * Where to write the live status (`status --live`) every few seconds:
   * counts and states only. Null or absent, it is not written.
   */
  liveStatusDir?: string | null;
  /** The box image's digest, for the live status (`SWITCH_IMAGE_DIGEST`); null when unknown. */
  imageDigest?: string | null;
  /**
   * Bytes kept back for the controller under the box's memory limit
   * (`controllerReserveFromEnv`): the box valve's memory lines work to the
   * limit less this, while its cap stays on the whole limit. 0 or absent, none.
   */
  controllerReserve?: number;
  /**
   * Front given logins through the provider gateway: the agents' CLIs get a
   * local base URL and an opaque token, never the login. Off by default.
   */
  providerGateway?: boolean;
  /**
   * With the gateway: the operator's daily cap on provider calls, as the
   * setting gives it (`gateway-usage.ts`). Unset, empty or 0, none; anything
   * but a whole number stops the controller.
   */
  providerGatewayDailyCalls?: string;
  /**
   * Ends what a stopped agent left running, with proof it is the agent's (the
   * ownership marker); absent, nothing is swept.
   */
  sweepAgent?: (agentId: string) => Promise<SweepResult>;
  /**
   * The owner markers that prove whose a process is: the box valve's proof
   * that a hub connection is the agent's own host, and the live status's
   * counts. Absent, no connection is proved and the valve serves none.
   */
  ownerMarkers?: OwnerMarkers;
  /**
   * A login given to the machine, checked with its provider once the CLI signs
   * in with it: a Vertex AI login asks Google for a token (`login-check.ts`).
   * Absent: the CLI's sign-in check is the whole check.
   */
  checkGivenLogin?: LoginCheck;
  /**
   * On a split box the controller runs as its own user: every agent host runs
   * in the agents container through the launcher. The controller listens on
   * `link`, mints a one-time ticket for every host hello, and measures and
   * hears its heartbeat (`measure`). Silence means stop: while the
   * launcher is quiet nothing is admitted and idle sessions park; while lost,
   * nothing starts.
   */
  split?: {
    link: LauncherLink;
    tickets: HostTickets;
    measure: LauncherMeasure;
    runner: Pick<LauncherRunner, 'launchOf' | 'currentLaunch'>;
    gate: LaunchGate;
    /** Given the gateway's probe once it is up, so a login's sign-in check goes through it. */
    setProbeEnv?: (probeEnv: ProbeEnv | undefined) => void;
    /**
     * Test boxes only (the template marks the box; `main` refuses it
     * otherwise): an operator's exec into the agents container is left
     * running and counted, not ended as a stranger. Shown in status.
     */
    operatorExec?: boolean;
  };
  /** The waits before each new try of a given login whose sign-in check could not run (`UNCHECKED_RETRY_MS`). */
  uncheckedRetryMs?: readonly number[];
  /** Split mode: the wait before trying the launcher listener's address again (`LAUNCHER_LISTEN_RETRY_MS`). */
  launcherListenRetryMs?: number;
};

/** What the box needs of the controller it runs in, read as it goes. */
export type BoxContext = {
  log: Logger;
  now: () => number;
  dataDir: string;
  /** The assignment the controller holds now. */
  assignment: () => Assignment | null;
  /** Ask for a status report. */
  report: () => void;
  /** Reconcile the held assignment again, locally. */
  reconcileLocally: () => Promise<void>;
  /** Run a task on the controller's one queue. */
  run: <T>(task: () => Promise<T>) => Promise<T>;
  /** A failure, handled as the controller handles any. */
  failed: (what: string, error: unknown) => void;
  /** True once the controller is stopping. */
  stopping: () => boolean;
};

/**
 * Whether the provider gateway can front a given login. One it can't even read
 * (a malformed Vertex AI login) counts as frontable here, so the usual sign-in
 * check meets it and says what is wrong, as before.
 */
export function frontable(login: GivenLogin, gateway: Pick<GatewayDeps, 'vertex'>): boolean {
  try {
    return gatewayPlanFor(login, gateway.vertex) !== null;
  } catch {
    return true;
  }
}

export class BoxController {
  /** The controller's logger, teed into the live status's event counts when it is written. */
  readonly log: Logger;
  readonly layout: DataLayout;
  readonly valve: BoxValve;
  readonly credentialRestarts = new CredentialRestarts();
  readonly leftovers = new LeftoverWatch();
  private readonly liveEvents: LiveEvents | null;
  private readonly split: BoxControllerDeps['split'];
  private readonly sourceCheck: MemorySourceCheck;
  private readonly cap: ReturnType<typeof boxCap> | null;
  /** The box's memory limit, as the valve takes it; null where none is set. */
  private readonly boxLimit: number | null;
  private readonly dailyCallCap: number;
  private rest: AgentRest | null = null;
  private gateway: GatewayDeps | null = null;
  private dailyCap: DailyCallCap | null = null;
  private agentsDisk: AgentsDisk | null = null;
  private liveStatus: LiveStatusWriter | null = null;
  private hubSocket: HubSocket | null = null;
  private runtime: AgentRuntime | null = null;
  private providers: ProviderStatuses | null = null;
  /** Split mode only: true while the controller can't listen for the launcher (fail closed). */
  private launcherUnavailable = false;
  /** A restarted agents container not yet looked at afresh: no admits until it has. */
  private splitSettling = false;
  /** When the assignment was last pulled from Switch, for the live status. */
  private lastSyncAt: number | null = null;
  private openValve: () => void = () => {};
  private readonly valveReady: Promise<void>;
  private stopValve: () => void = () => {};
  private stopLinkTicks: () => void = () => {};
  private uncheckedTry = 0;
  private uncheckedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: BoxControllerDeps,
    private readonly ctx: BoxContext
  ) {
    this.liveEvents = deps.liveStatusDir ? new LiveEvents(ctx.now) : null;
    this.log = this.liveEvents ? teeLogger(ctx.log, this.liveEvents) : ctx.log;
    this.dailyCallCap = 0;
    if (deps.providerGateway) {
      try {
        this.dailyCallCap = dailyCalls(deps.providerGatewayDailyCalls);
      } catch (error) {
        throw new ConfigurationError(errorMessage(error));
      }
    }
    this.split = deps.split;
    this.layout = dataLayout(ctx.dataDir);
    const log = this.log;
    const split = this.split;
    const valveLog = {
      info: (line: string) => log.info(line),
      warn: (line: string) => log.warn(line),
    };
    const boxLimit = boxLimitFromEnv(process.env, valveLog);
    this.boxLimit = boxLimit;
    // The cap stays on the box's whole limit (it already allows for the
    // controller at rest); only the memory lines move down by the reserve.
    const reserve = boxLimit === null ? 0 : (deps.controllerReserve ?? 0);
    const limits = valveLimits(boxLimit, reserve);
    // Split boxes: the reading must see the whole pod (meminfo, not the cgroup).
    this.sourceCheck = new MemorySourceCheck({
      split: split !== undefined,
      launcherTotal: () => split?.measure.totalBytes() ?? null,
      log,
    });
    const sourceCheck = this.sourceCheck;
    this.cap = limits === null ? null : boxCap(limits.capLimit, process.env, valveLog);
    const cap = this.cap;
    this.valve = new BoxValve({
      limit: limits === null ? null : limits.lineLimit,
      readUsage: async () => {
        // A split box reads /proc/meminfo only: its cgroup is the controller's own container.
        const reading = await (split ? readSplitBoxMemory() : readBoxMemory());
        sourceCheck.observe(reading);
        // On a split box a cgroup-only reading is no reading: the valve fails closed.
        return sourceCheck.usable(reading);
      },
      ...(cap ? { cap: cap.cap } : {}),
      ...(boxLimit === null ? {} : { startReserve: startReserveFromEnv(process.env, valveLog) }),
      // A resting agent is left alone: not parked, counted or admitted.
      isHeld: (agentId) => this.rest?.state(agentId)?.kind === 'resting',
      // Wait-list changes, counted for the live status only when it is on.
      ...(this.liveEvents
        ? { onEvent: (event: ValveEvent) => this.liveEvents?.noteValve(event) }
        : {}),
      // Split boxes: nothing starts while the launcher can't measure, or before a
      // restarted agents container has been looked at afresh.
      ...(split ? { admitting: () => split.link.current === 'live' && !this.splitSettling } : {}),
      log: valveLog,
    });
    if (cap && boxLimit !== null)
      log.info('Box valve on', {
        limitBytes: boxLimit,
        reserveBytes: reserve,
        restingBytes: CONTROLLER_RESTING_BYTES,
        headroomPercent: Math.round(CAP_HEADROOM * 100),
        sessionAllowanceBytes: SESSION_ALLOWANCE_BYTES,
        envBound: cap.bound,
        formula: cap.formula,
        cap: cap.cap,
      });
    // Hosts join the valve only once the controller has placed its agents (`beforeFirstReconcile`).
    this.valveReady = new Promise<void>((resolve) => {
      this.openValve = resolve;
    });
  }

  // -- The agent hub -------------------------------------------------------

  /** What the box adds to the agent hub's deps: rest's wakes, and the reset lines Switch posts. */
  hubDeps(client: ControllerClient, hub: () => AgentHub) {
    return {
      onWake: (agentId: string, why: Parameters<AgentRest['wake']>[1]) =>
        this.rest?.wake(agentId, why),
      onAddressedTaken: (agentId: string, event: Parameters<AgentRest['addressedTaken']>[1]) =>
        this.rest?.addressedTaken(agentId, event),
      now: this.ctx.now,
      resetRefused: (agentId: string, notice: Parameters<ControllerClient['resetRefused']>[1]) =>
        client.resetRefused(agentId, notice),
      // A reset kept for a resting agent that will not reach a host after all
      // gets the "couldn't reset" line, like one with no host or session.
      onHeldCommandDropped: (
        agentId: string,
        roomId: string,
        command: Parameters<AgentHub['refuseReset']>[2]
      ) => hub().refuseReset(agentId, roomId, command),
    };
  }

  /** Each agent host's stream, carrying the box valve. */
  openStream(hub: AgentHub): (agentId: string) => OpenAgentStream {
    return (agentId) =>
      Object.assign((streamDeps: Parameters<OpenAgentStream>[0]) => hub.open(agentId, streamDeps), {
        boxValve: this.valve,
      });
  }

  /** Posts an agent's restart line through this controller, keyed by its turn. */
  restartNotice(client: ControllerClient): (agentId: string) => RestartNotice {
    return (agentId) => (notice) => client.restartNotice(agentId, notice);
  }

  /** The runtime agents run in, once the controller has built it. */
  setRuntime(runtime: AgentRuntime): void {
    this.runtime = runtime;
  }

  /** What the box adds to the hub socket: the valve over the hub, and a split box's tickets. */
  hubSocketDeps() {
    const split = this.split;
    const log = this.log;
    const runtime = this.requireRuntime();
    return {
      box: true,
      valve: boxHubValve({
        valve: this.valve,
        ready: this.valveReady,
        // Proved from /proc by the owner markers; with none, nothing is proved.
        trusted: async (agentId: string, peerPort: number, localPort: number) => {
          const markers = this.deps.ownerMarkers;
          return markers
            ? connectionIsHost(
                agentId,
                this.layout.watcherRoot(agentId),
                peerPort,
                localPort,
                markers
              )
            : false;
        },
        share: () => this.valveShare(),
      }),
      tickets: split?.tickets,
      currentLaunch: split ? (agentId: string) => split.runner.currentLaunch(agentId) : undefined,
      onTicketTaken: split ? (agentId: string) => split.gate.taken(agentId) : undefined,
      // Only a minted ticket refused as spent or another agent's counts
      // towards failure; anything else is a relaunch after a backoff.
      onTicketRefused: split
        ? (agentId: string, reason: string) => {
            if (split.runner.currentLaunch(agentId) === null) return; // nothing of ours to relaunch
            if (reason === 'spent' || reason === 'wrong_agent') {
              const burnt = split.gate.burn(agentId);
              if (burnt === 'failed') {
                log.error(
                  'An agent’s launch tickets kept being refused: it is failed until changed',
                  { agentId }
                );
                void runtime.stop(agentId, { wait: false, asked: false }).catch(() => {});
                this.ctx.report();
                return;
              }
              this.relaunchSplitHost(agentId, burnt);
              return;
            }
            this.relaunchSplitHost(agentId, split.gate.delay(agentId));
          }
        : undefined,
      // A living host whose hub dropped needs a fresh ticket to reconnect: only the controller mints one.
      onTicketedClosed: split
        ? (agentId: string) => {
            const launchId = split.runner.launchOf(agentId);
            if (launchId === null || split.link.current === 'lost') return;
            const ticket = split.tickets.mint(agentId, launchId);
            void split.link.order({ kind: 'ticket', agentId, launchId, ticket }).then((reply) => {
              if (!reply.ok) {
                split.tickets.forget(agentId);
                log.warn('Could not send an agent host a fresh hub ticket', {
                  agentId,
                  code: reply.code ?? 'failed',
                });
              }
            });
          }
        : undefined,
    };
  }

  /** The hub socket, kept for the status's joined-hosts count. */
  setHubSocket(hubSocket: HubSocket): void {
    this.hubSocket = hubSocket;
  }

  // -- Placing agents, and the gateway ---------------------------------------

  /** After the relay: the provider gateway, when it is on. */
  async startGateway(): Promise<void> {
    if (!this.deps.providerGateway) return;
    // Kept whether or not a cap is set: the day's calls count from the start.
    this.dailyCap = new DailyCallCap({
      cap: this.dailyCallCap,
      file: usageFile(join(this.ctx.dataDir, 'gateway-usage.json')),
      log: this.log,
      now: this.ctx.now,
    });
    this.gateway = {
      gateway: new ProviderGateway({ log: this.log, cap: this.dailyCap }),
      vertex: new VertexTokenCache(),
    };
    await this.gateway.gateway.start();
    this.log.info('Provider gateway listening for this machine’s agents', {
      endpoint: this.gateway.gateway.endpoint,
    });
    // Split boxes: a given login's sign-in check runs in the agents container
    // with a short-lived gateway probe token, never the login.
    const split = this.split;
    if (split) {
      const fronting = this.gateway;
      split.setProbeEnv?.(async (_provider, login) => gatewayProbe(randomUUID(), login, fronting));
    }
  }

  /** The gateway, for an agent's credentials; null when it is off. */
  gatewayDeps(): GatewayDeps | null {
    return this.gateway;
  }

  /**
   * How the gateway fronts an agent's login when it is on; undefined when it
   * is off. A login it can't front is not used at all, and said once.
   */
  frontLogin(): FrontLogin | undefined {
    const gateway = this.gateway;
    if (!gateway) return undefined;
    const said = new Set<string>();
    return (agentId, login, saved) => {
      const fronted = resolveGateway(agentId, login, saved, gateway);
      if (fronted.refused && login) {
        const key = `${agentId}:${login.provider}:${login.revision}`;
        if (!said.has(key)) {
          said.add(key);
          this.log.warn('A given login is not used: the provider gateway cannot front it', {
            agentId,
            provider: login.provider,
            kind: login.kind,
          });
        }
      }
      return fronted;
    };
  }

  // -- Providers, status and reconciling -------------------------------------

  /** What the box adds to the provider statuses: only a login the gateway can front, and the given-login check. */
  providerDeps(): {
    usable?: (login: GivenLogin) => boolean;
    checkLogin?: LoginCheck;
  } {
    const gateway = this.gateway;
    return {
      ...(gateway ? { usable: (login: GivenLogin) => frontable(login, gateway) } : {}),
      ...(this.deps.checkGivenLogin ? { checkLogin: this.deps.checkGivenLogin } : {}),
    };
  }

  setProviders(providers: ProviderStatuses): void {
    this.providers = providers;
  }

  /** What the box adds to the status collector. */
  collectorDeps(hub: AgentHub): Partial<ConstructorParameters<typeof StatusCollector>[0]> {
    const split = this.split;
    // Split boxes: the agents' volume is the box's disk, and only the launcher mounts it.
    this.agentsDisk = split
      ? new AgentsDisk({ ask: () => split.link.order({ kind: 'disk' }), now: this.ctx.now })
      : null;
    const agentsDisk = this.agentsDisk;
    return {
      rest: (agentId) => this.rest?.state(agentId) ?? null,
      streamCarries: (agentId) => hub.streamCarries(agentId),
      onAgentAwake: (agentId, awake) => this.valve.noteHealth(agentId, awake),
      onAgentsSeen: (agentIds) => this.valve.keepHealthOnly(agentIds),
      sessionsMax: () => (Number.isFinite(this.valve.cap) ? this.valve.cap : 0),
      valveHosts: () => (this.valve.enabled ? (this.hubSocket?.valveHosts() ?? null) : null),
      // No launcher listener means no host can start, and nothing is protected: reported as such.
      valveMemory: () =>
        this.launcherUnavailable
          ? 'unprotected'
          : (this.valve.memoryProblem ?? this.sourceCheck.problem),
      boxCounts: () => ({ valveParks: this.valve.enabled ? this.valve.parks : null }),
      gatewayCounts: () =>
        this.gateway
          ? { ...this.gateway.gateway.counts(), ...(this.dailyCap ? this.dailyCap.counts() : {}) }
          : null,
      operatorExec: split?.operatorExec === true,
      meminfo: readMeminfo,
      ...(agentsDisk ? { disk: () => agentsDisk.reading() } : {}),
    };
  }

  /** What the box adds to reconciling: credential restarts, the gateway, removal and rest. */
  reconcileDeps(): Partial<ReconcileDeps> {
    const gateway = this.gateway;
    const runtime = this.requireRuntime();
    return {
      credentialRestarts: this.credentialRestarts,
      ...(gateway
        ? {
            gatewayEnv: async (agentId: string, login: GivenLogin) =>
              gatewayEnvironment(login, (await runtime.readCredentials(agentId))?.gateway, gateway),
          }
        : {}),
      removal: { layout: this.layout, log: this.log, leftovers: this.leftovers },
      rest: {
        suspended: (agentId) => this.rest?.suspended(agentId) ?? false,
        clear: (agentId) => this.rest?.clear(agentId),
      },
    };
  }

  /** An agent forgotten: the gateway forgets its token too. */
  forgetAgent(agentId: string): void {
    this.gateway?.gateway.forget(agentId);
  }

  /** Rest: made once the reconcile deps exist. */
  startRest(input: {
    hub: AgentHub;
    client: ControllerClient;
    reconcileDeps: ReconcileDeps;
  }): void {
    const { hub, client, reconcileDeps } = input;
    const runtime = this.requireRuntime();
    const log = this.log;
    this.rest = new AgentRest({
      hub,
      observe: (agentId) => runtime.observe(agentId),
      stopHost: (agentId) => runtime.stop(agentId, { wait: true }),
      sweep:
        this.deps.sweepAgent ?? (async () => ({ signalled: 0, killed: 0, gone: 0, notProven: 0 })),
      start: async (agentId) => {
        const entry = this.ctx
          .assignment()
          ?.agents.find((candidate) => candidate.agent_id === agentId);
        if (
          !entry ||
          entry.desired_state !== 'running' ||
          definitionProblem(entry, reconcileDeps.offered)
        )
          return null;
        return startAgent(
          {
            kind: 'start',
            agentId,
            entry,
            restart: false,
            replaceIdentity: false,
            clearTakenOver: false,
            // Not a restart: a wake is not counted in `restarts_10m`.
            relaunch: false,
            why: 'a message for an agent whose host was stopped until its next message',
          },
          reconcileDeps
        );
      },
      run: (task) => this.ctx.run(task),
      restAfterMs: this.deps.restAfterMs ?? null,
      now: this.ctx.now,
      log,
      onChange: () => this.ctx.report(),
      restNotice: (agentId, notice) => client.restNotice(agentId, notice),
    });
  }

  // -- Syncing ---------------------------------------------------------------

  /** A pull from Switch failed: proves nothing missing, so leftovers wait for two good ones. */
  fetchFailed(): void {
    this.leftovers.fetchFailed();
  }

  /** A pull from Switch answered; `pulled` when the assignment changed. */
  pulled(before: Assignment | null, pulled: Assignment | null): void {
    this.lastSyncAt = this.ctx.now();
    // Split boxes: an agent its owner changed is no longer failed for burnt tickets.
    if (this.split && pulled)
      for (const entry of pulled.agents) {
        const was = before?.agents.find((a) => a.agent_id === entry.agent_id);
        if (was && was.revision !== entry.revision) this.split.gate.clear(entry.agent_id);
      }
  }

  /** Restarted by its owner through Switch: started now, not on its next message. */
  restartAsked(agentId: string): void {
    this.rest?.clear(agentId);
  }

  /**
   * A hint that a chat with the agent opened. Its host stopped until it is
   * needed is woken instead, and its first message starts the session; true
   * when that was done, so the controller doesn't warm it too.
   */
  wokeForWarm(agentId: string): boolean {
    if (!this.rest?.suspended(agentId)) return false;
    this.rest.wake(agentId, 'warm');
    return true;
  }

  // -- The status report -----------------------------------------------------

  /** The live status, when it is written. */
  private live(runtime: AgentRuntime): LiveStatusWriter | null {
    if (!this.deps.liveStatusDir) return null;
    this.liveStatus ??= new LiveStatusWriter({
      dir: this.deps.liveStatusDir,
      startedAt: this.ctx.now(),
      now: this.ctx.now,
      gather: (agentIds) =>
        gatherLiveExtras({
          agentIds,
          markers: this.deps.ownerMarkers ?? null,
          layout: this.layout,
          health: async (agentId) => {
            const health = (await runtime.observe(agentId)).health;
            return health?.current ? health : null;
          },
        }),
      events: () => this.liveEvents?.snapshot() ?? { events: [], droppedBefore: null },
      warn: (message, fields) => this.log.warn(message, fields),
    });
    return this.liveStatus;
  }

  /** Each report collected: the live status is written from it. */
  async collected(report: Awaited<ReturnType<StatusCollector['collect']>>): Promise<void> {
    const live = this.live(this.requireRuntime());
    if (!live) return;
    await live.observe({
      report,
      assigned: (this.ctx.assignment()?.agents ?? []).map((entry) => ({
        agentId: entry.agent_id,
        desired: entry.desired_state === 'running' ? 'running' : 'stopped',
      })),
      restKind: (agentId) => this.rest?.state(agentId)?.kind ?? null,
      hubHosts: this.hubSocket?.hosts() ?? new Map(),
      valve: this.valve.status(),
      formulaCap: this.cap?.formula ?? null,
      memoryLimit: this.boxLimit,
      restAfterMs: this.deps.restAfterMs ?? null,
      lastSyncAt: this.lastSyncAt,
      imageDigest: this.deps.imageDigest ?? null,
      launcherMode: this.split !== undefined,
      flags: {
        optimizeForSize: process.execArgv.includes('--optimize-for-size'),
        nodeOptionsSet: Boolean(process.env.NODE_OPTIONS?.trim()),
      },
    });
  }

  // -- Retries ---------------------------------------------------------------

  /**
   * A login given to the machine whose sign-in check could not run (just after
   * a box wakes, before the agents container's launcher links) is tried again
   * a bounded number of times, backing off, and the agents waiting on it start
   * once it signs in, rather than at the next nudge or resync. Only the
   * provider and the try are logged, never the login.
   */
  retryUnchecked(): void {
    const providers = this.providers;
    if (!providers?.hasUnchecked()) {
      this.uncheckedTry = 0;
      return;
    }
    const waits = this.deps.uncheckedRetryMs ?? UNCHECKED_RETRY_MS;
    if (this.uncheckedTimer || this.ctx.stopping() || this.uncheckedTry >= waits.length) return;
    const delay = waits[this.uncheckedTry++]!;
    this.log.info('A given login’s sign-in check could not run; trying it again', {
      try: this.uncheckedTry,
      inMs: delay,
    });
    this.uncheckedTimer = setTimeout(() => {
      this.uncheckedTimer = null;
      if (this.ctx.stopping()) return;
      void providers
        .checkAll({ verify: true })
        .catch((error: unknown) => this.ctx.failed('Checking providers', error))
        .then(() => {
          void this.ctx.reconcileLocally();
          this.retryUnchecked();
        });
    }, delay);
    this.uncheckedTimer.unref?.();
  }

  /**
   * Reconciles again once an agent owed a restart for new credentials has no
   * session mid-turn, or has waited `CREDENTIAL_RESTART_WAIT_MS`: a turn
   * ending changes nothing reported, so nothing else would bring it round.
   */
  async restartOwedForCredentials(): Promise<void> {
    const owed = this.credentialRestarts.owed();
    if (owed.size === 0 || this.ctx.stopping()) return;
    const runtime = this.requireRuntime();
    try {
      for (const [agentId, since] of owed) {
        const observation = await runtime.observe(agentId);
        // One not running is settled by its next start, not by a reconcile.
        if (!observation.alive) continue;
        if (
          noSessionMidTurn([observation]) ||
          this.ctx.now() - since >= CREDENTIAL_RESTART_WAIT_MS
        ) {
          void this.ctx.reconcileLocally();
          return;
        }
      }
    } catch (error) {
      this.ctx.failed('Restarting agents owed new credentials', error);
    }
  }

  /** Each status poll: credential restarts owed, and resting agents. */
  poll(): void {
    void this.restartOwedForCredentials();
    if (!this.ctx.stopping())
      void this.rest
        ?.check(this.ctx.assignment())
        .catch((error: unknown) => this.ctx.failed('Resting agents', error));
  }

  // -- The split box's launcher ----------------------------------------------

  /**
   * Ends an agent's current host and reconciles again once `afterMs` has
   * passed, so it is started afresh with a new ticket (split boxes only).
   * The gate refuses the start until its backoff is over.
   */
  private relaunchSplitHost(agentId: string, afterMs: number): void {
    this.log.warn('Starting an agent’s host again', { agentId, afterMs });
    void this.requireRuntime()
      .stop(agentId, { wait: true, asked: false })
      .catch(() => {})
      .finally(() => {
        const timer = setTimeout(() => void this.ctx.reconcileLocally(), afterMs + 50);
        timer.unref?.();
      });
  }

  /** Split boxes: listens for the launcher, and follows its link. Fails closed. */
  async startLauncherLink(): Promise<void> {
    const split = this.split;
    if (!split) return;
    const log = this.log;
    split.link.listenTo({
      // Every hello: the launcher starts with everything off, and is told the settings.
      onConnected: () => {
        const operatorExec = split.operatorExec === true;
        void split.link.order({ kind: 'settings', operatorExec }).then((reply) => {
          if (!reply.ok)
            log.warn('Could not send the launcher its settings', { code: reply.code ?? 'failed' });
        });
      },
      // A report about an agent this controller didn't launch is refused.
      launched: (agentId) => split.runner.currentLaunch(agentId) !== null,
      onMeasure: (measurement) => split.measure.measured(measurement),
      onState: (state: LinkState) => {
        this.ctx.report();
        if (state === 'quiet') {
          // Nothing can be measured: park what is idle, so nothing grows unseen.
          log.warn('The launcher went quiet: admitting nothing, and parking idle sessions');
          void this.valve.parkIdle().catch(() => {});
        } else if (state === 'lost') {
          log.error('The launcher is lost: starting no agent until it is back');
        } else if (state === 'live') {
          // Back: the waiters and any agent that failed to start meanwhile.
          void this.valve.tick();
          void this.ctx.reconcileLocally();
        }
      },
      onRestarted: () => {
        // A new agents container: every host and lease is gone. Look again before admitting.
        log.warn('The agents container restarted: every agent host is gone; looking at each again');
        split.measure.reset();
        this.splitSettling = true;
        void this.ctx.reconcileLocally().finally(() => {
          this.splitSettling = false;
          void this.valve.tick();
        });
      },
      // Only the controller starts a host again, as for any host found gone.
      onExited: (agentId, launchId, reason) => {
        if (split.runner.launchOf(agentId) !== launchId) return;
        // Gone by itself or ended by the launcher: started again after a backoff.
        const wait = split.gate.delay(agentId);
        if (reason !== 'gone')
          log.warn('The launcher ended an agent host that failed a check', { agentId, reason });
        const timer = setTimeout(() => void this.ctx.reconcileLocally(), wait + 50);
        timer.unref?.();
      },
    });
    const linkTicks = setInterval(() => split.link.tick(), 1_000);
    linkTicks.unref?.();
    let listenRetry: NodeJS.Timeout | undefined;
    this.stopLinkTicks = () => {
      clearInterval(linkTicks);
      if (listenRetry) clearInterval(listenRetry);
    };
    // Fails closed: if the listener can't be opened, no host can start (every
    // host goes through the launcher), the box reports itself unprotected, and
    // one ERROR says so. The same address is tried again every 10 s, never
    // another one, so the box recovers by itself.
    const listen = (): Promise<string | null> =>
      split.link.listen().then(
        () => null,
        (error: unknown) => errorCode(error)
      );
    const failed = await listen();
    if (failed !== null) {
      this.launcherUnavailable = true;
      log.error(
        'The controller could not listen for the launcher, so no agent can start on this box; it tries the same address again every 10 s',
        { code: failed }
      );
      listenRetry = setInterval(() => {
        void listen().then((still) => {
          if (still !== null || !this.launcherUnavailable) return;
          this.launcherUnavailable = false;
          clearInterval(listenRetry);
          log.info('The controller is listening for the launcher', {});
        });
      }, this.deps.launcherListenRetryMs ?? LAUNCHER_LISTEN_RETRY_MS);
      listenRetry.unref?.();
    }
    log.info('Waiting for the launcher', {});
  }

  // -- Starting and stopping -------------------------------------------------

  /** Before the first reconcile: hosts may join the valve from now. */
  beforeFirstReconcile(): void {
    this.openValve();
    this.stopValve = this.valve.watch();
  }

  /** The relay is ready: so is the gateway. */
  ready(): void {
    this.gateway?.gateway.setReady();
  }

  /** The controller is stopping: timers first. */
  stopping(): void {
    if (this.uncheckedTimer) clearTimeout(this.uncheckedTimer);
    this.stopValve();
  }

  /** Last: the gateway, the day's call count, and the launcher link. */
  async close(): Promise<void> {
    await this.gateway?.gateway.close();
    this.dailyCap?.save();
    this.stopLinkTicks();
    await this.split?.link.close();
  }

  // -- Helpers ---------------------------------------------------------------

  /** This agent's share of the cap while its hub is down: the cap over the agents running, at least 1. */
  private valveShare(): number {
    const running = (this.ctx.assignment()?.agents ?? []).filter(
      (entry) => entry.desired_state === 'running'
    );
    return Number.isFinite(this.valve.cap)
      ? Math.max(1, Math.floor(this.valve.cap / Math.max(1, running.length)))
      : 1;
  }

  private requireRuntime(): AgentRuntime {
    if (!this.runtime) throw new Error('The box controller was used before its runtime was set.');
    return this.runtime;
  }
}
