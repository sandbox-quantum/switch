import type {
  LibraryDeleteResult,
  LibraryDocument,
  LibraryItem,
  LibraryItemChanges,
  LibraryItemInput,
  LibraryItemRoom,
  LibraryKind,
  LibraryVisibility,
  PackageMemberKind,
  ManagedReferenceType,
  PackageMemberRemoval,
  ReferenceTypeChanges,
  ReferenceTypeInput,
  ReferenceTypeOption,
} from '@shared/core/switch-servers/library';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { gatewayFetch } from './gateway-client';

// The workspace library's references and documents, through the gateway's
// `/references` and `/documents` routes. Attaching one to a room is the room
// resources call in gateway-client.

type LibraryItemJson = {
  id: string;
  owner_id: string;
  owner_name?: string | null;
  read_visibility: string;
  write_visibility: string;
  name: string;
  description: string;
  instructions?: string;
  type?: string;
  type_display_name?: string | null;
  value?: { urls?: unknown };
  content?: string;
  attached_rooms_count?: number;
  references_count?: number;
  documents_count?: number;
  hidden_rooms_count?: number;
  packages?: string[];
  scope?: 'global' | 'room';
  created_at: string;
  can_read?: boolean;
  can_edit?: boolean;
  can_manage?: boolean;
};

/** The server's answers on what the viewer may do, where it gives them. */
function capabilities(r: { can_read?: boolean; can_edit?: boolean; can_manage?: boolean }) {
  return {
    ...(r.can_read !== undefined ? { canRead: r.can_read } : {}),
    ...(r.can_edit !== undefined ? { canEdit: r.can_edit } : {}),
    ...(r.can_manage !== undefined ? { canManage: r.can_manage } : {}),
  };
}

function visibility(value: string): LibraryVisibility {
  return value === 'public' ? 'public' : 'private';
}

export function mapLibraryItem(kind: LibraryKind, r: LibraryItemJson): LibraryItem {
  const urls = Array.isArray(r.value?.urls)
    ? r.value.urls.filter((url): url is string => typeof url === 'string')
    : [];
  return {
    id: r.id,
    kind,
    name: r.name,
    description: r.description,
    instructions: r.instructions ?? '',
    ownerId: r.owner_id,
    ownerName: r.owner_name ?? null,
    readVisibility: visibility(r.read_visibility),
    writeVisibility: visibility(r.write_visibility),
    type: kind === 'references' ? (r.type ?? null) : null,
    typeLabel: kind === 'references' ? (r.type_display_name ?? r.type ?? null) : null,
    urls,
    attachedRoomsCount: r.attached_rooms_count ?? 0,
    ...(r.hidden_rooms_count !== undefined ? { hiddenRoomsCount: r.hidden_rooms_count } : {}),
    packageIds: r.packages ?? [],
    referencesCount: r.references_count ?? 0,
    documentsCount: r.documents_count ?? 0,
    createdAt: r.created_at,
    ...capabilities(r),
  };
}

function itemPath(kind: LibraryKind, id: string): string {
  return `/${kind}/${encodeURIComponent(id)}`;
}

/** The library items of one kind the signed-in person may read (`GET /{kind}`). */
export async function fetchLibraryItems(
  server: SwitchServer,
  kind: LibraryKind
): Promise<LibraryItem[]> {
  const res = await gatewayFetch(server, `/${kind}`, { authenticated: true });
  // Agents' room-only documents are the room's, not the library's.
  return ((await res.json()) as LibraryItemJson[])
    .filter((r) => r.scope !== 'room')
    .map((r) => mapLibraryItem(kind, r));
}

/** One library item; a document comes with its content. */
export async function fetchLibraryItem(
  server: SwitchServer,
  kind: LibraryKind,
  id: string
): Promise<LibraryItem | LibraryDocument> {
  const res = await gatewayFetch(server, itemPath(kind, id), { authenticated: true });
  const json = (await res.json()) as LibraryItemJson;
  const item = mapLibraryItem(kind, json);
  return kind === 'documents' ? { ...item, content: json.content ?? '' } : item;
}

