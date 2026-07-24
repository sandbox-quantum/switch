import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { Field, FieldDescription, FieldTitle } from '@renderer/lib/ui/field';
import { Switch } from '@renderer/lib/ui/switch';
import { log } from '@renderer/utils/logger';

/**
 * Per-agent "bypass permissions" toggle. When on, switchdash launches this
 * agent's CLI with its auto-approve flag (e.g. `--dangerously-skip-permissions`)
 * — for every session, including automation-started ones (auto-session,
 * remote reconcile). Defaults off for local agents and on for remote agents
 * (seeded at onboarding); this row is the source of truth thereafter. The
 * value lives on the agent row, so the toggle writes through `updateAgent`.
 */
export function AutoApproveSettingsSection({ locationId }: { locationId: string }) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  if ((agents ?? []).length === 0) return null;

  return (
    <Field>
      <FieldTitle>Bypass permissions</FieldTitle>
      <FieldDescription className="text-foreground-muted">
        When on, switchdash starts this agent&apos;s sessions with permission prompts bypassed (the
        provider&apos;s auto-approve flag). Off by default; turn it on only for agents you trust to
        run unattended.
      </FieldDescription>
      <div className="flex flex-col gap-2">
        {(agents ?? []).map((agent) => (
          <AutoApproveRow
            key={agent.id}
            agentId={agent.id}
            agentName={agent.name}
            enabled={agent.autoApprove}
            locationId={locationId}
          />
        ))}
      </div>
    </Field>
  );
}

function AutoApproveRow({
  agentId,
  agentName,
  enabled,
  locationId,
}: {
  agentId: string;
  agentName: string;
  enabled: boolean;
  locationId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['location-agents', locationId];

  const mutation = useMutation({
    mutationFn: (next: boolean) => rpc.agents.updateAgent({ agentId, autoApprove: next }),
    onError: (error) => {
      log.error('Failed to update autoApprove for agent', { agentId, error });
      void queryClient.invalidateQueries({ queryKey });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5">
      <span className="truncate text-sm">{agentName}</span>
      <Switch
        checked={enabled}
        disabled={mutation.isPending}
        onCheckedChange={(checked) => mutation.mutate(checked)}
      />
    </div>
  );
}
