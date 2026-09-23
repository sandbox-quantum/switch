import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A role lease must be kept alive by its holder and by nobody else.
 *
 * The server frees a seat shortly after renewals stop, so whoever beats decides
 * how long the seat is held. Beat for a session you are merely standing beside
 * and you hold its role open after it has gone — which, on a connection that
 * outlives every session using it, means forever.
 *
 * Two rules follow, and they are what this file pins. Only a process that owns
 * its connection beats: a borrowed connection belongs to the supervisor, and
 * the seats taken over it belong to SDK sessions the server tracks by their own
 * leases. And a beat says which holder it is for, so the server refreshes that
 * seat rather than whichever one the agent happens to have.
 *
 * `bin.ts` is the process entry point — importing it opens a connection and
 * starts an MCP server on stdio — so these read the source, the same approach
 * as `bin.fence.test.ts` and `bin.gap.test.ts`.
 */
const SOURCE = readFileSync(join(import.meta.dirname, 'bin.ts'), 'utf8');

/** The body of a top-level `function <name>`, up to the next one. */
function body(name: string): string {
  const start = SOURCE.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\nfunction ', start + 1);
  return SOURCE.slice(start, end > start ? end : undefined);
}

describe('who renews a role lease', () => {
  it('does not beat for a connection it does not own', () => {
    const fn = body('startLeaseRenew');
    const gate = fn.indexOf('if (!OWNS_CONNECTION) return;');
    expect(gate).toBeGreaterThan(-1);
    // Ahead of the `leaseAbort` guard, so a borrowed process cannot arrive
    // here with a loop already running and skip the gate on the way out.
    expect(gate).toBeLessThan(fn.indexOf('if (leaseAbort) return;'));
  });

  it('names the holder it is beating for', () => {
    const fn = body('startLeaseRenew');
    expect(fn).toContain('/leases/renew');
    expect(fn).toContain("'X-Switch-Connection-Id': CONNECTION_ID");
  });

  it('stops beating once the server says it holds nothing', () => {
    const fn = body('startLeaseRenew');
    const held = fn.indexOf('data.held === false');
    expect(held).toBeGreaterThan(-1);
    expect(fn.slice(held)).toContain('stopLeaseRenew()');
  });

  it('gives the seat up when it gives the connection up', () => {
    // standDown means another client holds this connection now. Carrying on
    // beating would hold a role for a process that can no longer act on it.
    expect(body('standDown')).toContain('stopLeaseRenew()');
  });
});
