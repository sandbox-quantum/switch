import { beforeAll, describe, expect, it } from 'vitest';
import { describeEnv } from '../core/env.ts';
import { RunContext } from '../core/run.ts';
import { admit, assertValidHeaders } from '../core/scenario.ts';
import { resolveLane, type LaneResolution } from '../core/suite.ts';
import { Fixtures } from '../fixtures/fixtures.ts';
import { FAST_SCENARIOS } from './index.ts';

/**
 * The fast lane: provider-free scenarios against a Switch server, one fresh
 * set of agents and rooms per scenario. Runs when `SWITCH_E2E_LANE=fast`.
 *
 * A scenario that cannot run here is reported as **skipped**, with the reason,
 * never as passed — and under `SWITCH_E2E_STRICT=1` a missing prerequisite is a
 * failure instead.
 */

assertValidHeaders(FAST_SCENARIOS.map((scenario) => scenario.header));

const run = new RunContext();
let lane: LaneResolution;

beforeAll(async () => {
  lane = await resolveLane('fast');
  if (lane.target) console.log(`fast lane run ${run.runId}: ${describeEnv(lane.target.env)}`);
}, 60_000);

describe('fast lane', () => {
  for (const scenario of FAST_SCENARIOS) {
    it(scenario.header.id, async (context) => {
      if (!lane.target) return context.skip(lane.skip);
      const { env, switchClient, mattermost } = lane.target;

      const admission = admit(scenario.header, env);
      if (!admission.run) {
        if (admission.failure) {
          throw new Error(
            `${scenario.header.id} cannot run (SWITCH_E2E_STRICT=1): ${admission.reason}`
          );
        }
        return context.skip(admission.reason);
      }

      const names = run.scope();
      const fixtures = new Fixtures(env, names, switchClient, mattermost);
      const log = (message: string): void => console.log(`[${scenario.header.id}] ${message}`);
      let failure: unknown = null;
      try {
        await scenario.run({ env, names, switchClient, mattermost, fixtures, log });
      } catch (error) {
        failure = error;
      }
      const leftovers = await fixtures.teardown();
      for (const line of leftovers) log(`teardown: ${line}`);
      // The scenario's own failure is the root cause and is reported as is; a
      // leak is only the verdict when nothing else went wrong.
      if (failure !== null) throw failure;
      if (!env.keepArtifacts) expect(leftovers, 'teardown left artefacts behind').toEqual([]);
    });
  }
});
