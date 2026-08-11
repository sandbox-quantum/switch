/**
 * A host's contents as rows (CHOO-1809).
 *
 * The first cut of this page was a flat checklist of every step, which read as
 * a wall of text and buried the one line that mattered. This is the same
 * language the agents settings page uses — icon tile, name, status pill, click
 * for detail — so a host reads like the rest of the product.
 */

import { GitBranch, Package, Puzzle, RefreshCw, Server, SquareTerminal } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { Button } from '@renderer/lib/ui/button';
import { Label } from '@renderer/lib/ui/label';
import { StatusBadge } from '@renderer/lib/ui/status-badge';
import { cn } from '@renderer/utils/utils';
import { isStepInFlight, type HostSetupStep } from '@shared/core/remote-hosts/setup';
import {
  canInstall,
  canOfferAction,
  canUpdate,
  stepBadge,
  versionSubtitle,
  type AgentTypeRow,
  type BadgeSpec,
} from './step-presentation';

/** Lucide icons for the host tools. Agent types use their own brand icon. */
const PREREQUISITE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  git: GitBranch,
  tmux: SquareTerminal,
  node: Package,
};

export function PrerequisiteIcon({ step, size = 16 }: { step: HostSetupStep; size?: 16 | 24 }) {
  const Icon = PREREQUISITE_ICON[step.id] ?? Server;
  return <Icon className={cn('text-foreground-muted', size === 24 ? 'size-6' : 'size-4')} />;
}

export function SectionLabel({ children, count }: { children: React.ReactNode; count: number }) {
  return (
    <div className="px-3 py-2">
      <Label>
        {children}
        {` (${count})`}
      </Label>
    </div>
  );
}

/**
 * One row. Deliberately the same shape as the agents page's `AgentRow`: a
 * tile, a name, a subtitle, and the status on the right.
 */
function Row({
  icon,
  name,
  subtitle,
  progress,
  badge,
  highlighted,
  action,
  onClick,
}: {
  icon: React.ReactNode;
  name: string;
  subtitle?: string | null;
  /** What the running command last printed. Takes the subtitle's place while it runs. */
  progress?: string | null;
  badge: BadgeSpec;
  highlighted?: boolean;
  /** Inline fix-it control, so acting on one item costs no navigation. */
  action?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <div
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg p-3 hover:bg-background-1',
        highlighted && 'bg-background-1 ring-1 ring-amber-500/40'
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
      >
        <div className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-background-1 p-1.5 group-hover:bg-background-2">
          {icon}
        </div>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-foreground">{name}</span>
          {progress ? (
            <span className="truncate font-mono text-[11px] text-foreground-muted">{progress}</span>
          ) : (
            subtitle && <span className="truncate text-xs text-foreground-muted">{subtitle}</span>
          )}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        {action}
      </div>
    </div>
  );
}

/**
 * Re-observe just this row.
 *
 * Always offered, including on a satisfied row: "is this still installed?" is a
 * fair question about something that was verified at some point in the past,
 * and answering it host-wide costs an SSH round trip per step. Disabled while
 * any host-level operation is in flight, so a whole-host re-check and a single
 * row cannot race for the runner.
 */
