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
