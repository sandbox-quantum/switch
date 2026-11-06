import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SwitchHttpError, type SwitchClient } from '../clients/switch-client.ts';
import {
  describeEnv,
  durationMs,
  exploreTimeLimitFrom,
  laneFrom,
  readDotEnvFile,
  type HarnessEnv,
} from '../core/env.ts';
import { RunContext, type NameScope } from '../core/run.ts';
import {
  describeServerLogCheck,
  expectNoServerErrors,
  ServerLogWatch,
  type ScenarioObserver,
  type ServerLogError,
} from '../core/server-log.ts';
import { resolveLane, type LaneResolution } from '../core/suite.ts';
import { Fixtures } from '../fixtures/fixtures.ts';
import { PROPERTIES } from './properties.ts';
import { readTrace, type TraceSummary } from './trace.ts';

/**
 * The explore lane: Bombadil drives the gateway UI at random for
 * `SWITCH_E2E_EXPLORE_TIME_LIMIT`, checking the properties in `spec/gateway.ts`
 * in every state it reaches. Runs when `SWITCH_E2E_LANE=explore`, with
 * `SWITCH_GATEWAY_UI_URL` naming where the UI is served.
 *
 * The explorer deletes, archives and renames whatever it finds, so the lane
 * runs only on an ephemeral stack. It starts on the login page and signs in
 * from there (the spec's `signIn`), so no session cookie is ever passed on
 * Bombadil's command line, which it prints back. The admin's credentials go
 * beside a copy of the spec in a private temporary directory, never into the
 * output.
 *
 * One case explores; then one case per property reports what the trace says
 * about it, with the first violating state's page and screenshot; then the
 * server log is checked for the whole exploration, as the browser lane checks
 * it per scenario. Bombadil's own log and trace go to
 * `$SWITCH_E2E_OUTPUT_DIR/explore`, readable with `bombadil browser inspect`.
 */

const SPEC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spec');

/** Bombadil's exit codes (`bombadil browser test`). */
const EXIT_CLEAN = 0;
const EXIT_STALLED = 1;
const EXIT_VIOLATIONS = 2;

/** Over the time limit, what the explorer may take to start Chromium and write its trace. */
const SLACK_MS = 3 * 60_000;
/** How long Bombadil has to stop on SIGINT, writing its trace, before it is killed. */
const KILL_GRACE_MS = 10_000;

/** The Bombadil binary the npm package ships for each platform it supports. */
const BOMBADIL_BINARIES: Record<string, string> = {
  'linux-x64': 'bombadil-linux-x64',
  'linux-arm64': 'bombadil-linux-arm64',
  'darwin-arm64': 'bombadil-darwin-arm64',
};

const run = new RunContext();
// Read only when this lane is asked for: a value the other lanes have no use
// for must not fail them.
const timeLimit =
  laneFrom(process.env, readDotEnvFile()) === 'explore' ? exploreTimeLimitFrom() : null;
let lane: LaneResolution;
let watch: ServerLogWatch;
let fixtures: Fixtures | null = null;
let names: NameScope;
let observer: ScenarioObserver | null = null;
let outputDir: string;
let trace: TraceSummary | null = null;
let serverErrors: ServerLogError[] | null = null;
let explorer: ChildProcess | null = null;

beforeAll(async () => {
  lane = await resolveLane('explore');
  if (!lane.target) return;
  const { env, switchClient, mattermost } = lane.target;
  if (env.environment !== 'ephemeral') {
    // The explorer deletes what it finds; on any other stack that is someone's data.
    const reason = `the explore lane runs only on an ephemeral stack, not '${env.environment}'`;
    if (env.strict) throw new Error(`The explore lane cannot run (SWITCH_E2E_STRICT=1): ${reason}`);
    lane = { target: null, skip: reason };
    return;
  }
  if (env.gatewayUiUrl === null) {
    throw new Error('The explore lane needs SWITCH_GATEWAY_UI_URL: where the gateway UI is served.');
  }
  if (env.outputDir === null) {
    throw new Error(
      'The explore lane needs SWITCH_E2E_OUTPUT_DIR: where Bombadil writes the trace a failure is read from.'
    );
  }
  console.log(`explore lane run ${run.runId}: ${describeEnv(env)}`);
  console.log(`  ${describeServerLogCheck(env.serverLog)}`);
  watch = new ServerLogWatch(env.serverLog);
  outputDir = path.join(env.outputDir, 'explore');
  names = run.scope();
  fixtures = new Fixtures(env, names, switchClient, mattermost);
  await seed(fixtures, switchClient, names);
}, 120_000);

