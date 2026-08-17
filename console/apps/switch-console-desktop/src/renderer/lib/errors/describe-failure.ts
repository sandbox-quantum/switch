import type { HostReachability } from '@shared/core/remote-hosts/reachability';
import { RpcError } from '@shared/lib/ipc/rpc-error';

/**
 * Splitting a failure into the sentence a user reads and the detail they may
 * need to hand to someone else.
 *
 * The pattern this replaces is
 * `toast({ title: 'Failed to X', description: String(error) })` — the right
 * shape filled in backwards, with a stub where the explanation belongs and a
 * raw exception where the explanation was expected. `headline` is what the
 * screen leads with; `detail` is the diagnostic, kept but demoted to the
 * toast's description or an expandable block.
 *
 * Detail is never dropped. A failure the app cannot describe keeps its raw
 * message under a caller-supplied headline, which is strictly more than the
 * raw message alone told anyone.
 */
export type FailureDescription = {
  /** Plain sentence. Never raw exception text. */
  headline: string;
  /** Diagnostic text, or null when the headline already says everything. */
  detail: string | null;
};

/** Reads as a finished sentence rather than a fragment or a stack-ish blob. */
function isSentence(text: string): boolean {
  if (text.length < 12 || text.length > 300) return false;
  if (text.includes('\n')) return false;
  // `TypeError: fetch failed`, `Error: ENOENT ...` — a leading exception class.
  if (/^[A-Z]\w*(Error|Exception):/.test(text)) return false;
  return /^[A-Z]/.test(text) && /[.!?]$/.test(text);
}

function describeGatewayFailure(error: RpcError, fallback: string): FailureDescription {
  const detail = error.stringField('detail') ?? error.message;
  const status = error.numberField('status');

  switch (error.stringField('kind')) {
    case 'unauthorized':
      // Matches the wording already used at the five places that handle a 401
      // inline, so the same failure reads the same way wherever it surfaces.
      return {
        headline: 'Your session for this server expired. Sign in again, then retry.',
        detail: null,
      };
    case 'network':
      return {
        headline:
          'Could not reach the server. Check that it is running and that you are on its network.',
        detail,
      };
    default:
      // The gateway's own `detail` is written for a person when it is present;
      // `message` is the status line and is not.
      return isSentence(detail)
        ? { headline: detail, detail: status ? `HTTP ${status}` : null }
        : { headline: fallback, detail: status ? `HTTP ${status}: ${detail}` : detail };
  }
}

function describeHostUnreachable(error: RpcError, fallback: string): FailureDescription {
  const reachability = error.data.reachability as HostReachability | undefined;
  if (!reachability) return { headline: fallback, detail: error.message };

  const host = reachability.sshHost;
  // `suspended` is an authentication failure, and the reconnect loop does not
  // run in that state — telling the user to wait for it would be telling them
  // to wait for something that is not going to happen.
  const headline =
    reachability.status === 'suspended'
      ? `Switch Console could not authenticate to ${host}. It will not keep retrying on its own — fix the host's SSH credentials, then retry.`
      : `Switch Console cannot reach ${host} at the moment. It keeps probing in the background, so this clears on its own once the host answers.`;

  return { headline, detail: reachability.lastError };
}

/**
 * @param fallback The sentence to lead with when the failure is not one the app
 *   recognises. Write it for the action the user just took ("Could not save the
 *   agent's settings."), not for the layer that failed.
 */
export function describeFailure(error: unknown, fallback: string): FailureDescription {
  if (error instanceof RpcError) {
    switch (error.code) {
      case 'GatewayError':
        return describeGatewayFailure(error, fallback);
      case 'HostUnreachableError':
        return describeHostUnreachable(error, fallback);
      case 'ManagedServerStoppedError':
        // Already a modeled, actionable sentence naming the server and the page
        // to fix it on.
        return { headline: error.message, detail: null };
    }
  }

  const raw = (error instanceof Error ? error.message : String(error)).trim();
  if (!raw) return { headline: fallback, detail: null };
  return { headline: fallback, detail: raw };
}

/** One string, for the surfaces that have nowhere to put the detail separately. */
export function failureText(error: unknown, fallback: string): string {
  const { headline, detail } = describeFailure(error, fallback);
  return detail ? `${headline} (${detail})` : headline;
}
