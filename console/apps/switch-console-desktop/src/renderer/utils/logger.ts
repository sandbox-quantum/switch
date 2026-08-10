import { createLogger, serializeLogValue, type LogSinkEntry } from '@shared/logger';

/**
 * `AsyncLocalStorage` is a Node API and has no browser equivalent, so the
 * renderer cannot resolve ambient context the way the main process does.
 * Instead it attaches whatever ids the call site knows via `log.child(...)`
 * and leaves the rest to the main sink, which enriches every entry in one
 * place regardless of which process it came from.
 */
export const log = createLogger({
  sink: (entry) => {
    const safe: LogSinkEntry = {
      level: entry.level,
      input: entry.input.map(serializeLogValue),
      source: entry.source,
      context: entry.context,
    };
    window.electronAPI?.eventSend('switch-console:renderer-log', safe);
  },
});
