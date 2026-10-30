import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeEnv } from '../core/env.ts';
import { RunContext } from '../core/run.ts';
import { admit, assertValidHeaders } from '../core/scenario.ts';
import { IssuedSecrets } from '../core/secrets.ts';
import {
  describeServerLogCheck,
  expectNoServerErrors,
  ServerLogWatch,
} from '../core/server-log.ts';
import { resolveLane, type LaneResolution } from '../core/suite.ts';
import { Fixtures } from '../fixtures/fixtures.ts';
import { GatewayUi } from './gateway-ui.ts';
import { BROWSER_SCENARIOS } from './index.ts';

/**
 * The browser lane: the gateway UI in headless Chromium, against the server
 * its `/gateway` requests reach. Runs when `SWITCH_E2E_LANE=browser`, with
 * `SWITCH_GATEWAY_UI_URL` naming where the UI is served.
 *
 * Each scenario gets a fresh browser context, so no session carries over. A
 * scenario fails on its own assertions, on what went wrong on its pages
 * (`GatewayUi`), on what it left behind, and on errors the server logged while
 * it ran, in that order. A failed scenario's last page is saved as a
 * screenshot under `SWITCH_E2E_OUTPUT_DIR`, when that is set.
 */

assertValidHeaders(BROWSER_SCENARIOS.map((scenario) => scenario.header));

const run = new RunContext();
let lane: LaneResolution;
let browser: Browser | null = null;
let watch: ServerLogWatch;

beforeAll(async () => {
  lane = await resolveLane('browser');
  if (!lane.target) return;
  console.log(`browser lane run ${run.runId}: ${describeEnv(lane.target.env)}`);
  console.log(`  ${describeServerLogCheck(lane.target.env.serverLog)}`);
  watch = new ServerLogWatch(lane.target.env.serverLog);
  if (lane.target.env.gatewayUiUrl !== null) browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

describe('browser lane', () => {
  for (const scenario of BROWSER_SCENARIOS) {
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
      if (browser === null || env.gatewayUiUrl === null) {
        throw new Error('The browser was not launched although the scenario was admitted.');
      }

      const names = run.scope();
      const fixtures = new Fixtures(env, names, switchClient, chat);
      const log = (message: string): void => console.log(`[${scenario.header.id}] ${message}`);
      // The page's own /gateway requests carry the scope's tag too, so an
      // error the server logs serving one is attributed to this scenario.
      const browserContext = await browser.newContext({
        extraHTTPHeaders: { 'X-Request-Id': `${names.tag}-ui` },
      });
      const page = await browserContext.newPage();
      const ui = new GatewayUi(
        browserContext,
        page,
        env.gatewayUiUrl,
        env.switch,
        new IssuedSecrets(env.secretsFile)
      );
      const observer = watch.begin(switchClient, names.tag, scenario.header.id);
      let failure: unknown = null;
      let problems: string[];
      let leftovers: string[];
      try {
        try {
          await scenario.run({ env, names, switchClient, fixtures, ui, log });
        } catch (error) {
          failure = error;
        }
        problems = [...ui.recorded()];
        if ((failure !== null || problems.length > 0) && env.outputDir !== null) {
          const dir = path.join(env.outputDir, 'screenshots');
          mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${scenario.header.id}.png`);
          await ui.screenshot(file);
          log(`screenshot of the last page: ${file}`);
        }
        await browserContext.close();
        leftovers = await fixtures.teardown();
      } finally {
        observer.stop();
      }
      for (const line of leftovers) log(`teardown: ${line}`);
      const serverErrors = observer.errors(failure, log);
      if (failure !== null) throw failure;
      expect(problems, `the pages went wrong:\n  ${problems.join('\n  ')}\n`).toEqual([]);
      if (!env.keepArtifacts) expect(leftovers, 'teardown left artefacts behind').toEqual([]);
      expectNoServerErrors(serverErrors, observer.tag, 'while this ran');
    });
  }

  it('the server logged no errors outside the scenarios', async (context) => {
    if (!lane.target) return context.skip(lane.skip);
    expectNoServerErrors(await watch.sweep(), null, 'outside any scenario');
  });
});
