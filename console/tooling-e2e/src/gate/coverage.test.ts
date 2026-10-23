import { describe, expect, it } from 'vitest';
import { AGENTIC_SCENARIO_DIR, loadAgenticScenarios } from '../agentic/scenario-file.ts';
import { BROWSER_SCENARIOS } from '../browser/index.ts';
import type { ScenarioHeader } from '../core/scenario.ts';
import { FAST_SCENARIOS } from '../fast/index.ts';
import { SCENARIOS as PROVIDER_SCENARIOS } from '../provider/scenarios.ts';
import {
  coverageProblems,
  readExemptions,
  readSurface,
  type Exemptions,
  type ServerSurface,
} from './gate.ts';

const HEADERS = [
  ...FAST_SCENARIOS,
  ...PROVIDER_SCENARIOS,
  ...BROWSER_SCENARIOS,
  ...loadAgenticScenarios(AGENTIC_SCENARIO_DIR),
].map((scenario) => scenario.header);

describe('coverage gate', () => {
  it('accounts for every operation and gateway route the server has', () => {
    const problems = coverageProblems(readSurface(), readExemptions(), HEADERS);
    expect(problems, `\n  ${problems.join('\n  ')}\n`).toEqual([]);
  });
});

const SURFACE: ServerSurface = {
  operations: ['list_rooms', 'post_message'],
  gatewayRoutes: [
    { route: 'POST /gateway/rooms', auth: 'session', flags: [] },
    { route: 'POST /gateway/auth/login', auth: 'none', flags: [] },
  ],
};

function header(id: string, covers: string[]): ScenarioHeader {
  return {
    id,
    covers,
    lane: 'fast',
    environments: ['ephemeral'],
    owner: 'platform',
    requires: [],
  };
}

function exemptions(overrides: Partial<Exemptions>): Exemptions {
  return {
    exempt: { 'POST /gateway/auth/login': 'How a session is obtained.' },
    unauthenticated: { 'POST /gateway/auth/login': 'How a session is obtained.' },
    backlog: ['post_message'],
    ...overrides,
  };
}

describe('coverage gate rules', () => {
  const covering = [
    header('rooms', ['list_rooms', 'POST /gateway/rooms', 'GET /agents/{agent_id}/ops']),
  ];

  it('passes when everything is covered, exempt or in the backlog', () => {
    expect(coverageProblems(SURFACE, exemptions({}), covering)).toEqual([]);
  });

  it('fails on a new operation or route nothing accounts for', () => {
    const grown: ServerSurface = {
      operations: [...SURFACE.operations, 'archive_room'],
      gatewayRoutes: [
        ...SURFACE.gatewayRoutes,
        { route: 'DELETE /gateway/rooms/{room_id}', auth: 'session', flags: [] },
      ],
    };
    const problems = coverageProblems(grown, exemptions({}), covering);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain("'archive_room' is covered by no scenario");
    expect(problems.join('\n')).toContain(
      "'DELETE /gateway/rooms/{room_id}' is covered by no scenario"
    );
  });

  it('fails on a backlog entry a scenario now covers, and on stale entries', () => {
    const problems = coverageProblems(
      SURFACE,
      exemptions({ backlog: ['post_message', 'list_rooms', 'gone_operation'] }),
      covering
    );
    expect(problems.join('\n')).toContain("backlog lists 'list_rooms', which rooms now covers");
    expect(problems.join('\n')).toContain(
      "backlog lists 'gone_operation', which the server does not have"
    );
  });

  it('fails on a header covering what the server does not have, trusting only agent-bridge routes', () => {
    const problems = coverageProblems(SURFACE, exemptions({}), [
      ...covering,
      header('stale', [
        'list_room',
        'GET /gateway/nowhere',
        'POST /gatway/rooms',
        'POST gateway/rooms',
        'POST /agents/register-known',
      ]),
    ]);
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toContain("stale covers 'list_room'");
    expect(problems.join('\n')).toContain("stale covers 'GET /gateway/nowhere'");
    expect(problems.join('\n')).toContain("stale covers 'POST /gatway/rooms'");
    expect(problems.join('\n')).toContain("stale covers 'POST gateway/rooms'");
  });

  it('wants a reason for every exemption, and for every route that takes no credential', () => {
    const problems = coverageProblems(
      SURFACE,
      exemptions({ exempt: { 'POST /gateway/auth/login': ' ' }, unauthenticated: {} }),
      covering
    );
    expect(problems.join('\n')).toContain(
      "exempt lists 'POST /gateway/auth/login' without a reason"
    );
    expect(problems.join('\n')).toContain("'POST /gateway/auth/login' takes no credential");
  });

  it('fails when a route listed as unauthenticated has gained a credential', () => {
    const problems = coverageProblems(
      SURFACE,
      exemptions({
        unauthenticated: {
          'POST /gateway/auth/login': 'How a session is obtained.',
          'POST /gateway/rooms': 'Was public once.',
        },
      }),
      covering
    );
    expect(problems).toEqual([
      "unauthenticated lists 'POST /gateway/rooms', which is not a route taking no credential",
    ]);
  });
});
