import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A gap, and the chatter it swallowed, must reach the agent without waking it.
 *
 * `bin.ts` is the process entry point: importing it opens a connection and
 * starts an MCP server on stdio, so the branches below cannot be exercised
 * in-process. These read the source instead — the same approach as
 * `bin.shebang.test.ts`, and enough to catch the two regressions that actually
 * threaten this: notifying from the gap branch, which made every stream hiccup
 * cost the agent a turn, and counting chatter here, which can only ever count
 * what this process was sent and answers for the wrong room.
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
    expect(gapBranch()).not.toContain('notify(');
  });

  it('still logs the gap, naming the rooms that lost events', () => {
    expect(gapBranch()).toContain('process.stderr.write');
    expect(gapBranch()).toContain('frame.data.rooms');
  });

  it('says every room when the loss is not confined to the ones named', () => {
    // A restart empties rooms this connection has not claimed yet, so the
    // named list is a subset. Printing it alone would tell the agent the
    // rooms missing from it are intact.
    expect(gapBranch()).toContain('frame.data.all_rooms === true');
    expect(gapBranch()).toContain("'every room'");
  });
});

describe('the unread count on a notification', () => {
  const emit = SOURCE.slice(SOURCE.indexOf('async function emitNotification'));

  it('comes from the event rather than a tally kept here', () => {
    // A count of its own would describe what this process was handed, which
    // is a different question from how far behind the agent is in the room.
    expect(SOURCE).not.toContain('missedSinceRead');
    expect(emit).toContain('unread');
  });

  it('is absent from meta when the server did not supply one', () => {
    expect(emit).toContain('if (unread !== undefined)');
  });

  it('says unknown rather than zero when no number can be given', () => {
    expect(emit).toContain("unread.count === null ? 'unknown'");
  });
});
