import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { ScenarioHeader } from '../core/scenario.ts';

/**
 * An agentic scenario, as written in `agentic/<id>.yaml`.
 *
 * It says who the human is and what they want, how the conversation opens,
 * and what a good conversation looks like. A model plays the human from it
 * (the driver), the agent under test answers in a real session, the facts are
 * checked against what the agent said, and only if they all hold does another
 * model grade the transcript against the rubric (the judge). Adding a
 * scenario is adding a file: no code.
 *
 *     id: summarise-the-channel        # kebab-case, the file's own name
 *     owner: platform                  # a team or role, never a person
 *     covers: [read_context]           # as any scenario header
 *     persona: |                       # who the driver plays
 *     goal: |                          # what they want; the driver stops once they have it
 *     room:                            # the room the conversation happens in (optional):
 *       instructions: |                #   description, instructions, roles, as POST /rooms
 *                                      #   takes them. The harness adds the name and the
 *                                      #   members, and keeps it off any messaging app.
 *                                      #   Without it, the lane's shared room is used.
 *     setup_messages: [...]            # posted, unaddressed, before the opening (optional)
 *     opening: "…"                     # the first message, sent as written, addressed to the agent
 *     max_turns: 3                     # human messages, the opening included
 *     facts:                           # what must hold, checked without a model; at least one
 *       - id: names-the-database
 *         turn: last                   # first | last | any | every agent reply
 *         matches: postgres            # or not_matches; a case-insensitive regular expression
 *     rubric:                          # what the judge checks, each on its own
 *       - id: cites-the-decision
 *         criterion: The summary names the decision the team reached.
 */
export interface AgenticScenario {
  header: ScenarioHeader;
  persona: string;
  goal: string;
  /** The scenario's own room, as `POST /rooms` takes one without name, bridge or members; null for the lane's shared room. */
  room: Record<string, unknown> | null;
  setupMessages: string[];
  opening: string;
  maxTurns: number;
  facts: Fact[];
  rubric: { id: string; criterion: string }[];
}

/** Which of the agent's replies a fact is about. */
export type FactTurn = 'first' | 'last' | 'any' | 'every';
const FACT_TURNS: readonly FactTurn[] = ['first', 'last', 'any', 'every'];

/** Something that must hold of what the agent said, checked by a regular expression. */
export interface Fact {
  id: string;
  turn: FactTurn;
  /** Case-insensitive. */
  pattern: RegExp;
  /** `matches` (the reply must match) or `not_matches` (it must not). */
  expect: 'matches' | 'not_matches';
}

/** What a scenario's `room:` may say. The rest of a room document is the harness's to fill in. */
const ROOM_KEYS = new Set(['description', 'instructions', 'roles']);

/** Where the scenario files live: `console/tooling-e2e/agentic/`. */
export const AGENTIC_SCENARIO_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agentic'
);

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEYS = new Set([
  'id',
  'owner',
  'covers',
  'persona',
  'goal',
  'room',
  'setup_messages',
  'opening',
  'max_turns',
  'facts',
  'rubric',
]);

/** Every scenario file, validated. A malformed one throws naming every problem in it. */
export function loadAgenticScenarios(dir: string): AgenticScenario[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yaml'))
    .sort()
    .map((file) => parseScenario(file, readFileSync(path.join(dir, file), 'utf8')));
}

