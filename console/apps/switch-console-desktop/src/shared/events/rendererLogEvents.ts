import { defineEvent } from '@shared/lib/ipc/events';
import type { LogSinkEntry } from '@shared/logger';

/**
 * A renderer log entry, sent to the main process's file sink. Sent directly
 * through `eventSend` rather than the renderer's event emitter, so the logger
 * works before (and without) the RPC client.
 */
export const rendererLogChannel = defineEvent<LogSinkEntry>('switch-console:renderer-log');
