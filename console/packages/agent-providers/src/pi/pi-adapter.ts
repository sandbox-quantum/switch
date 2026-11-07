/**
 * The Pi adapter (#777 plan, stage 5): drives `pi --mode rpc` (Pi 1.4.0) for Switch sessions.
 *
 * What it builds on, and what it adds (READY §2.2, §2.5; `ready_errata.md` ER-02, ER-06, ER-07,
 * ER-08; decisions Q1 A, Q2 A′, Q4 A, D-4 A, D-7 A, D-10 A + A5):
 * - Every Pi is prepared by `preparePiLaunch` (`./pi-launch.ts`: executable, version, profile,
 *   migrations, MCP names, environment, arguments) and started with exactly what it returns. The
 *   arguments come from `piArgs` alone: `-ne -e <bridge> -e builtin:mcp`, the bridge first and no
 *   other extension (D-4 A, D-7 A). A launch refusal is a `ProviderSessionError`.
 * - Before any `prompt` the bridge's handshake command must be listed by `get_commands`; without
 *   it no prompt is ever sent (the session does not start).
 * - The bridge announces each Pi run with `notify("switch:<nonce>:run:<n>")` in
 *   `before_agent_start`, before Pi answers the `prompt` (P-01). The adapter binds `<n>` to the
 *   turn whose `prompt` it sent and keeps no count of its own (ER-02). Events from the `prompt`
 *   until that binding are held and handed to the turn once it is bound (a compaction before the
 *   run is the turn's, `pi-events.ts`).
 * - A turn ends on `agent_settled` (`PiTurnMapper`), or, for the ends that never reach it, on the
 *   `prompt` answer: `handled`, a failure before or after `before_agent_start` (P-02: the run's
 *   number is then spent), or the process going away (ER-02).
 * - Approvals (READY §2.2 rule 1, then `decidePiToolCall`): a `confirm` must carry this
 *   generation's nonce and the run bound to the active, not interrupted, turn; anything else is
 *   answered `cancelled` without a card and its item ends `declined`. A card's answer reaches Pi
 *   only while the card is open: an interrupt, the end of the turn or of the process cancels it
 *   (`request.resolved: cancel`), and a later answer finds nothing to unblock.
 * - Dialogs other than `confirm` (`select`, `input`, `editor`: `/mcp` sign-in and the like) are
 *   always answered `cancelled`: Switch does not sign in to MCP servers through Pi's
 *   `mcp-auth.json`, which the next start would refuse (`p1_stage4_fix2_impl.md`).
 * - Processes (ER-06, Q1 A): the bridge's own `bash` writes every shell's process group to the
 *   registry of its launch (`./pi-bash.ts`). Stopping the session stops Pi, then kills every
 *   registered group of every generation of the session and checks that none is left. An
 *   interrupt kills only the groups of the interrupted run and reports what earlier commands left
 *   running (or that their state is unknown) with a `runtime.warning`. Pi going away by itself
 *   (D-10 A5: Pi 1.4.0 dies when it cannot write a long command output to its temporary
 *   directory, upstream #10585) ends the turn with an error that says so and kills the groups it
 *   left behind. Cleanup that cannot be confirmed blocks the next generation and the next turn
 *   until it can. The session stays busy while an ended turn is cleaned up: no turn starts, no
 *   prompt is sent, no Pi is started again before the cleanup's result is known (R1-A). A Pi
 *   that did not exit when stopped may still live: nothing of its launch is removed and nothing
 *   starts on its conversation until its exit is confirmed (R1-B). What a stop could not confirm
 *   is recorded beside the conversation (`<X>.cleanup.json`, `./pi-conversation.ts`) before the
 *   conversation is let go, and every start of it, in any adapter, tries again first (R1-E). A
 *   prompt Pi did not answer in time has an unknown outcome: that Pi is stopped like one whose
 *   interrupt did not settle, and the next turn runs in a new one (R1-H); so is one whose
 *   `set_model` Pi did not confirm (R2-C). Processes are read from procfs, or with `ps` where
 *   there is none (R1-I).
 * - Pi counts as gone only once its exit is confirmed: `dispose` saw the process exit, or no
 *   process of its launch is left. The end of its RPC link (a failed stream ends it as an exit
 *   does, `pi-rpc.ts` `handleStreamError`) is not an exit: nothing of its launch or conversation
 *   is let go before that confirmation (R2-A). A process is gone only when procfs says so
 *   (`ENOENT`, `ESRCH`); one Switch cannot read counts as possibly running, unless procfs shows
 *   it is another user's (R3-A).
 * - What runs in the background is surveyed over every generation of the session, shells
 *   recorded only as intended included; what cannot be seen counts as running (R2-D). A message
 *   sent while Switch waits for something is refused when the session was stopped meanwhile;
 *   it is never left in the queue of a session that is gone (R2-E).
 * - Resume (ER-07, Q2 A′): a new session is `--session-dir <state>/sessions --session-id <X>`
 *   and `nativeSessionId` is `<X>`; a resumed one is `--session <file>` for the transcript of
 *   `<X>` in that directory (the one file, or the one `<X>.map.json` names after a recovery),
 *   after it was checked (`validatePiSessionFile`). A transcript Switch cannot vouch for is a
 *   `ProviderConversationUnavailableError` with the reason; never a silent new session. One whose
 *   last line is cut off names the command of the procedure that recovers it (SC26,
 *   `pi-recover.mjs`). A session holds its conversation exclusively (`<X>.lock`) from start to
 *   stop.
 * - A stop while the session starts ends the start: nothing is reported ready and no Pi is left
 *   (R1-F), nor its launch directory, whenever the stop comes (R3-D). A session ends once: every
 *   stop of it waits for that end, cleanup and `session.exited` included (R3-C), and that end
 *   waits for what the session still does: a Pi being prepared (ended, its launch directory
 *   removed), a cleanup under way (R4-B). Switch's context goes with the first message Pi took
 *   (R1-G).
 * - One life of a session (R5): every asynchronous operation of a session (the start, a turn with
 *   the choice of its transcript and the preparation of its Pi, the cleanup after a turn, a model
 *   switch and its `retire`, a blocked cleanup checked again) runs through `run`, which records it
 *   before its first wait; every wait of it is followed by a check that ends it once the session
 *   ends; what it made and no generation took is removed as it ends. The end of the session
 *   (`end`, the one place that lets the conversation go) waits for every one of them, then
 *   accounts for what is left: a launch directory that could not be removed is recorded and keeps
 *   the conversation with this host until a later stop settles it (R5-C). The record of cleanup
 *   keeps the identity of the host that made each launch and says when every process of one
 *   ended, so that it is settled without the launch directory, and the sweep of dead hosts settles
 *   it with the record instead of removing it behind its back (R5-B).
 * - One owner of what an ended session leaves to do (D-16 A′): a duty of this adapter (`Duty`),
 *   with its own identity, outlives the session: the removal of launch directories nothing of
 *   which runs, the record of what is still unconfirmed, the release of the conversation, each
 *   tried again on its own (a stop of that session id, `stopAll`, a start of the conversation
 *   here) until done; the release goes last and only once it is durably written (R6-C). A lock is
 *   the session's from the moment its entry was made (D16-C1). No I/O failure ends the end of a
 *   session early (R6-A), and a message is accepted only in one step with the last check of the
 *   session (R6-B).
 * - A launch's owner (`owner.json`) is the identity the conversation's lock was taken with; with no
 *   start time known, no Pi starts. A launch whose owner is not resolved (no start time, an
 *   `owner.json` that cannot be read or is damaged) blocks its conversation, or every one of the
 *   state directory when it names none, until nothing of it is seen to live (R4-A).
 * - Models (ER-08, Q4 A): a session needs a model (`provider/id`); after start Pi's `get_state`
 *   must name it and `get_available_models` must list it. A start with no model, no MCP server and
 *   no resume is the model discovery of `host/shared-daemon.ts:40-60`: a Pi with `--no-session`
 *   that only answers `listModels`. `sendTurn.model` other than the current one is `set_model`
 *   before the prompt. A `set_model` answered with an error is a refusal only when `get_state`
 *   then names the model the session runs; otherwise its outcome is unknown (R3-B, as R2-C).
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import type { ModelChoice } from '@switch-console/shared/session-v1';
import type {
  ModelSelection,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '../adapter';
import { ProviderConversationUnavailableError, ProviderSessionError } from '../adapter';
import type { ApprovalDecision, ProviderRuntimeEvent, UserInputAnswers } from '../events';
import { noopLogger, type ProviderLogger } from '../transport/stdio-json-rpc';
import {
  piBridgeHandshakeCommand,
  PI_BRIDGE_CONFIG_ENV,
  PI_BRIDGE_ERROR_NOTICE,
  type PiBridgeConfirmMessage,
} from './bridge';
import { PiArgsError, type PiSessionTarget } from './pi-args';
import {
  PI_BASH_MARKER_ENV,
  piProcSource,
  readPiBashRegistry,
  readPiProcStat,
  readPiPsLabelled,
  readPiPsTable,
  signalPiBashGroup,
  type PiBashGroup,
  type PiBashIntent,
} from './pi-bash';
import {
  piConversationStore,
  piRecoverSource,
  PI_RECOVER_SCRIPT,
  type PiConversationStore,
  type PiPendingLaunch,
  type PiTranscriptCheck,
} from './pi-conversation';
import { PiTurnMapper, type PiTurnEvent } from './pi-events';
import {
  PI_RUN_PREPARING_PREFIX,
  piStateDir,
  PiLaunchError,
  preparePiLaunch,
  type PiLaunch,
} from './pi-launch';
import { decidePiToolCall, type PiPolicySession } from './pi-policy';
import { PiProfileError } from './pi-profile';
import { PiRpcClient, PiRpcError, type PiRpcEvent } from './pi-rpc';
import { PiVersionError, PI_VERSION } from './pi-version';

export interface PiAdapterOptions {
  /** The Pi executable; `pi` on PATH when undefined. */
  binaryPath?: string | undefined;
  logger?: ProviderLogger;
  /** How long an interrupted run may take to settle before Pi is stopped (default 10 s). */
  interruptTimeoutMs?: number;
  /** How long a killed process group may take to empty (default 3 s). */
  cleanupTimeoutMs?: number;
  /** How long Pi may take to answer a command while a session starts (default 30 s). */
  startTimeoutMs?: number;
  /** How long Pi may take to answer `prompt` (default 15 min); after it the outcome is unknown. */
  promptTimeoutMs?: number;
  /** Root of procfs (default `/proc`); where there is none, processes are read with `ps`. */
  procRoot?: string;
  /** The `ps` used without procfs (default `ps` on PATH). */
  ps?: string;
  /**
   * The user Switch's processes run as (default this process's): a process that cannot be read is
   * another user's, not Switch's, only when procfs shows it is not this user's (R3-A).
   */
  uid?: number;
}

const PROVIDER = 'pi';
const DEFAULT_INTERRUPT_TIMEOUT_MS = 10_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 3_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
/** Pi answers `prompt` once the run is prepared, which may include a compaction. */
const DEFAULT_PROMPT_TIMEOUT_MS = 15 * 60_000;
/** Pi's own rule for a session id (`dist/core/session-manager.js:15-19`; `pi-args.ts`). */
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const NEEDS_MODEL =
  'A Pi agent needs a model: choose one (provider/model) in the agent’s settings. Switch does not let Pi pick one by itself.';

type Emittable<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

interface PiModel {
  provider: string;
  id: string;
  name?: string;
  input?: string[];
}

/** One Pi process of a session: its launch, its client, and the runs the bridge announced. */
interface Generation {
  number: number;
  client: PiRpcClient;
  launch: PiLaunch;
  nonce: string;
  registry: string;
  /** Value of `SWITCH_PI_BRIDGE` in the Pi's environment: finds the Pi itself (R1-B, R1-E). */
  bridgeConfig: string;
  /** Switch is stopping this process itself; its exit is expected. */
  retiring: boolean;
  /**
   * The process is gone, confirmed: `dispose` saw it exit (`pi-rpc.ts`: the child's `exit`), or
   * no live process carries its launch's `SWITCH_PI_BRIDGE` (`confirmExit`). Only `confirmExit`
   * sets it.
   */
  exited: boolean;
  /**
   * Its RPC link ended (`PiRpcClient` `onExit`): the process exited, or a stream failed while it
   * may still run (`pi-rpc.ts:422-425`). Nothing more reaches it; it is not an exit (R2-A).
   */
  linkLost: boolean;
  /** Switch stopped it and `dispose` failed: it may still live (R1-B). */
  stuck: boolean;
  /** Highest run number the bridge announced in this process. */
  lastRun: number;
}

interface OpenRequest {
  uiId: string;
  toolCallId: string;
  generation: number;
  turnId: string;
}

interface Turn {
  input: ProviderSendTurnInput;
  turnId: string;
  mapper: PiTurnMapper;
  generation: number | null;
  /** The run the bridge announced for this turn's prompt; null until then. */
  run: number | null;
  promptSent: boolean;
  /** The generation's last announced run when the prompt went out: later runs are this turn's. */
  runFloor: number;
  /** Events written after the prompt and before the run was bound. */
  held: PiRpcEvent[];
  interrupted: boolean;
  /** The turn's Pi is stopped when the turn ends: an interrupt that did not settle, an unanswered prompt. */
  retire: boolean;
  interruptTimer: ReturnType<typeof setTimeout> | null;
  /** Tool calls Pi started and did not end yet (D-10 A5: what was running when Pi died). */
  running: Map<string, string>;
}

interface Session {
  id: string;
  input: ProviderSessionStartInput;
  discovery: boolean;
  /** Pi's session id `<X>`, also the `nativeSessionId`. */
  piSessionId: string;
  stateDir: string;
  sessionDir: string;
  generations: Generation[];
  /** The model as Switch names it, `provider/id`. */
  model: string;
  /** Pi's bare id of it, as assistant messages name it (for the mapper's usage). */
  modelId: string;
  /** A model to switch to before the next prompt (set while a turn ran). */
  pendingModel: ModelSelection | null;
  policy: PiPolicySession;
  queue: ProviderSendTurnInput[];
  turn: Turn | null;
  requests: Map<string, OpenRequest>;
  context: string;
  stopping: boolean;
  /** Stopped while it started: the start ends without a session (R1-F). */
  cancelled: boolean;
  /**
   * R3-C: the end of the session under way (a stop, `stopAll`, Pi's own end, a stop of its
   * start): every caller waits for this one, which settles after the cleanup and `session.exited`.
   */
  ending: Promise<void> | null;
  /**
   * An ended turn is being cleaned up (R1-A), or the model is switched outside a turn (R2-C): no
   * turn starts until the result is known.
   */
  cleaning: boolean;
  /** R5: the operation of a turn is under way (also after its turn ended): no other turn starts. */
  turning: boolean;
  /** Cleanup that could not be confirmed: no turn until it is (ER-06). */
  blocked: { reason: string; recheck: () => Promise<CleanupResult> } | null;
  /**
   * Commands of every generation still alive at the end of the last turn, and those whose state
   * cannot be seen (R2-D).
   */
  background: { alive: number; unknown: number };
  releaseLock: (() => void) | null;
  /**
   * R4-A: the procfs start time this host took the conversation's lock with, written as the owner
   * of every launch of the session (`owner.json`); null for a discovery, which writes none.
   */
  ownerStart: string | null;
  /**
   * R5 (R4-B): every operation of the session under way (`PiAdapter.run`: the start, a turn, the
   * preparation of a Pi, a cleanup, a model switch, a cleanup checked again). Its end waits for
   * all of them before it lets the conversation go.
   */
  tasks: Set<SessionTask>;
  /**
   * R5-C: what an operation could not clean up (a launch directory it made that could not be
   * removed), for the end of the session to account for: recorded, and the conversation kept.
   */
  leftovers: Array<{ launch: PiPendingLaunch; reason: string }>;
  /**
   * R5: the waits of the session's operations on its Pi (`SessionOperation.ask`): the end of the
   * session ends each of them at once (it stops that Pi, which answers nothing more).
   */
  halts: Set<() => void>;
  started: boolean;
}

