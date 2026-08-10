import { defineEvent } from '@shared/lib/ipc/events';

/**
 * A session started without the Switch MCP tools it was supposed to have.
 *
 * Sessions deliberately start anyway when the runtime cannot be fetched — one
 * with no MCP server beats none at all — but until this event the only trace
 * was a line in a log file, so the session looked healthy and simply had no
 * Switch tools. The reason distinguishes the fixes: `not-authenticated` and
 * `missing-scope` are resolved by the setup flow, while `env-shadowed` is not
 * resolved by authenticating at all.
 */
export const switchToolsUnavailableEvent = defineEvent<{
  reason: 'not-authenticated' | 'missing-scope' | 'invalid-token' | 'env-shadowed';
  detail: string;
}>('switch-setup:tools-unavailable');
