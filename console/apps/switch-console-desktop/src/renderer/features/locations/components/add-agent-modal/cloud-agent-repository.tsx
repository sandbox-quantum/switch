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
  onConnectGitHub,
}: {
  serverId: string;
  providerId: AgentProviderId;
  onProviderChange: (provider: AgentProviderId) => void;
  onSelection: (value: CloudRepositorySelection | null) => void;
  onConnectProvider: () => void;
  onConnectGitHub: () => void;
}) {
  const [repository, setRepository] = useState<string | null>(null);
  const provider = useQuery({
    queryKey: ['cloud-agent-connections', serverId, providerId],
    queryFn: () => rpc.switchServers.getCloudProviderConnection(serverId, providerId),
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === 'verifying' ? 2000 : false),
  });
  const github = useQuery({
    queryKey: ['cloud-agent-github', serverId],
    queryFn: () => rpc.switchServers.getGitHubConnection(serverId),
    staleTime: 0,
    retry: false,
  });
  const repositories =
    github.data?.status === 'connected'
      ? github.data.installations.flatMap((installation) =>
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
  const connected = provider.data?.status === 'connected' || provider.data?.status === 'configured';
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
            {provider.data
              ? provider.data.status === 'connected'
                ? 'Verified'
                : provider.data.status === 'configured'
                  ? 'Credential saved'
                  : provider.data.status === 'verifying'
                    ? 'Checking connection…'
                    : provider.data.status === 'failed'
                      ? 'Connection failed'
                      : 'Not connected'
              : 'Checking connection'}
          </span>
          {provider.error && (
            <Button variant="outline" size="sm" onClick={onConnectProvider}>
              Retry connection
            </Button>
          )}
          {provider.data &&
            ['not_connected', 'failed', 'verifying'].includes(provider.data.status) && (
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
                    : 'Connect'}
              </Button>
            )}
        </div>
      </Field>
      {(provider.isPending || github.isPending) && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Spinner /> Loading cloud connections…
        </p>
      )}
      {(provider.error || github.error) && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{failureText(provider.error || github.error, 'Could not load cloud connections.')}</p>
          <Button
            variant="outline"
            onClick={() => {
              void provider.refetch();
              void github.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      <Button variant="outline" onClick={onConnectGitHub}>
        {github.data?.status === 'connected'
          ? 'Manage GitHub access'
          : github.error
            ? 'Reconnect GitHub'
            : 'Connect GitHub'}
      </Button>
      {github.data && (
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
            {github.data.status !== 'connected'
              ? 'Connect GitHub to choose a repository.'
              : !repositories.length
                ? 'Grant Switch access to a repository in GitHub to continue.'
                : 'Only repositories shared with Switch on GitHub appear here.'}
          </FieldDescription>
        </Field>
      )}
    </>
  );
}
