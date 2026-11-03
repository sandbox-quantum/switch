/**
 * The new-session dialog's Conversation field offers the Claude Code CLI
 * conversations in the agent's folder, will not take one a terminal has open,
 * and asks for confirmation where Claude Code cannot say which are open.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { CliConversation, CliConversationList } from '@shared/core/sessions/cli-conversations';

const listCliConversations = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: { sessions: { listCliConversations } },
}));

import {
  CliConversationField,
  useCliConversations,
} from '@renderer/features/sessions/create-session-modal/cli-conversation-field';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const picked: { current: CliConversation | null } = { current: null };

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  picked.current = null;
  listCliConversations.mockReset();
});

const OPEN: CliConversation = {
  nativeSessionId: 'open-1',
  title: 'Refactor the session host',
  lastActivityAt: Date.now() - 60_000,
  gitBranch: 'main',
  openIn: { pid: 41, entrypoint: 'cli' },
};
const CLOSED: CliConversation = {
  nativeSessionId: 'closed-1',
  title: 'Fix the flaky build',
  lastActivityAt: Date.now() - 3 * 60 * 60_000,
  gitBranch: 'fix/build',
  openIn: null,
};

function Harness() {
  const conversations = useCliConversations('agent-1');
  const [value, setValue] = useState<CliConversation | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  picked.current = value;
  return (
    <CliConversationField
      conversations={conversations}
      value={value}
      onChange={setValue}
      confirmedClosed={confirmed}
      onConfirmedClosedChange={setConfirmed}
    />
  );
}

async function render(list: CliConversationList) {
  listCliConversations.mockResolvedValue({ success: true, data: list });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Dialog open>
          <DialogContent>
            <Harness />
          </DialogContent>
        </Dialog>
      </QueryClientProvider>
    )
  );
}

it('offers a closed conversation and not one a terminal has open', async () => {
  await render({ ownershipKnown: true, conversations: [OPEN, CLOSED] });
  expect(listCliConversations).toHaveBeenCalledWith('agent-1');
  await expect.element(page.getByText('New conversation')).toBeVisible();
  await page.getByText('New conversation').click();
  await expect.element(page.getByText('Open in Claude Code (process 41)')).toBeVisible();
  await expect
    .element(page.getByRole('option', { name: /Refactor the session host/ }))
    .toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('option', { name: /Fix the flaky build/ }).click();
  expect(picked.current?.nativeSessionId).toBe('closed-1');
  await expect.element(page.getByText(/continues a copy of this conversation/)).toBeVisible();
  await expect.element(page.getByText('It isn’t open in a terminal')).not.toBeInTheDocument();
  await page.getByText('Start a new conversation instead').click();
  expect(picked.current).toBeNull();
});

it('asks whether the conversation is closed when Claude Code cannot say', async () => {
  await render({ ownershipKnown: false, conversations: [CLOSED] });
  await page.getByText('New conversation').click();
  await page.getByRole('option', { name: /Fix the flaky build/ }).click();
  await expect.element(page.getByText('It isn’t open in a terminal')).toBeVisible();
});

it('says why nothing is offered', async () => {
  listCliConversations.mockResolvedValue({
    success: false,
    error: { message: 'Open the agent’s folder in Console first.' },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>
    )
  );
  await expect.element(page.getByText('Open the agent’s folder in Console first.')).toBeVisible();
});
