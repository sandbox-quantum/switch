import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { replaceOwner } from './ownership-lock';

const FILE = 'room-resources.json';

export const roomResourceEntrySchema = z.object({
  name: z.string(),
  hash: z.string(),
});
export type RoomResourceEntry = z.infer<typeof roomResourceEntrySchema>;

export const roomResourceSnapshotSchema = z.object({
  documents: z.record(z.string(), roomResourceEntrySchema),
  references: z.record(z.string(), roomResourceEntrySchema),
  packages: z.record(z.string(), roomResourceEntrySchema),
});
export type RoomResourceSnapshot = z.infer<typeof roomResourceSnapshotSchema>;

const recordSchema = z.strictObject({
  rooms: z.record(z.string(), roomResourceSnapshotSchema),
});

/**
 * Fingerprint a document by its name, description, instructions, and content hash.
 */
export function documentFingerprint(doc: {
  name: string;
  description?: string | null;
  instructions?: string | null;
  content_hash?: string | null;
}): string {
  return createHash('sha256')
    .update(doc.name)
    .update('\0')
    .update(doc.description ?? '')
    .update('\0')
    .update(doc.instructions ?? '')
    .update('\0')
    .update(doc.content_hash ?? '')
    .digest('hex')
    .slice(0, 16);
}

/**
 * Fingerprint a reference by its name, description, instructions, and value.
 */
