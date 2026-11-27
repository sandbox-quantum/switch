import type * as React from 'react';

/**
 * Click handlers for a link in something someone else wrote that keep every click from the browser, a
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
