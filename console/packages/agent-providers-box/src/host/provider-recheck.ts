/**
 * Switch Console asking the agent controller it runs on this computer to
 * check every provider again now, over the controller's IPC channel.
 *
 * The controller otherwise checks each provider at most every ten minutes, so
 * a CLI the user has just installed or signed in to would read as missing for
 * that long. On a request it reads the login shell's PATH again, checks every
 * provider, sends Switch a status report, and answers with the same `id` once
 * that report is out, so what Console then reads from Switch is the fresh one.
 */
export const PROVIDER_RECHECK_KIND = 'switch-provider-recheck';
export const PROVIDER_RECHECKED_KIND = 'switch-provider-rechecked';

export type ProviderRecheckRequest = { kind: typeof PROVIDER_RECHECK_KIND; id: string };

/** The answer: `error` says why the check could not be run or reported. */
export type ProviderRecheckReply = {
  kind: typeof PROVIDER_RECHECKED_KIND;
  id: string;
  error: string | null;
};

export function isProviderRecheckRequest(raw: unknown): raw is ProviderRecheckRequest {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === PROVIDER_RECHECK_KIND &&
    typeof (raw as { id?: unknown }).id === 'string'
  );
}

export function isProviderRecheckReply(raw: unknown): raw is ProviderRecheckReply {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === PROVIDER_RECHECKED_KIND &&
    typeof (raw as { id?: unknown }).id === 'string'
  );
}
