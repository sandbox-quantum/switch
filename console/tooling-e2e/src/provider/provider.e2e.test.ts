import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { setupHarness, teardownHarness, waitForSession, type Harness } from './harness.ts';
import { formatResultsTable, SCENARIOS, type ScenarioResult } from './scenarios.ts';

/**
 * The provider lane. One throwaway agent, one Mattermost channel, the scenarios
 * run in order against them, then teardown and a summary table. Runs when
 * `SWITCH_E2E_LANE=provider`.
 *
 * A failure only means something when a real agent session is attending the
 * room: a Switch Console session, or Console's auto-session watcher, for the
 * agent this setup registers — see README.md, "What must be running".
 */

assertValidHeaders(SCENARIOS.map((scenario) => scenario.header));

let lane: LaneResolution;
let harness: Harness | null = null;
/** The scopes whose tags this run's scenario requests carry. */
let scopes: RunContext;
let watch: ServerLogWatch;
const results: ScenarioResult[] = [];

beforeAll(async () => {
  lane = await resolveLane('provider');
  if (!lane.target) return;
  // Before setup, so whatever setup makes the server log is read too.
  watch = new ServerLogWatch(lane.target.env.serverLog);
  // Nothing to set up when no scenario can run here — say, a target that
  // lacks the prerequisites every scenario shares.
  if (!SCENARIOS.some((scenario) => admit(scenario.header, lane.target!.env).run)) return;

  harness = await setupHarness(lane.target);
  scopes = new RunContext(harness.runId);
  // The first scope named the setup's agent and channel; scenarios start after it.
  scopes.scope();
  console.log(
    [
      '',
      `Provider lane run ${harness.runId}`,
      `  ${describeEnv(lane.target.env)}`,
      `  ${describeServerLogCheck(lane.target.env.serverLog)}`,
      `  agent    ${harness.agent.name} (${harness.agent.id})`,
      `  bot      @${harness.bot.username} (${harness.bot.id})`,
      `  channel  ${harness.channel.name} (${harness.channel.id})`,
      `  room     ${harness.room.name} (${harness.room.id})`,
      '',
      lane.target.env.provider.controllerId !== null
        ? `  The agent controller now runs '${harness.agent.name}'.`
        : `  A Switch Console session must now be running for '${harness.agent.name}'.`,
      '',
    ].join('\n')
  );

  const status = await waitForSession(
    harness,
    Number(process.env.SWITCH_E2E_SESSION_TIMEOUT_MS ?? 120_000)
  );
  console.log(`  Switch reports the agent as '${status}' in the room — running scenarios.\n`);
}, 600_000);

afterAll(async () => {
  if (results.length > 0) console.log(formatResultsTable(results));
  await teardownHarness(harness);
  // Teardown runs after the last test, so its errors fail the hook instead.
  if (!lane.target) return;
  const late = await watch.sweep();
  if (late !== null && late.length > 0) {
    throw new Error(
      `the server logged errors after the last scenario (teardown):\n  ${describeErrors(late, null)}`
    );
  }
});

describe('provider lane', () => {
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
      const log = (message: string): void => console.log(`[${scenario.header.id}] ${message}`);
      const names = scopes.scope();
      const observer = watch.begin(h.switch, names.tag, scenario.header.id);
      let result: ScenarioResult;
      try {
        result = await scenario.run(h, names);
      } finally {
        observer.stop();
      }
      results.push(result);
      const serverErrors = observer.errors(result.ok ? null : result.details, log);
      if (!result.ok) {
        console.log(
          `${result.name} transcript:\n` +
            result.transcript
              .map((post) => `    [${post.user_id === h.bot.id ? 'bot ' : 'user'}] ${post.message}`)
              .join('\n')
        );
      }
      expect(result.ok, result.details).toBe(true);
      expectNoServerErrors(serverErrors, observer.tag, 'while this ran');
    });
  }

  // Last, so they see whatever the run left the server in.
  it('the server is still ready after the run', async (context) => {
    if (!lane.target) return context.skip(lane.skip);
    await lane.target.switchClient.ready();
  });

  it('the server logged no errors outside the scenarios', async (context) => {
    if (!lane.target) return context.skip(lane.skip);
    expectNoServerErrors(await watch.sweep(), null, 'during setup or between scenarios');
  });
});
