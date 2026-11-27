import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirmOpenExternalLink = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/open-external-link', () => ({ confirmOpenExternalLink }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));

import { contentLinkHandlers } from '@switch-console/chat-ui/model/content-link';
import { openContentLink } from '@renderer/lib/content-link';

function mouse(button: number) {
  const preventDefault = vi.fn();
  return { event: { button, preventDefault } as unknown as React.MouseEvent, preventDefault };
}

describe('openContentLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['https://example.test/a', 'HTTP://example.test/b'])(
    'asks before opening the web link %s',
    (href) => {
      openContentLink(href);
      expect(confirmOpenExternalLink).toHaveBeenCalledWith(href);
      expect(toast).not.toHaveBeenCalled();
    }
  );

  it.each([
    'mailto:someone@example.test',
    'irc://irc.example.test/room',
    'xmpp:someone@example.test',
    'file:///etc/passwd',
    '/etc/passwd',
    '#section',
    undefined,
  ])('refuses %s with a notice', (href) => {
    openContentLink(href);
    expect(confirmOpenExternalLink).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Link not opened' }));
  });
});

describe('contentLinkHandlers', () => {
  it('keeps every click from the browser and follows a left or middle one', () => {
    const follow = vi.fn();
    const handlers = contentLinkHandlers(follow);

    const left = mouse(0);
    handlers.onClick(left.event);
    const middle = mouse(1);
    handlers.onAuxClick(middle.event);
    const right = mouse(2);
    handlers.onAuxClick(right.event);

    expect(left.preventDefault).toHaveBeenCalled();
    expect(middle.preventDefault).toHaveBeenCalled();
    expect(right.preventDefault).toHaveBeenCalled();
    expect(follow).toHaveBeenCalledTimes(2);
  });
});
