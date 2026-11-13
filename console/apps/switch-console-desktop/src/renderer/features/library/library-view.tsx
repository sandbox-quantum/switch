import { useQuery } from '@tanstack/react-query';
import { FileText, Library, Link2, Package, Plus, Shapes } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { homeRedirect } from '@renderer/features/switch-servers/home-target';
import { ServerPage, ServerTableEmpty } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { administersWorkspaceInScope } from '@renderer/features/switch-servers/workspace-admin';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { FilterSelect } from '@renderer/lib/components/filter-select';
import { LIST_PAGE_WIDTH, ListToolbar } from '@renderer/lib/components/list-toolbar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import type { LibraryItem, LibraryKind } from '@shared/core/switch-servers/library';
import { LibraryCard } from './library-card';
import {
  filterLibraryItems,
  KIND_TEXT,
  libraryPermissions,
  NO_LIBRARY_FILTER,
  offeredLibraryFilter,
  typeOptions,
} from './library-model';
import { libraryItemsKey } from './library-queries';
import { ReferenceTypesPanel } from './reference-types';

function useViewParams() {
  return useParams('library').params;
}

const LibraryTitlebar = observer(function LibraryTitlebar() {
  return (
    <ServerSectionTitlebar serverId={useViewParams().serverId} icon={Library} label="Resources" />
  );
});

const KINDS = [
  { value: 'references', label: 'References', icon: Link2 },
  { value: 'documents', label: 'Documents', icon: FileText },
  { value: 'packages', label: 'Packages', icon: Package },
  { value: 'types', label: 'Reference types', icon: Shapes },
] as const satisfies readonly { value: LibraryTab; label: string; icon: typeof Link2 }[];

/** The page's tabs: each kind of item, and the types references take. */
type LibraryTab = LibraryKind | 'types';

const SCOPES = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Mine' },
] as const;

/**
 * The workspace's resources (the gateway's word; "library" in the code): the
 * references and documents anyone may attach to
 * a room, as cards. Each opens a page to change it, see the rooms it is in and
 * attach it to more.
 */
