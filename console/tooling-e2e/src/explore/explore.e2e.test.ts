import { spawn } from 'node:child_process';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SwitchHttpError, type SwitchClient } from '../clients/switch-client.ts';
import { describeEnv, durationMs, exploreTimeLimitFrom, type HarnessEnv } from '../core/env.ts';
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

const run = new RunContext();
const timeLimitMs = durationMs(exploreTimeLimitFrom());
let lane: LaneResolution;
let watch: ServerLogWatch;
let fixtures: Fixtures | null = null;
let names: NameScope;
let observer: ScenarioObserver | null = null;
let outputDir: string;
let trace: TraceSummary | null = null;
let serverErrors: ServerLogError[] | null = null;

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
  console.log(`explore lane run ${run.runId}: ${describeEnv(env)}`);
  console.log(`  ${describeServerLogCheck(env.serverLog)}`);
  watch = new ServerLogWatch(env.serverLog);
  outputDir =
    env.outputDir === null
      ? mkdtempSync(path.join(tmpdir(), 'switch-explore-'))
      : path.join(env.outputDir, 'explore');
  names = run.scope();
  fixtures = new Fixtures(env, names, switchClient, mattermost);
  await seed(fixtures, switchClient, names);
}, 120_000);

afterAll(async () => {
  observer?.stop();
  if (fixtures === null) return;
  const leftovers = await fixtures.teardown();
  for (const left of leftovers) console.log(`[explore] teardown: ${left}`);
});

describe('explore lane', () => {
  it(`explores the gateway UI`, { timeout: timeLimitMs + SLACK_MS }, async (context) => {
    if (!lane.target) return context.skip(lane.skip);
    const { env, switchClient } = lane.target;
    observer = watch.begin(switchClient, names.tag, 'explore');
    const exit = await explore(env, names.tag);
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
 */
async function explore(env: HarnessEnv, tag: string): Promise<number> {
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
      'exec',
      'bombadil',
      'browser',
      'test',
      '--headless',
      '--no-sandbox',
      '--time-limit',
      env.exploreTimeLimit,
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
    console.log(`[explore] exploring for ${env.exploreTimeLimit}; Bombadil's log: ${logFile()}`);
    const log = createWriteStream(logFile());
    const child = spawn('pnpm', args, {
      // Bombadil finds no browser of its own; Playwright's is installed for this lane.
      env: { ...process.env, CHROME: chromium.executablePath() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const code = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (exitCode, signal) =>
        exitCode === null ? reject(new Error(`Bombadil was killed by ${signal}.`)) : resolve(exitCode)
      );
    });
    await new Promise((resolve) => log.end(resolve));
    return code;
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
}

