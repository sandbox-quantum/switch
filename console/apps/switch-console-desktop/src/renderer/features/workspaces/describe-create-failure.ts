import { failureText } from '@renderer/lib/errors/describe-failure';
import { RpcError } from '@shared/lib/ipc/rpc-error';

/**
 * What to put under the name field when creating a workspace fails.
 *
 * A conflict from the gateway is never about the name: a slug already taken is
 * retried with a suffix, so the name is free to repeat. What it refuses with
 * 409 is a deployment that keeps to one workspace (it is not isolating tenants)
 * or a second create racing the first, and only the server can say which, in a
 * sentence of its own. So its words are shown as they are, said to come from
 * the server, rather than turned into advice to rename.
 *
 * Everything else keeps the shared description.
 */
export function createWorkspaceFailureText(
  error: unknown,
  serverName: string,
  fallback: string
): string {
  const detail =
    error instanceof RpcError &&
    error.code === 'GatewayError' &&
    error.numberField('status') === 409
      ? error.stringField('detail')?.trim()
      : undefined;
  if (!detail) return failureText(error, fallback);
  return `${serverName} could not create it: ${detail}`;
}
