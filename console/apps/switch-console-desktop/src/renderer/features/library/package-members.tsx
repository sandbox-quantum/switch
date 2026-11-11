import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Link2, Loader2, Plus, Search, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import {
  Dialog,
  DialogContent,
  DialogContentArea,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Input } from '@renderer/lib/ui/input';
import type { LibraryItem, PackageMemberKind } from '@shared/core/switch-servers/library';
import { KIND_TEXT, libraryItemOpens, removalText, type Viewer } from './library-model';
import { invalidateLibrary, libraryItemsKey } from './library-queries';
import { LOCKED_ROW_HINT, LockedMark, OpensMark } from './row-access';

export const packageMembersKey = (
  workspaceId: string,
  packageId: string,
  kind: PackageMemberKind
) => ['package-members', workspaceId, packageId, kind];

/**
 * What a package holds: its references and documents, each opening its own
 * page for whoever may open it. Whoever may change the package adds and removes them; taking one out
 * says which rooms lost it.
 */
export function PackageMembers({
  serverId,
  workspaceId,
  pkg,
  canEdit,
  viewer,
}: {
  serverId: string;
  workspaceId: string;
  pkg: LibraryItem;
  canEdit: boolean;
  viewer: Viewer;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      {notice !== null && (
        <Alert>
          <AlertDescription className="flex items-start justify-between gap-3">
            <span>{notice}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="cursor-pointer text-foreground-muted hover:text-foreground"
              onClick={() => setNotice(null)}
            >
              <X className="size-3.5" />
            </button>
          </AlertDescription>
        </Alert>
      )}
      {(['references', 'documents'] as const).map((kind) => (
        <MemberSection
          key={kind}
          serverId={serverId}
          workspaceId={workspaceId}
          pkg={pkg}
          kind={kind}
          canEdit={canEdit}
          viewer={viewer}
          onRemoved={setNotice}
        />
      ))}
    </>
  );
}

