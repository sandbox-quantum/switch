import { CircleAlert, Cloud, Monitor, Server, TriangleAlert } from 'lucide-react';
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../model/cn';
import type { NewAgentFormState } from '../model/new-agent-form';
import type { MachineProviderOption } from '../model/provider-catalogue';
import { Alert, AlertAction, AlertDescription } from '../primitives/alert';
import { Button } from '../primitives/button';
import { DialogFooter, DialogHeader, DialogTitle } from '../primitives/dialog';
import { DisclosureRow } from '../primitives/disclosure-row';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '../primitives/field';
import { InfoTooltip } from '../primitives/info-tooltip';
import { Input } from '../primitives/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../primitives/select';
import { Textarea } from '../primitives/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../primitives/tooltip';
import { PERMISSION_COPY, PermissionToggle, autoModeDescription } from './agent-permissions';

/** The New agent dialog's title, and the other ways to add an agent there are. */
export function NewAgentHeader({
  closable,
  otherWays,
}: {
  closable: boolean;
  /** Each a link under the title, such as starting from a template. */
  otherWays: { label: string; onClick: () => void }[];
}) {
  return (
    <DialogHeader showCloseButton={closable}>
      <DialogTitle>New agent</DialogTitle>
      {otherWays.map((way) => (
        <button
          key={way.label}
          type="button"
          disabled={!closable}
          onClick={way.onClick}
          className="w-fit cursor-pointer text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground disabled:cursor-default disabled:opacity-50"
        >
          {way.label}
        </button>
      ))}
    </DialogHeader>
  );
}

/** Cancel, and Add agent with why it cannot be pressed yet on hover. */
export function NewAgentFooter({
  waitingFor,
  onBack,
  onCancel,
  idle,
  creating,
  canSubmit,
  disabledReason,
  onCreate,
  ConfirmButton,
}: {
  /** A machine the form is waiting to hear from, said beside the buttons. */
  waitingFor: string | null;
  onBack: (() => void) | null;
  onCancel: () => void;
  idle: boolean;
  creating: boolean;
  canSubmit: boolean;
  disabledReason: string | null;
  onCreate: () => void;
  ConfirmButton: ComponentType<{
    type: 'button';
    onClick: () => void;
    disabled: boolean;
    children: ReactNode;
  }>;
}) {
  return (
    <DialogFooter>
      {waitingFor !== null && (
        <span className="mr-auto self-center text-xs text-foreground-muted">
          Waiting for {waitingFor}…
        </span>
      )}
      {onBack && (
        <Button variant="outline" onClick={onBack} disabled={!idle}>
          Back
        </Button>
      )}
      <Button type="button" variant="outline" onClick={onCancel} disabled={!idle}>
        Cancel
      </Button>
      <TooltipProvider delay={150}>
        <Tooltip>
          {/* Span, not button, carries the tooltip: a disabled button emits no pointer events. */}
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <ConfirmButton type="button" onClick={onCreate} disabled={!canSubmit}>
                  {creating ? 'Adding…' : 'Add agent'}
                </ConfirmButton>
              </span>
            }
          />
          {disabledReason !== null && <TooltipContent side="top">{disabledReason}</TooltipContent>}
        </Tooltip>
      </TooltipProvider>
    </DialogFooter>
  );
}

/**
 * Name and description, which are what the dialog is really asking for, under
 * the agent's icon. The icon picker is the app's own.
 */
