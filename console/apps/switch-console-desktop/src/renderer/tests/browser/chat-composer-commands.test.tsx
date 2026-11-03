/**
 * A `!` that starts a message offers the room's commands, from the server's
 * list: typed on, they narrow; arrows move, Enter or Tab inserts `!name `, Esc
 * closes. A `!` later in the message is just text.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const commands = vi.hoisted(() =>
  vi.fn(async () => [
    { name: 'help', description: 'Show this list of commands.', usage: '!help' },
    { name: 'reset', description: "Reset a targeted agent's session.", usage: '!reset <target>' },
    { name: 'reset-all-agents', description: 'Reset every agent.', usage: '!reset-all-agents' },
  ])
);
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { chats: { commands } },
}));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ group_chats: true }),
}));

import { ChatComposer } from '@renderer/features/chats/components/chat-composer';
import {
  ChatTimeline,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLTextAreaElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatComposer
          serverId="s"
          timeline={new ChatTimeline('room-commands', {} as TimelineApi)}
          agents={[]}
          people={[]}
          groupName="Ship review"
          activity={null}
          replyTo={null}
          onClearReply={() => {}}
          disabled={null}
        />
      </QueryClientProvider>
    )
  );
  return container.querySelector('textarea')!;
}

async function type(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    textarea.focus();
    textarea.select();
    document.execCommand('insertText', false, value);
  });
  for (let i = 0; i < 3; i++) await act(async () => await Promise.resolve());
}

const key = (textarea: HTMLTextAreaElement, name: string) =>
  act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
    );
  });

const options = () =>
  [...container!.querySelectorAll('[role="option"]')].map(
    (option) => option.querySelector('.font-medium')?.textContent
  );

it('offers the room’s commands on a starting !, narrowing as the name is typed', async () => {
  const textarea = await render();
  await type(textarea, '!');
  expect(container!.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe(
    'Room commands'
  );
  expect(options()).toEqual(['!help', '!reset <target>', '!reset-all-agents']);
  await type(textarea, '!res');
  expect(options()).toEqual(['!reset <target>', '!reset-all-agents']);
  expect(commands).toHaveBeenCalledWith('s', 'room-commands');
});

it('inserts the picked command with a space after it, by arrows and Enter or Tab', async () => {
  const textarea = await render();
  await type(textarea, '!res');
  await key(textarea, 'ArrowDown');
  await key(textarea, 'ArrowUp');
  await key(textarea, 'Enter');
  expect(textarea.value).toBe('!reset ');
  expect(container!.querySelector('[role="listbox"]')).toBeNull();

  await type(textarea, '!he');
  await key(textarea, 'Tab');
  expect(textarea.value).toBe('!help ');
});

it('closes on Esc, and offers nothing for a ! later in the message', async () => {
  const textarea = await render();
  await type(textarea, '!');
  await key(textarea, 'Escape');
  expect(container!.querySelector('[role="listbox"]')).toBeNull();
  await type(textarea, 'hello !res');
  expect(container!.querySelector('[role="listbox"]')).toBeNull();
});
