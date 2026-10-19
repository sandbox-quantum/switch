import { describe, expect, it } from 'vitest';
import {
  distanceFromBottom,
  FOLLOW_BOTTOM_THRESHOLD_PX,
  isAtBottom,
  keepsFollowing,
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

  it('keeps following when its own stick is reported after more content landed', () => {
    const late = { scrollTop: 2819, scrollHeight: 3601, clientHeight: 698 };
    expect(keepsFollowing(late, 1151, true, 32)).toBe(true);
  });

  it('stops following only when the reader moves up', () => {
    const above = { scrollTop: 500, scrollHeight: 1400, clientHeight: 400 };
    expect(keepsFollowing(above, 900, true, 32)).toBe(false);
    expect(keepsFollowing(above, 500, false, 32)).toBe(false);
  });

  it('resumes following at the end', () => {
    expect(
      keepsFollowing({ scrollTop: 1000, scrollHeight: 1400, clientHeight: 400 }, 0, false, 32)
    ).toBe(true);
  });
});
