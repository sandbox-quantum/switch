import { ManagedGitHubStep } from '@renderer/features/switch-servers/managed-github-step';
import { workspaceServiceCalls } from '@renderer/features/switch-servers/service-calls';
import { ServiceConnectStep } from '@renderer/features/switch-servers/service-connect-step';
import { ServiceKeyStep } from '@renderer/features/switch-servers/service-key-step';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { offersAddAgent } from './grant-agents';

/**
 * Connecting one service from its Connectors profile: GitHub's own step, a key
 * form, or the generic sign-in, as the catalog entry calls for. A service the
 * person then adds agents to from its page closes the dialog as soon as it is
 * connected, so the page, with its Add agent search open, is what they see
 * next. GitHub's stays open once connected, showing the repositories reached,
 * until Done; the page behind is already current. `startAt: 'replace'` opens
 * on the form that replaces a connected key, which keeps every agent's access.
 */
export function ConnectServiceModal({
  serverId,
  workspaceId,
  connection,
  startAt,
  onConnected,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  startAt: 'connect' | 'replace';
  /** Runs as soon as the service is connected, with the warning Switch gave. */
  onConnected: (warning: string | null) => void;
} & BaseModalProps) {
  const calls = workspaceServiceCalls(workspaceId);
  const connected = (warning: string | null) => {
    onConnected(warning);
    if (offersAddAgent(connection)) onClose();
  };

  if (startAt === 'replace' && connection.key)
    return (
      <ServiceKeyStep
        calls={calls}
        connection={connection}
        form={connection.key}
        replacing
        onBack={onClose}
        onConnected={onConnected}
      />
    );
  if (connection.slug === 'github')
    return (
      <ManagedGitHubStep
        serverId={serverId}
        onBack={onClose}
        onDone={onClose}
        onConnected={onConnected}
      />
    );
  if (connection.key)
    return (
      <ServiceKeyStep
        calls={calls}
        connection={connection}
        form={connection.key}
        replacing={false}
        onBack={onClose}
        onConnected={connected}
      />
    );
  return (
    <ServiceConnectStep
      calls={calls}
      connection={connection}
      onBack={onClose}
      onConnected={connected}
    />
  );
}
