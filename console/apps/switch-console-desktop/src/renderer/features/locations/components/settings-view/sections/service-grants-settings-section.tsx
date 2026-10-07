import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { GitHubConnection } from '@shared/core/switch-servers/github-connection';
import { OWNER_ONLY_POLICY, type ServiceGrant } from '@shared/core/switch-servers/service-grants';
import {
  CLOUD_GITHUB_GRANT_NOTES,
  GITHUB_GRANT_NOTES,
  grantedRepositoryIds,
  grantedRepositoryNames,
} from './service-grants';

type Access = 'read' | 'write';

const ACCESS_OPTIONS = [
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Read and push' },
] as const;

/**
 * What the agent may use of its owner's service connections (GitHub, for
 * now): its grants, a grant it works without, who else can reach it and so
 * its grants, and what a GitHub grant does on the machine it runs on.
 * Hidden for an agent with no Switch registration.
 */
export function ServiceGrantsSettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  /** The local agent; none yet while the location's agents load. */
  agentId: string | undefined;
}) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });
  const agent = (agents ?? []).find(
    (candidate) => candidate.id === agentId && candidate.workspaceId && candidate.switchAgentId
  );
  if (!agent) return null;
  return (
    <ServiceGrantsRow
      workspaceId={agent.workspaceId as string}
      serverId={agent.serverId as string}
      agentId={agent.switchAgentId as string}
      agentName={agent.name}
      cloud={false}
    />
  );
}

/**
 * One agent's Service access. `cloud` is for a cloud agent, whose sessions
 * have no GitHub sign-in of their own and run on no machine of the owner's.
 */
