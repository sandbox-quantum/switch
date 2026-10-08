import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionGrant } from '@shared/core/switch-servers/connection-grants';
import type { GitHubInstallation } from '@shared/core/switch-servers/github-connection';
import {
  type GitHubAccess,
  gitHubAccess,
  GITHUB_SLUG,
  withGitHubAccess,
} from './connection-grants';
import { ConnectionIcon } from './connection-icon';
import type { ConnectionCatalog } from './connections-step';

type AccessChoice = GitHubAccess['kind'];

const ACCESS_OPTIONS: readonly { value: AccessChoice; label: string }[] = [
  { value: 'none', label: 'No access' },
  { value: 'all', label: 'All repositories' },
  { value: 'selected', label: 'Selected repositories' },
];

/**
 * The connections a cloud agent is granted. Lists the owner's connected,
 * enabled connections; for GitHub, each installation (account) gets no access,
 * all its repositories, or the ones chosen. Nothing here is required: an agent
 * with no grant is still created.
 */
export function ConnectionGrantsEditor({
  catalog,
  value,
  onChange,
  onConnect,
}: {
  catalog: ConnectionCatalog;
  value: ConnectionGrant[];
  onChange: (value: ConnectionGrant[]) => void;
  /** Opens the Connections page, to connect or reconnect a service. */
  onConnect: () => void;
}) {
  const { connections, error, github, reload } = catalog;
  if (error)
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button variant="outline" size="sm" onClick={() => void reload()}>
          Retry
        </Button>
      </div>
    );
  if (connections === null)
    return (
      <p role="status" className="flex items-center gap-2 text-sm">
        <Spinner /> Loading connections…
      </p>
    );
  const githubEntry = connections.find((entry) => entry.slug === GITHUB_SLUG && entry.enabled);
  const others = connections.filter(
    (entry) => entry.slug !== GITHUB_SLUG && entry.enabled && entry.status === 'connected'
  );
  const installations = github?.status === 'connected' ? github.installations : [];
  const shown = new Set(installations.map((installation) => installation.id));
  const orphaned =
    github?.status === 'connected'
      ? (value
          .find((grant) => grant.slug === GITHUB_SLUG)
          ?.installations.filter((installation) => !shown.has(installation.installation_id)) ?? [])
      : [];
  return (
    <div className="space-y-3">
      {githubEntry && (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <ConnectionIcon slug={githubEntry.slug} name={githubEntry.name} />
            <span className="text-sm font-medium">{githubEntry.name}</span>
          </div>
          {githubEntry.status !== 'connected' || github?.status === 'not_connected' ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-foreground-muted">
                Not connected. Connect GitHub to give this agent access to your repositories.
              </p>
              <Button variant="outline" size="sm" onClick={onConnect}>
                Connect
              </Button>
            </div>
          ) : github === null || github.status === 'checking' ? (
            <p role="status" className="flex items-center gap-2 text-xs text-foreground-muted">
              <Spinner /> Checking GitHub access…
            </p>
          ) : github.status === 'reconnect' ? (
            <div className="flex items-center justify-between gap-3">
              <p role="alert" className="text-xs text-destructive">
                {github.message}
              </p>
              <Button variant="outline" size="sm" onClick={onConnect}>
                Reconnect
              </Button>
            </div>
          ) : github.status === 'error' ? (
            <div className="flex items-center justify-between gap-3">
              <p role="alert" className="text-xs text-destructive">
                {github.message}
              </p>
              <Button variant="outline" size="sm" onClick={() => void reload()}>
                Retry
              </Button>
            </div>
          ) : installations.length === 0 ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-foreground-muted">
                The Switch GitHub App is installed on no account yet. Choose repositories on GitHub
                to give agents access.
              </p>
              <Button variant="outline" size="sm" onClick={onConnect}>
                Manage
              </Button>
            </div>
          ) : (
            installations.map((installation) => (
              <InstallationGrant
                key={installation.id}
                installation={installation}
                access={gitHubAccess(value, installation.id)}
                onChange={(access) => onChange(withGitHubAccess(value, installation.id, access))}
              />
            ))
          )}
          {orphaned.map((installation) => (
            <div
              key={installation.installation_id}
              className="flex items-center justify-between gap-3"
            >
              <p className="text-xs text-foreground-muted">
                Access to a GitHub installation you can no longer see (
                {installation.installation_id}).
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onChange(withGitHubAccess(value, installation.installation_id, { kind: 'none' }))
                }
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      {others.map((entry) => (
        <div
          key={entry.slug}
          className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm"
        >
          <ConnectionIcon slug={entry.slug} name={entry.name} />
          <span className="font-medium">{entry.name}</span>
          <span className="ml-auto text-xs text-foreground-muted">
            Agents cannot use this connection yet.
          </span>
        </div>
      ))}
      {!githubEntry && others.length === 0 && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-foreground-muted">No connection is connected.</p>
          <Button variant="outline" size="sm" onClick={onConnect}>
            Connect
          </Button>
        </div>
      )}
    </div>
  );
}

function InstallationGrant({
  installation,
  access,
  onChange,
}: {
  installation: GitHubInstallation;
  access: GitHubAccess;
  onChange: (access: GitHubAccess) => void;
}) {
  return (
    <div className="space-y-2" role="group" aria-label={installation.account}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">{installation.account}</span>
        <SegmentedControl
          value={access.kind}
          onChange={(kind) =>
            onChange(
              kind === 'selected'
                ? { kind, repositories: access.kind === 'selected' ? access.repositories : [] }
                : { kind }
            )
          }
          options={ACCESS_OPTIONS}
          ariaLabel={`Access to ${installation.account}`}
          className="w-max"
        />
      </div>
      {access.kind === 'selected' && (
        <RepositoryPicker
          installation={installation}
          selected={access.repositories}
          onChange={(repositories) => onChange({ kind: 'selected', repositories })}
        />
      )}
    </div>
  );
}

function RepositoryPicker({
  installation,
  selected,
  onChange,
}: {
  installation: GitHubInstallation;
  selected: number[];
  onChange: (repositories: number[]) => void;
}) {
  const [query, setQuery] = useState('');
  const known = new Set(installation.repositories.map((repo) => repo.id));
  // A granted repository the installation no longer shares stays listed, so it can be removed.
  const repositories = [
    ...installation.repositories,
    ...selected
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: `Repository ${id} (no longer shared)` })),
  ];
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? repositories.filter((repo) => repo.name.toLowerCase().includes(needle))
    : repositories;
  const chosen = new Set(selected);
  const toggle = (id: number, checked: boolean) =>
    onChange(checked ? [...selected, id] : selected.filter((candidate) => candidate !== id));
  return (
    <div className="space-y-2">
      <SearchInput
        aria-label={`Search ${installation.account} repositories`}
        placeholder="Search repositories"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul
        aria-label={`${installation.account} repositories`}
        className="max-h-48 space-y-1 overflow-auto"
      >
        {visible.map((repo) => (
          <li key={repo.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-background-tertiary-2">
              <Checkbox
                checked={chosen.has(repo.id)}
                onCheckedChange={(checked) => toggle(repo.id, checked)}
                aria-label={repo.name}
              />
              <span className="truncate">{repo.name}</span>
            </label>
          </li>
        ))}
        {visible.length === 0 && (
          <li className="text-xs text-foreground-muted">
            {repositories.length === 0
              ? 'This account shares no repository with Switch.'
              : `No repository matches “${query}”.`}
          </li>
        )}
      </ul>
      <p className="text-xs text-foreground-muted">
        {selected.length} {selected.length === 1 ? 'repository' : 'repositories'} selected
      </p>
    </div>
  );
}
