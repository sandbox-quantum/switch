import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every operations call from the standalone binary says which session made it,
 * where a supervisor said so.
 *
 * `hosted.test.ts` covers that a call sends whatever context it is given;
 * this covers the part that cannot be unit tested, which is that the binary
 * builds that context from its connection and the selector file on every
 * call. Miss that and the selector is correct and never reaches the server.
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
  it('stamps the connection id and the selector into every call context', () => {
    const fn = body('callerContext');
    expect(fn).toContain('connectionId: CONNECTION_ID');
    expect(fn).toContain('selector: sessionSelector(SESSION_FILE)');
  });

  it('builds the context per call rather than capturing what it said at startup', () => {
    // The epoch is re-minted whenever the session recovers, so the constant is
    // the path and never the values behind it.
    expect(SOURCE).toContain('const SESSION_FILE = process.env.SWITCH_SESSION_FILE');
    expect(SOURCE).not.toContain('const SESSION_SELECTOR =');
    expect(SOURCE).toContain('catalog.call(callerContext(), name, args)');
  });
});
