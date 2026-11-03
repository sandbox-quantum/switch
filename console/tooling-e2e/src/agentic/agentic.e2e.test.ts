import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sleep } from '../clients/mattermost-client.ts';
import type { UsageTotal } from '../clients/switch-client.ts';
import { describeEnv } from '../core/env.ts';
import { RunContext } from '../core/run.ts';
import { admit, assertValidHeaders } from '../core/scenario.ts';
import {
  describeErrors,
  describeServerLogCheck,
  expectNoServerErrors,
  ServerLogWatch,
} from '../core/server-log.ts';
import { resolveLane, type LaneResolution } from '../core/suite.ts';
import {
  setupHarness,
  teardownHarness,
  waitForSession,
  type Harness,
} from '../provider/harness.ts';
import { exchange, postUnaddressed } from './conversation.ts';
import { checkFacts, undelivered, type FactResult } from './facts.ts';
import { ModelClient } from './model.ts';
import {
  driverTurn,
  DRIVER_VERSION,
  judge,
  JUDGE_VERSION,
  type Judgement,
  type Turn,
} from './roles.ts';
import { provisionScenarioRoom, type ScenarioRoom } from './room.ts';
import { AGENTIC_SCENARIO_DIR, loadAgenticScenarios } from './scenario-file.ts';
import { describeUsage, Ledger, usageCostUsd } from './spend.ts';

/**
 * The agentic lane: scenario files played against a real agent session.
 * Runs when `SWITCH_E2E_LANE=agentic`, on the same setup as the provider lane
 * (one agent on a headless controller, one Mattermost channel).
 *
 * For each scenario, in its own room when it declares one, a driver model
 * plays the human, from the scenario's persona and goal, until the goal is met
 * or `max_turns` runs out. Then the deterministic checks; then, only if they
 * all passed, a judge model grades the transcript against the rubric.
 *
 * What fails a scenario is what can be decided without a model: the agent did
 * not answer, a message the driver wrote never reached the room, one of the
 * scenario's facts does not hold, the server logged an error, or the run
 * reached its spending limit. The judge's verdicts are reported, per
 * criterion, in the run's output and in `agentic/<id>.json` under
 * SWITCH_E2E_OUTPUT_DIR, with the prompt versions that produced them, but do
 * not fail the scenario: a model's grade is evidence to read, not a gate,
 * until it has a record of agreeing with people.
 */

const SCENARIOS = loadAgenticScenarios(AGENTIC_SCENARIO_DIR);
assertValidHeaders(SCENARIOS.map((scenario) => scenario.header));

const REPLY_DEADLINE_MS = Number(process.env.SWITCH_E2E_REPLY_TIMEOUT_MS ?? 5 * 60_000);
const SESSION_DEADLINE_MS = Number(process.env.SWITCH_E2E_SESSION_TIMEOUT_MS ?? 120_000);
/** The most a single driver or judge call may spend. */
const CALL_LIMIT_USD = 0.5;
/** How long to wait for Switch's usage count to stop moving after a conversation. */
const USAGE_SETTLE_MS = 30_000;

interface ScenarioReport {
  id: string;
  turns: Turn[];
  failure: string | null;
  facts: FactResult[];
  driver: { model: string; version: number };
  judge: { model: string; version: number };
  judgement: Judgement | null;
  agentUsd: number;
  harnessUsd: number;
  durationMs: number;
}

let lane: LaneResolution;
let harness: Harness | null = null;
let scopes: RunContext;
let watch: ServerLogWatch;
let ledger: Ledger;
let models: ModelClient;
let tenantId: string;
let runStart: Date;
const reports: ScenarioReport[] = [];

beforeAll(async () => {
  lane = await resolveLane('agentic');
  if (!lane.target) return;
  if (!SCENARIOS.some((scenario) => admit(scenario.header, lane.target!.env).run)) return;
  const { env } = lane.target;
  watch = new ServerLogWatch(env.serverLog);
  ledger = new Ledger(env.agentic.budgetUsd!);
  models = new ModelClient(env.agentic.providerEnvFile);
  runStart = new Date();
  tenantId = await lane.target.switchClient.tenantId();

  harness = await setupHarness(lane.target);
  scopes = new RunContext(harness.runId);
  // The first scope named the setup's agent and channel; scenarios start after it.
  scopes.scope();
  console.log(
    [
      '',
      `Agentic lane run ${harness.runId}`,
      `  ${describeEnv(env)}`,
      `  ${describeServerLogCheck(env.serverLog)}`,
      `  driver   ${env.agentic.driverModel}`,
      `  driver prompt v${DRIVER_VERSION}, judge prompt v${JUDGE_VERSION}`,
      `  judge    ${env.agentic.judgeModel} (runs once the facts hold; reported, does not fail a scenario)`,
      `  limit    $${ledger.budgetUsd.toFixed(2)}`,
      `  agent    ${harness.agent.name} in ${harness.channel.name}`,
      '',
    ].join('\n')
  );
  const status = await waitForSession(harness, SESSION_DEADLINE_MS);
  console.log(`  Switch reports the agent as '${status}' in the room — running scenarios.\n`);
}, 600_000);

