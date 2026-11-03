import type { MattermostClient } from '../clients/mattermost-client.ts';
import type { SwitchClient } from '../clients/switch-client.ts';
import type { HarnessEnv } from '../core/env.ts';
import type { NameScope } from '../core/run.ts';
import type { ScenarioHeader } from '../core/scenario.ts';
import type { Fixtures } from '../fixtures/fixtures.ts';

/**
 * A fast-lane scenario: plain code, run against a Switch server over HTTP with
 * the harness playing every participant. No provider, no Console, no model.
 *
 * `run` asserts with `expect` and throws on failure. Everything it creates goes
 * through `fixtures`, which tears it down afterwards whether or not it passed.
 */
export interface FastScenario {
  header: ScenarioHeader;
  run(context: FastContext): Promise<void>;
}

export interface FastContext {
  env: HarnessEnv;
  /** Names and markers for this scenario, unique within the run. */
  names: NameScope;
  switchClient: SwitchClient;
  /** Present exactly when the header requires `mattermost`. */
  mattermost: MattermostClient | null;
  fixtures: Fixtures;
  log: (message: string) => void;
}

/** Where a fast scenario that writes may run: anywhere but prod. */
export const WRITABLE: ScenarioHeader['environments'] = ['ephemeral', 'local', 'dev', 'staging'];
