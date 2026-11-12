import { useMutation } from '@tanstack/react-query';
import { CircleCheck, LogOut, Pencil, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import { type SwitchServer, type SwitchUser } from '@shared/core/switch-servers/switch-servers';
import { OnSignedInServer } from './settings-server';

/** Your profile on the server, and how to leave it. */
export function AccountSettingsPage() {
  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        sticky
        title="Your account"
        description="Your profile in Switch, and how to leave it."
      />
      <OnSignedInServer>
        {/* Keyed on the server so a half-typed name never carries over to another one. */}
        {({ server, user }) => <Account key={server.id} server={server} user={user} />}
      </OnSignedInServer>
    </div>
  );
}

const Account = observer(function Account({
  server,
  user,
}: {
  server: SwitchServer;
  user: SwitchUser;
}) {
  const showDeleteAccount = useShowModal('deleteAccountModal');
  // Only a server that signs people in with a password, and only an account
  // that has one: one made through single sign-on has no password to change.
  const passwords =
    (switchServersStore.authConfigFor(server.id)?.passwordLoginEnabled ?? false) &&
    user.hasPassword !== false;
  useEffect(() => {
    void switchServersStore.ensureAuthConfig(server.id);
  }, [server.id]);

  return (
    <div className="space-y-6">
      <DisplayName serverId={server.id} name={user.name} />
      <div className="space-y-1.5">
        <Label htmlFor="account-email">Email</Label>
        <Input id="account-email" value={user.email} readOnly className="max-w-md" />
      </div>
      {passwords && <ChangePassword serverId={server.id} />}

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm text-foreground">Sign out of this Console</p>
          <p className="text-sm text-foreground-muted">
            This computer only. Your agents keep running and your other devices stay signed in.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void switchServersStore.logout(server.id)}
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      </div>

      <div className="space-y-3 rounded-lg border border-destructive/40 p-4">
        <div className="space-y-0.5">
          <p className="text-sm text-destructive">Delete account</p>
          <p className="text-sm text-foreground-muted">
            Permanent: your agents, your devices and everything else you own are deleted. Rooms you
            created stay, for the workspace’s admins to manage.
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() =>
            showDeleteAccount({ serverId: server.id, serverName: server.name, email: user.email })
          }
        >
          <Trash2 className="size-4" />
          Delete my account
        </Button>
      </div>
    </div>
  );
});

/** Your name as others in the workspace see it, changed in place. */
function DisplayName({ serverId, name }: { serverId: string; name: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  // The field is the same element read-only and editable, so it is focused
  // here rather than by autoFocus, which only acts when an element mounts.
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const save = useMutation({
    mutationFn: () => rpc.switchServers.updateMyName({ serverId, name: draft.trim() }),
    onSuccess: async () => {
      setEditing(false);
      await switchServersStore.refreshStatus(serverId);
    },
    onError: (error) => {
      const { headline, detail } = describeFailure(error, 'Could not change your name.');
      toast.error(headline, detail ? { description: detail } : undefined);
    },
  });
  const trimmed = draft.trim();
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed && trimmed !== name) save.mutate();
        else setEditing(false);
      }}
    >
      <Label htmlFor="account-name">Display name</Label>
      <div className="flex max-w-md items-center gap-2">
        <Input
          id="account-name"
          ref={input}
          value={editing ? draft : name}
          readOnly={!editing}
          maxLength={255}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false);
          }}
        />
        {editing ? (
          <>
            <Button type="submit" size="sm" disabled={!trimmed || save.isPending}>
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Change display name"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
          >
            <Pencil className="size-4" />
          </Button>
        )}
      </div>
    </form>
  );
}

export function ChangePassword({ serverId }: { serverId: string }) {
  const [open, setOpen] = useState(false);
  // Said on the page rather than in a toast that can be missed, and held here
  // only, so it is gone once the person navigates away and back.
  const [changed, setChanged] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const reset = () => {
    setOpen(false);
    setCurrent('');
    setNext('');
    setConfirm('');
  };
  const change = useMutation({
    mutationFn: () =>
      rpc.switchServers.changeMyPassword({
        serverId,
        currentPassword: current,
        newPassword: next,
      }),
    onSuccess: () => {
      reset();
      setChanged(true);
      // Anything refused in the moment between the server ending the old
      // session and Console keeping the new one can have shown the server as
      // signed out; read its status again now the new session is in place.
      void switchServersStore.refreshStatus(serverId);
    },
    onError: (error) => {
      const { headline, detail } = describeFailure(error, 'Could not change your password.');
      toast.error(headline, detail ? { description: detail } : undefined);
    },
  });

  if (!open) {
    return (
      <div className="space-y-1.5">
        <Label>Password</Label>
        {changed && (
          <Alert variant="success" className="max-w-md">
            <CircleCheck />
            <AlertTitle>Password changed successfully</AlertTitle>
          </Alert>
        )}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setChanged(false);
              setOpen(true);
            }}
          >
            Change password
          </Button>
        </div>
      </div>
    );
  }
  const mismatch = confirm.length > 0 && confirm !== next;
  return (
    <form
      className="max-w-md space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (current && next && next === confirm) change.mutate();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="account-current-password">Current password</Label>
        <Input
          id="account-current-password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="account-new-password">New password</Label>
        <Input
          id="account-new-password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="account-confirm-password">Confirm new password</Label>
        <Input
          id="account-confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        {mismatch && <p className="text-xs text-destructive">The passwords do not match.</p>}
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!current || !next || next !== confirm || change.isPending}
        >
          Change password
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={reset}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
