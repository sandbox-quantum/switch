import { CircleAlert } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useAgentTypeAvailability } from '@renderer/lib/stores/use-switch-setup';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { autoSelectedAgentType } from './agent-type-auto-selection';

/**
 * Picks the agent type for a new Switch agent. Only agent types that are both
 * Switch-supported and have their connector plugin installed (i.e. actually
 * usable) are offered; if none qualify, the user is pointed at the per-agent
 * Switch setup.
 *
 * Everything past this picker is gated on a chosen type — the directory scan,
 * the onboard-existing list and every submit button — so leaving it unset
 * strands the rest of the form behind a control the user may not read as
 * required. `autoSelectedAgentType` decides when the pick can be made for them.
 */
export function AgentTypePicker({
  value,
  onChange,
  sshHost,
  onNavigateAway,
}: {
  value: AgentProviderId | null;
  onChange: (providerId: AgentProviderId) => void;
  sshHost?: string;
  /** Called before leaving for the page that installs providers, so the modal
   * can close itself rather than being navigated out from under. */
  onNavigateAway: () => void;
}) {
  const { navigate } = useNavigate();
  const { data: availability, isPending } = useAgentTypeAvailability(sshHost);
  const { data: agents } = useAgents();
  const { value: defaultAgent } = useAppSettingsKey('defaultAgent');

  // Every known type, each with the agent registry's name and icon plus the
  // verdict from the machine being targeted. Types the registry does not know
  // are dropped — there is nothing to render them with.
  const options = useMemo(() => {
    const byId = new Map((agents ?? []).map((a) => [a.id, a]));
    return (availability ?? []).flatMap((entry) => {
      const agent = byId.get(entry.agentId);
      return agent ? [{ agent, ...entry }] : [];
    });
  }, [availability, agents]);
  const selectable = useMemo(() => options.filter((o) => o.available), [options]);

  useEffect(() => {
    if (value) return;
    // Only ever auto-select something that can actually be used. Picking a
    // greyed-out type on the user's behalf would put them straight into the
    // refusal the greying exists to prevent.
    const picked = autoSelectedAgentType(
      selectable.map((o) => o.agent.id as AgentProviderId),
      defaultAgent
    );
    if (picked) onChange(picked);
  }, [value, selectable, onChange, defaultAgent]);

  // Nothing usable is a real dead end and still needs saying — but the list
  // below now shows *which* types exist and what each is missing, so this is
  // the pointer to where they get fixed rather than the only signal.
  const nothingUsable = !isPending && selectable.length === 0;
  const emptyNotice = nothingUsable ? (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      {/* Name the host: "no agent type is set up" reads as a global problem,
            but availability is per-host — the connector may well be installed
            locally and simply missing on the machine being targeted. */}
      <span>
        {sshHost ? (
          <>
            No agent type is set up for Switch on <span className="font-medium">{sshHost}</span>.
            Install an agent&apos;s Switch connector on that host in Settings &rarr; Remote hosts
            before onboarding it there.
          </>
        ) : (
          <>
            No agent type is set up for Switch on this computer. Install an agent&apos;s Switch
            connector in Settings &rarr; Agent providers before onboarding it.
          </>
        )}
      </span>
    </div>
  ) : null;

  // Asking the host what it has costs SSH round trips, and an empty dropdown
  // during that reads as "this host offers nothing" rather than "still asking".
  // The placeholder tiles say the answer is a set of these, so the section does
  // not resize under the user when it arrives.
  if (isPending) {
    return (
      <Field>
        <FieldLabel>Agent provider</FieldLabel>
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner />
          {sshHost ? `Checking what ${sshHost} has installed…` : 'Checking what is installed…'}
        </div>
        <div aria-hidden className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[86px] animate-pulse rounded-[11px] bg-[var(--fill)]" />
          ))}
        </div>
      </Field>
    );
  }

  return (
    <Field>
      {emptyNotice}
      <FieldLabel>Agent provider</FieldLabel>
      {/*
        Types that cannot be used here are listed and disabled rather than
        omitted. A missing tile says nothing; a dimmed one with its reason
        says what to go and fix. Availability is per-machine, so a type the
        user has locally can legitimately be absent on the host they picked.
      */}
      <div className="grid grid-cols-3 gap-2">
        {options.map(({ agent, available, blockedReason }) => (
          <button
            key={agent.id}
            type="button"
            disabled={!available}
            aria-pressed={value === agent.id}
            title={!available ? (blockedReason ?? 'Not available here.') : undefined}
            onClick={() => onChange(agent.id as AgentProviderId)}
            className={cn(
              'flex cursor-pointer flex-col items-start gap-2 rounded-[11px] border p-3 text-left transition-colors',
              value === agent.id
                ? 'border-foreground bg-[var(--sel-soft)]'
                : 'border-border hover:bg-[var(--sel-soft)]',
              !available && 'cursor-not-allowed opacity-45 hover:bg-transparent'
            )}
          >
            <AgentIcon id={agent.id} size={22} />
            <span className="w-full truncate text-sm text-foreground">{agent.name}</span>
          </button>
        ))}
      </div>
      {/* The list is a report on one machine, so the way to change it is on
          that machine's own page — Agent providers for this computer, the
          host's page for a host. */}
      <p className="text-xs text-foreground-muted">
        Only providers installed {sshHost ? `on ${sshHost}` : 'on this machine'} are listed.{' '}
        <button
          type="button"
          className="-mx-1 cursor-pointer rounded px-1 text-foreground underline underline-offset-2 transition-colors hover:bg-[var(--sel-soft)]"
          onClick={() => {
            onNavigateAway();
            if (sshHost) navigate('remoteHost', { sshHost });
            else navigate('settings', { tab: 'clis-models' });
          }}
        >
          {sshHost ? `Set up ${sshHost}` : 'Set up agent providers'}
        </button>
      </p>
    </Field>
  );
}
