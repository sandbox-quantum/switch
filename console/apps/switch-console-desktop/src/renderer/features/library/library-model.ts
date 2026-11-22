import type {
  PackageMemberRemoval,
  LibraryItem,
  LibraryKind,
  LibraryVisibility,
} from '@shared/core/switch-servers/library';

/** The three settings a library item can have, as one choice rather than two flags. */
export type LibraryAccess = 'private' | 'shared' | 'open';

export const LIBRARY_ACCESS_OPTIONS: { value: LibraryAccess; label: string; hint: string }[] = [
  { value: 'private', label: 'Private', hint: 'Only you and admins can see it or attach it.' },
  {
    value: 'shared',
    label: 'Shared',
    hint: 'Everyone on the workspace can see it and attach it to rooms. Only you change it.',
  },
  {
    value: 'open',
    label: 'Open',
    hint: 'Everyone on the workspace can see it, attach it and change it.',
  },
];

export const ACCESS_SHORT: Record<LibraryAccess, string> = {
  private: 'Private',
  shared: 'Shared',
  open: 'Open',
};

export function accessOf(item: {
  readVisibility: LibraryVisibility;
  writeVisibility: LibraryVisibility;
}): LibraryAccess {
  if (item.readVisibility === 'private') return 'private';
  return item.writeVisibility === 'public' ? 'open' : 'shared';
}

export function visibilityOf(access: LibraryAccess): {
  readVisibility: LibraryVisibility;
  writeVisibility: LibraryVisibility;
} {
  return {
    readVisibility: access === 'private' ? 'private' : 'public',
    writeVisibility: access === 'open' ? 'public' : 'private',
  };
}

/** Who is looking: their id, and whether they administer the workspace. */
export type Viewer = { id: string | null; isAdmin: boolean };

/**
 * What the viewer may do with an item, as the server says. The server's flags
 * are taken together: if it sends either, a flag it leaves out counts as no,
 * so its answer is never mixed with the rule below. Only a server too old to
 * send either leaves it to the server's rule, mirrored here: its owner and
 * admins change and delete it, and anyone changes an open one. The server
 * still checks every change.
 */
export function libraryPermissions(
  item: Pick<LibraryItem, 'ownerId' | 'writeVisibility' | 'canEdit' | 'canManage'>,
  viewer: Viewer
): { canEdit: boolean; canDelete: boolean; canChangeAccess: boolean } {
  if (item.canEdit !== undefined || item.canManage !== undefined) {
    const manage = item.canManage ?? false;
    // Access decides who else may change it, so it goes with managing it.
    return { canEdit: item.canEdit ?? false, canDelete: manage, canChangeAccess: manage };
  }
  const owns = viewer.isAdmin || (viewer.id !== null && item.ownerId === viewer.id);
  return {
    canEdit: owns || (viewer.id !== null && item.writeVisibility === 'public'),
    canDelete: owns,
    // Access decides who else may change it, so it stays with the owner and admins.
    canChangeAccess: owns,
  };
}

/**
 * Whether the viewer may open an item's own page. A package lists everything
 * in it to whoever may read the package, including an item its owner keeps
 * private, whose page would refuse them. A server too old to say leaves it to
 * the rule: its owner, an admin, or anyone when it is open to read.
 */
export function libraryItemOpens(
  item: Pick<LibraryItem, 'ownerId' | 'readVisibility' | 'canRead'>,
  viewer: Viewer
): boolean {
  if (item.canRead !== undefined) return item.canRead;
  return (
    viewer.isAdmin ||
    item.readVisibility === 'public' ||
    (viewer.id !== null && item.ownerId === viewer.id)
  );
}

export const KIND_TEXT: Record<
  LibraryKind,
  { title: string; noun: string; Noun: string; none: string }
> = {
  references: {
    title: 'References',
    noun: 'reference',
    Noun: 'Reference',
    none: 'No references here yet. Add one to point your agents at a repository, a doc or a page.',
  },
  documents: {
    title: 'Documents',
    noun: 'document',
    Noun: 'Document',
    none: 'No documents here yet. Write one to give your agents notes or instructions to share.',
  },
  packages: {
    title: 'Packages',
    noun: 'package',
    Noun: 'Package',
    none: 'No packages here yet. Make one to attach a set of references and documents to a room in one go.',
  },
};

export type LibraryFilter = {
  mineOnly: boolean;
  query: string;
  /** A reference type slug, or null for any. */
  type: string | null;
};

export const NO_LIBRARY_FILTER: LibraryFilter = { mineOnly: false, query: '', type: null };

/** `filter` with its type kept only if `types` still offers it. */
export function offeredLibraryFilter(
  filter: LibraryFilter,
  types: readonly { value: string }[]
): LibraryFilter {
  const offered = filter.type !== null && types.some((each) => each.value === filter.type);
  return { ...filter, type: offered ? filter.type : null };
}

/** The items the filter row lets through, by name. */
export function filterLibraryItems(
  items: readonly LibraryItem[],
  filter: LibraryFilter,
  viewerId: string | null
): LibraryItem[] {
  const needle = filter.query.trim().toLowerCase();
  return items
    .filter((item) => !filter.mineOnly || (viewerId !== null && item.ownerId === viewerId))
    .filter((item) => filter.type === null || item.type === filter.type)
    .filter(
      (item) =>
        needle.length === 0 ||
        item.name.toLowerCase().includes(needle) ||
        item.description.toLowerCase().includes(needle) ||
        (item.typeLabel ?? '').toLowerCase().includes(needle)
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The reference types the items carry, for the type filter. */
export function typeOptions(items: readonly LibraryItem[]): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (item.type !== null && !seen.has(item.type))
      seen.set(item.type, item.typeLabel ?? item.type);
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The links typed into a reference, one per line, without blanks or surrounding space. */
export function parseUrls(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function ownerText(
  item: Pick<LibraryItem, 'ownerId' | 'ownerName'>,
  viewerId: string | null
) {
  if (viewerId !== null && item.ownerId === viewerId) return 'Owned by you';
  return item.ownerName ? `Owned by ${item.ownerName}` : null;
}

/** The rooms a viewer cannot open, which the server counts but never names. */
export function hiddenRoomsText(count: number): string {
  return count === 1 ? '1 private room you can’t open' : `${count} private rooms you can’t open`;
}

/** "2 references · 1 document", or "Empty" for a package holding nothing. */
export function packageContentsText(item: Pick<LibraryItem, 'referencesCount' | 'documentsCount'>) {
  const parts = [
    item.referencesCount > 0
      ? `${item.referencesCount} ${item.referencesCount === 1 ? 'reference' : 'references'}`
      : null,
    item.documentsCount > 0
      ? `${item.documentsCount} ${item.documentsCount === 1 ? 'document' : 'documents'}`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Empty';
}

export function roomsText(count: number): string {
  return count === 0 ? 'In no rooms' : count === 1 ? 'In 1 room' : `In ${count} rooms`;
}

/** What removing an item cost, in words: the rooms that lost it, the private ones counted. */
export function removalText(name: string, removal: PackageMemberRemoval): string {
  const hidden = removal.hiddenAffectedRoomsCount;
  const rooms = [
    ...removal.affectedRoomNames,
    ...(hidden > 0
      ? [hidden === 1 ? '1 private room you can’t open' : `${hidden} private rooms you can’t open`]
      : []),
  ];
  if (rooms.length === 0) return `Removed ${name}. No room had it only through this package.`;
  return `Removed ${name}. These rooms had it only through this package, and no longer have it: ${rooms.join(', ')}.`;
}