export function NewAgentIdentityFields({
  form,
  nameTaken,
  takenWhere,
  iconPicker,
}: {
  form: NewAgentFormState;
  /** Another agent where it is made already has this name. */
  nameTaken: boolean;
  /** Where that other agent is, after "already exists": "on this server", or "here". */
  takenWhere: string;
  iconPicker: ReactNode;
}) {
  const nameId = useId();
  const descriptionId = useId();
  const instructionsId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <FieldGroup>
      {/* Above the name, because it is the first thing the finished agent is
          recognised by. */}
      <div className="flex flex-col items-center gap-1.5 pb-1">
        {iconPicker}
        <span className="text-xs text-foreground-muted">
          {form.iconUrl === null && form.thirdPartyAvatarsEnabled === false
            ? 'No icon'
            : form.iconIsGenerated
              ? 'Automatically generated'
              : 'Custom icon'}
        </span>
      </div>

      <Field>
        <FieldLabel htmlFor={nameId}>Name</FieldLabel>
        <Input
          id={nameId}
          ref={nameRef}
          placeholder="Name this agent"
          value={form.agentName}
          onChange={(e) => form.setAgentName(e.target.value)}
          aria-invalid={form.nameIsRejected || nameTaken}
        />
        {form.nameIsRejected ? (
          <Alert
            variant="destructive"
            className="border-border-destructive bg-background-destructive"
          >
            <TriangleAlert />
            <AlertDescription className="text-foreground-destructive">
              Use lowercase letters, digits, <span className="font-mono">. - _</span>, starting with
              a letter or digit. No spaces or uppercase.
            </AlertDescription>
            {form.suggestedName && (
              <AlertAction>
                <Button
                  variant="outline"
                  size="xs"
                  className="max-w-full"
                  // Accepting the offer makes the name valid, which unmounts this
                  // button; without moving focus first it falls to the body and
                  // the tab order restarts.
                  onClick={() => {
                    form.acceptSuggestedName();
                    nameRef.current?.focus();
                  }}
                >
                  Use <span className="truncate font-mono">{form.suggestedName}</span>
                </Button>
              </AlertAction>
            )}
          </Alert>
        ) : nameTaken ? (
          <Alert
            variant="destructive"
            className="border-border-destructive bg-background-destructive"
          >
            <TriangleAlert />
            <AlertDescription className="text-foreground-destructive">
              An agent called <span className="font-mono">{form.agentName}</span> already exists{' '}
              {takenWhere}. Pick another name.
            </AlertDescription>
          </Alert>
        ) : form.agentName.length > 0 ? (
          // Once there is a name, show the handle it produces rather than
          // repeating the advice: the advice is about choosing a name, and it
          // has been taken.
          <span className="text-xs text-foreground-muted">
            In rooms this agent is addressed as{' '}
            <span className="text-foreground">@{form.agentName}</span>.
          </span>
        ) : (
          <span className="text-xs text-foreground-muted">
            In rooms this agent is addressed by its name — include your own so it&apos;s clear whose
            agent it is.
          </span>
        )}
      </Field>

      <Field>
        <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
        <Input
          id={descriptionId}
          placeholder="What is this agent for?"
          value={form.description}
          onChange={(e) => form.setDescription(e.target.value)}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor={instructionsId}>
          Agent instructions <span className="text-foreground-muted">(optional)</span>
        </FieldLabel>
        <Textarea
          id={instructionsId}
          rows={4}
          placeholder="How this agent should work"
          value={form.instructions}
          onChange={(e) => form.setInstructions(e.target.value)}
        />
      </Field>
    </FieldGroup>
  );
}

/**
 * The folded Settings of the New agent dialog: auto mode, bypass permissions,
 * who can talk to the agent (the app's own control), and whatever else this
 * kind of agent has after them.
 */
