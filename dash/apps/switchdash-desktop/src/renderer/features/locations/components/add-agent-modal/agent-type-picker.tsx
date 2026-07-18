import { CircleAlert } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useOnboardableAgentTypes } from '@renderer/lib/stores/use-switch-setup';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * Picks the agent type for a new Switch agent. Only agent types that are both
 * Switch-supported and have their connector plugin installed (i.e. actually
 * usable) are offered; if none qualify, the user is pointed at the per-agent
 * Switch setup. The selection is auto-set to the single option when there is
 * only one, so the common case needs no extra click.
 */
export function AgentTypePicker({
  value,
  onChange,
  sshHost,
}: {
  value: AgentProviderId | null;
  onChange: (providerId: AgentProviderId) => void;
  sshHost?: string;
}) {
  const { data: onboardable, isPending } = useOnboardableAgentTypes(sshHost);
  const { data: agents } = useAgents();

  const options = useMemo(() => {
    const byId = new Map((agents ?? []).map((a) => [a.id, a]));
    return (onboardable ?? [])
      .map((o) => byId.get(o.agentId))
      .filter((a): a is NonNullable<typeof a> => !!a);
  }, [onboardable, agents]);

  useEffect(() => {
    if (value) return;
    if (options.length === 1) onChange(options[0].id as AgentProviderId);
  }, [value, options, onChange]);

  if (!isPending && options.length === 0) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <span>
          No agent type is set up for Switch yet. Install an agent&apos;s Switch connector in
          Settings &rarr; Agents before onboarding it.
        </span>
      </div>
    );
  }

  const selected = options.find((a) => a.id === value);

  return (
    <Field>
      <FieldLabel>Agent type</FieldLabel>
      <Select value={value ?? undefined} onValueChange={(v) => v && onChange(v as AgentProviderId)}>
        <SelectTrigger>
          <SelectValue placeholder="Select an agent type">
            {selected ? (
              <span className="flex items-center gap-2">
                <AgentIcon id={selected.id} size={16} />
                {selected.name}
              </span>
            ) : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              <span className="flex items-center gap-2">
                <AgentIcon id={agent.id} size={16} />
                {agent.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