/** R5: an operation of a session under way; `done` settles once it ended and cleaned up after itself. */
interface SessionTask {
  done: Promise<void>;
}

/**
 * R5: an operation of a session went no further because the session is ending (or its start was
 * stopped): what it made is removed by `PiAdapter.run`, the rest by the end of the session.
 */
class SessionStoppedError extends ProviderSessionError {}

/**
 * R5: what an operation of a session uses to see the session (`PiAdapter.run`). `check` throws
 * once the session is ending (the operation goes no further, its own cleanup still runs). `wait`
 * is an await followed by that check, whether the awaited work succeeded or not; `keep` takes what
 * the work made (a launch directory) before that check, so that a stop meanwhile never leaves it
 * unaccounted for. `ask` is a wait on Pi, which the end of the session also ends at once. `hold`
 * makes a launch directory the operation's own until a generation takes it (`release`): whatever
 * ends the operation before that removes it, and what cannot be removed is the session's to
 * account for (`Session.leftovers`).
 */
class SessionOperation {
  readonly held = new Map<string, PiPendingLaunch>();
  constructor(
    private readonly checkSession: () => void,
    private readonly halts: Set<() => void>
  ) {}
  check(): void {
    this.checkSession();
  }
  async wait<T>(work: Promise<T>, keep?: (value: T) => void): Promise<T> {
    let value: T;
    try {
      value = await work;
    } catch (error) {
      this.check();
      throw error;
    }
    keep?.(value);
    this.check();
    return value;
  }
  ask<T>(request: Promise<T>): Promise<T> {
    let leave = () => {};
    const ended = new Promise<never>((_resolve, reject) => {
      const halt = () => reject(new Error('the session ended'));
      this.halts.add(halt);
      leave = () => this.halts.delete(halt);
    });
    return this.wait(Promise.race([request, ended]).finally(leave));
  }
  hold(launch: PiPendingLaunch): void {
    this.held.set(launch.runDir, launch);
  }
  release(runDir: string): void {
    this.held.delete(runDir);
  }
}

/**
 * D-16 (A′): what a session leaves this adapter to do once it ended, with one owner (`PiAdapter`'s
 * ledger, `duties`) that outlives the session. R5-C: a conversation is kept while something of it
 * could not be cleaned up. A duty has three kinds of step, each tried again on its own until it is
 * done: remove a launch directory nothing of which runs or ran (`remove`: its processes were
 * confirmed gone, or no Pi ran in it; recorded as ended), write launches into the record of
 * cleanup (`unrecorded`: the durable hand-over of what is still unconfirmed, which every start of
 * the conversation, in any adapter, tries first), let the conversation go (`release`, the lock's
 * own release, R6-C: tried again until it is durably released). The lock goes last, once nothing
 * of this host is left unrecorded or unremoved, so that no one takes the conversation meanwhile.
 * A duty leaves the ledger only once every step is done. D16-C2: it has its own identity (`id`);
 * the session id only finds it (a later session may take that id for another conversation, and
 * the duty of the earlier one stays). D16-C1: a lock taken and not finished, or one whose session
 * never started, is a duty too (`release` only). Tried again by a stop of that session id,
 * `stopAll`, and a start of the conversation here.
 */
interface Duty {
  readonly id: number;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly piSessionId: string;
  remove: PiPendingLaunch[];
  unrecorded: PiPendingLaunch[];
  release: (() => void) | null;
  trying: Promise<string[]> | null;
}

/** What killing registered process groups achieved. */
export interface CleanupResult {
  /** Every group asked for is gone, as far as procfs shows. */
  confirmed: boolean;
  /** Groups signalled now. */
  killed: number;
  /** Why some could not be confirmed (`toolCallId: reason`). */
  unconfirmed: string[];
}

/**
 * The runs of a turn: the one the bridge announced for it, or, while none was bound, every run
 * announced after its prompt went out (none of them can be an earlier turn's).
 */
function turnRuns(turn: Turn): (run: number) => boolean {
  const bound = turn.run;
  const floor = turn.runFloor;
  return bound !== null ? (run) => run === bound : (run) => turn.promptSent && run > floor;
}

const CAPABILITIES: ProviderCapabilities = {
  // `set_model` over RPC changes the model without writing settings (`agent-session.js:2008-2019`,
  // no `persist`; `rpc-mode.js:365-373`).
  modelSwitchInSession: true,
  steering: false,
  resume: true,
  approvals: true,
  userInput: false,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A `set_model` whose outcome is unknown (R2-C): unanswered in time or cut off (Pi may still
 * switch: it checks the sign-in before it does, `agent-session.js:2009-2024`, and a timed-out
 * command is not cancelled, `pi-rpc.ts:201-205`), or answered with another model. Which model
 * that Pi runs is unknown: it gets no prompt again.
 */
class PiModelUnknownError extends Error {}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? errorText(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `provider/id` as Pi's `--model` takes it; the provider never holds `/`, the id may. */
function splitModel(id: string): { provider: string; modelId: string } | null {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

function modelName(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

function piModel(value: unknown): PiModel | null {
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.id !== 'string')
    return null;
  return {
    provider: value.provider,
    id: value.id,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(Array.isArray(value.input) ? { input: value.input.map(String) } : {}),
  };
}

/** `get_available_models` (`rpc-mode.js:381-384`): the models whose provider has a sign-in. */
function modelChoices(data: unknown): ModelChoice[] {
  const models = isRecord(data) && Array.isArray(data.models) ? data.models : [];
  const choices: ModelChoice[] = [];
  for (const entry of models) {
    const model = piModel(entry);
    if (!model) continue;
    choices.push({
      id: modelName(model),
      label: model.name ? `${model.name} (${model.provider})` : modelName(model),
      options: {},
      imageInput: model.input ? model.input.includes('image') : null,
    });
  }
  return choices;
}

export type { PiTranscriptCheck } from './pi-conversation';

/**
 * Checks a Pi transcript before Pi is given it (ER-07, EQ-04; P-04: Pi rejects nothing itself but
 * a missing directory): a regular file, not a link, whose text `checkText` of
 * `./pi-conversation.ts` accepts (header, entries, references, no cut-off last line, Q2 A′).
 */
export async function validatePiSessionFile(
  file: string,
  expected: { id: string; cwd: readonly string[] },
  store: PiConversationStore = piConversationStore({ procSource: piProcSource })
): Promise<PiTranscriptCheck> {
  const refuse = (reason: string): PiTranscriptCheck => ({ ok: false, reason, cutOff: false });
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    return refuse(`cannot be read (${errorCode(error)})`);
  }
  if (info.isSymbolicLink()) return refuse('is a symbolic link, not the file Pi wrote');
  if (!info.isFile()) return refuse('is not a regular file');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return refuse(`cannot be read (${errorCode(error)})`);
  }
  return store.checkText(text, expected);
}

/** Where processes are read: procfs, or `ps` where there is no procfs (R1-I, D-15). */
interface ProcessView {
  procRoot: string;
  ps: string;
  /** The user Switch's processes run as; undefined where there is none (then nothing is foreign). */
  uid: number | undefined;
  /** D-15: `ps` was given (tests that hide procfs): then any root without `self` is no procfs. */
  psGiven: boolean;
}

const SYSTEM_PROC_ROOT = '/proc';
const DEFAULT_VIEW: ProcessView = {
  procRoot: SYSTEM_PROC_ROOT,
  ps: 'ps',
  uid: process.getuid?.(),
  psGiven: false,
};

/**
 * D-15, R7-C: where this view reads processes, by the one rule of the bridge and of the checks of
 * groups (`piProcSource` of `./pi-bash.ts`, which the store uses too), by what is there, not by
 * platform: `procfs` (also one with processes but no `self`, and one that cannot be listed: its
 * reads fail and count as unseen), `ps` (no procfs: a root that does not exist, or an empty
 * system root or any empty root when `ps` was given), or `none` (an empty root someone passed
 * without `ps`, Codex A12: no source at all, so nothing is seen and nothing is confirmed).
 */
function procSource(view: ProcessView): 'procfs' | 'ps' | 'none' {
  return piProcSource(view.procRoot, view.psGiven, (root) => readdirSync(root)).source;
}

/**
 * D-15: the options of `./pi-bash.ts` for `view`, so that its choice (`piProcSource`, the same
 * rule on the same root) is this view's: `ps` is passed exactly when this view reads `ps`; `none`
 * stays `none` there (no `ps` given, the same empty root).
 */
function bashOptions(view: ProcessView): { procRoot: string; ps?: string; uid?: number } {
  return {
    procRoot: view.procRoot,
    ...(procSource(view) === 'ps' ? { ps: view.ps } : {}),
    ...(view.uid === undefined ? {} : { uid: view.uid }),
  };
}

/**
 * D-18 (cost of D-15): without procfs no marker can be read, but every shell the bridge started
 * carries its label in its command line (`./pi-bash.ts`, `readPiPsLabelled`). The live processes
 * that carry one of `labels`; `unlabelled`: something looked for has no label (a registry written
 * before D-18), so it cannot be seen. A process found this way is counted, never signalled: a
 * label is visible to anyone in the process list, so carrying it does not prove the process is a
 * shell of this bridge, and the `ps` path signals only what it verified (`signalPiBashGroup`).
 */
function labelledProcesses(
  labels: readonly string[],
  unlabelled: boolean,
  view: ProcessView
): { pids: number[]; unreadable: number } {
  if (unlabelled) return { pids: [], unreadable: 1 };
  if (labels.length === 0) return { pids: [], unreadable: 0 };
  try {
    const found = readPiPsLabelled(labels, { ps: view.ps });
    return { pids: [...new Set([...found.values()].flat())], unreadable: 0 };
  } catch {
    return { pids: [], unreadable: 1 };
  }
}

/**
 * R3-A: what a failed read of `/proc/<pid>/environ` tells of that process. Only `ENOENT` and
 * `ESRCH` say it is gone, and, for an `EACCES`, a `stat` that shows a process that exited (a
 * zombie, `Z`, as everywhere else here; `X`) or none. `EACCES` says it is another user's (so neither a Pi of this user's
 * Switch nor one of its shells) only once procfs shows that: `/proc/<pid>` is not owned by this
 * user (`proc(5)`: the process's effective user) and none of the user ids in `status` (real,
 * effective, saved, file system; readable for every process, also one whose `/proc/<pid>` turned
 * root's because it is not dumpable) is this user's.
 *
 * A process of this user's whose environment no one but root can read (one that is not dumpable:
 * `(sd-pam)` of the user's `systemd`, `ssh-agent`) is not taken for gone either. It is left out
 * only when its procfs start time (`stat` field 22, ticks since boot) is earlier than `since`, the
 * start time of the Switch host that made the launch whose processes are looked for (`owner.json`,
 * `ownIdentity`): it was started before that host, so before the launch and its variables
 * existed, and an environment is the one given at the process's last `execve` (which also makes a
 * process dumpable again, so readable). Any other error, and an `EACCES` none of this rules out,
 * leaves the process unseen: counted, never taken for gone.
 */
function environFailure(
  view: ProcessView,
  name: string,
  error: unknown,
  since: string | null
): 'gone' | 'foreign' | 'older' | 'unreadable' {
  const gone = (code: unknown) => code === 'ENOENT' || code === 'ESRCH';
  const code = (error as NodeJS.ErrnoException).code;
  if (gone(code)) return 'gone';
  if (code !== 'EACCES') return 'unreadable';
  try {
    // A process that exited and is not reaped yet (a zombie) has no environment left: `EACCES`.
    const found = readPiProcStat(Number(name), { procRoot: view.procRoot });
    if (!found || found.state === 'Z' || found.state === 'X') return 'gone';
    if (view.uid !== undefined && statSync(`${view.procRoot}/${name}`).uid !== view.uid) {
      const status = readFileSync(`${view.procRoot}/${name}/status`, 'utf8');
      const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
      if (ids && !ids.slice(1).map(Number).includes(view.uid)) return 'foreign';
    }
    if (
      since !== null &&
      /^\d+$/.test(since) &&
      /^\d+$/.test(found.starttime) &&
      BigInt(found.starttime) < BigInt(since)
    )
      return 'older';
    return 'unreadable';
  } catch (failure) {
    return gone((failure as NodeJS.ErrnoException).code) ? 'gone' : 'unreadable';
  }
}

/**
 * Live processes whose environment holds one of `entries` (`NAME=value`); processes that could
 * not be read are counted (R3-A: all but those gone, those shown to be another user's and those
 * started before `since`, the start of the host that made the launch, see `environFailure`; a
 * process that carries an entry and whose `stat` cannot be read is counted too). Without procfs no
 * environment can be read: every wanted entry is unreadable then, never absent. D-15: that `ps`
 * shows another process's environment on macOS is not confirmed by a source
 * (`p1_d15_stage2_fix_impl.md`), so without procfs (`procSource`, also an empty mount point, and a
 * root that is no source at all) the answer is the cautious one, never "none": what is looked for
 * cannot be seen.
 */
function processesWith(
  entries: readonly string[],
  view: ProcessView,
  since: string | null
): { pids: number[]; unreadable: number } {
  const pids: number[] = [];
  if (entries.length === 0) return { pids, unreadable: 0 };
  if (procSource(view) !== 'procfs') return { pids, unreadable: 1 };
  const wanted = entries.map((entry) => Buffer.from(entry));
  let names: string[];
  try {
    names = readdirSync(view.procRoot);
  } catch {
    return { pids, unreadable: 1 };
  }
  let unreadable = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let environ: Buffer;
    try {
      environ = readFileSync(`${view.procRoot}/${name}/environ`);
    } catch (error) {
      // R3-A: gone meanwhile, or shown to be another user's (no Pi or shell of this user's);
      // anything else cannot be seen.
      if (environFailure(view, name, error, since) === 'unreadable') unreadable += 1;
      continue;
    }
    for (let start = 0; start < environ.length;) {
      const nul = environ.indexOf(0, start);
      const end = nul === -1 ? environ.length : nul;
      const variable = environ.subarray(start, end);
      if (wanted.some((entry) => variable.equals(entry))) {
        // R3-A: `readPiProcStat` is `undefined` only for a process that is gone; it throws for
        // one it cannot read, which then may still live.
        let found;
        try {
          found = readPiProcStat(Number(name), { procRoot: view.procRoot });
        } catch {
          unreadable += 1;
          break;
        }
        if (found && found.state !== 'Z') pids.push(Number(name));
        break;
      }
      start = end + 1;
    }
  }
  return { pids, unreadable };
}

/**
 * Live (not zombie) processes per process group, from one pass; null when that cannot be read
 * completely. With procfs only those in the session the group's leader started count
 * (`pi-bash.ts` `verifyPiBashGroup`: every shell leads its own session and group). Without it
 * (macOS) one pass of `ps` answers (D-15: `readPiPsTable` of `./pi-bash.ts`, read only whole: a
 * line that is not a row, or no row, is a table not read), and every member of the group counts.
 * O-2 B: with the start of each live process that leads its own group (`leaders`), read the way
 * the bridge records a shell's (procfs: `stat` field 22; `ps`: `ps:<lstart>`), see `groupLeft`.
 */
function liveGroups(view: ProcessView): GroupTable | null {
  const table: GroupTable = { members: new Map(), leaders: new Map() };
  const count = (pgid: number) => table.members.set(pgid, (table.members.get(pgid) ?? 0) + 1);
  const source = procSource(view);
  if (source === 'none') return null;
  if (source === 'ps') {
    let rows;
    try {
      rows = readPiPsTable({ ps: view.ps });
    } catch {
      return null;
    }
    for (const row of rows.values()) {
      if (row.state.startsWith('Z')) continue;
      count(row.pgid);
      if (row.pid === row.pgid) table.leaders.set(row.pid, `ps:${row.lstart}`);
    }
    return table;
  }
  let entries: string[];
  try {
    entries = readdirSync(view.procRoot);
  } catch {
    return null;
  }
  try {
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const found = readPiProcStat(Number(entry), { procRoot: view.procRoot });
      if (!found || found.state === 'Z' || found.sid !== found.pgrp) continue;
      count(found.pgrp);
      if (found.pid === found.pgrp) table.leaders.set(found.pid, found.starttime);
    }
  } catch {
    return null;
  }
  return table;
}

