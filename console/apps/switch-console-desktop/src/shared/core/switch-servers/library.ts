/**
 * The workspace's library: references and documents anyone may attach to a
 * room, as the gateway's Resources pages show them. Packages bundle them and
 * join later.
 */

/** The library kinds the Library page lists. */
export type LibraryKind = 'references' | 'documents';

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
  /** The packages it is in, by id. */
  packageIds: string[];
  createdAt: string;
};

/** A document read in full. */
export type LibraryDocument = LibraryItem & { content: string };

/** A reference type a new reference may be given. */
export type ReferenceTypeOption = {
  type: string;
  displayName: string;
  /** What the links should point at, as the type describes it. */
  valueHint: string;
  isBuiltin: boolean;
  /** Who wrote a type of their own; null for a built-in one. */
  ownerName: string | null;
};

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
