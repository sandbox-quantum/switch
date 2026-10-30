/**
 * The composer's mention badges sit behind the textarea on a mirrored layer;
 * they only line up with the text if that layer scrolls exactly like the
 * textarea. And Enter that an IME is handling must never send.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Geometry is the subject, so the real utility classes must be present.
import '@renderer/index.css';
import { ChatComposer } from '@renderer/features/chats/components/chat-composer';
import {
  ChatTimeline,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';
import { PromptInput, PromptInputTextarea } from '@renderer/features/chats/ui/prompt-input';

const flags = vi.hoisted(() => ({ group_chats: true }));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({ useFeatureFlags: () => flags }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(node: React.ReactNode): Promise<HTMLTextAreaElement> {
  container = document.createElement('div');
  container.style.width = '600px';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>)
  );
  return container.querySelector('textarea')!;
}

const agent = {
  id: 'a2',
  name: 'agent-two',
  displayName: null,
  iconUrl: null,
  provider: null,
  alias: null,
  ownerName: null,
  ownedByViewer: false,
};

describe('ChatComposer mention badges', () => {
  it('scroll in step with the text at the bottom of a long draft', async () => {
    const textarea = await render(
      <ChatComposer
        serverId="s"
        timeline={new ChatTimeline('room-geometry', {} as TimelineApi)}
        agents={[agent]}
        people={[]}
        groupName="Ship review"
        activity={null}
        replyTo={null}
        onClearReply={() => {}}
        disabled={null}
      />
    );
    const draft = `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\n@agent-two last`;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        draft
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const mark = container!.querySelector('mark')!;
    const backdrop = mark.parentElement!;
    expect(mark.textContent).toBe('@agent-two');
    expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
    expect(backdrop.clientHeight).toBe(textarea.clientHeight);
    expect(backdrop.scrollHeight).toBe(textarea.scrollHeight);
    await act(async () => {
      textarea.scrollTop = textarea.scrollHeight;
      textarea.dispatchEvent(new Event('scroll'));
    });
    expect(backdrop.scrollTop).toBe(textarea.scrollTop);
  });
});

describe('PromptInputTextarea', () => {
  it('does not submit on an Enter the IME is handling, even without isComposing', async () => {
    const onSubmit = vi.fn();
    const textarea = await render(
      <PromptInput onSubmit={onSubmit}>
        <PromptInputTextarea defaultValue="hi" />
        <button type="submit">Send</button>
      </PromptInput>
    );
    const enter = (keyCode: number) =>
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', keyCode, bubbles: true, cancelable: true })
      );
    await act(async () => enter(229));
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => enter(13));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('ChatComposer picked mentions', () => {
  it('keeps a picked person as the person through delete and undo, beside a same-name agent', async () => {
    const sharer = { ...agent, id: 'a9', name: 'Bob Member' };
    const textarea = await render(
      <ChatComposer
        serverId="s"
        timeline={new ChatTimeline('room-undo', {} as TimelineApi)}
        agents={[sharer]}
        people={[{ userId: 'u1', name: 'Bob Member', email: 'bob@example.com' }]}
        groupName="Ship review"
        activity={null}
        replyTo={null}
        onClearReply={() => {}}
        disabled={null}
      />
    );
    const kinds = () =>
      [...container!.querySelectorAll('mark[data-mention]')].map(
        (mark) => (mark as HTMLElement).dataset.mention
      );
    await act(async () => {
      textarea.focus();
      document.execCommand('insertText', false, '@bo');
    });
    // The agent comes first in the list; the person is next.
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });
    expect(textarea.value).toBe('@Bob Member ');
    expect(kinds()).toEqual(['person']);
    await act(async () => {
      textarea.setSelectionRange(0, textarea.value.length);
      document.execCommand('delete');
    });
    expect(kinds()).toEqual([]);
    await act(async () => {
      document.execCommand('undo');
    });
    expect(textarea.value).toBe('@Bob Member ');
    expect(kinds()).toEqual(['person']);
  });
});

describe('ChatComposer on a server without group chats', () => {
  it('offers no people and badges only the first agent mention', async () => {
    flags.group_chats = false;
    try {
      const one = { ...agent, id: 'a1', name: 'agent-one' };
      const textarea = await render(
        <ChatComposer
          serverId="s"
          timeline={new ChatTimeline('room-flag', {} as TimelineApi)}
          agents={[one, agent]}
          people={[{ userId: 'u1', name: 'Bob Member', email: null }]}
          groupName="Ship review"
          activity={null}
          replyTo={null}
          onClearReply={() => {}}
          disabled={null}
        />
      );
      await act(async () => {
        textarea.focus();
        document.execCommand('insertText', false, '@bo');
      });
      expect(container!.querySelector('[role="listbox"]')).toBeNull();
      await act(async () => {
        textarea.setSelectionRange(0, textarea.value.length);
        document.execCommand('insertText', false, '@agent-one and @agent-two ');
      });
      expect(
        [...container!.querySelectorAll('mark[data-mention]')].map((mark) => mark.textContent)
      ).toEqual(['@agent-one']);
      await act(async () => {
        document.execCommand('insertText', false, '@ag');
      });
      // One agent is named already: the list does not offer another.
      expect(container!.querySelector('[role="listbox"]')).toBeNull();
    } finally {
      flags.group_chats = true;
    }
  });
});
