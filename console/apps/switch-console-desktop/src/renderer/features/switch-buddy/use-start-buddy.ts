import { useCallback, useEffect, useRef, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import { buddyPerson } from './buddy-person';
import { reportBuddyStep } from './buddy-telemetry';
import { createBuddy } from './create-buddy';
import type { ThisComputer } from './use-this-computer';

/**
 * Starting switch-buddy with a provider: the one way Meet switch-buddy's
 * buttons and the provider card both do it.
 *
 * `starting` is the provider being started, from the click until the buddy
 * exists (or the start fails, when it is null again and `error` says why). A
 * provider chosen while this computer is still getting ready is started once
 * it is, and dropped if setting it up fails.
 */
export function useStartBuddy({
  serverId,
  workspaceId,
  computer,
  entryPoint,
  onCreated,
}: {
  serverId: string;
  workspaceId: string;
  computer: ThisComputer;
  /** Where the person set the buddy up: the first run, or the buddy's chat later. */
  entryPoint: UiEntryPoint;
  onCreated: (agent: { agentId: string; name: string }) => void;
}) {
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waitingToStart, setWaitingToStart] = useState<string | null>(null);

  const start = async (providerId: string) => {
    setStarting(providerId);
    if (computer.kind !== 'ready') {
      setWaitingToStart(providerId);
      return;
    }
    reportBuddyStep('start', providerId);
    setError(null);
    try {
      onCreated(
        await createBuddy({
          serverId,
          workspaceId,
          machineId: computer.machine.id,
          provider: providerId,
          person: buddyPerson(serverId),
          entryPoint,
        })
      );
    } catch (cause) {
      setError(failureText(cause, 'Could not create switch-buddy.'));
      setStarting(null);
    }
  };
  // The effect below starts with the latest closure, which reads the computer as it is now.
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    if (waitingToStart === null) return;
    if (computer.kind === 'failed') {
      setWaitingToStart(null);
      setStarting(null);
      return;
    }
    if (computer.kind !== 'ready') return;
    const providerId = waitingToStart;
    setWaitingToStart(null);
    void startRef.current(providerId);
  }, [computer, waitingToStart]);

  const clearError = useCallback(() => setError(null), []);
  return { starting, error, start: (providerId: string) => void start(providerId), clearError };
}
