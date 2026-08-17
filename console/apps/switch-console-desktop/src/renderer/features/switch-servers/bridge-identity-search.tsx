import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useDebounce } from '@renderer/lib/hooks/useDebounce';
import { rpc } from '@renderer/lib/ipc';
import { useModalContext } from '@renderer/lib/modal/modal-provider';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Spinner } from '@renderer/lib/ui/spinner';
import type {
  BridgeDirectorySearchResult,
  BridgeDirectoryUser,
  ClaimIdentityResult,
  LinkedIdentity,
} from '@shared/core/switch-servers/switch-servers';
import { switchServersStore } from './switch-servers-store';
import { useMyIdentities } from './use-my-identities';

/** How long to wait after the last keystroke before asking the platform. Every
 * search is a live call out to Slack or Mattermost, so this is a courtesy to
 * their rate limits as much as to ours. */
const SEARCH_DEBOUNCE_MS = 300;

/** Below this the directory returns most of the workspace, which is neither
 * useful to scan nor cheap to fetch. */
const MIN_QUERY_LENGTH = 2;

/**
 * Find yourself in a messaging app's directory and say that account is you.
 *
 * Two surfaces ask for this — the modal reached from a server's messaging-app
 * row, and the last step of connecting to a server — so the search, the claim
 * and every way either can fail live here rather than in whichever one was
 * written first.
 */
