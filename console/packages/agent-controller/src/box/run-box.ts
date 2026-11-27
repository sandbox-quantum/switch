import { resolve } from 'node:path';
import type { OpenAgentStream } from '@switch-console/agent-providers';
import {
  boxLimitFromEnv,
  OWNER_MARKER_ENV,
  recordedOwnerAlive,
  type RestartNotice,
} from '@switch-console/agent-providers/box';
import { ConfigurationError, UsageError } from '../errors';
import { EXIT_FAILURE, EXIT_OK } from '../exit-codes';
import { HostTickets } from '../host-tickets';
import { errorCode, errorMessage, type Logger } from '../log';
import { dataLayout, type DataLayout } from '../paths';
import { type ProviderRechecks, RechecksNotServing } from '../provider-rechecks';
import type { AgentRuntime, InProcessBox } from '../runtime';
import type { BoxControllerDeps } from './controller-box';
import { controllerReserveFromEnv } from './controller-reserve';
import { gatewayProxyProblem, takeGatewayProxy } from './gateway-proxy';
import { inProcessBox } from './in-process-box';
import { type LauncherAddress, parseLoopback } from './launcher-address';
import { LauncherLink } from './launcher-link';
import { runLauncher } from './launcher-main';
import { LauncherMeasure } from './launcher-measure';
import { LauncherRunner } from './launcher-runner';
import {
  eventsSince,
  formatEventsSince,
  formatLiveStatus,
  imageDigestFromEnv,
  LIVE_STATUS_DIR_ENV,
  liveStatusDirFromEnv,
  liveStatusDirOrOff,
  readLiveStatus,
} from './live-status';
import { givenLoginCheck } from './login-check';
import { type OwnerMarkers, openOwnerMarkers, processesOf, signalProven } from './owner-marker';
import { restAfterFromEnv, SWEEP_GRACE_MS } from './rest';
import { sweepOwned } from './rest-sweep';
import { isSplitBox, splitFlagsProblem } from './split-flags';
import { LaunchGate, SplitRuntime } from './split-runtime';

/**
 * Box mode's half of `main.ts`: the flags only a box takes, the parts a box
 * controller is built with, and the commands only a box runs. Loaded only
 * through `await import('./box/run-box')` inside a box-mode branch, so a
 * desktop or v1 controller never loads it. Defines things only: nothing runs
 * at import.
 */

/** `run`'s flags only a box takes; outside box mode they are unknown, as before. */
export const BOX_RUN_OPTIONS = {
  // The controller as its own user, every host through the launcher.
  'launcher-socket': { type: 'string' },
  // A split box on gVisor: loopback inside the pod (a socket isn't shared between containers there).
  'launcher-address': { type: 'string' },
  'agents-data-dir': { type: 'string' },
  'agents-workspaces': { type: 'string' },
  // Test boxes only: the box template marks the box (`--test-box`).
  'test-box': { type: 'boolean' },
  // Off unless the box template gives it, and refused unless the box is a
  // split test box (`splitFlagsProblem`). It lets an operator's own exec into
  // the agents container keep running, counted to the box, instead of being
  // ended as a process no agent owns. Nothing from Core or a message can turn
  // it on. The launcher logs each exec once, with its pid and command name
  // only, and the box's status reports `operator_exec`.
  'operator-exec': { type: 'boolean' },
} as const;

/** `status`'s flags only a box takes: the live status file. */
export const BOX_STATUS_OPTIONS = {
  live: { type: 'boolean' },
  json: { type: 'boolean' },
  'live-dir': { type: 'string' },
  since: { type: 'string' },
} as const;

export type BoxRunFlags = {
  'launcher-socket'?: string;
  'launcher-address'?: string;
  'agents-data-dir'?: string;
  'agents-workspaces'?: string;
  'test-box'?: boolean;
  'operator-exec'?: boolean;
};

/** `status`'s box-only flags, as parsed. */
export type BoxStatusFlags = {
  live?: boolean;
  json?: boolean;
  'live-dir'?: string;
  since?: string;
};

/**
 * The box flags from what `parseArgs` gave for `options` (`BOX_RUN_OPTIONS`
 * or `BOX_STATUS_OPTIONS`), each held to its declared type.
 */
function flagsOf<T>(
  values: Record<string, unknown>,
  options: Record<string, { type: 'string' | 'boolean' }>
): T {
  const flags: Record<string, string | boolean> = {};
  for (const [name, { type }] of Object.entries(options)) {
    const value = values[name];
    if (value === undefined) continue;
    if (typeof value !== type) throw new UsageError(`--${name} takes a ${type}.`);
    flags[name] = value as string | boolean;
  }
  return flags as T;
}

