import type {
  LibraryItem,
  LibraryItemChanges,
  LibraryItemInput,
  LibraryKind,
} from '@shared/core/switch-servers/library';
import { accessOf, type LibraryAccess, parseUrls, visibilityOf } from './library-model';

/** What the form holds while someone fills it in. */
export type LibraryForm = {
  name: string;
  description: string;
  instructions: string;
  access: LibraryAccess;
  type: string;
  /** A reference's links, one per line. */
  urlsText: string;
  content: string;
};

export function emptyForm(): LibraryForm {
  return {
    name: '',
    description: '',
    instructions: '',
    access: 'shared',
    type: '',
    urlsText: '',
    content: '',
  };
}

export function formOf(item: LibraryItem & { content?: string }): LibraryForm {
  return {
    name: item.name,
    description: item.description,
    instructions: item.instructions,
    access: accessOf(item),
    type: item.type ?? '',
    urlsText: item.urls.join('\n'),
    content: item.content ?? '',
  };
}

/** Why the form cannot be saved yet, or null when it can. */
export function formProblem(kind: LibraryKind, form: LibraryForm): string | null {
  if (!form.name.trim()) return 'Give it a name.';
  if (kind === 'references') {
    if (!form.type) return 'Pick a type.';
    if (parseUrls(form.urlsText).length === 0) return 'Add at least one link.';
  }
  return null;
}

export function inputOf(kind: LibraryKind, form: LibraryForm): LibraryItemInput {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    instructions: form.instructions.trim(),
    ...visibilityOf(form.access),
    ...(kind === 'references'
      ? { type: form.type, urls: parseUrls(form.urlsText) }
      : { content: form.content }),
  };
}

/** Only what changed, so a save does not overwrite someone else's edit to another field. */
export function changesOf(
  kind: LibraryKind,
  before: LibraryForm,
  after: LibraryForm
): LibraryItemChanges {
  const next = inputOf(kind, after);
  const prev = inputOf(kind, before);
  const changes: LibraryItemChanges = {};
  if (next.name !== prev.name) changes.name = next.name;
  if (next.description !== prev.description) changes.description = next.description;
  if (next.instructions !== prev.instructions) changes.instructions = next.instructions;
  if (after.access !== before.access) {
    changes.readVisibility = next.readVisibility;
    changes.writeVisibility = next.writeVisibility;
  }
  if (kind === 'references' && next.urls?.join('\n') !== prev.urls?.join('\n')) {
    changes.urls = next.urls;
  }
  if (kind === 'documents' && next.content !== prev.content) changes.content = next.content;
  return changes;
}
