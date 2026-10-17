import { describe, expect, it } from 'vitest';
import { isStartMarker, requestHandle } from './scenarios.ts';

describe('interruption admission', () => {
  it('requires the command marker, not an acknowledgement or refusal', () => {
    expect(isStartMarker('SWITCH_INTERRUPT_STARTED')).toBe(true);
    expect(isStartMarker('')).toBe(false);
    expect(isStartMarker('I cannot post 200 separate messages.')).toBe(false);
    expect(isStartMarker('Working on it… · 0s')).toBe(false);
    expect(isStartMarker('I will write SWITCH_INTERRUPT_STARTED')).toBe(false);
  });
});

describe('request cards', () => {
  it('reads the handle a card answers to', () => {
    expect(requestHandle('@user **Questions** · request `A1` Question from the agent 1. red')).toBe(
      'A1'
    );
    expect(requestHandle('**Permission** · request `R42` Run `echo hi`?')).toBe('R42');
    expect(requestHandle('SWITCH_E2E_OK')).toBeNull();
  });
});
