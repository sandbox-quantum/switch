import { useCallback, useEffect, useRef, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import { buddyPerson } from './buddy-person';
import { reportBuddyStep } from './buddy-telemetry';
import { createBuddy } from './create-buddy';
import { addFailedLine } from './this-computer-ask';
import type { ThisComputer } from './use-this-computer';

/**
 * Starting switch-buddy with a provider: the one way Meet switch-buddy's
 * buttons and the provider card both do it.
 *
 * `starting` is the provider being started, from the click until the buddy
 * exists (or the start fails, when it is null again and `error` says why). A
 * provider chosen while this computer is still getting ready is started once
 * it is, and dropped if setting it up fails.
 *
 * On a computer not yet a machine of the workspace (B38), a Start is the
 * person's yes: `allow` adds it (`adding` while it does), and the buddy is
 * started once it reports. If adding fails, `error` says why and nothing starts.
 */
export function useStartBuddy({
  serverId,
  workspaceId,
  computer,
  allow,
  entryPoint,
  onCreated,
}: {
  serverId: string;
  workspaceId: string;
  computer: ThisComputer;
  /** Adds this computer to the workspace, when it is still to be asked (B38). */
  allow?: () => Promise<void>;
  /** Where the person set the buddy up: the first run, or the buddy's chat later. */
  entryPoint: UiEntryPoint;
  onCreated: (agent: { agentId: string; name: string }) => void;
}) {
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waitingToStart, setWaitingToStart] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const start = async (providerId: string) => {
    setStarting(providerId);
    if (computer.kind === 'needs-permission' && allow) {
      // The person's yes: add this computer, then start once it reports.
      setError(null);
      setAdding(true);
      try {
        await allow();
      } catch (cause) {
        setError(addFailedLine(failureText(cause, 'It could not be set up to run agents.')));
        setStarting(null);
        return;
      } finally {
        setAdding(false);
      }
      setWaitingToStart(providerId);
      return;
    }
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
  return {
    starting,
    error,
    start: (providerId: string) => void start(providerId),
    clearError,
    adding,
  };
}