afterAll(async () => {
  if (explorer !== null) await stop(explorer);
  observer?.stop();
  if (fixtures === null) return;
  const leftovers = await fixtures.teardown();
  for (const left of leftovers) console.log(`[explore] teardown: ${left}`);
});

describe('explore lane', () => {
  const timeout = timeLimit === null ? undefined : durationMs(timeLimit) + SLACK_MS;
  it(`explores the gateway UI`, { timeout }, async (context) => {
    if (!lane.target || timeLimit === null) return context.skip(lane.skip ?? 'not asked for');
    const { env, switchClient } = lane.target;
    observer = watch.begin(switchClient, names.tag, 'explore');
    const exit = await explore(env, names.tag, timeLimit, context.signal);
    serverErrors = observer.errors(null, (message) => console.log(`[explore] ${message}`));
    observer.stop();
    observer = null;

    const traceFile = path.join(outputDir, 'trace.jsonl');
    if (!existsSync(traceFile)) {
      throw new Error(`Bombadil exited ${exit} and wrote no trace; see ${logFile()}.`);
    }
    trace = readTrace(traceFile);
    console.log(
      `[explore] ${trace.states} states, ${trace.violations.size} properties violated; ` +
        `inspect with: pnpm exec bombadil browser inspect ${outputDir}`
    );
    if (exit === EXIT_STALLED) {
      throw new Error(`The browser stalled: Bombadil stopped getting new states; see ${logFile()}.`);
    }
    if (exit !== EXIT_CLEAN && exit !== EXIT_VIOLATIONS) {
      throw new Error(`Bombadil exited ${exit}; see ${logFile()}.`);
    }
    const unknown = [...trace.violations.keys()].filter(
      (name) => !(PROPERTIES as readonly string[]).includes(name)
    );
    expect(unknown, 'violated properties missing from PROPERTIES').toEqual([]);
    expect(exit === EXIT_VIOLATIONS, 'Bombadil exit code agrees with the trace').toBe(
      trace.violations.size > 0
    );
  });

  for (const property of PROPERTIES) {
    it(property, (context) => {
      if (!lane.target) return context.skip(lane.skip);
      if (trace === null) throw new Error('The exploration did not finish, so nothing was checked.');
      const violation = trace.violations.get(property);
      if (violation === undefined) return;
      throw new Error(
        `${property} was violated ${(violation.firstAtMicros / 1e6).toFixed(1)} s in, on ${violation.url}, ` +
          `and in ${violation.states} of ${trace.states} states: ${violation.detail}\n` +
          `  screenshot: ${violation.screenshot}`
      );
    });
  }

  it('the server logged no errors while it explored', (context) => {
    if (!lane.target) return context.skip(lane.skip);
    if (trace === null) throw new Error('The exploration did not finish, so nothing was checked.');
    expectNoServerErrors(serverErrors, names.tag, 'while the explorer ran');
  });

  it('the server logged no errors outside the exploration', async (context) => {
    if (!lane.target) return context.skip(lane.skip);
    expectNoServerErrors(await watch.sweep(), null, 'outside the exploration');
  });
});

/**
 * Something on the pages: an agent, in two rooms (an internal room needs one).
 * The explorer may delete them before teardown does, so one already gone is
 * not a leftover.
 */
async function seed(fixtures: Fixtures, client: SwitchClient, names: NameScope): Promise<void> {
  const agentName = names.name('agent');
  await client.registerKnownAgent({
    agentType: 'opencode',
    name: agentName,
    description: `Switch end-to-end harness agent (run ${names.runId}). Safe to delete.`,
    options: { auto_session: false },
  });
  fixtures.defer(`agent ${agentName}`, () => unlessGone(client.deleteAgentByName(agentName)));
  for (const role of ['room', 'other-room']) {
    const name = names.name(role);
    const room = await client.createRoom({
      name,
      description: `Switch end-to-end harness (run ${names.runId}). Safe to delete.`,
      bridgeId: null,
      agentNames: [agentName],
      userNames: [],
    });
    fixtures.defer(`room ${name} (${room.id})`, () => unlessGone(client.deleteRoom(room.id)));
  }
}

function logFile(): string {
  return path.join(outputDir, 'bombadil.log');
}

async function unlessGone(removal: Promise<void>): Promise<void> {
  try {
    await removal;
  } catch (error) {
    if (error instanceof SwitchHttpError && error.status === 404) return;
    throw error;
  }
}

/**
 * Run Bombadil against the gateway UI, and return its exit code.
 *
 * Its output goes to a log file rather than this process's: it prints a line
 * per action, thousands in a run. Every request the page makes carries the
 * scope's tag, so an error the server logs serving one is attributed here.
 *
 * When the case times out or the run is cancelled (`signal`), Bombadil and the
 * Chromium it started are stopped (see `stop`), rather than going on deleting
 * things on the stack while teardown runs.
 */
