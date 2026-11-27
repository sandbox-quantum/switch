import { Button } from '@switch-console/chat-ui/primitives/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { managedAgentLabel } from '@renderer/features/managed-agents/managed-agent-state';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import type {
  DeviceAgentGrant,
  DeviceConsentChoice,
} from '@shared/core/embedded-controller/embedded-controller';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { Card } from './detail-card';
import { askLines } from './device-consent-modal';
import { DEVICE_CONSENT_KEY } from './device-consent-prompts';

/** The device policy's key for every agent. */
const EVERY_AGENT = '*';

/**
 * What this computer allows the managed agents a server runs on it, beyond
 * their workspaces folder and asking before they act: set here, never by the
 * server. Each can be taken back, and taking back always wins. Asks still
 * waiting for an answer are listed too.
 */
export function DevicePermissionsCard({
  serverId,
  agents,
}: {
  serverId: string;
  /** The person's managed agents, to name each agent by. */
  agents: ManagedAgentView[] | null;
}) {
  const queryClient = useQueryClient();
  const showConsent = useShowModal('deviceConsentModal');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grants = useQuery({
    queryKey: [...DEVICE_CONSENT_KEY, 'grants', serverId],
    queryFn: () => rpc.embeddedController.deviceGrants(serverId),
  });
  const asks = useQuery({
    queryKey: [...DEVICE_CONSENT_KEY, 'asks'],
    queryFn: () => rpc.embeddedController.consentAsks(),
  });
  const waiting = asks.data?.find((event) => event.serverId === serverId)?.asks ?? [];

  const nameOf = (agentId: string) => {
    if (agentId === EVERY_AGENT) return 'Every agent';
    const agent = agents?.find((each) => each.agentId === agentId);
    return agent ? managedAgentLabel(agent) : agentId;
  };

  const revoke = async (grant: DeviceAgentGrant, choice: DeviceConsentChoice, key: string) => {
    setBusy(key);
    setError(null);
    try {
      await rpc.embeddedController.revokeForAgent({ serverId, agentId: grant.agentId, choice });
      await queryClient.invalidateQueries({ queryKey: DEVICE_CONSENT_KEY });
    } catch (cause) {
      setError(failureText(cause, 'Could not take it back.'));
    } finally {
      setBusy(null);
    }
  };

  const rows = (grants.data ?? []).flatMap((grant) => [
    ...(grant.bypass
      ? [
          {
            key: `${grant.agentId}:bypass`,
            grant,
            text: 'Runs every command without asking you first',
            choice: { bypass: true, directory: null },
          },
        ]
      : []),
    ...grant.directories.map((directory) => ({
      key: `${grant.agentId}:${directory}`,
      grant,
      text: `Works in ${directory}`,
      choice: { bypass: false, directory },
    })),
  ]);

  return (
    <Card
      title="Allowed on this computer"
      subtitle="Only you can allow these, here. Agents not listed work in their workspaces folder and ask before they act."
    >
      {grants.isError ? (
        <p className="text-sm text-destructive">
          {failureText(grants.error, 'Could not read what this computer allows.')}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--fg-dim)]">Nothing beyond that.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center gap-3 py-1.5">
              <span className="w-40 shrink-0 truncate font-medium">
                {nameOf(row.grant.agentId)}
              </span>
              <span className="min-w-0 flex-1 truncate" title={row.text}>
                {row.text}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void revoke(row.grant, row.choice, row.key)}
              >
                {busy === row.key ? 'Taking back…' : 'Revoke'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {waiting.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {waiting.map((ask) => (
            <li key={`${ask.agentId}:${ask.bypass}:${ask.directory ?? ''}`} className="flex gap-3">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{ask.name}</span> asks to{' '}
                {askLines(ask)
                  .map((line) => line.charAt(0).toLowerCase() + line.slice(1, -1))
                  .join(', and ')}
                .
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  showConsent({
                    serverId,
                    ask,
                    onSuccess: () =>
                      void queryClient.invalidateQueries({ queryKey: DEVICE_CONSENT_KEY }),
                  })
                }
              >
                Review
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </Card>
  );
}
