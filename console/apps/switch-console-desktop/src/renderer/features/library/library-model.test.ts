import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '@shared/core/switch-servers/library';
import { changesOf, emptyForm, formOf, formProblem, inputOf } from './library-form';
import {
  accessOf,
  filterLibraryItems,
  libraryPermissions,
  NO_LIBRARY_FILTER,
  offeredLibraryFilter,
  parseUrls,
  typeOptions,
  visibilityOf,
} from './library-model';

function item(over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'ref-1',
    kind: 'references',
    name: 'Switch repo',
    description: 'The code',
    instructions: '',
    ownerId: 'u1',
    ownerName: 'Ada',
    readVisibility: 'public',
    writeVisibility: 'private',
    type: 'github',
    typeLabel: 'GitHub',
    urls: ['https://github.com/acme/switch'],
    attachedRoomsCount: 0,
    packageIds: [],
    createdAt: '2026-11-01',
    ...over,
  };
}

describe('access', () => {
  it('reads the two flags as one of three settings, and back', () => {
    for (const access of ['private', 'shared', 'open'] as const) {
      expect(accessOf(visibilityOf(access))).toBe(access);
    }
    // Private to read is private, whatever writing says.
    expect(accessOf({ readVisibility: 'private', writeVisibility: 'public' })).toBe('private');
  });
});

describe('libraryPermissions', () => {
  it('lets the owner do everything', () => {
    expect(libraryPermissions(item(), { id: 'u1', isAdmin: false })).toEqual({
      canEdit: true,
      canDelete: true,
      canChangeAccess: true,
    });
  });

  it('lets an admin do everything with someone else’s', () => {
    expect(libraryPermissions(item(), { id: 'u9', isAdmin: true }).canDelete).toBe(true);
  });

  it('lets anyone change an open item, but only its owner delete it or change who sees it', () => {
    expect(
      libraryPermissions(item({ writeVisibility: 'public' }), { id: 'u2', isAdmin: false })
    ).toEqual({ canEdit: true, canDelete: false, canChangeAccess: false });
  });

  it('lets nobody else change a shared item', () => {
    expect(libraryPermissions(item(), { id: 'u2', isAdmin: false }).canEdit).toBe(false);
  });

  it('offers nothing to a viewer it does not know', () => {
    expect(
      libraryPermissions(item({ writeVisibility: 'public' }), { id: null, isAdmin: false })
    ).toEqual({ canEdit: false, canDelete: false, canChangeAccess: false });
  });
});

describe('filterLibraryItems', () => {
  const items = [
    item({ id: 'a', name: 'Zeta', ownerId: 'u1' }),
    item({ id: 'b', name: 'alpha', ownerId: 'u2', type: 'jira', typeLabel: 'Jira' }),
    item({ id: 'c', name: 'Beta', description: 'release notes', ownerId: 'u2' }),
  ];

  it('sorts by name', () => {
    expect(filterLibraryItems(items, NO_LIBRARY_FILTER, 'u1').map((i) => i.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('keeps yours, a type, or what matches the search', () => {
    expect(
      filterLibraryItems(items, { ...NO_LIBRARY_FILTER, mineOnly: true }, 'u1').map((i) => i.id)
    ).toEqual(['a']);
    expect(
      filterLibraryItems(items, { ...NO_LIBRARY_FILTER, type: 'jira' }, 'u1').map((i) => i.id)
    ).toEqual(['b']);
    expect(
      filterLibraryItems(items, { ...NO_LIBRARY_FILTER, query: ' RELEASE ' }, 'u1').map((i) => i.id)
    ).toEqual(['c']);
  });

  it('shows nothing as yours to a viewer it does not know', () => {
    expect(filterLibraryItems(items, { ...NO_LIBRARY_FILTER, mineOnly: true }, null)).toEqual([]);
  });

  it('applies a type only while it is offered', () => {
    const picked = { ...NO_LIBRARY_FILTER, type: 'jira' };
    expect(offeredLibraryFilter(picked, [{ value: 'jira' }]).type).toBe('jira');
    expect(offeredLibraryFilter(picked, [{ value: 'github' }]).type).toBeNull();
    expect(offeredLibraryFilter(picked, []).type).toBeNull();
  });

  it('offers each type once, by its name', () => {
    expect(typeOptions(items)).toEqual([
      { value: 'github', label: 'GitHub' },
      { value: 'jira', label: 'Jira' },
    ]);
  });
});

describe('the form', () => {
  it('takes links one per line, without blanks or surrounding space', () => {
    expect(parseUrls(' https://a.example \n\n https://b.example\n')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('asks for a name, and for a reference a type and a link', () => {
    expect(formProblem('documents', emptyForm())).toBe('Give it a name.');
    expect(formProblem('documents', { ...emptyForm(), name: 'Notes' })).toBeNull();
    expect(formProblem('references', { ...emptyForm(), name: 'Repo' })).toBe('Pick a type.');
    expect(formProblem('references', { ...emptyForm(), name: 'Repo', type: 'github' })).toBe(
      'Add at least one link.'
    );
  });

  it('sends a reference its links and a document its content, trimmed', () => {
    const form = {
      ...emptyForm(),
      name: ' Repo ',
      type: 'github',
      urlsText: 'https://a.example',
      content: 'ignored',
    };
    expect(inputOf('references', form)).toEqual({
      name: 'Repo',
      description: '',
      instructions: '',
      readVisibility: 'public',
      writeVisibility: 'private',
      type: 'github',
      urls: ['https://a.example'],
    });
    expect(inputOf('documents', { ...form, access: 'private' })).toMatchObject({
      readVisibility: 'private',
      content: 'ignored',
    });
  });

  it('sends only what changed', () => {
    const before = formOf(item());
    expect(changesOf('references', before, before)).toEqual({});
    expect(changesOf('references', before, { ...before, description: 'New' })).toEqual({
      description: 'New',
    });
    expect(changesOf('references', before, { ...before, access: 'open' })).toEqual({
      readVisibility: 'public',
      writeVisibility: 'public',
    });
    expect(
      changesOf('references', before, { ...before, urlsText: `${before.urlsText}\nhttps://b` })
    ).toEqual({ urls: ['https://github.com/acme/switch', 'https://b'] });
  });
});