export const BridgeIdentitySearch = observer(function BridgeIdentitySearch({
  serverId,
  bridgeId,
  bridgeDisplayName,
  platform,
  directorySearchSupported,
  autoFocus,
  onClaimed,
}: {
  serverId: string;
  bridgeId: string;
  /** The workspace being searched — two connections on the same platform can
   * exist, and only the name tells them apart. */
  bridgeDisplayName: string;
  /** The platform as a person names it, for prose about what is searchable. */
  platform: string;
  directorySearchSupported: boolean;
  autoFocus: boolean;
  onClaimed: (identity: LinkedIdentity) => void;
}) {
  const { setCloseGuard } = useModalContext();
  const queryClient = useQueryClient();
  const currentUserId = switchServersStore.statusFor(serverId)?.user?.id ?? null;

  const [search, setSearch] = useState('');
  const [claiming, setClaiming] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { refresh: refreshIdentities } = useMyIdentities(serverId || null);

  const debouncedQuery = useDebounce(search.trim(), SEARCH_DEBOUNCE_MS);
  const searchable = !!serverId && debouncedQuery.length >= MIN_QUERY_LENGTH;
  const directoryQuery = useQuery({
    queryKey: ['bridge-directory', serverId, bridgeId, debouncedQuery],
    queryFn: () =>
      rpc.switchServers.searchBridgeDirectory({ serverId, bridgeId, query: debouncedQuery }),
    enabled: searchable,
  });

  const handleClaim = async (person: BridgeDirectoryUser) => {
    setClaiming(person.externalUserId);
    setCloseGuard(true);
    setError(null);
    try {
      const result = await rpc.switchServers.claimBridgeIdentity({
        serverId,
        bridgeId,
        externalUserId: person.externalUserId,
        username: person.username,
      });
      if (result.kind !== 'claimed') {
        setError(claimFailureText(result));
        return;
      }
      refreshIdentities();
      onClaimed(result.identity);
    } catch (cause) {
      setError(failureText(cause, 'Could not link this account.'));
    } finally {
      setClaiming(null);
      setCloseGuard(false);
    }
  };

  // Undo, in place: the row the user just linked is the row they look at when
  // they realise it is the wrong account, so the search stays open and the
  // directory is re-read to show who is left holding the account.
  const handleRelease = async (person: BridgeDirectoryUser) => {
    if (person.knownExternalUserId === null) return;
    setReleasing(person.externalUserId);
    setCloseGuard(true);
    setError(null);
    try {
      await rpc.switchServers.releaseBridgeIdentity({
        serverId,
        bridgeId,
        identityId: person.knownExternalUserId,
        userId: currentUserId,
      });
      refreshIdentities();
      await queryClient.invalidateQueries({ queryKey: ['bridge-directory', serverId, bridgeId] });
    } catch (cause) {
      setError(failureText(cause, 'Could not unlink this account.'));
    } finally {
      setReleasing(null);
      setCloseGuard(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <Field>
        <FieldLabel>Search {bridgeDisplayName}</FieldLabel>
        <Input
          autoFocus={autoFocus}
          placeholder="Your name, handle or email"
          value={search}
          spellCheck={false}
          onChange={(e) => {
            setSearch(e.target.value);
            setError(null);
          }}
        />
      </Field>

      <DirectoryResults
        query={debouncedQuery}
        searchable={searchable}
        platform={platform}
        hasDirectory={directorySearchSupported}
        isFetching={directoryQuery.isFetching}
        result={directoryQuery.data ?? null}
        fetchError={directoryQuery.error}
        currentUserId={currentUserId}
        claimingId={claiming}
        releasingId={releasing}
        onClaim={(person) => void handleClaim(person)}
        onRelease={(person) => void handleRelease(person)}
      />

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
});

function DirectoryResults({
  query,
  searchable,
  platform,
  hasDirectory,
  isFetching,
  result,
  fetchError,
  currentUserId,
  claimingId,
  releasingId,
  onClaim,
  onRelease,
}: {
  query: string;
  searchable: boolean;
  /** The platform as a person names it, for the line that says what is being
   * searched. */
  platform: string;
  /** Whether the platform has a directory at all. When it does not, the only
   * people findable are those Switch has already seen — so the prompt has to
   * say that rather than promise a workspace directory the platform has no
   * concept of. */
  hasDirectory: boolean;
  isFetching: boolean;
  result: BridgeDirectorySearchResult | null;
  fetchError: unknown;
  currentUserId: string | null;
  /** The platform id of the account being linked, or null when none is. */
  claimingId: string | null;
  /** The platform id of the account being unlinked, or null when none is. */
  releasingId: string | null;
  onClaim: (person: BridgeDirectoryUser) => void;
  onRelease: (person: BridgeDirectoryUser) => void;
}) {
  if (!searchable) {
    return (
      <p className="text-xs text-foreground-muted">
        {hasDirectory
          ? `Type at least ${MIN_QUERY_LENGTH} characters to search the workspace directory.`
          : `Type at least ${MIN_QUERY_LENGTH} characters to search the people Switch has seen on ${platform}. It has no directory to search — someone appears here once they have sent a message.`}
      </p>
    );
  }
  if (fetchError) {
    return (
      <p className="text-destructive text-xs">
        {failureText(fetchError, 'Could not search the directory.')}
      </p>
    );
  }
  if (isFetching && result === null) {
    return (
      <p className="flex items-center gap-2 text-xs text-foreground-muted">
        <Spinner className="size-3.5" />
        Searching…
      </p>
    );
  }
  if (result === null) return null;

  // A platform with no directory to search is not an empty result — the server
  // says what has to happen instead, and that is the only useful thing to show.
  if (result.kind === 'unsupported' || result.kind === 'bridge-unavailable') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <span>{result.message}</span>
      </div>
    );
  }
  if (result.kind === 'unauthenticated') {
    return (
      <p className="text-destructive text-xs">
        Your session for this server expired. Sign in again, then retry.
      </p>
    );
  }
  if (result.kind === 'error') {
    return <p className="text-destructive text-xs">{result.message}</p>;
  }
  // Set when the platform has no directory and the server answered from the
  // accounts it has already seen. The list is real but cannot be complete, so
  // it is captioned rather than replaced — replacing it is what left Telegram
  // with a warning and no way forward.
  const narrowed = result.note !== null && (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <span>{result.note}</span>
    </div>
  );

  if (result.users.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {narrowed}
        <p className="text-xs text-foreground-muted">
          {result.note === null
            ? `Nobody in this workspace matches “${query}”.`
            : `Nobody Switch has seen here matches “${query}”.`}
        </p>
      </div>
    );
  }

  // Nothing here is disabled because someone else holds the account: several
  // people can be recognised on the same one, and the other claimants are shown
  // so a shared or misidentified account is visible rather than silent.
  const pending = claimingId !== null || releasingId !== null;
  return (
    <div className="flex flex-col gap-2">
      {narrowed}
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {result.users.map((person) => {
          const linkedToMe = person.claimedBy.some((c) => c.userId === currentUserId);
          const others = person.claimedBy.filter((c) => c.userId !== currentUserId);
          return (
            <li
              key={person.externalUserId}
              className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-foreground">{person.displayName}</span>
                <span className="truncate text-xs text-foreground-muted">
                  @{person.username}
                  {person.email ? ` · ${person.email}` : ''}
                </span>
                {others.length > 0 && (
                  <span className="truncate text-xs text-foreground-muted">
                    Also linked to {others.map((c) => c.userName).join(', ')}
                  </span>
                )}
              </div>
              {linkedToMe ? (
                <span className="flex shrink-0 items-center gap-2">
                  <Badge variant="secondary">Linked to you</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending || person.knownExternalUserId === null}
                    onClick={() => onRelease(person)}
                  >
                    {releasingId === person.externalUserId ? 'Unlinking…' : 'Unlink'}
                  </Button>
                </span>
              ) : (
                <Button size="sm" disabled={pending} onClick={() => onClaim(person)}>
                  {claimingId === person.externalUserId ? 'Linking…' : 'This is me'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Turn a failed claim into something the user can act on. */
function claimFailureText(result: Exclude<ClaimIdentityResult, { kind: 'claimed' }>): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'bridge-unavailable':
      return result.message;
    case 'error':
      return result.message;
  }
}