const LibraryPanel = observer(function LibraryPanel() {
  const { serverId, kind: initialKind } = useViewParams();
  const { navigate } = useNavigate();
  const showNew = useShowModal('newLibraryItemModal');
  const showDelete = useShowModal('deleteLibraryItemModal');
  const showType = useShowModal('referenceTypeModal');
  const [tab, setTab] = useState<LibraryTab>(initialKind ?? 'references');
  // Coming back from an item's page lands on that item's kind.
  useEffect(() => {
    if (initialKind) setTab(initialKind);
  }, [initialKind]);
  const onTypes = tab === 'types';
  // The items query and its words follow the tab; the types tab reads its own.
  const kind: LibraryKind = onTypes ? 'references' : tab;
  const [filter, setFilter] = useState(NO_LIBRARY_FILTER);
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const viewer = {
    id: switchServersStore.statusFor(serverId)?.user?.id ?? null,
    isAdmin: administersWorkspaceInScope(serverId),
  };
  const items = useQuery({
    queryKey: libraryItemsKey(workspaceId ?? '', kind),
    queryFn: () => rpc.workspaces.listLibraryItems({ workspaceId: workspaceId as string, kind }),
    enabled: workspaceId !== null && !onTypes,
  });
  const text = KIND_TEXT[kind];
  const all = items.data ?? [];
  const types = kind === 'references' ? typeOptions(all) : [];
  // A type applies only while it is on offer: not on Documents, and not once
  // the last reference of that type is gone (the filter would hide everything
  // with no option showing it is on), as the Rooms filters do.
  const applied = offeredLibraryFilter(filter, types);
  const shown = filterLibraryItems(all, applied, viewer.id);
  const filtering = applied.mineOnly || applied.query.trim() !== '' || applied.type !== null;

  const open = (item: LibraryItem) =>
    navigate('libraryItem', { serverId, kind: item.kind, itemId: item.id });
  const create = () => {
    if (workspaceId === null) return;
    if (onTypes) showType({ workspaceId, editing: null });
    else showNew({ workspaceId, kind, onSuccess: (created: LibraryItem) => open(created) });
  };
  const listLabel = onTypes ? 'reference types' : text.title.toLowerCase();

  return (
    <ServerPage
      width={LIST_PAGE_WIDTH}
      title="Resources"
      description="References, documents and packages of them that your agents can be given. Attach one to a room and every agent there can use it."
      action={
        <Button size="sm" disabled={workspaceId === null} onClick={create}>
          <Plus className="size-4" />
          {onTypes ? 'New reference type' : `New ${text.noun}`}
        </Button>
      }
    >
      {workspaceId === null ? (
        <ServerTableEmpty>
          This server has no workspace yet, so its resources cannot be read.
        </ServerTableEmpty>
      ) : (
        <div className="flex flex-col gap-4">
          <SegmentedControl
            ariaLabel="References, documents, packages or reference types"
            value={tab}
            onChange={setTab}
            options={KINDS}
            className="w-max"
          />
          <ListToolbar
            scope={
              viewer.id !== null && (
                <SegmentedControl
                  ariaLabel={`Whose ${listLabel}`}
                  value={filter.mineOnly ? 'mine' : 'all'}
                  onChange={(next) => setFilter({ ...filter, mineOnly: next === 'mine' })}
                  options={SCOPES}
                />
              )
            }
            search={
              <SearchInput
                containerClassName="w-full"
                className="h-8"
                value={filter.query}
                onChange={(e) => setFilter({ ...filter, query: e.target.value })}
                placeholder={`Search ${listLabel}…`}
                aria-label={`Search ${listLabel} by name and description`}
              />
            }
            filters={
              tab === 'references' &&
              types.length > 0 && (
                <FilterSelect
                  label="Type"
                  anyLabel="Any type"
                  value={applied.type}
                  options={types}
                  onChange={(type) => setFilter({ ...filter, type })}
                />
              )
            }
          />
          {tab === 'documents' && (
            // The server keeps an agent's room documents out of this list, which
            // surprises someone who knows one exists: say where it is.
            <p className="text-xs text-foreground-muted">
              Documents an agent writes in a room belong to that room, so they aren’t listed here.
              Find them in the room’s Resources tab.
            </p>
          )}
          {onTypes ? (
            <ReferenceTypesPanel workspaceId={workspaceId} viewerId={viewer.id} filter={filter} />
          ) : items.isPending ? (
            <p className="py-2 text-sm text-foreground-muted">Loading…</p>
          ) : items.isError ? (
            <div className="flex flex-col items-start gap-2 rounded-[11px] border border-border px-4 py-4">
              <p className="text-sm text-foreground-muted">
                {failureText(items.error, `Could not read the ${text.title.toLowerCase()}.`)}
              </p>
              <Button size="sm" variant="outline" onClick={() => void items.refetch()}>
                Try again
              </Button>
            </div>
          ) : shown.length === 0 ? (
            filtering ? (
              <p className="py-2 text-sm text-foreground-muted">
                {applied.mineOnly && all.length > 0 && !applied.query.trim() && !applied.type
                  ? `None of these ${text.title.toLowerCase()} are yours.`
                  : `No ${text.noun} matches.`}
              </p>
            ) : (
              <div className="flex flex-col items-start gap-3 rounded-[11px] border border-dashed border-border px-4 py-5">
                <p className="text-sm text-foreground-muted">{text.none}</p>
                <Button size="sm" variant="outline" onClick={create}>
                  <Plus className="size-3.5" />
                  New {text.noun}
                </Button>
              </div>
            )
          ) : (
            <div
              role="list"
              aria-label={text.title}
              className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-[14px]"
            >
              {shown.map((item) => (
                <div role="listitem" key={item.id}>
                  <LibraryCard
                    item={item}
                    viewerId={viewer.id}
                    showYours={!filter.mineOnly}
                    onOpen={() => open(item)}
                    onDelete={
                      libraryPermissions(item, viewer).canDelete
                        ? () => showDelete({ workspaceId, item })
                        : null
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </ServerPage>
  );
});

export const libraryView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string; kind?: LibraryKind }) => (
    <>{children}</>
  ),
  TitlebarSlot: LibraryTitlebar,
  MainPanel: LibraryPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return homeRedirect();
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string; kind?: LibraryKind }>;