/** Live members per process group, and the start of each live process leading its group (O-2 B). */
interface GroupTable {
  members: Map<number, number>;
  leaders: Map<number, string>;
}

/**
 * O-2 B (FAP-06, R5P-02): the live members of `group`'s process group that count for that shell.
 * None once the group's number names another process: its leader lives with a start other than the
 * one recorded for the shell, both known and read the same way (procfs: `starttime`; `ps`:
 * `lstart`, compared as `ps` prints it, so the same second still counts). The kernel gives a PID
 * again only once nothing has it as a process, group or session id, so the shell's group is empty
 * then. The decision is the shell's own: another shell recorded with the same number and the
 * leader's start still counts its members. No leader (gone, or a zombie), no start recorded, one
 * read the other way, or one not in its format: the members count.
 */
function groupLeft(table: GroupTable, group: PiBashGroup): number {
  const members = table.members.get(group.pgid) ?? 0;
  const leader = table.leaders.get(group.pgid);
  if (members === 0 || leader === undefined) return members;
  const recorded = leader.startsWith('ps:')
    ? group.lstart === undefined
      ? undefined
      : `ps:${group.lstart}`
    : group.starttime !== null && /^\d+$/.test(group.starttime)
      ? group.starttime
      : undefined;
  return recorded === undefined || recorded === leader ? members : 0;
}

/**
 * Stops the Pi of a launch that Switch could not see exit (R1-B): every live process whose
 * environment names the launch's bridge config (`SWITCH_PI_BRIDGE`, unique per launch) is
 * killed, until none is left. Confirmed only when none is. `since`: the start of the host that
 * made the launch (R3-A).
 */
async function killLaunchPi(
  bridgeConfig: string,
  view: ProcessView,
  timeoutMs: number,
  since: string | null
): Promise<CleanupResult> {
  if (!bridgeConfig) return { confirmed: true, killed: 0, unconfirmed: [] };
  const entry = `${PI_BRIDGE_CONFIG_ENV}=${bridgeConfig}`;
  const deadline = Date.now() + timeoutMs;
  let killed = 0;
  for (;;) {
    const found = processesWith([entry], view, since);
    for (const pid of found.pids) {
      try {
        process.kill(pid, 'SIGKILL');
        killed += 1;
      } catch {
        // Gone, or not this user's: the next pass sees which.
      }
    }
    const left: string[] = [];
    if (found.pids.length > 0) left.push(`Pi: ${found.pids.length} process(es) left`);
    if (found.unreadable > 0) left.push('Pi: its exit cannot be confirmed');
    if (left.length === 0) return { confirmed: true, killed, unconfirmed: [] };
    if (Date.now() >= deadline) return { confirmed: false, killed, unconfirmed: left };
    await sleep(50);
  }
}

/**
 * Kills the registered groups `select` picks (SIGKILL, each only after `signalPiBashGroup`
 * verified it is still the bridge's) and waits for them to empty (ER-06: kill, then check down to
 * an empty result). A group is confirmed gone when procfs shows no live member of it in its
 * session and no live process carries its marker; the marker also finds a shell recorded as
 * intended but never as spawned (Pi died in between, `pi-bash.ts:7-18`) when `includeUnspawned`
 * picks it (all of them, or those its filter picks: an interrupt takes only its own run's, R1-C).
 * A group that cannot be verified, killed or seen empty in time leaves the result unconfirmed.
 * Without procfs (`ps`, R1-I) a group's members are counted, but no marker can be read: a result
 * with any group or intent to look for stays unconfirmed there. `since`: the procfs start time of
 * the Switch host that made the registry's launch (R3-A, `environFailure`); null when unknown.
 */
export async function killPiBashGroups(
  registry: string,
  select: (group: PiBashGroup) => boolean,
  options: {
    timeoutMs?: number;
    includeUnspawned?: boolean | ((intent: PiBashIntent) => boolean);
    procRoot?: string;
    ps?: string;
    uid?: number;
    since?: string | null;
  } = {}
): Promise<CleanupResult> {
  const view: ProcessView = {
    procRoot: options.procRoot ?? DEFAULT_VIEW.procRoot,
    ps: options.ps ?? DEFAULT_VIEW.ps,
    uid: options.uid ?? DEFAULT_VIEW.uid,
    psGiven: options.ps !== undefined,
  };
  const unconfirmed: string[] = [];
  let killed = 0;
  let groups: PiBashGroup[];
  const markers = new Set<string>();
  // D-18: the labels of the same shells, for the `ps` path; `unlabelled`: one of them has none.
  const labels = new Set<string>();
  let unlabelled = false;
  const want = (shell: { marker: string; label?: string }) => {
    markers.add(shell.marker);
    if (shell.label === undefined) unlabelled = true;
    else labels.add(shell.label);
  };
  try {
    const read = readPiBashRegistry(registry);
    groups = read.groups.filter(select);
    const pick = options.includeUnspawned;
    if (pick) for (const intent of read.unspawned) if (pick === true || pick(intent)) want(intent);
  } catch (error) {
    return { confirmed: false, killed: 0, unconfirmed: [`registry: ${errorCode(error)}`] };
  }
  for (const group of groups) want(group);
  const markerEntries = [...markers].map((marker) => `${PI_BASH_MARKER_ENV}=${marker}`);
  // One pass first: a group with no live member is not signalled (nor verified, which reads
  // procfs once per group).
  const before = liveGroups(view);
  if (before) groups = groups.filter((group) => groupLeft(before, group) > 0);
  for (const group of groups) {
    // D-15: verified the way this view reads processes (procfs, or `ps` and the recorded `lstart`).
    const result = signalPiBashGroup(group, 'SIGKILL', bashOptions(view));
    if (result.sent) killed += 1;
    else if (result.verification.ok)
      unconfirmed.push(`${group.toolCallId}: kill failed (${result.error})`);
    else if (result.verification.reason === 'inspection_failed')
      unconfirmed.push(`${group.toolCallId}: state unknown (${result.verification.error})`);
    else if (
      result.verification.reason === 'member_outside_session' ||
      result.verification.reason === 'member_without_marker'
    )
      unconfirmed.push(`${group.toolCallId}: ${result.verification.reason}`);
    // `group_empty`, or the leader's pid now names another process: nothing of the bridge's leads
    // the group; the checks below find any member of it that is left.
  }
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
  for (;;) {
    const left: string[] = [];
    const table = liveGroups(view);
    if (!table) left.push('the process table could not be read');
    else
      for (const group of groups) {
        const count = groupLeft(table, group);
        if (count > 0) left.push(`${group.toolCallId}: ${count} process(es) left`);
      }
    if (procSource(view) === 'ps') {
      // D-18: without procfs the shells are found by their labels, counted, never signalled.
      const labelled = labelledProcesses([...labels], unlabelled, view);
      if (labelled.pids.length > 0) left.push(`${labelled.pids.length} labelled process(es) left`);
      if (labelled.unreadable > 0) left.push('the markers of the commands could not be read');
    } else {
      const marked = processesWith(markerEntries, view, options.since ?? null);
      for (const pid of marked.pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Gone, or not this user's to signal: the next pass sees which.
        }
      }
      if (marked.pids.length > 0) left.push(`${marked.pids.length} marked process(es) left`);
      if (marked.unreadable > 0) left.push('the markers of the commands could not be read');
    }
    if (left.length === 0) break;
    if (Date.now() >= deadline) {
      unconfirmed.push(...left);
      break;
    }
    await sleep(50);
  }
  return { confirmed: unconfirmed.length === 0, killed, unconfirmed };
}

/**
 * Commands of the registry `skip` does not pick (by their run) that still live, and those that
 * cannot be seen: groups by their members, shells recorded only as intended by their marker
 * (R2-D; without procfs no marker can be read: such a shell is found by its label, D-18, and one
 * without a label is unknown, never gone).
 */
function surveyGroups(
  registry: string,
  skip: (run: number) => boolean,
  view: ProcessView,
  since: string | null
): { alive: string[]; unknown: string[] } {
  const survey = { alive: [] as string[], unknown: [] as string[] };
  let groups: PiBashGroup[];
  let intents: PiBashIntent[];
  try {
    const read = readPiBashRegistry(registry);
    groups = read.groups.filter((group) => !skip(group.run));
    intents = read.unspawned.filter((intent) => !skip(intent.run));
  } catch (error) {
    survey.unknown.push(`registry (${errorCode(error)})`);
    return survey;
  }
  const table: GroupTable | null =
    groups.length > 0 ? liveGroups(view) : { members: new Map(), leaders: new Map() };
  for (const group of groups) {
    if (!table) survey.unknown.push(group.toolCallId);
    else if (groupLeft(table, group) > 0) survey.alive.push(group.toolCallId);
  }
  const ps = intents.length > 0 && procSource(view) === 'ps';
  for (const intent of intents) {
    // D-18: without procfs an intended shell is found by its label (none: cannot be seen).
    const found = ps
      ? labelledProcesses(
          intent.label === undefined ? [] : [intent.label],
          intent.label === undefined,
          view
        )
      : processesWith([`${PI_BASH_MARKER_ENV}=${intent.marker}`], view, since);
    if (found.pids.length > 0) survey.alive.push(intent.toolCallId);
    else if (found.unreadable > 0) survey.unknown.push(intent.toolCallId);
  }
  return survey;
}

/**
 * Takes conversation `<X>` for this session alone (ER-07 exclusivity, EQ-04: while it is checked
 * and while it is used): `lock` of `./pi-conversation.ts`, the lock the recovery procedure takes
 * too. A lock whose holder is gone is taken over, by one taker only (R1-D); one whose holder
 * lives (this process included) refuses the start.
 *
 * R4-A: the identity the lock was taken with (read once) is the one this session's launches name
 * as their owner (`owner.json`), so that a launch is never left with an owner other than the
 * lock's. Without a start time this host cannot be told from a pid reused, neither by the lock
 * nor by a launch: the start is refused.
 *
 * D16-C1: a lock the store took is the session's (`releaseLock`) from the moment its entry was
 * made, also when taking it could not be finished (`failed`) or the start is refused right after:
 * the end of the start lets it go, and a release that fails stays a duty of this adapter.
 */
function lockConversation(store: PiConversationStore, session: Session): void {
  const id = session.piSessionId;
  const held = store.lock(session.sessionDir, id);
  if ('owner' in held) {
    session.releaseLock = held.release;
    const start = held.owner.start;
    if (start !== null) {
      session.ownerStart = start;
      return;
    }
    throw new ProviderSessionError(
      PROVIDER,
      session.id,
      `Switch cannot read its own process start time (procfs or ps), so it cannot mark Pi conversation ${id} as its own; it starts no Pi until it can.`
    );
  }
  if ('failed' in held) {
    session.releaseLock = held.release;
    throw new ProviderSessionError(
      PROVIDER,
      session.id,
      `Switch could not take Pi conversation ${id} (${held.failed}); it starts no Pi for it.`
    );
  }
  throw new ProviderSessionError(
    PROVIDER,
    session.id,
    `Pi conversation ${id} is open in another Switch session (${held.busy}); Switch opens a conversation in one place at a time.`
  );
}

/** Written into a launch's own directory (by `preparePiLaunch`, R3-E): the host that owns its groups. */
type RunOwner = {
  v: 1;
  pid: number;
  start: string | null;
  piSessionId: string;
};

/** A launch of a session as the record of cleanup and an operation's held directories name it. */
function pendingLaunch(launch: PiLaunch): PiPendingLaunch {
  const runDir = launch.runDir ?? '';
  return {
    runDir,
    registry: launch.bridgeConfig?.processRegistry ?? join(runDir, 'processes.jsonl'),
    // `preparePiLaunch` names the bridge config `<runDir>/config.json` (`pi-launch.ts`).
    bridgeConfig: launch.env[PI_BRIDGE_CONFIG_ENV] ?? join(runDir, 'config.json'),
  };
}

/**
 * D-16: what a launch directory is named once it is being removed (`removeLaunch`): nothing of it
 * runs or ran, so the sweep removes what is left of it and the recovery does not wait for it.
 * O-9 A′ (S4-11): never the name of one being made (`PI_RUN_PREPARING_PREFIX`, `.preparing-`),
 * which the sweep removes only once its owner is known to be gone (`sweepDeadHosts`). The
 * in-process count of launches being made (joint round 4, U-5) is gone with the shared name: a
 * launch this process makes names this process, which runs, as its owner, or has no whole owner
 * yet; either way the sweep leaves it, in this process and in any other.
 */
const REMOVED_PREFIX = '.removed-';

/**
 * D-16: removes a launch directory whose processes are gone (or never ran). It is first renamed,
 * in one step, to a name the sweep and the recovery know (`REMOVED_PREFIX`); only then removed.
 * A removal cut short (an error halfway through the recursive removal, which may take `owner.json`
 * first) never leaves a launch directory without its owner (which the sweep leaves as the start of
 * a launch, R3-E, and nothing removes): it leaves a removed one, which the next sweep finishes.
 * Throws only when the rename fails: then nothing changed and the caller tries again.
 */
