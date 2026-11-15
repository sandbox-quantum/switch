import { describe, expect, it, vi } from 'vitest';

const refreshSummaries = vi.fn(async () => {});
vi.mock('@renderer/features/chats/stores/chats', () => ({ chatsStore: { refreshSummaries } }));

const { agentNamesChanged } = await import('./agent-names-changed');
const { queryClient } = await import('@renderer/lib/query-client');

describe('agentNamesChanged', () => {
  it('reads again the room participants, chat members, workspace agents and chat summaries', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    agentNamesChanged();
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ['remote-room-detail'],
      ['chat-members'],
      ['workspace-agents'],
    ]);
    expect(refreshSummaries).toHaveBeenCalledTimes(1);
  });
});
