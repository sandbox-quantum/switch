import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The standalone runtime must not read its own reconnect as a takeover.
 *
 * Every attach makes a new incarnation of the connection server-side, and a
 * beat naming an older one is refused with `taken_over` — which this process
 * answers by stopping delivery for good. So the window between opening a socket
 * and being told which incarnation it is must carry no beats, and a beat
 * already in flight when that window opens must not be believed.
 *
 * The mechanism doing both is `ReattachFence`, which is exercised directly in
 * `reattach-fence.test.ts`; these cover the wiring instead. `bin.ts` is the
 * process entry point — importing it opens a connection and starts an MCP
 * server on stdio, so its loops cannot be driven in-process the way
 * `event-stream.test.ts` drives the shared client's. These read the source, the
 * same approach as `bin.gap.test.ts`, and pin the ordering the fence relies on.
 */
const SOURCE = readFileSync(join(import.meta.dirname, 'bin.ts'), 'utf8');

/** The body of a top-level `function <name>`, up to the next one. */
function body(name: string): string {
  const start = SOURCE.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\nfunction ', start + 1);
  return SOURCE.slice(start, end > start ? end : undefined);
}

/** The `while` loop inside `<name>`, without the declarations above it. */
function loop(name: string): string {
  const fn = body(name);
  const start = fn.indexOf('while (!abort.signal.aborted)');
  expect(start).toBeGreaterThan(-1);
  return fn.slice(start);
}

describe('the standalone heartbeat across a reattach', () => {
  it('holds its tick until the server has named this incarnation', () => {
    const beating = loop('startHeartbeat');
    const gate = beating.indexOf('streamFence.reached');
    const tick = beating.indexOf('streamFence.tick(');
    expect(gate).toBeGreaterThan(-1);
    // Before the request, not after it is refused: the refusal is terminal.
    expect(gate).toBeLessThan(tick);
  });

  it('sends every beat inside the fence, so a reattach can disown it', () => {
    // A beat that left before the gate shut answers about an incarnation we
    // have left; acting on it turns our own reopen into a self-inflicted
    // `taken_over`. Reaching the request any other way escapes that.
    expect(loop('startHeartbeat')).not.toContain('connection/beat');
    expect(loop('startHeartbeat')).toContain('streamFence.tick(beat)');
  });

  it('closes the window before each open attempt, not after it lands', () => {
    // Inside the loop: the open of attempt two must shut the gate the frame of
    // attempt one opened, and shut it before the socket, not once it lands.
    const opening = loop('startStream');
    const closed = opening.indexOf('streamFence.detaching(');
    expect(closed).toBeGreaterThan(-1);
    expect(closed).toBeLessThan(opening.indexOf('/events?'));
  });

  it('claims the incarnation it believes it holds when it reattaches', () => {
    const opening = loop('startStream');
    const claim = opening.indexOf('expected_generation');
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(opening.indexOf('/events?'));
  });

  it('opens the window again only from the frame that names the incarnation', () => {
    const arm = SOURCE.slice(SOURCE.indexOf("case 'connection_state':"));
    const state = arm.slice(0, arm.indexOf('return;'));
    expect(state).toContain('streamGeneration = frame.data.generation');
    expect(state).toContain('streamFence.attached()');
  });

  it('is not attached while no stream is running', () => {
    expect(body('stopStream')).toContain('streamFence.closeAdmission()');
  });

  it('gives the connection up when its reattach is refused', () => {
    const opening = loop('startStream');
    const refused = opening.indexOf('EVICTION_TAKEN_OVER');
    expect(refused).toBeGreaterThan(-1);
    // Standing down rather than throwing, which would reopen on the backoff
    // and ask the server to take the connection off the holder again.
    expect(opening.slice(refused)).toContain('standDown()');
  });
});
