import { randomBytes } from 'node:crypto';
import { mkdir, readFile, statfs } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { sharedConfigSchema } from '@switch-console/agent-providers-box';
import type { FilesReader } from './files-reader';
import { FilesService } from './files-service';
import { FirstSight, OPERATOR, type SeenProcess } from './first-sight';
import {
  encodeLine,
  type LauncherOrder,
  hostFailureCode,
  launcherOrderSchema,
  type LauncherReport,
  LineReader,
  type ReplyCode,
  type LineRefusal,
} from './launcher-protocol';
import { anonymousBytesIn } from './memory-guard';
import {
  listProcesses,
  MarkerTable,
  type ProcessEntry,
  type ProcOptions,
  ProcReader,
} from './owner-marker';
import { relayCredentialsBody, writeAtomic } from './runtime';
import type { AgentObservation, AgentRunner } from './runtime';

/**
 * The launcher: pid 1 of the agents container, behind tini.
 * It runs as the agents' user
 * and holds no secrets. It does what the controller orders over one socket
 * and nothing else: starts, stops and observes agent hosts, measures each
 * agent's memory, and ends processes with proof. The controller decides.
 *
 * - **No host it wasn't ordered to start.** A crashed host is reported
 *   (`exited`); only the controller starts it again, with a new ticket (C9).
 * - **Markers per launch,** in memory only (`MarkerTable`); the key stays in
 *   the controller (C8).
 * - **Whose a process is goes by first sight** (`FirstSight`): counted to the
 *   tree it was first seen under, else its marker as disputed; stopping an
 *   agent ends what was first seen under it, whatever its marker (C8a).
 * - **When the socket closes, it exits,** so the container restarts and every
 *   host and tool goes with it: nothing runs unsupervised.
 */

export const MEASURE_INTERVAL_MS = 2_000;
const END_ROUNDS = 5;
/** How long a spawned host has to confirm its push key, by taking its first ticket. */
export const CONFIRM_KEY_MS = 5_000;

/** Called by the runner the moment it spawns an agent's host: its pid and the push key it was handed. */
export type SpawnRecorder = (agentId: string, pid: number, key: Buffer) => void;

/** How a ticket push went: taken (and confirmed), refused for a port not the host's own, or not taken. */
export type PushOutcome = 'taken' | 'wrong_port' | 'not_taken';

type Spawned = {
  pid: number;
  /** Read at the first scan that finds it, as this launcher's own child. */
  startTicks: number | null;
  key: Buffer;
  confirmed: boolean;
  timer: NodeJS.Timeout | null;
};

export type LauncherDeps = {
  /** Writes a line to the controller. */
  send: (line: string) => void;
  /**
   * Starts, stops and observes hosts, as `DetachedRuntime` does today, given the
   * launcher's own marker table for each host's environment.
   */
  runner: (markers: Pick<MarkerTable, 'environmentFor'>, spawned: SpawnRecorder) => AgentRunner;
  /** Where each agent's credentials file goes (`dataLayout(...).agentCredentials`). */
  credentialsPath: (agentId: string) => string;
  proc?: ProcOptions;
  /** Lists processes, as `listProcesses` (tests substitute a fake `/proc`). */
  list?: typeof listProcesses;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  version: string;
  bundle: string;
  now: () => number;
  /** Refusals and failures, as fixed codes with ids only. */
  log: (event: string, fields: Record<string, string | number>) => void;
  /**
   * Hands a host its one-time hub ticket over its control port, with an HMAC
   * under its push key, retrying while the host comes up. First checks that the
   * port is the spawned host's own (`wrong_port` if not), and that the host's
   * answer is the confirmation under the same key (`not_taken` if not). Never
   * through its environment or a file.
   */
  pushTicket: (
    agentId: string,
    ticket: string,
    host: { pid: number; key: Buffer }
  ) => Promise<PushOutcome>;
  /** Runs a provider's sign-in check here, with the gateway's probe environment; its readiness. */
  probe: (provider: string, binaryPath: string, env: Record<string, string>) => Promise<unknown>;
  /** Asks a host to start a room's session early, over its control port (`warmOverControlPort`). */
  warm: (agentId: string, roomId: string) => Promise<void>;
  /** Asks a host to tell its rooms the guard is stopping it; how many it told (`stopForMemoryOverControlPort`). */
  memoryNotice: (agentId: string) => Promise<number>;
  /** The workspaces folder: a launch's `directory` is made only inside it. */
  workspacesRoot?: string;
  /** The agents' data folder: a launch's `directory` may also be an existing one inside it. */
  dataRoot?: string;
  /** Measures a folder's file system, as `statfs` (tests substitute their own). */
  statfs?: (path: string) => Promise<{ bavail: number; blocks: number; bsize: number }>;
  /** Overrides `CONFIRM_KEY_MS` (tests). */
  confirmMs?: number;
  /** The controller's socket closed: the caller exits. */
  onClosed: () => void;
  /** The file explorer's reader (tests point it at a folder of their own). */
  files?: FilesReader;
};

