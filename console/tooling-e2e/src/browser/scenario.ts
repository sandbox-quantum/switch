import type { SwitchClient } from '../clients/switch-client.ts';
import type { HarnessEnv } from '../core/env.ts';
import type { NameScope } from '../core/run.ts';
import type { ScenarioHeader } from '../core/scenario.ts';
import type { Fixtures } from '../fixtures/fixtures.ts';
import type { GatewayUi } from './gateway-ui.ts';

/**
 * A browser-lane scenario: the gateway UI driven in a fresh headless browser
 * context, signed out at the start. What it needs in the server it creates
 * over HTTP through `fixtures`, which tears it down afterwards.
 */
export interface BrowserScenario {
  header: ScenarioHeader;
  run(context: BrowserScenarioContext): Promise<void>;
}

export interface BrowserScenarioContext {
  env: HarnessEnv;
  names: NameScope;
  switchClient: SwitchClient;
  fixtures: Fixtures;
  ui: GatewayUi;
  log: (message: string) => void;
}

/**
 * Where a browser scenario runs: anywhere but prod. Signing in and loading
 * pages writes nothing a scenario asks for, but a page is free to write on
 * load, and the browser goes around the clients' read-only guard.
 */
export const BROWSER_ENVIRONMENTS: ScenarioHeader['environments'] = [
  'ephemeral',
  'local',
  'dev',
  'staging',
];

export function browserHeader(id: string, covers: string[]): ScenarioHeader {
  return {
    id,
    covers,
    lane: 'browser',
    environments: BROWSER_ENVIRONMENTS,
    owner: 'platform',
    requires: ['gateway-ui'],
  };
}
