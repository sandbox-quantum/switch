/**
 * A view that opens a chat's timeline while it renders (the chat panel) must
 * not change what another view on screen observes (a chat row peeking at it):
 * React refuses an update to one component made while another renders.
 */
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  ChatTimelines,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';

it('opens a timeline while rendering without updating a view that peeks at it', async () => {
  const timelines = new ChatTimelines(() => ({}) as TimelineApi);
  const Row = observer(() => <span>{timelines.peek('s', 'r1') ? 'open' : 'closed'}</span>);
  const Panel = observer(() => {
    timelines.get('s', 'r1');
    return null;
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  // The row is on screen, watching, before the panel opens the timeline.
  await act(async () => root.render(<Row />));
  await act(async () =>
    root.render(
      <>
        <Row />
        <Panel />
      </>
    )
  );
  await act(async () => await Promise.resolve());
  expect(
    error.mock.calls.some((call) =>
      String(call[0]).includes('while rendering a different component')
    )
  ).toBe(false);
  // The row still follows the timeline once it is open.
  expect(container.textContent).toBe('open');
  error.mockRestore();
  await act(async () => root.unmount());
  container.remove();
});