export class Launcher {
  private readonly markers = new MarkerTable();
  private readonly sight = new FirstSight();
  private readonly reader = new ProcReader();
  private readonly launches = new Map<string, number>();
  private readonly lines: LineReader<LauncherOrder>;
  private readonly runner: AgentRunner;
  /** Agents whose host was seen alive since its launch, and not stopped on order since. */
  private readonly running = new Set<string>();
  /** Each agent's host as this launcher spawned it: the only thing taken as its host. */
  private readonly spawned = new Map<string, Spawned>();
  /** Strangers seen in the last scan, by pid and start time. */
  private strangersBefore = new Set<string>();
  private strangersEnded = 0;
  /** Set by the controller's `settings` order; off until then. */
  private operatorExec = false;
  /** Operator exec roots already logged, by pid and start time. */
  private operatorSeen = new Set<string>();
  readonly bootId = randomBytes(16).toString('hex');
  private closed = false;
  /** The file explorer's orders: the box's workspaces, read for the owner's Console. */
  private readonly files: FilesService;

  constructor(private readonly deps: LauncherDeps) {
    this.files = new FilesService({
      report: (report) => this.report(report),
      log: deps.log,
      ...(deps.files ? { reader: deps.files } : {}),
    });
    this.runner = deps.runner(this.markers, (agentId, pid, key) => {
      this.forgetSpawn(agentId);
      this.spawned.set(agentId, { pid, startTicks: null, key, confirmed: false, timer: null });
    });
    this.lines = new LineReader(
      launcherOrderSchema,
      (order) => void this.handle(order),
      (reason: LineRefusal) => this.deps.log('refused_order', { reason })
    );
  }

  /** The socket is open: say who this is. */
  start(): void {
    this.report({
      kind: 'hello',
      version: this.deps.version,
      bundle: this.deps.bundle,
      bootId: this.bootId,
    });
  }

  /** Bytes from the controller. */
  feed(chunk: Buffer): void {
    if (!this.closed) this.lines.feed(chunk);
  }

  /** The socket closed: nothing more is done, and the caller exits. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const spawn of this.spawned.values()) if (spawn.timer) clearTimeout(spawn.timer);
    void this.files.close();
    this.deps.onClosed();
  }

  /** One measurement: every launched agent's bytes, from what each process was first seen under. */
  async measure(): Promise<void> {
    if (this.closed) return;
    const scan = await this.scan();
    const agents: Record<string, { bytes: number; processes: number; disputedBytes: number }> = {};
    for (const agentId of this.launches.keys())
      agents[agentId] = { bytes: 0, processes: 0, disputedBytes: 0 };
    const strangers = { processes: 0, bytes: 0, ended: 0 };
    const operator = { processes: 0, bytes: 0 };
    const operatorNow = new Set<string>();
    const strangersNow = new Set<string>();
    const toEnd: SeenProcess[] = [];
    for (const entry of scan) {
      const { agentId, disputed } = this.sight.attribute(entry);
      if (agentId === null) {
        // No first sight and no current marker: no agent's. Counted to the box,
        // and ended once it has been seen two scans in a row.
        if (entry.pid === 1) continue; // tini
        const k = `${entry.pid}:${entry.startTicks}`;
        strangersNow.add(k);
        strangers.processes++;
        strangers.bytes += await this.bytesOf(entry);
        if (this.strangersBefore.has(k)) toEnd.push(entry);
        continue;
      }
      if (agentId === OPERATOR) {
        // An operator's exec on a test box: left running, counted to the box,
        // and one WARN per exec with its command name only.
        operator.processes++;
        operator.bytes += await this.bytesOf(entry);
        if (entry.ppid === 0) {
          const k = `${entry.pid}:${entry.startTicks}`;
          operatorNow.add(k);
          if (!this.operatorSeen.has(k))
            this.deps.log('operator_exec', {
              pid: entry.pid,
              command: await this.commandName(entry.pid),
            });
        }
        continue;
      }
      if (!agents[agentId]) continue;
      const bytes = await this.bytesOf(entry);
      agents[agentId]!.bytes += bytes;
      agents[agentId]!.processes++;
      if (disputed) agents[agentId]!.disputedBytes += bytes;
    }
    this.strangersBefore = strangersNow;
    this.operatorSeen = operatorNow;
    for (const entry of toEnd) {
      if (!(await this.stillSame(entry))) continue;
      try {
        this.deps.signal(entry.pid, 'SIGKILL');
        this.strangersEnded++;
        this.deps.log('stranger_ended', { pid: entry.pid, ended: this.strangersEnded });
      } catch {
        // gone meanwhile
      }
    }
    strangers.ended = Math.min(this.strangersEnded, 1_000_000);
    this.report({
      kind: 'measure',
      at: this.deps.now(),
      agents,
      strangers,
      ...(this.operatorExec ? { operator } : {}),
    });
  }

