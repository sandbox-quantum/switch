import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRoomResourceSnapshot,
  documentFingerprint,
  packageFingerprint,
  readToldRoomResources,
  recordToldRoomResources,
  referenceFingerprint,
  roomResourcesNote,
  roomResourcesUnreadNote,
} from './told-room-resources';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('roomResourcesNote', () => {
  it('returns null on the first visit (told === undefined)', () => {
    const current = buildRoomResourceSnapshot({
      documents: [{ id: 'doc-1', name: 'launch-plan', content_hash: 'abc' }],
      references: [{ id: 'ref-1', name: 'api-url', value: 'https://api.example.com' }],
      packages: [{ id: 'pkg-1', name: 'starter-kit' }],
    });
    expect(roomResourcesNote('room-1', current, undefined)).toBeNull();
  });

  it('returns null when nothing has changed', () => {
    const current = buildRoomResourceSnapshot({
      documents: [{ id: 'doc-1', name: 'launch-plan', content_hash: 'abc' }],
      references: [{ id: 'ref-1', name: 'api-url', value: 'https://api.example.com' }],
      packages: [{ id: 'pkg-1', name: 'starter-kit' }],
    });
    expect(roomResourcesNote('room-1', current, current)).toBeNull();
  });

  it('detects modified, attached, and detached documents', () => {
    const baseline = buildRoomResourceSnapshot({
      documents: [
        { id: 'doc-1', name: 'launch-plan', content_hash: 'v1' },
        { id: 'doc-2', name: 'old-notes', content_hash: 'v1' },
      ],
    });

    const updated = buildRoomResourceSnapshot({
      documents: [
        { id: 'doc-1', name: 'launch-plan', content_hash: 'v2' },
        { id: 'doc-3', name: 'new-spec', content_hash: 'v1' },
      ],
    });

    const note = roomResourcesNote('room-1', updated, baseline);
    expect(note).not.toBeNull();
    expect(note).toContain('Attached resources in room room-1 have changed since you were last told');
    expect(note).toContain('- Document "launch-plan" (doc-1) was modified.');
    expect(note).toContain('- Document "new-spec" (doc-3) was attached.');
    expect(note).toContain('- Document "old-notes" (doc-2) was detached.');
    expect(note).toContain('call load_internal_documents with their ids to inspect updated contents.');
  });

  it('detects modified, attached, and detached references and packages', () => {
    const baseline = buildRoomResourceSnapshot({
      references: [{ id: 'ref-1', name: 'api-url', value: { url: 'v1' } }],
      packages: [{ id: 'pkg-1', name: 'kit', documents: [{ id: 'doc-1' }] }],
    });

    const updated = buildRoomResourceSnapshot({
      references: [{ id: 'ref-1', name: 'api-url', value: { url: 'v2' } }],
      packages: [{ id: 'pkg-1', name: 'kit', documents: [{ id: 'doc-1' }, { id: 'doc-2' }] }],
    });

    const note = roomResourcesNote('room-1', updated, baseline);
    expect(note).not.toBeNull();
    expect(note).toContain('- Reference "api-url" (ref-1) was modified.');
    expect(note).toContain('- Package "kit" (pkg-1) was modified.');
    expect(note).toContain('call load_internal_documents / list_references to inspect updated resources.');
  });

  it('returns an unread note when resources cannot be fetched', () => {
    const note = roomResourcesUnreadNote('room-1', 'Server timeout');
    expect(note).toContain("Room room-1's attached resources could not be read for you (Server timeout)");
    expect(note).toContain('call list_references or connect_to_room');
  });
});

describe('fingerprints', () => {
  it('changes document fingerprint when content_hash changes', () => {
    const fp1 = documentFingerprint({ name: 'doc', content_hash: 'h1' });
    const fp2 = documentFingerprint({ name: 'doc', content_hash: 'h2' });
    expect(fp1).not.toEqual(fp2);
  });

  it('changes reference fingerprint when value changes', () => {
    const fp1 = referenceFingerprint({ name: 'ref', value: { a: 1 } });
    const fp2 = referenceFingerprint({ name: 'ref', value: { a: 2 } });
    expect(fp1).not.toEqual(fp2);
  });

  it('changes package fingerprint when package contents change', () => {
    const fp1 = packageFingerprint({ name: 'pkg', documents: [{ id: 'd1' }] });
    const fp2 = packageFingerprint({ name: 'pkg', documents: [{ id: 'd2' }] });
    expect(fp1).not.toEqual(fp2);
  });
});

it('persists told room resources across restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'told-resources-'));
  roots.push(root);

  expect(await readToldRoomResources(root)).toEqual({});

  const snapshot = buildRoomResourceSnapshot({
    documents: [{ id: 'doc-1', name: 'notes', content_hash: 'abc' }],
  });

  await recordToldRoomResources(root, { 'room-1': snapshot });

  const readBack = await readToldRoomResources(root);
  expect(readBack).toEqual({ 'room-1': snapshot });
});
