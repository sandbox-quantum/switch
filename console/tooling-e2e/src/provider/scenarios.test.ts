import { describe, expect, it } from 'vitest';
import { isStartMarker } from './scenarios.ts';

describe('interruption admission', () => {
  it('requires the command marker, not an acknowledgement or refusal', () => {
    expect(isStartMarker('SWITCH_INTERRUPT_STARTED')).toBe(true);
    expect(isStartMarker('')).toBe(false);
    expect(isStartMarker('I cannot post 200 separate messages.')).toBe(false);
    expect(isStartMarker('Working on it… · 0s')).toBe(false);
    expect(isStartMarker('I will write SWITCH_INTERRUPT_STARTED')).toBe(false);
  });
});
