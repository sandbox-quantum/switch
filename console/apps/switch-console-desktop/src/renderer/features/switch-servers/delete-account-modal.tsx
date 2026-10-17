import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import { Spinner } from '@renderer/lib/ui/spinner';
import { BUILD_FEATURE_FLAGS } from '@shared/core/feature-flags/feature-flags';
import { switchServersStore } from './switch-servers-store';

type Args = { serverId: string; serverName: string; email: string };

/**
 * Deleting your account on a server, confirmed by typing its email: an SSO
 * account has no password to ask for. Says what goes and what stays before,
 * and the server's own reason when it refuses. Once it is gone, "Start over"
 * opens the first-run pages, for whoever wants to come back as someone new.
 */
export const DeleteAccountModal = observer(function DeleteAccountModal({
  serverId,
  serverName,
  email,
  onClose,
}: Args & BaseModalProps<void>) {
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const matches = typed.trim().toLowerCase() === email.toLowerCase();

  const confirm = async () => {
    if (!matches || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await switchServersStore.deleteAccount(serverId, typed.trim());
      setDeleted(true);
    } catch (cause) {
      setError(failureText(cause, 'Could not delete your account.'));
    } finally {
      setDeleting(false);
    }
  };

  if (deleted)
    return (
      <>
        <DialogHeader>
          <DialogTitle>Your account is deleted</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="pt-0">
          <p className="text-sm text-foreground-muted">
            {email} no longer has an account on {serverName}. Signing in again with it creates a new
            one.
          </p>
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {BUILD_FEATURE_FLAGS.onboarding && (
            <Button
              onClick={() => {
                onClose();
                onboardingStore.rehearse();
                appState.navigation.navigate('home');
              }}
            >
              Start over
            </Button>
          )}
        </DialogFooter>
      </>
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete your account on {serverName}?</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="gap-4 pt-0">
        <div className="space-y-2 text-sm text-foreground-muted">
          <p>This can't be undone.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Your agents, the machines you connected, and your templates, references, documents and
              packages are deleted.
            </li>
            <li>
              Rooms you created stay, for the rest of the workspace. Your private chats are
              archived.
            </li>
            <li>A workspace only you are in is left empty.</li>
          </ul>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="delete-account-email">
            Type <span className="font-medium text-foreground">{email}</span> to confirm
          </Label>
          <Input
            id="delete-account-email"
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void confirm();
            }}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={deleting}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={() => void confirm()}
          disabled={!matches || deleting}
        >
          {deleting && <Spinner className="size-3.5" />}
          Delete my account
        </Button>
      </DialogFooter>
    </>
  );
});
