import { Button } from '@switch-console/chat-ui/primitives/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@switch-console/chat-ui/primitives/dialog';
import { Field, FieldGroup, FieldLabel } from '@switch-console/chat-ui/primitives/field';
import { Input } from '@switch-console/chat-ui/primitives/input';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { useSessionSettings } from '@renderer/features/sessions/hooks/useSessionSettings';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  liveTransformSessionName,
  MAX_SESSION_NAME_LENGTH,
  normalizeSessionName,
  sessionNameCollisionKey,
} from '@renderer/utils/sessionNames';

type RenameSessionModalArgs = {
  locationId: string;
  sessionId: string;
  currentName: string;
};

type Props = BaseModalProps<void> & RenameSessionModalArgs;

export const RenameSessionModal = observer(function RenameSessionModal({
  locationId,
  sessionId,
  currentName,
  onSuccess,
  onClose,
}: Props) {
  const [name, setName] = useState(currentName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { preserveNameCapitalization } = useSessionSettings();

  const sessionManager = getSessionManagerStore(locationId);
  const siblingNames = new Set(
    Array.from(sessionManager?.sessions.values() ?? [])
      .filter((t) => t.state !== 'unregistered' && t.data.id !== sessionId)
      .map((t) => sessionNameCollisionKey(t.data.title))
  );

  const normalizedName = normalizeSessionName(name, {
    preserveCapitalization: preserveNameCapitalization,
  });
  const isDuplicate = siblingNames.has(sessionNameCollisionKey(normalizedName));
  const isUnchanged = normalizedName === currentName;
  const isEmpty = normalizedName.length === 0;
  const isValid = !isEmpty && !isDuplicate && !isUnchanged;

  const validationMessage = isDuplicate
    ? 'A session with this name already exists in this location.'
    : isEmpty
      ? 'Session name cannot be empty.'
      : undefined;

  const handleNameChange = useCallback(
    (value: string) => {
      setName(
        liveTransformSessionName(value, {
          preserveCapitalization: preserveNameCapitalization,
        })
      );
      setError(null);
    },
    [preserveNameCapitalization]
  );

  const handleSubmit = useCallback(async () => {
    if (!isValid) return;
    const session = sessionManager?.sessions.get(sessionId);
    if (!session) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await session.rename(normalizedName);
      if (!result.success) {
        setError('Session not found.');
        setIsSubmitting(false);
        return;
      }
      onSuccess();
    } catch (e) {
      setError(failureText(e, 'Could not rename the session.'));
      setIsSubmitting(false);
    }
  }, [isValid, sessionManager, sessionId, normalizedName, onSuccess]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Rename session</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel>Session name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit();
              }}
              maxLength={MAX_SESSION_NAME_LENGTH}
              autoFocus
            />
            {validationMessage && !isUnchanged && (
              <p className="mt-1 text-xs text-destructive">{validationMessage}</p>
            )}
            {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
          </Field>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void handleSubmit()} disabled={!isValid || isSubmitting}>
          {isSubmitting ? 'Renaming...' : 'Rename'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
