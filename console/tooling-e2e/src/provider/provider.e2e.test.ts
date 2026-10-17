import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeEnv } from '../core/env.ts';
import { admit, assertValidHeaders } from '../core/scenario.ts';
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
const results: ScenarioResult[] = [];

beforeAll(async () => {
  lane = await resolveLane('provider');
  if (!lane.target) return;
  // Nothing to set up when no scenario can run here — say, a target that
  // lacks the prerequisites every scenario shares.
  if (!SCENARIOS.some((scenario) => admit(scenario.header, lane.target!.env).run)) return;

  harness = await setupHarness(lane.target);
  console.log(
    [
      '',
      `Provider lane run ${harness.runId}`,
      `  ${describeEnv(lane.target.env)}`,
      `  agent    ${harness.agent.name} (${harness.agent.id})`,
      `  bot      @${harness.bot.username} (${harness.bot.id})`,
      `  channel  ${harness.channel.name} (${harness.channel.id})`,
      `  room     ${harness.room.name} (${harness.room.id})`,
      '',
      `  A Switch Console session must now be running for '${harness.agent.name}'.`,
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
      const result = await scenario.run(h);
      results.push(result);
      if (!result.ok) {
        console.log(
          `${result.name} transcript:\n` +
            result.transcript
              .map((post) => `    [${post.user_id === h.bot.id ? 'bot ' : 'user'}] ${post.message}`)
              .join('\n')
        );
      }
      expect(result.ok, result.details).toBe(true);
    });
  }
});
