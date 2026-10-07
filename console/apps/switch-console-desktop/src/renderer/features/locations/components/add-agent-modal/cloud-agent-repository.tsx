import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
import type { CloudRepositorySelection } from '@shared/core/switch-servers/github-connection';

/**
 * The GitHub repository a new Switch cloud agent works in, through the
 * owner's GitHub App installation. Its machine makes the agent's workspace a
 * worktree of it.
 */
export function CloudAgentRepository({
  serverId,
  onSelection,
  onConnectGitHub,
}: {
  serverId: string;
  onSelection: (value: CloudRepositorySelection | null) => void;
  onConnectGitHub: () => void;
}) {
  const [repository, setRepository] = useState<string | null>(null);
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
  useEffect(() => {
    const ids = selected?.split(':').map(Number);
    onSelection(ids ? { installationId: ids[0], repositoryId: ids[1] } : null);
    return () => onSelection(null);
  }, [selected, onSelection]);
  return (
    <>
      {github.isPending && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Spinner /> Loading the GitHub connection…
        </p>
      )}
      {github.error && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{failureText(github.error, 'Could not load the GitHub connection.')}</p>
          <Button variant="outline" onClick={() => void github.refetch()}>
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
