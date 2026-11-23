/**
 * How the chat UI reads a failure. The app that hosts the chat knows its own
 * errors (Console's RPC errors, the dashboard's fetch errors), so it says how
 * to read them once, with {@link configureFailures}, before any chat loads.
 * Until it does, a failure is read from its message alone.
 */

/** A failure split into the sentence a person reads and the detail they may need to pass on. */
export type FailureDescription = {
  /** Plain sentence. Never raw exception text. */
  headline: string;
  /** Diagnostic text, or null when the headline already says everything. */
  detail: string | null;
};

/**
 * What a failed `/chats` call means for the chat: the person lost access, a
 * request id was reused with another payload, the server refused the message
 * on trust grounds, or something else — and whether the outcome is unknown
 * (the request may have been applied), in which case only a retry with the
 * same request id is safe.
 */
export type ChatFailure = {
  kind: 'not-a-member' | 'request-reused' | 'refused' | 'not-a-manager' | 'agent-owner' | 'other';
  message: string;
  /** The server may have applied the request; retrying with the same id is safe. */
  uncertain: boolean;
};

export type FailureReader = {
  describe: (error: unknown, fallback: string) => FailureDescription;
  chatFailure: (error: unknown) => ChatFailure;
  /** An uncoded 404 from an activity route: the server predates live chat activity. */
  serverTooOld: (error: unknown) => boolean;
  warn: (message: string, context: Record<string, unknown>) => void;
};

function describeByMessage(error: unknown, fallback: string): FailureDescription {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  return { headline: fallback, detail: raw || null };
}

let reader: FailureReader = {
  describe: describeByMessage,
  chatFailure: (error) => ({
    kind: 'other',
    message: failureText(error, 'The request failed.'),
    uncertain: true,
  }),
  serverTooOld: () => false,
  warn: (message, context) => console.warn(message, context),
};

export function configureFailures(next: FailureReader): void {
  reader = next;
}

/**
 * @param fallback The sentence to lead with when the failure is not one the app
 *   recognises, written for the action the person just took.
 */
export function describeFailure(error: unknown, fallback: string): FailureDescription {
  return reader.describe(error, fallback);
}

/** One string, for the surfaces that have nowhere to put the detail separately. */
export function failureText(error: unknown, fallback: string): string {
  const { headline, detail } = describeFailure(error, fallback);
  return detail ? `${headline} (${detail})` : headline;
}

export function chatFailure(error: unknown): ChatFailure {
  return reader.chatFailure(error);
}

export function serverTooOld(error: unknown): boolean {
  return reader.serverTooOld(error);
}

export function warn(message: string, context: Record<string, unknown>): void {
  reader.warn(message, context);
}
