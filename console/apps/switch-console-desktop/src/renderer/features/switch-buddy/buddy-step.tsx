import { useEffect, useRef, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { OnboardingSurface, useWizardExit } from '@renderer/lib/ui/wizard-frame';
import { buddyOffered } from './buddy-identity';
import { MeetBuddyPage } from './meet-buddy-page';

/**
 * The first run's last step: meeting switch-buddy, on a server that offers it.
 *
 * The buddy is made from a template the server ships, behind its
 * `switch_buddy` flag (and agent management, which the buddy runs as). A
 * server that does not turn them on — an older one among them — is not asked
 * for a buddy it cannot make: the flow ends on the server as it did before.
 * The flags are read afresh here, after sign-in, rather than trusted from a
 * read made before there was an account.
 */
export function BuddyStep({
  serverId,
  workspaceId,
  onCreated,
  onSkip,
  onSetupOpened,
  onNotOffered,
}: {
  serverId: string;
  workspaceId: string;
  onCreated: (agent: { agentId: string; name: string }) => void;
  onSkip: () => void;
  /** The person chose to set up a provider other than those already signed in, for the flow to count. */
  onSetupOpened: () => void;
  onNotOffered: () => void;
}) {
  const exit = useWizardExit();
  const [offered, setOffered] = useState<boolean | { error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setOffered(null);
    void (async () => {
      try {
        await rpc.featureFlags.refresh();
        const { data } = await rpc.featureFlags.get(serverId);
        // Flags that could not be read are not an answer: off would skip the buddy on a guess.
        if (data.error !== null) throw new Error(data.error);
        if (live) setOffered(buddyOffered(data.flags));
      } catch (cause) {
        if (live)
          setOffered({ error: failureText(cause, 'Could not ask the server what it offers.') });
      }
    })();
    return () => {
      live = false;
    };
  }, [serverId, attempt]);

  // Once: leaving the flow unmounts this page.
  const left = useRef(false);
  useEffect(() => {
    if (offered !== false || left.current) return;
    left.current = true;
    onNotOffered();
  }, [offered, onNotOffered]);

  if (offered !== true)
    return (
      <OnboardingSurface
        exit={exit}
        footer={
          typeof offered === 'object' && offered !== null ? (
            <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
          ) : null
        }
      >
        {typeof offered === 'object' && offered !== null ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {offered.error}
          </p>
        ) : (
          <p className="flex items-center justify-center gap-2 text-sm text-foreground-muted">
            <Spinner className="size-3.5" />
            Getting your workspace ready…
          </p>
        )}
      </OnboardingSurface>
    );
  return (
    <MeetBuddyPage
      serverId={serverId}
      workspaceId={workspaceId}
      onCreated={onCreated}
      onSkip={onSkip}
      onSetupOpened={onSetupOpened}
    />
  );
}
