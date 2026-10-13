import { CircleCheck, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import type {
  ConnectionCatalogEntry,
  ServiceKeyForm,
} from '@shared/core/switch-servers/connection-catalog';

/**
 * Connecting a service by pasting a key: a form of the fields the catalog
 * names, the keys typed into password inputs and anything else picked from its
 * choices. Switch checks the key with the vendor before keeping it, and never
 * sends it back, so a key typed here is cleared once it is submitted.
 */
export function ServiceKeyStep({
  serverId,
  connection,
  form,
  onBack,
}: {
  serverId: string;
  connection: ConnectionCatalogEntry;
  form: ServiceKeyForm;
  onBack: () => void;
}) {
  const service = connection.slug;
  const name = connection.name;
  const [connected, setConnected] = useState(connection.status === 'connected');
  const [identity, setIdentity] = useState(connection.external_identity);
  const [replacing, setReplacing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useCloseGuard(busy);
  const editing = !connected || replacing;
  const complete = form.fields.every((field) => (values[field.name] ?? '').trim() !== '');
  const clearSecrets = () =>
    setValues((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([fieldName]) => !form.fields.some((field) => field.name === fieldName && field.secret)
        )
      )
    );
  const submit = async () => {
    setBusy(true);
    setError(null);
    setWarning(null);
    const fields = Object.fromEntries(
      form.fields.map((field) => [field.name, (values[field.name] ?? '').trim()])
    );
    clearSecrets();
    try {
      const result = await rpc.switchServers.connectServiceWithKey(serverId, service, fields);
      setIdentity(result.external_identity);
      setWarning(result.warning);
      setConnected(true);
      setReplacing(false);
    } catch (cause) {
      setError(failureText(cause, `Could not connect ${name}.`));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.switchServers.disconnectService(serverId, service);
      setWarning(result.warning);
      setConnected(false);
      setIdentity(null);
      setReplacing(false);
    } catch (cause) {
      setError(failureText(cause, `Could not disconnect ${name}.`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>{connected ? `${name} connected` : `Connect ${name}`}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        <p className="text-sm text-foreground-muted">{connection.description}</p>
        {connected && (
          <p className="flex items-center gap-2 text-sm">
            <CircleCheck className="size-5 text-foreground-success" />
            {identity ? (
              <span>
                Connected with <strong>{identity}</strong>
              </span>
            ) : (
              <span>Connected with your key</span>
            )}
          </p>
        )}
        {editing && (
          <div role="group" aria-label={`${name} key`} className="space-y-3">
            {form.fields.map((field) => {
              const id = `service-key-${service}-${field.name}`;
              const value = values[field.name] ?? '';
              const set = (next: string) => {
                setValues((current) => ({ ...current, [field.name]: next }));
                setError(null);
              };
              return (
                <div key={field.name} className="space-y-1">
                  <label htmlFor={id} className="block text-sm font-medium">
                    {field.label}
                  </label>
                  {field.choices ? (
                    <Select value={value || null} onValueChange={(next) => set(next ?? '')}>
                      <SelectTrigger id={id} aria-label={field.label} className="w-full">
                        <SelectValue placeholder={`Choose a ${field.label.toLowerCase()}`}>
                          {value || undefined}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {field.choices.map((choice) => (
                          <SelectItem key={choice} value={choice}>
                            {choice}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={id}
                      type={field.secret ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                      value={value}
                      onChange={(event) => set(event.target.value)}
                    />
                  )}
                  {field.help && <p className="text-xs text-foreground-muted">{field.help}</p>}
                </div>
              );
            })}
            {form.help_url && (
              <button
                type="button"
                className="flex w-fit items-center gap-1 text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground"
                onClick={() =>
                  void openExternalUrl(form.help_url!, `Could not open ${name}'s help on keys`)
                }
              >
                How to make a {name} key <ExternalLink className="size-3" />
              </button>
            )}
          </div>
        )}
        <p className="text-xs text-foreground-muted">
          Switch checks the key with {name}, stores it encrypted, and never shows it again. The
          agent can do whatever this key allows. Keys don't expire; disconnecting removes the key
          from Switch but can't revoke it at {name} — revoke it there too.
        </p>
        {connection.unavailable_reason && (
          <p className="text-sm text-foreground-muted">{connection.unavailable_reason}</p>
        )}
        {warning && (
          <p role="status" className="rounded-md border p-3 text-sm text-foreground-muted">
            {warning}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onBack} disabled={busy}>
          Back
        </Button>
        {connected && (
          <Button variant="ghost" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        )}
        {connected && !replacing && (
          <Button variant="outline" disabled={busy} onClick={() => setReplacing(true)}>
            Replace key
          </Button>
        )}
        {editing && (
          <Button
            disabled={busy || !complete || !connection.connectable}
            onClick={() => void submit()}
          >
            Connect {name}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