async function removeLaunch(runDir: string): Promise<void> {
  const removed = join(dirname(runDir), `${REMOVED_PREFIX}${randomUUID()}`);
  try {
    await rename(runDir, removed);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  try {
    await rm(removed, { recursive: true, force: true });
  } catch {
    // Its name says it is removed: the sweep of the next start finishes it.
  }
}

/** The start time of the host that made a launch, from its `owner.json`; null when unknown (R3-A). */
async function launchHostStart(launch: PiPendingLaunch): Promise<string | null> {
  try {
    const owner: unknown = JSON.parse(await readFile(join(launch.runDir, 'owner.json'), 'utf8'));
    return isRecord(owner) && owner.v === 1 && typeof owner.start === 'string' ? owner.start : null;
  } catch {
    return null;
  }
}

/**
 * Every process of a launch Switch no longer runs: its Pi (`killLaunchPi`), then every group of
 * its registry, intended shells too. Confirmed only when both are. `since`: the start of the host
 * that made the launch (its `owner.json`; R3-A), null when unknown.
 */
async function killLaunch(
  launch: PiPendingLaunch,
  view: ProcessView,
  timeoutMs: number,
  since: string | null
): Promise<CleanupResult & { piGone: boolean }> {
  // O-1 A (FAP-01): a Pi whose exit the record keeps (`piExited`) is not looked for again (without
  // procfs it could never be confirmed); its groups and shells are, as always.
  const pi =
    launch.piExited === true
      ? { confirmed: true, killed: 0, unconfirmed: [] }
      : await killLaunchPi(launch.bridgeConfig, view, timeoutMs, since);
  const groups = await killPiBashGroups(launch.registry, () => true, {
    timeoutMs,
    includeUnspawned: true,
    procRoot: view.procRoot,
    ...(view.psGiven ? { ps: view.ps } : {}),
    ...(view.uid === undefined ? {} : { uid: view.uid }),
    since,
  });
  return {
    confirmed: pi.confirmed && groups.confirmed,
    killed: pi.killed + groups.killed,
    unconfirmed: [...pi.unconfirmed, ...groups.unconfirmed],
    piGone: pi.confirmed,
  };
}

/**
 * After a host that died with Pi sessions (SIGKILL, power loss; ER-06 "after a host crash"):
 * every launch directory under `<state>/run` whose owning host is gone has its Pi and its groups
 * killed and is removed. One that cannot be confirmed is kept; the ids of its conversations are
 * returned.
 *
 * R4-A: a launch whose owner is not resolved is never passed over. One whose owner names its
 * conversation but no start time (its host cannot be told from a pid reused, so nothing of it is
 * killed) blocks that conversation, unless the scan (`launchLeft` of `./pi-conversation.ts`: its
 * Pi by `SWITCH_PI_BRIDGE`, its groups, its intended shells; anything unseen counts) shows that
 * nothing of it lives. One whose `owner.json` cannot be read or is damaged names no conversation:
 * unless the same scan shows nothing of it lives, it blocks every conversation of this state
 * directory (`all`), since any of them may be the one its Pi writes. A launch being made is under
 * `PI_RUN_PREPARING_PREFIX` (R3-E), removed only once its whole owner is told gone (O-9 A′); one
 * being removed (`REMOVED_PREFIX`) is finished; a directory without
 * `owner.json` under any other name is none of this Switch's launches: left as it is. A live host's launch is
 * left to that host: it holds the conversation's lock while its Pi may run, and lets it go only
 * after the launch is removed or recorded (`<X>.cleanup.json`, which every start tries first).
 *
 * R5-B: a dead host's launch that a record of cleanup lists (or whose record cannot be read) is
 * settled with that record, never removed behind its back: for `own`, the conversation whose lock
 * the caller holds, the record says first that every process of the launch ended (durably), then
 * the directory goes, then the entry; another conversation's launch is left to that
 * conversation's start (its record keeps the identity of the host that made it).
 */
async function sweepDeadHosts(
  stateDir: string,
  timeoutMs: number,
  store: PiConversationStore,
  view: ProcessView,
  own: { sessionDir: string; id: string }
): Promise<{ blocked: Map<string, string[]>; all: string[] }> {
  const blocked = new Map<string, string[]>();
  const all: string[] = [];
  const block = (id: string, reasons: string[]) =>
    blocked.set(id, [...(blocked.get(id) ?? []), ...reasons]);
  const runRoot = join(stateDir, 'run');
  let names: string[];
  try {
    names = await readdir(runRoot);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT')
      all.push(`Switch cannot list its launches in ${runRoot} (${errorCode(error)})`);
    return { blocked, all };
  }
  for (const name of names) {
    const dir = join(runRoot, name);
    if (name.startsWith(REMOVED_PREFIX)) {
      // D-16: a removal cut short (`removeLaunch`): nothing of it runs; finished when it can be.
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // The next sweep tries again; it blocks nothing.
      }
      continue;
    }
    if (name.startsWith(PI_RUN_PREPARING_PREFIX)) {
      // O-9 A′ (S4-11): a launch being made (`preparePiLaunch`, R3-E), in this process or another:
      // no Pi ran in it (Pi starts on the name it is renamed to). Removed (renamed to a removed
      // one first, `removeLaunch`) only once its owner is whole and its host is told gone (the
      // rule of the lock, `stillRuns`: another start time is another process, one that cannot
      // be read runs); an owner that is missing, cut off or damaged tells nothing: it is left.
      let maker: unknown;
      try {
        maker = JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8'));
      } catch {
        continue;
      }
      if (
        !isRecord(maker) ||
        maker.v !== 1 ||
        typeof maker.pid !== 'number' ||
        typeof maker.start !== 'string' ||
        typeof maker.piSessionId !== 'string' ||
        store.stillRuns(maker.pid, maker.start)
      )
        continue;
      try {
        await removeLaunch(dir);
      } catch {
        // The next sweep tries again; it blocks nothing (no Pi ran in it).
      }
      continue;
    }
    let text: string;
    try {
      text = await readFile(join(dir, 'owner.json'), 'utf8');
    } catch (error) {
      const failure = errorCode(error);
      // R3-E: a launch is renamed into place with its owner in it (`preparePiLaunch`), so one
      // without is no launch of this Switch's (one an earlier version left half made, before its
      // Pi: no Pi ran in it) and blocks nothing; it is left as it is, never removed behind a
      // writer's back. ENOTDIR: not a launch directory.
      if (failure === 'ENOENT' || failure === 'ENOTDIR') continue;
      const left = store.launchLeft(dir, null);
      if (left.length > 0)
        all.push(
          `launch ${dir}: its owner (owner.json) cannot be read (${failure}), and ${left.join('; ')}`
        );
      continue;
    }
    let owner: unknown;
    try {
      owner = JSON.parse(text);
    } catch {
      owner = null;
    }
    if (
      !isRecord(owner) ||
      owner.v !== 1 ||
      typeof owner.pid !== 'number' ||
      typeof owner.piSessionId !== 'string'
    ) {
      const left = store.launchLeft(dir, null);
      if (left.length > 0)
        all.push(
          `launch ${dir}: its owner (owner.json) is damaged or not one Switch wrote, and ${left.join('; ')}`
        );
      continue;
    }
    const pid: number = owner.pid;
    const piSessionId: string = owner.piSessionId;
    const start = owner.start;
    if (typeof start !== 'string') {
      // R4-A: a host whose start time is unknown cannot be told from a pid reused: nothing of
      // its launch is killed, and its conversation waits until nothing of it is seen to live.
      const left = store.launchLeft(dir, null);
      if (left.length > 0)
        block(piSessionId, [
          `launch ${dir} has an owner whose start time is unknown, and ${left.join('; ')}`,
        ]);
      continue;
    }
    if (store.stillRuns(pid, start)) continue;
    // O-1 A (FAP-01): the record of the launch's conversation is read before its Pi is looked
    // for: one that keeps the exit of its Pi (`piExited`) spares that search, which without procfs
    // could never be confirmed. A record that cannot be read spares nothing.
    const sessionDir = join(stateDir, 'sessions');
    const before = store.readCleanup(sessionDir, piSessionId);
    const exited =
      'launches' in before &&
      before.launches.some(
        (launch) => resolvePath(launch.runDir) === resolvePath(dir) && launch.piExited === true
      );
    const result = await killLaunch(
      {
        runDir: dir,
        registry: join(dir, 'processes.jsonl'),
        // `preparePiLaunch` names the bridge config `<runDir>/config.json` (`pi-launch.ts`).
        bridgeConfig: join(dir, 'config.json'),
        ...(exited ? { piExited: true as const } : {}),
      },
      view,
      timeoutMs,
      start
    );
    if (!result.confirmed) {
      block(piSessionId, result.unconfirmed);
      continue;
    }
    // R5-B: the record of the launch's conversation, if it lists the launch, is settled with it.
    const listed = store.readCleanup(sessionDir, piSessionId);
    const entry =
      'launches' in listed
        ? listed.launches.find((launch) => resolvePath(launch.runDir) === resolvePath(dir))
        : undefined;
    if ('launches' in listed && !entry) {
      // D16-S1: a directory that cannot be removed blocks its own conversation only (said, and
      // tried again by the next sweep); the sweep goes on, and no other conversation waits for it.
      try {
        await removeLaunch(dir);
      } catch (error) {
        block(piSessionId, [
          `Switch ended every process of launch ${dir} but could not remove its directory (${errorCode(error)})`,
        ]);
      }
      continue;
    }
    // Listed (or the record cannot be read): only the holder of that conversation's lock settles it.
    if (!entry || piSessionId !== own.id || resolvePath(sessionDir) !== resolvePath(own.sessionDir))
      continue;
    try {
      store.settleCleanup(sessionDir, piSessionId, entry.runDir, 'ended');
      await removeLaunch(dir);
      store.settleCleanup(sessionDir, piSessionId, entry.runDir, 'drop');
    } catch (error) {
      block(piSessionId, [
        `Switch ended every process of launch ${dir} but could not settle its record (${errorCode(error)})`,
      ]);
    }
  }
  return { blocked, all };
}

export class PiAdapter implements ProviderAdapter {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;
  private readonly sessions = new Map<string, Session>();
  /** R3-C: sessions whose end is under way, also once they left `sessions`. */
  private readonly ending = new Set<Session>();
  /** D-16: what ended sessions left to do (R5-C), each duty by its own identity, until it is done. */
  private readonly duties = new Set<Duty>();
  private nextDuty = 0;
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly logger: ProviderLogger;
  private readonly interruptTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  /** Where processes are read (procfs, or `ps`), for every check of this adapter. */
  private readonly view: ProcessView;
  /** The conversations on disk: lock, transcript, cleanup records (`./pi-conversation.ts`). */
  private readonly store: PiConversationStore;
  private nextGeneration = 0;

  constructor(private readonly options: PiAdapterOptions = {}) {
    this.logger = options.logger ?? noopLogger;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.view = {
      procRoot: options.procRoot ?? DEFAULT_VIEW.procRoot,
      ps: options.ps ?? DEFAULT_VIEW.ps,
      uid: options.uid ?? DEFAULT_VIEW.uid,
      psGiven: options.ps !== undefined,
    };
    // D-15, R7-C: the store chooses procfs or `ps` by the same rule, the same function
    // (`piProcSource`), on the same root (`ps` given only when it was).
    this.store = piConversationStore({
      procRoot: this.view.procRoot,
      ...(this.view.psGiven ? { ps: this.view.ps } : {}),
      ...(this.view.uid === undefined ? {} : { uid: this.view.uid }),
      procSource: piProcSource,
    });
  }

  /**
   * R3-A: the procfs start time of this host, which makes the launches of its sessions: no process
   * started before it carries one of their variables (`environFailure`).
   */
  private hostStart(): string | null {
    return this.store.ownIdentity().start;
  }

