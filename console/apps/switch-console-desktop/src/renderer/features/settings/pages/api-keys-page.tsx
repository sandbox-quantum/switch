import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Plus, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@renderer/lib/components/page-header';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Alert } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Spinner } from '@renderer/lib/ui/spinner';
import {
  type CreatedRegistrationKey,
  type SwitchApiKey,
} from '@shared/core/switch-servers/switch-servers';
import {
  DEFAULT_KEY_LIFETIME,
  describeCreatedKeyExpiry,
  formatKeyExpiry,
  KEY_LIFETIMES,
  type KeyLifetimeChoice,
  keyLifetime,
  NEVER_EXPIRES_WARNING,
  splitApiKeys,
} from './api-keys';
import { OnSignedInServer, SectionLabel, settingsServer } from './settings-server';

/** Keyed on the person as well as the server, so one person's keys are never shown to the next to sign in. */
export const apiKeysQueryKey = (serverId: string, userId: string) => [
  'my-api-keys',
  serverId,
  userId,
];

/**
 * Your keys on the server: the registration keys you made to register agents
 * with, and your agents' own keys. Everyone's keys are the workspace's
 * business, in the gateway; these are only yours.
 */
export const ApiKeysSettingsPage = observer(function ApiKeysSettingsPage() {
  const { server } = settingsServer();
  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        sticky
        title="API keys"
        description={`Manage registration tokens for connecting agents to ${server?.name ?? 'this Switch server'}.`}
      />
      <OnSignedInServer>
        {({ server, user }) => <ApiKeys serverId={server.id} userId={user.id} />}
      </OnSignedInServer>
    </div>
  );
});

function ApiKeys({ serverId, userId }: { serverId: string; userId: string }) {
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: apiKeysQueryKey(serverId, userId),
    queryFn: () => rpc.switchServers.listMyApiKeys(serverId),
  });
  const [created, setCreated] = useState<CreatedRegistrationKey | null>(null);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: apiKeysQueryKey(serverId, userId) });

  if (keys.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Spinner /> Loading keys…
      </div>
    );
  }
  if (keys.isError) {
    return (
      <p className="text-sm text-destructive">
        {describeFailure(keys.error, 'Could not load your keys.').headline}
      </p>
    );
  }
  const { registration, agent } = splitApiKeys(keys.data ?? []);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionLabel>Registration keys</SectionLabel>
        <CreateRegistrationKey
          serverId={serverId}
          onCreated={(key) => {
            setCreated(key);
            refresh();
          }}
        />
        {created && <CreatedKey created={created} onDismiss={() => setCreated(null)} />}
        <KeyTable
          serverId={serverId}
          keys={registration}
          empty="You have no registration keys."
          canDelete
          onDeleted={refresh}
        />
      </section>
      <section className="space-y-3">
        <SectionLabel>Agent keys</SectionLabel>
        <p className="text-sm text-foreground-muted">
          Each of your agents signs in with its own key.
        </p>
        <KeyTable
          serverId={serverId}
          keys={agent}
          empty="None of your agents has a key yet."
          canDelete={false}
          onDeleted={refresh}
        />
      </section>
    </div>
  );
}

