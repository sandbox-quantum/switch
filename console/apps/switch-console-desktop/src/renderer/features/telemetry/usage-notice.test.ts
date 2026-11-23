import { describe, expect, it } from 'vitest';
import { usageNoticeOwed } from './usage-notice';

describe('usageNoticeOwed', () => {
  it('is owed to an install that has never been shown the notice', () => {
    expect(usageNoticeOwed({ askedAt: null })).toBe(true);
  });

  it('holds while the answer has not been read yet', () => {
    expect(usageNoticeOwed(undefined)).toBe(true);
  });

  it('is not owed once shown', () => {
    expect(usageNoticeOwed({ askedAt: 1_790_000_000_000 })).toBe(false);
  });
});