export function NewAgentSettingsSection({
  form,
  addressing,
  ownerUnreachable,
  children,
}: {
  form: NewAgentFormState;
  /** The "Who can talk to your agent" control. */
  addressing: ReactNode;
  /** The policy admits the owner in a messaging app they have linked no account on. */
  ownerUnreachable: boolean;
  /** Further settings for this kind of agent, after the common ones. */
  children: ReactNode;
}) {
  // Sessions, permissions and addressing are set once and rarely revisited, so
  // they start folded — the identity fields above are what the dialog is for.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Folded is right until the defaults are wrong: a warning nothing on screen
  // hints at is a warning nobody reads, so the section opens itself the first
  // time there is one. Once only: closing it again is an answer, not an
  // oversight.
  const openedForWarning = useRef(false);
  useEffect(() => {
    if (!ownerUnreachable || openedForWarning.current) return;
    openedForWarning.current = true;
    setSettingsOpen(true);
  }, [ownerUnreachable]);

  return (
    <FieldGroup>
      {/* No box around the disclosure: it is a heading for the fields it
          reveals, and framing it made it read as a control of the same weight
          as the inputs above and below it. */}
      <div>
        <DisclosureRow
          open={settingsOpen}
          title="Settings"
          meta="Sessions, permissions, who can address it"
          onToggle={() => setSettingsOpen((v) => !v)}
        />
        {settingsOpen && (
          <FieldGroup className="pt-3">
            {form.supportsAutoMode && (
              <PermissionToggle
                setting="autoMode"
                description={autoModeDescription(
                  form.unreviewedAutoMode ? [form.unreviewedAutoMode] : [],
                  form.autoApprove
                )}
                checked={form.autoMode}
                onCheckedChange={form.setAutoMode}
              />
            )}
            <PermissionToggle
              setting="autoApprove"
              description={PERMISSION_COPY.autoApprove.description}
              checked={form.autoApprove}
              onCheckedChange={form.setAutoApprove}
            />

            <Field>
              {/* FieldTitle rather than FieldLabel: this is a settings row like
                  the two toggles above it. */}
              <FieldTitle>
                <span className="flex items-center gap-1.5">
                  Who can talk to your agent
                  <InfoTooltip
                    label="More info about addressing"
                    content="Talking to an agent means an @mention or a targeted message. A new agent answers you and your own agents; choose Only me to shut your agents out, or let others in. You can change this later from the agent's settings."
                  />
                </span>
              </FieldTitle>
              {addressing}
            </Field>
            {children}
          </FieldGroup>
        )}
      </div>
    </FieldGroup>
  );
}

/** The icon a run location is drawn with. */
export type RunLocationIconKind = 'monitor' | 'server' | 'cloud';

/** One entry in the Run location list. */
export type RunLocationEntry = {
  value: string;
  label: string;
  /** The right-hand tag: what sort of machine it is. */
  tag: string;
  icon: RunLocationIconKind;
  disabled?: boolean;
  /** A name that may be long, cut short to fit. */
  truncate: boolean;
};

export function RunLocationIcon({
  icon,
  className = 'size-4 text-foreground-muted',
}: {
  icon: RunLocationIconKind;
  className?: string;
}) {
  if (icon === 'monitor') return <Monitor className={className} />;
  if (icon === 'cloud') return <Cloud className={className} />;
  return <Server className={className} />;
}

/**
 * Where the agent runs, as a list mixing sorts of machine — so each carries an
 * icon and, on the right, what sort it is — followed by what is said about the
 * choice.
 */