  private kill(
    registry: string,
    select: (group: PiBashGroup) => boolean,
    unspawned: boolean | ((intent: PiBashIntent) => boolean),
    timeoutMs = this.cleanupTimeoutMs
  ) {
    return killPiBashGroups(registry, select, {
      timeoutMs,
      includeUnspawned: unspawned,
      procRoot: this.view.procRoot,
      ...(this.view.psGiven ? { ps: this.view.ps } : {}),
      ...(this.view.uid === undefined ? {} : { uid: this.view.uid }),
      since: this.hostStart(),
    });
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** R2-D: a command that may still run (its state unknown) counts as running: the session is not idle. */
  hasBackgroundWork(sessionId: string): boolean {
    const background = this.sessions.get(sessionId)?.background;
    return background ? background.alive + background.unknown > 0 : false;
  }

  async startSession(input: ProviderSessionStartInput) {
    if (this.sessions.has(input.sessionId))
      throw new ProviderSessionError(PROVIDER, input.sessionId, 'session already started');
    // `host/shared-daemon.ts:40-60`: model discovery starts a session with no model, no MCP server
    // and no resume, and only lists models (P-12). Any other session needs a model (Q4 A).
    const discovery = !input.model && !input.resume && Object.keys(input.mcpServers).length === 0;
    if (!discovery && !input.model?.id)
      throw new ProviderSessionError(PROVIDER, input.sessionId, NEEDS_MODEL);
    if (input.model && !splitModel(input.model.id))
      throw new ProviderSessionError(
        PROVIDER,
        input.sessionId,
        `Pi names a model as provider/model, not ${JSON.stringify(input.model.id)}.`
      );
    const piSessionId = input.resume ? input.resume.nativeSessionId : randomUUID();
    if (input.resume && !SESSION_ID.test(piSessionId))
      throw new ProviderConversationUnavailableError(
        PROVIDER,
        input.sessionId,
        `${JSON.stringify(piSessionId)} is not a Pi conversation id.`
      );
    const stateDir = piStateDir(input.env);
    const session: Session = {
      id: input.sessionId,
      input,
      discovery,
      piSessionId,
      stateDir,
      sessionDir: join(stateDir, 'sessions'),
      generations: [],
      model: input.model?.id ?? '',
      modelId: input.model ? (splitModel(input.model.id)?.modelId ?? '') : '',
      pendingModel: null,
      policy: {
        runtimeMode: input.runtimeMode,
        cwd: input.cwd,
        mcpServers: [],
        connectorMcpServers: input.connectorMcpServers,
        env: input.env,
        // Pi's sessions and the launches' registries live here (stage 3 hand-over).
        protectedRoots: [stateDir],
      },
      queue: [],
      turn: null,
      requests: new Map(),
      context: input.systemContext ?? '',
      stopping: false,
      cancelled: false,
      ending: null,
      cleaning: false,
      turning: false,
      blocked: null,
      background: { alive: 0, unknown: 0 },
      releaseLock: null,
      ownerStart: null,
      tasks: new Set(),
      leftovers: [],
      halts: new Set(),
      started: false,
    };
    this.sessions.set(session.id, session);
    // R1-F, R5-A: the start is an operation of the session (`run`) from before `starting` is said:
    // a stop from then on, a listener of that event's included, marks the session cancelled and
    // its end waits for the start, which goes no further at its next step and leaves nothing; it
    // never reports the session ready.
    const startup = this.run(session, async (op) => {
      this.emit(session, { type: 'session.state.changed', status: 'starting' });
      op.check();
      if (discovery) await this.startDiscovery(session, op);
      else {
        // R5-C: what an earlier session of this conversation here could not clean up, first.
        const left = await op.wait(this.settleConversation(session.sessionDir, piSessionId));
        if (left.length > 0)
          throw new ProviderSessionError(
            PROVIDER,
            session.id,
            `Switch could not clean up after the last session of Pi conversation ${piSessionId} (${left.join('; ')}); it keeps the conversation and starts no Pi for it until it can. Stopping that session again tries once more.`
          );
        lockConversation(this.store, session);
        await this.checkEarlierCleanup(session, op);
        const target = await this.sessionTarget(session, Boolean(input.resume), op);
        await this.spawnGeneration(session, target, op);
      }
      op.check();
      // In the same step as the last check: a stop from here on is the stop of a started session.
      session.started = true;
      this.emit(session, {
        type: 'session.started',
        nativeSessionId: discovery ? '' : piSessionId,
      });
      this.emit(session, { type: 'session.state.changed', status: 'ready' });
    });
    try {
      await startup;
    } catch (cause) {
      const error = this.startError(session, cause);
      // The one end of the session (R3-C): a stop of the start ended it already, or this does.
      await this.exited(session, errorText(error));
      throw error;
    }
    const nativeSessionId = discovery ? '' : piSessionId;
    return { provider: PROVIDER, sessionId: session.id, nativeSessionId };
  }

  /** ER-08: a Pi that lists models and keeps no conversation (`--no-session`); never prompted. */
  private async startDiscovery(session: Session, op: SessionOperation): Promise<void> {
    // Nothing of a discovery is on disk but what `preparePiLaunch` wrote in the profile.
    const launch = await op.wait(
      preparePiLaunch({
        kind: 'discovery',
        binaryPath: this.options.binaryPath,
        env: session.input.env,
        cwd: session.input.cwd,
      })
    );
    const generation = this.connect(session, launch, '');
    await op.ask(
      generation.client.request('get_available_models', {}, { timeoutMs: this.startTimeoutMs })
    );
  }

  /** R1-F, R5: a session that is ending, or whose start was stopped, goes no further. */
  private checkCancelled(session: Session): void {
    if (session.cancelled || session.stopping)
      throw new SessionStoppedError(
        PROVIDER,
        session.id,
        session.started ? 'The session was stopped.' : 'The session was stopped while it started.'
      );
  }

  /**
   * R5: the one way an operation of a session runs (the start, a turn with the preparation of its
   * Pi and the choice of its transcript, the cleanup after a turn, a model switch with its
   * `retire`, a blocked cleanup checked again). (1) It is recorded in the session synchronously,
   * before `work` runs, so before its first wait; none starts once the session ends. (2) `work`
   * sees the session through `op`: every wait is followed by a check, which ends the operation
   * when the session is ending. (3) Whatever ends it, the launch directories it holds and no
   * generation took are removed here, and one that cannot be is left to the end of the session to
   * account for (`Session.leftovers`). The end of the session waits for every operation recorded
   * (`settleTasks`) before it accounts for what is left and lets the conversation go.
   */
  private run<T>(session: Session, work: (op: SessionOperation) => Promise<T>): Promise<T> {
    try {
      this.checkCancelled(session);
    } catch (error) {
      return Promise.reject(error);
    }
    const op = new SessionOperation(() => this.checkCancelled(session), session.halts);
    let finish!: () => void;
    const task: SessionTask = {
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    session.tasks.add(task);
    let running: Promise<T>;
    try {
      running = work(op);
    } catch (error) {
      running = Promise.reject(error);
    }
    const settled = running.finally(() => this.releaseHeld(session, op));
    void settled
      .then(
        () => {},
        () => {}
      )
      .then(() => {
        session.tasks.delete(task);
        finish();
      });
    return settled;
  }

  /** R5-C: the launch directories an operation made and no generation took; never throws. */
  private async releaseHeld(session: Session, op: SessionOperation): Promise<void> {
    for (const launch of [...op.held.values()]) {
      try {
        await removeLaunch(launch.runDir);
      } catch (error) {
        session.leftovers.push({ launch, reason: errorCode(error) });
      }
      op.release(launch.runDir);
    }
  }

  /** R5: every operation of the session, also one recorded while its end waited for the others. */
  private async settleTasks(session: Session): Promise<void> {
    while (session.tasks.size > 0) await Promise.all([...session.tasks].map((task) => task.done));
  }

  /**
   * Cleanup an earlier end of this conversation could not confirm (`<X>.cleanup.json`, written by
   * any adapter on any host, R1-E), and what dead hosts left, tried again; still unconfirmed, the
   * start is refused (ER-06: no new generation). Runs under the conversation's lock.
   */
  private async checkEarlierCleanup(session: Session, op: SessionOperation): Promise<void> {
    const hosts = await op.wait(
      sweepDeadHosts(session.stateDir, this.cleanupTimeoutMs, this.store, this.view, {
        sessionDir: session.sessionDir,
        id: session.piSessionId,
      })
    );
    const earlier = this.store.readCleanup(session.sessionDir, session.piSessionId);
    if (!('launches' in earlier))
      throw new ProviderSessionError(
        PROVIDER,
        session.id,
        `Switch cannot tell whether the processes this Pi conversation started before are gone: ${earlier.problem}. It starts no new Pi for it until it can.`
      );
    if (earlier.launches.length > 0) {
      const results = await op.wait(
        Promise.all(earlier.launches.map((launch) => this.settleRecorded(session, launch)))
      );
      const left = results.flatMap((result) => result.unconfirmed);
      if (left.length > 0)
        throw new ProviderSessionError(
          PROVIDER,
          session.id,
          `Switch could not confirm that the processes this Pi conversation started before are gone (${left.join('; ')}); it starts no new Pi for it until it can.`
        );
    }
    const left = hosts.blocked.get(session.piSessionId);
    if (left)
      throw new ProviderSessionError(
        PROVIDER,
        session.id,
        `Switch could not confirm that the processes a stopped Switch left for this Pi conversation are gone (${left.join('; ')}); it starts no new Pi for it until it can.`
      );
    // R4-A: a launch that names no conversation Switch can read may be this one's: no Pi starts
    // in this state directory while anything of it may live (refused, with where it is, rather
    // than guessed).
    if (hosts.all.length > 0)
      throw new ProviderSessionError(
        PROVIDER,
        session.id,
        `Switch cannot tell which Pi conversation a launch it found belongs to, and that launch may still run (${hosts.all.join('; ')}); it starts no Pi for any conversation of ${session.stateDir} until nothing of that launch is seen to run, or the launch directory is removed by someone who knows it is over.`
      );
  }

  /**
   * R5-B: one launch of the record of cleanup, tried again. Its processes are looked for with the
   * identity the record keeps (the start of the host that made it, R3-A; `owner.json` only for a
   * record written before round 5); once none is left, the record says so first (durably), then
   * the directory goes, then the entry. A launch whose directory is gone while the record does not
   * say it ended stays unconfirmed: its registry, so its commands, went with it. One the record
   * says ended only has its directory and entry left to remove, wherever an earlier try stopped.
   */
  private async settleRecorded(session: Session, launch: PiPendingLaunch): Promise<CleanupResult> {
    const unconfirmed = (reason: string): CleanupResult => ({
      confirmed: false,
      killed: 0,
      unconfirmed: [reason],
    });
    let killed = 0;
    if (launch.ended !== true) {
      const there = await lstat(launch.runDir).then(
        () => true,
        (error: unknown) => errorCode(error) !== 'ENOENT'
      );
      if (!there)
        return unconfirmed(
          `launch ${launch.runDir} is gone and the record does not say its processes ended, so its commands cannot be found; remove ${join(session.sessionDir, `${session.piSessionId}.cleanup.json`)} once you know they did`
        );
      const since = launch.owner?.start ?? (await launchHostStart(launch));
      const result = await killLaunch(launch, this.view, this.cleanupTimeoutMs, since);
      if (!result.confirmed) {
        // O-1 A: a Pi seen gone now (procfs) is kept as gone, so that no later try looks for it
        // again; merged into the entry (`addCleanup`), never lost by a write after it.
        if (result.piGone && launch.piExited !== true)
          try {
            this.store.addCleanup(session.sessionDir, session.piSessionId, [
              { ...launch, piExited: true },
            ]);
          } catch {
            // Not kept: the next try looks for that Pi again, as before.
          }
        return result;
      }
      killed = result.killed;
      try {
        this.store.settleCleanup(session.sessionDir, session.piSessionId, launch.runDir, 'ended');
      } catch (error) {
        return unconfirmed(
          `the record of launch ${launch.runDir} cannot be written (${errorCode(error)})`
        );
      }
    }
    try {
      await removeLaunch(launch.runDir);
      this.store.settleCleanup(session.sessionDir, session.piSessionId, launch.runDir, 'drop');
    } catch (error) {
      return unconfirmed(
        `every process of launch ${launch.runDir} ended, but its directory or its record entry could not be removed (${errorCode(error)})`
      );
    }
    return { confirmed: true, killed, unconfirmed: [] };
  }

  /** What Pi is started on: a new conversation `<X>`, or `<X>`'s checked transcript (ER-07). */
  private async sessionTarget(
    session: Session,
    resume: boolean,
    op: SessionOperation
  ): Promise<PiSessionTarget> {
    const found = this.store.transcript(session.sessionDir, session.piSessionId);
    if ('problem' in found)
      throw new ProviderConversationUnavailableError(
        PROVIDER,
        session.id,
        `Switch will not resume Pi conversation ${session.piSessionId}: ${found.problem}.`
      );
    if ('none' in found) {
      if (resume)
        throw new ProviderConversationUnavailableError(
          PROVIDER,
          session.id,
          `Pi has no saved conversation ${session.piSessionId} in ${session.sessionDir}.`
        );
      return { id: session.piSessionId };
    }
    if (!resume)
      throw new ProviderSessionError(
        PROVIDER,
        session.id,
        `A Pi conversation ${session.piSessionId} already exists in ${session.sessionDir}.`
      );
    const cwd = [session.input.cwd];
    const real = await op.wait(realpath(session.input.cwd).catch(() => null));
    if (real && real !== session.input.cwd) cwd.push(real);
    const check = await op.wait(
      validatePiSessionFile(found.file, { id: session.piSessionId, cwd }, this.store)
    );
    if (!check.ok)
      throw new ProviderConversationUnavailableError(
        PROVIDER,
        session.id,
        `Switch will not resume Pi conversation ${session.piSessionId}: its transcript ${found.file} ${check.reason}. Pi would load it without saying what it lost. ${check.cutOff ? this.recoverHint(session) : 'Switch recovers only a transcript whose last line is cut off; keep the file and start a new conversation.'}`
      );
    return { file: found.file };
  }

  /**
   * SC26 (Q2 A′): the procedure that recovers a conversation whose last line is cut off, written
   * into Switch's Pi state directory as it is in this build, and the exact command to run it.
   */
  private recoverHint(session: Session): string {
    const script = join(session.stateDir, PI_RECOVER_SCRIPT);
    try {
      this.store.writeDurably(script, piRecoverSource());
    } catch (error) {
      return `Switch could not write its recovery procedure to ${script} (${errorCode(error)}); keep the file and start a new conversation.`;
    }
    const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
    return `To recover it (the original file is kept), run: node ${quote(script)} ${quote(session.sessionDir)} ${quote(session.piSessionId)} — it shows what it would remove and the command that does it.`;
  }

  /** Starts one Pi for the session and checks it before anything is sent: handshake, conversation, model. */
  private async spawnGeneration(
    session: Session,
    target: PiSessionTarget,
    op: SessionOperation
  ): Promise<Generation> {
    const generation = await this.prepareGeneration(session, target, op);
    return this.checkGeneration(session, target, generation, op);
  }

  /**
   * The launch of a new Pi and the Pi spawned on it, as a step of operation `op`. R3-D, R4-B, R5-C:
   * from the moment `preparePiLaunch` returns until a generation holds it (`connect` adds it to the
   * session, whose stop then removes it), the launch directory is the operation's (`op.hold`):
   * whatever ends it before that (a stop while `owner.json` is written, a refusal) removes it in
   * `run`, and one that cannot be removed is accounted for by the end of the session, so that no
   * launch of a live host is left behind unrecorded to refuse the conversation's recovery.
   */
  private async prepareGeneration(
    session: Session,
    target: PiSessionTarget,
    op: SessionOperation
  ): Promise<Generation> {
    // R5-A: nothing is prepared for a session that is ending.
    op.check();
    // R4-A: the owner is the identity the conversation's lock was taken with, read once; a
    // launch is never written with an owner whose start time is unknown, so nothing is written
    // without one.
    const start = session.ownerStart;
    if (start === null)
      throw new ProviderSessionError(
        PROVIDER,
        session.id,
        'Switch does not know the start time it took this Pi conversation with, so it starts no Pi for it.'
      );
    const owner: RunOwner = {
      v: 1,
      pid: process.pid,
      start,
      piSessionId: session.piSessionId,
    };
    // R3-E (stage 4), R4-A: `preparePiLaunch` makes the launch directory with its `owner.json` in
    // it, under a name of its own (`PI_RUN_PREPARING_PREFIX`, its owner written first), and renames
    // it into place whole: no sweep or recovery ever reads a launch without its owner, or a partial
    // one (which it would take for a damaged one, blocking every conversation of the state
    // directory). O-9 A′: no sweep removes it while it is made: its owner is this process.
    const preparing = preparePiLaunch({
      kind: 'session',
      binaryPath: this.options.binaryPath,
      env: session.input.env,
      cwd: session.input.cwd,
      model: session.model,
      session: target,
      mcpServers: session.input.mcpServers,
      owner,
    });
    const launch = await op.wait(preparing, (made) => {
      if (made.runDir) op.hold(pendingLaunch(made));
    });
    const config = launch.bridgeConfig;
    const runDir = launch.runDir;
    if (!config || !runDir)
      throw new Error('the launch of a Pi session came without its bridge configuration');
    session.policy = { ...session.policy, mcpServers: Object.keys(config.mcpServers) };
    const generation = this.connect(session, launch, config.nonce);
    // The generation holds the directory now: the stop of the session removes it.
    op.release(runDir);
    return generation;
  }

  /** The checks of a Pi before anything is sent to it: handshake, conversation, model. */
  private async checkGeneration(
    session: Session,
    target: PiSessionTarget,
    generation: Generation,
    op: SessionOperation
  ): Promise<Generation> {
    const config = generation.launch.bridgeConfig;
    if (!config)
      throw new Error('the launch of a Pi session came without its bridge configuration');
    const timeoutMs = this.startTimeoutMs;
    const commands = await op.ask(
      generation.client.request<{ commands?: unknown }>('get_commands', {}, { timeoutMs })
    );
    const handshake = piBridgeHandshakeCommand(config.nonce);
    const listed = isRecord(commands) && Array.isArray(commands.commands) ? commands.commands : [];
    if (
      !listed.some(
        (command) =>
          isRecord(command) && command.name === handshake && command.source === 'extension'
      )
    )
      throw new Error(
        'Switch’s bridge did not load in Pi (no handshake), so no tool call could be approved; nothing was sent to Pi'
      );
    const state = await op.ask(
      generation.client.request<Record<string, unknown>>('get_state', {}, { timeoutMs })
    );
    if (!isRecord(state) || state.sessionId !== session.piSessionId)
      throw new Error(
        `Pi opened conversation ${JSON.stringify(isRecord(state) ? state.sessionId : null)}, not ${session.piSessionId}`
      );
    const sessionFile = typeof state.sessionFile === 'string' ? state.sessionFile : '';
    const where =
      'file' in target
        ? sessionFile === target.file
        : dirname(sessionFile) === session.sessionDir &&
          basename(sessionFile).endsWith(`_${session.piSessionId}.jsonl`);
    if (!where)
      throw new Error(
        `Pi keeps the conversation in ${JSON.stringify(sessionFile)}, not where Switch put it`
      );
    const model = piModel(state.model);
    if (!model || modelName(model) !== session.model)
      throw new Error(
        `Pi runs ${model ? modelName(model) : 'no model'}, not ${session.model}; check the model name (provider/model)`
      );
    const available = modelChoices(
      await op.ask(generation.client.request('get_available_models', {}, { timeoutMs }))
    );
    if (!available.some((choice) => choice.id === session.model))
      throw new Error(
        `Pi has no model ${session.model} it can use: the model is unknown, or its provider has no sign-in on the execution machine`
      );
    session.modelId = model.id;
    return generation;
  }

  /** Spawns the Pi of a launch, a new generation, and wires its events to the session. */
  private connect(session: Session, launch: PiLaunch, nonce: string): Generation {
    this.checkCancelled(session);
    const generation = {
      number: ++this.nextGeneration,
      launch,
      nonce,
      registry: launch.bridgeConfig?.processRegistry ?? '',
      bridgeConfig: launch.env[PI_BRIDGE_CONFIG_ENV] ?? '',
      retiring: false,
      exited: false,
      linkLost: false,
      stuck: false,
      lastRun: 0,
    } as Generation;
    session.generations.push(generation);
    generation.client = new PiRpcClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      logger: this.logger,
      onEvent: (event) => this.onEvent(session, generation, event),
      onExit: (reason) => void this.onExit(session, generation, reason),
    });
    return generation;
  }

  private current(session: Session): Generation | undefined {
    const last = session.generations.at(-1);
    return last && !last.exited && !last.retiring && !last.linkLost ? last : undefined;
  }

  /** R2-E: after a wait, the session may be gone (stopped, its queue emptied). */
  private gone(session: Session): boolean {
    return this.sessions.get(session.id) !== session || session.stopping;
  }

  private startError(session: Session, cause: unknown): ProviderSessionError {
    if (cause instanceof ProviderSessionError) return cause;
    // `pi-launch.ts`: version, profile, launch (`binary`, `migration`, `mcp`, `model`, `shell`)
    // and argument refusals say what to do; they are the session's error as they are.
    const known =
      cause instanceof PiVersionError ||
      cause instanceof PiProfileError ||
      cause instanceof PiLaunchError ||
      cause instanceof PiArgsError;
    const stderr = session.generations.at(-1)?.client?.stderr.trim() ?? '';
    return new ProviderSessionError(
      PROVIDER,
      session.id,
      known
        ? errorText(cause)
        : `Could not start Pi: ${errorText(cause)}${stderr ? `\n${stderr}` : ''}`,
      { cause }
    );
  }

  // -----------------------------------------------------------------------------------------------
  // Events

  private onEvent(session: Session, generation: Generation, event: PiRpcEvent): void {
    // Rule 1, generation: nothing of a process Switch stopped or replaced reaches a turn.
    if (this.sessions.get(session.id) !== session || generation.retiring || generation.exited)
      return;
    if (event.type === 'extension_ui_request') {
      this.onUiRequest(session, generation, event);
      return;
    }
    const turn = session.turn;
    if (!turn || turn.generation !== generation.number || !turn.promptSent) return;
    if (turn.run === null) {
      turn.held.push(event);
      return;
    }
    this.feed(session, turn, event);
  }

