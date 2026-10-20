import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import { Spinner } from '@renderer/lib/ui/spinner';
import { useGitHubConnection } from './connectors-queries';
import {
  NO_REPOSITORIES_NOTE,
  SSO_HIDDEN_NOTE,
  repositoriesActionLabel,
  repositoriesSummary,
} from './github-access';
import { type GitHubInstallation, connectedGitHub, matchingRepositories } from './github-grant';
import { RepositorySearchInput } from './repository-search-input';

/** Above this many, an opened account's directory gets a search above it. */
const SEARCH_FROM = 8;
/** How many names the directory shows before asking for a narrower search. */
const DIRECTORY_ROWS = 100;

/**
 * The repositories the person's GitHub connection reaches, on the connector's
 * page: one card per account the App is installed on, stacked, each opening
 * to a directory of names searched rather than scrolled once it is long.
 * Chosen on GitHub, so the action goes there, and re-read whenever the window
 * regains focus.
 */
export function GitHubAccessSection({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const github = useGitHubConnection(workspaceId, true);
  const reach = connectedGitHub(github.data);
  return (
    <section className="flex flex-col gap-3" aria-label="Repositories">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Repositories</h2>
          {reach && (
            <span className="text-xs text-foreground-muted">{repositoriesSummary(reach)}</span>
          )}
        </div>
        {reach && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void rpc.switchServers.openGitHubInstallation(serverId)}
          >
            {repositoriesActionLabel(reach)} <ExternalLink className="size-3.5" />
          </Button>
        )}
      </div>
      {github.isPending && (
        <p className="flex items-center gap-2 text-sm">
          <Spinner /> Loading repository access…
        </p>
      )}
      {github.isError && (
        <p role="alert" className="text-sm text-destructive">
          {failureText(github.error, 'Could not load repository access.')}
        </p>
      )}
      {reach &&
        (reach.installations.length === 0 ? (
          <p className="text-sm text-foreground-muted">{NO_REPOSITORIES_NOTE}</p>
        ) : (
          <div role="list" aria-label="Accounts" className="flex flex-col gap-2.5">
            {reach.installations.map((installation) => (
              <InstallationCard key={installation.id} installation={installation} />
            ))}
          </div>
        ))}
      {reach && (reach.sso_hidden_organizations?.length ?? 0) > 0 && (
        <p role="alert" className="text-sm text-foreground-warning">
          {SSO_HIDDEN_NOTE}
        </p>
      )}
    </section>
  );
}

/** One account the App is installed on: its name and count, opening to its directory. */
function InstallationCard({ installation }: { installation: GitHubInstallation }) {
  const [open, setOpen] = useState(false);
  const count = installation.repositories.length;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        role="listitem"
        className="rounded-[10px] border border-border bg-[var(--surface-2)] px-3.5 py-3"
      >
        <CollapsibleTrigger
          className="flex w-full cursor-pointer items-center gap-2 text-left"
          aria-label={`${open ? 'Hide' : 'Show'} the repositories under ${installation.account}`}
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-foreground-muted" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-foreground-muted" />
          )}
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {installation.account}
            </span>
            <span className="text-xs text-foreground-muted">
              {count} {count === 1 ? 'repository' : 'repositories'}
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3">
          <RepositoryDirectory installation={installation} />
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/**
 * An account's repositories laid out as a directory: names in columns, in a
 * fixed-height area, with a search above once there are many.
 */
function RepositoryDirectory({ installation }: { installation: GitHubInstallation }) {
  const [query, setQuery] = useState('');
  const shown = matchingRepositories(installation, query, []);
  return (
    <div className="flex flex-col gap-2">
      {installation.repositories.length > SEARCH_FROM && (
        <RepositorySearchInput
          value={query}
          onChange={setQuery}
          label={`Search the repositories under ${installation.account}`}
          placeholder="Search repositories…"
        />
      )}
      {shown.length === 0 ? (
        <p className="px-1 text-xs text-foreground-muted">No repository matches “{query}”.</p>
      ) : (
        <ul
          aria-label={`Repositories under ${installation.account}`}
          className="grid max-h-64 grid-cols-2 gap-x-6 gap-y-0.5 overflow-auto text-sm xl:grid-cols-3"
        >
          {shown.slice(0, DIRECTORY_ROWS).map((repository) => (
            <li key={repository.id} className="truncate py-0.5" title={repository.name}>
              {repository.name}
            </li>
          ))}
          {shown.length > DIRECTORY_ROWS && (
            <li className="col-span-full py-0.5 text-xs text-foreground-muted">
              {shown.length - DIRECTORY_ROWS} more; search to narrow the list.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