export function RunLocationField({
  value,
  onValueChange,
  selected,
  entries,
  children,
}: {
  value: string;
  onValueChange: (value: string | null) => void;
  /** What the trigger says: the host's name, not the value behind it. */
  selected: { icon: RunLocationIconKind; label: string };
  entries: RunLocationEntry[];
  /** What is said under the list about the location chosen. */
  children: ReactNode;
}) {
  return (
    <Field>
      <FieldLabel>Run location</FieldLabel>
      <Select value={value} onValueChange={(v) => onValueChange(v)}>
        <SelectTrigger className="w-full">
          <SelectValue>
            <RunLocationIcon icon={selected.icon} />
            <span className="truncate">{selected.label}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {entries.map((entry) => (
            <SelectItem key={entry.value} value={entry.value} disabled={entry.disabled}>
              <RunLocationIcon icon={entry.icon} />
              <span className={entry.truncate ? 'flex-1 truncate' : 'flex-1'}>{entry.label}</span>
              <span className="text-xs text-foreground-muted">{entry.tag}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {children}
    </Field>
  );
}

/** A line about the run location chosen, beside the icon of the sort of machine it is. */
export function RunLocationLine({
  icon,
  status,
  children,
}: {
  icon: 'cloud' | 'server';
  /** Said as it changes, as a status. */
  status: boolean;
  children: ReactNode;
}) {
  return (
    <p
      className="flex items-start gap-1.5 text-xs text-foreground-muted"
      role={status ? 'status' : undefined}
    >
      <RunLocationIcon icon={icon} className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * The agent provider for a managed agent, from what its machine reports to the
 * server: only the providers installed and logged in there can be picked. A
 * provider installed there but not signed in can be given a login, from a
 * button in its card (`loginInCard`) or from a row under the cards.
 */
export function MachineProviderPicker<P extends string>({
  machineName,
  reportedTo,
  reported,
  options,
  value,
  onChange,
  autoSelect,
  icon,
  acceptsLogins,
  loginOffered,
  loginInCard,
  giveLogin,
}: {
  machineName: string;
  /** Who the machine reports to: "the server", or "Switch". */
  reportedTo: string;
  /** Whether the machine has reported its providers at all. */
  reported: boolean;
  options: MachineProviderOption<P>[];
  value: P | null;
  onChange: (providerId: P) => void;
  /** The provider to pick on the person's behalf among the ready ones, or null to leave it to them. */
  autoSelect: (ready: P[]) => P | null;
  icon: (providerId: P) => ReactNode;
  /** The machine keeps a key a login can be sealed to. */
  acceptsLogins: boolean;
  /** The app can give this provider a login. */
  loginOffered: (providerId: P) => boolean;
  /**
   * Each card carries its own Give login button and says where a missing
   * provider is missing (the web); otherwise the buttons are a row under the
   * cards (Console).
   */
  loginInCard: boolean;
  /** The form giving the machine a login for the provider. */
  giveLogin: (providerId: P, onClose: () => void) => ReactNode;
}) {
  const ready = useMemo(
    () => options.filter((option) => option.ready).map((option) => option.id),
    [options]
  );
  // Installed there but not signed in, with a login the machine can be given.
  const givable = acceptsLogins
    ? options.filter(
        (option) => !option.ready && option.problem !== 'not installed' && loginOffered(option.id)
      )
    : [];
  const [giving, setGiving] = useState<P | null>(null);

  useEffect(() => {
    if (value) return;
    const picked = autoSelect(ready);
    if (picked) onChange(picked);
  }, [value, ready, onChange, autoSelect]);

  return (
    <Field>
      <FieldLabel>Agent provider</FieldLabel>
      {ready.length === 0 && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>
            {!reported
              ? `${machineName} has not reported its providers yet.`
              : `No provider is installed and logged in on ${machineName}.`}
          </span>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {options.map((option) => (
          <div key={option.id} className="relative">
            <button
              type="button"
              disabled={!option.ready}
              aria-pressed={value === option.id}
              title={option.problem ? `${option.name}: ${option.problem}` : undefined}
              onClick={() => onChange(option.id)}
              className={cn(
                'flex h-full w-full cursor-pointer flex-col items-start gap-2 rounded-[11px] border p-3 text-left transition-colors',
                value === option.id
                  ? 'border-foreground bg-[var(--sel-soft)]'
                  : 'border-border hover:bg-[var(--sel-soft)]',
                !option.ready &&
                  'cursor-not-allowed opacity-50 bg-background-1 hover:bg-transparent'
              )}
            >
              {icon(option.id)}
              <span className="w-full truncate text-sm text-foreground">{option.name}</span>
              <span className="text-xs text-foreground-muted">
                {!option.problem
                  ? 'Ready'
                  : loginInCard && option.problem === 'not installed'
                    ? `Not installed on ${machineName}`
                    : capitalize(option.problem)}
              </span>
            </button>
            {loginInCard && givable.includes(option) && (
              <Button
                variant="outline"
                size="xs"
                className="absolute top-2 right-2"
                aria-pressed={giving === option.id}
                aria-label={`Give ${machineName} a login for ${option.name}`}
                onClick={() => setGiving((open) => (open === option.id ? null : option.id))}
              >
                Give login
              </Button>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-foreground-muted">
        As {machineName} last reported to {reportedTo}.
      </p>
      {giving
        ? giveLogin(giving, () => setGiving(null))
        : !loginInCard &&
          givable.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
              <span>Give {machineName} a login for</span>
              {givable.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="cursor-pointer rounded-md border border-border px-2 py-0.5 text-foreground hover:bg-[var(--sel-soft)]"
                  onClick={() => setGiving(option.id)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          )}
    </Field>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const DIRECTORY_PLACEHOLDER = 'Where the agent runs';

/**
 * Where a managed agent runs on its machine, as a settings row: a path typed
 * for that machine, or the app's own folder picker where it has one for it.
 */
export function ManagedDirectoryField({
  machineWord,
  machineLabel,
  value,
  suggestedPath,
  error,
  picker,
  onChange,
}: {
  /** What the app calls a computer that runs agents. */
  machineWord: 'machine' | 'device';
  machineLabel: string;
  value: string;
  /** What the agent runs in while the field is empty; null while not known. */
  suggestedPath: string | null;
  /** Why the suggested folder could not be worked out; null when it could. */
  error: string | null;
  /** The app's folder picker for this machine, given its placeholder; null to type the path. */
  picker: ((placeholder: string) => ReactNode) | null;
  onChange: (value: string) => void;
}) {
  const placeholder = suggestedPath ?? DIRECTORY_PLACEHOLDER;
  return (
    <Field>
      <div className="-mx-2 flex flex-col gap-2 px-2 py-1.5">
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm">
            Directory
            <InfoTooltip
              label="More info about the directory"
              content={`The agent's working directory, a full path on ${machineLabel}. It starts as a folder named after the agent in the ${machineWord}'s workspaces; choose another to run it in an existing project.`}
            />
          </span>
          <span className="text-xs text-foreground-muted">
            Where the agent runs on {machineLabel}.
          </span>
        </span>
        {picker ? (
          picker(placeholder)
        ) : (
          <Input
            aria-label="Directory"
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {error !== null && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </Field>
  );
}

/** A field of a provider's advanced configuration, as the section draws it. */
export type AdvancedConfigFieldBase = {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  help?: string | null;
};

/**
 * The collapsed "Advanced configuration" section: the model and the server's
 * fields for the provider. Each field's input, and what is said under it about
 * the models the machine offers, are the app's.
 */
export function AdvancedConfigSection<F extends AdvancedConfigFieldBase>({
  providerLabel,
  fields,
  fieldNote,
  renderInput,
}: {
  providerLabel: string | null;
  fields: F[];
  /** What is said under the field about the machine's models; undefined for nothing. */
  fieldNote: (field: F) => string | undefined;
  renderInput: (field: F) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <DisclosureRow
        open={open}
        title="Advanced configuration"
        meta={
          providerLabel
            ? `${providerLabel} · ${fields.length} ${fields.length === 1 ? 'field' : 'fields'}`
            : undefined
        }
        onToggle={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="flex flex-col gap-4 pt-3">
          {fields.map((field) => {
            const note = fieldNote(field);
            return (
              <Field key={field.key}>
                <FieldLabel htmlFor={`agent-advanced-${field.key}`}>
                  {field.label}
                  {field.required || field.type === 'boolean' ? '' : ' (optional)'}
                </FieldLabel>
                {renderInput(field)}
                {note && <FieldDescription>{note}</FieldDescription>}
                {field.help && (
                  <FieldDescription className="text-foreground-muted">
                    {field.help}
                  </FieldDescription>
                )}
              </Field>
            );
          })}
        </div>
      )}
    </div>
  );
}
