/**
 * One thing on a host, in detail (CHOO-1809).
 *
 * Deliberately the same shape as the agents settings sheet: an identity header,
 * an **Installation** section with the found/not-found card, and — for an agent
 * type — a **Switch setup** section for its connector. Setting up Claude Code
 * on a remote host should not look like a different product from setting it up
 * locally.
 *
 * The row says what state something is in; this says what was actually
 * observed and what you can do about it.
 */

import { Check, ChevronRight, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { Button } from '@renderer/lib/ui/button';
import { Field } from '@renderer/lib/ui/field';
import { Label } from '@renderer/lib/ui/label';
import { Sheet, SheetContent, SheetHeader } from '@renderer/lib/ui/sheet';
import { StatusBadge } from '@renderer/lib/ui/status-badge';
import { cn } from '@renderer/utils/utils';
import { isStepInFlight, type HostSetupStep } from '@shared/core/remote-hosts/setup';
import {
  agentTypeBadge,
  canInstall,
  canOfferAction,
  canSkip,
  outcomeLabel,
  stepBadge,
  type AgentTypeRow,
} from './step-presentation';

/**
 * A failed step's raw command output, collapsed by default. Hidden behind a
 * disclosure rather than dropped: it is usually the only thing that explains
 * *why* an install failed, but it is long enough to bury everything else.
 */
function FailureOutput({ output }: { output: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className="flex w-fit items-center gap-1 text-xs text-foreground-muted hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {open ? 'Hide output' : 'Show output'}
      </button>
      {open && (
        <pre className="bg-background-subtle max-h-64 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">
          {output}
        </pre>
      )}
    </div>
  );
}

/** The tick / spinner / cross tile the agents page uses for install status. */
function OutcomeTile({ step }: { step: HostSetupStep }) {
  if (step.state === 'satisfied') {
    return (
      <div className="flex size-6 items-center justify-center rounded-lg bg-background-success">
        <Check
          className="size-3.5 shrink-0 text-foreground-success"
          absoluteStrokeWidth
          strokeWidth={3}
        />
      </div>
    );
  }
  if (isStepInFlight(step)) {
    return (
      <div className="flex size-6 items-center justify-center rounded-lg bg-background-2">
        <Loader2 className="size-3.5 animate-spin text-foreground-muted" />
      </div>
    );
  }
  return (
    <div className="flex size-6 items-center justify-center rounded-lg bg-background-2">
      <X className="size-3.5 shrink-0 text-foreground-passive" strokeWidth={2.5} />
    </div>
  );
}

/** What a step observed, in the agents page's "Found `v…`" card. */
function ObservationCard({
  step,
  activity,
  actions,
}: {
  step: HostSetupStep;
  /** The running command's latest line, when something is in flight. */
  activity: string | null;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 rounded-lg border p-3">
        <OutcomeTile step={step} />
        <div className="min-w-0 flex-1 truncate text-sm">
          {step.state === 'satisfied' ? (
            <>
              <span>Found</span>
              {step.version && (
                <span className="ml-1 rounded-md bg-background-quaternary-2 px-1 py-0.5 font-mono text-xs text-foreground-muted">
                  {step.version}
                </span>
              )}
              <span className="ml-1">on this host</span>
              {step.updateAvailable && step.latestVersion && (
                <>
                  <span className="ml-1">·</span>
                  <span className="ml-1 text-foreground-warning">
                    {step.latestVersion} available
                  </span>
                </>
              )}
            </>
          ) : step.state === 'checking' ? (
            <span className="text-foreground-muted">Checking…</span>
          ) : step.state === 'installing' ? (
            <span className="text-foreground-muted">Installing…</span>
          ) : step.state === 'updating' ? (
            <span className="text-foreground-muted">Updating…</span>
          ) : (
            <span className="text-foreground-muted">{outcomeLabel(step.outcome)}</span>
          )}
        </div>
        {actions}
      </div>

      {/*
        A remote install can run for minutes. Showing the line the host is
        printing is the difference between "this is working" and "this has hung".
      */}
      {activity && (
        <p className="truncate font-mono text-xs text-foreground-muted" title={activity}>
          {activity}
        </p>
      )}

      {/*
        Not gated on `failed`. An update that fails over something still
        installed leaves the step satisfied — correctly, it works — but the
        attempt did fail, and hiding the reason leaves a row that silently
        refuses to move off "Update available" with nothing to explain why.
      */}
      {step.error && <p className="text-xs text-destructive">{step.error}</p>}
      {step.output && <FailureOutput output={step.output} />}
    </div>
  );
}

function StepActions({
  step,
  onInstall,
  installing,
  hostBusy,
  onSkip,
  skipping,
}: {
  step: HostSetupStep;
  onInstall: () => void;
  installing: boolean;
  /** True while any operation is running on this host. */
  hostBusy: boolean;
  onSkip: () => void;
  skipping: boolean;
}) {
  // The same rule the rows follow: while the host is working, the only honest
  // thing to show is what it is doing. The runner would refuse these anyway.
  if (!canOfferAction(hostBusy, installing)) return null;
  const installable = canInstall(step);
  const busy = installing || isStepInFlight(step);
  if (!installable && !canSkip(step)) return null;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {installable && (
        <Button size="xs" disabled={busy} onClick={onInstall}>
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : step.state === 'failed' ? (
            'Retry'
          ) : (
            'Install'
          )}
        </Button>
      )}
      {canSkip(step) && (
        <Button size="xs" variant="ghost" disabled={busy || skipping} onClick={onSkip}>
          {skipping ? 'Skipping…' : 'Skip'}
        </Button>
      )}
    </div>
  );
}