export function parseScenario(file: string, raw: string): AgenticScenario {
  const value: unknown = parse(raw);
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${file}: not a mapping of scenario fields`);
  }
  const doc = value as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!KEYS.has(key)) problems.push(`unknown field '${key}'`);
  }
  const text = (key: string): string => {
    const field = doc[key];
    if (typeof field !== 'string' || field.trim() === '') {
      problems.push(`'${key}' must be non-empty text`);
      return '';
    }
    return field.trim();
  };
  const texts = (key: string, required: boolean): string[] => {
    const field = doc[key];
    if (field === undefined && !required) return [];
    if (!Array.isArray(field) || !field.every((item) => typeof item === 'string' && item !== '')) {
      problems.push(`'${key}' must be a list of non-empty text`);
      return [];
    }
    return field as string[];
  };

  const id = text('id');
  if (id !== '' && !ID.test(id)) problems.push(`id '${id}' is not kebab-case`);
  if (id !== '' && `${id}.yaml` !== file) problems.push(`id '${id}' does not match the file name`);
  const maxTurns = doc.max_turns;
  if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 6) {
    problems.push(`'max_turns' must be a whole number from 1 to 6`);
  }
  const rubric: { id: string; criterion: string }[] = [];
  if (!Array.isArray(doc.rubric) || doc.rubric.length === 0) {
    problems.push(`'rubric' must list at least one criterion`);
  } else {
    for (const entry of doc.rubric as unknown[]) {
      const item = entry as Record<string, unknown> | null;
      if (
        item === null ||
        typeof item.id !== 'string' ||
        !ID.test(item.id) ||
        typeof item.criterion !== 'string' ||
        item.criterion.trim() === ''
      ) {
        problems.push(`each rubric entry needs a kebab-case 'id' and a 'criterion'`);
        continue;
      }
      if (rubric.some((existing) => existing.id === item.id)) {
        problems.push(`rubric id '${item.id}' is used twice`);
      }
      rubric.push({ id: item.id, criterion: item.criterion.trim() });
    }
  }

  let room: Record<string, unknown> | null = null;
  if (doc.room !== undefined) {
    if (typeof doc.room !== 'object' || doc.room === null || Array.isArray(doc.room)) {
      problems.push(`'room' must be a mapping`);
    } else {
      room = doc.room as Record<string, unknown>;
      for (const key of Object.keys(room)) {
        if (!ROOM_KEYS.has(key)) {
          problems.push(
            `'room' may not set '${key}' (only ${[...ROOM_KEYS].join(', ')}; the harness names the room and picks its bridge and members)`
          );
        }
      }
    }
  }

  const facts: Fact[] = [];
  if (!Array.isArray(doc.facts) || doc.facts.length === 0) {
    problems.push(
      `'facts' must list at least one fact: every scenario needs a check without a model`
    );
  } else {
    for (const entry of doc.facts as unknown[]) {
      const item = entry as Record<string, unknown> | null;
      if (item === null || typeof item.id !== 'string' || !ID.test(item.id)) {
        problems.push(`each fact needs a kebab-case 'id'`);
        continue;
      }
      if (facts.some((existing) => existing.id === item.id)) {
        problems.push(`fact id '${item.id}' is used twice`);
      }
      const unknown = Object.keys(item).filter(
        (key) => !['id', 'turn', 'matches', 'not_matches'].includes(key)
      );
      if (unknown.length > 0)
        problems.push(`fact '${item.id}' has unknown fields: ${unknown.join(', ')}`);
      if (!FACT_TURNS.includes(item.turn as FactTurn)) {
        problems.push(`fact '${item.id}': 'turn' must be one of ${FACT_TURNS.join(', ')}`);
      }
      const given = (['matches', 'not_matches'] as const).filter((key) => item[key] !== undefined);
      if (given.length !== 1) {
        problems.push(`fact '${item.id}' needs exactly one of 'matches' and 'not_matches'`);
        continue;
      }
      const expect = given[0]!;
      const source = item[expect];
      if (typeof source !== 'string' || source === '') {
        problems.push(`fact '${item.id}': '${expect}' must be a non-empty regular expression`);
        continue;
      }
      let pattern: RegExp;
      try {
        pattern = new RegExp(source, 'i');
      } catch (error) {
        problems.push(
          `fact '${item.id}': '${source}' is not a regular expression: ${String(error)}`
        );
        continue;
      }
      facts.push({ id: item.id, turn: item.turn as FactTurn, pattern, expect });
    }
  }

  const scenario: AgenticScenario = {
    header: {
      id,
      covers: texts('covers', true),
      lane: 'agentic',
      environments: ['ephemeral', 'local', 'dev', 'staging'],
      owner: text('owner'),
      requires: ['agentic-models'],
    },
    persona: text('persona'),
    goal: text('goal'),
    room,
    setupMessages: texts('setup_messages', false),
    opening: text('opening'),
    maxTurns: typeof maxTurns === 'number' ? maxTurns : 0,
    facts,
    rubric,
  };
  if (problems.length > 0) throw new Error(`${file}:\n  ${problems.join('\n  ')}`);
  return scenario;
}
