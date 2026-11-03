import { CircleCheck, Circle, ExternalLink, FileKey } from 'lucide-react';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Input } from '@renderer/lib/ui/input';
import { RadioGroup, RadioGroupItem } from '@renderer/lib/ui/radio-group';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import type {
  ConnectorApp,
  ConnectorAppField,
  ConnectorAppImpact,
  SaveConnectorAppInput,
} from '@shared/core/switch-servers/connector-apps';
import {
  type Audience,
  type SecretField,
  UPDATE_SECRET_NOTE,
  asksWhoConnects,
  confirmBeforeCheck,
  menuLabel,
  moveChecklist,
  peopleIn,
  removeWarning,
  secretFields,
  setupInstructions,
  switchWarning,
  vendorName,
} from './connector-apps';
import { useReloadConnectorApps, useRememberChecks } from './connector-apps-queries';
import { CopyButton } from './copy-button';

export type SetupMode = 'set_up' | 'switch' | 'enter_again';

type AppDialogProps = { serverId: string; app: ConnectorApp } & BaseModalProps<string>;

/** A save's refusal as the form shows it: the vendor's words, and the value to look at again. */
type Refusal = { message: string; field: ConnectorAppField | null };

/**
 * Save through the server, which checks with the vendor first. Resolves to
 * the refusal to show, or null once saved and the page re-read; a failure
 * that is not the vendor's is shown the same way, with no field marked.
 */
function useSave(serverId: string, service: string, failure: string) {
  const reload = useReloadConnectorApps(serverId);
  const remember = useRememberChecks(serverId);
  return async (input: SaveConnectorAppInput): Promise<Refusal | null> => {
    try {
      const result = await rpc.switchServers.saveConnectorApp({ serverId, service, input });
      if (result.kind === 'refused') return { message: result.message, field: result.field };
      remember(service, result.checks);
      await reload();
      return null;
    } catch (cause) {
      return { message: failureText(cause, failure), field: null };
    }
  };
}

/** A value to paste at the vendor, with a button that copies it. */
function Copyable({ value }: { value: string }) {
  return (
    <span className="mt-1.5 flex items-center gap-1 rounded-md border border-border bg-background-1 py-1 pr-1 pl-2">
      <code className="min-w-0 flex-1 font-mono text-xs break-all">{value}</code>
      <CopyButton value={value} />
    </span>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium">
      {children}
    </label>
  );
}

/**
 * The secret inputs, labelled as the vendor labels them: empty and masked,
 * and a private key read from its file here and never shown.
 */
