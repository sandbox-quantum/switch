import { describe, expect, it, vi } from 'vitest';
import { knownPeople } from './chat-people';

vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('./stores/chats', () => ({ chatsStore: {} }));

describe('knownPeople', () => {
  it('keeps the viewer among the members and adds the rest of the roster to the known', () => {
    const { members, known } = knownPeople(
      [
        { userId: 'me', name: 'Alice' },
        { userId: 'u2', name: 'Bob' },
      ],
      [
        { userId: 'u2', name: 'Bob', email: 'bob@example.com' },
        { userId: 'u9', name: 'Carol', email: null },
      ]
    );
    expect(members.map((p) => p.userId)).toEqual(['me', 'u2']);
    expect(members[1]!.email).toBe('bob@example.com');
    expect(known.map((p) => p.userId)).toEqual(['me', 'u2', 'u9']);
  });
});
