import type { Client } from 'ssh2';

/**
 * A server that declines `auth-agent-req@openssh.com` — typically
 * `AllowAgentForwarding no` in a hardening drop-in.
 *
 * ssh2 asks for a reply to that request and treats "no" as fatal: it closes the
 * channel and errors the exec/shell, so a host refusing an optional extra makes
 * every command on it fail. OpenSSH sends the same request with no reply
 * expected and never notices the refusal, which is why `ssh <host>` works on
 * exactly the hosts Switch Console could not reach.
 */
export function isAgentForwardRefusal(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown })?.message === 'string'
        ? (error as { message: string }).message
        : String(error);
  return message.toLowerCase().includes('unable to request agent forwarding');
}

type ClientWithConfig = { config?: { allowAgentFwd?: boolean } };

/**
 * Stop ssh2 requesting agent forwarding on this connection's future channels.
 *
 * `allowAgentFwd` is connection-scoped and decided at connect time, so a
 * refusal cannot be worked around per channel — every subsequent exec would
 * request it again and fail the same way. Clearing it degrades the connection
 * to what OpenSSH gives you against such a host: everything works except
 * forwarding. Returns false when there was no flag to clear.
 */
export function disableAgentForwarding(client: Client): boolean {
  const config = (client as unknown as ClientWithConfig).config;
  if (!config?.allowAgentFwd) return false;
  config.allowAgentFwd = false;
  return true;
}
