import { defineEvent } from '@shared/lib/ipc/events';

/**
 * A `switchdash://open/…` link the OS handed to the app: from a messaging-app
 * message, a web page or another app. The renderer reads it and opens the page;
 * a link clicked in the app's own chat goes there without this hop.
 */
export const consoleDeeplinkChannel = defineEvent<{
  url: string;
  /** Whether the link started the app rather than being handed to a running one. */
  coldStart: boolean;
}>('deeplink:console-page');
