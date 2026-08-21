import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What a search reports, and how often.
 *
 * The palette searches as you type, so the interesting property of this event is
 * that there is one of it per search rather than one per keystroke.
 */

const { h } = vi.hoisted(() => ({ h: { trackEvent: vi.fn(), search: vi.fn() } }));

vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent: h.trackEvent }));
vi.mock('./search-service', () => ({ searchService: { search: h.search } }));

const { searchController } = await import('./controller');

function answers(status: string, count: number) {
  h.search.mockReturnValue({ status, items: Array.from({ length: count }, (_, i) => ({ id: i })) });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  answers('ok', 3);
});

afterEach(() => vi.useRealTimers());

describe('reporting a search', () => {
  it('reports once for a burst of typing, not once per keystroke', () => {
    for (const query of ['s', 'se', 'ses', 'sess']) {
      searchController.commandPalette({ query } as never);
    }
    vi.advanceTimersByTime(2_000);

    expect(h.trackEvent).toHaveBeenCalledTimes(1);
  });

  it('reports what the last search of the burst found, not the first', () => {
    answers('ok', 9);
    searchController.commandPalette({ query: 's' } as never);
    answers('ok', 1);
    searchController.commandPalette({ query: 'sessi' } as never);
    vi.advanceTimersByTime(2_000);

    expect(h.trackEvent).toHaveBeenCalledWith('search_performed', {
      status: 'ok',
      result_count: 1,
    });
  });

  it('reports two searches separated by a pause as two', () => {
    searchController.commandPalette({ query: 'agent' } as never);
    vi.advanceTimersByTime(2_000);
    searchController.commandPalette({ query: 'room' } as never);
    vi.advanceTimersByTime(2_000);

    expect(h.trackEvent).toHaveBeenCalledTimes(2);
  });

  it('says nothing when the palette merely opens', () => {
    // An empty query asks for recents, which is not a search anyone ran.
    answers('recents', 5);
    searchController.commandPalette({ query: '' } as never);
    vi.advanceTimersByTime(2_000);

    expect(h.trackEvent).not.toHaveBeenCalled();
  });

  it('reports a search that failed, which is not the same as finding nothing', () => {
    answers('failed', 0);
    searchController.commandPalette({ query: 'agent' } as never);
    vi.advanceTimersByTime(2_000);

    expect(h.trackEvent).toHaveBeenCalledWith('search_performed', {
      status: 'failed',
      result_count: 0,
    });
  });

  it('never carries the query', () => {
    searchController.commandPalette({ query: 'secret-project-name' } as never);
    vi.advanceTimersByTime(2_000);

    expect(JSON.stringify(h.trackEvent.mock.calls)).not.toContain('secret-project-name');
  });
});
