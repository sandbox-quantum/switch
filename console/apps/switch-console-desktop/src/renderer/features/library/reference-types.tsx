import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreVertical, Pencil, Shapes, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Textarea } from '@renderer/lib/ui/textarea';
import type {
  ManagedReferenceType,
  ReferenceTypeChanges,
  ReferenceTypeInput,
  ReferenceTypeOption,
} from '@shared/core/switch-servers/library';
import {
  ACCESS_SHORT,
  accessOf,
  type LibraryAccess,
  LIBRARY_ACCESS_OPTIONS,
  type LibraryFilter,
  visibilityOf,
} from './library-model';
import {
  libraryItemsKey,
  libraryItemsOfKindKey,
  referenceTypesKey,
  roomResourcesInWorkspaceKey,
} from './library-queries';
import { slugAsTyped, slugFromName, slugProblem } from './reference-type-slug';

export const managedReferenceTypesKey = (workspaceId: string) => [
  'managed-reference-types',
  workspaceId,
];

/** One reference type as the tab lists it: Switch's own, or one someone wrote. */
export type ReferenceTypeCard = {
  key: string;
  type: string;
  displayName: string;
  instructions: string;
  valueHint: string;
  isBuiltin: boolean;
  ownerId: string | null;
  ownerName: string | null;
  /** Null when the viewer is not told (someone else's type). */
  access: LibraryAccess | null;
  shadowedByBuiltin: boolean;
  /** Its full settings, when the viewer may change it; null otherwise. */
  managed: ManagedReferenceType | null;
};

/**
 * Every type the viewer can see, built-ins first, merged with the ones they
 * may change. A type hidden by a built-in of the same slug is not offered for
 * new references, so it shows only to whoever may change it.
 */
export function referenceTypeCards(
  visible: readonly ReferenceTypeOption[],
  managed: readonly ManagedReferenceType[]
): ReferenceTypeCard[] {
  const managedBySlug = new Map(managed.map((t) => [t.type, t]));
  const cards: ReferenceTypeCard[] = visible.map((t) => {
    const own = t.isBuiltin ? null : (managedBySlug.get(t.type) ?? null);
    return {
      key: `${t.isBuiltin ? 'builtin' : 'user'}:${t.type}`,
      type: t.type,
      displayName: t.displayName,
      instructions: t.instructions,
      valueHint: t.valueHint,
      isBuiltin: t.isBuiltin,
      ownerId: t.ownerId,
      ownerName: t.ownerName,
      access: own ? accessOf(own) : null,
      shadowedByBuiltin: false,
      managed: own,
    };
  });
  const listed = new Set(cards.filter((c) => !c.isBuiltin).map((c) => c.type));
  for (const t of managed) {
    if (listed.has(t.type)) continue;
    cards.push({
      key: `user:${t.type}`,
      type: t.type,
      displayName: t.displayName,
      instructions: t.instructions,
      valueHint: t.valueHint,
      isBuiltin: false,
      ownerId: t.ownerId,
      ownerName: t.ownerName,
      access: accessOf(t),
      shadowedByBuiltin: t.shadowedByBuiltin,
      managed: t,
    });
  }
  return cards.sort(
    (a, b) =>
      Number(b.isBuiltin) - Number(a.isBuiltin) || a.displayName.localeCompare(b.displayName)
  );
}

/** The cards the filter row lets through: yours, and what matches the search. */
export function filterReferenceTypeCards(
  cards: readonly ReferenceTypeCard[],
  filter: Pick<LibraryFilter, 'mineOnly' | 'query'>,
  viewerId: string | null
): ReferenceTypeCard[] {
  const needle = filter.query.trim().toLowerCase();
  return cards
    .filter((c) => !filter.mineOnly || (viewerId !== null && c.ownerId === viewerId))
    .filter(
      (c) =>
        !needle ||
        c.displayName.toLowerCase().includes(needle) ||
        c.type.includes(needle) ||
        c.valueHint.toLowerCase().includes(needle)
    );
}