export function referenceFingerprint(ref: {
  name: string;
  description?: string | null;
  instructions?: string | null;
  value?: unknown;
}): string {
  return createHash('sha256')
    .update(ref.name)
    .update('\0')
    .update(ref.description ?? '')
    .update('\0')
    .update(ref.instructions ?? '')
    .update('\0')
    .update(JSON.stringify(ref.value ?? null))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Fingerprint a package by its name, description, instructions, and constituent items.
 */
export function packageFingerprint(pkg: {
  name: string;
  description?: string | null;
  instructions?: string | null;
  documents?: Array<{ id: string; content_hash?: string | null }>;
  references?: Array<{ id: string }>;
}): string {
  const docSummary = (pkg.documents ?? [])
    .map((d) => `${d.id}:${d.content_hash ?? ''}`)
    .sort()
    .join(',');
  const refSummary = (pkg.references ?? [])
    .map((r) => r.id)
    .sort()
    .join(',');
  return createHash('sha256')
    .update(pkg.name)
    .update('\0')
    .update(pkg.description ?? '')
    .update('\0')
    .update(pkg.instructions ?? '')
    .update('\0')
    .update(docSummary)
    .update('\0')
    .update(refSummary)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Build a structured resource snapshot from raw room resources returned by connect_to_room.
 */
export function buildRoomResourceSnapshot(resources?: {
  documents?: any[];
  references?: any[];
  packages?: any[];
}): RoomResourceSnapshot {
  const documents: Record<string, RoomResourceEntry> = {};
  for (const doc of resources?.documents ?? []) {
    if (doc && typeof doc.id === 'string' && typeof doc.name === 'string') {
      documents[doc.id] = { name: doc.name, hash: documentFingerprint(doc) };
    }
  }
  const references: Record<string, RoomResourceEntry> = {};
  for (const ref of resources?.references ?? []) {
    if (ref && typeof ref.id === 'string' && typeof ref.name === 'string') {
      references[ref.id] = { name: ref.name, hash: referenceFingerprint(ref) };
    }
  }
  const packages: Record<string, RoomResourceEntry> = {};
  for (const pkg of resources?.packages ?? []) {
    if (pkg && typeof pkg.id === 'string' && typeof pkg.name === 'string') {
      packages[pkg.id] = { name: pkg.name, hash: packageFingerprint(pkg) };
    }
  }
  return { documents, references, packages };
}

/**
 * Read the told attached resources record for all rooms this session has visited.
 */
export async function readToldRoomResources(
  root: string
): Promise<Record<string, RoomResourceSnapshot>> {
  try {
    return recordSchema.parse(JSON.parse(await readFile(join(root, FILE), 'utf8'))).rooms;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * Atomically record what attached resources this conversation has been told per room.
 */
export async function recordToldRoomResources(
  root: string,
  rooms: Record<string, RoomResourceSnapshot>
): Promise<void> {
  await replaceOwner(join(root, FILE), { rooms });
}

export type ResourceDiff = {
  modifiedDocs: Array<{ id: string; name: string }>;
  attachedDocs: Array<{ id: string; name: string }>;
  detachedDocs: Array<{ id: string; name: string }>;
  modifiedRefs: Array<{ id: string; name: string }>;
  attachedRefs: Array<{ id: string; name: string }>;
  detachedRefs: Array<{ id: string; name: string }>;
  modifiedPkgs: Array<{ id: string; name: string }>;
  attachedPkgs: Array<{ id: string; name: string }>;
  detachedPkgs: Array<{ id: string; name: string }>;
};

/**
 * Compute differences between current room resource snapshot and previously told snapshot.
 */
export function roomResourcesDiff(
  current: RoomResourceSnapshot,
  told: RoomResourceSnapshot
): ResourceDiff {
  const diff: ResourceDiff = {
    modifiedDocs: [],
    attachedDocs: [],
    detachedDocs: [],
    modifiedRefs: [],
    attachedRefs: [],
    detachedRefs: [],
    modifiedPkgs: [],
    attachedPkgs: [],
    detachedPkgs: [],
  };

  // Documents
  for (const [id, entry] of Object.entries(current.documents)) {
    const prior = told.documents[id];
    if (!prior) {
      diff.attachedDocs.push({ id, name: entry.name });
    } else if (prior.hash !== entry.hash) {
      diff.modifiedDocs.push({ id, name: entry.name });
    }
  }
  for (const [id, entry] of Object.entries(told.documents)) {
    if (!current.documents[id]) {
      diff.detachedDocs.push({ id, name: entry.name });
    }
  }

  // References
  for (const [id, entry] of Object.entries(current.references)) {
    const prior = told.references[id];
    if (!prior) {
      diff.attachedRefs.push({ id, name: entry.name });
    } else if (prior.hash !== entry.hash) {
      diff.modifiedRefs.push({ id, name: entry.name });
    }
  }
  for (const [id, entry] of Object.entries(told.references)) {
    if (!current.references[id]) {
      diff.detachedRefs.push({ id, name: entry.name });
    }
  }

  // Packages
  for (const [id, entry] of Object.entries(current.packages)) {
    const prior = told.packages[id];
    if (!prior) {
      diff.attachedPkgs.push({ id, name: entry.name });
    } else if (prior.hash !== entry.hash) {
      diff.modifiedPkgs.push({ id, name: entry.name });
    }
  }
  for (const [id, entry] of Object.entries(told.packages)) {
    if (!current.packages[id]) {
      diff.detachedPkgs.push({ id, name: entry.name });
    }
  }

  return diff;
}

/**
 * Format a notice naming what resources changed in the room since this conversation was last told.
 * Returns null if this is the first time the room is seen (told === undefined) or if nothing changed.
 */
export function roomResourcesNote(
  roomId: string,
  current: RoomResourceSnapshot,
  told: RoomResourceSnapshot | undefined
): string | null {
  if (told === undefined) return null;

  const diff = roomResourcesDiff(current, told);
  const lines: string[] = [];

  for (const doc of diff.modifiedDocs) {
    lines.push(`- Document "${doc.name}" (${doc.id}) was modified.`);
  }
  for (const doc of diff.attachedDocs) {
    lines.push(`- Document "${doc.name}" (${doc.id}) was attached.`);
  }
  for (const doc of diff.detachedDocs) {
    lines.push(`- Document "${doc.name}" (${doc.id}) was detached.`);
  }

  for (const ref of diff.modifiedRefs) {
    lines.push(`- Reference "${ref.name}" (${ref.id}) was modified.`);
  }
  for (const ref of diff.attachedRefs) {
    lines.push(`- Reference "${ref.name}" (${ref.id}) was attached.`);
  }
  for (const ref of diff.detachedRefs) {
    lines.push(`- Reference "${ref.name}" (${ref.id}) was detached.`);
  }

  for (const pkg of diff.modifiedPkgs) {
    lines.push(`- Package "${pkg.name}" (${pkg.id}) was modified.`);
  }
  for (const pkg of diff.attachedPkgs) {
    lines.push(`- Package "${pkg.name}" (${pkg.id}) was attached.`);
  }
  for (const pkg of diff.detachedPkgs) {
    lines.push(`- Package "${pkg.name}" (${pkg.id}) was detached.`);
  }

  if (lines.length === 0) return null;

  const hasDocs = diff.modifiedDocs.length > 0 || diff.attachedDocs.length > 0;
  const hasRefs = diff.modifiedRefs.length > 0 || diff.attachedRefs.length > 0;
  const hasPkgs = diff.modifiedPkgs.length > 0 || diff.attachedPkgs.length > 0;

  let cta = 'Before you reply, call ';
  if ((hasDocs && hasRefs) || hasPkgs) {
    cta += 'load_internal_documents / list_references to inspect updated resources.';
  } else if (hasDocs) {
    cta += 'load_internal_documents with their ids to inspect updated contents.';
  } else {
    cta += 'list_references to inspect updated references.';
  }

  return (
    `[Switch] Attached resources in room ${roomId} have changed since you were last told about them:\n` +
    `${lines.join('\n')}\n` +
    `${cta}`
  );
}

/**
 * Notice when room resources could not be fetched.
 */
export function roomResourcesUnreadNote(roomId: string, reason: string): string {
  return (
    `[Switch] Room ${roomId}'s attached resources could not be read for you (${reason}). ` +
    `Before you reply, call list_references or connect_to_room to verify current room resources.`
  );
}
