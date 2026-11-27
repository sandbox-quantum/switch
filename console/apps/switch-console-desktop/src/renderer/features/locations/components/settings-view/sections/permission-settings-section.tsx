import {
  AutoApproveRow,
  AutoModeRow,
  PERMISSION_COPY,
} from '@switch-console/chat-ui/components/agent-permissions';
import { Switch } from '@switch-console/chat-ui/primitives/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { Agent } from '@shared/core/agents/agents';
import {
  autoModeIsUnreviewed,
  providerDisplayName,
  providerSupportsAutoMode,
} from '@shared/core/providers/agent-provider-registry';

type PermissionSetting = 'autoApprove' | 'autoMode';

/**
 * Per-agent permission settings: auto mode (the provider's own automatic
 * review) and bypass permissions (no checks at all, winning over auto mode).
 * Both apply to every session, including automation-started ones. The values
 * live on the agent row; each toggle writes through `setAgentPermission`, which
 * also pushes the change to a remote agent's watcher so it takes effect live
 * (CHOO-1664).
 */
export function PermissionSettingsSection({
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

  const perAgent = (setting: PermissionSetting) =>
    !single && (
      <div className="flex flex-col gap-2">
        {list
          .filter((agent) => setting !== 'autoMode' || providerSupportsAutoMode(agent.providerId))
          .map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5"
            >
              <span className="truncate text-sm">{agent.name}</span>
              <PermissionSwitch agent={agent} setting={setting} locationId={locationId} />
            </div>
          ))}
      </div>
    );

  return (
    <>
      {list.some((agent) => providerSupportsAutoMode(agent.providerId)) && (
        <AutoModeRow
          unreviewed={list
            .filter((agent) => autoModeIsUnreviewed(agent.providerId))
            .map((agent) => providerDisplayName(agent.providerId) ?? agent.providerId)}
          overridden={single?.autoApprove ?? false}
          control={
            single && <PermissionSwitch agent={single} setting="autoMode" locationId={locationId} />
          }
        >
          {perAgent('autoMode')}
        </AutoModeRow>
      )}
      <AutoApproveRow
        control={
          single && (
            <PermissionSwitch agent={single} setting="autoApprove" locationId={locationId} />
          )
        }
      >
        {perAgent('autoApprove')}
      </AutoApproveRow>
    </>
  );
}

function PermissionSwitch({
  agent,
  setting,
  locationId,
}: {
  agent: Agent;
  setting: PermissionSetting;
  locationId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['location-agents', locationId];

  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      rpc.agents.setAgentPermission({ agentId: agent.id, setting, enabled: next }),
    onError: (error) => {
      log.error('Failed to update a permission setting for agent', {
        agentId: agent.id,
        setting,
        error,
      });
      void queryClient.invalidateQueries({ queryKey });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <Switch
      aria-label={PERMISSION_COPY[setting].title}
      checked={agent[setting]}
      disabled={mutation.isPending}
      onCheckedChange={(checked) => mutation.mutate(checked)}
    />
  );
}