export function ServiceGrantsRow({
  workspaceId,
  serverId,
  agentId,
  agentName,
  cloud,
}: {
  workspaceId: string;
  serverId: string;
  /** The agent's id in Switch. */
  agentId: string;
  agentName: string;
  cloud: boolean;
}) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const grantsKey = ['agent-service-grants', workspaceId, agentId];
  const grants = useQuery({
    queryKey: grantsKey,
    queryFn: () => rpc.workspaces.getServiceGrants({ workspaceId, agentId }),
    retry: false,
  });
  const github = useQuery({
    queryKey: ['cloud-agent-github', serverId],
    queryFn: () => rpc.switchServers.getGitHubConnection(serverId),
    retry: false,
  });

  const change = useMutation({
    mutationFn: async (run: () => Promise<string | null | void>) => run(),
    onSuccess: async (warning) => {
      setNotice(warning ?? null);
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: grantsKey });
    },
  });
  const set = (service: string, access: Access, resources: Record<string, unknown>) =>
    change.mutate(() =>
      rpc.workspaces.setServiceGrant({ workspaceId, agentId, service, access, resources })
    );

  if (grants.isPending)
    return (
      <p className="flex items-center gap-2 text-sm">
        <Spinner /> Loading service access…
      </p>
    );
  // Only the agent's owner sees its grants; anyone else is answered as if it had none.
  if (grants.isError) return null;

  const githubGrant = grants.data.grants.find((grant) => grant.service === 'github') ?? null;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <span className="text-sm font-medium">Service access</span>
        <p className="text-sm text-foreground-muted">
          What {agentName} may use of your own connections. Its sessions are given short-lived
          access for what you grant, and nothing else.
        </p>
      </div>
      {change.isError && (
        <span className="text-xs text-destructive">
          {failureText(change.error, 'Could not change the grant.')}
        </span>
      )}
      {notice && <span className="text-xs text-foreground-muted">{notice}</span>}

      {grants.data.addressing_open && grants.data.grants.length > 0 && (
        <Alert variant="warning">
          <AlertDescription>
            Anyone who can address {agentName} can have it use these grants. Owner-only stops that,
            but it still reads what others write in shared rooms, can be reached through your other
            agents that are open, and posts results to shared rooms.
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              disabled={change.isPending}
              onClick={() =>
                change.mutate(async () => {
                  await rpc.workspaces.updateAddressingPolicy({
                    workspaceId,
                    agentId,
                    policy: OWNER_ONLY_POLICY,
                  });
                  await queryClient.invalidateQueries({
                    queryKey: ['agent-addressing-policy', workspaceId, agentId],
                  });
                })
              }
            >
              Make owner-only
            </Button>
          </AlertAction>
        </Alert>
      )}

      {grants.data.missing.map((missing) => (
        <Alert key={missing.service} variant="warning">
          <AlertDescription>{missing.reason}</AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              disabled={change.isPending}
              onClick={() => set(missing.service, missing.access, missing.resources)}
            >
              Grant it
            </Button>
          </AlertAction>
        </Alert>
      ))}

      {grants.data.grants.map((grant) => (
        <GrantCard
          key={grant.service}
          grant={grant}
          github={github.data}
          busy={change.isPending}
          onChange={grant.service === 'github' ? () => setEditing(true) : null}
          onRemove={() =>
            change.mutate(() =>
              rpc.workspaces.removeServiceGrant({ workspaceId, agentId, service: grant.service })
            )
          }
        />
      ))}

      {(editing || !githubGrant) && (
        <GitHubGrantForm
          github={github}
          current={githubGrant}
          busy={change.isPending}
          onCancel={githubGrant ? () => setEditing(false) : null}
          onSave={(access, resources) => set('github', access, resources)}
        />
      )}

      <ul className="list-disc space-y-1 pl-5 text-xs text-foreground-muted">
        {(cloud ? CLOUD_GITHUB_GRANT_NOTES : GITHUB_GRANT_NOTES).map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

function GrantCard({
  grant,
  github,
  busy,
  onChange,
  onRemove,
}: {
  grant: ServiceGrant;
  github: GitHubConnection | undefined;
  busy: boolean;
  onChange: (() => void) | null;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-medium">{grant.name}</span>
        <Badge variant="outline">{grant.access === 'write' ? 'Read and push' : 'Read'}</Badge>
        {onChange && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onChange}>
            Change
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
          Remove
        </Button>
      </div>
      <p className="mt-1 text-sm text-foreground-muted">{grant.summary}</p>
      {grant.service === 'github' && (
        <p className="mt-1 text-sm">{grantedRepositoryNames(github, grant.resources).join(', ')}</p>
      )}
    </div>
  );
}

function GitHubGrantForm({
  github,
  current,
  busy,
  onCancel,
  onSave,
}: {
  github: { data: GitHubConnection | undefined; isError: boolean; error: unknown };
  current: ServiceGrant | null;
  busy: boolean;
  onCancel: (() => void) | null;
  onSave: (access: Access, resources: Record<string, unknown>) => void;
}) {
  const [access, setAccess] = useState<Access>(current?.access ?? 'read');
  const [installationId, setInstallationId] = useState<number | null>(
    typeof current?.resources.installation_id === 'number'
      ? current.resources.installation_id
      : null
  );
  const [selected, setSelected] = useState<number[]>(
    current ? grantedRepositoryIds(current.resources) : []
  );

  if (github.isError)
    return (
      <span className="text-xs text-destructive">
        {failureText(github.error, 'Could not load your GitHub repositories.')}
      </span>
    );
  if (!github.data) return <Spinner />;
  if (github.data.status === 'not_connected')
    return (
      <p className="text-sm text-foreground-muted">
        To grant GitHub, first connect your GitHub account from the server&apos;s Connections.
      </p>
    );

  const installations = github.data.installations;
  const installation = installations.find((candidate) => candidate.id === installationId);
  const toggle = (id: number) =>
    setSelected((now) => (now.includes(id) ? now.filter((other) => other !== id) : [...now, id]));

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <span className="text-sm font-medium">
        {current ? 'Change the GitHub grant' : 'Grant GitHub'}
      </span>
      <Select
        value={installationId === null ? null : String(installationId)}
        onValueChange={(value) => {
          setInstallationId(value ? Number(value) : null);
          setSelected([]);
        }}
      >
        <SelectTrigger aria-label="GitHub account" className="w-full">
          <SelectValue placeholder="Choose a GitHub account">{installation?.account}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {installations.map((candidate) => (
            <SelectItem key={candidate.id} value={String(candidate.id)}>
              {candidate.account}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {installation && (
        <div role="group" aria-label="Repositories" className="max-h-48 space-y-1 overflow-auto">
          {installation.repositories.map((repository) => (
            <label key={repository.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selected.includes(repository.id)}
                onCheckedChange={() => toggle(repository.id)}
              />
              {repository.name}
            </label>
          ))}
        </div>
      )}
      <SegmentedControl
        ariaLabel="Access"
        value={access}
        onChange={setAccess}
        options={ACCESS_OPTIONS}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !installation || selected.length === 0}
          onClick={() =>
            installation &&
            onSave(access, { installation_id: installation.id, repository_ids: selected })
          }
        >
          {current ? 'Save' : 'Grant'}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
