import { describe, expect, it } from 'vitest';
import {
  distanceFromBottom,
  FOLLOW_BOTTOM_THRESHOLD_PX,
  isAtBottom,
} from '@renderer/features/chats/ui/follow-bottom';

describe('follow-bottom', () => {
  it('measures the distance left to scroll', () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })).toBe(600);
    expect(distanceFromBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(0);
  });

  it('never reports a negative distance when content is shorter than the viewport', () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(0);
  });

  it('keeps following within the threshold, including fractional pixels', () => {
    const threshold = FOLLOW_BOTTOM_THRESHOLD_PX;
    expect(isAtBottom({ scrollTop: 599.5, scrollHeight: 1000, clientHeight: 400 }, threshold)).toBe(
      true
    );
    expect(
      isAtBottom({ scrollTop: 600 - threshold, scrollHeight: 1000, clientHeight: 400 }, threshold)
    ).toBe(true);
  });

  it('stops following once the reader scrolls up past the threshold', () => {
    const threshold = FOLLOW_BOTTOM_THRESHOLD_PX;
    expect(
      isAtBottom(
        { scrollTop: 600 - threshold - 1, scrollHeight: 1000, clientHeight: 400 },
        threshold
      )
    ).toBe(false);
  });

  it('stops following when content grows under a reader who is not at the bottom', () => {
    expect(isAtBottom({ scrollTop: 600, scrollHeight: 1400, clientHeight: 400 }, 32)).toBe(false);
  });
});
