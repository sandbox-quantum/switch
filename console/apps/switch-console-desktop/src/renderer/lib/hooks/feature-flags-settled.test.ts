import { describe, expect, it, vi } from 'vitest';
import { FLAGS_NOT_READ_YET } from '@shared/core/feature-flags/feature-flags';
import { flagsSettled } from './useFeatureFlags';

vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));

describe('flagsSettled', () => {
  it('is unknown until the flags are read or a read fails', () => {
    expect(flagsSettled({ fetchedAt: null, error: FLAGS_NOT_READ_YET })).toBe(false);
    expect(flagsSettled({ fetchedAt: 1, error: null })).toBe(true);
    expect(flagsSettled({ fetchedAt: null, error: 'unreachable' })).toBe(true);
  });
});
