import { beforeAll, describe, expect, it } from 'vitest';
import { describeEnv } from '../core/env.ts';
import { RunContext } from '../core/run.ts';
import { admit, assertValidHeaders } from '../core/scenario.ts';
import {
  describeServerLogCheck,
  expectNoServerErrors,
  ServerLogWatch,
} from '../core/server-log.ts';
import { resolveLane, type LaneResolution } from '../core/suite.ts';
import { Fixtures } from '../fixtures/fixtures.ts';
import { readSurface } from '../gate/gate.ts';
import { otherTenantAndProber, probeCrossTenant, type CrossTenantProbe } from './cross-tenant.ts';
import { FAST_SCENARIOS } from './index.ts';
import { probeSessionRoutes } from './session-required.ts';

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
let watch: ServerLogWatch;

beforeAll(async () => {
  lane = await resolveLane('fast');
  if (lane.target) {
    console.log(`fast lane run ${run.runId}: ${describeEnv(lane.target.env)}`);
    console.log(`  ${describeServerLogCheck(lane.target.env.serverLog)}`);
    watch = new ServerLogWatch(lane.target.env.serverLog);
  }
}, 60_000);

describe('fast lane', () => {
  for (const scenario of FAST_SCENARIOS) {
    it(scenario.header.id, async (context) => {
      if (!lane.target) return context.skip(lane.skip);
      const { env, switchClient, chat } = lane.target;

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
      const fixtures = new Fixtures(env, names, switchClient, chat);
      const log = (message: string): void => console.log(`[${scenario.header.id}] ${message}`);
      const observer = watch.begin(switchClient, names.tag, scenario.header.id);
      let failure: unknown = null;
      let leftovers: string[];
      try {
        try {
          await scenario.run({ env, names, switchClient, chat, fixtures, log });
        } catch (error) {
          failure = error;
        }
        leftovers = await fixtures.teardown();
      } finally {
        observer.stop();
      }
      for (const line of leftovers) log(`teardown: ${line}`);
      const serverErrors = observer.errors(failure, log);
      // The scenario's own failure is the root cause and is reported as is; a
      // leak, then a server error, is the verdict only when nothing else went
      // wrong.
      if (failure !== null) throw failure;
      if (!env.keepArtifacts) expect(leftovers, 'teardown left artefacts behind').toEqual([]);
      expectNoServerErrors(serverErrors, observer.tag, 'while this ran');
    });
  }
});

describe('fast lane, derived checks', () => {
  // Sends writes (without a credential), so it stays off prod like every
  // scenario that writes.
  it('every gateway route that takes a session refuses a request without one', async (context) => {
    if (!lane.target) return context.skip(lane.skip);
    if (lane.target.env.environment === 'prod') return context.skip('sends writes; not on prod');
    const { switchClient } = lane.target;
    const observer = watch.begin(switchClient, run.scope().tag, 'session-required');
    let probe: Awaited<ReturnType<typeof probeSessionRoutes>>;
    try {
      probe = await probeSessionRoutes(switchClient, readSurface());
    } finally {
      observer.stop();
    }
    const serverErrors = observer.errors(null, console.log);
    console.log(
      `[session-required] probed ${probe.probed} session routes; ` +
        `${probe.notMounted} more are not mounted here (feature flags off)`
    );
    expect(probe.probed, 'no session route was probed').toBeGreaterThan(0);
    expect(probe.wrong, `answered without a session:\n  ${probe.wrong.join('\n  ')}\n`).toEqual([]);
    expectNoServerErrors(serverErrors, observer.tag, 'while this ran');
  }, 120_000);

  // Makes a workspace and two users, none of which can be deleted, so only on
  // a stack that is thrown away after the run: not on `local`, which is a
  // developer's own and lives on.
  it("a workspace member is refused another workspace's rooms and agents", async (context) => {
    if (!lane.target) return context.skip(lane.skip);
    const { env, switchClient, chat } = lane.target;
    if (env.environment !== 'ephemeral') {
      return context.skip(
        `leaves a workspace and users behind, which cannot be deleted; only on ephemeral, not ${env.environment}`
      );
    }
    const names = run.scope();
    const fixtures = new Fixtures(env, names, switchClient, chat);
    const log = (message: string): void => console.log(`[cross-tenant] ${message}`);
    const observer = watch.begin(switchClient, names.tag, 'cross-tenant');
    let failure: unknown = null;
    let probe: CrossTenantProbe | null = null;
    let leftovers: string[];
    try {
      try {
        const { other, prober } = await otherTenantAndProber(switchClient, names, fixtures);
        probe = await probeCrossTenant(
          prober,
          readSurface(),
          await switchClient.enabledFeatureFlags(),
          other
        );
      } catch (error) {
        failure = error;
      }
      leftovers = await fixtures.teardown();
    } finally {
      observer.stop();
    }
    for (const line of leftovers) log(`teardown: ${line}`);
    const serverErrors = observer.errors(failure, log);
    for (const error of serverErrors ?? []) {
      const route = error.requestId === null ? undefined : probe?.routeOf.get(error.requestId);
      if (route !== undefined) log(`the error at ${error.timestamp} was logged serving ${route}`);
    }
    if (failure !== null) throw failure;
    if (probe === null) throw new Error('the probe neither ran nor failed');
    log(
      `${probe.refused} routes refused; ${probe.inconclusive.length} answered neither way; ` +
        `${probe.unprobed} take a parameter the other workspace has nothing for`
    );
    for (const line of probe.inconclusive) log(`inconclusive: ${line}`);
    expect(probe.refused, 'no route refused the other workspace').toBeGreaterThan(0);
    expect(
      probe.wrong,
      `served another workspace's resource:\n  ${probe.wrong.join('\n  ')}\n`
    ).toEqual([]);
    if (!env.keepArtifacts) expect(leftovers, 'teardown left artefacts behind').toEqual([]);
    expectNoServerErrors(serverErrors, observer.tag, 'while this ran');
  }, 180_000);

  // Last, so they see whatever the run left the server in.
  it('the server is still ready after the run', async (context) => {
    if (!lane.target) return context.skip(lane.skip);
    await lane.target.switchClient.ready();
  });

  it('the server logged no errors outside the scenarios', async (context) => {
    if (!lane.target) return context.skip(lane.skip);
    expectNoServerErrors(await watch.sweep(), null, 'outside any scenario');
  });
});
