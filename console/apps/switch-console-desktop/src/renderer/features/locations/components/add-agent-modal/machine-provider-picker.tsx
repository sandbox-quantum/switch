import { CircleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { cn } from '@renderer/utils/utils';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  AGENT_PROVIDERS,
  type AgentProviderId,
} from '@shared/core/providers/agent-provider-registry';
import { autoSelectedAgentType } from './agent-type-auto-selection';
import { GiveMachineLogin } from './give-machine-login';

/** Each provider, and whether the machine last reported it installed and logged in. */
export function machineProviderOptions(
  machine: OwnedMachine
): { id: AgentProviderId; name: string; ready: boolean; problem: string | null }[] {
  return AGENT_PROVIDERS.map((provider) => {
    const reported = machine.providers.find((entry) => entry.provider === provider.id);
    return {
      id: provider.id,
      name: provider.name,
      ready: reported?.ready ?? false,
      problem: reported ? reported.problem : 'not checked yet',
    };
  });
}

/**
 * The agent provider for a managed agent, from what its machine reports to the
 * server: only the providers installed and logged in there can be picked.
 */
export function MachineProviderPicker({
  serverId,
  machine,
  value,
  onChange,
  defaultAgent,
}: {
  serverId: string;
  machine: OwnedMachine;
  value: AgentProviderId | null;
  onChange: (providerId: AgentProviderId) => void;
  /** The user's default agent; undefined while it loads. */
  defaultAgent: string | undefined;
}) {
  const options = useMemo(() => machineProviderOptions(machine), [machine]);
  const ready = useMemo(
    () => options.filter((option) => option.ready).map((option) => option.id),
    [options]
  );
  // Installed there but not signed in: a login can be given to the machine.
  const givable = machine.acceptsLogins
    ? options.filter((option) => !option.ready && option.problem !== 'not installed')
    : [];
  const [giving, setGiving] = useState<AgentProviderId | null>(null);

  useEffect(() => {
    if (value) return;
    const picked = autoSelectedAgentType(ready, defaultAgent);
    if (picked) onChange(picked);
  }, [value, ready, onChange, defaultAgent]);

  return (
    <Field>
      <FieldLabel>Agent provider</FieldLabel>
      {ready.length === 0 && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>
            {machine.providers.length === 0
              ? `${machine.name} has not reported its providers yet.`
              : `No provider is installed and logged in on ${machine.name}.`}
          </span>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={!option.ready}
            aria-pressed={value === option.id}
            title={option.problem ? `${option.name}: ${option.problem}` : undefined}
            onClick={() => onChange(option.id)}
            className={cn(
              'flex cursor-pointer flex-col items-start gap-2 rounded-[11px] border p-3 text-left transition-colors',
              value === option.id
                ? 'border-foreground bg-[var(--sel-soft)]'
                : 'border-border hover:bg-[var(--sel-soft)]',
              !option.ready && 'cursor-not-allowed opacity-50 bg-background-1 hover:bg-transparent'
            )}
          >
            <AgentIcon id={option.id} size={22} />
            <span className="w-full truncate text-sm text-foreground">{option.name}</span>
            <span className="text-xs text-foreground-muted">
              {option.problem ? capitalize(option.problem) : 'Ready'}
            </span>
          </button>
        ))}
      </div>
      <p className="text-xs text-foreground-muted">
        As {machine.name} last reported to the server.
      </p>
      {giving ? (
        <GiveMachineLogin
          serverId={serverId}
          machine={machine}
          provider={giving}
          onClose={() => setGiving(null)}
        />
      ) : (
        givable.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
            <span>Give {machine.name} a login for</span>
            {givable.map((option) => (
              <button
                key={option.id}
                type="button"
                className="cursor-pointer rounded-md border border-border px-2 py-0.5 text-foreground hover:bg-[var(--sel-soft)]"
                onClick={() => setGiving(option.id)}
              >
                {option.name}
              </button>
            ))}
          </div>
        )
      )}
    </Field>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
