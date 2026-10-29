import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetch } from '../api';
import { errorMessage, type Logger } from '../log';
import type {
  DecisionAssignment,
  DecisionErrorCode,
  DecisionHardware,
  DecisionOffer,
  DecisionReason,
  DecisionRequestFrame,
  DecisionResult,
  DecisionState,
  DecisionStatus,
} from '../schemas';
import {
  type Artifact,
  buildFor,
  type Catalogue,
  type CatalogueModel,
  catalogueModel,
  type Machine,
  offeredModels,
  type RuntimeBuild,
} from './catalogue';
import { ChecksumMismatch, downloadArtifact } from './download';
import { detectHardware, type RunCommand } from './hardware';
import { type DecisionLayout, readLocalSetting, removeDownloads } from './local-setting';
import {
  type LaunchModelServer,
  type ModelServerExit,
  type ModelServerHandle,
  ModelServerEnded,
  type StaleServers,
  WARM_UP_PAYLOAD,
  waitHealthy,
} from './model-server';

/** As many decisions as the model server has slots for; one more is answered `busy`. */
export const MAX_IN_FLIGHT = 4;

export type DecisionTiming = {
  /** How long a model server has to load its model and answer `/health`. */
  healthTimeoutMs: number;
  healthIntervalMs: number;
  /** The waits before starting a crashed model server again, in turn. */
  crashBackoffMs: number[];
  /** Crashes within `crashWindowMs` past which it is left failed. */
  crashLimit: number;
  crashWindowMs: number;
  /** The first wait before a failed download is tried again; it doubles up to `downloadRetryMaxMs`. */
  downloadRetryMs: number;
  downloadRetryMaxMs: number;
  /** How often free disk space is looked at again, while too little held a download back. */
  diskRetryMs: number;
  /** A download that receives nothing for this long is given up and resumed later. */
  stallTimeoutMs: number;
};

export const DEFAULT_DECISION_TIMING: DecisionTiming = {
  healthTimeoutMs: 180_000,
  healthIntervalMs: 250,
  crashBackoffMs: [2_000, 4_000, 8_000],
  crashLimit: 3,
  crashWindowMs: 10 * 60 * 1000,
  downloadRetryMs: 30_000,
  downloadRetryMaxMs: 10 * 60 * 1000,
  diskRetryMs: 60_000,
  stallTimeoutMs: 60_000,
};

/** Room for llama.cpp's build unpacked beside its archive, and for the system to breathe. */
const UNPACK_FACTOR = 3;
const DISK_HEADROOM_BYTES = 512 * 1024 ** 2;

/** Unpacks a `.tar.gz` into `dir`. */
export type Extract = (archive: string, dir: string) => Promise<void>;

export const tarExtract: Extract = (archive, dir) =>
  new Promise((resolve, reject) => {
    execFile(
      'tar',
      ['-xzf', archive, '-C', dir, '--no-same-owner'],
      { timeout: 10 * 60 * 1000 },
      (error) => (error ? reject(error) : resolve())
    );
  });

export const freeDiskBytes = async (dir: string): Promise<number> => {
  const disk = await statfs(dir);
  return disk.bavail * disk.bsize;
};

export type DecisionRuntimeDeps = {
  layout: DecisionLayout;
  /** The pinned models and builds (`CATALOGUE`). */
  catalogue: Catalogue;
  platform: NodeJS.Platform;
  arch: string;
  totalMemory: number;
  /** CPU threads llama.cpp's CPU build gets. */
  cpuThreads: number;
  run: RunCommand;
  fetch: Fetch;
  launch: LaunchModelServer;
  stale: StaleServers;
  extract: Extract;
  diskFree: (dir: string) => Promise<number>;
  /**
   * What this run says of decision work (`decisionModelOverride`): `off`
   * with `--no-decision-model` or `SWITCH_CONTROLLER_DECISION_MODEL=off`,
   * `on` with that variable `on`; null follows the owner's switch in the
   * data directory.
   */
  override: 'on' | 'off' | null;
  log: Logger;
  now: () => number;
  /** Something a status report carries changed. */
  onChange: () => void;
  timing: DecisionTiming;
};

class NotEnoughDisk extends Error {
  constructor(
    readonly needed: number,
    readonly free: number
  ) {
    super(
      `Needs ${gigabytes(needed)} of free disk space for the decision model; ${gigabytes(free)} is free.`
    );
  }
}