function body(kind: LibraryKind, input: LibraryItemChanges & { type?: string }) {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    ...(input.readVisibility !== undefined ? { read_visibility: input.readVisibility } : {}),
    ...(input.writeVisibility !== undefined ? { write_visibility: input.writeVisibility } : {}),
    ...(kind === 'references' && input.type !== undefined ? { type: input.type } : {}),
    ...(kind === 'references' && input.urls !== undefined ? { value: { urls: input.urls } } : {}),
    ...(kind === 'documents' && input.content !== undefined ? { content: input.content } : {}),
  };
}

/** Add a reference or document to the library. Refusals propagate in the gateway's words. */
export async function createLibraryItem(
  server: SwitchServer,
  kind: LibraryKind,
  input: LibraryItemInput
): Promise<LibraryItem> {
  const res = await gatewayFetch(server, `/${kind}`, {
    authenticated: true,
    method: 'POST',
    body: body(kind, input),
  });
  return mapLibraryItem(kind, (await res.json()) as LibraryItemJson);
}

/** Change a library item; only the fields given are sent. */
export async function updateLibraryItem(
  server: SwitchServer,
  kind: LibraryKind,
  id: string,
  changes: LibraryItemChanges
): Promise<LibraryItem | LibraryDocument> {
  const res = await gatewayFetch(server, itemPath(kind, id), {
    authenticated: true,
    method: 'PATCH',
    body: body(kind, changes),
  });
  const json = (await res.json()) as LibraryItemJson;
  const item = mapLibraryItem(kind, json);
  return kind === 'documents' ? { ...item, content: json.content ?? '' } : item;
}

/** Delete a library item, detaching it from every room and package it was in. */
export async function deleteLibraryItem(
  server: SwitchServer,
  kind: LibraryKind,
  id: string
): Promise<LibraryDeleteResult> {
  const res = await gatewayFetch(server, itemPath(kind, id), {
    authenticated: true,
    method: 'DELETE',
  });
  const json = (await res.json()) as {
    detached_room_ids?: string[];
    affected_package_ids?: string[];
  };
  return {
    detachedRoomIds: json.detached_room_ids ?? [],
    affectedPackageIds: json.affected_package_ids ?? [],
  };
}

/** The rooms a library item is attached to that the signed-in person can see. */
export async function fetchLibraryItemRooms(
  server: SwitchServer,
  kind: LibraryKind,
  id: string
): Promise<LibraryItemRoom[]> {
  const res = await gatewayFetch(server, `${itemPath(kind, id)}/rooms`, { authenticated: true });
  return ((await res.json()) as { room_id: string; room_name: string; can_unlink?: boolean }[]).map(
    (r) => ({
      roomId: r.room_id,
      roomName: r.room_name,
      ...(r.can_unlink !== undefined ? { canUnlink: r.can_unlink } : {}),
    })
  );
}

type ReferenceTypeJson = {
  type: string;
  display_name: string;
  instructions?: string;
  value_hint?: string | null;
  is_builtin?: boolean;
  owner_id?: string | null;
  owner_name?: string | null;
  read_visibility?: string;
  write_visibility?: string;
  shadowed_by_builtin?: boolean;
  created_at?: string;
  can_edit?: boolean;
  can_manage?: boolean;
};

function mapReferenceType(t: ReferenceTypeJson): ReferenceTypeOption {
  return {
    type: t.type,
    displayName: t.display_name,
    instructions: t.instructions ?? '',
    valueHint: t.value_hint ?? '',
    isBuiltin: t.is_builtin ?? false,
    ownerName: t.owner_name ?? null,
    ownerId: t.owner_id ?? null,
  };
}

function mapManagedReferenceType(t: ReferenceTypeJson): ManagedReferenceType {
  return {
    ...mapReferenceType(t),
    ownerId: t.owner_id ?? '',
    readVisibility: visibility(t.read_visibility ?? 'private'),
    writeVisibility: visibility(t.write_visibility ?? 'private'),
    shadowedByBuiltin: t.shadowed_by_builtin ?? false,
    createdAt: t.created_at ?? '',
    ...capabilities(t),
  };
}

