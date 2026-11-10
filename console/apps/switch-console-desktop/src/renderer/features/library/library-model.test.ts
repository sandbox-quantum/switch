import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '@shared/core/switch-servers/library';
import { changesOf, emptyForm, formOf, formProblem, inputOf } from './library-form';
import {
  accessOf,
  filterLibraryItems,
  libraryItemOpens,
  libraryPermissions,
  NO_LIBRARY_FILTER,
  offeredLibraryFilter,
  packageContentsText,
  removalText,
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
    referencesCount: 0,
    documentsCount: 0,
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

describe('libraryPermissions, from a server that says', () => {
  it('follows the server over the viewer’s own rule', () => {
    // The owner, told no: a rule the server knows and Console does not.
    expect(
      libraryPermissions(item({ canEdit: false, canManage: false }), { id: 'u1', isAdmin: false })
    ).toEqual({ canEdit: false, canDelete: false, canChangeAccess: false });
    // Someone else, told yes to editing alone.
    expect(
      libraryPermissions(item({ canEdit: true, canManage: false }), { id: 'u2', isAdmin: false })
    ).toEqual({ canEdit: true, canDelete: false, canChangeAccess: false });
  });

  it('never mixes a partial answer with the viewer’s own rule', () => {
    // The owner, whose own rule would allow everything: a flag the server
    // leaves out counts as no rather than falling back to that rule.
    const owner = { id: 'u1', isAdmin: false };
    expect(libraryPermissions(item({ canManage: true }), owner)).toEqual({
      canEdit: false,
      canDelete: true,
      canChangeAccess: true,
    });
    expect(libraryPermissions(item({ canEdit: true }), owner)).toEqual({
      canEdit: true,
      canDelete: false,
      canChangeAccess: false,
    });
  });
});

describe('libraryItemOpens', () => {
  const someoneElse = { id: 'u2', isAdmin: false };

  it('follows the server where it says', () => {
    expect(libraryItemOpens(item({ canRead: false }), someoneElse)).toBe(false);
    expect(libraryItemOpens(item({ readVisibility: 'private', canRead: true }), someoneElse)).toBe(
      true
    );
  });

  it('otherwise opens what is open to read, or the viewer’s own, or anything for an admin', () => {
    const secret = item({ readVisibility: 'private' });
    expect(libraryItemOpens(item(), someoneElse)).toBe(true);
    expect(libraryItemOpens(secret, someoneElse)).toBe(false);
    expect(libraryItemOpens(secret, { id: 'u1', isAdmin: false })).toBe(true);
    expect(libraryItemOpens(secret, { id: 'u9', isAdmin: true })).toBe(true);
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

describe('a package', () => {
  it('says what it holds in words', () => {
    expect(packageContentsText({ referencesCount: 2, documentsCount: 1 })).toBe(
      '2 references · 1 document'
    );
    expect(packageContentsText({ referencesCount: 1, documentsCount: 0 })).toBe('1 reference');
    expect(packageContentsText({ referencesCount: 0, documentsCount: 0 })).toBe('Empty');
  });

  it('says which rooms lost an item taken out of it, counting the private ones', () => {
    expect(removalText('Guide', { affectedRoomNames: [], hiddenAffectedRoomsCount: 0 })).toBe(
      'Removed Guide. No room had it only through this package.'
    );
    expect(
      removalText('Guide', { affectedRoomNames: ['design'], hiddenAffectedRoomsCount: 2 })
    ).toBe(
      'Removed Guide. These rooms had it only through this package, and no longer have it: design, 2 private rooms you can’t open.'
    );
  });
});
