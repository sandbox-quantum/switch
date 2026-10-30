import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { UsageTotal } from '../clients/switch-client.ts';
import { checkFacts, undelivered } from './facts.ts';
import { parseAnswer } from './model.ts';
import {
  DRIVER_SYSTEM,
  driverPrompt,
  DRIVER_VERSION,
  JUDGE_SYSTEM,
  judgePrompt,
  JUDGE_VERSION,
  parseVerdicts,
  type Turn,
} from './roles.ts';
import { AGENTIC_SCENARIO_DIR, loadAgenticScenarios, parseScenario } from './scenario-file.ts';
import { BudgetExceededError, Ledger, priceOf, usageCostUsd } from './spend.ts';

const SCENARIO = `
id: some-scenario
owner: platform
covers: [post_message]
persona: Someone.
goal: Something.
opening: Hello?
max_turns: 2
facts:
  - id: says-hello
    turn: any
    matches: hello
rubric:
  - id: replies
    criterion: The agent replies.
`;

describe('agentic scenario files', () => {
  it('reads every scenario in the suite', () => {
    const scenarios = loadAgenticScenarios(AGENTIC_SCENARIO_DIR);
    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios.every((scenario) => scenario.header.lane === 'agentic')).toBe(true);
  });

  it('reads a valid file, with setup messages optional', () => {
    const scenario = parseScenario('some-scenario.yaml', SCENARIO);
    expect(scenario.setupMessages).toEqual([]);
    expect(scenario.rubric).toEqual([{ id: 'replies', criterion: 'The agent replies.' }]);
    expect(scenario.header.requires).toEqual(['agentic-models']);
    expect(scenario.room).toBeNull();
    expect(scenario.facts).toEqual([
      { id: 'says-hello', turn: 'any', pattern: /hello/i, expect: 'matches' },
    ]);
  });

  it('takes a room with what a scenario may set, and refuses what the harness sets', () => {
    const withRoom = `${SCENARIO}room:\n  instructions: Sign every message.\n`;
    expect(parseScenario('some-scenario.yaml', withRoom).room).toEqual({
      instructions: 'Sign every message.',
    });
    expect(() =>
      parseScenario('some-scenario.yaml', `${SCENARIO}room:\n  name: mine\n  agents: [x]\n`)
    ).toThrow(/'room' may not set 'name'[\s\S]*'room' may not set 'agents'/);
  });

  it('keeps room text as written and refuses what POST /rooms cannot take', () => {
    const templated = `${SCENARIO}room:\n  instructions: Report to {$creator} and {team}.\n`;
    expect(parseScenario('some-scenario.yaml', templated).room).toEqual({
      instructions: 'Report to {$creator} and {team}.',
    });
    expect(() => parseScenario('some-scenario.yaml', `${SCENARIO}room:\n  docs: []\n`)).toThrow(
      /'room' may not set 'docs'/
    );
  });

  it('refuses a scenario with no facts, and facts that cannot be checked', () => {
    const noFacts = SCENARIO.replace(/facts:[\s\S]*?rubric:/, 'rubric:');
    expect(() => parseScenario('some-scenario.yaml', noFacts)).toThrow(/at least one fact/);
    const badFacts = SCENARIO.replace(
      /facts:[\s\S]*?rubric:/,
      `facts:
  - id: both
    turn: any
    matches: a
    not_matches: b
  - id: broken
    turn: any
    matches: '('
  - id: when
    turn: sometimes
    matches: a
rubric:`
    );
    let message = '';
    try {
      parseScenario('some-scenario.yaml', badFacts);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("fact 'both' needs exactly one of");
    expect(message).toContain("fact 'broken': '(' is not a regular expression");
    expect(message).toContain("fact 'when': 'turn' must be one of");
  });

  it('names every problem in a bad file at once', () => {
    const bad = `
id: Not Kebab
owner: ''
covers: post_message
persona: Someone.
goal: Something.
opening: Hello?
max_turns: 9
surprise: true
rubric:
  - id: same
    criterion: One.
  - id: same
    criterion: Two.
`;
    let message = '';
    try {
      parseScenario('other.yaml', bad);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const problem of [
      "unknown field 'surprise'",
      "'owner' must be non-empty",
      "'covers' must be a list",
      'not kebab-case',
      'does not match the file name',
      "'max_turns'",
      'used twice',
    ]) {
      expect(message).toContain(problem);
    }
  });
});