export function boxRunFlags(values: Record<string, unknown>): BoxRunFlags {
  return flagsOf<BoxRunFlags>(values, BOX_RUN_OPTIONS);
}

export function boxStatusFlags(values: Record<string, unknown>): BoxStatusFlags {
  return flagsOf<BoxStatusFlags>(values, BOX_STATUS_OPTIONS);
}

/**
 * Takes the gateway's proxy password out of this process's environment before
 * anything is started, so no child inherits it (`gateway-proxy.ts`). Box mode
 * only: it comes in `SWITCH_CONTROLLER_GATEWAY_PROXY`, which the box's
 * entrypoint sets, never on the command line; it is held in memory for the
 * gateway's transport and never logged, reported or named in an error.
 */
export function takeBoxGatewayProxy(env: NodeJS.ProcessEnv): void {
  takeGatewayProxy(env);
}

/**
 * What is wrong with a box `run`'s flags, before anything opens: the split
 * box's flags together, and the gateway's proxy on a split box only. Throws
 * `UsageError`.
 */
export function checkBoxRunFlags(
  flags: BoxRunFlags,
  agentRuntime: string,
  env: NodeJS.ProcessEnv
): void {
  const splitProblem = splitFlagsProblem(
    {
      agentRuntime,
      launcherSocket: flags['launcher-socket'],
      launcherAddress: flags['launcher-address'],
      agentsDataDir: flags['agents-data-dir'],
      agentsWorkspaces: flags['agents-workspaces'],
      testBox: flags['test-box'] === true,
      operatorExec: flags['operator-exec'] === true,
    },
    env
  );
  if (splitProblem) throw new UsageError(splitProblem);
  takeGatewayProxy(env);
  const proxyProblem = gatewayProxyProblem(splitOf(flags));
  if (proxyProblem) throw new UsageError(proxyProblem);
}

function splitOf(flags: BoxRunFlags): boolean {
  return isSplitBox({
    launcherSocket: flags['launcher-socket'],
    launcherAddress: flags['launcher-address'],
  });
}

/** How a box controller runs: what `main.ts` hands `runController` and the runtime in box mode. */
export type BoxRun = {
  /** A split box's runtime, through the launcher; null where agent hosts run here. */
  splitRuntime:
    | ((
        openStream: (agentId: string) => OpenAgentStream,
        workspaces: string,
        restartNotice?: (agentId: string) => RestartNotice
      ) => AgentRuntime)
    | null;
  /** What a box's in-process agent hosts add (`InProcessBox`), given the controller's restart notices. */
  inProcess: (restartNotice?: (agentId: string) => RestartNotice) => InProcessBox;
  /**
   * The detached runtime's box half: a stale `control.json` a host left when it
   * died is cleared before the next launch, and the host carries its owner marker.
   */
  detached: { box: true; ownerMarkers?: OwnerMarkers };
  /** On a split box, a provider's CLI never runs as the controller's user, so no test prompt. */
  verifyLogin: boolean;
  /** Where agents with no directory of their own work, when the box names a folder for them. */
  workspacesFor: (() => string) | null;
  /** The box-only parts of `runController`'s deps. */
  deps: BoxControllerDeps;
};

/**
 * Builds a box controller's parts once its store is open: owner markers, the
 * controller's memory reserve, rest and its sweep, the live status, the
 * provider gateway, and on a split box the launcher's link, tickets, runner
 * and gate.
 */
