import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A gap must reach the agent without waking it.
 *
 * `bin.ts` is the process entry point: importing it opens a connection and
 * starts an MCP server on stdio, so the branch below cannot be exercised
 * in-process. These read the source instead — the same approach as
 * `bin.shebang.test.ts`, and enough to catch the regression that actually
 * threatens this: someone restoring the `emitNotification` call to the gap
 * branch, which is what made every stream hiccup cost the agent a turn.
 */
const SOURCE = readFileSync(join(import.meta.dirname, 'bin.ts'), 'utf8');

/** The body of the `case 'gap':` arm, up to its `return`. */
function gapBranch(): string {
  const start = SOURCE.indexOf("case 'gap':");
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('return;', start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('gap handling in the connector channel', () => {
  it('does not notify the agent from the gap branch', () => {
    expect(gapBranch()).not.toContain('emitNotification');
  });

  it('records the gap for later rather than dropping it', () => {
    expect(gapBranch()).toContain('pendingGapReason =');
  });

  it('still logs the gap', () => {
    expect(gapBranch()).toContain('process.stderr.write');
  });

  it('drains the deferred gap onto an outgoing notification', () => {
    const emit = SOURCE.slice(SOURCE.indexOf('async function emitNotification'));
    // Read and cleared in the one place every notification passes through, so
    // the warning rides out on a turn the agent was already being given.
    expect(emit).toContain('pendingGapReason !== null');
    expect(emit).toContain('pendingGapReason = null');
  });

  it('clears a deferred gap when the agent reads context', () => {
    const hook = SOURCE.slice(SOURCE.indexOf("url.pathname === '/read-context'"));
    expect(hook.slice(0, hook.indexOf('}'))).toContain('pendingGapReason = null');
  });
});
