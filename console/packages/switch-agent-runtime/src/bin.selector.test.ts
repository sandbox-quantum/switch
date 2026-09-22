import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every operations call says which session made it, where a supervisor said so.
 *
 * `session-selector.test.ts` covers what the selector resolves to; this covers
 * the part that cannot be unit tested, which is that the one function turning a
 * tool call into an HTTP request actually sends it. Miss that and the selector
 * is correct and never reaches the server, and a shared connection resolves
 * every session's room to whichever one bound last.
 *
 * `bin.ts` is the process entry point — importing it opens a connection and
 * starts an MCP server on stdio — so this reads the source, the same approach
 * as `bin.lease.test.ts`, `bin.fence.test.ts` and `bin.gap.test.ts`.
 */
const SOURCE = readFileSync(join(import.meta.dirname, 'bin.ts'), 'utf8');

/** The body of a top-level `function <name>`, up to the next one. */
function body(name: string): string {
  const start = SOURCE.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\nfunction ', start + 1);
  return SOURCE.slice(start, end > start ? end : undefined);
}

describe('naming the calling session', () => {
  it('sends the selector alongside the connection id on every operation', () => {
    const fn = body('callOperation');
    expect(fn).toContain('/ops/');
    expect(fn).toContain("'X-Switch-Connection-Id': CONNECTION_ID");
    expect(fn).toContain('...sessionSelector(SESSION_FILE)');
  });

  it('reads the file per call rather than capturing what it said at startup', () => {
    // The epoch is re-minted whenever the session recovers, so the constant is
    // the path and never the values behind it.
    expect(SOURCE).toContain('const SESSION_FILE = process.env.SWITCH_SESSION_FILE');
    expect(SOURCE).not.toContain('const SESSION_SELECTOR =');
  });
});