export async function prepareBoxRun(input: {
  flags: BoxRunFlags;
  agentRuntime: string;
  dataDir: string;
  layout: DataLayout;
  env: NodeJS.ProcessEnv;
  log: Logger;
  rechecks: ProviderRechecks;
}): Promise<BoxRun> {
  const { flags, agentRuntime, dataDir, layout, env, log, rechecks } = input;
  // A marker in the controller's own environment (started from an agent's
  // shell, say) would pass to everything it starts for itself.
  delete env[OWNER_MARKER_ENV];
  const ownerMarkers = await openOwnerMarkers(dataDir, log).catch((error: unknown) => {
    log.error('Owner markers are off: the resting sweep stops nothing', {
      error: errorMessage(error),
    });
    return undefined;
  });
  // Markers are only given where agent hosts run as this controller's own processes.
  const markers = agentRuntime === 'default' ? ownerMarkers : undefined;
  const split = splitOf(flags);
  // Memory kept back for the controller under the box's limit: always some on
  // a split box, none elsewhere unless set. The limit is read quietly here;
  // the valve says if it isn't valid.
  const controllerReserve = controllerReserveFromEnv(env, {
    split,
    podLimit: boxLimitFromEnv(env, { warn: () => {} }),
    log,
  });
  const launcherAddress: LauncherAddress | null =
    flags['launcher-address'] !== undefined
      ? parseLoopback(flags['launcher-address'])
      : flags['launcher-socket'] !== undefined
        ? { kind: 'path', path: flags['launcher-socket'] }
        : null;
  const launcher =
    launcherAddress === null
      ? null
      : splitMode({
          address: launcherAddress,
          markers: ownerMarkers,
          log,
          // A login check that ran before the launcher linked (just after the
          // box wakes) couldn't try the given login: check every provider
          // again now, which also starts agents waiting on one.
          onConnected: () =>
            void rechecks.run().then(
              () => log.info('Checked the providers again once the launcher connected'),
              (error: unknown) => {
                // Not connected to Switch yet: its first check runs with the launcher linked.
                if (error instanceof RechecksNotServing) return;
                // Anything else is said, by its kind only, never its message.
                log.warn('Re-check after the launcher connected failed', {
                  kind: errorCode(error),
                });
              }
            ),
        });
  const agentsLayout = flags['agents-data-dir']
    ? dataLayout(resolve(flags['agents-data-dir']))
    : null;
  let splitRuntime: SplitRuntime | null = null;
  const runner = launcher
    ? new LauncherRunner({
        link: launcher.link,
        tickets: launcher.tickets,
        markers: launcher.markers,
        credentials: (agentId) => splitRuntime?.credentialsFor(agentId) ?? null,
      })
    : null;
  // The box valve's figures through the launcher: only for agents launched here.
  const measure =
    launcher && runner
      ? new LauncherMeasure({
          link: launcher.link,
          now: Date.now,
          launched: (agentId) => runner.launchOf(agentId) !== null,
          log: (event, fields) => log.warn(`Launcher: ${event}`, fields),
        })
      : null;
  const agentsWorkspaces = flags['agents-workspaces'];
  return {
    splitRuntime:
      launcher && runner && agentsLayout
        ? (_openStream, workspaces) =>
            (splitRuntime = new SplitRuntime({
              runner,
              link: launcher.link,
              store: layout,
              agents: agentsLayout,
              workspaces,
              gate: launcher.gate,
            }))
        : null,
    inProcess: (restartNotice) =>
      inProcessBox({
        restartNotice: (agentId) => restartNotice?.(agentId),
        ownerEnv: (agentId) => ownerMarkers?.environmentFor(agentId) ?? {},
      }),
    detached: { box: true, ...(ownerMarkers ? { ownerMarkers } : {}) },
    // A split box's provider CLIs run only in the agents container, never as
    // this controller's user, so a test prompt from here would test nothing.
    // A given login is checked there instead: its sign-in check runs through
    // the launcher once it links (`onConnected` above), `checkGivenLogin`
    // asks the provider, and a check that could not run shows as not checked
    // and is tried again (`ProviderStatuses`), never as signed in.
    verifyLogin: launcher === null,
    workspacesFor: agentsWorkspaces ? () => resolve(agentsWorkspaces) : null,
    deps: {
      // Hosted boxes set it to 600000, the shipping default; agents running as
      // users of their own never rest.
      restAfterMs: agentRuntime === 'default' ? restAfterFromEnv(env, log) : null,
      // Off unless the box's template names a folder (never the data folder).
      liveStatusDir: await liveStatusDirOrOff(env, dataDir, log),
      imageDigest: imageDigestFromEnv(env),
      controllerReserve,
      // Off unless the box's template sets it; the gateway starts beside the relay.
      providerGateway: agentRuntime === 'default' && env.SWITCH_CONTROLLER_PROVIDER_GATEWAY === '1',
      // Claude's own check can't tell a good Vertex key from a made-up one
      // here (the box buys Google's tokens itself), so the box asks Google.
      checkGivenLogin: givenLoginCheck(),
      // The valve's host proof: the same markers rest's sweep proves with.
      ...(markers ? { ownerMarkers: markers } : {}),
      // What a resting agent left running ends with proof it is the agent's.
      sweepAgent: launcher
        ? async (agentId) => {
            const reply = await launcher.link.order({ kind: 'sweep', agentId });
            if (!reply.ok || !reply.counts)
              throw new Error(`The launcher did not sweep the agent (${reply.code ?? 'failed'}).`);
            return {
              signalled: reply.counts.signalled,
              killed: reply.counts.signalled,
              gone: reply.counts.gone,
              notProven: reply.counts.notProven,
            };
          }
        : markers
          ? (agentId) =>
              sweepOwned(
                {
                  find: () => processesOf(markers, agentId),
                  signal: (entry, signal) => signalProven(entry, signal, markers),
                },
                SWEEP_GRACE_MS
              )
          : undefined,
      split:
        launcher && runner && measure
          ? {
              link: launcher.link,
              tickets: launcher.tickets,
              measure,
              runner,
              gate: launcher.gate,
              operatorExec: flags['operator-exec'] === true,
              // The gateway starts inside the controller: it hands its probe over then.
              setProbeEnv: (probeEnv) => splitRuntime?.setProbeEnv(probeEnv),
            }
          : undefined,
    },
  };
}

