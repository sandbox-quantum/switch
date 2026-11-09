import { CircleCheck, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
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
  ServiceKeyField,
  ServiceKeyForm,
} from '@shared/core/switch-servers/connection-catalog';
import type { ServiceCalls } from './service-calls';

/** Whether `value` fits the field's pattern, matched in full as Core matches it. */
function fitsPattern(field: ServiceKeyField, value: string): boolean {
  if (!field.pattern) return true;
  try {
    return new RegExp(`^(?:${field.pattern})$`).test(value);
  } catch {
    // Core checks every value again, so a pattern this build cannot read is left to it.
    return true;
  }
}

/**
 * The fields a person fills in to connect with a key, or with a credential
 * pasted in place of a sign-in: each secret typed into a password input, any
 * other picked from its choices, each with its help under it, and the link to
 * where the vendor says how to make one.
 */
export function ServiceKeyFields({
  service,
  name,
  label,
  fields,
  values,
  busy,
  helpUrl,
  helpText,
  onChange,
}: {
  service: string;
  /** The service's name, as people read it. */
  name: string;
  /** What the group of fields is, for assistive technology. */
  label: string;
  fields: ServiceKeyField[];
  values: Record<string, string>;
  busy: boolean;
  helpUrl: string | null;
  /** The help link's words. */
  helpText: string;
  onChange: (field: string, value: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="space-y-3">
      {fields.map((field) => {
        const id = `service-key-${service}-${field.name}`;
        const value = values[field.name] ?? '';
        const misfit = value.trim() !== '' && !fitsPattern(field, value.trim());
        return (
          <div key={field.name} className="space-y-1">
            <label htmlFor={id} className="block text-sm font-medium">
              {field.label}
            </label>
            {field.choices ? (
              <Select
                value={value || null}
                onValueChange={(next) => onChange(field.name, next ?? '')}
              >
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
                aria-invalid={misfit || undefined}
                aria-describedby={misfit ? `${id}-form` : undefined}
                onChange={(event) => onChange(field.name, event.target.value)}
              />
            )}
            {field.help && <p className="text-xs text-foreground-muted">{field.help}</p>}
            {misfit && (
              <p id={`${id}-form`} className="text-xs text-destructive">
                {field.label} is not in the form {name} uses.
              </p>
            )}
          </div>
        );
      })}
      {helpUrl && (
        <button
          type="button"
          className="flex w-fit items-center gap-1 text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground"
          onClick={() => void openExternalUrl(helpUrl, `Could not open ${name}'s help`)}
        >
          {helpText} <ExternalLink className="size-3" />
        </button>
      )}
    </div>
  );
}

/**
 * Connecting a service by pasting a key: a form of the fields the catalog
 * names, the keys typed into password inputs and anything else picked from its
 * choices. Switch checks the key with the vendor before keeping it, and never
 * sends it back, so a key typed here is cleared once it is submitted.
 *
 * Opened `replacing` a connected key, it is that one action: it opens on the
 * form, and once the new key is kept it is done. The server replaces the key
 * in place, so every agent that had the service keeps it.
 */
export function ServiceKeyStep({
  calls,
  connection,
  form,
  replacing,
  onBack,
  onConnected,
}: {
  calls: ServiceCalls;
  connection: ConnectionCatalogEntry;
  form: ServiceKeyForm;
  replacing: boolean;
  onBack: () => void;
  /** Moves on once the key is connected, with the warning Switch gave. */
  onConnected?: (warning: string | null) => void;
}) {
  const service = connection.slug;
  const name = connection.name;
  const [connected, setConnected] = useState(connection.status === 'connected');
  const [identity, setIdentity] = useState(connection.external_identity);
  const [changingKey, setChangingKey] = useState(replacing);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useCloseGuard(busy);
  const editing = !connected || changingKey;
  const complete = form.fields.every((field) => {
    const value = (values[field.name] ?? '').trim();
    return value !== '' && fitsPattern(field, value);
  });
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
      const result = await calls.connectWithKey(service, fields);
      setIdentity(result.external_identity);
      setWarning(result.warning);
      setConnected(true);
      setChangingKey(false);
      onConnected?.(result.warning);
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
      const result = await calls.disconnect(service);
      setWarning(result.warning);
      setConnected(false);
      setIdentity(null);
      setChangingKey(false);
    } catch (cause) {
      setError(failureText(cause, `Could not disconnect ${name}.`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>
          {replacing && changingKey
            ? `Replace the ${name} key`
            : connected
              ? `${name} connected`
              : `Connect ${name}`}
        </DialogTitle>
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
          <ServiceKeyFields
            service={service}
            name={name}
            label={`${name} key`}
            fields={form.fields}
            values={values}
            busy={busy}
            helpUrl={form.help_url}
            helpText={`How to make a ${name} key`}
            onChange={(field, next) => {
              setValues((current) => ({ ...current, [field]: next }));
              setError(null);
            }}
          />
        )}
        <p className="text-xs text-foreground-muted">
          Switch checks the key with {name}, stores it encrypted, and never shows it again. The
          agent can do whatever this key allows. Keys are long-lived; disconnecting removes the key
          from Switch but can't revoke it at {name}, so revoke it there too.
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
      {replacing ? (
        <DialogFooter>
          {changingKey ? (
            <>
              <Button variant="outline" onClick={onBack} disabled={busy}>
                Cancel
              </Button>
              <Button
                disabled={busy || !complete || !connection.connectable}
                onClick={() => void submit()}
              >
                Replace key
              </Button>
            </>
          ) : (
            <Button onClick={onBack}>Done</Button>
          )}
        </DialogFooter>
      ) : (
        <DialogFooter>
          <Button variant="outline" onClick={onBack} disabled={busy}>
            Back
          </Button>
          {connected && (
            <Button variant="ghost" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </Button>
          )}
          {connected && !changingKey && (
            <Button variant="outline" disabled={busy} onClick={() => setChangingKey(true)}>
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
      )}
    </>
  );
}
