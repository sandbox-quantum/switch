/**
 * Retry on a failed turn: offered when the agent's session says it can, in its
 * place a plain reason when it cannot, held while it is being posted, the
 * server's refusal said, and a retry no new turn followed called out.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ChatActivityBlock,
  RETRY_UNANSWERED_MS,
  RETRY_UNSUPPORTED_TEXT,
} from '@renderer/features/chats/components/chat-activity-block';
import {
  type ActivityApi,
  AgentActivities,
} from '@renderer/features/chats/stores/chat-activity-store';
import type { ChatActivityItem } from '@shared/core/chats/activity';
import { RpcError } from '@shared/lib/ipc/rpc-error';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

const failedTurn: ChatActivityItem = {
  agentId: 'agent-a',
  sessionId: 's1',
  turnId: 't1',
  itemId: 'turn',
  kind: 'turn',
  revision: 1,
  status: 'error',
  title: '',
  text: '',
  commandId: null,
  roomId: 'room-1',
  threadId: null,
  messageId: 'm1',
  occurredAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

async function render(
  support: 'yes' | 'no' | 'unknown',
  control: ActivityApi['control'],
  items: ChatActivityItem[] = [failedTurn]
): Promise<HTMLDivElement> {
  const api: ActivityApi = {
    resolve: async () => ({
      kind: 'session',
      target: { kind: 'local' } as never,
      hostAgentKey: 'agent-local',
      sessionId: 's1',
    }),
    reasoning: async () => null,
    watchPlacements: () => () => {},
    roomActivity: async () => ({ items, approvals: [] }),
    roomMessages: () => [],
    control,
    retrySupport: async () => support,
    answerApproval: async () => {
      throw new Error('unused');
    },
  };
  const activities = new AgentActivities(api, {
    getItem: () => null,
    setItem: () => {},
  });
  const activity = activities.acquire('server', 'tenant', 'room-1', 'agent-a');
  await vi.waitFor(() => expect(activity.turns().size).toBe(1));
  await vi.waitFor(() => expect(activity.target).not.toBeNull());
  const turn = activity.turns().get('m1')!;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatActivityBlock
          activity={activity}
          turn={turn}
          agent={{ name: 'helper', iconUrl: null }}
          head
          endReason="model not supported"
          serverId="server"
        />
      </QueryClientProvider>
    )
  );
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  return container;
}

const retryButton = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].find((b) => /^Retr/.test(b.textContent ?? ''));

it('says why in place of Retry when the session cannot retry', async () => {
  const el = await render('no', vi.fn());
  expect(retryButton(el)).toBeUndefined();
  expect(el.textContent).toContain(RETRY_UNSUPPORTED_TEXT);
  expect(el.textContent).toContain('model not supported');
});

it('asks once, holds the button while it is posted, and says when no new turn followed', async () => {
  let answer: (commandId: string) => void = () => {};
  const control = vi.fn(() => new Promise<string>((resolve) => (answer = resolve)));
  const el = await render('yes', control);
  const button = retryButton(el)!;
  expect(button.disabled).toBe(false);

  await act(async () => button.click());
  expect(retryButton(el)!.textContent).toBe('Retrying…');
  expect(retryButton(el)!.disabled).toBe(true);
  await act(async () => retryButton(el)!.click());
  expect(control).toHaveBeenCalledTimes(1);
  expect(control).toHaveBeenCalledWith(
    expect.objectContaining({ command: 'retry', messageId: 'm1' })
  );

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  await act(async () => answer('cmd-1'));
  expect(retryButton(el)!.textContent).toBe('Retry asked');
  await act(async () => vi.advanceTimersByTime(RETRY_UNANSWERED_MS + 10));
  expect(el.textContent).toContain('did not pick up the retry');
  expect(retryButton(el)!.disabled).toBe(false);
});

it('says the server’s refusal and offers Retry again', async () => {
  const el = await render('unknown', async () => {
    throw new RpcError({
      code: 'ChatApiError',
      message: 'helper took no turn for that message.',
      data: { status: 409, code: 'NOTHING_TO_RETRY' },
    } as never);
  });
  await act(async () => retryButton(el)!.click());
  for (let i = 0; i < 3; i++) await act(async () => await Promise.resolve());
  expect(el.querySelector('[role="alert"]')?.textContent).toContain('took no turn');
  expect(retryButton(el)!.disabled).toBe(false);
});

it('shows the host’s warning in the turn, such as a model this sign-in cannot use', async () => {
  const warning =
    'This Codex sign-in cannot use gpt-6.1-sol, the model its configuration names, so this session runs gpt-6-astra.';
  const el = await render('yes', vi.fn(), [
    { ...failedTurn, status: 'running' },
    {
      ...failedTurn,
      itemId: 'notice:12',
      kind: 'notice',
      status: 'warning',
      title: warning,
      text: warning,
    },
  ]);
  expect(el.textContent).toContain('cannot use gpt-6.1-sol');
});