/**
 * A split box's parts, made before the controller: the launcher socket's link,
 * the one-time host tickets and the launch gate. The markers are required:
 * without them nothing is provable, so the box refuses to start rather than
 * run its agents unproven.
 */
function splitMode(input: {
  address: LauncherAddress;
  markers: OwnerMarkers | undefined;
  log: Logger;
  /** The launcher linked: a given login's sign-in check can run now. */
  onConnected: () => void;
}): { link: LauncherLink; tickets: HostTickets; gate: LaunchGate; markers: OwnerMarkers } {
  if (!input.markers)
    throw new ConfigurationError(
      'This box runs agents through the launcher, which needs the owner markers; they could not be opened.'
    );
  const link = new LauncherLink({
    address: input.address,
    now: Date.now,
    // Fixed events with ids and numbers only.
    log: (event, fields) => {
      if (event === 'launcher_connected') {
        input.log.info('The launcher connected', fields);
        input.onConnected();
      } else input.log.warn(`Launcher: ${event}`, fields);
    },
  });
  return {
    link,
    tickets: new HostTickets(),
    gate: new LaunchGate(Date.now),
    markers: input.markers,
  };
}

/**
 * `status --live` and `status --json`: what the running box controller last
 * wrote about itself (`live-status.json`), counts and states only. Reads one
 * file and nothing else, so it is safe to run inside a box at any time.
 */
export async function boxStatusCommand(
  values: BoxStatusFlags,
  env: NodeJS.ProcessEnv
): Promise<number> {
  const dir = values['live-dir'] ?? liveStatusDirFromEnv(env);
  if (!dir)
    throw new ConfigurationError(
      `The live status is off here: pass --live-dir, or set ${LIVE_STATUS_DIR_ENV} as the running controller has it.`
    );
  let sinceMs: number | null = null;
  if (values.since !== undefined) {
    sinceMs = Date.parse(values.since);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(values.since) || Number.isNaN(sinceMs))
      throw new ConfigurationError('--since takes an ISO time, such as 2026-10-28T16:00:00Z.');
  }
  const now = Date.now();
  const read = await readLiveStatus(dir, now);
  if (read.kind === 'missing' || read.kind === 'unreadable') {
    process.stderr.write(
      read.kind === 'missing'
        ? `No live status in ${dir}: the controller is not running here, or has not written one yet.\n`
        : `The live status in ${dir} can't be read (${read.why}).\n`
    );
    return EXIT_FAILURE;
  }
  const since = sinceMs === null ? null : eventsSince(read.status, sinceMs);
  process.stdout.write(
    values.json === true
      ? `${JSON.stringify({
          state: read.kind,
          age_ms: read.ageMs,
          ...read.status,
          ...(since ? { since } : {}),
        })}\n`
      : `${read.kind === 'stale' ? `STALE: last written ${Math.round(read.ageMs / 1000)}s ago; the controller may have stopped.\n` : ''}${formatLiveStatus(read.status, read.ageMs, now)}${since ? `\n${formatEventsSince(since)}` : ''}\n`
  );
  return read.kind === 'fresh' ? EXIT_OK : EXIT_FAILURE;
}

/** What `status` needs to read a box's agent hosts from disk (`observeOnDisk`). */
export function statusObserveBox(): Pick<InProcessBox, 'recordedOwnerAlive'> {
  return { recordedOwnerAlive };
}

/** `launcher`: the agents container's pid 1 on boxes where the controller runs as its own user. */
export function runBoxLauncher(
  args: string[],
  defaults: { bundle: string; version: string }
): Promise<number> {
  return runLauncher(args, defaults);
}
