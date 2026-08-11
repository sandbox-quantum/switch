import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearHumanInput, isHumanInputRecent, recordHumanInput } from './human-activity';

afterEach(() => {
  vi.useRealTimers();
});

describe('human-activity', () => {
  it('reports recent input within the idle window and not after it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    recordHumanInput('s1');
    expect(isHumanInputRecent('s1')).toBe(true);

    vi.setSystemTime(1400);
    expect(isHumanInputRecent('s1')).toBe(true);

    vi.setSystemTime(1600);
    expect(isHumanInputRecent('s1')).toBe(false);
  });

  it('is false for a session with no recorded input', () => {
    expect(isHumanInputRecent('never-typed')).toBe(false);
  });

  it('clears a session', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    recordHumanInput('s2');
    clearHumanInput('s2');
    expect(isHumanInputRecent('s2')).toBe(false);
  });
});
