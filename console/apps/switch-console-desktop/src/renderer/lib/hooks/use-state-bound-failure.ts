import { useCallback, useEffect, useState } from 'react';

export type StateBoundFailure = { error: Error; stateKey: string | null };

/** The failure still shown once the state reads `stateKey`: kept while the state it failed in lasts. */
export function keepFailure(
  current: StateBoundFailure | null,
  stateKey: string | null
): StateBoundFailure | null {
  return current && current.stateKey !== stateKey ? null : current;
}

/**
 * A failed action's error, shown for as long as the state it failed in lasts.
 * `fail` records it with the state read once the failure settled; as soon as
 * `stateKey` moves on (the cause was fixed, or something else happened) it is
 * dropped, so a refusal never outlives what it was about.
 *
 * Checked only when `stateKey` changes, so a render that still shows the data
 * from before the failure's own refresh does not drop it.
 */
export function useStateBoundFailure(stateKey: string | null) {
  const [bound, setBound] = useState<StateBoundFailure | null>(null);
  useEffect(() => {
    setBound((current) => keepFailure(current, stateKey));
  }, [stateKey]);
  const fail = useCallback(
    (error: Error, failedIn: string | null) => setBound({ error, stateKey: failedIn }),
    []
  );
  const clear = useCallback(() => setBound(null), []);
  return { failure: bound?.error ?? null, fail, clear };
}
