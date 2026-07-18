import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Field, FieldDescription, FieldTitle } from '@renderer/lib/ui/field';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Switch } from '@renderer/lib/ui/switch';
import { log } from '@renderer/utils/logger';

/**
 * Per-subagent "auto-create session on notify" toggle. Mirrors
 * {@link AutoSessionSettingsSection} but is keyed by the subagent's own Switch
 * agent id: toggling flips its gateway connection model and starts/stops a
 * watcher that spawns sessions launched as that subagent. Hidden when the
 * location's agent is not linked to a Switch server.
 */
export function SubagentAutoSessionSettingsSection({
  locationId,
  subagentName,
}: {
  locationId: string;
  subagentName: string;
}) {
  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  const parent = (agents ?? []).find((a) => a.serverId && a.switchAgentId);

  if (agentsLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }
  if (!parent) return null;

  return (
    <Field>
      <FieldTitle>Auto-create a session on notify</FieldTitle>
      <FieldDescription className="text-foreground-muted">
        When on, switchdash watches this subagent&apos;s Switch rooms and automatically starts a
        session — launched as {subagentName}, connected to the room and ready to reply — whenever
        it&apos;s addressed with no session running.
      </FieldDescription>
      <SubagentAutoSessionRow parentAgentId={parent.id} name={subagentName} label={subagentName} />
    </Field>
  );
}

function SubagentAutoSessionRow({
  parentAgentId,
  name,
  label,
}: {
  parentAgentId: string;
  name: string;
  label: string;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const queryKey = ['subagent-auto-session', parentAgentId, name];

  const { data: enabled, isLoading } = useQuery({
    queryKey,
    queryFn: () => rpc.subagents.getAutoSession({ parentAgentId, name }),
  });

  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      rpc.subagents.setAutoSession({ parentAgentId, name, enabled: next }),
    onMutate: (next) => {
      setPending(true);
      queryClient.setQueryData(queryKey, next);
    },
    onError: (error, next) => {
      queryClient.setQueryData(queryKey, !next);
      log.error('Failed to update auto_session for subagent', { parentAgentId, name, error });
    },
    onSettled: () => {
      setPending(false);
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5">
      <span className="truncate text-sm">{label}</span>
      <Switch
        checked={enabled === true}
        disabled={isLoading || pending}
        onCheckedChange={(checked) => mutation.mutate(checked)}
      />
    </div>
  );
}
