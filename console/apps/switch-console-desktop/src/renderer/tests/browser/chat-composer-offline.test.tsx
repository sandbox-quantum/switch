/**
 * A 1:1 chat whose agent's machine is offline holds Send back, Enter too, and
 * says why above the composer, while the draft can still be typed. Once the
 * machine is back, Send works again without a remount.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '@renderer/features/chats/components/chat-composer';
import { chatAvailability } from '@renderer/features/chats/machine-availability';
import {
  ChatTimeline,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ group_chats: true }),
}));

const agent = {
  id: 'a1',
  name: 'porky',
  displayName: null,
  iconUrl: null,
  provider: null,
  alias: null,
  ownerName: null,
  ownedByViewer: true,
};

const managedOn = (state: 'online' | 'offline') => [
  {
    agentId: 'a1',
    machine: { id: 'c1', name: 'FHXDK633MX', kind: 'console', state },
  } as ManagedAgentView,
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe('ChatComposer with an offline machine', () => {
  it('disables Send in a 1:1 chat while the machine is offline, and enables it once back', async () => {
    const send = vi.fn(() => 'req-1');
    const timeline = new ChatTimeline('room-offline', {} as TimelineApi);
    timeline.send = send;
    const client = new QueryClient();
    const mount = async (state: 'online' | 'offline') => {
      if (!root) {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
      }
      await act(async () =>
        root!.render(
          <QueryClientProvider client={client}>
            <ChatComposer
              serverId="srv"
              timeline={timeline}
              agents={[agent]}
              people={[]}
              groupName={null}
              activity={null}
              replyTo={null}
              onClearReply={() => {}}
              disabled={null}
              availability={chatAvailability([agent], 0, managedOn(state))}
            />
          </QueryClientProvider>
        )
      );
    };
    await mount('offline');
    const textarea = container!.querySelector('textarea')!;
    const submit = () => container!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => {
      textarea.focus();
      document.execCommand('insertText', false, 'hello');
    });
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('hello');
    expect(container!.textContent).toContain(
      "FHXDK633MX is offline. porky can't reply until it's back."
    );
    expect(submit().disabled).toBe(true);
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });
    expect(send).not.toHaveBeenCalled();
    expect(textarea.value).toBe('hello');

    await mount('online');
    expect(container!.textContent).not.toContain('is offline');
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    expect(send).toHaveBeenCalledTimes(1);
  });
});