function MemberSection({
  serverId,
  workspaceId,
  pkg,
  kind,
  canEdit,
  viewer,
  onRemoved,
}: {
  serverId: string;
  workspaceId: string;
  pkg: LibraryItem;
  kind: PackageMemberKind;
  canEdit: boolean;
  viewer: Viewer;
  onRemoved: (notice: string) => void;
}) {
  const queryClient = useQueryClient();
  const { navigate } = useNavigate();
  const text = KIND_TEXT[kind];
  const members = useQuery({
    queryKey: packageMembersKey(workspaceId, pkg.id, kind),
    queryFn: () => rpc.workspaces.listPackageMembers({ workspaceId, packageId: pkg.id, kind }),
  });
  const [adding, setAdding] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(member: LibraryItem) {
    setBusy(member.id);
    setError(null);
    let removal;
    try {
      removal = await rpc.workspaces.removePackageMember({
        workspaceId,
        packageId: pkg.id,
        kind,
        memberId: member.id,
      });
    } catch (cause) {
      setError(failureText(cause, `Could not remove ${member.name} from the package.`));
      setBusy(null);
      setArmed(null);
      return;
    }
    // Removed: only the removal speaks for itself. Refreshing what shows it
    // comes after, so a refresh that fails cannot report the removal as failed.
    onRemoved(removalText(member.name, removal));
    setBusy(null);
    setArmed(null);
    await refreshAfterChange(queryClient, workspaceId, pkg.id, kind).catch(() => {});
  }

  return (
    <section aria-label={text.title} className="flex flex-col gap-2.5">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{text.title} in this package</h2>
        {canEdit && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add {text.noun}
          </Button>
        )}
      </div>
      {members.isPending ? (
        <Loader2 className="size-4 animate-spin text-foreground-muted" />
      ) : members.isError ? (
        <p className="text-xs text-destructive">
          {failureText(members.error, `Could not list the package’s ${text.title.toLowerCase()}.`)}
        </p>
      ) : members.data.length === 0 ? (
        <p className="text-sm text-foreground-muted">No {text.title.toLowerCase()} in it yet.</p>
      ) : (
        <List>
          {members.data.map((member) => (
            <div key={member.id} className="flex items-center gap-2 px-3.5 py-2.5">
              <MemberRow
                member={member}
                kind={kind}
                onOpen={
                  libraryItemOpens(member, viewer)
                    ? () => navigate('libraryItem', { serverId, kind, itemId: member.id })
                    : null
                }
              />
              {canEdit && armed === member.id ? (
                <span className="flex shrink-0 items-center gap-1">
                  <span className="text-xs text-foreground-muted">
                    Rooms that have it only through this package lose it.
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => setArmed(null)}
                  >
                    Keep
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy !== null}
                    autoFocus
                    onClick={() => void remove(member)}
                  >
                    {busy === member.id ? <Loader2 className="animate-spin" /> : 'Remove'}
                  </Button>
                </span>
              ) : (
                canEdit && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${member.name} from the package`}
                    title="Remove from the package"
                    disabled={busy !== null}
                    onClick={() => setArmed(member.id)}
                  >
                    <X />
                  </Button>
                )
              )}
            </div>
          ))}
        </List>
      )}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
      {adding && (
        <AddMemberDialog
          workspaceId={workspaceId}
          pkg={pkg}
          kind={kind}
          inPackage={new Set((members.data ?? []).map((member) => member.id))}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}

/** The references or documents the viewer can read that the package does not hold yet. */
function AddMemberDialog({
  workspaceId,
  pkg,
  kind,
  inPackage,
  onClose,
}: {
  workspaceId: string;
  pkg: LibraryItem;
  kind: PackageMemberKind;
  inPackage: Set<string>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const text = KIND_TEXT[kind];
  const items = useQuery({
    queryKey: libraryItemsKey(workspaceId, kind),
    queryFn: () => rpc.workspaces.listLibraryItems({ workspaceId, kind }),
  });
  const [filter, setFilter] = useState('');
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needle = filter.trim().toLowerCase();
  const shown = (items.data ?? [])
    .filter((item) => !inPackage.has(item.id) && !done.has(item.id))
    .filter(
      (item) =>
        !needle ||
        item.name.toLowerCase().includes(needle) ||
        item.description.toLowerCase().includes(needle)
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  async function add(item: LibraryItem) {
    setBusy(item.id);
    setError(null);
    try {
      await rpc.workspaces.addPackageMember({
        workspaceId,
        packageId: pkg.id,
        kind,
        memberId: item.id,
      });
      setDone((current) => new Set(current).add(item.id));
    } catch (cause) {
      setError(failureText(cause, `Could not add ${item.name} to the package.`));
      return;
    } finally {
      setBusy(null);
    }
    // As for removing: a refresh that fails does not make the add a failure.
    await refreshAfterChange(queryClient, workspaceId, pkg.id, kind).catch(() => {});
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Add {text.title.toLowerCase()} to {pkg.name}
          </DialogTitle>
        </DialogHeader>
        <DialogContentArea className="flex flex-col gap-3 pt-0">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground-muted" />
            <Input
              autoFocus
              className="pl-8"
              placeholder={`Search ${text.title.toLowerCase()}…`}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          {items.isPending ? (
            <Loader2 className="size-4 animate-spin text-foreground-muted" />
          ) : items.isError ? (
            <p className="text-xs text-destructive">
              {failureText(items.error, `Could not list the ${text.title.toLowerCase()}.`)}
            </p>
          ) : shown.length === 0 ? (
            <p className="text-sm text-foreground-muted">
              {needle
                ? `No ${text.noun} matches.`
                : `Every ${text.noun} you can see is already in it.`}
            </p>
          ) : (
            <div className="flex max-h-80 flex-col overflow-y-auto">
              {shown.map((item) => (
                <div key={item.id} className="flex items-center gap-2 py-1.5">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-foreground">{item.name}</span>
                    {(item.typeLabel || item.description) && (
                      <span className="truncate text-xs text-foreground-muted">
                        {[item.typeLabel, item.description].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void add(item)}
                  >
                    {busy === item.id ? <Loader2 className="animate-spin" /> : 'Add'}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {error !== null && <p className="text-xs text-destructive">{error}</p>}
          <p className="text-xs text-foreground-muted">
            The server takes only what the package’s owner can see.
          </p>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={onClose}>
              Done
            </Button>
          </div>
        </DialogContentArea>
      </DialogContent>
    </Dialog>
  );
}

/** A package's contents changed: its members, counts, and the items' own "in packages" read again. */
async function refreshAfterChange(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
  packageId: string,
  kind: PackageMemberKind
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: packageMembersKey(workspaceId, packageId, kind) }),
    invalidateLibrary(queryClient, workspaceId, 'packages'),
    invalidateLibrary(queryClient, workspaceId, kind),
  ]);
}

function List({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
      {children}
    </div>
  );
}

/**
 * One thing a package holds. It opens its page for whoever may open it; for
 * anyone else, an item its owner keeps private, it is named without a link,
 * dimmed and locked, since its page would refuse them.
 */
function MemberRow({
  member,
  kind,
  onOpen,
}: {
  member: LibraryItem;
  kind: PackageMemberKind;
  onOpen: (() => void) | null;
}) {
  const locked = onOpen === null;
  const content = (
    <>
      {kind === 'references' ? (
        <Link2 className="size-4 shrink-0 text-foreground-muted" />
      ) : (
        <FileText className="size-4 shrink-0 text-foreground-muted" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={`flex items-center gap-1.5 text-sm ${locked ? 'text-foreground-muted' : 'text-foreground'}`}
        >
          <span className="truncate">{member.name}</span>
          {locked && <LockedMark />}
        </span>
        {(member.typeLabel || member.description) && (
          <span className="truncate text-xs text-foreground-muted">
            {[member.typeLabel, member.description].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
    </>
  );
  if (onOpen === null) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-3" title={LOCKED_ROW_HINT}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
      onClick={onOpen}
    >
      {content}
      <OpensMark />
    </button>
  );
}