/** The model server could not be started at all (its binary would not run). */
class LaunchFailed extends Error {}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

type Work = {
  model: CatalogueModel;
  abort: AbortController;
  done: Promise<void>;
};

type Failure = { reason: DecisionReason; detail: string };

function result(requestId: string, code: DecisionErrorCode, message: string): DecisionResult {
  return { type: 'decision.result', request_id: requestId, ok: false, error: { code, message } };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The decision model this machine serves for auto-route, reconciled to what
 * the assignment asks (`decision: {revision, model}` or none) and to the
 * owner's own switch on this machine.
 *
 * Asked for a model, it downloads the pinned llama.cpp build and weights
 * (resuming, checking each SHA-256, after making sure the disk has room),
 * starts llama-server on loopback with a key made for that launch, waits
 * for `/health`, runs one warm-up decision, and reports `running`. A model
 * server that exits is started again after 2, 4 and 8 seconds; the third
 * crash within ten minutes leaves it `failed` until the assignment's next
 * revision. A failed download is retried with backoff, from where it
 * stopped. When the assignment stops naming a model, or the owner turns
 * decision work off here, the server is stopped and the weights are kept.
 *
 * Decisions are forwarded to the model server as they came, at most
 * `MAX_IN_FLIGHT` at once. Their payloads and answers are room content:
 * they are never logged or written anywhere.
 */
export class DecisionRuntime {
  private hardware: DecisionHardware | null = null;
  private machine: Machine | null = null;
  private offered: DecisionOffer[] = [];
  private desired: DecisionAssignment | null = null;
  private localEnabled = true;
  private work: Work | null = null;
  /** A failure that waits for the assignment's next revision, and the revision it happened at. */
  private settled: { model: string; revision: number } | null = null;
  private state: DecisionState = 'off';
  private model: string | null = null;
  private appliedRevision: number | null = null;
  private progress: { done_bytes: number; total_bytes: number } | null = null;
  private failure: Failure | null = null;
  private reason: DecisionReason | null = null;
  private since: number;
  private lastDecisionMs: number | null = null;
  private crashes: number[] = [];
  private server: ModelServerHandle | null = null;
  private inFlight = 0;
  private closed = false;
  private applying: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DecisionRuntimeDeps) {
    this.since = deps.now();
  }

  /** Detects the hardware, reads the owner's switch, and stops a model server an earlier run left. */
  async start(): Promise<void> {
    const detected = await detectHardware({
      platform: this.deps.platform,
      totalMemory: this.deps.totalMemory,
      run: this.deps.run,
    });
    this.hardware = detected.hardware;
    this.machine = {
      platform: this.deps.platform,
      arch: this.deps.arch,
      hardware: detected.hardware,
      nvidiaDriver: detected.nvidiaDriver,
    };
    this.offered = offeredModels(this.deps.catalogue, this.machine);
    await this.readSetting();
    await this.deps.stale.stopStale().catch((error: unknown) =>
      this.deps.log.warn('Could not stop a model server an earlier run left', {
        error: errorMessage(error),
      })
    );
    this.deps.log.info('Decision model hardware', {
      accelerator: detected.hardware.accelerator,
      offered: this.offered.map((offer) => `${offer.model} (${offer.runtime}, ${offer.speed})`),
      turnedOffHere: this.turnedOff(),
    });
    this.apply();
  }

  /** Follows the assignment's `decision`: a model to serve, or none. */
  reconcile(desired: DecisionAssignment | null): void {
    this.desired = desired;
    this.apply();
  }

  /** Reads the owner's switch again, as `decision-model on|off` may have changed it while this runs. */
  async refreshSetting(): Promise<void> {
    if (await this.readSetting()) this.apply();
  }

  /**
   * Deletes the downloaded weights and llama.cpp build, stopping the model
   * server (or a download) first. When the assignment still names a model
   * and decision work is allowed here, it is then downloaded again: what to
   * serve is the assignment's to say.
   */
  async removeModel(): Promise<void> {
    const removal = this.applying.then(async () => {
      const serving = this.work !== null;
      await this.stopWork();
      await removeDownloads(this.deps.layout);
      this.settled = null;
      this.deps.log.info('Removed the downloaded decision model', { stoppedServer: serving });
      if (serving)
        this.deps.log.warn(
          'The assignment still asks this machine for the decision model it removed; downloading it again'
        );
    });
    this.applying = removal.catch(() => {});
    await removal;
    this.apply();
  }

  status(): DecisionStatus {
    if (!this.hardware) throw new Error('The decision runtime has not started.');
    const failed = this.state === 'failed' && this.failure;
    return {
      hardware: this.hardware,
      offered: this.offered,
      state: this.state,
      model: this.model,
      applied_revision: this.appliedRevision,
      ...(this.state === 'downloading' && this.progress ? { progress: this.progress } : {}),
      restarts_10m: this.recentCrashes(),
      since: new Date(this.since).toISOString(),
      ...(failed
        ? { reason: this.failure!.reason, detail: this.failure!.detail.slice(0, 500) }
        : this.reason
          ? { reason: this.reason }
          : {}),
      ...(this.lastDecisionMs !== null ? { last_decision_ms: this.lastDecisionMs } : {}),
    };
  }

  /**
   * Answers one decision: forwards its payload to the model server with this
   * launch's key and returns the server's answer, or why there is none.
   */
  async decide(request: DecisionRequestFrame): Promise<DecisionResult> {
    const id = request.request_id;
    const received = this.deps.now();
    const outcome = await this.forward(request);
    this.deps.log.info('Decision answered', {
      requestId: id,
      ok: outcome.ok,
      ...(outcome.ok ? { modelMs: outcome.model_ms } : { code: outcome.error.code }),
      ms: this.deps.now() - received,
    });
    return outcome;
  }

  /** Stops the model server and any download, for the controller's exit. */
  async close(): Promise<void> {
    this.closed = true;
    await this.stopWork();
  }

  private async forward(request: DecisionRequestFrame): Promise<DecisionResult> {
    const id = request.request_id;
    if (request.deadline_ms <= 0)
      return result(id, 'deadline', 'The decision’s deadline had passed when it arrived.');
    if (request.kind !== 'llamacpp')
      return result(id, 'not_running', 'This machine serves llama.cpp decision models only.');
    const server = this.server;
    if (this.state !== 'running' || !server)
      return result(
        id,
        'not_running',
        `The decision model on this machine is ${this.state === 'off' && this.turnedOff() ? 'turned off on the machine' : this.state}.`
      );
    if (request.model !== this.model)
      return result(
        id,
        'not_running',
        `This machine serves ${this.model ?? 'no model'}, not ${request.model}.`
      );
    if (this.inFlight >= MAX_IN_FLIGHT)
      return result(id, 'busy', `This machine is already answering ${MAX_IN_FLIGHT} decisions.`);
    this.inFlight++;
    const started = this.deps.now();
    const deadline = AbortSignal.timeout(request.deadline_ms);
    try {
      const response = await this.deps.fetch(
        `http://127.0.0.1:${server.port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${server.apiKey}`,
          },
          body: JSON.stringify(request.payload),
          signal: deadline,
        }
      );
      if (!response.ok) {
        await response.body?.cancel();
        return result(id, 'model_server_error', `The model server answered ${response.status}.`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (deadline.aborted) throw error;
        return result(id, 'model_server_error', 'The model server’s answer is not JSON.');
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body))
        return result(id, 'model_server_error', 'The model server’s answer is not a JSON object.');
      const modelMs = Math.max(0, Math.round(this.deps.now() - started));
      this.lastDecisionMs = modelMs;
      return {
        type: 'decision.result',
        request_id: id,
        ok: true,
        body: body as Record<string, unknown>,
        model_ms: modelMs,
      };
    } catch (error) {
      if (deadline.aborted)
        return result(
          id,
          'deadline',
          `The model server did not answer within ${request.deadline_ms} ms.`
        );
      // The error names the request's failure, never its payload.
      return result(
        id,
        'model_server_error',
        `The model server could not be reached: ${errorMessage(error)}`
      );
    } finally {
      this.inFlight--;
    }
  }

  private turnedOff(): boolean {
    if (this.deps.override !== null) return this.deps.override === 'off';
    return !this.localEnabled;
  }

  /** Reads the owner's switch; resolves whether it changed. */
  private async readSetting(): Promise<boolean> {
    const setting = await readLocalSetting(this.deps.layout);
    if (setting.problem) this.deps.log.error(`${setting.problem}; decision work is off.`);
    const changed = setting.enabled !== this.localEnabled;
    this.localEnabled = setting.enabled;
    return changed;
  }

  private recentCrashes(): number {
    const since = this.deps.now() - this.deps.timing.crashWindowMs;
    this.crashes = this.crashes.filter((at) => at >= since);
    return this.crashes.length;
  }

  private setState(
    state: DecisionState,
    fields: { model?: string | null; failure?: Failure | null; reason?: DecisionReason | null } = {}
  ): void {
    const model = fields.model === undefined ? this.model : fields.model;
    const failure = fields.failure === undefined ? null : fields.failure;
    const reason = fields.reason === undefined ? null : fields.reason;
    const changed =
      state !== this.state ||
      model !== this.model ||
      failure?.reason !== this.failure?.reason ||
      failure?.detail !== this.failure?.detail ||
      reason !== this.reason;
    if (state !== this.state) this.since = this.deps.now();
    if (state !== 'downloading') this.progress = null;
    this.state = state;
    this.model = model;
    this.failure = failure;
    this.reason = reason;
    if (!changed) return;
    this.deps.log.info('Decision model state', {
      state,
      model,
      ...(failure ? { reason: failure.reason, detail: failure.detail } : {}),
      ...(reason ? { reason } : {}),
    });
    this.deps.onChange();
  }

  /** Moves toward what is wanted now, after any move already under way. */
  private apply(): void {
    this.applying = this.applying
      .then(() => this.applyNow())
      .catch((error: unknown) =>
        this.deps.log.error('Could not apply the decision model setting', {
          error: errorMessage(error),
        })
      );
  }

  /** Resolves once every change asked for so far has been acted on. */
  settledChanges(): Promise<void> {
    return this.applying;
  }

  /** Off, or one model served: whichever is wanted when this runs. */
  private async applyNow(): Promise<void> {
    if (this.closed || !this.machine) return;
    if (this.turnedOff()) {
      this.appliedRevision = this.desired?.revision ?? null;
      this.setState('off', { model: null, reason: 'turned_off_on_machine' });
      await this.stopWork();
      return;
    }
    const desired = this.desired;
    if (!desired) {
      this.appliedRevision = null;
      this.setState('off', { model: null });
      await this.stopWork();
      return;
    }
    const model = catalogueModel(this.deps.catalogue, desired.model);
    const build = model ? buildFor(this.deps.catalogue, this.machine, model) : null;
    if (!model || !build) {
      await this.stopWork();
      this.appliedRevision = desired.revision;
      this.setState('failed', {
        model: desired.model,
        failure: {
          reason: 'unsupported_hardware',
          detail: model
            ? `${model.label} does not run on this machine (${this.machine.hardware.accelerator}, ${gigabytes(this.machine.hardware.memory_bytes)} of memory).`
            : `This controller does not know the model ${desired.model}; update it.`,
        },
      });
      return;
    }
    if (this.work?.model.id === model.id) {
      if (this.state === 'running' && this.appliedRevision !== desired.revision) {
        this.appliedRevision = desired.revision;
        this.deps.onChange();
      }
      return;
    }
    if (this.settled?.model === model.id && this.settled.revision === desired.revision) return;
    this.settled = null;
    await this.stopWork();
    this.begin(model, build);
  }

  private begin(model: CatalogueModel, build: RuntimeBuild): void {
    const abort = new AbortController();
    const work: Work = { model, abort, done: Promise.resolve() };
    this.work = work;
    this.crashes = [];
    work.done = this.serve(model, build, abort.signal)
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        this.deps.log.error('The decision model stopped unexpectedly', {
          error: errorMessage(error),
        });
        this.settle(model, abort.signal, {
          reason: 'model_server_crashed',
          detail: errorMessage(error),
        });
      })
      .finally(() => {
        if (this.work === work) this.work = null;
      });
  }

  private async stopWork(): Promise<void> {
    const work = this.work;
    if (!work) return;
    work.abort.abort();
    await work.done;
  }

  /** Prepares and serves `model` until `signal` fires or it fails for good. */
  private async serve(
    model: CatalogueModel,
    build: RuntimeBuild,
    signal: AbortSignal
  ): Promise<void> {
    this.workState(signal, 'downloading', { model: model.id });
    let retry = this.deps.timing.downloadRetryMs;
    let files: { binary: string; libraryDirs: string[]; modelFile: string };
    for (;;) {
      try {
        files = await this.prepare(model, build, signal);
        break;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ChecksumMismatch) {
          this.settle(model, signal, { reason: 'checksum_mismatch', detail: error.message });
          return;
        }
        if (error instanceof NotEnoughDisk) {
          this.workState(signal, 'failed', {
            model: model.id,
            failure: { reason: 'not_enough_disk', detail: error.message },
          });
          await sleep(this.deps.timing.diskRetryMs, signal).catch(() => {});
        } else {
          this.workState(signal, 'failed', {
            model: model.id,
            failure: { reason: 'download_failed', detail: errorMessage(error) },
          });
          await sleep(retry, signal).catch(() => {});
          retry = Math.min(retry * 2, this.deps.timing.downloadRetryMaxMs);
        }
        if (signal.aborted) return;
        this.workState(signal, 'downloading', { model: model.id });
      }
    }
    await this.run(model, build, files, signal);
  }

  /** Leaves the model failed until the assignment's next revision. */
  private settle(model: CatalogueModel, signal: AbortSignal, failure: Failure): void {
    if (signal.aborted) return;
    this.settled = { model: model.id, revision: this.desired?.revision ?? -1 };
    this.appliedRevision = this.desired?.revision ?? null;
    this.setState('failed', { model: model.id, failure });
  }

  /** A state the work for a model reached, unless that work was stopped meanwhile. */
  private workState(
    signal: AbortSignal,
    state: DecisionState,
    fields: { model: string; failure?: Failure }
  ): void {
    if (!signal.aborted) this.setState(state, fields);
  }

  /** Runs the model server, starting it again after a crash, until stopped or crashed too often. */
  private async run(
    model: CatalogueModel,
    build: RuntimeBuild,
    files: { binary: string; libraryDirs: string[]; modelFile: string },
    signal: AbortSignal
  ): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      this.workState(signal, 'starting', { model: model.id });
      let server: ModelServerHandle;
      try {
        server = await this.deps.launch({
          binary: files.binary,
          libraryDirs: files.libraryDirs,
          modelFile: files.modelFile,
          contextSize: model.contextSize,
          parallel: model.parallel,
          gpuLayers: build.gpuLayers,
          threads: build.runtime === 'llamacpp-cpu' ? this.deps.cpuThreads : null,
        });
      } catch (error) {
        throw new LaunchFailed(`The model server could not be started: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      if (server.pid !== null)
        await this.deps.stale.record(server.pid, files.binary).catch(() => {});
      const exit = await this.serveOnce(model, server, signal);
      await this.deps.stale.clear().catch(() => {});
      if (exit === null || signal.aborted) return;
      this.crashes.push(this.deps.now());
      const crashes = this.recentCrashes();
      const reason: DecisionReason = exit.outOfMemory ? 'out_of_memory' : 'model_server_crashed';
      const how =
        exit.code !== null
          ? `exited with code ${exit.code}`
          : exit.signal
            ? `was ended by ${exit.signal}`
            : 'ended';
      if (crashes >= this.deps.timing.crashLimit) {
        this.settle(model, signal, {
          reason,
          detail: `The model server ${how}, its ${crashes}th crash in ${Math.round(this.deps.timing.crashWindowMs / 60_000)} minutes; it is left stopped until the setting changes.`,
        });
        return;
      }
      const backoff = this.deps.timing.crashBackoffMs;
      const wait = backoff[Math.min(crashes - 1, backoff.length - 1)] ?? 0;
      this.deps.log.warn('The decision model server stopped; starting it again', {
        model: model.id,
        reason,
        how,
        retryInMs: wait,
      });
      this.workState(signal, 'starting', { model: model.id });
      await sleep(wait, signal).catch(() => {});
    }
  }

  /**
   * Waits for one launched server to be ready, warms it, serves until it
   * exits or `signal` fires. Resolves with how it exited, or null when it
   * was stopped on purpose.
   */
  private async serveOnce(
    model: CatalogueModel,
    server: ModelServerHandle,
    signal: AbortSignal
  ): Promise<ModelServerExit | null> {
    const stopped = new Promise<null>((resolve) => {
      if (signal.aborted) resolve(null);
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    try {
      try {
        await waitHealthy({
          fetch: this.deps.fetch,
          server,
          timeoutMs: this.deps.timing.healthTimeoutMs,
          intervalMs: this.deps.timing.healthIntervalMs,
          signal,
        });
        await this.warmUp(server, signal);
      } catch (error) {
        if (signal.aborted) return null;
        if (error instanceof ModelServerEnded) return error.exit;
        this.deps.log.warn('The decision model server did not become ready; stopping it', {
          error: errorMessage(error),
        });
        await server.stop();
        return await server.exited;
      }
      if (signal.aborted) return null;
      this.server = server;
      this.appliedRevision = this.desired?.revision ?? null;
      this.workState(signal, 'running', { model: model.id });
      return await Promise.race([server.exited, stopped]);
    } finally {
      if (this.server === server) this.server = null;
      await server.stop();
    }
  }

  private async warmUp(server: ModelServerHandle, signal: AbortSignal): Promise<void> {
    const response = await this.deps.fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.apiKey}` },
      body: JSON.stringify(WARM_UP_PAYLOAD),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.deps.timing.healthTimeoutMs)]),
    });
    await response.body?.cancel();
    if (!response.ok)
      throw new Error(`The model server answered the warm-up decision with ${response.status}.`);
  }

  /** The build and weights on disk, downloading and unpacking what is missing. */
  private async prepare(
    model: CatalogueModel,
    build: RuntimeBuild,
    signal: AbortSignal
  ): Promise<{ binary: string; libraryDirs: string[]; modelFile: string }> {
    const { layout } = this.deps;
    await mkdir(layout.models, { recursive: true, mode: 0o700 });
    await mkdir(layout.runtime, { recursive: true, mode: 0o700 });
    const buildDir = join(layout.runtime, `${build.version}-${build.runtime}`);
    const modelFile = join(layout.models, `${model.file.sha256}.gguf`);
    const unpacked = await exists(join(buildDir, build.binary));
    const pending: { artifact: Artifact; target: string; part: string; held: number }[] = [];
    if (!unpacked)
      for (const archive of build.archives)
        pending.push(await this.pendingFile(archive, layout.runtime, '.tar.gz'));
    if ((await sizeOf(modelFile)) !== model.file.bytes)
      pending.push(await this.pendingFile(model.file, layout.models, '.gguf'));
    const total = pending.reduce((sum, file) => sum + file.artifact.bytes, 0);
    const missing = pending.reduce((sum, file) => sum + file.artifact.bytes - file.held, 0);
    const unpack = unpacked
      ? 0
      : build.archives.reduce((sum, archive) => sum + archive.bytes * UNPACK_FACTOR, 0);
    if (missing > 0 || unpack > 0) {
      const needed = missing + unpack + DISK_HEADROOM_BYTES;
      const free = await this.deps.diskFree(layout.root);
      if (free < needed) throw new NotEnoughDisk(needed, free);
    }
    let before = 0;
    for (const file of pending) {
      const base = before;
      await downloadArtifact({
        fetch: this.deps.fetch,
        artifact: file.artifact,
        target: file.target,
        part: file.part,
        signal,
        stallTimeoutMs: this.deps.timing.stallTimeoutMs,
        onProgress: (done) => this.setProgress(base + done, total),
      });
      before += file.artifact.bytes;
    }
    if (!unpacked) {
      const staging = await mkdtemp(join(layout.runtime, '.unpack-'));
      try {
        for (const archive of build.archives)
          await this.deps.extract(join(layout.runtime, `${archive.sha256}.tar.gz`), staging);
        if (!(await exists(join(staging, build.binary))))
          throw new Error(`The llama.cpp ${build.version} archive holds no ${build.binary}.`);
        await rm(buildDir, { recursive: true, force: true });
        await rename(staging, buildDir);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      for (const archive of build.archives)
        await rm(join(layout.runtime, `${archive.sha256}.tar.gz`), { force: true });
    }
    return {
      binary: join(buildDir, build.binary),
      libraryDirs: build.libraryDirs.map((dir) => join(buildDir, dir)),
      modelFile,
    };
  }

  private async pendingFile(artifact: Artifact, dir: string, suffix: string) {
    const target = join(dir, `${artifact.sha256}${suffix}`);
    const part = join(dir, `${artifact.sha256}.part`);
    const held =
      (await sizeOf(target)) === artifact.bytes ? artifact.bytes : ((await sizeOf(part)) ?? 0);
    return { artifact, target, part, held: Math.min(held, artifact.bytes) };
  }

  private setProgress(done: number, total: number): void {
    const before = this.progress;
    this.progress = { done_bytes: done, total_bytes: total };
    // A report for every 5% moved, not every chunk.
    const step = (value: number) => Math.floor((value / Math.max(total, 1)) * 20);
    if (!before || step(before.done_bytes) !== step(done)) this.deps.onChange();
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await sizeOf(path)) !== null;
}