/** The types a new reference may be given: Switch's own, then those people wrote. */
export async function fetchReferenceTypes(server: SwitchServer): Promise<ReferenceTypeOption[]> {
  const res = await gatewayFetch(server, '/references/reference-types', { authenticated: true });
  return ((await res.json()) as ReferenceTypeJson[])
    .map(mapReferenceType)
    .sort(
      (a, b) =>
        Number(b.isBuiltin) - Number(a.isBuiltin) || a.displayName.localeCompare(b.displayName)
    );
}

/** The types the viewer may change: their own, or every one for an admin. */
export async function fetchManagedReferenceTypes(
  server: SwitchServer
): Promise<ManagedReferenceType[]> {
  const res = await gatewayFetch(server, '/references/reference-types/owned', {
    authenticated: true,
  });
  return ((await res.json()) as ReferenceTypeJson[]).map(mapManagedReferenceType);
}

function typeBody(input: ReferenceTypeChanges & { type?: string }) {
  return {
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    ...(input.valueHint !== undefined ? { value_hint: input.valueHint } : {}),
    ...(input.readVisibility !== undefined ? { read_visibility: input.readVisibility } : {}),
    ...(input.writeVisibility !== undefined ? { write_visibility: input.writeVisibility } : {}),
  };
}

const typePath = (type: string) => `/references/reference-types/${encodeURIComponent(type)}`;

/** Add a reference type. Refusals (a slug in use, a built-in's slug) propagate in the gateway's words. */
export async function createReferenceType(
  server: SwitchServer,
  input: ReferenceTypeInput
): Promise<ManagedReferenceType> {
  const res = await gatewayFetch(server, '/references/reference-types', {
    authenticated: true,
    method: 'POST',
    body: typeBody(input),
  });
  return mapManagedReferenceType((await res.json()) as ReferenceTypeJson);
}

/** Change a reference type; its slug stays. */
export async function updateReferenceType(
  server: SwitchServer,
  type: string,
  changes: ReferenceTypeChanges
): Promise<ManagedReferenceType> {
  const res = await gatewayFetch(server, typePath(type), {
    authenticated: true,
    method: 'PATCH',
    body: typeBody(changes),
  });
  return mapManagedReferenceType((await res.json()) as ReferenceTypeJson);
}

/** Delete a reference type. The server refuses (409) while references still use it. */
export async function deleteReferenceType(server: SwitchServer, type: string): Promise<void> {
  await gatewayFetch(server, typePath(type), { authenticated: true, method: 'DELETE' });
}

/** The references or documents a package holds (`GET /packages/{id}/{kind}`). */
export async function fetchPackageMembers(
  server: SwitchServer,
  packageId: string,
  kind: PackageMemberKind
): Promise<LibraryItem[]> {
  const res = await gatewayFetch(server, `${itemPath('packages', packageId)}/${kind}`, {
    authenticated: true,
  });
  return ((await res.json()) as LibraryItemJson[]).map((r) => mapLibraryItem(kind, r));
}

/**
 * Put a reference or document in a package. The server lets whoever may
 * change the package do it, for an item the package's owner can read.
 */
export async function addPackageMember(
  server: SwitchServer,
  packageId: string,
  kind: PackageMemberKind,
  memberId: string
): Promise<void> {
  await gatewayFetch(
    server,
    `${itemPath('packages', packageId)}/${kind}/${encodeURIComponent(memberId)}`,
    { authenticated: true, method: 'POST' }
  );
}

/** Take a reference or document out of a package, saying which rooms lost it. */
export async function removePackageMember(
  server: SwitchServer,
  packageId: string,
  kind: PackageMemberKind,
  memberId: string
): Promise<PackageMemberRemoval> {
  const res = await gatewayFetch(
    server,
    `${itemPath('packages', packageId)}/${kind}/${encodeURIComponent(memberId)}`,
    { authenticated: true, method: 'DELETE' }
  );
  const json = (await res.json()) as {
    affected_room_names?: string[];
    hidden_affected_rooms_count?: number;
  };
  return {
    affectedRoomNames: json.affected_room_names ?? [],
    hiddenAffectedRoomsCount: json.hidden_affected_rooms_count ?? 0,
  };
}
