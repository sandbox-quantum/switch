import { autorun } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `docker compose` narrates a pull faster than the UI can redraw — hundreds of
 * lines a second, for minutes, on a first run. One observable write per line
 * meant one render of the whole dialog per line, each rebuilding the tail and
 * measuring it to scroll, and the renderer never got to paint: the output
 * appeared in one lump once the command fell quiet.
 *
 * What matters is the number of times observers are woken, not the lines
 * themselves — so that is what these assert.
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { localSwitchServer: {} },
  events: { on: () => () => {} },
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({ agentsStore: {} }));
vi.mock('./switch-servers-store', () => ({
  switchServersStore: { init: () => Promise.resolve() },
}));

import { LocalServerStore } from './local-server-store';

let store: LocalServerStore;

beforeEach(() => {
  vi.useFakeTimers();
  store = new LocalServerStore();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Counts how often anything observing the tail is woken. */
function watchTail(target: LocalServerStore) {
  let renders = 0;
  const stop = autorun(() => {
    // Reading length is what an observer of the tail does; the void keeps the
    // read without leaving a bare expression behind.
    void target.logs.length;
    renders += 1;
  });
  return { count: () => renders, stop };
}

describe('the local server log tail', () => {
  it('wakes observers once for a burst, not once per line', () => {
    const tail = watchTail(store);
    const before = tail.count();

    for (let i = 0; i < 200; i += 1) store.queueLine(`layer ${i} downloading`);

    // Nothing yet: a burst mid-flight must not repaint 200 times.
    expect(tail.count()).toBe(before);

    vi.advanceTimersByTime(200);

    expect(tail.count()).toBe(before + 1);
    expect(store.logs).toHaveLength(200);
    tail.stop();
  });

  it('keeps the lines, and their order, across several batches', () => {
    store.queueLine('first');
    vi.advanceTimersByTime(200);
    store.queueLine('second');
    vi.advanceTimersByTime(200);

    expect(store.logs).toEqual(['first', 'second']);
  });

  it('does not strand the last lines when the output stops', () => {
    // These are the ones that say how it went, so they cannot wait on a timer
    // that nothing will trigger.
    store.queueLine('Container switch-1 Started');
    store.flushLines();

    expect(store.logs).toEqual(['Container switch-1 Started']);
  });

  it('still caps the tail when a batch overflows it', () => {
    for (let i = 0; i < 500; i += 1) store.queueLine(`line ${i}`);
    vi.advanceTimersByTime(200);

    expect(store.logs).toHaveLength(400);
    expect(store.logs.at(-1)).toBe('line 499');
  });
});
