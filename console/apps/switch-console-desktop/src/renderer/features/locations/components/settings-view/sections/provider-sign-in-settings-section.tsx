import { useQuery } from '@tanstack/react-query';
import { ProviderConnectionStatus } from '@renderer/lib/components/provider-connection-status';
import { rpc } from '@renderer/lib/ipc';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';

/**
 * Whether the agent's provider CLI is signed in on the machine its sessions
 * run on. A session cannot start without it, and that otherwise only shows
 * once somebody addresses the agent and the start fails.
 */
export function ProviderSignInSettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  agentId: string | undefined;
}) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });
  const { data: locations } = useQuery({
    queryKey: ['locations'],
    queryFn: () => rpc.locations.getLocations(),
  });
  const agent = (agents ?? []).find((a) => a.id === agentId);
  const location = (locations ?? []).find((l) => l.id === locationId);
  if (!agent || !location) return null;
  return (
    <Field>
      <FieldLabel>Provider sign-in</FieldLabel>
      {/* An empty directory shares the Add Agent check's result for the same machine. */}
      <ProviderConnectionStatus providerId={agent.providerId} sshHost={location.sshHost} dir="" />
      <FieldDescription className="text-foreground-muted">
        The agent&apos;s sessions start only when its provider CLI is signed in on the machine they
        run on.
      </FieldDescription>
    </Field>
  );
}
