/**
 * A single remote host's page (CHOO-1809).
 *
 * A host is not a settings row — it has an ongoing lifecycle: reach it, work
 * out what it needs, install those things one at a time, and later manage the
 * agent types running on it. It gets its own route so that lifecycle has
 * somewhere to live and somewhere to grow.
 *
 * Presented as a catalogue of what is on the host rather than a checklist of
 * steps: prerequisites and agent types, each a row with its status, each
 * opening a sheet with the detail and the actions. The same language the
 * agents settings page uses, so a host reads like the rest of the product.
 *
 * The page does no probing of its own on open. Reachability comes from the
 * central model (CHOO-1682/1780) and the setup plan is pushed from the main
 * process, so opening this page costs nothing and cannot disagree with the
 * rest of the app.
 */

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { PageHeader } from '@renderer/lib/components/page-header';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { StatusBadge } from '@renderer/lib/ui/status-badge';
import { deriveHostStatus } from '@shared/core/remote-hosts/host-status';
import { isHostBlocked } from '@shared/core/remote-hosts/reachability';
import { GhAuthPanel } from '../gh-auth-panel';
import { hostReachabilityStore } from '../host-reachability-store';
import { hostSetupStore } from '../host-setup-store';
import { HostUnreachablePanel } from '../host-unreachable-panel';
import { SetupDetailSheet, type SheetTarget } from '../setup/setup-detail-sheet';
import {
  AgentTypeRowItem,
  PrerequisiteIcon,
  PrerequisiteRow,
  SectionLabel,
} from '../setup/setup-rows';
import { groupPlanSteps } from '../setup/step-presentation';
import {
  useHostSetupPlan,
  useInstallSetupStep,
  usePrepareSetup,
  useRecheckSetup,
  useRecheckSetupStep,
  useSkipSetupStep,
  useUpdateSetupStep,
} from '../setup/use-host-setup';
import { REMOTE_HOSTS_QUERY_KEY } from './remote-hosts-view';

function useSshHost(): string {
  return useParams('remoteHost').params.sshHost;
}