function CreateRegistrationKey({
  serverId,
  onCreated,
}: {
  serverId: string;
  onCreated: (key: CreatedRegistrationKey) => void;
}) {
  const [label, setLabel] = useState('');
  const [lifetime, setLifetime] = useState<KeyLifetimeChoice>(DEFAULT_KEY_LIFETIME);
  const create = useMutation({
    mutationFn: () =>
      rpc.switchServers.createRegistrationKey({
        serverId,
        label: label.trim(),
        lifetime: keyLifetime(lifetime),
      }),
    onSuccess: (key) => {
      setLabel('');
      setLifetime(DEFAULT_KEY_LIFETIME);
      onCreated(key);
    },
    onError: (error) => {
      const { headline, detail } = describeFailure(error, 'Could not create the key.');
      toast.error(headline, detail ? { description: detail } : undefined);
    },
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (label.trim()) create.mutate();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="New key's label"
          placeholder="Label, such as the agent or machine it is for"
          value={label}
          maxLength={255}
          onChange={(event) => setLabel(event.target.value)}
          className="max-w-sm"
        />
        <Button type="submit" size="sm" disabled={!label.trim() || create.isPending}>
          <Plus className="size-4" />
          Create registration key
        </Button>
      </div>
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <span>Expires after</span>
        <SegmentedControl
          value={lifetime}
          onChange={setLifetime}
          options={KEY_LIFETIMES}
          ariaLabel="Expires after"
        />
      </div>
      {lifetime === 'never' && <Alert variant="warning">{NEVER_EXPIRES_WARNING}</Alert>}
    </form>
  );
}

/** A key just made: shown in full here, once, so it can be copied. */
function CreatedKey({
  created,
  onDismiss,
}: {
  created: CreatedRegistrationKey;
  onDismiss: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background-1 p-3">
      <p className="text-sm text-foreground">
        <span className="font-medium">{created.label}</span> is ready. Copy it here, or later from
        the list below. {describeCreatedKeyExpiry(created.expiresAt)}
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-background-2 px-2 py-1 font-mono text-xs">
          {created.key}
        </code>
        <CopyButton label="Copy key" read={() => Promise.resolve(created.key)} />
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}

function KeyTable({
  serverId,
  keys,
  empty,
  canDelete,
  onDeleted,
}: {
  serverId: string;
  keys: SwitchApiKey[];
  empty: string;
  canDelete: boolean;
  onDeleted: () => void;
}) {
  if (keys.length === 0) return <p className="text-sm text-foreground-muted">{empty}</p>;
  const now = new Date();
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-foreground-muted">
            <th className="px-3 py-2 font-normal">Label</th>
            {/* The start of the key's hash, not of the key: it tells keys apart without showing one. */}
            <th className="px-3 py-2 font-normal">Fingerprint</th>
            <th className="px-3 py-2 font-normal">Created</th>
            <th className="px-3 py-2 font-normal">Expires</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} className="border-b border-border last:border-b-0">
              <td className="px-3 py-2 text-foreground">{key.label}</td>
              <td className="px-3 py-2 font-mono text-xs text-foreground-muted">{key.keyPrefix}</td>
              <td className="px-3 py-2 text-foreground-muted">{key.createdAt.slice(0, 10)}</td>
              <ExpiryCell expiresAt={key.expiresAt} now={now} />
              <td className="px-3 py-2">
                <span className="flex items-center justify-end gap-1">
                  <CopyButton
                    label={`Copy ${key.label}`}
                    read={() => rpc.switchServers.revealApiKey({ serverId, keyId: key.id })}
                  />
                  {canDelete && key.type === 'registration' && (
                    <DeleteKeyButton serverId={serverId} apiKey={key} onDeleted={onDeleted} />
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExpiryCell({ expiresAt, now }: { expiresAt: string | null; now: Date }) {
  const text = formatKeyExpiry(expiresAt, now);
  const expired = expiresAt !== null && new Date(expiresAt) <= now;
  return (
    <td className={expired ? 'px-3 py-2 text-destructive' : 'px-3 py-2 text-foreground-muted'}>
      {text}
    </td>
  );
}

function CopyButton({ label, read }: { label: string; read: () => Promise<string> }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await read());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      const { headline, detail } = describeFailure(error, 'Could not copy the key.');
      toast.error(headline, detail ? { description: detail } : undefined);
    }
  };
  return (
    <Button size="icon-sm" variant="ghost" aria-label={label} onClick={() => void copy()}>
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
}

/** Deleting a key stops every agent still registering with it, so it asks first. */
function DeleteKeyButton({
  serverId,
  apiKey,
  onDeleted,
}: {
  serverId: string;
  apiKey: SwitchApiKey;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => rpc.switchServers.deleteApiKey({ serverId, keyId: apiKey.id }),
    onSuccess: () => {
      setConfirming(false);
      onDeleted();
    },
    onError: (error) => {
      setConfirming(false);
      const { headline, detail } = describeFailure(error, 'Could not delete the key.');
      toast.error(headline, detail ? { description: detail } : undefined);
    },
  });
  if (!confirming) {
    return (
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Delete ${apiKey.label}`}
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="size-4" />
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <span className="text-xs text-foreground-muted">Delete?</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={remove.isPending}
        onClick={() => setConfirming(false)}
      >
        No
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={remove.isPending}
        onClick={() => remove.mutate()}
      >
        {remove.isPending ? 'Deleting…' : 'Delete'}
      </Button>
    </span>
  );
}
