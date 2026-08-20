import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InfoTooltip } from '@renderer/features/settings/components/InfoTooltip';
import { rpc } from '@renderer/lib/ipc';
import { Field, FieldDescription, FieldTitle } from '@renderer/lib/ui/field';
import { Switch } from '@renderer/lib/ui/switch';
import { log } from '@renderer/utils/logger';

/**
 * Per-agent "bypass permissions" toggle. When on, Switch Console launches this
 * agent's CLI with its auto-approve flag (e.g. `--dangerously-skip-permissions`)
 * — for every session, including automation-started ones (auto-session,
 * remote reconcile). Defaults off for local agents and on for remote agents
 * (seeded at onboarding); this row is the source of truth thereafter. The value
 * lives on the agent row; the toggle writes through `setAgentAutoApprove`, which
 * also pushes the change to a remote agent's on-VM watcher so it takes effect
 * live (CHOO-1664).
 */
export function AutoApproveSettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  /** Scope to a single agent (e.g. a subagent's own row); omit for every agent. */
  agentId?: string;
}) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  const list = (agents ?? []).filter((a) => !agentId || a.id === agentId);
  if (list.length === 0) return null;
  // Single-agent locations don't need the (directory-derived) agent name label —
  // the section title identifies the setting, so the toggle sits inline with it.
  const single = list.length === 1 ? list[0] : null;

  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldTitle>
          <span className="flex items-center gap-1.5">
            Bypass permissions
            <InfoTooltip
              label="More info about bypassing permissions"
              content="Sessions start with the provider's auto-approve flag, including ones started automatically. Turn it on only for agents you trust to run unattended."
            />
          </span>
        </FieldTitle>
        {single && (
          <AutoApproveSwitch
            agentId={single.id}
            enabled={single.autoApprove}
            locationId={locationId}
          />
        )}
      </div>
      <FieldDescription className="text-foreground-muted">
        Run this agent&apos;s sessions without permission prompts.
      </FieldDescription>
      {!single && (
        <div className="flex flex-col gap-2">
          {list.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5"
            >
              <span className="truncate text-sm">{agent.name}</span>
              <AutoApproveSwitch
                agentId={agent.id}
                enabled={agent.autoApprove}
                locationId={locationId}
              />
            </div>
          ))}
        </div>
      )}
    </Field>
  );
}

function AutoApproveSwitch({
  agentId,
  enabled,
  locationId,
}: {
  agentId: string;
  enabled: boolean;
  locationId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['location-agents', locationId];

  const mutation = useMutation({
    mutationFn: (next: boolean) => rpc.agents.setAgentAutoApprove({ agentId, enabled: next }),
    onError: (error) => {
      log.error('Failed to update autoApprove for agent', { agentId, error });
      void queryClient.invalidateQueries({ queryKey });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <Switch
      checked={enabled}
      disabled={mutation.isPending}
      onCheckedChange={(checked) => mutation.mutate(checked)}
    />
  );
}
