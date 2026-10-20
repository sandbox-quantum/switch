import { when } from 'mobx';
import { useEffect } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { events } from '@renderer/lib/ipc';
import { consoleDeeplinkChannel } from '@shared/core/deeplinks/console-link-events';
import { setConsoleLinkHandler } from './console-link-handler';
import { openConsoleLink } from './open-console-link';

/**
 * Opens the page of a `switchdash://open/…` link the OS handed to the app.
 * Waits for the server list on a cold start, since a link that names a server
 * can only be matched once the list is read.
 */
export function ConsoleLinkListener(): null {
  useEffect(() => {
    setConsoleLinkHandler((url) => void openConsoleLink(url));
    const off = events.on(consoleDeeplinkChannel, ({ url }) => {
      void (async () => {
        await when(() => switchServersStore.loaded);
        await openConsoleLink(url);
      })();
    });
    return () => {
      off();
      setConsoleLinkHandler(null);
    };
  }, []);
  return null;
}
