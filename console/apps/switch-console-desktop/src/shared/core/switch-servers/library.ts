/**
 * The workspace's library ("Resources" to people): references and documents
 * anyone may attach to a room, and packages bundling them, as the gateway's
 * Resources pages show them.
 */

/** The library kinds the Resources page lists. */
export type LibraryKind = 'references' | 'documents' | 'packages';

/** What a package can hold. */
export type PackageMemberKind = 'references' | 'documents';

/** Who may read, or change, a library item: its owner (and admins) alone, or everyone. */
export type LibraryVisibility = 'private' | 'public';

/** One library item as the list and its page show it. */
export type LibraryItem = {
  id: string;
  kind: LibraryKind;
  name: string;
  description: string;
  /** What agents are told about using it. */
  instructions: string;
  ownerId: string;
  /** Null when the server could not name the owner. */
  ownerName: string | null;
  readVisibility: LibraryVisibility;
  writeVisibility: LibraryVisibility;
  /** A reference's type slug ("github"); null for a document. */
  type: string | null;
  /** A reference's type as people read it ("GitHub"); null for a document. */
  typeLabel: string | null;
  /** A reference's links; empty for a document. */
  urls: string[];
  attachedRoomsCount: number;
  /**
   * Of those, the rooms the viewer may not open, which are never named to
   * them. Sent only to whoever may manage the item, by a server that counts
   * them; undefined from an older one.
   */
  hiddenRoomsCount?: number;
  /** The packages it is in, by id; empty for a package. */
  packageIds: string[];
  /** What a package holds, by kind; zero for anything else. */
  referencesCount: number;
  documentsCount: number;
  createdAt: string;
  /**
   * What the viewer may do with it, as the server decides: open its page,
   * change it, and delete it or change who may see or change it. Undefined
   * from a server too old to say, where the viewer's own rule stands in
   * (`libraryPermissions`).
   */
  canRead?: boolean;
  canEdit?: boolean;
  canManage?: boolean;
};

/** A document read in full. */
export type LibraryDocument = LibraryItem & { content: string };

/** A reference type a new reference may be given. */
export type ReferenceTypeOption = {
  type: string;
  displayName: string;
  /** What every reference of this type tells agents about using it. */
  instructions: string;
  /** What the links should point at, as the type describes it. */
  valueHint: string;
  isBuiltin: boolean;
  /** Who wrote a type of their own; null for a built-in one. */
  ownerName: string | null;
  ownerId: string | null;
};

/** A type the viewer may change (theirs, or any for an admin), with its settings. */
export type ManagedReferenceType = ReferenceTypeOption & {
  ownerId: string;
  readVisibility: LibraryVisibility;
  writeVisibility: LibraryVisibility;
  /** A built-in with the same slug hides it: references of that slug use the built-in. */
  shadowedByBuiltin: boolean;
  createdAt: string;
  /** As on `LibraryItem`; undefined from a server too old to say. */
  canEdit?: boolean;
  canManage?: boolean;
};

/** What a new reference type is made of. The slug cannot change afterwards. */
export type ReferenceTypeInput = {
  type: string;
  displayName: string;
  instructions: string;
  valueHint: string;
  readVisibility: LibraryVisibility;
  writeVisibility: LibraryVisibility;
};

/** The fields of a reference type to change; anything left out stays as it is. */
export type ReferenceTypeChanges = Partial<Omit<ReferenceTypeInput, 'type'>>;

/** What a new library item is made of. */
export type LibraryItemInput = {
  name: string;
  description: string;
  instructions: string;
  readVisibility: LibraryVisibility;
  writeVisibility: LibraryVisibility;
  /** A reference's type. */
  type?: string;
  /** A reference's links. */
  urls?: string[];
  /** A document's content. */
  content?: string;
};

/** The fields of a library item to change; anything left out stays as it is. */
export type LibraryItemChanges = Partial<Omit<LibraryItemInput, 'type'>>;

/** What deleting a library item took with it. */
export type LibraryDeleteResult = {
  detachedRoomIds: string[];
  affectedPackageIds: string[];
};

/** A room a library item is attached to. */
export type LibraryItemRoom = {
  roomId: string;
  roomName: string;
  /** Whether the viewer may detach the item from this room, when the server says. */
  canUnlink?: boolean;
};

/**
 * What taking something out of a package cost: the rooms that had it only
 * through the package, by name where the viewer may read them, the rest
 * counted (by a server that counts them).
 */
export type PackageMemberRemoval = {
  affectedRoomNames: string[];
  hiddenAffectedRoomsCount: number;
};
