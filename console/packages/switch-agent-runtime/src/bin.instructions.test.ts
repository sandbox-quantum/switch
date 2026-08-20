import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The MCP server's `instructions` are injected into every session that
 * registers this runtime, and the model reads them as ground truth about the
 * protocol. Nothing else pins their content.
 *
 * They used to tell the agent to `read_context` on every message event and to
 * connect before every call, which made a session re-read a room it was
 * already caught up on and reconnect to a room it was already in. That is a
 * regression a future edit can reintroduce in one line, so these assert the
 * shape of the guidance rather than its exact prose: conditional reading, and
 * a connection that holds for the session.
 *
 * `bin.ts` is the process entry point — importing it opens a connection and
 * starts an MCP server on stdio — so this reads the source, the same approach
 * as `bin.gap.test.ts` and `bin.shebang.test.ts`.
 */
const SOURCE = readFileSync(join(import.meta.dirname, 'bin.ts'), 'utf8');

/** The `instructions: [...]` array passed to the Server constructor. */
function instructions(): string {
  const start = SOURCE.indexOf('instructions: [');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf("].join('\\n')", start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('MCP server instructions', () => {
  it('makes reading conditional on being behind, not automatic per event', () => {
    const text = instructions();
    const step = text.split('\n').find((line) => line.includes('1. Call read_context'));
    expect(step, 'the message-event procedure still opens with read_context').toBeDefined();
    // The condition is the whole point: an unqualified "call read_context" here
    // is the bug this file guards.
    expect(step).toMatch(/ONLY if|only if/);
    expect(step).toContain('missed_count');
  });

  it('describes the room connection as holding for the session', () => {
    const text = instructions();
    expect(text).toContain('do not reconnect before each call');
    expect(text).not.toContain('You must be connected to the room (via connect_to_room) before');
  });

  it('does not tell the agent to read on every message event', () => {
    // Phrasings that would restore the unconditional instruction.
    for (const banned of [
      'Call read_context with the since parameter set to a timestamp a few minutes before the event timestamp to get recent',
      'always call read_context',
      'Always call read_context',
    ]) {
      expect(instructions()).not.toContain(banned);
    }
  });
});
