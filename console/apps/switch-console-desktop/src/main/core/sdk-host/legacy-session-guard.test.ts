import { expect, it, vi } from 'vitest';
vi.mock('@main/db/client', () => ({ db: {} }));
const { legacyTmuxNames } = await import('./legacy-session-guard');
it('identifies only exact legacy sessions and the sidecar for this agent and directory', () => {
  const names = legacyTmuxNames(['saved-id'], '/repo', 'agent');
  expect(names).toContain(`switchdash-${Buffer.from('session-saved-id').toString('base64url')}`);
  expect(names).toHaveLength(3);
  expect(legacyTmuxNames(['saved-id'], '/other', 'agent').at(-1)).not.toBe(names.at(-1));
  expect(legacyTmuxNames(['saved-id'], '/repo', 'other').at(-1)).not.toBe(names.at(-1));
});