afterAll(async () => {
  if (reports.length > 0) console.log(formatReport(reports, ledger));
  await teardownHarness(harness);
  if (!lane.target || harness === null) return;
  const late = await watch.sweep();
  if (late !== null && late.length > 0) {
    throw new Error(
      `the server logged errors after the last scenario (teardown):\n  ${describeErrors(late, null)}`
    );
  }
});

/** The agent's usage this run, as Switch records it. */
async function agentUsage(): Promise<UsageTotal[]> {
  const until = new Date(Date.now() + 60 * 60_000);
  const rows = await harness!.switch.usage(tenantId, runStart, until);
  return rows.filter((row) => row.clientName === harness!.agent.name);
}

/** Bring the ledger's agent spend up to date, waiting for Switch's count to stop moving. */
async function settleAgentSpend(): Promise<UsageTotal[]> {
  const deadline = Date.now() + USAGE_SETTLE_MS;
  let rows = await agentUsage();
  let usd = usageCostUsd(rows);
  for (;;) {
    await sleep(3_000);
    const next = await agentUsage();
    const nextUsd = usageCostUsd(next);
    rows = next;
    if (nextUsd === usd || Date.now() >= deadline) {
      usd = nextUsd;
      break;
    }
    usd = nextUsd;
  }
  ledger.setAgent(usd);
  return rows;
}

describe('agentic lane', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.header.id, async (context) => {
      if (!lane.target) return context.skip(lane.skip);
      const admission = admit(scenario.header, lane.target.env);
      if (!admission.run) {
        if (admission.failure) {
          throw new Error(
            `${scenario.header.id} cannot run (SWITCH_E2E_STRICT=1): ${admission.reason}`
          );
        }
        return context.skip(admission.reason);
      }
      const h = harness!;
      const { env } = lane.target;
      const driverModel = env.agentic.driverModel!;
      const judgeModel = env.agentic.judgeModel!;
      const log = (message: string): void => console.log(`[${scenario.header.id}] ${message}`);
      const started = Date.now();
      const agentBefore = usageCostUsd(await agentUsage());
      let harnessUsd = 0;
      const spendOnHarness = (usd: number): void => {
        harnessUsd += usd;
        ledger.addHarness(usd);
      };

      ledger.assertWithin(`${scenario.header.id} started`);
      const names = scopes.scope();
      const observer = watch.begin(h.switch, names.tag, scenario.header.id);
      const turns: Turn[] = [];
      let facts: FactResult[] = [];
      let failure: unknown = null;
      let own: ScenarioRoom | null = null;
      try {
        if (scenario.room !== null) {
          own = await provisionScenarioRoom(h, scenario, names, SESSION_DEADLINE_MS);
          log(`in its own room, ${own.harness.room.name}`);
        }
        const active = own?.harness ?? h;
        for (const message of scenario.setupMessages) {
          await postUnaddressed(active, message);
          turns.push({ from: 'channel', text: message });
        }
        let next: string | null = scenario.opening;
        while (next !== null) {
          turns.push({ from: 'human', text: next });
          log(`human: ${next}`);
          const reply = await exchange(active, next, REPLY_DEADLINE_MS);
          turns.push(reply);
          log(`agent: ${reply.text.replace(/\s+/g, ' ').slice(0, 300)}`);
          ledger.setAgent(usageCostUsd(await agentUsage()));
          ledger.assertWithin(`the next turn of ${scenario.header.id}`);
          if (turns.filter((turn) => turn.from === 'human').length >= scenario.maxTurns) break;
          const driven = await driverTurn(
            models,
            driverModel,
            Math.min(CALL_LIMIT_USD, ledger.remainingUsd),
            scenario,
            turns
          );
          spendOnHarness(driven.costUsd);
          next = driven.message;
        }

        const history = await h.switch.roomHistory(h.witness, active.room.id, 100);
        const lost = undelivered(
          turns,
          history
            .toSorted((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
            .map((event) => event.body)
        );
        if (lost.length > 0) {
          throw new Error(
            `${lost.length} message(s) the driver wrote never reached the Switch room: ` +
              lost.map((text) => `«${text}»`).join(' ')
          );
        }
        facts = checkFacts(scenario.facts, turns);
        for (const fact of facts)
          log(`fact ${fact.holds ? 'holds' : 'FAILS'} ${fact.id}: ${fact.detail}`);
        const failed = facts.filter((fact) => !fact.holds);
        if (failed.length > 0) {
          throw new Error(
            `${failed.length} of ${facts.length} facts do not hold: ` +
              failed.map((fact) => `${fact.id} (${fact.detail})`).join('; ')
          );
        }
      } catch (error) {
        failure = error;
      } finally {
        observer.stop();
        if (own !== null && !env.keepArtifacts) await own.remove(log);
      }

      let judgement: Judgement | null = null;
      if (failure === null) {
        try {
          ledger.assertWithin(`judging ${scenario.header.id}`);
          judgement = await judge(
            models,
            judgeModel,
            Math.min(CALL_LIMIT_USD, ledger.remainingUsd),
            scenario,
            turns
          );
          spendOnHarness(judgement.costUsd);
        } catch (error) {
          failure = error;
        }
      }
      let usage: UsageTotal[] = [];
      try {
        usage = await settleAgentSpend();
      } catch (error) {
        if (failure === null) failure = error;
      }
      const agentUsd = usage.length === 0 ? 0 : usageCostUsd(usage) - agentBefore;
      const report: ScenarioReport = {
        id: scenario.header.id,
        turns,
        failure:
          failure === null ? null : failure instanceof Error ? failure.message : String(failure),
        facts,
        driver: { model: driverModel, version: DRIVER_VERSION },
        judge: { model: judgeModel, version: JUDGE_VERSION },
        judgement,
        agentUsd,
        harnessUsd,
        durationMs: Date.now() - started,
      };
      reports.push(report);
      log(`agent tokens this run so far: ${describeUsage(usage)}`);
      log(
        `spent: agent $${agentUsd.toFixed(4)}, driver and judge $${report.harnessUsd.toFixed(4)}; run ${ledger.describe()}`
      );
      log(describeJudgement(judgement));
      writeReport(env.outputDir, report);

      const serverErrors = observer.errors(failure, log);
      if (failure !== null) throw failure;
      expectNoServerErrors(serverErrors, observer.tag, 'while this ran');
    });
  }

  it('the server is still ready after the run', async (context) => {
    if (!lane.target) return context.skip(lane.skip);
    await lane.target.switchClient.ready();
  });

  it('the server logged no errors outside the scenarios', async (context) => {
    if (!lane.target || harness === null) return context.skip(lane.skip ?? 'no scenario ran');
    expectNoServerErrors(await watch.sweep(), null, 'during setup or between scenarios');
  });

  it('the run stayed within its spending limit', async (context) => {
    if (!lane.target || harness === null) return context.skip(lane.skip ?? 'no scenario ran');
    await settleAgentSpend();
    console.log(`agentic lane spent ${ledger.describe()}`);
    expect(ledger.totalUsd, `spent ${ledger.describe()}`).toBeLessThanOrEqual(ledger.budgetUsd);
  });
});

