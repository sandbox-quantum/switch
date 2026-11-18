import { describe, expect, it, vi } from 'vitest';
import { getAgentAdvancedSettings } from './agent-advanced-config';

vi.mock('./agent-config', () => ({
  readAgentConfig: vi.fn(),
  setAgentSettings: vi.fn(),
}));
vi.mock('./getAgentById', () => ({ getAgentById: vi.fn() }));

describe('the locally editable advanced fields', () => {
  it('offers only the OpenCode field sent by the session launch path', () => {
    expect(getAgentAdvancedSettings('opencode')).toEqual({
      surface: 'launch-profile',
      keys: ['variant'],
    });
  });

  it('keeps the Codex fields from its applied profile', () => {
    expect(getAgentAdvancedSettings('codex').keys).toEqual([
      'effort',
      'verbosity',
      'reasoningSummary',
      'webSearch',
    ]);
  });
});