  private feed(session: Session, turn: Turn, event: PiRpcEvent): void {
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string')
      turn.running.set(event.toolCallId, String(event.toolName ?? 'a tool'));
    if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string')
      turn.running.delete(event.toolCallId);
    this.emitAll(session, turn.mapper.handle(event));
    if (turn.mapper.completed) this.closeTurn(session, turn);
  }

  private onUiRequest(session: Session, generation: Generation, event: PiRpcEvent): void {
    const id = typeof event.id === 'string' ? event.id : '';
    switch (event.method) {
      case 'notify':
        this.onNotify(session, generation, String(event.message ?? ''), event.notifyType);
        return;
      case 'confirm':
        this.onConfirm(session, generation, id, event);
        return;
      case 'select':
      case 'input':
      case 'editor':
        // Not Switch's dialogs: an MCP sign-in (`extensions/mcp/index.js:930`, `:958`), a server
        // choice. Refused, so nothing is written to `mcp-auth.json` (which the next start would
        // refuse, `pi-profile.ts` `checkPiMcpAuth`) and nothing waits for an answer forever.
        if (id) this.answer(generation, { type: 'extension_ui_response', id, cancelled: true });
        return;
      default:
      // `setStatus`, `setWidget`, `setTitle`, `set_editor_text`: nothing to show.
    }
  }

  private onNotify(
    session: Session,
    generation: Generation,
    message: string,
    notifyType: unknown
  ): void {
    if (message.startsWith(PI_BRIDGE_ERROR_NOTICE)) {
      this.emit(session, {
        type: 'runtime.error',
        message: `Switch’s bridge in Pi cannot work (${message.slice(PI_BRIDGE_ERROR_NOTICE.length)}): every tool call is blocked.`,
      });
      return;
    }
    const prefix = generation.nonce ? `switch:${generation.nonce}:run:` : null;
    if (prefix && message.startsWith(prefix)) {
      const rest = message.slice(prefix.length);
      if (!/^[1-9]\d{0,8}$/.test(rest)) return;
      const run = Number(rest);
      // The bridge counts up from 1 in each process; an announcement that does not is not its.
      if (run <= generation.lastRun) return;
      generation.lastRun = run;
      const turn = session.turn;
      if (turn && turn.generation === generation.number && turn.promptSent && turn.run === null) {
        // Bound also when interrupted, so that its `agent_settled` (aborted) ends the turn; its
        // tool calls are cancelled all the same (`onConfirm`).
        turn.run = run;
        for (const held of turn.held.splice(0)) {
          if (turn.mapper.completed) break;
          this.feed(session, turn, held);
        }
      }
      // Otherwise a run no turn of Switch's is waiting for: its tool calls find no turn and are
      // cancelled, its events reach no turn.
      return;
    }
    if (notifyType === 'error' || notifyType === 'warning')
      this.emit(session, { type: 'runtime.warning', message: `Pi: ${message}` });
  }

  /**
   * A tool call the bridge asks about (READY §2.2). Rule 1 first, here: the request must come
   * from the current process under its nonce, for the run bound to the active turn, which is not
   * interrupted; otherwise `cancelled` without a card, and its item ends `declined`. Then the
   * policy (`decidePiToolCall`, rules 2-6): allow, deny, or a card.
   */
  private onConfirm(
    session: Session,
    generation: Generation,
    uiId: string,
    event: PiRpcEvent
  ): void {
    if (!uiId) return;
    const turn = session.turn;
    let message: PiBridgeConfirmMessage | null = null;
    try {
      const parsed: unknown = JSON.parse(String(event.message ?? ''));
      if (isRecord(parsed)) message = parsed as unknown as PiBridgeConfirmMessage;
    } catch {
      message = null;
    }
    const toolCallId = message && typeof message.toolCallId === 'string' ? message.toolCallId : '';
    const cancel = () => {
      if (turn && toolCallId) turn.mapper.markDeclined(toolCallId);
      this.answer(generation, { type: 'extension_ui_response', id: uiId, cancelled: true });
    };
    if (!message || !generation.nonce) return cancel();
    if (
      event.title !== `switch:${generation.nonce}:run:${String(message.run)}` ||
      message.protocolVersion !== 1 ||
      message.nonce !== generation.nonce ||
      typeof message.run !== 'number' ||
      !turn ||
      turn.generation !== generation.number ||
      turn.interrupted ||
      turn.run === null ||
      turn.run !== message.run ||
      turn.mapper.completed ||
      session.stopping
    )
      return cancel();
    const decision = decidePiToolCall(session.policy, {
      toolName: message.toolName,
      toolCallId,
      server: message.server ?? null,
      input: message.input,
    });
    if (decision.kind === 'allow') {
      this.answer(generation, { type: 'extension_ui_response', id: uiId, confirmed: true });
      return;
    }
    if (decision.kind === 'deny') {
      turn.mapper.markDeclined(toolCallId);
      this.answer(generation, { type: 'extension_ui_response', id: uiId, confirmed: false });
      return;
    }
    const requestId = randomUUID();
    session.requests.set(requestId, {
      uiId,
      toolCallId,
      generation: generation.number,
      turnId: turn.turnId,
    });
    this.emit(session, {
      type: 'request.opened',
      turnId: turn.turnId,
      requestId,
      requestType: decision.requestType,
      title: decision.title,
      ...(decision.detail === undefined ? {} : { detail: decision.detail }),
      options: decision.options.map((option) => ({ ...option })),
      ...(decision.connector === undefined ? {} : { connector: decision.connector }),
    });
  }

  private answer(generation: Generation, response: { type: string; [key: string]: unknown }): void {
    if (generation.exited || !generation.client.isAlive) return;
    try {
      generation.client.send(response);
    } catch (error) {
      this.logger.warn('Pi dialog answer could not be sent', { error: errorText(error) });
    }
  }

