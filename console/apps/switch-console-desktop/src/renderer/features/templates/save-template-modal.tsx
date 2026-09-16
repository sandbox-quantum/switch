import { useId, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';

export type SaveTemplateArgs = {
  serverId: string;
  serverName?: string | null;
  kind: 'agent' | 'room';
  content: string;
  /** Prefilled from the document; the person can change both. */
  name: string;
  description: string;
};

type Props = BaseModalProps<{ id: string }> & SaveTemplateArgs;

/**
 * The one step between "this document" and "a template everyone on the
 * server sees": what it is called there, and the line under the name. A file
 * name is a poor name for a listing, so this is asked rather than guessed.
 */
export function SaveTemplateModal({
  serverId,
  serverName,
  kind,
  content,
  name: initialName,
  description: initialDescription,
  onSuccess,
  onClose,
}: Props) {
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await rpc.switchServers.saveTemplate({
        serverId,
        name: name.trim(),
        description: description.trim(),
        kind,
        content,
      });
      toast({ title: `"${name.trim()}" is now on ${serverName ?? 'the server'}` });
      onSuccess({ id: saved.id });
    } catch (e) {
      setError(failureText(e, 'Could not save the template to the server.'));
      setSaving(false);
    }
  };

  return (
    <ModalLayout
      header={
        <DialogHeader showCloseButton={!saving}>
          <DialogTitle>Save to {serverName ?? 'the server'}</DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={saving || name.trim().length === 0}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      }
    >
      <DialogContentArea className="gap-4">
        <p className="text-sm text-foreground-muted">
          Everyone on this server will find it under Templates.{' '}
          <Badge variant="outline">{kind} template</Badge>
        </p>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={nameId}>Name</FieldLabel>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === 'agent' ? 'Switch expert' : 'Coder and reviewer workroom'}
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={descriptionId}>
              Description <span className="text-foreground-muted">(optional)</span>
            </FieldLabel>
            <Input
              id={descriptionId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What it is for, in a line"
            />
          </Field>
        </FieldGroup>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
}
