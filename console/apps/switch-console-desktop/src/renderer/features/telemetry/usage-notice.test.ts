import { describe, expect, it } from 'vitest';
import { usageNoticeOwed, workspaceShowsUsageNotice } from './usage-notice';

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

describe('workspaceShowsUsageNotice', () => {
  const upgraded = {
    onboardingEnabled: true,
    loaded: true,
    installIsEmpty: false,
    onboardingInProgress: false,
  };

  it('shows it to an install that already held servers', () => {
    expect(workspaceShowsUsageNotice(upgraded)).toBe(true);
  });

  it('leaves a new install to the first-run pages, even in Settings before them', () => {
    expect(workspaceShowsUsageNotice({ ...upgraded, installIsEmpty: true })).toBe(false);
    expect(workspaceShowsUsageNotice({ ...upgraded, onboardingInProgress: true })).toBe(false);
  });

  it('waits for the server list, and leaves builds without those pages to App', () => {
    expect(workspaceShowsUsageNotice({ ...upgraded, loaded: false })).toBe(false);
    expect(workspaceShowsUsageNotice({ ...upgraded, onboardingEnabled: false })).toBe(false);
  });
});
