import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { InfoTooltip } from '@renderer/features/settings/components/InfoTooltip';
import { rpc } from '@renderer/lib/ipc';
import { Field, FieldDescription, FieldTitle } from '@renderer/lib/ui/field';
import { Switch } from '@renderer/lib/ui/switch';
import { log } from '@renderer/utils/logger';

/**
 * Per-Switch-agent "auto-create session on notify" toggle. Unlike the rest of
 * the location settings form (persisted to .switchdash.json / DB on Save), this
 * flips the agent's gateway connection model immediately on toggle — there is
 * no local config to stage. Renders one row per Switch-linked agent in the
 * location; hidden entirely when the location has none.
 */
export function AutoSessionSettingsSection({
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

  const switchAgents = (agents ?? [])
    .filter((a) => a.serverId && a.switchAgentId)
    .filter((a) => !agentId || a.id === agentId);
  if (switchAgents.length === 0) return null;
  // The agent name only disambiguates when a location has more than one agent;
  // for the common single-agent case the section title already identifies it, so
  // the toggle sits inline with the title instead of in a redundant named row.
  const single = switchAgents.length === 1 ? switchAgents[0] : null;

  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldTitle>
          <span className="flex items-center gap-1.5">
            Auto-create a session on notify
            <InfoTooltip
              label="More info about auto-creating a session"
              content="Switch Console watches this agent's Switch rooms and starts a session — connected to the room and ready to reply — whenever it's addressed with no session running."
            />
          </span>
        </FieldTitle>
        {single && <AutoSessionSwitch agentId={single.id} />}
      </div>
      <FieldDescription className="text-foreground-muted">
        Start a session when this agent is addressed.
      </FieldDescription>
      {!single && (
        <div className="flex flex-col gap-2">
          {switchAgents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5"
            >
              <AgentLabel name={agent.name} />
              <AutoSessionSwitch agentId={agent.id} />
            </div>
          ))}
        </div>
      )}
    </Field>
  );
}

/** Renders an agent's Switch name — the stored one, which is what was
 * registered on the server. */
function AgentLabel({ name }: { name: string }) {
  return <span className="truncate text-sm">{name}</span>;
}

function AutoSessionSwitch({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const { data: enabled, isLoading } = useQuery({
    queryKey: ['agent-auto-session', agentId],
    queryFn: () => rpc.agents.getAgentAutoSession({ agentId }),
  });

  const mutation = useMutation({
    mutationFn: (next: boolean) => rpc.agents.setAgentAutoSession({ agentId, enabled: next }),
    onMutate: (next) => {
      setPending(true);
      queryClient.setQueryData(['agent-auto-session', agentId], next);
    },
    onError: (error, next) => {
      // Revert the optimistic update on failure.
      queryClient.setQueryData(['agent-auto-session', agentId], !next);
      log.error('Failed to update auto_session for agent', { agentId, error });
    },
    onSettled: () => {
      setPending(false);
      void queryClient.invalidateQueries({ queryKey: ['agent-auto-session', agentId] });
    },
  });

  return (
    <Switch
      checked={enabled === true}
      disabled={isLoading || pending}
      onCheckedChange={(checked) => mutation.mutate(checked)}
    />
  );
}
