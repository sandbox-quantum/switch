import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  introduceFirstAgentMessage,
  useChatEntrance,
} from '@renderer/features/chats/chat-entrance';

function Probe({ roomId }: { roomId: string }) {
  return createElement('span', null, useChatEntrance(roomId) ? 'enter' : 'still');
}

const open = (roomId: string) => renderToStaticMarkup(createElement(Probe, { roomId }));

it('brings in the first message of the chat it was asked for, once', () => {
  introduceFirstAgentMessage('room-1');

  expect(open('room-2')).toContain('still');
  expect(open('room-1')).toContain('enter');
  // Reopening the chat later draws it at once.
  expect(open('room-1')).toContain('still');
});
