import { describe, expect, it, vi } from 'vitest';
import { turnEndNote } from '@renderer/features/sessions/components/transcript/session-v1-chat';

// The transcript's imports read the desktop bridge when loaded; `turnEndNote` needs none of it.
vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn(() => () => {}) }, rpc: {} }));

describe('the line under a turn in the session transcript', () => {
  it('says a cancelled turn was cancelled, and not as a failure', () => {
    expect(turnEndNote('cancelled')).toEqual({ text: 'Turn cancelled.', failed: false });
  });

  it('keeps an interrupted or failed turn marked as it was', () => {
    expect(turnEndNote('interrupted')).toEqual({ text: 'Turn interrupted.', failed: true });
    expect(turnEndNote('error')).toEqual({ text: 'Turn error.', failed: true });
  });

  it('says nothing under a turn still going or one that answered', () => {
    for (const status of ['queued', 'running', 'completed'] as const)
      expect(turnEndNote(status)).toBeNull();
  });
});