/** The Reference types tab: every type the viewer can see, as cards. */
export function ReferenceTypesPanel({
  workspaceId,
  viewerId,
  filter,
}: {
  workspaceId: string;
  viewerId: string | null;
  filter: Pick<LibraryFilter, 'mineOnly' | 'query'>;
}) {
  const queryClient = useQueryClient();
  const showType = useShowModal('referenceTypeModal');
  const confirm = useShowModal('confirmActionModal');
  const visible = useQuery({
    queryKey: referenceTypesKey(workspaceId),
    queryFn: () => rpc.workspaces.listReferenceTypes({ workspaceId }),
  });
  const managed = useQuery({
    queryKey: managedReferenceTypesKey(workspaceId),
    queryFn: () => rpc.workspaces.listManagedReferenceTypes({ workspaceId }),
  });
  const cards = referenceTypeCards(visible.data ?? [], managed.data ?? []);
  const shown = filterReferenceTypeCards(cards, filter, viewerId);

  const remove = (card: ReferenceTypeCard) =>
    confirm({
      title: `Delete ${card.displayName}?`,
      description: 'It is deleted for everyone. Switch refuses while any reference still uses it.',
      confirmLabel: 'Delete',
      onSuccess: () => {
        rpc.workspaces
          .deleteReferenceType({ workspaceId, type: card.type })
          .then(async () => {
            toast({ title: `"${card.displayName}" deleted` });
            await invalidateReferenceTypes(queryClient, workspaceId);
          })
          .catch((e: unknown) =>
            toast({
              title: `Could not delete "${card.displayName}"`,
              description: failureText(e, 'Check the server connection and try again.'),
              variant: 'destructive',
            })
          );
      },
    });

  if (visible.isPending) return <p className="py-2 text-sm text-foreground-muted">Loading…</p>;
  if (visible.isError) {
    return (
      <p className="py-2 text-sm text-foreground-muted">
        {failureText(visible.error, 'Could not read the reference types.')}
      </p>
    );
  }
  // Without the types you may change, edit and delete would vanish silently.
  const managedError = managed.isError ? (
    <p role="alert" className="text-xs text-destructive">
      {failureText(
        managed.error,
        'Could not read which types you can change, so editing and deleting are unavailable.'
      )}
    </p>
  ) : null;
  if (shown.length === 0) {
    return (
      <>
        {managedError}
        <p className="py-2 text-sm text-foreground-muted">
          {filter.mineOnly && !filter.query.trim()
            ? 'You have made no reference types yet.'
            : 'No reference type matches.'}
        </p>
      </>
    );
  }
  return (
    <>
      {managedError}
      <div
        role="list"
        aria-label="Reference types"
        className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-[14px]"
      >
        {shown.map((card) => {
          // The server says what the viewer may do with a type they manage; an
          // older one lists only those they may change and delete.
          const editable =
            card.managed !== null && (card.managed.canEdit ?? true) ? card.managed : null;
          const deletable = card.managed !== null && (card.managed.canManage ?? true);
          return (
            <div role="listitem" key={card.key}>
              <TypeCard
                card={card}
                viewerId={viewerId}
                showYours={!filter.mineOnly}
                onOpen={() => showType({ workspaceId, editing: editable, viewing: card })}
                onEdit={
                  editable
                    ? () => showType({ workspaceId, editing: editable, viewing: card })
                    : null
                }
                onDelete={deletable ? () => remove(card) : null}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

function TypeCard({
  card,
  viewerId,
  showYours,
  onOpen,
  onEdit,
  onDelete,
}: {
  card: ReferenceTypeCard;
  viewerId: string | null;
  showYours: boolean;
  onOpen: () => void;
  onEdit: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  const mine = viewerId !== null && card.ownerId === viewerId;
  const owner = card.isBuiltin
    ? 'Comes with Switch'
    : mine
      ? 'Owned by you'
      : card.ownerName
        ? `Owned by ${card.ownerName}`
        : null;
  return (
    <div
      data-reference-type-card={card.type}
      className="group relative flex h-full min-h-[150px] flex-col rounded-[11px] border border-border bg-background transition-colors hover:border-border-1"
    >
      <button
        type="button"
        aria-label={`Open ${card.displayName}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-[11px] focus-visible:ring-2 focus-visible:outline-none"
        onClick={onOpen}
      />
      <div className="pointer-events-none flex flex-1 flex-col gap-2 p-4">
        <div className={`flex items-center gap-2${onEdit ? ' pr-8' : ''}`}>
          <Shapes className="size-4.5 shrink-0 text-foreground-muted" />
          <h3 className="min-w-0 truncate font-medium text-foreground">{card.displayName}</h3>
          {card.isBuiltin && <Badge variant="outline">Built-in</Badge>}
          {showYours && mine && <Badge variant="secondary">Yours</Badge>}
        </div>
        <p className="line-clamp-2 text-sm text-foreground-muted">
          {card.valueHint || <span className="italic">No hint for its links.</span>}
        </p>
        <p className="flex min-w-0 items-center gap-1 text-xs text-foreground-muted">
          <span className="truncate font-mono">{card.type}</span>
          {card.access && (
            <>
              <span aria-hidden>·</span>
              <span>{ACCESS_SHORT[card.access]}</span>
            </>
          )}
          {card.shadowedByBuiltin && (
            <>
              <span aria-hidden>·</span>
              <span className="text-foreground-warning">Hidden by a built-in</span>
            </>
          )}
        </p>
        {owner && (
          <div className="mt-auto border-t border-border pt-2.5 text-xs text-foreground-muted">
            {owner}
          </div>
        )}
      </div>
      {(onEdit || onDelete) && (
        <div className="absolute top-2.5 right-2.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0"
                  aria-label={`${card.displayName} actions`}
                >
                  <MoreVertical className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
              {onEdit && (
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil className="size-4" />
                  Edit…
                </DropdownMenuItem>
              )}
              {onDelete && (
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 className="size-4" />
                  Delete…
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

export async function invalidateReferenceTypes(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: referenceTypesKey(workspaceId) }),
    queryClient.invalidateQueries({ queryKey: managedReferenceTypesKey(workspaceId) }),
    // References show their type's name: in Resources, on their pages, and in rooms.
    queryClient.invalidateQueries({ queryKey: libraryItemsKey(workspaceId, 'references') }),
    queryClient.invalidateQueries({
      queryKey: libraryItemsOfKindKey(workspaceId, 'references'),
    }),
    queryClient.invalidateQueries({ queryKey: roomResourcesInWorkspaceKey(workspaceId) }),
  ]);
}

type TypeForm = {
  displayName: string;
  type: string;
  instructions: string;
  valueHint: string;
  access: LibraryAccess;
};

type ModalProps = BaseModalProps<ManagedReferenceType> & {
  workspaceId: string;
  /** The type to change; null makes a new one, or shows one the viewer may not change. */
  editing: ManagedReferenceType | null;
  /** A type to show read-only when it is not the viewer's to change. */
  viewing?: ReferenceTypeCard;
  /**
   * Shown as a step inside another dialog (New reference). There is no close
   * button, and Escape goes back to that dialog (`onClose`) rather than
   * closing it and losing what was filled in there.
   */
  embedded?: boolean;
};

/**
 * Makes a reference type, changes one, or shows one read-only. The slug is
 * filled in from the display name until edited, kept in the shape the server
 * takes as it is typed, and anything still wrong is said in words.
 */
export function ReferenceTypeModal({
  workspaceId,
  editing,
  viewing,
  embedded = false,
  onSuccess,
  onClose,
}: ModalProps) {
  const queryClient = useQueryClient();
  const id = useId();
  const readOnly = editing === null && viewing !== undefined;
  const creating = editing === null && viewing === undefined;
  const [form, setForm] = useState<TypeForm>(() => {
    const from = editing ?? viewing;
    return {
      displayName: from?.displayName ?? '',
      type: from?.type ?? '',
      instructions: from?.instructions ?? '',
      valueHint: from?.valueHint ?? '',
      access: editing ? accessOf(editing) : 'shared',
    };
  });
  // The slug follows the name until the person types into it.
  const slugEdited = useRef(!creating);
  const [touchedSlug, setTouchedSlug] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = useQuery({
    queryKey: referenceTypesKey(workspaceId),
    queryFn: () => rpc.workspaces.listReferenceTypes({ workspaceId }),
    enabled: creating,
  });
  const builtin = new Set((visible.data ?? []).filter((t) => t.isBuiltin).map((t) => t.type));
  const taken = new Set((visible.data ?? []).filter((t) => !t.isBuiltin).map((t) => t.type));
  const problem = creating ? slugProblem(form.type, { builtin, taken }) : null;
  const nameMissing = form.displayName.trim() === '';

  useEffect(() => {
    if (creating && !slugEdited.current) {
      setForm((now) => ({ ...now, type: slugFromName(now.displayName) }));
    }
  }, [creating, form.displayName]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = creating
        ? await rpc.workspaces.createReferenceType({
            workspaceId,
            input: inputOf(form),
          })
        : await rpc.workspaces.updateReferenceType({
            workspaceId,
            type: form.type,
            changes: changesOf(editing as ManagedReferenceType, form),
          });
      await invalidateReferenceTypes(queryClient, workspaceId);
      toast({ title: creating ? `"${saved.displayName}" added` : 'Saved' });
      onSuccess(saved);
    } catch (e) {
      setError(failureText(e, creating ? 'Could not add the type.' : 'Could not save the type.'));
      setSaving(false);
    }
  };

  const title = creating
    ? 'New reference type'
    : readOnly
      ? (viewing?.displayName ?? 'Reference type')
      : `Edit ${editing?.displayName ?? 'reference type'}`;

  return (
    <div
      className="contents"
      onKeyDownCapture={(e) => {
        if (embedded && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (!saving) onClose();
        }
      }}
    >
      <ModalLayout
        header={
          <DialogHeader showCloseButton={!saving && !embedded}>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
        }
        footer={
          <DialogFooter>
            {readOnly ? (
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                  {embedded ? 'Back' : 'Cancel'}
                </Button>
                <Button
                  type="button"
                  onClick={() => void save()}
                  disabled={
                    saving ||
                    nameMissing ||
                    problem !== null ||
                    (editing !== null && Object.keys(changesOf(editing, form)).length === 0)
                  }
                >
                  {saving ? 'Saving…' : creating ? 'Add type' : 'Save'}
                </Button>
              </>
            )}
          </DialogFooter>
        }
      >
        <DialogContentArea className="max-h-[calc(100dvh-2rem-var(--modal-chrome,10rem))] gap-4 overflow-y-auto">
          {readOnly && viewing?.isBuiltin && (
            <p className="text-sm text-foreground-muted">
              Comes with Switch, so it can’t be changed.
            </p>
          )}
          {readOnly && !viewing?.isBuiltin && (
            <p className="text-sm text-foreground-muted">
              {viewing?.ownerName ? `${viewing.ownerName}’s type. ` : ''}Only its owner or an admin
              changes it.
            </p>
          )}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={form.displayName}
                disabled={readOnly}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="Linear issues"
                autoFocus={!readOnly}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-slug`}>Slug</FieldLabel>
              <Input
                id={`${id}-slug`}
                value={form.type}
                disabled={!creating}
                aria-invalid={creating && touchedSlug && problem !== null}
                className="h-9 font-mono text-[13px] leading-6 md:text-[13px]"
                onChange={(e) => {
                  slugEdited.current = true;
                  setTouchedSlug(true);
                  setForm({ ...form, type: slugAsTyped(e.target.value) });
                }}
                onBlur={() => setTouchedSlug(true)}
                placeholder="linear_issues"
              />
              {creating && (touchedSlug || form.type !== '') && problem !== null ? (
                <p className="text-xs text-destructive">{problem}</p>
              ) : null}
              <p className="text-xs text-foreground-muted">
                Stored on every reference of this type, so it cannot be changed later.
              </p>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-hint`}>What the links point at</FieldLabel>
              <Input
                id={`${id}-hint`}
                value={form.valueHint}
                disabled={readOnly}
                onChange={(e) => setForm({ ...form, valueHint: e.target.value })}
                placeholder="Links to Linear issues, e.g. https://linear.app/acme/issue/ENG-123"
              />
              <p className="text-xs text-foreground-muted">
                Shown under the links when someone adds a reference of this type.
              </p>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-instructions`}>Instructions for agents</FieldLabel>
              <Textarea
                id={`${id}-instructions`}
                value={form.instructions}
                disabled={readOnly}
                onChange={(e) => setForm({ ...form, instructions: e.target.value })}
                placeholder="What an agent needs to use these links, such as the connector to read them with"
                className="min-h-20"
              />
              <p className="text-xs text-foreground-muted">
                Every agent in a room with a reference of this type is told this.
              </p>
            </Field>
            {!readOnly && (
              <Field>
                <FieldLabel>Who can see it</FieldLabel>
                <div className="flex">
                  <SegmentedControl
                    value={form.access}
                    onChange={(access) => setForm({ ...form, access })}
                    options={LIBRARY_ACCESS_OPTIONS}
                    ariaLabel="Who can see it"
                  />
                </div>
                <p className="text-xs text-foreground-muted">
                  {LIBRARY_ACCESS_OPTIONS.find((o) => o.value === form.access)?.hint}
                </p>
              </Field>
            )}
          </FieldGroup>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </DialogContentArea>
      </ModalLayout>
    </div>
  );
}

function inputOf(form: TypeForm): ReferenceTypeInput {
  return {
    type: form.type,
    displayName: form.displayName.trim(),
    instructions: form.instructions.trim(),
    valueHint: form.valueHint.trim(),
    ...visibilityOf(form.access),
  };
}

/** Only what changed, so a save does not overwrite another field someone else changed. */
export function changesOf(before: ManagedReferenceType, form: TypeForm): ReferenceTypeChanges {
  const next = inputOf(form);
  const changes: ReferenceTypeChanges = {};
  if (next.displayName !== before.displayName) changes.displayName = next.displayName;
  if (next.instructions !== before.instructions) changes.instructions = next.instructions;
  if (next.valueHint !== before.valueHint) changes.valueHint = next.valueHint;
  if (form.access !== accessOf(before)) {
    changes.readVisibility = next.readVisibility;
    changes.writeVisibility = next.writeVisibility;
  }
  return changes;
}
