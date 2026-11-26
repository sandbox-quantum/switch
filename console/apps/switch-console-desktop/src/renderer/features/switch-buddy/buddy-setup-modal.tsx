import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@switch-console/chat-ui/primitives/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@switch-console/chat-ui/primitives/dialog';
import { ProviderSetup } from './provider-setup';
import { useThisComputer } from './use-this-computer';

type Args = { serverId: string; workspaceId: string };

/** Connect an AI provider to switch-buddy, from its chat, after skipping it in onboarding. */
export function BuddySetupModal({
  serverId,
  workspaceId,
  onSuccess,
  onClose,
}: Args & BaseModalProps<{ agentId: string; name: string }>) {
  const thisComputer = useThisComputer(serverId, workspaceId);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect an AI provider to switch-buddy</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <ProviderSetup
          serverId={serverId}
          workspaceId={workspaceId}
          onCreated={onSuccess}
          thisComputer={thisComputer}
        />
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Not now
        </Button>
      </DialogFooter>
    </>
  );
}
