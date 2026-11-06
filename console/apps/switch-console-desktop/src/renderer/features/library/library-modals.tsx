import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';
import type { LibraryItem, LibraryKind } from '@shared/core/switch-servers/library';
import { emptyForm, formProblem, inputOf, type LibraryForm } from './library-form';
import { LibraryItemFields } from './library-item-form';
import { hiddenRoomsText, KIND_TEXT } from './library-model';
import {
  forgetLibraryItem,
  invalidateLibrary,
  libraryRoomsKey,
  referenceTypesKey,
} from './library-queries';
import { ReferenceTypeModal } from './reference-types';

type NewProps = BaseModalProps<LibraryItem> & { workspaceId: string; kind: LibraryKind };

/** Add a reference or a document to the workspace's library. */
export function NewLibraryItemModal({ workspaceId, kind, onSuccess, onClose }: NewProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<LibraryForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const types = useQuery({
    queryKey: referenceTypesKey(workspaceId),
    queryFn: () => rpc.workspaces.listReferenceTypes({ workspaceId }),
    enabled: kind === 'references',
  });
  const text = KIND_TEXT[kind];
  const problem = formProblem(kind, form);
  // A new type is made in this same window (one modal at a time), then picked.
  const [addingType, setAddingType] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await rpc.workspaces.createLibraryItem({
        workspaceId,
        kind,
        input: inputOf(kind, form),
      });
      await invalidateLibrary(queryClient, workspaceId, kind);
      toast({ title: `"${created.name}" added to Resources` });
      onSuccess(created);
    } catch (e) {
      setError(failureText(e, `Could not add the ${text.noun}.`));
      setSaving(false);
    }
  };

  if (addingType) {
    return (
      <ReferenceTypeModal
        workspaceId={workspaceId}
        editing={null}
        embedded
        onSuccess={(created) => {
          setForm((now) => ({ ...now, type: created.type }));
          setAddingType(false);
        }}
        onClose={() => setAddingType(false)}
      />
    );
  }

  return (
    <ModalLayout
      header={
        <DialogHeader showCloseButton={!saving}>
          <DialogTitle>New {text.noun}</DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter>
          {problem && form.name.trim() && (
            <span className="mr-auto self-center text-xs text-foreground-muted">{problem}</span>
          )}
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving || problem !== null}>
            {saving ? 'Adding…' : `Add ${text.noun}`}
          </Button>
        </DialogFooter>
      }
    >
      <DialogContentArea className="max-h-[calc(100dvh-2rem-var(--modal-chrome,10rem))] gap-4 overflow-y-auto">
        {kind === 'references' && types.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {failureText(types.error, 'Could not read the reference types.')}
            </AlertDescription>
          </Alert>
        ) : (
          <LibraryItemFields
            kind={kind}
            form={form}
            onChange={setForm}
            types={types.data ?? []}
            autoFocus
            onNewType={kind === 'references' ? () => setAddingType(true) : null}
          />
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
}

type DeleteProps = BaseModalProps<void> & {
  workspaceId: string;
  item: Pick<LibraryItem, 'id' | 'kind' | 'name' | 'packageIds' | 'hiddenRoomsCount'>;
};

/**
 * Asks before deleting a library item, naming what it comes out of: every room
 * it is attached to and every package it is in, for everyone.
 */
export function DeleteLibraryItemModal({ workspaceId, item, onSuccess, onClose }: DeleteProps) {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rooms = useQuery({
    queryKey: libraryRoomsKey(workspaceId, item.kind, item.id),
    queryFn: () =>
      rpc.workspaces.listLibraryItemRooms({ workspaceId, kind: item.kind, itemId: item.id }),
  });
  const packages = useQuery({
    queryKey: ['library', workspaceId, 'packages'],
    queryFn: () => rpc.workspaces.listLibrary({ workspaceId, kind: 'packages' }),
    enabled: item.packageIds.length > 0,
  });
  const packageNames = item.packageIds.map(
    (id) => packages.data?.find((p) => p.id === id)?.name ?? 'a package you cannot see'
  );
  const noun = KIND_TEXT[item.kind].noun;
  // Rooms it is in that you cannot open: the server counts them for its owner, never names them.
  const hidden = item.hiddenRoomsCount ?? 0;

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await rpc.workspaces.deleteLibraryItem({ workspaceId, kind: item.kind, itemId: item.id });
      toast({ title: `"${item.name}" deleted` });
      // Leave first (closing this and, from its page, the page itself), then
      // drop what was read for the item rather than reading it again: it is gone.
      onSuccess();
      await forgetLibraryItem(queryClient, workspaceId, item.kind, item.id);
    } catch (e) {
      setError(failureText(e, `Could not delete the ${noun}.`));
      setDeleting(false);
    }
  };

  return (
    <ModalLayout
      header={
        <DialogHeader showCloseButton={!deleting}>
          <DialogTitle>Delete {item.name}?</DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void remove()}
            disabled={deleting || rooms.isPending}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      }
    >
      <DialogContentArea className="gap-3">
        <p className="text-sm text-foreground-muted">
          The {noun} is deleted for everyone. This cannot be undone.
        </p>
        {rooms.isPending ? (
          <Loader2 className="size-4 animate-spin text-foreground-muted" />
        ) : rooms.isError ? (
          <p className="text-xs text-destructive">
            {failureText(rooms.error, 'Could not list the rooms it is in.')}
          </p>
        ) : rooms.data.length > 0 ? (
          <WhatItLeaves
            title="It is removed from these rooms:"
            names={[
              ...rooms.data.map((r) => r.roomName),
              ...(hidden > 0 ? [`and ${hiddenRoomsText(hidden)}`] : []),
            ]}
          />
        ) : hidden > 0 ? (
          <p className="text-sm text-foreground">It is removed from {hiddenRoomsText(hidden)}.</p>
        ) : (
          <p className="text-sm text-foreground-muted">
            It is not attached to any room you can see.
          </p>
        )}
        {packageNames.length > 0 && (
          <WhatItLeaves title="And from these packages:" names={packageNames} />
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
}

function WhatItLeaves({ title, names }: { title: string; names: string[] }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-foreground">{title}</span>
      <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-foreground-muted">
        {names.map((name, i) => (
          <li key={`${name}-${i}`}>{name}</li>
        ))}
      </ul>
    </div>
  );
}