describe('facts', () => {
  const turns: Turn[] = [
    { from: 'channel', text: 'Earlier chatter.' },
    { from: 'human', text: 'Which day?' },
    { from: 'agent', text: 'Which release do you mean?' },
    { from: 'human', text: 'The payments one.' },
    { from: 'agent', text: 'Tuesday. -- payments-release' },
  ];
  const fact = (
    turn: 'first' | 'last' | 'any' | 'every',
    source: string,
    expect: 'matches' | 'not_matches' = 'matches'
  ) => ({
    id: `${turn}-${expect}`,
    turn,
    pattern: new RegExp(source, 'i'),
    expect,
  });

  it("checks the agent's replies, and only those, as the fact says", () => {
    const results = checkFacts(
      [
        fact('first', '\\?'),
        fact('last', 'tuesday'),
        fact('any', 'payments-release'),
        fact('every', 'payments-release'),
        fact('every', 'friday', 'not_matches'),
        fact('any', 'earlier chatter'),
      ],
      turns
    );
    expect(results.map((result) => result.holds)).toEqual([true, true, true, false, true, false]);
    expect(results[3]!.detail).toContain('reply 1 of 2');
  });

  it('fails every fact when the agent never replied', () => {
    const [result] = checkFacts([fact('every', 'x', 'not_matches')], turns.slice(0, 2));
    expect(result).toMatchObject({ holds: false, detail: 'the agent never replied' });
  });

  it("finds the driver's messages that never reached the room", () => {
    const history = [
      'Earlier chatter.',
      '@e2e-abc123b-claude Which day?',
      'Which release do you mean?',
    ];
    expect(undelivered(turns, history)).toEqual(['The payments one.']);
  });

  it('does not count a short message as delivered because a longer or earlier body contains it', () => {
    const short: Turn[] = [
      { from: 'human', text: 'Yes.' },
      { from: 'agent', text: 'Done.' },
      { from: 'human', text: 'Yes.' },
    ];
    expect(undelivered(short, ['@e2e-abc123b-claude Yes.'])).toEqual(['Yes.']);
    expect(undelivered(short, ['Yes. Ship it.', '@e2e-abc123b-claude Yes.'])).toEqual(['Yes.']);
  });

  it("matches across a platform's spacing and quote style", () => {
    const quoted: Turn[] = [{ from: 'human', text: 'It\u2019s  the   "payments" one.' }];
    expect(
      undelivered(quoted, ["@e2e-abc123b-claude It's the \u201Cpayments\u201D one.\n"])
    ).toEqual([]);
  });
});

describe('prompt versions', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
  const scenario = parseScenario('some-scenario.yaml', SCENARIO);
  const turns: Turn[] = [
    { from: 'human', text: 'Hello?' },
    { from: 'agent', text: 'Hello.' },
  ];

  // Changing a prompt changes its hash. Bump its version in roles.ts, then put
  // the new hash here, so every report says which prompt produced it.
  it('pins the driver prompt to its version', () => {
    expect({
      version: DRIVER_VERSION,
      sha: sha(DRIVER_SYSTEM + driverPrompt(scenario, turns)),
    }).toEqual({
      version: 1,
      sha: '9051058c1f87af25',
    });
  });

  it('pins the judge prompt to its version', () => {
    expect({
      version: JUDGE_VERSION,
      sha: sha(JUDGE_SYSTEM + judgePrompt(scenario, turns)),
    }).toEqual({
      version: 1,
      sha: 'f6555f985305dfcd',
    });
  });
});