function SecretInputs({
  fields,
  values,
  onChange,
  marked,
  disabled,
  optional,
}: {
  fields: SecretField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  marked: ConnectorAppField | null;
  disabled: boolean;
  /** Left empty, the saved one is kept. */
  optional: boolean;
}) {
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  return (
    <>
      {fields.map((field) => {
        const id = `connector-app-${field.name}`;
        return (
          <div key={field.name} className="space-y-1">
            <FieldLabel htmlFor={id}>
              {field.label}
              {optional && <span className="font-normal text-foreground-muted"> (optional)</span>}
            </FieldLabel>
            {field.file ? (
              <>
                <label
                  className={cn(
                    'flex w-fit cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-background-1',
                    marked === field.name ? 'border-destructive' : 'border-border',
                    disabled && 'pointer-events-none opacity-50'
                  )}
                >
                  <FileKey className="size-4 text-foreground-muted" />
                  {fileNames[field.name] ?? 'Choose the .pem file'}
                  <input
                    id={id}
                    type="file"
                    accept=".pem"
                    className="sr-only"
                    aria-invalid={marked === field.name || undefined}
                    disabled={disabled}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      void file.text().then((text) => {
                        setFileNames((names) => ({ ...names, [field.name]: file.name }));
                        onChange(field.name, text);
                      });
                    }}
                  />
                </label>
                <p className="text-xs text-foreground-muted">
                  Read on this computer and sent only to Switch; never shown.
                </p>
              </>
            ) : (
              <Input
                id={id}
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                aria-invalid={marked === field.name || undefined}
                value={values[field.name] ?? ''}
                onChange={(event) => onChange(field.name, event.target.value)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function RefusalText({ refusal }: { refusal: Refusal | null }) {
  if (!refusal) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {refusal.message}
    </p>
  );
}

type Step = 'warning' | 'create' | 'values';

const STEPS: Record<SetupMode, Step[]> = {
  set_up: ['create', 'values'],
  enter_again: ['create', 'values'],
  switch: ['warning', 'create', 'values'],
};

/**
 * Setting up an app, entering it again, or switching to a different one:
 * create it at the vendor following the steps, paste its values, and check
 * and save in one click. Switching starts with what it does to the people
 * connected, and asks the server who would reconnect before it saves.
 */
export function ConnectorAppSetupDialog({
  serverId,
  app,
  publicUrl,
  mode,
  onSuccess,
  onClose,
}: AppDialogProps & { publicUrl: string | null; mode: SetupMode }) {
  const steps = STEPS[mode];
  const [step, setStep] = useState<Step>(steps[0]);
  const [audience, setAudience] = useState<Audience>('internal');
  const [clientId, setClientId] = useState(
    mode === 'enter_again' ? (app.saved_client_id ?? '') : ''
  );
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<ConnectorAppImpact | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  useCloseGuard(busy);
  const save = useSave(serverId, app.slug, `Could not save ${app.name}'s app.`);

  const vendor = vendorName(app);
  const fields = secretFields(app);
  const id = clientId.trim();
  const confirmation = confirmBeforeCheck(app);
  const complete =
    id !== '' &&
    fields.every((field) => (secrets[field.name] ?? '') !== '') &&
    (confirmation === null || confirmed);
  const replacing = app.saved_client_id !== null && id !== app.saved_client_id;
  const index = steps.indexOf(step);
  const stepName = {
    warning: 'Before you switch',
    create: `Create the app at ${vendor}`,
    values: 'Paste its values',
  }[step];

  const submit = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      if (mode === 'switch' && impact === null) {
        setImpact(
          await rpc.switchServers.getConnectorAppImpact({
            serverId,
            service: app.slug,
            clientId: id,
          })
        );
        return;
      }
      const refused = await save({ client_id: id, ...secrets, replace: mode === 'switch' });
      if (refused) setRefusal(refused);
      else onSuccess(`${app.name} is ready.`);
    } catch (cause) {
      setRefusal({
        message: failureText(cause, 'Could not ask who would reconnect.'),
        field: null,
      });
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === 'switch'
      ? `Use a different ${vendor} app`
      : mode === 'enter_again'
        ? `Enter ${app.name}'s app again`
        : `Set up ${app.kind === 'github_app' ? 'GitHub' : app.name}`;

  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        {steps.length > 1 && (
          <p className="text-xs font-medium tracking-wide text-foreground-muted uppercase">
            Step {index + 1} of {steps.length} · {stepName}
          </p>
        )}

        {step === 'warning' && (
          <div className="space-y-2 rounded-md border border-border-warning bg-background-warning p-3">
            {switchWarning(app, app).map((line) => (
              <p key={line} className="text-sm">
                {line}
              </p>
            ))}
          </div>
        )}

        {step === 'create' && (
          <>
            {asksWhoConnects(app) && (
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">Who will connect?</legend>
                <RadioGroup
                  value={audience}
                  onValueChange={(value) => setAudience(value as Audience)}
                  className="gap-2"
                >
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="internal" />
                    Only people in your Google organization (recommended)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="external" />
                    Anyone with a Google account
                  </label>
                </RadioGroup>
              </fieldset>
            )}
            <ol className="list-decimal space-y-3 pl-5 text-sm">
              {setupInstructions(app, audience, publicUrl).map((instruction) => (
                <li key={instruction.text}>
                  {instruction.text}
                  {instruction.link && (
                    <button
                      type="button"
                      className="ml-1 inline-flex items-center gap-1 text-foreground underline underline-offset-2"
                      onClick={() =>
                        void openExternalUrl(
                          instruction.link!.href,
                          `Could not open ${instruction.link!.label}`
                        )
                      }
                    >
                      {instruction.link.label}
                      <ExternalLink className="size-3" />
                    </button>
                  )}
                  {instruction.items.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-xs">
                      {instruction.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                  {instruction.copy.map((value) => (
                    <Copyable key={value} value={value} />
                  ))}
                </li>
              ))}
            </ol>
          </>
        )}

        {step === 'values' && (
          <div className="space-y-3">
            <div className="space-y-1">
              <FieldLabel htmlFor="connector-app-client_id">Client ID</FieldLabel>
              <Input
                id="connector-app-client_id"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-invalid={refusal?.field === 'client_id' || undefined}
                value={clientId}
                onChange={(event) => {
                  setClientId(event.target.value);
                  setImpact(null);
                }}
              />
            </div>
            <SecretInputs
              fields={fields}
              values={secrets}
              marked={refusal?.field ?? null}
              disabled={busy}
              optional={false}
              onChange={(name, value) => {
                setSecrets((current) => ({ ...current, [name]: value }));
                setRefusal(null);
              }}
            />
            {app.kind === 'github_app' && (
              <p className="text-xs text-foreground-muted">
                The App&apos;s name is read from GitHub when Switch checks it.
              </p>
            )}
            {confirmation && (
              <label className="flex cursor-pointer items-start gap-2.5 pt-1">
                <Checkbox
                  checked={confirmed}
                  disabled={busy}
                  onCheckedChange={(checked) => setConfirmed(checked === true)}
                  className="mt-0.5"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{confirmation.label}</span>
                  <span className="text-xs text-foreground-muted">{confirmation.why}</span>
                </span>
              </label>
            )}
            {mode === 'enter_again' && replacing && (
              <p role="status" className="text-sm text-foreground-warning">
                This is a different client ID from the one saved. Use a different app to switch on
                purpose.
              </p>
            )}
            {impact && (
              <p role="status" className="text-sm text-foreground-warning">
                {impact.connected_members === 0
                  ? 'Nobody is connected through the current app.'
                  : `${peopleIn(impact)} will need to reconnect.`}
              </p>
            )}
            <RefusalText refusal={refusal} />
          </div>
        )}
      </DialogContentArea>
      <DialogFooter>
        {index > 0 ? (
          <Button variant="outline" disabled={busy} onClick={() => setStep(steps[index - 1])}>
            Back
          </Button>
        ) : (
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        )}
        {step !== 'values' ? (
          <Button onClick={() => setStep(steps[index + 1])}>
            {step === 'warning' ? 'Continue' : 'Next'}
          </Button>
        ) : (
          <Button
            variant={mode === 'switch' && impact ? 'destructive' : 'default'}
            disabled={!complete || busy || (mode === 'enter_again' && replacing)}
            onClick={() => void submit()}
          >
            {busy && <Spinner />}
            {busy
              ? 'Checking…'
              : mode === 'switch'
                ? impact
                  ? 'Switch app'
                  : 'Check who reconnects'
                : 'Check and save'}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/**
 * A new secret (or, for GitHub, a new private key) for the same app: nobody
 * is disconnected. What is left empty keeps what is saved.
 */
export function ConnectorAppSecretDialog({ serverId, app, onSuccess, onClose }: AppDialogProps) {
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  useCloseGuard(busy);
  const save = useSave(serverId, app.slug, `Could not update ${app.name}'s secret.`);
  const given = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== ''));
  const fields = secretFields(app);

  const submit = async () => {
    if (app.client_id === null) return;
    setBusy(true);
    setRefusal(null);
    const refused = await save({ client_id: app.client_id, ...given, replace: false });
    setBusy(false);
    if (refused) setRefusal(refused);
    else onSuccess(`${app.name}'s secret is updated. Nobody was disconnected.`);
  };

  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>{menuLabel(app, 'update_secret')}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        <p className="text-sm text-foreground-muted">
          For the app with client ID <code className="font-mono text-xs">{app.client_id}</code>.{' '}
          {UPDATE_SECRET_NOTE}
        </p>
        <SecretInputs
          fields={fields}
          values={secrets}
          marked={refusal?.field ?? null}
          disabled={busy}
          optional={fields.length > 1}
          onChange={(name, value) => {
            setSecrets((current) => ({ ...current, [name]: value }));
            setRefusal(null);
          }}
        />
        <RefusalText refusal={refusal} />
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || Object.keys(given).length === 0} onClick={() => void submit()}>
          {busy && <Spinner />}
          {busy ? 'Checking…' : 'Check and save'}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Removing the saved app: nobody can connect it after, and who was connected loses it. */
export function ConnectorAppRemoveDialog({ serverId, app, onSuccess, onClose }: AppDialogProps) {
  const reload = useReloadConnectorApps(serverId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useCloseGuard(busy);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc.switchServers.removeConnectorApp({ serverId, service: app.slug });
      await reload();
      onSuccess(`${app.name}'s app is removed.`);
    } catch (cause) {
      setError(failureText(cause, `Could not remove ${app.name}'s app.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>Remove {app.name}&apos;s app?</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        <p className="text-sm">{removeWarning(app)}</p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
          {busy && <Spinner />}
          Remove
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Moving an app off the server's configuration: copy it into Switch, remove
 * the configuration, restart. Only the first is done here; the dialog stays
 * open on the checklist so the other two are in front of the operator.
 */
export function ConnectorAppMoveDialog({
  serverId,
  app: initial,
  onSuccess,
  onClose,
}: AppDialogProps) {
  const reload = useReloadConnectorApps(serverId);
  const [app, setApp] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useCloseGuard(busy);
  const items = moveChecklist(app);
  const copied = items[0]?.done ?? false;

  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      setApp(await rpc.switchServers.importConnectorApp({ serverId, service: app.slug }));
      await reload();
    } catch (cause) {
      setError(failureText(cause, `Could not copy ${app.name}'s app into Switch.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>Manage {app.name} here instead</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        <ol className="space-y-3">
          {items.map((item, index) => (
            <li key={item.text} className="flex items-start gap-2 text-sm">
              {item.done ? (
                <CircleCheck
                  aria-label="Done"
                  className="mt-0.5 size-4 shrink-0 text-foreground-success"
                />
              ) : (
                <Circle
                  aria-label="To do"
                  className="mt-0.5 size-4 shrink-0 text-foreground-muted"
                />
              )}
              <div className="space-y-1.5">
                <p>{item.text}</p>
                {index === 0 && !item.done && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void copy()}>
                    {busy && <Spinner />}
                    Copy into Switch
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
        <p className="text-sm text-foreground-muted">
          Nobody needs to reconnect: Switch keeps using the same app.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button
          variant={copied ? 'default' : 'outline'}
          disabled={busy}
          onClick={() => (copied ? onSuccess(`${app.name} is copied into Switch.`) : onClose())}
        >
          {copied ? 'Done' : 'Close'}
        </Button>
      </DialogFooter>
    </>
  );
}
