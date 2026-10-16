import { describe, expect, it, vi } from 'vitest';
import { DirectChatStarter } from '@renderer/features/chats/stores/direct-chat-starter';
import type { ChatSummary } from '@shared/core/chats/chats';

const chat = { roomId: 'r1', channelType: 'direct' } as ChatSummary;

function setup(
  create: () => Promise<ChatSummary>,
  findEmpty: () => ChatSummary | null = () => null
) {
  let id = 0;
  const deps = {
    create: vi.fn(create),
    created: vi.fn(),
    opened: vi.fn(),
    warm: vi.fn(),
    failed: vi.fn(),
    findEmpty: vi.fn(findEmpty),
    newId: () => `req-${++id}`,
  };
  return { deps, starter: new DirectChatStarter(deps) };
}

describe('DirectChatStarter', () => {
  it('creates an unnamed direct chat with the one agent and reports it', async () => {
    const { deps, starter } = setup(async () => chat);
    await expect(starter.start('s1', 'a1')).resolves.toBe(chat);
    expect(deps.create).toHaveBeenCalledWith({
      serverId: 's1',
      agentIds: ['a1'],
      name: null,
      requestId: 'req-1',
    });
    expect(deps.created).toHaveBeenCalledWith('s1', chat);
    expect(deps.warm).not.toHaveBeenCalled();
  });

  it('ignores a second start for the same agent while one is in flight', async () => {
    let finish: (value: ChatSummary) => void = () => {};
    const { deps, starter } = setup(() => new Promise((resolve) => (finish = resolve)));
    const first = starter.start('s1', 'a1');
    await expect(starter.start('s1', 'a1')).resolves.toBeNull();
    finish(chat);
    await expect(first).resolves.toBe(chat);
    expect(deps.create).toHaveBeenCalledOnce();
  });

  it('reports a failure and reuses the request id after an uncertain one', async () => {
    const { deps, starter } = setup(async () => {
      throw new Error('offline');
    });
    await expect(starter.start('s1', 'a1')).resolves.toBeNull();
    expect(deps.failed).toHaveBeenCalledWith(expect.stringContaining('Try again'));
    expect(deps.created).not.toHaveBeenCalled();
    deps.create.mockResolvedValueOnce(chat);
    await starter.start('s1', 'a1');
    expect(deps.create).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'req-1' }));
  });

  it('reuses an existing empty chat', async () => {
    const existing = { roomId: 'r2', channelType: 'direct' } as ChatSummary;
    const { deps, starter } = setup(
      async () => chat,
      () => existing
    );
    await expect(starter.start('s1', 'a1')).resolves.toBe(existing);
    expect(deps.findEmpty).toHaveBeenCalledWith('a1');
    expect(deps.opened).toHaveBeenCalledWith(existing);
    expect(deps.warm).toHaveBeenCalledWith('s1', 'a1', 'r2');
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('creates a new chat when no empty chat exists', async () => {
    const { deps, starter } = setup(
      async () => chat,
      () => null
    );
    await expect(starter.start('s1', 'a1')).resolves.toBe(chat);
    expect(deps.findEmpty).toHaveBeenCalledWith('a1');
    expect(deps.create).toHaveBeenCalled();
    expect(deps.opened).not.toHaveBeenCalled();
  });
});