describe('judge verdicts', () => {
  const ids = ['replies', 'stays-short'];

  it('takes one verdict per criterion, in rubric order, from JSON wrapped in prose', () => {
    const raw = `Here you go: {"verdicts": [
      {"id": "stays-short", "pass": false, "reason": "Long."},
      {"id": "replies", "pass": true, "reason": "It did."}]}`;
    expect(parseVerdicts(raw, ids)).toEqual({
      ok: true,
      verdicts: [
        { id: 'replies', pass: true, reason: 'It did.' },
        { id: 'stays-short', pass: false, reason: 'Long.' },
      ],
    });
  });

  it('refuses verdicts that do not match the rubric, or are not verdicts', () => {
    expect(parseVerdicts('no json here', ids).ok).toBe(false);
    expect(
      parseVerdicts('{"verdicts": [{"id": "replies", "pass": true, "reason": "x"}]}', ids)
    ).toMatchObject({ ok: false, error: expect.stringContaining('missing: stays-short') });
    expect(
      parseVerdicts(
        '{"verdicts": [{"id": "replies", "pass": "yes", "reason": "x"}, {"id": "stays-short", "pass": true, "reason": "x"}]}',
        ids
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('not {id, pass, reason}') });
  });
});

describe('model answers', () => {
  const answer = (model: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      result: ' ok ',
      is_error: false,
      total_cost_usd: 0.0011,
      modelUsage: { [model]: {} },
      ...extra,
    });

  it('takes the text and cost of an answer from the model asked', () => {
    expect(parseAnswer(answer('claude-sonnet-5'), 'claude-sonnet-5')).toEqual({
      text: 'ok',
      costUsd: 0.0011,
    });
  });

  it('refuses an answer from another model, a failed call, and output that is not JSON', () => {
    expect(() => parseAnswer(answer('claude-haiku-4-5'), 'claude-sonnet-5')).toThrow(
      /came from claude-haiku-4-5/
    );
    expect(() =>
      parseAnswer(
        answer('claude-sonnet-5', { is_error: true, result: 'not available' }),
        'claude-sonnet-5'
      )
    ).toThrow(/not available/);
    expect(() => parseAnswer('Error: something', 'claude-sonnet-5')).toThrow(
      /did not answer with JSON/
    );
  });
});

describe('spend', () => {
  const row = (metric: string, amount: number, model = 'claude-sonnet-5'): UsageTotal => ({
    metric,
    clientId: 'c',
    clientName: 'e2e-abc123a-claude',
    model,
    amount,
  });

  it('prices tokens per metric and model, and counts turns and messages as free', () => {
    const usd = usageCostUsd([
      row('input_tokens', 1_000_000),
      row('output_tokens', 100_000),
      row('cache_read_tokens', 1_000_000),
      row('cache_write_tokens', 400_000),
      row('turns', 3),
    ]);
    expect(usd).toBeCloseTo(2 + 1 + 0.2 + 1, 6);
    expect(priceOf('claude-sonnet-5-20260801')).toEqual(priceOf('claude-sonnet-5'));
    expect(priceOf('claude-haiku-4-5@20251001')).toEqual(priceOf('claude-haiku-4-5'));
  });

  it('refuses a model it has no price for, rather than counting it as free', () => {
    expect(() => usageCostUsd([row('input_tokens', 10, 'claude-unknown-1')])).toThrow(/No price/);
  });

  it('stops once the limit is reached', () => {
    const ledger = new Ledger(1);
    ledger.addHarness(0.25);
    ledger.setAgent(0.5);
    expect(ledger.remainingUsd).toBeCloseTo(0.25, 6);
    ledger.assertWithin('the next turn');
    ledger.setAgent(0.75);
    expect(() => ledger.assertWithin('the next turn')).toThrow(BudgetExceededError);
  });
});
