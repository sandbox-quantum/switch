import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { toast } from 'sonner';
import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
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
import { isSwitchCloudServer } from './switch-cloud-store';
import { switchServersStore } from './switch-servers-store';

type Args = { serverId: string; serverName: string; email: string; mode: 'delete' | 'reset' };

/**
 * Deleting your account on a server, confirmed by typing its email: an SSO
 * account has no password to ask for. Says what goes and what stays before,
 * and the server's own reason when it refuses. Once it is gone, "Start over"
 * opens the first-run pages, for whoever wants to come back as someone new.
 * `reset` is the dev-only variant that wipes a test account and everything it
 * owns on a server that allows it, then opens that server's sign-in page in the
 * first-run flow, where a new account starts.
 */
export const DeleteAccountModal = observer(function DeleteAccountModal({
  serverId,
  serverName,
  email,
  mode,
  onClose,
}: Args & BaseModalProps<void>) {
  const reset = mode === 'reset';
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
      if (reset) {
        await switchServersStore.resetTestAccount(serverId, typed.trim());
        startOnboardingOn(serverId);
        onClose();
        toast.success('Test account reset');
        return;
      }
      await switchServersStore.deleteAccount(serverId, typed.trim());
      setDeleted(true);
    } catch (cause) {
      // The server's refusal is already a sentence saying what to do first.
      const { headline, detail } = describeFailure(
        cause,
        reset ? 'Could not reset the test account.' : 'Could not delete your account.'
      );
      setError(detail ?? headline);
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
            one. Files your agents kept on this computer stay in their folders.
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
        <DialogTitle>
          {reset
            ? `Reset the test account on ${serverName}?`
            : `Delete your account on ${serverName}?`}
        </DialogTitle>
      </DialogHeader>
      <DialogContentArea className="gap-4 pt-0">
        <div className="space-y-2 text-sm text-foreground-muted">
          <p>This can't be undone.</p>
          {reset ? (
            <ul className="list-disc space-y-1 pl-5">
              <li>For test accounts only.</li>
              <li>
                Everything this account has on {serverName} is wiped: messaging and Slack installs
                are disconnected, and its agents, machines, rooms, workspace, organization and user
                are deleted.
              </li>
            </ul>
          ) : (
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Your agents, the machines you connected, and your templates, references, documents
                and packages are deleted.
              </li>
              <li>
                Rooms you created stay, for the rest of the workspace. Your private chats are
                archived.
              </li>
              <li>A workspace only you are in is left empty.</li>
            </ul>
          )}
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
          {reset ? 'Reset test account' : 'Delete my account'}
        </Button>
      </DialogFooter>
    </>
  );
});

/**
 * Put the window on the first-run sign-in page for a server whose account was
 * just wiped: the server stays added and signed out, so a new account starts there.
 */
function startOnboardingOn(serverId: string): void {
  const server = switchServersStore.serverById(serverId);
  if (server === null) throw new Error('The reset server is no longer in the server list.');
  onboardingStore.connected(server, isSwitchCloudServer(server) ? 'cloud' : 'external', false);
  appState.navigation.navigate('home');
}
