import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Why a session could not start, as far as its room needs to know:
 * `no_login` when the provider is not signed in, `setup` for any other
 * failure the session host recorded, and `unknown` for one it did not (it
 * exited without saying, or started but would not take the message).
 */
export type StartFailureKind = 'no_login' | 'setup' | 'unknown';

/** Thrown by a session host whose provider is not signed in. */
export class NotSignedInError extends Error {
  readonly kind = 'no_login' as const;
  constructor(message: string) {
    super(message);
    this.name = 'NotSignedInError';
  }
}

/** The kind a session host records beside its failure message in `failure.json`. */
export function recordedKindOf(error: unknown): Exclude<StartFailureKind, 'unknown'> {
  return error instanceof NotSignedInError ? 'no_login' : 'setup';
}

/** The kind the session host at `sessionRoot` recorded with its last failure. */
export async function readStartFailureKind(sessionRoot: string): Promise<StartFailureKind> {
  try {
    const recorded = z
      .object({ message: z.string(), kind: z.enum(['no_login', 'setup']).optional() })
      .safeParse(
        JSON.parse(await readFile(join(sessionRoot, 'supervisor', 'failure.json'), 'utf8'))
      );
    return recorded.success ? (recorded.data.kind ?? 'unknown') : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The one "kept" line a message gets when its session can't start, in the
 * agreed wording. Never the raw failure: that names
 * commands a hosted user can't run and goes to the log and Console.
 */
export function keptLine(kind: StartFailureKind, owner: string | null): string {
  const who = owner ? `My owner (@${owner})` : 'My owner';
  switch (kind) {
    case 'no_login':
      return `I can't start yet: there's no AI login on my cloud. ${who} can add one in Your Agents in Switch Console. I've kept your message, so there's no need to send it again. I'll answer as soon as I can.`;
    case 'setup':
      // The no-login line with its middle sentence changed; "there's no AI
      // login" would be untrue here, so the opening stops at "yet".
      return `I can't start yet. ${who} can see why in Your Agents in Switch Console. I've kept your message, so there's no need to send it again. I'll answer as soon as I can.`;
    case 'unknown':
      return "I can't start a session right now. I've kept your message and I'll answer as soon as I can.";
  }
}

/** Posted once a kept message waited its limit without a start; it is never answered later. */
export const START_LET_GO_MESSAGE =
  "I still couldn't start, so I've let your message go. Send it again once I'm back.";

/** Posted for each message a session still owed when it is closed (deleted) in Console. */
export const SESSION_CLOSED_MESSAGE =
  "My session was closed, so I've let your message go. Send it again if you still need it.";
