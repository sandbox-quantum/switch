/**
 * The readiness gate on creating an agent (CHOO-1809).
 *
 * A host missing what an agent needs used to change nothing outside its own
 * page: you could create an agent on a host with no git and find out when the
 * session failed. This refuses, names what is missing, and offers one click to
 * the place that fixes it.
 *
 * The rule that matters is what happens when we *do not know*. A host nobody
 * has checked is not blocked — it is checked, now, and then judged. Refusing on
 * ignorance is the same mistake as the false green, only inverted, and it would
 * contradict how `unknown` reachability already behaves everywhere else.
 */

import { CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { log } from '@renderer/utils/logger';
import { deriveAgentTypeStatus } from '@shared/core/remote-hosts/host-status';
import { queueHostProbe } from './host-probe-queue';
import { hostReachabilityStore } from './host-reachability-store';
import { resolveReadiness, stepsNeedingObservation, type HostReadiness } from './host-readiness';
import { hostSetupStore } from './host-setup-store';

export { resolveReadiness, type HostReadiness };

/**
 * Readiness for the host an agent is about to be created on, probing once if
 * nothing has ever been observed.
 *
 * Reachability is deliberately not treated as "blocked" here — the modal
 * already gates on it separately and says something more useful about it.
 */
export function useRemoteHostReadiness(
  sshHost: string | null,
  /** The agent type being created, so the gate judges that type and not all of them. */
  agentId: string | null
): HostReadiness {
  const [checking, setChecking] = useState(false);
  // One probe per host+type per mount. Keyed on the host and type ALONE: an
  // earlier version folded the stale-step list into this key, and since every
  // completed step pushes a new plan — shortening that list — the key changed
  // mid-pass and started a second run over the first. The runner refused it, and
  // the log filled with "another setup operation is already running" for steps
  // nobody had asked about.
  const probed = useRef(new Set<string>());

  useEffect(() => {
    void hostSetupStore.hydrate();
  }, []);

  const reachability = sshHost ? hostReachabilityStore.get(sshHost) : null;
  const plan = hostSetupStore.get(sshHost);
  const status =
    sshHost && reachability ? deriveAgentTypeStatus(reachability, plan, agentId) : null;

  // The persisted plan answers this most of the time. Only what is missing or
  // gone stale is re-observed, and only for this agent type.
  const stale = sshHost ? stepsNeedingObservation(plan, agentId, Date.now()) : [];
  // Held in a ref so the effect can read the current list without depending on
  // it — the list is derived from a plan that changes while the probe runs.
  const staleRef = useRef(stale);
  staleRef.current = stale;

  // No plan at all is a different job: there is nothing to refresh, the host
  // has to be surveyed from scratch.
  const needsSurvey = !!sshHost && !plan;
  const needsProbe = needsSurvey || stale.length > 0;
  const probeKey = `${sshHost}:${agentId ?? '*'}`;

  useEffect(() => {
    if (!sshHost || !needsProbe || probed.current.has(probeKey)) return;
    probed.current.add(probeKey);
    setChecking(true);
    const steps = staleRef.current;
    queueHostProbe(sshHost, async () => {
      if (needsSurvey) {
        await rpc.remoteHosts.recheckSetup(sshHost);
        return;
      }
      // Sequentially, and behind the queue: the runner takes one operation per
      // host, so overlapping requests only make the later ones fail.
      for (const stepId of steps) {
        await rpc.remoteHosts.recheckSetupStep({ sshHost, stepId });
      }
    })
      .catch((error: unknown) => {
        // A probe we could not run tells us nothing. Leaving the gate open is
        // the honest outcome — the alternative blocks the user over our own
        // failure to look.
        log.warn('Could not check host readiness before creating an agent', { sshHost, error });
      })
      .finally(() => setChecking(false));
  }, [sshHost, probeKey, needsProbe, needsSurvey]);

  return resolveReadiness(status, plan, agentId, checking || needsProbe);
}

/** Explains a blocked host, and sends the user to the page that fixes it. */
export const HostReadinessNotice = observer(function HostReadinessNotice({
  sshHost,
  readiness,
  onNavigateAway,
}: {
  sshHost: string;
  readiness: HostReadiness;
  /** Called before navigating, so a host modal can close itself first. */
  onNavigateAway?: () => void;
}) {
  const { navigate } = useNavigate();

  if (readiness.checking) {
    return (
      <div className="flex items-center gap-2 text-xs text-foreground-muted">
        <Spinner /> Checking what {sshHost} has installed…
      </div>
    );
  }

  if (!readiness.blocked) return null;

  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <span>
          <span className="font-medium">{sshHost}</span>{' '}
          {/*
            Two different messages, because "we looked and X is missing" and "we
            never looked" are different facts. Reading the second as the first
            invented a missing dependency; reading it as ready is what let an
            agent be created for a type nobody had checked for.
          */}
          {readiness.missing.length > 0 ? (
            <>
              {readiness.scope === 'agent-type'
                ? 'is ready, but is not set up for this agent type'
                : 'is not set up to run agents'}
              {`: ${readiness.missing.join(', ')} `}
              {readiness.missing.length === 1 ? 'is missing.' : 'are missing.'} An agent created
              here would fail to start.
            </>
          ) : readiness.scope === 'agent-type' ? (
            <>
              has never been checked for this agent type, so there is no telling whether it can run
              one. Check the host, then try again.
            </>
          ) : (
            <>
              has never been checked, so there is no telling whether it can run agents. Check the
              host, then try again.
            </>
          )}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={() => {
            onNavigateAway?.();
            navigate('remoteHost', { sshHost });
          }}
        >
          Set up {sshHost}
        </Button>
      </div>
    </div>
  );
});
