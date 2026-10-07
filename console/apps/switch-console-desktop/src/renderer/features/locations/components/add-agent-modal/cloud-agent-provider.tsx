import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Spinner } from '@renderer/lib/ui/spinner';
import {
  AGENT_PROVIDERS,
  providerDisplayName,
  type AgentProviderId,
} from '@shared/core/providers/agent-provider-registry';

/**
 * The provider a new Switch cloud agent runs, chosen before the user has a
 * cloud machine to report its providers, with the login Switch holds for it.
 * Reports whether that login is connected, which the agent cannot run without.
 */
export function CloudAgentProvider({
  serverId,
  providerId,
  onProviderChange,
  onConnectedChange,
  onConnectProvider,
}: {
  serverId: string;
  providerId: AgentProviderId;
  onProviderChange: (provider: AgentProviderId) => void;
  onConnectedChange: (connected: boolean) => void;
  onConnectProvider: () => void;
}) {
  const provider = useQuery({
    queryKey: ['cloud-agent-connections', serverId, providerId],
    queryFn: () => rpc.switchServers.getCloudProviderConnection(serverId, providerId),
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === 'verifying' ? 2000 : false),
  });
  const connected = provider.data?.status === 'connected' || provider.data?.status === 'configured';
  useEffect(() => {
    onConnectedChange(connected);
    return () => onConnectedChange(false);
  }, [connected, onConnectedChange]);
  return (
    <>
      <Field>
        <FieldLabel>Agent provider</FieldLabel>
        <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
          <AgentIcon id={providerId} className="size-5" />
          <Select
            value={providerId}
            onValueChange={(value) => {
              if (value) onProviderChange(value as AgentProviderId);
            }}
          >
            <SelectTrigger aria-label="Cloud provider">
              <SelectValue>{providerDisplayName(providerId)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {AGENT_PROVIDERS.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto text-xs text-foreground-muted">
            {provider.data
              ? provider.data.status === 'connected'
                ? 'Verified'
                : provider.data.status === 'configured'
                  ? 'Credential saved'
                  : provider.data.status === 'verifying'
                    ? 'Checking connection…'
                    : provider.data.status === 'failed'
                      ? 'Connection failed'
                      : provider.data.status === 'reconnect_required'
                        ? 'Reconnect required'
                        : 'Not connected'
              : 'Checking connection'}
          </span>
          {provider.error && (
            <Button variant="outline" size="sm" onClick={onConnectProvider}>
              Retry connection
            </Button>
          )}
          {provider.data &&
            ['not_connected', 'failed', 'verifying', 'reconnect_required'].includes(
              provider.data.status
            ) && (
              <Button
                variant="outline"
                size="sm"
                aria-label={`Connect ${providerDisplayName(providerId)}`}
                onClick={onConnectProvider}
              >
                {provider.data.status === 'verifying'
                  ? 'View'
                  : provider.data.status === 'failed'
                    ? 'Retry'
                    : provider.data.status === 'reconnect_required'
                      ? 'Reconnect'
                      : 'Connect'}
              </Button>
            )}
        </div>
      </Field>
      {provider.isPending && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Spinner /> Loading the cloud connection…
        </p>
      )}
      {provider.error && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{failureText(provider.error, 'Could not load the cloud connection.')}</p>
          <Button variant="outline" onClick={() => void provider.refetch()}>
            Retry
          </Button>
        </div>
      )}
    </>
  );
}
