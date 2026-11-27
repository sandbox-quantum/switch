import { introduceChat, useChatEntrance } from '@switch-console/chat-ui/components/chat-entrance';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

function Probe({ roomId }: { roomId: string }) {
  const { firstAgent, firstOwn } = useChatEntrance(roomId);
  return createElement(
    'span',
    null,
    firstAgent && firstOwn ? 'enter' : firstAgent ? 'agent' : 'still'
  );
}

const open = (roomId: string) => renderToStaticMarkup(createElement(Probe, { roomId }));

it('brings in the first message of the chat it was asked for, once', () => {
  introduceChat('room-1', 'own-and-agent');

  expect(open('room-2')).toContain('still');
  expect(open('room-1')).toContain('enter');
  // Reopening the chat later draws it at once.
  expect(open('room-1')).toContain('still');
});

it('brings in only the agent’s first message when asked for that', () => {
  introduceChat('room-3', 'agent');
  expect(open('room-3')).toContain('agent');
});
