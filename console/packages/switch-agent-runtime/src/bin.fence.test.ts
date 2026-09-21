import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The standalone runtime must not read its own reconnect as a takeover.
 *
 * Every attach makes a new incarnation of the connection server-side, and a
 * beat naming an older one is refused with `taken_over` — which this process
 * answers by stopping the stream for good. So the window between opening a
 * socket and being told which incarnation it is must carry no beats at all.
 *
 * `bin.ts` is the process entry point: importing it opens a connection and
 * starts an MCP server on stdio, so the loops cannot be driven in-process the
 * way `event-stream.test.ts` drives the shared client's. These read the source
 * instead, the same approach as `bin.gap.test.ts`, and assert the ordering
 * that makes the window safe.
 */
const SOURCE = readFileSync(join(import.meta.dirname, 'bin.ts'), 'utf8');

/** The body of a top-level `function <name>`, up to the next one. */
function body(name: string): string {
  const start = SOURCE.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\nfunction ', start + 1);
  return SOURCE.slice(start, end > start ? end : undefined);
}

describe('the standalone heartbeat across a reattach', () => {
  it('holds its tick until the server has named this incarnation', () => {
    const loop = body('startHeartbeat');
    const guard = loop.indexOf('if (!streamAttached)');
    const beat = loop.indexOf('connection/beat');
    expect(guard).toBeGreaterThan(-1);
    // Before the request, not after it is refused: the refusal is terminal.
    expect(guard).toBeLessThan(beat);
  });

  it('stops counting itself attached before each open attempt', () => {
    const loop = body('startStream');
    const cleared = loop.indexOf('streamAttached = false');
    const opened = loop.indexOf('/events?');
    expect(cleared).toBeGreaterThan(loop.indexOf('while (!abort.signal.aborted)'));
    expect(cleared).toBeLessThan(opened);
  });

  it('counts itself attached again only from the frame that names the incarnation', () => {
    const arm = SOURCE.slice(SOURCE.indexOf("case 'connection_state':"));
    const state = arm.slice(0, arm.indexOf('return;'));
    expect(state).toContain('streamGeneration = frame.data.generation');
    expect(state).toContain('streamAttached = true');
  });

  it('is not attached while no stream is running', () => {
    expect(body('stopStream')).toContain('streamAttached = false');
  });
});
