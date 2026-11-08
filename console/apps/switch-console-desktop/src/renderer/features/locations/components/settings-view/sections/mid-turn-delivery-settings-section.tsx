import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { log } from '@renderer/utils/logger';
import { SettingRow } from './setting-row';

export const MID_TURN_DELIVERY_COPY = {
  title: 'Mid-turn messages',
  description: 'How messages arriving while the agent is running a turn should be handled.',
  infoLabel: 'More info about mid-turn messages',
  info: "When steering is enabled, messages from you or the turn starter in the running thread steer directly into the active turn. Messages from other users or threads are queued safely. When set to always queue, all mid-turn messages wait until the current turn completes.",
  options: {
    steer: 'Steer into running turn (default)',
    queue: 'Always queue behind running turn',
  },
} as const;

/**
 * Per-agent setting for mid-turn message delivery: steering into the running
 * turn (default) vs always queueing behind it (#801).
 */
export function MidTurnDeliverySettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  agentId?: string;
}) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  const list = (agents ?? []).filter((a) => !agentId || a.id === agentId);
  if (list.length === 0) return null;
  const single = list.length === 1 ? list[0] : null;

  return (
    <>
      {list.map((agent) => (
        <MidTurnDeliveryRow
          key={agent.id}
          agentId={agent.id}
          agentName={single ? null : agent.name}
          locationId={locationId}
        />
      ))}
    </>
  );
}

export function MidTurnDeliveryRow({
  agentId,
  agentName,
  locationId,
}: {
  agentId: string;
  agentName: string | null;
  locationId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['agent-advanced-config', agentId];
  const { data: current } = useQuery({
    queryKey,
    queryFn: () => rpc.agents.readAdvancedConfig({ agentId }),
  });

  const mode: 'steer' | 'queue' =
    current?.midTurnDelivery === 'queue' ? 'queue' : 'steer';

  const mutation = useMutation({
    mutationFn: (nextMode: 'steer' | 'queue') =>
      rpc.agents.updateAdvancedConfig({
        agentId,
        attributes: {
          ...(current ?? {}),
          midTurnDelivery: nextMode,
        },
      }),
    onSuccess: () => {
      toast({ title: 'Mid-turn messaging setting updated' });
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ['location-agents', locationId] });
    },
    onError: (error) => {
      log.error('Failed to update midTurnDelivery', { agentId, error });
    },
  });

  return (
    <SettingRow
      title={
        agentName
          ? `${agentName}: ${MID_TURN_DELIVERY_COPY.title}`
          : MID_TURN_DELIVERY_COPY.title
      }
      info={{
        label: MID_TURN_DELIVERY_COPY.infoLabel,
        content: MID_TURN_DELIVERY_COPY.info,
      }}
      description={MID_TURN_DELIVERY_COPY.description}
      control={
        <Select
          value={mode}
          onValueChange={(val) => mutation.mutate(val as 'steer' | 'queue')}
          disabled={mutation.isPending}
        >
          <SelectTrigger className="w-64" aria-label="Mid-turn message handling">
            <SelectValue>{MID_TURN_DELIVERY_COPY.options[mode]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="steer">
              {MID_TURN_DELIVERY_COPY.options.steer}
            </SelectItem>
            <SelectItem value="queue">
              {MID_TURN_DELIVERY_COPY.options.queue}
            </SelectItem>
          </SelectContent>
        </Select>
      }
    >
      {mutation.error && (
        <span className="text-xs text-destructive">
          {failureText(mutation.error, 'Could not change mid-turn message handling.')}
        </span>
      )}
    </SettingRow>
  );
}
