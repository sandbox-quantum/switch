import { definedEventNames, isEventChannel } from './events';

// Every event is defined with `defineEvent` in a `*Events.ts` or `*-events.ts`
// module under src/shared (event-channels.test.ts holds the tree to that), so
// loading them all defines every event the app has.
import.meta.glob(['../../**/*Events.ts', '../../**/*-events.ts'], { eager: true });

/** The name of every event the app defines. */
export const EVENT_NAMES: ReadonlySet<string> = new Set(definedEventNames());

/** Whether `channel` is the IPC channel of an event the app defines. */
export function isAppEventChannel(channel: string): boolean {
  return isEventChannel(EVENT_NAMES, channel);
}
