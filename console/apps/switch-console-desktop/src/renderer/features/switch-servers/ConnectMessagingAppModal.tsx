import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useMemo, useState } from 'react';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel, bridgeSetupDocsUrl } from '@renderer/lib/components/bridge-platform';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { cn } from '@renderer/utils/utils';
import type { CreateBridgeResult } from '@shared/core/switch-servers/switch-servers';
import { switchServersStore } from './switch-servers-store';

type ConnectMessagingAppModalArgs = {
  /** Attach to this server instead of the active one. */
  serverId?: string;
};

/** What the caller needs to decide what to do next. `directorySearchSupported`
 * says whether there is any point offering the link-your-account step: on a
 * platform without a directory, a connection nobody has used yet knows nobody,
 * so the search would be a form that cannot be filled in. */
type ConnectedApp = {
  bridgeId: string;
  displayName: string;
  directorySearchSupported: boolean;
};

type Props = BaseModalProps<ConnectedApp> & ConnectMessagingAppModalArgs;

export const ConnectMessagingAppModal = observer(function ConnectMessagingAppModal({
  serverId: overrideServerId,
  onSuccess,
  onClose,
}: Props) {
  const { setCloseGuard } = useModalContext();

  const serverId = overrideServerId ?? switchServersStore.activeServerId ?? '';
  const server = switchServersStore.servers.find((s) => s.id === serverId) ?? null;
  const isAdmin = switchServersStore.statusFor(serverId)?.user?.role === 'admin';

  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  // Credential values. Renderer-local and never persisted: this state dies with
  // the modal, and the only thing that reads it is the submit call.
  const [config, setConfig] = useState<Record<string, string>>({});
  const [setAsDefault, setSetAsDefault] = useState(false);
  // Defaults on: most platforms can create channels, and the server rejects
  // this staying true for one that can't rather than us guessing wrong.
  const [channelCreationEnabled, setChannelCreationEnabled] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typesQuery = useQuery({
    queryKey: ['remote-bridge-types', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridgeTypes(serverId),
    enabled: !!serverId,
  });

  const types = useMemo(() => typesQuery.data ?? [], [typesQuery.data]);
  const selectedType = types.find((t) => t.key === typeKey) ?? null;
  // Unknown until the type list has loaded; assume supported so the checkbox
  // isn't forced off while that request is in flight.
  const channelCreationSupported = selectedType?.channelCreationSupported ?? true;

  const handleTypeChange = useCallback((next: string | null) => {
    // Switching platform drops whatever was typed for the previous one — those
    // fields do not exist on the new type, and carrying a stale token forward
    // would silently submit a credential the user thinks they replaced.
    setTypeKey(next);
    setConfig({});
    setChannelCreationEnabled(true);
    setError(null);
  }, []);

  const trimmedName = displayName.trim();
  const missingRequired = (selectedType?.fields ?? []).some(
    (f) => f.required && !(config[f.key] ?? '').trim()
  );
  const canSubmit =
    !!serverId && isAdmin && !!selectedType && !!trimmedName && !missingRequired && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selectedType) return;
    setIsSubmitting(true);
    setCloseGuard(true);
    setError(null);

    try {
      // Send only the fields this type declares, trimmed. A value left over in
      // state from a field that is no longer rendered must not ride along.
      const connectionConfig: Record<string, string> = {};
      for (const field of selectedType.fields) {
        const value = (config[field.key] ?? '').trim();
        if (value) connectionConfig[field.key] = value;
      }

      const result = await rpc.switchServers.createBridge({
        serverId,
        bridgeType: selectedType.key,
        displayName: trimmedName,
        connectionConfig,
        setAsDefault,
        // Forced off for a platform that can't create channels regardless of
        // the checkbox state — the server rejects `true` there anyway, but
        // sending what the form actually shows is the honest request.
        channelCreationEnabled: channelCreationSupported && channelCreationEnabled,
      });

      if (result.kind !== 'created') {
        setError(messageFor(result));
        return;
      }
      onSuccess({
        bridgeId: result.bridge.id,
        displayName: result.bridge.displayName,
        directorySearchSupported: selectedType.directorySearchSupported,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSubmitting(false);
      setCloseGuard(false);
    }
  }, [
    canSubmit,
    selectedType,
    serverId,
    trimmedName,
    config,
    setAsDefault,
    channelCreationSupported,
    channelCreationEnabled,
    onSuccess,
    setCloseGuard,
  ]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Connect a messaging app{server ? ` to ${server.name}` : ''}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-5">
          {!server && (
            <p className="text-destructive text-xs">
              No Switch server is selected. Choose a server in the sidebar first.
            </p>
          )}

          {server && !isAdmin && (
            <p className="text-destructive text-xs">
              Connecting a messaging app requires an admin account on this server. You are signed in
              without admin rights, so the server would reject this.
            </p>
          )}

          <Field>
            <FieldLabel>Messaging app</FieldLabel>
            <Select
              value={typeKey ?? ''}
              onValueChange={(next) => handleTypeChange(next ?? null)}
              disabled={typesQuery.isLoading || types.length === 0 || !isAdmin}
            >
              <SelectTrigger>
                <SelectValue placeholder={typesQuery.isLoading ? 'Loading…' : 'Choose a platform'}>
                  {selectedType ? bridgePlatformLabel(selectedType.key) : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {types.map((type) => (
                  <SelectItem key={type.key} value={type.key}>
                    <span className="flex items-center gap-2">
                      {hasBridgeIcon(type.key) && <BridgeIcon bridgeType={type.key} size={16} />}
                      {bridgePlatformLabel(type.key)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {typesQuery.isError && (
              <p className="text-destructive mt-1 text-xs">
                Could not load the available messaging apps: {errorText(typesQuery.error)}
              </p>
            )}
          </Field>

          {selectedType && (
            <>
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  autoFocus
                  placeholder={`e.g. ${bridgePlatformLabel(selectedType.key)}`}
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    setError(null);
                  }}
                />
                <p className="mt-1 text-xs text-foreground-muted">
                  How this connection is labelled in Switch Console when you pick it for a room.
                </p>
              </Field>

              {/* The fields below are asked for without explanation — what a
                  "bot token" is, and where to get one, lives in the platform's
                  setup guide. Link to it at the point the question arises. */}
              <button
                type="button"
                className="-mt-2 flex w-fit items-center gap-1 text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground"
                onClick={() =>
                  void openExternalUrl(
                    bridgeSetupDocsUrl(selectedType.key),
                    'Could not open the setup guide'
                  )
                }
              >
                How to set up {bridgePlatformLabel(selectedType.key)}
                <ExternalLink className="size-3" />
              </button>

              {selectedType.fields.map((field) => (
                <Field key={field.key}>
                  <FieldLabel>
                    {field.label}
                    {!field.required && (
                      <span className="ml-1 font-normal text-foreground-muted">(optional)</span>
                    )}
                  </FieldLabel>
                  <Input
                    // Masked for credentials, so a token is not left readable on
                    // screen while the user checks the rest of the form.
                    type={field.secret ? 'password' : 'text'}
                    autoComplete={field.secret ? 'new-password' : 'off'}
                    spellCheck={false}
                    value={config[field.key] ?? ''}
                    onChange={(e) => {
                      const { value } = e.target;
                      setConfig((prev) => ({ ...prev, [field.key]: value }));
                      setError(null);
                    }}
                  />
                  {field.description && (
                    <p className="mt-1 text-xs text-foreground-muted">{field.description}</p>
                  )}
                </Field>
              ))}

              <label
                className={cn(
                  'group/field flex items-start gap-2.5',
                  channelCreationSupported ? 'cursor-pointer' : 'cursor-not-allowed'
                )}
              >
                <Checkbox
                  checked={channelCreationSupported && channelCreationEnabled}
                  disabled={!channelCreationSupported}
                  onCheckedChange={(checked) => setChannelCreationEnabled(checked === true)}
                  className="mt-0.5"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Allow creating channels from Switch</span>
                  <span className="text-xs text-foreground-muted">
                    {channelCreationSupported
                      ? `Allows Switch users and agents to create channels in ${bridgePlatformLabel(selectedType.key)} from Switch. Turn it off to only ever use channels made in the app.`
                      : `${bridgePlatformLabel(selectedType.key)} has no way to create channels from Switch, so this connection can only be used with channels made in the app.`}
                  </span>
                </span>
              </label>

              <label className="group/field flex cursor-pointer items-start gap-2.5">
                <Checkbox
                  checked={setAsDefault}
                  onCheckedChange={(checked) => setSetAsDefault(checked === true)}
                  className="mt-0.5"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Use for new rooms by default</span>
                  <span className="text-xs text-foreground-muted">
                    Rooms created without naming a messaging app will land here. Replaces the
                    server’s current default; existing rooms are unaffected.
                  </span>
                </span>
              </label>
            </>
          )}

          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {isSubmitting ? 'Connecting…' : 'Connect'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Turn a failed attach into something the user can act on. */
function messageFor(result: Exclude<CreateBridgeResult, { kind: 'created' }>): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'forbidden':
      return 'Connecting a messaging app requires an admin account on this server.';
    case 'invalid':
      // The gateway validated the credentials against the platform's own config
      // model, so its wording is more specific than anything we could invent.
      return `The server rejected these details: ${result.message}`;
    case 'error':
      return result.message;
  }
}