  /** A process's command name (`comm`), reduced to safe characters for a log line. */
  private async commandName(pid: number): Promise<string> {
    const procRoot = this.deps.proc?.procRoot ?? '/proc';
    const comm = await readFile(join(procRoot, String(pid), 'comm'), 'utf8').catch(() => '');
    return (
      comm
        .trim()
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 16) || 'unknown'
    );
  }

  /** A process's anonymous bytes; gone or unreadable counts as nothing. */
  private async bytesOf(entry: SeenProcess): Promise<number> {
    const procRoot = this.deps.proc?.procRoot ?? '/proc';
    try {
      return (await anonymousBytesIn(this.reader, join(procRoot, String(entry.pid), 'smaps')))
        .bytes;
    } catch {
      return 0;
    } finally {
      this.reader.settle();
    }
  }

  /**
   * Looks at every launched host: one seen alive before and gone now, not on
   * an order to stop, is reported `exited` once. Nothing is restarted here (C9).
   */
  async checkHosts(): Promise<void> {
    for (const agentId of this.launches.keys()) {
      if (this.closed) return;
      const alive = await this.runner
        .observe(agentId)
        .then((observation) => observation.alive)
        .catch(() => false);
      if (alive) this.running.add(agentId);
      else if (this.running.delete(agentId)) this.hostExited(agentId, 'gone');
    }
  }

  /** A host the controller started has gone, or was ended here: reported, never restarted here (C9). */
  hostExited(agentId: string, reason: 'gone' | 'unconfirmed' | 'wrong_port'): void {
    this.forgetSpawn(agentId);
    const launchId = this.launches.get(agentId);
    if (launchId !== undefined) this.report({ kind: 'exited', agentId, launchId, reason });
  }

  private forgetSpawn(agentId: string): void {
    const spawn = this.spawned.get(agentId);
    if (spawn?.timer) clearTimeout(spawn.timer);
    this.spawned.delete(agentId);
  }

  /**
   * Ends a host that failed a check (its push key unconfirmed, or a control
   * port not its own), and everything first seen under it, then reports it
   * gone with the reason: the controller decides what starts next.
   */
  private async endHost(agentId: string, reason: 'unconfirmed' | 'wrong_port'): Promise<void> {
    this.deps.log('host_ended', { agentId, reason });
    this.running.delete(agentId);
    await this.runner.stop(agentId, { wait: false, asked: false }).catch(() => {});
    await this.signalAgent({ kind: 'end', id: 0, agentId }).catch(() => {});
    this.hostExited(agentId, reason);
  }

  private async handle(order: LauncherOrder): Promise<void> {
    try {
      switch (order.kind) {
        case 'launch': {
          const template = sharedConfigSchema.safeParse(order.template);
          if (!template.success) return this.reply(order.id, false, 'bad_template');
          if (order.directory !== undefined) {
            const wanted = resolve(order.directory);
            const inside = (root: string | undefined) =>
              root !== undefined &&
              (wanted === resolve(root) || wanted.startsWith(resolve(root) + sep));
            // Only inside the agents' folders: made inside the workspaces folder;
            // inside the data folder it must already exist.
            if (!inside(this.deps.workspacesRoot) && !inside(this.deps.dataRoot))
              return this.reply(order.id, false, 'bad_directory');
            if (inside(this.deps.workspacesRoot)) await mkdir(wanted, { recursive: true });
          }
          this.markers.set(order.agentId, order.marker);
          this.launches.set(order.agentId, order.launchId);
          const path = this.deps.credentialsPath(order.agentId);
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          // The relay fields only. Logins reach hosts through the credential
          // gateway, whose token comes in the start environment, never through here.
          await writeAtomic(
            path,
            relayCredentialsBody(order.agentId, {
              endpoint: order.credentials.endpoint,
              token: order.credentials.token,
              hub: order.credentials.hub,
              providerLogin: null,
            })
          );
          await this.runner.launch(order.agentId, template.data, {
            isolation: 'isolated',
            restart: order.restart,
            replaceIdentity: order.replaceIdentity,
            clearTakenOver: order.clearTakenOver,
          });
          this.awaitConfirmation(order.agentId);
          this.handOver(order.agentId, order.ticket);
          return this.reply(order.id, true);
        }
        case 'stop':
          this.running.delete(order.agentId);
          this.forgetSpawn(order.agentId);
          await this.runner.stop(order.agentId, { wait: order.wait, asked: order.asked });
          return this.reply(order.id, true);
        case 'observe': {
          const observation: AgentObservation = await this.runner.observe(order.agentId);
          // Only what the controller acts on, which it checks against a strict schema.
          return this.report({
            kind: 'reply',
            id: order.id,
            ok: true,
            observation: JSON.parse(
              JSON.stringify({
                alive: observation.alive,
                health: observation.health,
                // A code, never the host's own words (C6).
                failure: observation.failure === null ? null : hostFailureCode(observation.failure),
                outdated: observation.outdated,
              })
            ) as Record<string, unknown>,
          });
        }
        case 'probe': {
          const readiness = await this.deps.probe(order.provider, order.binaryPath, order.env);
          return this.report({
            kind: 'reply',
            id: order.id,
            ok: true,
            readiness: JSON.parse(JSON.stringify(readiness ?? {})) as Record<string, unknown>,
          });
        }
        case 'ticket':
          this.handOver(order.agentId, order.ticket);
          return this.reply(order.id, true);
        case 'disk': {
          // The agents' volume, where their workspaces live: the figure Switch
          // shows as the box's disk. Without a data folder there is nothing to measure.
          if (this.deps.dataRoot === undefined) return this.reply(order.id, false, 'failed');
          const fs = await (this.deps.statfs ?? statfs)(this.deps.dataRoot);
          const bytes = (n: number) =>
            Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n)));
          const total = bytes(fs.blocks * fs.bsize);
          return this.report({
            kind: 'reply',
            id: order.id,
            ok: true,
            disk: { free: Math.min(bytes(fs.bavail * fs.bsize), total), total },
          });
        }
        case 'settings':
          this.operatorExec = order.operatorExec;
          if (order.operatorExec) this.deps.log('operator_exec_on', {});
          return this.reply(order.id, true);
        case 'warm':
          if (!this.launches.has(order.agentId))
            return this.reply(order.id, false, 'unknown_agent');
          await this.deps.warm(order.agentId, order.roomId);
          return this.reply(order.id, true);
        case 'memory_notice': {
          if (!this.launches.has(order.agentId))
            return this.reply(order.id, false, 'unknown_agent');
          const told = await this.deps.memoryNotice(order.agentId);
          return this.report({
            kind: 'reply',
            id: order.id,
            ok: true,
            told: Math.max(0, Math.min(told, 1_000_000)),
          });
        }
        case 'files_list':
        case 'files_read':
        case 'files_zip':
        case 'files_more':
        case 'files_cancel':
          return await this.files.handle(order);
        case 'freeze':
        case 'thaw':
        case 'end':
        case 'sweep':
          return this.report({
            kind: 'reply',
            id: order.id,
            ok: true,
            counts: await this.signalAgent(order),
          });
      }
    } catch {
      this.deps.log('order_failed', {
        kind: order.kind,
        ...('agentId' in order ? { agentId: order.agentId } : {}),
      });
      return this.reply(order.id, false, 'failed');
    }
  }

  /**
   * The memory guard's and resting's steps, for one agent, on what first sight
   * says is its (C8a): `freeze` stops all but its host, `thaw` resumes, `end`
   * and `sweep` stop then kill, in rounds, until none is left.
   */
  private async signalAgent(
    order: Extract<LauncherOrder, { kind: 'freeze' | 'thaw' | 'end' | 'sweep' }>
  ) {
    const counts = { signalled: 0, gone: 0, notProven: 0, disputed: 0, left: 0 };
    const host = this.hostOf(order.agentId, await this.scan());
    const rounds = order.kind === 'end' || order.kind === 'sweep' ? END_ROUNDS : 1;
    for (let round = 0; round < rounds; round++) {
      const scan = await this.scan();
      const targets = this.sight
        .toEnd(scan, order.agentId)
        .filter((entry) => !(order.kind === 'freeze' && host && entry.pid === host.pid));
      if (targets.length === 0) break;
      for (const entry of targets) {
        if (this.sight.attribute(entry).disputed) counts.disputed++;
        const signals: NodeJS.Signals[] =
          order.kind === 'freeze'
            ? ['SIGSTOP']
            : order.kind === 'thaw'
              ? ['SIGCONT']
              : ['SIGSTOP', 'SIGKILL'];
        for (const name of signals) {
          // Signal only the process that was scanned: same pid and start time, read again just before.
          if (!(await this.stillSame(entry))) {
            counts.gone++;
            break;
          }
          try {
            this.deps.signal(entry.pid, name);
            if (name === signals[signals.length - 1]) counts.signalled++;
          } catch {
            counts.gone++;
            break;
          }
        }
      }
    }
    if (order.kind === 'end' || order.kind === 'sweep')
      counts.left = this.sight.toEnd(await this.scan(), order.agentId).length;
    return counts;
  }

  /** Every process, with first sight brought up to date. */
  private async scan(): Promise<SeenProcess[]> {
    const agentIds = [...this.launches.keys()];
    const list = this.deps.list ?? listProcesses;
    const scan = await list(this.markers, agentIds, this.deps.proc, this.reader);
    this.reader.settle();
    const hosts = new Map<string, SeenProcess>();
    for (const agentId of agentIds) {
      const host = this.hostOf(agentId, scan);
      if (host) hosts.set(agentId, host);
    }
    this.sight.observe(scan, hosts, this.operatorExec);
    return scan;
  }

  /**
   * An agent's host: the process this launcher spawned for it, by pid and
   * start time, never a guess from markers or command
   * lines. Its start time is taken at the first scan that finds that pid as
   * this launcher's own child; after that, only the same pid and start time is it.
   */
  private hostOf(agentId: string, scan: readonly ProcessEntry[]): SeenProcess | null {
    const spawn = this.spawned.get(agentId);
    if (!spawn) return null;
    const self = this.deps.proc?.self ?? process.pid;
    const entry = scan.find(
      (candidate) =>
        candidate.pid === spawn.pid &&
        (spawn.startTicks === null
          ? candidate.ppid === self
          : candidate.startTicks === spawn.startTicks)
    );
    if (!entry) return null;
    spawn.startTicks ??= entry.startTicks;
    return entry;
  }

  private async stillSame(entry: SeenProcess): Promise<boolean> {
    const list = this.deps.list ?? listProcesses;
    const now = await list(this.markers, [], this.deps.proc, this.reader);
    this.reader.settle();
    return now.some((other) => other.pid === entry.pid && other.startTicks === entry.startTicks);
  }

  /**
   * A freshly spawned host has `CONFIRM_KEY_MS` to take its first ticket,
   * which proves it read its push key; if not, it is ended and reported, and
   * the controller relaunches it.
   */
  private awaitConfirmation(agentId: string): void {
    const spawn = this.spawned.get(agentId);
    if (!spawn || spawn.confirmed || spawn.timer) return;
    spawn.timer = setTimeout(() => {
      spawn.timer = null;
      if (this.spawned.get(agentId) === spawn && !spawn.confirmed && !this.closed)
        void this.endHost(agentId, 'unconfirmed');
    }, this.deps.confirmMs ?? CONFIRM_KEY_MS);
    spawn.timer.unref?.();
  }

  /**
   * Gives the spawned host its ticket, in the background: never to a host this
   * launcher didn't spawn, never to a control port that isn't the host's own
   * (then the host is ended), and taken only when the host
   * answers with the confirmation under its push key.
   */
  private handOver(agentId: string, ticket: string): void {
    const spawn = this.spawned.get(agentId);
    if (!spawn) {
      this.deps.log('ticket_no_host', { agentId });
      return;
    }
    void this.deps
      .pushTicket(agentId, ticket, { pid: spawn.pid, key: spawn.key })
      .then((outcome) => {
        if (this.spawned.get(agentId) !== spawn) return;
        if (outcome === 'taken') {
          spawn.confirmed = true;
          if (spawn.timer) clearTimeout(spawn.timer);
          spawn.timer = null;
        } else if (outcome === 'wrong_port') void this.endHost(agentId, 'wrong_port');
        else this.deps.log('ticket_not_taken', { agentId });
      })
      .catch(() => this.deps.log('ticket_not_handed_over', { agentId }));
  }

  private reply(id: number, ok: boolean, code?: ReplyCode): void {
    this.report(code ? { kind: 'reply', id, ok, code } : { kind: 'reply', id, ok });
  }

  private report(report: LauncherReport): void {
    if (!this.closed) this.deps.send(encodeLine(report));
  }
}