async function explore(
  env: HarnessEnv,
  tag: string,
  timeLimit: string,
  signal: AbortSignal
): Promise<number> {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const specDir = mkdtempSync(path.join(tmpdir(), 'switch-explore-spec-'));
  try {
    copyFileSync(path.join(SPEC_DIR, 'gateway.ts'), path.join(specDir, 'gateway.ts'));
    writeFileSync(
      path.join(specDir, 'credentials.json'),
      JSON.stringify({
        email: env.switch.gatewayAdminEmail,
        password: env.switch.gatewayAdminPassword,
      }),
      { mode: 0o600 }
    );
    const args = [
      'browser',
      'test',
      '--headless',
      '--no-sandbox',
      '--time-limit',
      timeLimit,
      '--output-path',
      outputDir,
      '--width',
      '1440',
      '--height',
      '900',
      '--header',
      `X-Request-Id=${tag}-ui`,
      `${env.gatewayUiUrl}/login`,
      path.join(specDir, 'gateway.ts'),
    ];
    console.log(`[explore] exploring for ${timeLimit}; Bombadil's log: ${logFile()}`);
    const log = createWriteStream(logFile());
    const child = spawn(bombadilBinary(), args, {
      // Bombadil finds no browser of its own; Playwright's is installed for this lane.
      env: { ...process.env, CHROME: chromium.executablePath() },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    explorer = child;
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const onAbort = () => void stop(child);
    signal.addEventListener('abort', onAbort, { once: true });
    const removeGuard = guardAgainstExit(child, specDir);
    try {
      return await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (exitCode, killedBy) =>
          exitCode === null
            ? reject(new Error(`Bombadil was stopped by ${killedBy}.`))
            : resolve(exitCode)
        );
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
      removeGuard();
      explorer = null;
      await new Promise((resolve) => log.end(resolve));
    }
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
}

const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Kill Bombadil's process group and remove the spec copy (which holds the
 * admin's password) if this worker goes away first: cancelling a run with
 * Ctrl-C ends it without aborting the case's signal, and the group, detached
 * so it can be stopped as one, would otherwise outlive it. Everything here is
 * synchronous, as an `exit` handler must be. Returns the undo.
 */
function guardAgainstExit(child: ChildProcess, specDir: string): () => void {
  const kill = () => {
    killExplorer(child);
    rmSync(specDir, { recursive: true, force: true });
  };
  const onSignal = (received: NodeJS.Signals) => {
    kill();
    process.kill(process.pid, received);
  };
  process.once('exit', kill);
  process.once('disconnect', kill);
  for (const name of EXIT_SIGNALS) process.once(name, onSignal);
  return () => {
    process.off('exit', kill);
    process.off('disconnect', kill);
    for (const name of EXIT_SIGNALS) process.off(name, onSignal);
  };
}

/**
 * Stop Bombadil the way Ctrl-C does (SIGINT, its only handled signal): it
 * finishes, writes its trace and closes Chromium. Killed if it has not exited
 * in time.
 */
async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('close', resolve));
  process.kill(child.pid, 'SIGINT');
  const timer = new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS, 'timeout'));
  if ((await Promise.race([exited, timer])) === 'timeout') {
    console.log(`[explore] Bombadil did not stop within ${KILL_GRACE_MS / 1000} s; killing it.`);
    killExplorer(child);
    await exited;
  }
}

/**
 * SIGKILL Bombadil's process group and each Chromium's. Bombadil starts
 * Chromium in a group of its own and closes it only on a clean exit, so a
 * killed Bombadil would leave it running: its groups are found first, from
 * Bombadil's children. Synchronous, for the exit guard.
 */
function killExplorer(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  for (const leader of [...childPids(child.pid), child.pid]) {
    try {
      process.kill(-leader, 'SIGKILL');
    } catch (error) {
      // A child that leads no group of its own went with Bombadil's.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

function childPids(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map(Number);
  } catch (error) {
    // pgrep exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/** The binary the npm package ships for this platform, run without its Node launcher. */
function bombadilBinary(): string {
  const key = `${process.platform}-${process.arch}`;
  const binary = BOMBADIL_BINARIES[key];
  if (binary === undefined) throw new Error(`Bombadil ships no binary for ${key}.`);
  // The package's exports name only its types, so look for it where Node would.
  const searched = createRequire(import.meta.url).resolve.paths('@antithesishq/bombadil') ?? [];
  for (const dir of searched) {
    const candidate = path.join(dir, '@antithesishq', 'bombadil', 'binaries', binary);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No ${binary} in @antithesishq/bombadil; is it installed (pnpm install)?`);
}
