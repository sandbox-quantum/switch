import { failureText } from '@renderer/lib/errors/describe-failure';
import { RpcError } from '@shared/lib/ipc/rpc-error';

/**
 * What to put under the name field when creating a workspace fails.
 *
 * The name being taken is by far the likeliest way this form fails, and it is
 * the only failure the person at the keyboard can fix. The gateway derives a
 * slug from the name and refuses a duplicate with `Slug already taken:
 * acme-robotics` — no terminal punctuation, so the generic description does not
 * read it as a sentence and shows it as diagnostic text instead: a status code
 * and a slug the user never typed, for the one refusal that is about what they
 * did type.
 *
 * Only that route's conflict is rewritten. Everything else keeps the shared
 * description, because a name-specific sentence over an expired session or an
 * unreachable server would blame the name for something it had nothing to do
 * with.
 */
export function createWorkspaceFailureText(
  error: unknown,
  serverName: string,
  fallback: string
): string {
  const conflict =
    error instanceof RpcError &&
    error.code === 'GatewayError' &&
    error.numberField('status') === 409;
  if (!conflict) return failureText(error, fallback);
  return `A workspace on ${serverName} already goes by that name. Capitalisation and punctuation do not make it a different one, so pick a name that stands apart.`;
}
