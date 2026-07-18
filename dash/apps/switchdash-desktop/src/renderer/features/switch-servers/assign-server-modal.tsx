import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import {
  AgentServerPicker,
  type ServerVerifyState,
} from '@renderer/features/switch-servers/agent-server-picker';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { log } from '@renderer/utils/logger';

export type AssignServerModalProps = BaseModalProps & {
  locationId: string;
};

/**
 * Assign (or re-assign) the Switch server an agent belongs to. Every agent must
 * be bound to a server it provably exists on; this is how a legacy agent with no
 * server — or one whose server was removed — gets linked. The server choice is
 * verified before it is persisted.
 */
export const AssignServerModal = observer(function AssignServerModal({
  locationId,
  onClose,
}: AssignServerModalProps) {
  const [serverId, setServerId] = useState<string | null>(null);
  const [verifyState, setVerifyState] = useState<ServerVerifyState>('idle');
  const [submitState, setSubmitState] = useState<'idle' | 'saving'>('idle');

  const agentQuery = useQuery({
    queryKey: ['projectAgent', locationId],
    queryFn: async () => {
      const agents = await rpc.agents.getAgents(locationId);
      return agents[0] ?? null;
    },
  });
  const agent = agentQuery.data ?? null;

  const onVerifyStateChange = useCallback((state: ServerVerifyState) => setVerifyState(state), []);

  const canSubmit =
    !!agent?.switchAgentId && !!serverId && verifyState === 'found' && submitState === 'idle';

  const handleAssign = async () => {
    if (!canSubmit || !serverId || !agent) return;
    setSubmitState('saving');
    try {
      const result = await rpc.agents.assignServer({ agentId: agent.id, serverId });
      if (result === 'found') {
        onClose();
        return;
      }
      toast({
        title: 'Could not assign server',
        description:
          result === 'unauthenticated'
            ? 'You are not signed in to that server.'
            : 'This agent is not registered on that server.',
        variant: 'destructive',
      });
    } catch (error) {
      log.error(error);
      toast({
        title: 'Could not assign server',
        description: String(error),
        variant: 'destructive',
      });
    } finally {
      setSubmitState('idle');
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Assign Switch server</DialogTitle>
      </DialogHeader>
      <DialogContentArea>
        {agent?.switchAgentId ? (
          <Field>
            <FieldLabel>Server</FieldLabel>
            <AgentServerPicker
              switchAgentId={agent.switchAgentId}
              serverId={serverId}
              onServerIdChange={setServerId}
              onVerifyStateChange={onVerifyStateChange}
            />
          </Field>
        ) : (
          <p className="text-sm text-foreground-muted">
            This agent has no Switch identity to verify against a server.
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <ConfirmButton size="sm" onClick={() => void handleAssign()} disabled={!canSubmit}>
          {submitState === 'saving' ? 'Assigning…' : 'Assign'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
