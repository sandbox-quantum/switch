import type * as React from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';

const HTTP_URL_PATTERN = /^https?:\/\//i;

/**
 * Follow a link in something someone else wrote: a chat message, a room
 * document, a library item, a transcript. A web link goes through the confirm
 * dialog, which shows where it really leads. Anything else (`mailto:`, `irc:`,
 * a relative path) is refused with a notice: left to the browser, it opens a
 * stray app window or launches whatever the OS has registered for the scheme,
 * with nothing asked.
 */
export function openContentLink(href: string | undefined): void {
  if (href && HTTP_URL_PATTERN.test(href)) {
    confirmOpenExternalLink(href);
    return;
  }
  toast({
    title: 'Link not opened',
    description: 'Switch Console opens web links (http and https) only.',
  });
}

/**
 * Click handlers for such a link that keep every click from the browser, a
 * middle-click included, and pass a left or middle click to `follow`.
 */
export function contentLinkHandlers(follow: () => void): {
  onClick: React.MouseEventHandler;
  onAuxClick: React.MouseEventHandler;
} {
  return {
    onClick: (event) => {
      event.preventDefault();
      follow();
    },
    onAuxClick: (event) => {
      event.preventDefault();
      if (event.button === 1) follow();
    },
  };
}