function describeJudgement(judgement: Judgement | null): string {
  if (judgement === null)
    return 'judge: not run (the conversation or a deterministic check failed)';
  if (!judgement.ok)
    return `judge: no usable verdict (${judgement.error}); it said: ${judgement.raw.slice(0, 300)}`;
  const passed = judgement.verdicts.filter((verdict) => verdict.pass).length;
  return [
    `judge: ${passed}/${judgement.verdicts.length} criteria met (reported, not failing)`,
    ...judgement.verdicts.map(
      (verdict) => `  ${verdict.pass ? 'met    ' : 'not met'} ${verdict.id}: ${verdict.reason}`
    ),
  ].join('\n');
}

function writeReport(outputDir: string | null, report: ScenarioReport): void {
  if (outputDir === null) return;
  const dir = path.join(outputDir, 'agentic');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${report.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

function formatReport(all: readonly ScenarioReport[], spent: Ledger): string {
  const rows = all.map((report) => {
    const humans = report.turns.filter((turn) => turn.from === 'human').length;
    const verdict =
      report.judgement === null
        ? 'not judged'
        : report.judgement.ok
          ? `${report.judgement.verdicts.filter((v) => v.pass).length}/${report.judgement.verdicts.length} met`
          : 'judge error';
    return (
      `  ${report.failure === null ? 'ok  ' : 'FAIL'}  ${report.id.padEnd(28)} ` +
      `${String(humans).padStart(2)} turns  ${verdict.padEnd(11)} ` +
      `agent $${report.agentUsd.toFixed(4)}  driver+judge $${report.harnessUsd.toFixed(4)}  ` +
      `${Math.round(report.durationMs / 1000)} s`
    );
  });
  return ['', 'Agentic lane', ...rows, `  total ${spent.describe()}`, ''].join('\n');
}
