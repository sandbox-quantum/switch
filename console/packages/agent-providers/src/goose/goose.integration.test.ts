import { describe, expect, it } from 'vitest';
import { gooseAcp } from './goose-acp';

describe('goose integration', () => {
  it('defines capabilities matching provider expectations', () => {
    expect(gooseAcp.provider).toBe('goose');
    expect(gooseAcp.label).toBe('Goose CLI');
    expect(gooseAcp.defaultBinary).toBe('goose');
    expect(gooseAcp.capabilities.approvals).toBe(true);
    expect(gooseAcp.capabilities.resume).toBe(true);
  });
});