  /** Cancels open cards (of one turn, or all): Pi gets `cancelled`, the host `request.resolved: cancel`. */
  private cancelRequests(session: Session, turnId?: string): void {
    for (const [requestId, request] of session.requests) {
      if (turnId !== undefined && request.turnId !== turnId) continue;
      session.requests.delete(requestId);
      if (session.turn?.turnId === request.turnId)
        session.turn.mapper.markDeclined(request.toolCallId);
      const generation = session.generations.find((g) => g.number === request.generation);
      if (generation)
        this.answer(generation, {
          type: 'extension_ui_response',
          id: request.uiId,
          cancelled: true,
        });
      this.emit(session, { type: 'request.resolved', requestId, decision: 'cancel' });
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Turns

  async sendTurn(input: ProviderSendTurnInput) {
    const session = this.require(input.sessionId);
    if (session.discovery)
      throw new ProviderSessionError(
        PROVIDER,
        session.id,
        `${NEEDS_MODEL} This Pi was started only to list models.`
      );
    const blocked = session.blocked;
    if (blocked) {
      let result: CleanupResult;
      try {
        result = await this.run(session, (op) => op.wait(blocked.recheck()));
      } catch (error) {
        // R2-E: stopped while the cleanup was checked again, the session's queue is gone: the
        // message is refused, never left in it.
        if (error instanceof SessionStoppedError)
          throw new ProviderSessionError(
            PROVIDER,
            session.id,
            'Session is not running: it was stopped while Switch checked its cleanup, and the message did not run.'
          );
        throw error;
      }
      if (!result.confirmed)
        throw new ProviderSessionError(
          PROVIDER,
          session.id,
          `${blocked.reason} (${result.unconfirmed.join('; ')}); no message runs until they are. Stopping the session tries again.`
        );
      if (session.blocked === blocked) session.blocked = null;
    }
    // R6-B: the message is accepted here, in one synchronous step with the last check of the
    // session (its state and that it is still this session): a stop that came after that check
    // of the cleanup (also in the step `run` takes to let what it held go) emptied the queue
    // already, so the message is refused as in R2-E, never left in a queue no one drains.
    if (this.gone(session))
      throw new ProviderSessionError(
        PROVIDER,
        session.id,
        'Session is not running: it was stopped while Switch checked its cleanup, and the message did not run.'
      );
    session.queue.push(input);
    this.drain(session);
    return { turnId: input.turnId };
  }

  private drain(session: Session): void {
    // R1-A: an ended turn being cleaned up keeps the session busy; `endTurn` drains after it.
    // R5: so does the operation of the last turn until it ended (its prompt's answer included).
    if (
      session.turn ||
      session.turning ||
      session.cleaning ||
      session.stopping ||
      this.sessions.get(session.id) !== session
    )
      return;
    const input = session.queue.shift();
    if (!input) return;
    const turn: Turn = {
      input,
      turnId: input.turnId,
      mapper: new PiTurnMapper({ turnId: input.turnId, model: session.modelId }),
      generation: null,
      run: null,
      promptSent: false,
      runFloor: 0,
      held: [],
      interrupted: false,
      retire: false,
      interruptTimer: null,
      running: new Map(),
    };
    session.turn = turn;
    this.emit(session, { type: 'turn.started', turnId: input.turnId });
    this.emit(session, { type: 'session.state.changed', status: 'running' });
    // R5: the turn is an operation of the session, recorded before its first wait; the next turn
    // starts only once it ended.
    session.turning = true;
    void this.run(session, (op) => this.runTurn(session, turn, op))
      .catch((error: unknown) =>
        this.finishTurn(session, turn, turn.interrupted ? 'interrupted' : 'error', errorText(error))
      )
      .finally(() => {
        session.turning = false;
        this.drain(session);
      });
  }

  /**
   * ER-06, R1-A: cleanup that could not be confirmed is tried again; still unconfirmed, the turn
   * ends with the reason and nothing runs. True when nothing blocks.
   */
  private async clearBlock(session: Session, turn: Turn, op: SessionOperation): Promise<boolean> {
    const blocked = session.blocked;
    if (!blocked) return true;
    // R2-E: stopped during that check, the stop ended this turn; it goes no further.
    const result = await op.wait(blocked.recheck());
    if (result.confirmed) {
      if (session.blocked === blocked) session.blocked = null;
      return true;
    }
    this.finishTurn(
      session,
      turn,
      'error',
      `${blocked.reason} (${result.unconfirmed.join('; ')}); no message runs until they are.`
    );
    return false;
  }

  private async runTurn(session: Session, turn: Turn, op: SessionOperation): Promise<void> {
    // A turn queued behind a cleanup that could not be confirmed: checked before any Pi is
    // started again and before its prompt (R1-A). A block is only set while the session is
    // cleaning up after a turn, when no turn runs, so this check precedes every prompt.
    if (!(await this.clearBlock(session, turn, op))) return;
    if (session.turn !== turn) return;
    let generation = this.current(session);
    if (!generation) {
      // Pi was stopped after an interrupt that did not settle, or a prompt it did not answer: a
      // new process on the same conversation, its transcript checked again (ER-07). R5-A: the
      // choice of the transcript is a step of this operation, as the preparation that follows.
      try {
        const found = this.store.transcript(session.sessionDir, session.piSessionId);
        const target: PiSessionTarget =
          'none' in found
            ? { id: session.piSessionId }
            : await this.sessionTarget(session, true, op);
        generation = await this.spawnGeneration(session, target, op);
      } catch (error) {
        if (session.stopping) return;
        const reason = `Pi could not be started again for this conversation: ${errorText(this.startError(session, error))}`;
        this.finishTurn(session, turn, 'error', reason);
        // Not waited for: that end waits for this operation (R5).
        void this.exited(session, reason);
        return;
      }
    }
    if (turn.interrupted) return this.finishTurn(session, turn, 'interrupted', 'Interrupted.');
    turn.generation = generation.number;
    const wanted = turn.input.model ?? session.pendingModel;
    session.pendingModel = null;
    if (wanted && wanted.id !== session.model) {
      try {
        await this.applyModel(session, generation, wanted, op);
      } catch (error) {
        if (error instanceof SessionStoppedError) throw error;
        // R2-C: an unknown outcome isolates that Pi as an unanswered prompt does (R1-H): it is
        // stopped as the turn ends, and the next turn runs in a new one on the session's model.
        if (error instanceof PiModelUnknownError && session.turn === turn && !this.gone(session)) {
          turn.retire = true;
          generation.retiring = true;
        }
        return this.finishTurn(session, turn, 'error', errorText(error));
      }
      turn.mapper = new PiTurnMapper({ turnId: turn.turnId, model: session.modelId });
    }
    // R1-G: Switch's context goes with the first message Pi takes; kept until then.
    const context = session.context;
    let text = context ? `${context}\n\n${turn.input.text}` : turn.input.text;
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    const files: string[] = [];
    for (const attachment of turn.input.attachments ?? []) {
      if (attachment.mimeType.startsWith('image/'))
        images.push({
          type: 'image',
          data: (await op.wait(readFile(attachment.path))).toString('base64'),
          mimeType: attachment.mimeType,
        });
      else files.push(attachment.path);
    }
    if (files.length)
      text = `${text}\n\nAttached files:\n${files.map((file) => `- ${file}`).join('\n')}`;
    // Pi runs a text that starts with `/` as one of its commands (`agent-session.js:1640-1646`);
    // what Switch sends is always a message to the model (ER-02).
    if (text.startsWith('/')) text = ` ${text}`;
    if (turn.interrupted) return this.finishTurn(session, turn, 'interrupted', 'Interrupted.');
    if (session.turn !== turn || this.current(session) !== generation) {
      // Pi went away (or was stopped) while the message was prepared: `onExit` ends the turn.
      if (session.turn === turn)
        this.finishTurn(session, turn, 'error', 'Pi went away before the message was sent.');
      return;
    }
    turn.promptSent = true;
    turn.runFloor = generation.lastRun;
    let answer: { disposition?: unknown } | undefined;
    try {
      answer = await op.ask(
        generation.client.request<{ disposition?: unknown }>(
          'prompt',
          { message: text, ...(images.length ? { images } : {}) },
          { timeoutMs: this.promptTimeoutMs }
        )
      );
    } catch (error) {
      // R5: the session is ending; its end finishes the turn.
      if (error instanceof SessionStoppedError) throw error;
      // Refused before the run (preflight: no key, no model) or after `before_agent_start` (the
      // announced run is spent, P-02): no `agent_settled` follows (ER-02). A process that went
      // away is ended by `onExit`.
      if (error instanceof PiRpcError)
        return this.finishTurn(
          session,
          turn,
          turn.interrupted ? 'interrupted' : 'error',
          `Pi did not run the message: ${error.message}`
        );
      // R1-H: unanswered in time, the outcome is unknown (Pi may still prepare or run it). No
      // other prompt goes to that Pi: it is stopped with what this turn's runs started, as after
      // an interrupt that did not settle, and the next turn runs in a new one.
      if (generation.client.isAlive && session.turn === turn) {
        turn.retire = true;
        generation.retiring = true;
        this.finishTurn(
          session,
          turn,
          'error',
          `${errorText(error)} Pi did not answer the message in time, so what it did with it is unknown; Switch stops that Pi before anything else runs.`
        );
      }
      return;
    }
    const disposition = answer?.disposition;
    // R1-G: Pi took the message into the conversation.
    if (disposition === 'started' && session.context === context) session.context = '';
    if (disposition === 'started') {
      if (turn.run === null && session.turn === turn) {
        // P-01: the bridge's announcement always comes before this answer. A run it did not
        // announce cannot be approved; it is stopped rather than left unbound.
        void generation.client
          .request('abort', {}, { timeoutMs: this.startTimeoutMs })
          .catch(() => {});
        this.finishTurn(
          session,
          turn,
          'error',
          // D-23 C: the abort is sent, not confirmed.
          'Pi started a run Switch’s bridge did not announce, so Switch asked Pi to stop it.'
        );
      }
      return;
    }
    if (turn.interrupted) return this.finishTurn(session, turn, 'interrupted', 'Interrupted.');
    if (disposition === 'handled')
      return this.finishTurn(
        session,
        turn,
        'completed',
        'Pi handled the message itself; nothing was sent to the model.'
      );
    this.finishTurn(
      session,
      turn,
      'error',
      `Pi did not start a run (${JSON.stringify(disposition)}).`
    );
  }

  private async applyModel(
    session: Session,
    generation: Generation,
    model: ModelSelection,
    op: SessionOperation
  ): Promise<void> {
    const parts = splitModel(model.id);
    if (!parts)
      throw new Error(`Pi names a model as provider/model, not ${JSON.stringify(model.id)}.`);
    let data: unknown;
    try {
      data = await op.ask(
        generation.client.request(
          'set_model',
          { provider: parts.provider, modelId: parts.modelId },
          { timeoutMs: this.startTimeoutMs }
        )
      );
    } catch (error) {
      if (error instanceof SessionStoppedError) throw error;
      // R3-B: an answer with an error does not say the model did not change: Pi 1.4.0 changes it
      // first and then writes the change into the transcript (`agent-session.js:2008-2016`), and
      // a failure there is answered as one (`rpc-mode.js:634-636`). Only `get_state`, asked
      // after that answer (the command has ended, `rpc-mode.js:627-631`), naming the model the
      // session runs proves a refusal before the change (`rpc-mode.js:345-358`); anything else
      // is an unknown outcome (R2-C).
      if (error instanceof PiRpcError) {
        const running = await this.runningModel(generation, op);
        if (running === session.model)
          throw new Error(`Pi could not switch to ${model.id}: ${errorText(error)}`);
        throw new PiModelUnknownError(
          `Pi answered the switch to ${model.id} with an error (${errorText(error)}) and ${running === null ? 'cannot say which model it runs' : `runs ${running}`}: what it runs and what its transcript holds is unknown, so Switch stops that Pi before anything else runs.`
        );
      }
      throw new PiModelUnknownError(
        `Pi did not confirm the switch to ${model.id} (${errorText(error)}); which model it runs is unknown, so Switch stops that Pi before anything else runs.`
      );
    }
    const confirmed = piModel(data);
    if (!confirmed || modelName(confirmed) !== model.id)
      throw new PiModelUnknownError(
        `Pi switched to ${confirmed ? modelName(confirmed) : 'no model'}, not ${model.id}; Switch stops that Pi before anything else runs.`
      );
    session.model = model.id;
    session.modelId = confirmed.id;
  }

  /** The model Pi's `get_state` names (`provider/id`); null when it cannot be told. */
  private async runningModel(generation: Generation, op: SessionOperation): Promise<string | null> {
    try {
      const state = await op.ask(
        generation.client.request<Record<string, unknown>>(
          'get_state',
          {},
          { timeoutMs: this.startTimeoutMs }
        )
      );
      const model = isRecord(state) ? piModel(state.model) : null;
      return model ? modelName(model) : null;
    } catch (error) {
      if (error instanceof SessionStoppedError) throw error;
      return null;
    }
  }

  /** Ends the turn once, for the ends without `agent_settled` (`PiTurnMapper.finish`). */
  private finishTurn(
    session: Session,
    turn: Turn,
    outcome: 'completed' | 'interrupted' | 'error',
    message?: string
  ): void {
    if (session.turn !== turn) return;
    this.emitAll(session, turn.mapper.finish(outcome, message));
    this.closeTurn(session, turn);
  }

  /** R5: the cleanup after a turn is an operation of the session (its end waits for it). */
  private closeTurn(session: Session, turn: Turn): void {
    void this.run(session, (op) => this.endTurn(session, turn, op)).catch((error: unknown) => {
      if (!(error instanceof SessionStoppedError))
        this.logger.warn('Pi turn cleanup failed', { error: errorText(error) });
    });
  }

  private async endTurn(session: Session, turn: Turn, op: SessionOperation): Promise<void> {
    if (session.turn !== turn) return;
    if (turn.interruptTimer) clearTimeout(turn.interruptTimer);
    turn.interruptTimer = null;
    this.cancelRequests(session, turn.turnId);
    session.turn = null;
    // R1-A: busy until the cleanup's result is known; a turn sent meanwhile waits in the queue.
    session.cleaning = true;
    const generation = session.generations.find((g) => g.number === turn.generation);
    try {
      // R4-B, R5: the session's end waits for this cleanup (its warnings come before
      // `session.exited`); a cleanup is never cut off halfway, the check follows its end.
      if (generation && !session.stopping) {
        if (turn.retire) await op.wait(this.retire(session, generation, turnRuns(turn)));
        else if (turn.interrupted && generation.registry && turn.run !== null)
          await op.wait(this.afterInterrupt(session, generation, turnRuns(turn)));
      }
    } finally {
      session.cleaning = false;
    }
    op.check();
    // R2-D: every generation the session kept, not only this turn's.
    const survey = this.survey(session);
    session.background = { alive: survey.alive.length, unknown: survey.unknown.length };
    this.emit(session, {
      type: 'session.state.changed',
      status: session.blocked ? 'error' : 'ready',
    });
    this.drain(session);
  }

  /**
   * Q1 A after an interrupt: the groups of the interrupted run are killed (Pi's abort normally did
   * it through the bridge; this confirms it), and the shells it recorded only as intended (R1-C);
   * those of earlier runs are left and reported.
   */
  private async afterInterrupt(
    session: Session,
    generation: Generation,
    runs: (run: number) => boolean
  ) {
    const ofRun = (group: PiBashGroup) => runs(group.run);
    const intentOfRun = (intent: PiBashIntent) => runs(intent.run);
    const registry = generation.registry;
    const result = await this.kill(registry, ofRun, intentOfRun);
    if (!result.confirmed) {
      const reason = 'Switch could not confirm that the commands of the interrupted run stopped';
      session.blocked = { reason, recheck: () => this.kill(registry, ofRun, intentOfRun) };
      this.emit(session, {
        type: 'runtime.warning',
        message: `${reason}: their state is unknown (${result.unconfirmed.join('; ')}). No message runs until they are gone; stopping the session tries again.`,
      });
    }
    this.reportEarlier(session, generation, runs, result.confirmed);
  }

  /**
   * Whether the generation's Pi is gone (R1-B, R2-A): `dispose` confirmed its exit (it resolves
   * only once the child's `exit` came, `pi-rpc.ts:263`, `:283-286`; a Pi whose link ended while
   * it runs is stopped there), or, when `dispose` failed, no live process carries its launch's
   * `SWITCH_PI_BRIDGE` (procfs read completely). Otherwise it may still live: `stuck`, and
   * nothing of its launch is let go. The one place that sets `exited`.
   */
  /**
   * The cost of D-15 (D-18 A): without procfs a shell is shown to be its bridge's only while its
   * parent, the Pi that started it, lives (`./pi-bash.ts`, R11-A); once that Pi is stopped, none of
   * its groups can be verified, nothing is sent to them, and their end stays unconfirmed (a record
   * that blocks the conversation). So on the `ps` path the groups `select` picks, of a generation
   * whose Pi may still live, are verified and signalled first, in one pass (no wait: what was
   * signalled dies whether Pi lives or not), and only then is Pi stopped; the check after Pi
   * (`kill`, as before) waits for them to be gone. Its own result counts for nothing: the check
   * after Pi decides. With procfs nothing changes (ER-06's order: Pi, then the groups).
   */
  private async killBeforeStop(
    generation: Generation,
    select: (group: PiBashGroup) => boolean,
    unspawned: boolean | ((intent: PiBashIntent) => boolean)
  ): Promise<void> {
    if (generation.exited || !generation.registry || procSource(this.view) !== 'ps') return;
    await this.kill(generation.registry, select, unspawned, 0).catch(() => undefined);
  }

  private async confirmExit(generation: Generation): Promise<CleanupResult> {
    const ok: CleanupResult = { confirmed: true, killed: 0, unconfirmed: [] };
    if (generation.exited) return ok;
    try {
      await generation.client.dispose();
      generation.exited = true;
      generation.stuck = false;
      return ok;
    } catch (error) {
      this.logger.warn('Pi did not stop', { error: errorText(error) });
      generation.stuck = true;
      if (generation.bridgeConfig) {
        // R3-A: confirmed only when every process was seen, and none carries the launch's config.
        const found = processesWith(
          [`${PI_BRIDGE_CONFIG_ENV}=${generation.bridgeConfig}`],
          this.view,
          this.hostStart()
        );
        if (found.pids.length === 0 && found.unreadable === 0) {
          generation.exited = true;
          generation.stuck = false;
          return ok;
        }
      }
      return {
        confirmed: false,
        killed: 0,
        // D-23 C: what Switch did, not what it could not confirm.
        unconfirmed: [`Pi did not exit when Switch tried to stop it (${errorText(error)})`],
      };
    }
  }

  /**
   * A Pi is stopped (an interrupt that did not settle; a prompt it did not answer, R1-H; a model
   * switch it did not confirm, R2-C), then the groups and intended shells of `runs` (the turn's)
   * are killed. Until both are confirmed, nothing runs and no Pi is started again (R1-B): the
   * next turn tries again.
   */
  private async retire(
    session: Session,
    generation: Generation,
    runs: (run: number) => boolean
  ): Promise<void> {
    generation.retiring = true;
    const ofRun = (group: PiBashGroup) => runs(group.run);
    const intentOfRun = (intent: PiBashIntent) => runs(intent.run);
    const stop = async (): Promise<CleanupResult> => {
      // D-15 cost: without procfs the run's groups go first, while Pi lives (`killBeforeStop`).
      await this.killBeforeStop(generation, ofRun, intentOfRun);
      const exit = await this.confirmExit(generation);
      if (!exit.confirmed || !generation.registry) return exit;
      return this.kill(generation.registry, ofRun, intentOfRun);
    };
    const result = await stop();
    if (!result.confirmed) {
      // D-23 C: a stop is said only once confirmed; until then, that it could not be.
      const reason = generation.stuck
        ? 'Switch tried to stop Pi and could not confirm that it exited'
        : 'Switch could not confirm that the commands of the run it tried to stop are gone';
      session.blocked = { reason, recheck: stop };
      this.emit(session, {
        type: 'runtime.warning',
        message: `${reason}: its state is unknown (${result.unconfirmed.join('; ')}). No message runs and no Pi starts again until it is; stopping the session tries again.`,
      });
    }
    this.reportEarlier(session, generation, runs, result.confirmed);
  }

  /**
   * R2-D: commands of every generation of the session that still live, and those that cannot be
   * seen; of `skip.generation`, those of the runs `skip.runs` picks are left out.
   */
  private survey(
    session: Session,
    skip?: { generation: Generation; runs: (run: number) => boolean }
  ): { alive: string[]; unknown: string[] } {
    const all = { alive: [] as string[], unknown: [] as string[] };
    for (const generation of session.generations) {
      if (!generation.registry) continue;
      const runs = skip?.generation === generation ? skip.runs : () => false;
      const found = surveyGroups(generation.registry, runs, this.view, this.hostStart());
      all.alive.push(...found.alive);
      all.unknown.push(...found.unknown);
    }
    return all;
  }

  /**
   * What earlier runs left running (Q1 A: left, and said), in this Pi and in the ones before it,
   * shells recorded only as intended included, and what cannot be seen (R2-D). D-23 C: that the
   * current run's commands were stopped is said only when `stopped` (their cleanup confirmed).
   */
  private reportEarlier(
    session: Session,
    generation: Generation,
    runs: (run: number) => boolean,
    stopped: boolean
  ): void {
    const survey = this.survey(session, { generation, runs });
    if (survey.alive.length > 0)
      this.emit(session, {
        type: 'runtime.warning',
        message: `${survey.alive.length} command(s) started earlier in this session still run in the background; ${stopped ? 'only the commands of the current run were stopped' : 'Switch tried to stop only the commands of the current run, and could not confirm that they are gone'}. Stopping the session tries to end them.`,
      });
    if (survey.unknown.length > 0)
      this.emit(session, {
        type: 'runtime.warning',
        message: `The state of ${survey.unknown.length} command(s) started earlier in this session is unknown.`,
      });
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const session = this.require(sessionId);
    const turn = session.turn;
    if (!turn || turn.interrupted) return;
    turn.interrupted = true;
    this.cancelRequests(session, turn.turnId);
    // Before the prompt is out, `runTurn` ends the turn without sending it.
    if (!turn.promptSent) return;
    const generation = session.generations.find((g) => g.number === turn.generation);
    if (!generation) return;
    void generation.client
      .request('abort', {}, { timeoutMs: this.interruptTimeoutMs })
      .catch(() => {});
    turn.interruptTimer = setTimeout(
      () => void this.forceInterrupt(session, turn, generation),
      this.interruptTimeoutMs
    );
  }

  /**
   * The interrupted run did not settle in time (READY §2.5): Pi is stopped, the run's groups are
   * killed (`afterInterrupt`) and the turn ends `interrupted`; the next turn starts a new
   * generation on the same conversation.
   */
  private forceInterrupt(session: Session, turn: Turn, generation: Generation): void {
    if (session.turn !== turn || session.stopping) return;
    turn.interruptTimer = null;
    // Stopped by `retire` as the turn ends, with the session busy until that is confirmed (R1-B).
    turn.retire = true;
    generation.retiring = true;
    this.finishTurn(
      session,
      turn,
      'interrupted',
      // D-23 C: Pi is stopped as the turn ends (`retire`), after this message; whether that is
      // confirmed comes after, as a warning when it is not.
      'Interrupted; Pi did not stop in time, so Switch stops it; a warning follows if that cannot be confirmed.'
    );
  }

  // -----------------------------------------------------------------------------------------------
  // Approvals, models, questions

  async respondToRequest(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const session = this.require(sessionId);
    const request = session.requests.get(requestId);
    // A card that was cancelled (interrupt, end of turn or process) is gone: a late answer
    // unblocks nothing.
    if (!request)
      throw new ProviderSessionError(PROVIDER, sessionId, `No pending approval ${requestId}`);
    if (decision === 'acceptForSession')
      throw new ProviderSessionError(PROVIDER, sessionId, `Decision ${decision} is not offered`);
    session.requests.delete(requestId);
    const generation = session.generations.find((g) => g.number === request.generation);
    const turn = session.turn;
    if (decision !== 'accept' && turn?.turnId === request.turnId)
      turn.mapper.markDeclined(request.toolCallId);
    if (generation)
      this.answer(
        generation,
        decision === 'accept'
          ? { type: 'extension_ui_response', id: request.uiId, confirmed: true }
          : decision === 'decline'
            ? { type: 'extension_ui_response', id: request.uiId, confirmed: false }
            : { type: 'extension_ui_response', id: request.uiId, cancelled: true }
      );
    this.emit(session, { type: 'request.resolved', requestId, decision });
  }

  async respondToUserInput(
    sessionId: string,
    requestId: string,
    _answers: UserInputAnswers
  ): Promise<void> {
    // `userInput: false`: Pi's own questions (`select`, `input`) are refused, never shown.
    throw new ProviderSessionError(PROVIDER, sessionId, `No pending question ${requestId}`);
  }

  async listModels(sessionId: string): Promise<ModelChoice[]> {
    const session = this.require(sessionId);
    const generation = this.current(session);
    if (!generation) return [];
    return modelChoices(
      await generation.client.request(
        'get_available_models',
        {},
        { timeoutMs: this.startTimeoutMs }
      )
    );
  }

  async setModel(sessionId: string, model: ModelSelection): Promise<void> {
    const session = this.require(sessionId);
    if (session.discovery)
      throw new ProviderSessionError(
        PROVIDER,
        sessionId,
        'This Pi was started only to list models.'
      );
    if (!splitModel(model.id))
      throw new ProviderSessionError(
        PROVIDER,
        sessionId,
        `Pi names a model as provider/model, not ${JSON.stringify(model.id)}.`
      );
    const generation = this.current(session);
    if (session.turn || session.turning || session.cleaning || !generation) {
      session.pendingModel = model;
      return;
    }
    // Busy while Pi switches: a message sent meanwhile waits, and goes to no Pi whose model is
    // unknown (R2-C).
    session.cleaning = true;
    let retired = false;
    try {
      // R5: the switch, and the `retire` of a Pi whose model is unknown, is an operation of the session.
      await this.run(session, async (op) => {
        try {
          await this.applyModel(session, generation, model, op);
        } catch (error) {
          if (error instanceof PiModelUnknownError && !this.gone(session)) {
            retired = true;
            await op.wait(this.retire(session, generation, () => false));
          }
          throw error;
        }
      });
    } catch (error) {
      throw new ProviderSessionError(PROVIDER, sessionId, errorText(error), { cause: error });
    } finally {
      session.cleaning = false;
      if (!this.gone(session)) {
        if (retired)
          this.emit(session, {
            type: 'session.state.changed',
            status: session.blocked ? 'error' : 'ready',
          });
        this.drain(session);
      }
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Ends

  async stopSession(sessionId: string): Promise<void> {
    const session =
      this.sessions.get(sessionId) ?? [...this.ending].find((held) => held.id === sessionId);
    if (session) await this.stop(session);
    // R5-C, D-16: what sessions of this id left to do (every duty of them, D16-C2): stopping it
    // again tries once more.
    const mine = [...this.duties].filter((duty) => duty.sessionId === sessionId);
    await Promise.all(mine.map((duty) => this.settleDuty(duty)));
  }

  async stopAll(): Promise<void> {
    const all = new Set([...this.sessions.values(), ...this.ending]);
    await Promise.all([...all].map((session) => this.stop(session)));
    await Promise.all([...this.duties].map((duty) => this.settleDuty(duty)));
  }

  /**
   * R3-C: a session ends once. A stop while it ends (a second stop, `stopAll`, Pi's own end, a
   * stop of its start) waits for that end, which settles after its cleanup and `session.exited`.
   */
  private stop(session: Session): Promise<void> {
    if (session.ending) return session.ending;
    if (!session.started) {
      // R1-F, R5: the start ends at its next step and leaves nothing; the end waits for it.
      session.cancelled = true;
      return this.track(session, () => this.end(session, 'Session stopped while it started'));
    }
    if (session.turn) session.turn.interrupted = true;
    return this.exited(session, 'Session stopped');
  }

  /**
   * D-16: a duty taken into the ledger, its record and release tried at once (`finishDuty`). Only
   * a duty with something to do is kept; what is still left, by reason.
   */
  private takeDuty(
    of: { sessionId: string; sessionDir: string; piSessionId: string },
    steps: {
      remove: PiPendingLaunch[];
      unrecorded: PiPendingLaunch[];
      release: (() => void) | null;
    }
  ): string[] {
    const duty: Duty = { id: ++this.nextDuty, ...of, ...steps, trying: null };
    this.duties.add(duty);
    return this.finishDuty(duty);
  }

  /**
   * D-16: the steps of a duty that need no wait, each on its own: the record of what it could not
   * remove or confirm (durable: from then on every start of the conversation tries it first), then,
   * once nothing of this host is left unrecorded or unremoved, the conversation let go. The duty
   * leaves the ledger once all its steps are done. Never throws; what is still left, by reason.
   */
  private finishDuty(duty: Duty): string[] {
    const reasons: string[] = [];
    if (duty.unrecorded.length > 0)
      try {
        this.store.addCleanup(duty.sessionDir, duty.piSessionId, duty.unrecorded);
        duty.unrecorded = [];
      } catch (error) {
        reasons.push(`the record of it could not be written (${errorCode(error)})`);
      }
    if (duty.remove.length === 0 && duty.unrecorded.length === 0 && duty.release)
      try {
        duty.release();
        duty.release = null;
      } catch (error) {
        reasons.push(
          `Switch could not let Pi conversation ${duty.piSessionId} go (the release of its lock, ${errorCode(error)})`
        );
      }
    if (duty.remove.length === 0 && duty.unrecorded.length === 0 && duty.release === null)
      this.duties.delete(duty);
    return reasons;
  }

  /**
   * R5-C, D-16: tries a duty again: its launch directories (each entry of the record dropped once
   * its directory is gone), then the record, then the release (`finishDuty`). One try at a time;
   * what is still left, by reason.
   */
  private settleDuty(duty: Duty): Promise<string[]> {
    if (duty.trying) return duty.trying;
    const trying = (async () => {
      const reasons: string[] = [];
      for (const launch of [...duty.remove]) {
        try {
          await removeLaunch(launch.runDir);
        } catch (error) {
          reasons.push(
            `Switch could not remove launch directory ${launch.runDir} (${errorCode(error)})`
          );
          continue;
        }
        duty.remove = duty.remove.filter((held) => held !== launch);
        duty.unrecorded = duty.unrecorded.filter((held) => held.runDir !== launch.runDir);
        try {
          this.store.settleCleanup(duty.sessionDir, duty.piSessionId, launch.runDir, 'drop');
        } catch {
          // Its entry says it ended: the next start of the conversation drops it.
        }
      }
      return [...reasons, ...this.finishDuty(duty)];
    })().finally(() => {
      duty.trying = null;
    });
    duty.trying = trying;
    return trying;
  }

  /** R5-C: settles what ended sessions of conversation `id` left here; what is still left. */
  private async settleConversation(sessionDir: string, id: string): Promise<string[]> {
    const mine = [...this.duties].filter(
      (duty) => duty.piSessionId === id && resolvePath(duty.sessionDir) === resolvePath(sessionDir)
    );
    const reasons = await Promise.all(mine.map((duty) => this.settleDuty(duty)));
    return reasons.flat();
  }

  /**
   * R3-C: records `work` as the end of `session` before it runs (a stop asked for while it
   * starts, from a listener, joins it), until it settled.
   */
  private track(session: Session, work: () => Promise<void>): Promise<void> {
    let settle!: { resolve: () => void; reject: (error: unknown) => void };
    const ending = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    session.ending = ending;
    this.ending.add(session);
    work().then(
      () => {
        this.ending.delete(session);
        settle.resolve();
      },
      (error: unknown) => {
        this.ending.delete(session);
        settle.reject(error);
      }
    );
    return ending;
  }

  /**
   * ER-06's order for every Pi of the session: stop Pi (SIGTERM, then SIGKILL, `PiRpcClient`),
   * then kill every registered group of every generation (Q1 A) and check that none is left. A
   * launch directory (`launch.runDir`) goes once its Pi's exit and its groups are confirmed;
   * otherwise it is kept with its registry and recorded beside the conversation
   * (`<X>.cleanup.json`, written by `account`), durably, before the conversation is let go: the
   * next start of it, in any adapter, tries again first (R1-B, R1-E).
   *
   * R6-A: never throws, and every generation is gone through. A launch whose processes were
   * confirmed gone and whose directory could not be removed is the session's to account for
   * (`leftovers`: recorded as ended, removal tried again by the duty, D-16); anything else that
   * fails leaves that launch unconfirmed (`pending`, never `ended`), so no Pi starts on it.
   *
   * D-15 cost (D-18 A): without procfs the groups of each generation are signalled first, while
   * its Pi lives (`killBeforeStop`); the order above is then the check that they are gone.
   */
  private async stopGenerations(
    session: Session
  ): Promise<{ results: CleanupResult[]; pending: PiPendingLaunch[] }> {
    const unseen = (error: unknown): CleanupResult => ({
      confirmed: false,
      killed: 0,
      unconfirmed: [`Switch could not check what is left (${errorCode(error)})`],
    });
    const exits = new Map<Generation, CleanupResult>();
    for (const generation of session.generations) {
      generation.retiring = true;
      // D-15 cost: without procfs its groups go first, while its Pi lives (`killBeforeStop`).
      await this.killBeforeStop(generation, () => true, true);
      exits.set(generation, await this.confirmExit(generation).catch(unseen));
    }
    const results: CleanupResult[] = [];
    const pending: PiPendingLaunch[] = [];
    for (const generation of session.generations) {
      const exit = exits.get(generation) as CleanupResult;
      if (!generation.registry) {
        results.push(exit);
        continue;
      }
      const groups = await this.kill(generation.registry, () => true, true).catch(unseen);
      const result: CleanupResult = {
        confirmed: exit.confirmed && groups.confirmed,
        killed: groups.killed,
        unconfirmed: [...exit.unconfirmed, ...groups.unconfirmed],
      };
      results.push(result);
      if (!generation.launch.runDir) continue;
      const launch: PiPendingLaunch = {
        runDir: generation.launch.runDir,
        registry: generation.registry,
        bridgeConfig: generation.bridgeConfig,
      };
      if (!result.confirmed) {
        // O-1 A (FAP-01): its Pi's exit was seen (`confirmExit`), its groups' end was not: the
        // record keeps the exit, so that the next try, by any adapter, looks only for the
        // launch's commands. (A launch whose processes were all confirmed gone is recorded as
        // ended, which says more.)
        pending.push(exit.confirmed ? { ...launch, piExited: true } : launch);
        continue;
      }
      try {
        await removeLaunch(launch.runDir);
      } catch (error) {
        session.leftovers.push({ launch, reason: errorCode(error) });
      }
    }
    return { results, pending };
  }

  /**
   * R5-B, R5-C: what the end of a session leaves, accounted for once every operation of it settled
   * and before the conversation is let go. Launches whose processes were not confirmed gone
   * (`pending`) and launch directories an operation made and could not remove (`leftovers`: no Pi
   * ran in them, so they are recorded as ended) are recorded beside the conversation, each with the
   * identity of this host (the one its `owner.json` names), so that the record can be settled
   * without the directory. The conversation is kept by this host (a duty, D-16) while a
   * directory of it could not be removed (its `owner.json` names a live host, which the recovery
   * takes for a busy one) or the record could not be written; a later stop tries again.
   *
   * D-16: all of it is one duty of this adapter (`takeDuty`): the record, the removals, the
   * release, each tried again on its own until done. Never throws; `kept`: the duty is still in
   * the ledger (the conversation stays with this host until it is done).
   */
  private account(
    session: Session,
    results: CleanupResult[],
    pending: PiPendingLaunch[]
  ): { left: string[]; kept: boolean } {
    const left = results.flatMap((result) => result.unconfirmed);
    const owner =
      session.ownerStart === null ? {} : { owner: { pid: process.pid, start: session.ownerStart } };
    const remove = session.leftovers.splice(0).map(({ launch, reason }) => {
      left.push(`Switch could not remove launch directory ${launch.runDir} it made (${reason})`);
      return { ...launch, ...owner, ended: true as const };
    });
    const records = session.discovery
      ? []
      : [...pending.map((launch) => ({ ...launch, ...owner })), ...remove];
    const release = session.releaseLock;
    session.releaseLock = null;
    if (records.length === 0 && remove.length === 0 && release === null)
      return { left, kept: false };
    const before = this.duties.size;
    left.push(
      ...this.takeDuty(
        { sessionId: session.id, sessionDir: session.sessionDir, piSessionId: session.piSessionId },
        { remove: session.discovery ? [] : remove, unrecorded: records, release }
      )
    );
    return { left, kept: this.duties.size > before };
  }

  /**
   * The link to a Pi Switch did not stop ended: Pi went away by itself (D-10 A5: also in the
   * middle of a tool call), or a stream of it failed while it may still run (`pi-rpc.ts:422-425`
   * ends the link as an exit does). The session ends; its Pi counts as gone only once
   * `confirmExit` (in `stopGenerations`) saw it exit, and until then nothing of its launch or
   * conversation is let go (R2-A). While the session starts, the start's waiting commands fail
   * and the start's end (`end`) does the same.
   */
  private async onExit(session: Session, generation: Generation, reason: string): Promise<void> {
    if (generation.retiring || generation.exited || generation.linkLost) return;
    generation.linkLost = true;
    if (this.sessions.get(session.id) !== session || session.stopping || !session.started) return;
    const turn = session.turn;
    // What Pi said as it went: its last `Error:` line (Node prints the stack and its version
    // after it), else its last lines.
    const lines = generation.client.stderr.trim().split('\n');
    const errorLine = [...lines].reverse().find((line) => /^\s*\w*Error\b.*:/.test(line));
    const stderr = errorLine?.trim() ?? lines.slice(-3).join('\n');
    let message = `Pi stopped unexpectedly (${reason}).`;
    if (turn && turn.generation === generation.number && turn.running.size > 0)
      message = `Pi stopped unexpectedly while running ${[...new Set(turn.running.values())].join(', ')} (${reason}). Pi ${PI_VERSION} ends this way when a command's long output cannot be written to its temporary directory (TMPDIR); Switch stops the processes the command left, and warns if that cannot be confirmed.`;
    if (stderr) message = `${message}\n${stderr}`;
    await this.exited(session, message);
  }

  /**
   * The end of a session, asked for or not: turns end, Pi and its processes stop, the lock goes.
   * One per session (R3-C): a later call waits for the end under way.
   */
  private exited(session: Session, reason: string): Promise<void> {
    if (session.ending) return session.ending;
    if (this.sessions.get(session.id) !== session || session.stopping) return Promise.resolve();
    return this.track(session, () => this.end(session, reason));
  }

  /**
   * R5: the end of a session, the one place that lets its conversation go. From its first step no
   * operation of the session starts (`run`) and every one under way goes no further at its next
   * step (`checkCancelled`), a wait on Pi at once (`halts`). Its Pi are stopped first (a turn
   * waiting on its prompt then ends), then every operation is waited for, its own cleanup
   * included; only then is what is left accounted for (`account`), the lock let go or kept, and
   * the session reported gone. A start that failed ends here too, without `session.exited`.
   */
  private async end(session: Session, reason: string): Promise<void> {
    session.stopping = true;
    for (const halt of [...session.halts]) halt();
    const turn = session.turn;
    this.cancelRequests(session);
    if (turn) {
      if (turn.interruptTimer) clearTimeout(turn.interruptTimer);
      this.emitAll(session, turn.mapper.finish(turn.interrupted ? 'interrupted' : 'error', reason));
      session.turn = null;
    }
    for (const input of session.queue.splice(0))
      this.emit(session, {
        type: 'turn.completed',
        turnId: input.turnId,
        outcome: 'error',
        message: reason,
        usage: [],
      });
    const { results, pending } = await this.stopGenerations(session);
    // R4-B, R5: what the session still does (the start, a turn, a Pi being prepared, a cleanup
    // under way) settles, its own cleanup included, before the conversation is let go and the
    // session is reported gone. No generation is added meanwhile (`connect` checks).
    await this.settleTasks(session);
    // D-16: what is left is a duty of this adapter, which outlives the session: the record, the
    // removals, and the lock last (kept with this host while a directory of it is left or a launch
    // is not recorded). Nothing of it throws: the end always ends.
    const { left, kept } = this.account(session, results, pending);
    if (left.length > 0)
      this.emit(session, {
        type: 'runtime.warning',
        message: `Switch could not confirm that every process of this Pi session stopped, or clean up after it; their state is unknown (${left.join('; ')}). The conversation does not start again until they are gone${kept ? '; this Switch keeps it until then, and stopping the session again tries once more' : ''}.`,
      });
    this.sessions.delete(session.id);
    if (!session.started && !session.cancelled) return;
    this.emit(session, { type: 'session.state.changed', status: 'stopped' });
    this.emit(session, { type: 'session.exited', reason });
  }

  private require(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session || session.stopping || !session.started)
      throw new ProviderSessionError(PROVIDER, sessionId, 'Session is not running');
    return session;
  }

  private emitAll(session: Session, events: readonly PiTurnEvent[]): void {
    for (const event of events) this.emit(session, event as Emittable);
  }

  private emit(session: Session, event: Emittable): void {
    const full = {
      ...event,
      eventId: randomUUID(),
      provider: PROVIDER,
      sessionId: session.id,
      createdAt: new Date().toISOString(),
    } as ProviderRuntimeEvent;
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch (cause) {
        this.logger.error('Pi event listener failed', { error: String(cause) });
      }
    }
  }
}

export function createPiAdapter(options: PiAdapterOptions = {}): ProviderAdapter {
  return new PiAdapter(options);
}