/** Identity header, mirroring the agents sheet. */
function ItemHeader({
  icon,
  name,
  subtitle,
  badge,
}: {
  icon: React.ReactNode;
  name: string;
  subtitle: string;
  badge: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-background-quaternary-1 p-1.5">
        {icon}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-lg text-foreground">{name}</span>
          {badge}
        </div>
        <span className="text-xs text-foreground-muted">{subtitle}</span>
      </div>
    </div>
  );
}

export type SheetTarget =
  | { kind: 'prerequisite'; step: HostSetupStep }
  | { kind: 'agent-type'; row: AgentTypeRow };

export function SetupDetailSheet({
  target,
  sshHost,
  icon,
  activityFor,
  onClose,
  onInstall,
  installingStepId,
  hostBusy,
  onSkip,
  skippingStepId,
}: {
  target: SheetTarget | null;
  sshHost: string;
  /** Icon for the prerequisite being shown; agent types use their own. */
  icon: React.ReactNode;
  /** The running command's latest line for a step, if it is running. */
  activityFor: (stepId: string) => string | null;
  onClose: () => void;
  onInstall: (stepId: string) => void;
  installingStepId: string | null;
  /** True while any operation is running on this host. */
  hostBusy: boolean;
  onSkip: (stepId: string) => void;
  skippingStepId: string | null;
}) {
  return (
    <Sheet open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex flex-col gap-0 p-0">
        {target && (
          <>
            <SheetHeader label={target.kind === 'agent-type' ? 'Agent type' : 'Prerequisite'} />
            <div className="space-y-6 overflow-y-auto px-4 pb-6">
              {target.kind === 'prerequisite' ? (
                <>
                  <ItemHeader
                    icon={icon}
                    name={target.step.name}
                    subtitle={`On ${sshHost}`}
                    badge={
                      <StatusBadge tone={stepBadge(target.step).tone}>
                        {stepBadge(target.step).label}
                      </StatusBadge>
                    }
                  />
                  <Field>
                    <Label>Installation</Label>
                    <ObservationCard
                      step={target.step}
                      activity={activityFor(target.step.id)}
                      actions={
                        <StepActions
                          step={target.step}
                          onInstall={() => onInstall(target.step.id)}
                          installing={installingStepId === target.step.id}
                          hostBusy={hostBusy}
                          onSkip={() => onSkip(target.step.id)}
                          skipping={skippingStepId === target.step.id}
                        />
                      }
                    />
                  </Field>
                </>
              ) : (
                <AgentTypeDetail
                  row={target.row}
                  sshHost={sshHost}
                  activityFor={activityFor}
                  onInstall={onInstall}
                  installingStepId={installingStepId}
                  hostBusy={hostBusy}
                  onSkip={onSkip}
                  skippingStepId={skippingStepId}
                />
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function AgentTypeDetail({
  row,
  sshHost,
  activityFor,
  onInstall,
  installingStepId,
  hostBusy,
  onSkip,
  skippingStepId,
}: {
  row: AgentTypeRow;
  sshHost: string;
  activityFor: (stepId: string) => string | null;
  onInstall: (stepId: string) => void;
  installingStepId: string | null;
  /** True while any operation is running on this host. */
  hostBusy: boolean;
  onSkip: (stepId: string) => void;
  skippingStepId: string | null;
}) {
  const badge = agentTypeBadge(row);
  return (
    <>
      <ItemHeader
        icon={<AgentIcon id={row.agentId} size={24} />}
        name={row.name}
        subtitle={`On ${sshHost}`}
        badge={<StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
      />

      <Field>
        <Label>Installation</Label>
        <ObservationCard
          step={row.cli}
          activity={activityFor(row.cli.id)}
          actions={
            <StepActions
              step={row.cli}
              onInstall={() => onInstall(row.cli.id)}
              installing={installingStepId === row.cli.id}
              hostBusy={hostBusy}
              onSkip={() => onSkip(row.cli.id)}
              skipping={skippingStepId === row.cli.id}
            />
          }
        />
      </Field>

      {row.plugin && (
        <Field>
          <Label>Switch setup</Label>
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-sm text-foreground">switch-connector</span>
                <StatusBadge tone={stepBadge(row.plugin).tone}>
                  {stepBadge(row.plugin).label}
                </StatusBadge>
                {row.plugin.version && (
                  <span className="text-xs text-foreground-muted">v{row.plugin.version}</span>
                )}
              </div>
              <StepActions
                step={row.plugin}
                onInstall={() => onInstall(row.plugin!.id)}
                installing={installingStepId === row.plugin.id}
                hostBusy={hostBusy}
                onSkip={() => onSkip(row.plugin!.id)}
                skipping={skippingStepId === row.plugin.id}
              />
            </div>
            {row.plugin.state === 'failed' && row.plugin.error && (
              <p className="text-xs text-destructive">{row.plugin.error}</p>
            )}
            {row.plugin.state === 'failed' && row.plugin.output && (
              <FailureOutput output={row.plugin.output} />
            )}
            <p className="text-xs text-foreground-muted">
              Connects this agent to a Switch instance. Without it the agent starts on this host
              with no Switch tools.
            </p>
          </div>
        </Field>
      )}
    </>
  );
}