export const RemoteHostMainPanel = observer(function RemoteHostMainPanel() {
  const sshHost = useSshHost();
  const { navigate } = useNavigate();

  const hosts = useQuery({
    queryKey: REMOTE_HOSTS_QUERY_KEY,
    queryFn: () => rpc.remoteHosts.listHosts(),
  });
  const host = hosts.data?.find((candidate) => candidate.sshHost === sshHost);

  const plan = useHostSetupPlan(sshHost);
  const prepare = usePrepareSetup(sshHost);
  const recheck = useRecheckSetup(sshHost);
  const skip = useSkipSetupStep(sshHost);
  const installStep = useInstallSetupStep(sshHost);
  const recheckStep = useRecheckSetupStep(sshHost);
  const updateStep = useUpdateSetupStep(sshHost);

  const [authenticatingGh, setAuthenticatingGh] = useState(false);
  const [sheetTarget, setSheetTarget] = useState<SheetTarget | null>(null);
  const reachability = hostReachabilityStore.get(sshHost);
  const blocked = isHostBlocked(reachability);

  useEffect(() => {
    void hostReachabilityStore.hydrate();
  }, []);

  // Rebuild the plan whenever the page opens, not only when none exists.
  //
  // Which steps a plan *has* comes from the local plugin registry and costs no
  // SSH at all; only their states come from the host, and those are merged
  // forward. Building only when the plan was absent meant a host onboarded
  // before an agent type shipped never grew a row for it — Codex was simply
  // missing from that host's page for good, while appearing on hosts added
  // later. Rebuilding is free, so there is no reason to skip it.
  //
  // Still gated on reachability: probing a host the model already knows is down
  // would only mislabel every prerequisite as missing.
  const { mutate: startPrepare } = prepare;
  useEffect(() => {
    if (blocked || plan.isLoading) return;
    startPrepare();
  }, [blocked, plan.isLoading, startPrepare]);

  const status = deriveHostStatus(reachability, plan.data ?? null);
  const { prerequisites, agentTypes } = useMemo(
    () => groupPlanSteps(plan.data ?? null),
    [plan.data]
  );
  const busy =
    prepare.isPending ||
    recheck.isPending ||
    installStep.isPending ||
    recheckStep.isPending ||
    updateStep.isPending;
  const installingStepId = installStep.isPending ? (installStep.variables ?? null) : null;
  const updatingStepId = updateStep.isPending ? (updateStep.variables ?? null) : null;
  const recheckingStepId = recheckStep.isPending ? (recheckStep.variables ?? null) : null;
  const currentStepId = plan.data?.currentStepId ?? null;

  // Read inside render so mobx tracks it: the line changes several times a
  // second while an install runs, and nothing else re-renders on that.
  const activityFor = (stepId: string) => hostSetupStore.activityFor(sshHost, stepId);

  // Keep an open sheet in step with pushed plan updates, so a row's detail
  // advances while a run is in flight instead of freezing at the state it had
  // when it was opened.
  const liveTarget = useMemo((): SheetTarget | null => {
    if (!sheetTarget) return null;
    if (sheetTarget.kind === 'prerequisite') {
      const step = prerequisites.find((s) => s.id === sheetTarget.step.id);
      return step ? { kind: 'prerequisite', step } : null;
    }
    const row = agentTypes.find((r) => r.agentId === sheetTarget.row.agentId);
    return row ? { kind: 'agent-type', row } : null;
  }, [sheetTarget, prerequisites, agentTypes]);

  // The workspace gives every main panel a fixed, `overflow-hidden` box, so a
  // view that does not scroll itself simply clips. This page grows without
  // bound — the gh device-flow terminal alone is tall enough to push the agent
  // types past the bottom of the window with no way to reach them.
  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="space-y-6 px-8 pb-10">
        <PageHeader
          sticky
          title={host?.name ?? sshHost}
          description={`Remote host · ${sshHost}. Auth uses your SSH agent — Switch Console stores no credentials.`}
          back={
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2"
              onClick={() => navigate('remoteHosts')}
            >
              <ArrowLeft className="size-4" /> All hosts
            </Button>
          }
        >
          <div className="flex items-center gap-2">
            {!blocked && (
              <span className="flex items-center gap-2">
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                {status.readinessKnown && status.total > 0 && (
                  <span className="text-xs text-foreground-muted">
                    {status.done} of {status.total} prerequisites
                  </span>
                )}
              </span>
            )}
            {!blocked && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => recheck.mutate()}
                aria-label="Re-check this host"
              >
                <RefreshCw className={`size-3.5 ${recheck.isPending ? 'animate-spin' : ''}`} />
                Re-check
              </Button>
            )}
          </div>
        </PageHeader>

        {blocked ? (
          <HostUnreachablePanel reachability={reachability} />
        ) : (
          <>
            {/*
            An operation that stops because the host went away is reported as
            exactly that, rather than being blamed on whichever step it touched.
          */}
            {installStep.isError && (
              <p className="text-destructive text-xs">
                Could not install: {(installStep.error as Error).message}
              </p>
            )}
            {updateStep.isError && (
              <p className="text-destructive text-xs">
                Could not update: {(updateStep.error as Error).message}
              </p>
            )}
            {recheck.isError && (
              <p className="text-destructive text-xs">
                Could not check this host: {(recheck.error as Error).message}
              </p>
            )}
            {prepare.isError && (
              <p className="text-destructive text-xs">
                Could not work out what this host needs: {(prepare.error as Error).message}
              </p>
            )}

            {plan.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-foreground-muted">
                <Spinner /> Loading…
              </div>
            ) : prerequisites.length === 0 && agentTypes.length === 0 ? (
              <p className="text-sm text-foreground-muted">
                Nothing known about this host yet. Re-check to see what it has.
              </p>
            ) : (
              <div className="flex flex-col">
                {prerequisites.length > 0 && (
                  <section>
                    <SectionLabel count={prerequisites.length}>Prerequisites</SectionLabel>
                    {prerequisites.map((step) => (
                      <div key={step.id} className="w-full py-0.5">
                        <PrerequisiteRow
                          step={step}
                          plan={plan.data ?? null}
                          isCurrent={step.id === currentStepId}
                          installing={installingStepId === step.id}
                          updating={updatingStepId === step.id}
                          rechecking={recheckingStepId === step.id}
                          hostBusy={busy}
                          activity={activityFor(step.id)}
                          authenticating={authenticatingGh && step.kind === 'gh-auth'}
                          onInstall={() => installStep.mutate(step.id)}
                          onUpdate={() => updateStep.mutate(step.id)}
                          onRecheck={() => recheckStep.mutate(step.id)}
                          onAuthenticate={() => setAuthenticatingGh(true)}
                          onOpen={() => setSheetTarget({ kind: 'prerequisite', step })}
                        />
                        {/*
                        Opens against the row it belongs to rather than at the
                        foot of the page: the terminal is the continuation of
                        that one row's Sign in, and appending it below
                        everything else meant scrolling away from the thing you
                        just clicked to find it.
                      */}
                        {authenticatingGh && step.kind === 'gh-auth' && (
                          <div className="px-3 pt-2 pb-1">
                            <GhAuthPanel
                              sshHost={sshHost}
                              onDone={() => {
                                setAuthenticatingGh(false);
                                recheck.mutate();
                              }}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </section>
                )}

                {agentTypes.length > 0 && (
                  <section className="pt-2">
                    <SectionLabel count={agentTypes.length}>Agent types</SectionLabel>
                    {agentTypes.map((row) => (
                      <div key={row.agentId} className="w-full py-0.5">
                        <AgentTypeRowItem
                          row={row}
                          currentStepId={currentStepId}
                          installingStepId={installingStepId}
                          updatingStepId={updatingStepId}
                          recheckingStepId={recheckingStepId}
                          hostBusy={busy}
                          activityFor={activityFor}
                          onInstall={(stepId) => installStep.mutate(stepId)}
                          onUpdate={(stepId) => updateStep.mutate(stepId)}
                          onRecheck={(stepId) => recheckStep.mutate(stepId)}
                          onOpen={() => setSheetTarget({ kind: 'agent-type', row })}
                        />
                      </div>
                    ))}
                  </section>
                )}
              </div>
            )}

            <SetupDetailSheet
              target={liveTarget}
              sshHost={sshHost}
              plan={plan.data ?? null}
              icon={
                liveTarget?.kind === 'prerequisite' ? (
                  <PrerequisiteIcon step={liveTarget.step} size={24} />
                ) : null
              }
              activityFor={activityFor}
              onClose={() => setSheetTarget(null)}
              onInstall={(stepId) => installStep.mutate(stepId)}
              installingStepId={installingStepId}
              hostBusy={busy}
              onSkip={(stepId) => skip.mutate(stepId)}
              skippingStepId={skip.isPending ? (skip.variables ?? null) : null}
              onAuthenticate={() => {
                setSheetTarget(null);
                setAuthenticatingGh(true);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
});

export const remoteHostView = {
  WrapView: ({ children }: { children: React.ReactNode; sshHost: string }) => <>{children}</>,
  // No titlebar slot: the page header already names the host and repeats the
  // alias underneath it, so a third copy in the title bar was only noise.
  MainPanel: RemoteHostMainPanel,
  canActivate: (params: unknown): GuardResult => {
    // Params can come from a snapshot written by an older build, so validate
    // rather than trust: a view with no host to show has nothing to render.
    const sshHost =
      typeof params === 'object' && params !== null
        ? (params as { sshHost?: unknown }).sshHost
        : undefined;
    if (typeof sshHost !== 'string' || sshHost.length === 0) {
      return { ok: false, redirect: 'remoteHosts' };
    }
    return { ok: true };
  },
} satisfies ViewDefinition<{ sshHost: string }>;
