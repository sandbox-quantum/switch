import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
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
import type { CloudRepositorySelection } from '@shared/core/switch-servers/cloud-launch';

export function CloudAgentRepository({
  serverId,
  providerId,
  onProviderChange,
  onSelection,
  onConnectProvider,
}: {
  serverId: string;
  providerId: AgentProviderId;
  onProviderChange: (provider: AgentProviderId) => void;
  onSelection: (value: CloudRepositorySelection | null) => void;
  onConnectProvider: () => void;
}) {
  const [repository, setRepository] = useState<string | null>(null);
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['cloud-agent-connections', serverId, providerId],
    queryFn: async () => {
      const [claude, github] = await Promise.all([
        rpc.switchServers.getCloudProviderConnection(serverId, providerId),
        rpc.switchServers.getGitHubConnection(serverId),
      ]);
      return { claude, github };
    },
    staleTime: 0,
    retry: false,
  });
  const repositories =
    data?.github.status === 'connected'
      ? data.github.installations.flatMap((installation) =>
          installation.repositories.map((repo) => ({
            value: `${installation.id}:${repo.id}`,
            label: repo.name,
          }))
        )
      : [];
  const selected = repositories.some((repo) => repo.value === repository)
    ? repository
    : repositories.length === 1
      ? repositories[0].value
      : null;
  const connected = data?.claude.status === 'connected' || data?.claude.status === 'configured';
  useEffect(() => {
    const ids = selected?.split(':').map(Number);
    onSelection(connected && ids ? { installationId: ids[0], repositoryId: ids[1] } : null);
    return () => onSelection(null);
  }, [selected, connected, onSelection]);
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
            {data
              ? data.claude.status === 'connected'
                ? 'Verified'
                : data.claude.status === 'configured'
                  ? 'Saved · awaiting worker verification'
                  : 'Not connected'
              : 'Checking connection'}
          </span>
        </div>
      </Field>
      {isPending && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Spinner /> Loading cloud connections…
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{failureText(error, 'Could not load cloud connections.')}</p>
          <Button variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      )}
      {data && data.claude.status === 'not_connected' && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-foreground-muted">
            Connect {providerDisplayName(providerId)} to use it in the cloud.
          </p>
          <Button variant="outline" onClick={onConnectProvider}>
            Connect {providerDisplayName(providerId)}
          </Button>
        </div>
      )}
      {data && (
        <Field>
          <FieldLabel htmlFor="cloud-agent-repository">Repository</FieldLabel>
          <Select
            items={repositories}
            value={selected}
            onValueChange={setRepository}
            disabled={!repositories.length}
          >
            <SelectTrigger id="cloud-agent-repository" className="w-full">
              <SelectValue placeholder="Choose a repository" />
            </SelectTrigger>
            <SelectContent>
              {repositories.map((repo) => (
                <SelectItem key={repo.value} value={repo.value}>
                  {repo.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            {data.github.status !== 'connected'
              ? 'Connect GitHub in Switch-managed server setup to choose a repository.'
              : !repositories.length
                ? 'Grant Switch access to a repository in GitHub to continue.'
                : 'Only repositories shared with Switch on GitHub appear here.'}
          </FieldDescription>
        </Field>
      )}
    </>
  );
}
