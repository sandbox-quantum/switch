import type { Environment, HarnessEnv, Lane } from './env.ts';

/**
 * The machine-readable header every scenario carries, in either lane.
 *
 * It is what lets tooling answer questions about the suite without running it:
 * which lane a scenario belongs to (`lane`), where it may run
 * (`environments`), who to ask when it breaks (`owner`), and what it exercises
 * (`covers`), which is what the coverage gate reads.
 */
export interface ScenarioHeader {
  /** Kebab-case, unique across the suite. */
  id: string;
  /**
   * What the scenario exercises: agent-operation names from the registry
   * (`core/switch_core/bridges/agent/operations/definitions.py`, e.g.
   * `list_rooms`) and HTTP routes as `METHOD /path/{param}` with the server's
   * own parameter names (e.g. `POST /agents/{agent_id}/message`).
   */
  covers: readonly string[];
  /**
   * The lane it runs in: `fast` (plain HTTP), `provider` (a real agent
   * session) or `browser` (the gateway UI in a headless browser).
   */
  lane: Lane;
  /**
   * Where it may run. A scenario that changes server-global state (a feature
   * flag) lists only `ephemeral`. One that writes anything never lists `prod`.
   */
  environments: readonly Environment[];
  /** Who answers for it — a team or role, not a person. */
  owner: string;
  /** What has to be configured for it to mean anything. */
  requires: readonly Prerequisite[];
}

/**
 * `mattermost`: a Mattermost and a human token on it are configured.
 * `agent-dir`: the provider session's working directory is on this machine.
 * `gateway-ui`: the address of a gateway UI served against this Switch server.
 * `agentic-models`: the driver and judge models, and the spending limit.
 */
export type Prerequisite = 'mattermost' | 'agent-dir' | 'gateway-ui' | 'agentic-models';

const OPERATION = /^[a-z][a-z0-9_]*$/;
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/;
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Every problem with a header, so a bad one is fixed in one pass. Empty when it is valid. */
export function headerProblems(header: ScenarioHeader): string[] {
  const problems: string[] = [];
  if (!ID.test(header.id)) problems.push(`id '${header.id}' is not kebab-case`);
  if (header.covers.length === 0) problems.push('covers is empty');
  for (const entry of header.covers) {
    if (!OPERATION.test(entry) && !ROUTE.test(entry)) {
      problems.push(`covers entry '${entry}' is neither an operation name nor 'METHOD /path'`);
    }
  }
  if (header.environments.length === 0) problems.push('environments is empty');
  if (header.owner.trim() === '') problems.push('owner is empty');
  if (
    (header.lane === 'provider' || header.lane === 'agentic') &&
    header.environments.includes('prod')
  ) {
    problems.push(`a ${header.lane} scenario writes to the room, so it cannot list prod`);
  }
  return problems;
}

/** Throw naming every problem in every header, plus any id used twice. */
export function assertValidHeaders(headers: readonly ScenarioHeader[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const header of headers) {
    for (const problem of headerProblems(header)) problems.push(`${header.id}: ${problem}`);
    if (seen.has(header.id)) problems.push(`${header.id}: id used by another scenario`);
    seen.add(header.id);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid scenario headers:\n  ${problems.join('\n  ')}`);
  }
}

/**
 * Whether a scenario runs here, and if not, whether that is a failure.
 *
 * A scenario from the other lane, or one that does not list this environment,
 * is simply not this run's business. A missing prerequisite is different: the
 * scenario belongs here and cannot run, which skips on a developer machine and
 * fails in strict mode — CI must not report a scenario that never ran as green.
 * The exception is a prerequisite the environment declares it lacks by design
 * (`SWITCH_E2E_NO_MATTERMOST`): that skips everywhere, with the reason given.
 */
export type Admission = { run: true } | { run: false; reason: string; failure: boolean };

export function admit(header: ScenarioHeader, env: HarnessEnv): Admission {
  if (header.lane !== env.lane) {
    return { run: false, reason: `belongs to the ${header.lane} lane`, failure: false };
  }
  if (!header.environments.includes(env.environment)) {
    return {
      run: false,
      reason: `does not run against '${env.environment}' (only ${header.environments.join(', ')})`,
      failure: false,
    };
  }
  const missing = header.requires.filter((prerequisite) => !satisfied(prerequisite, env));
  if (missing.length > 0) {
    const byDesign = missing.every((prerequisite) => absentByDesign(prerequisite, env));
    return {
      run: false,
      reason:
        `needs ${missing.map(describePrerequisite).join(' and ')}` +
        (byDesign ? `, which '${env.environment}' does not deploy (SWITCH_E2E_NO_MATTERMOST)` : ''),
      failure: env.strict && !byDesign,
    };
  }
  return { run: true };
}

function absentByDesign(prerequisite: Prerequisite, env: HarnessEnv): boolean {
  return prerequisite === 'mattermost' && env.noMattermost;
}

function satisfied(prerequisite: Prerequisite, env: HarnessEnv): boolean {
  switch (prerequisite) {
    case 'mattermost':
      return env.mattermost !== null;
    case 'agent-dir':
      return env.provider.agentRepoDir !== null;
    case 'gateway-ui':
      return env.gatewayUiUrl !== null;
    case 'agentic-models':
      return (
        env.agentic.driverModel !== null &&
        env.agentic.judgeModel !== null &&
        env.agentic.budgetUsd !== null
      );
  }
}

function describePrerequisite(prerequisite: Prerequisite): string {
  switch (prerequisite) {
    case 'mattermost':
      return 'Mattermost (MATTERMOST_URL, MATTERMOST_TOKEN, MATTERMOST_TEAM)';
    case 'agent-dir':
      return 'the session working directory (SWITCH_E2E_AGENT_DIR)';
    case 'gateway-ui':
      return 'a gateway UI (SWITCH_GATEWAY_UI_URL)';
    case 'agentic-models':
      return 'the driver and judge models and a spending limit (SWITCH_E2E_DRIVER_MODEL, SWITCH_E2E_JUDGE_MODEL, SWITCH_E2E_AGENTIC_BUDGET_USD)';
  }
}
