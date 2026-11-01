import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import '@renderer/index.css';
import type { TurnActivity } from '@renderer/features/chats/activity-join';
import { ChatActivityBlock } from '@renderer/features/chats/components/chat-activity-block';
import type { AgentActivity } from '@renderer/features/chats/stores/chat-activity-store';
import { avatarSettingsQueryKey } from '@renderer/lib/stores/use-avatar-settings';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // The agent's avatar reads its server's avatar setting; seeded, it is fresh
  // and never asked for.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  client.setQueryData(avatarSettingsQueryKey('server-1'), { thirdPartyAvatarsEnabled: false });
  await act(async () =>
    root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
  );
  return container;
}

const activity = { reasoning: new Map(), toolDetails: new Map() } as unknown as AgentActivity;

function turn(status: TurnActivity['status']): TurnActivity {
  return {
    sessionId: 's1',
    turnId: 't1',
    status,
    roomId: 'room-1',
    messageId: 'm1',
    items: [],
    requests: [],
  };
}

function block(status: TurnActivity['status']) {
  return (
    <ChatActivityBlock
      activity={activity}
      turn={turn(status)}
      agent={{ name: 'Helper', iconUrl: null }}
      head
      endReason={null}
      serverId="server-1"
    />
  );
}

describe('ChatActivityBlock', () => {
  it('shows a cancelled turn as cancelled, without the failure mark', async () => {
    const el = await render(block('cancelled'));

    const status = el.querySelector<HTMLElement>('[role="status"]');
    expect(status?.textContent).toBe('Cancelled');
    expect(status?.querySelector('.text-foreground-destructive')).toBeNull();
    expect(el.textContent).not.toContain('t1');
  });

  it('keeps the failure mark for a turn that ended with an error', async () => {
    const el = await render(block('error'));

    const status = el.querySelector<HTMLElement>('[role="status"]');
    expect(status?.querySelector('.text-foreground-destructive')).not.toBeNull();
  });
});