function RecheckAction({
  rechecking,
  disabled,
  label,
  onRecheck,
}: {
  rechecking: boolean;
  disabled: boolean;
  label: string;
  onRecheck: () => void;
}) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      disabled={disabled || rechecking}
      aria-label={`Re-check ${label}`}
      title={`Re-check ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        onRecheck();
      }}
    >
      <RefreshCw className={cn('size-3.5', rechecking && 'animate-spin')} />
    </Button>
  );
}

/** The inline Install / Retry control, shown only when there is something to do. */
function InstallAction({
  step,
  installing,
  onInstall,
}: {
  step: HostSetupStep;
  installing: boolean;
  onInstall: () => void;
}) {
  if (!canInstall(step)) return null;
  const busy = installing || isStepInFlight(step);
  return (
    <Button
      size="xs"
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        onInstall();
      }}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : step.state === 'failed' ? (
        'Retry'
      ) : (
        'Install'
      )}
    </Button>
  );
}

/**
 * The inline Update control, shown only when a newer version is known to exist.
 *
 * Separate from Install because the step is already satisfied: this replaces
 * something working, rather than supplying something absent, and the two want
 * different words and different risk.
 */
function UpdateAction({
  step,
  updating,
  onUpdate,
}: {
  step: HostSetupStep;
  updating: boolean;
  onUpdate: () => void;
}) {
  if (!canUpdate(step)) return null;
  const busy = updating || step.state === 'updating';
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={busy}
      title={step.latestVersion ? `Update to ${step.latestVersion}` : 'Update'}
      onClick={(event) => {
        event.stopPropagation();
        onUpdate();
      }}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : 'Update'}
    </Button>
  );
}

export function PrerequisiteRow({
  step,
  isCurrent,
  installing,
  updating,
  rechecking,
  hostBusy,
  activity,
  onInstall,
  onUpdate,
  onRecheck,
  onOpen,
}: {
  step: HostSetupStep;
  isCurrent: boolean;
  installing: boolean;
  /** True while this row's update is the operation in flight. */
  updating: boolean;
  rechecking: boolean;
  /** True while any operation is running on this host. */
  hostBusy: boolean;
  activity: string | null;
  /** True while the sign-in terminal for this step is already open. */
  onInstall: () => void;
  onUpdate: () => void;
  onRecheck: () => void;
  onOpen: () => void;
}) {
  return (
    <Row
      icon={<PrerequisiteIcon step={step} />}
      name={step.name}
      subtitle={versionSubtitle(step)}
      progress={activity}
      badge={stepBadge(step)}
      highlighted={isCurrent}
      action={
        <>
          {canOfferAction(hostBusy, installing || updating) && (
            <>
              <UpdateAction step={step} updating={updating} onUpdate={onUpdate} />
              <InstallAction step={step} installing={installing} onInstall={onInstall} />
            </>
          )}
          {/* Last, so the primary action keeps the same place whether or not
              there is one to take. */}
          <RecheckAction
            rechecking={rechecking || step.state === 'checking'}
            disabled={hostBusy}
            label={step.name}
            onRecheck={onRecheck}
          />
        </>
      }
      onClick={onOpen}
    />
  );
}

/**
 * The three controls a step row offers, in a fixed order.
 *
 * Order is deliberate and shared: Update, Install, then Re-check. The re-check
 * sits last so the primary action keeps the same place whether or not there is
 * one to take.
 */
function StepControls({
  step,
  installing,
  updating,
  rechecking,
  hostBusy,
  label,
  onInstall,
  onUpdate,
  onRecheck,
}: {
  step: HostSetupStep;
  installing: boolean;
  updating: boolean;
  rechecking: boolean;
  hostBusy: boolean;
  label: string;
  onInstall: () => void;
  onUpdate: () => void;
  onRecheck: () => void;
}) {
  return (
    <>
      {canOfferAction(hostBusy, installing || updating) && (
        <>
          <UpdateAction step={step} updating={updating} onUpdate={onUpdate} />
          <InstallAction step={step} installing={installing} onInstall={onInstall} />
        </>
      )}
      <RecheckAction
        rechecking={rechecking || step.state === 'checking'}
        disabled={hostBusy}
        label={label}
        onRecheck={onRecheck}
      />
    </>
  );
}

/**
 * An agent type: its CLI, and its Switch connector indented beneath it.
 *
 * The two were one row with one badge and one button, on the theory that a user
 * thinks of an agent type as a single thing. That hid which half needed work and
 * gave the connector no controls of its own — you could not update it, and its
 * "Switch setup required" state named no action.
 *
 * They are now separate rows, with the connector indented under the CLI to show
 * what it hangs off. That relationship is real, not decorative: the connector is
 * installed *by* the CLI, so with the CLI absent there is nothing to install it
 * with — the sub-row says what it is waiting for instead of offering a button
 * that would fail.
 */
export function AgentTypeRowItem({
  row,
  currentStepId,
  installingStepId,
  updatingStepId,
  recheckingStepId,
  hostBusy,
  activityFor,
  onInstall,
  onUpdate,
  onRecheck,
  onOpen,
}: {
  row: AgentTypeRow;
  /** The step the plan says is in flight — highlights that row, not both. */
  currentStepId: string | null;
  installingStepId: string | null;
  /** The step whose update is in flight, if any. */
  updatingStepId: string | null;
  /** The step being re-checked, if any. */
  recheckingStepId: string | null;
  /** True while any operation is running on this host. */
  hostBusy: boolean;
  /** A row covers two steps, so it asks per step which one is talking. */
  activityFor: (stepId: string) => string | null;
  onInstall: (stepId: string) => void;
  onUpdate: (stepId: string) => void;
  onRecheck: (stepId: string) => void;
  onOpen: () => void;
}) {
  const plugin = row.plugin;
  // The connector is installed through the agent's own CLI. Until that exists,
  // an Install button here is an offer we cannot honour.
  const cliReady = row.cli.state === 'satisfied';
  return (
    <>
      <Row
        icon={<AgentIcon id={row.agentId} size={16} />}
        name={row.name}
        subtitle={versionSubtitle(row.cli)}
        progress={activityFor(row.cli.id)}
        badge={stepBadge(row.cli)}
        highlighted={currentStepId === row.cli.id}
        action={
          <StepControls
            step={row.cli}
            installing={installingStepId === row.cli.id}
            updating={updatingStepId === row.cli.id}
            rechecking={recheckingStepId === row.cli.id}
            hostBusy={hostBusy}
            label={row.name}
            onInstall={() => onInstall(row.cli.id)}
            onUpdate={() => onUpdate(row.cli.id)}
            onRecheck={() => onRecheck(row.cli.id)}
          />
        }
        onClick={onOpen}
      />

      {plugin && (
        // Indented and rule-marked, so the connector reads as belonging to the
        // CLI above rather than as a seventh thing on the host.
        <div className="ml-6 border-l border-border pl-3">
          <Row
            icon={<Puzzle className="size-4 text-foreground-muted" />}
            name="Switch connector"
            subtitle={cliReady ? versionSubtitle(plugin) : `Needs ${row.name} first`}
            progress={activityFor(plugin.id)}
            badge={stepBadge(plugin)}
            highlighted={currentStepId === plugin.id}
            action={
              cliReady ? (
                <StepControls
                  step={plugin}
                  installing={installingStepId === plugin.id}
                  updating={updatingStepId === plugin.id}
                  rechecking={recheckingStepId === plugin.id}
                  hostBusy={hostBusy}
                  label={`the ${row.name} Switch connector`}
                  onInstall={() => onInstall(plugin.id)}
                  onUpdate={() => onUpdate(plugin.id)}
                  onRecheck={() => onRecheck(plugin.id)}
                />
              ) : null
            }
            onClick={onOpen}
          />
        </div>
      )}
    </>
  );
}
