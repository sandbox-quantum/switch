import { StrictMode, useEffect, useRef, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeetBuddyIntro } from './meet-buddy-intro';

/** Holds "played" in a ref and re-renders on its own, like a page that polls. */
function Host({ onPlayed }: { onPlayed: () => void }) {
  const played = useRef(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 100);
    return () => clearInterval(timer);
  }, []);
  return (
    <MeetBuddyIntro
      firstName="Max"
      here="the dashboard"
      play={!played.current}
      onPlayed={() => {
        played.current = true;
        onPlayed();
      }}
      after={<p data-testid="after">pick</p>}
    />
  );
}

describe('MeetBuddyIntro', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('plays through to what comes after under StrictMode with a host that re-renders', async () => {
    vi.useFakeTimers();
    const onPlayed = vi.fn();
    render(
      <StrictMode>
        <Host onPlayed={onPlayed} />
      </StrictMode>
    );
    expect(onPlayed).not.toHaveBeenCalled();
    for (let step = 0; step < 100; step++) {
      await act(async () => vi.advanceTimersByTimeAsync(100));
    }
    expect(screen.getByTestId('after')).toBeInTheDocument();
    expect(onPlayed).toHaveBeenCalled();
  });

  it('shows everything when it stops playing part-way', async () => {
    vi.useFakeTimers();
    const intro = (play: boolean) => (
      <MeetBuddyIntro
        firstName="Max"
        here="the dashboard"
        play={play}
        onPlayed={() => {}}
        after={<p data-testid="after">pick</p>}
      />
    );
    const { rerender } = render(intro(true));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(screen.queryByTestId('after')).toBeNull();
    rerender(intro(false));
    expect(screen.getByTestId('after')).toBeInTheDocument();
  });
});
