import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import {
  type ConnectedGitHub,
  type GitHubGrantChoice,
  chosenInstallation,
  chosenRepositories,
  githubAccessOptions,
  matchingRepositories,
  withEveryRepository,
  withInstallation,
  withRepository,
  withoutRepository,
} from './github-grant';
import { RepositorySearchInput } from './repository-search-input';

/** How many matches the Add repository search lists before asking for more letters. */
const SEARCH_ROWS = 8;

/** One chosen repository, removable. Sized to read beside the page's text, not as a tag. */
export function RepositoryChip({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <li className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-[var(--surface-2)] py-1 pr-1 pl-2.5 text-sm text-foreground">
      <span className="truncate">{name}</span>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-foreground-muted hover:bg-[var(--fill-2)] hover:text-foreground"
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </button>
    </li>
  );
}

/**
 * Chooses what an agent's GitHub access names: the account only where the
 * App is on several, the repositories as chips with a search to add one and
 * Add all for every one, and whether it may push, which the server may
 * allow only reading of (`readOnlyReason`, said beside the choice).
 */
export function GitHubGrantPicker({
  github,
  value,
  readOnlyReason,
  onChange,
}: {
  github: ConnectedGitHub;
  value: GitHubGrantChoice;
  /** Why the server's App lets agents read only; null where pushing can be granted. */
  readOnlyReason: string | null;
  onChange: (choice: GitHubGrantChoice) => void;
}) {
  const [query, setQuery] = useState('');
  const installation = chosenInstallation(github, value);
  const chosen = chosenRepositories(github, value);
  const matches =
    installation && query.trim() !== ''
      ? matchingRepositories(installation, query, value.repositoryIds)
      : [];
  const allChosen =
    installation !== undefined && value.repositoryIds.length >= installation.repositories.length;

  return (
    <div className="flex flex-col gap-3">
      {github.installations.length > 1 && (
        <Select
          value={value.installationId === null ? null : String(value.installationId)}
          onValueChange={(next) => onChange(withInstallation(value, next ? Number(next) : null))}
        >
          <SelectTrigger aria-label="GitHub account" className="w-full">
            <SelectValue placeholder="Choose a GitHub account">{installation?.account}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {github.installations.map((candidate) => (
              <SelectItem key={candidate.id} value={String(candidate.id)}>
                {candidate.account}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {installation && (
        <>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <RepositorySearchInput
                value={query}
                onChange={setQuery}
                label="Add repository"
                placeholder="Add repository…"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={allChosen}
              onClick={() => onChange(withEveryRepository(github, value))}
            >
              Add all
            </Button>
          </div>
          {query.trim() !== '' && matches.length === 0 && (
            <p className="px-1 text-xs text-foreground-muted">
              No repository it reaches matches “{query}”.
            </p>
          )}
          {matches.length > 0 && (
            <div
              role="listbox"
              aria-label="Matching repositories"
              className="divide-y divide-border overflow-hidden rounded-[10px] border border-border"
            >
              {matches.slice(0, SEARCH_ROWS).map((repository) => (
                <button
                  key={repository.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    onChange(withRepository(value, repository.id));
                    setQuery('');
                  }}
                  className="flex w-full cursor-pointer items-center bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--fill)]"
                >
                  {repository.name}
                </button>
              ))}
              {matches.length > SEARCH_ROWS && (
                <p className="px-3 py-2 text-xs text-foreground-muted">
                  {matches.length - SEARCH_ROWS} more match; type more of the name.
                </p>
              )}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-foreground-muted">
              {chosen.length === 0
                ? 'No repository chosen.'
                : `${chosen.length} of ${installation.repositories.length} chosen`}
            </span>
            {chosen.length > 0 && (
              <ul
                aria-label="Chosen repositories"
                className="flex max-h-40 flex-wrap gap-1.5 overflow-auto"
              >
                {chosen.map((repository) => (
                  <RepositoryChip
                    key={repository.id}
                    name={repository.name}
                    onRemove={() => onChange(withoutRepository(value, repository.id))}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      <SegmentedControl
        ariaLabel="Access"
        value={value.access}
        onChange={(access) => onChange({ ...value, access })}
        options={githubAccessOptions(readOnlyReason)}
      />
      {readOnlyReason && (
        <p role="status" className="px-1 text-xs text-foreground-muted">
          {readOnlyReason}
        </p>
      )}
    </div>
  );
}
