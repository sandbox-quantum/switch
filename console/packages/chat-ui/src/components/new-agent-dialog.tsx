import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { AddressingPolicy } from '../contracts/switch-servers';
import { failureText } from '../model/failures';
import {
  type NewAgentFormDeps,
  type NewAgentFormState,
  useNewAgentForm,
} from '../model/new-agent-form';
import { machineProviderOptions } from '../model/provider-catalogue';
import { Alert, AlertAction, AlertDescription } from '../primitives/alert';
import { Button } from '../primitives/button';
import { DialogContentArea } from '../primitives/dialog';
import { Input } from '../primitives/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../primitives/select';
import { Switch } from '../primitives/switch';
import { Textarea } from '../primitives/textarea';
import { CanManageAgentsToggle } from './agent-permissions';
import {
  AdvancedConfigSection,
  MachineProviderPicker,
  ManagedDirectoryField,
  NewAgentFooter,
  NewAgentHeader,
  NewAgentIdentityFields,
  NewAgentSettingsSection,
  type RunLocationEntry,
  RunLocationField,
  type RunLocationIconKind,
  RunLocationLine,
} from './new-agent-form';

/** A computer of the person's that can run the agent, as it last reported. */
export type NewAgentDevice = {
  id: string;
  /** Its name as people know it. */
  name: string;
  /** The person's Switch Cloud device: it runs every agent as a user of its own. */
  cloud: boolean;
  online: boolean;
  /** What sort of device it is, said on the right of the list. */
  tag: string;
  icon: RunLocationIconKind;
  /** `windows`, `macos`, `linux`; null when not known. */
  os: string | null;
  /** Where it makes agents' folders; null before it has said. */
  workspacesDir: string | null;
  /** It keeps a key a provider login can be sealed to. */
  acceptsLogins: boolean;
  /** Each provider it reported: ready (installed and signed in), or why not. Empty before it has. */
  providers: { provider: string; ready: boolean; problem: string | null }[];
  /** It has reported every provider it runs (`providerReportSettled`): one missing is not available there. */
  providersSettled: boolean;
};

/** A field of a provider's advanced configuration, as Switch describes it. */
export type NewAgentAdvancedField = {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'list' | 'select';
  help: string | null;
  placeholder: string | null;
  /** A select's choices, the first (value "") meaning unset. */
  options: { value: string; label: string }[] | null;
  /** Filled from the models the device offers, when the app can ask it. */
  catalogue: unknown;
};

/** A provider Switch runs, with its advanced configuration. */
export type NewAgentProvider = { id: string; name: string; fields: NewAgentAdvancedField[] };

export type AdvancedConfigValue = string | number | boolean | string[];

/** What the dialog asks the app to create. */
export type NewAgentRequest = {
  name: string;
  description: string;
  displayName: string | null;
  iconUrl: string | null;
  deviceId: string;
  /** Null for a folder the device makes, named after the agent. */
  directory: string | null;
  provider: string;
  /** Null for the provider's default. */
  model: string | null;
  advancedConfig: Record<string, AdvancedConfigValue>;
  instructions: string;
  autoMode: boolean;
  autoApprove: boolean;
  isolation: 'shared' | 'isolated';
};

/**
 * What the app showing the dialog provides: the person's devices and the
 * providers Switch runs, how an agent is created, set up and opened, and the
 * pieces of its own UI the dialog draws.
 */
export type NewAgentHost = {
  /**
   * The agent runs on the person's Switch Cloud device, the one in `devices`,
   * so no Run location is asked; otherwise it is picked among `devices`.
   */
  cloudOnly: boolean;
  /** Drawn under where a `cloudOnly` agent runs: where else agents can run. */
  cloudNote: ReactNode;
  /** Undefined while they load. */
  devices: NewAgentDevice[] | undefined;
  devicesError: unknown;
  providers: NewAgentProvider[] | undefined;
  providersError: unknown;
  /** Names already taken where the agent is made. */
  takenNames: ReadonlySet<string>;
  /** What the app calls a computer that runs agents. */
  machineWord: 'machine' | 'device';
  /** Where a taken name's agent is, after "already exists". */
  takenWhere: string;
  /** Who a device reports to, after "last reported to". */
  reportedTo: string;
  formRules: Pick<NewAgentFormDeps, 'namePattern' | 'slugify'>;
  permissionsFor: (providerId: string | null) => NewAgentFormDeps['permissions'];
  initialPolicy: () => AddressingPolicy | null;
  thirdPartyAvatarsEnabled: boolean | null;
  iconPicker: (form: NewAgentFormState) => ReactNode;
  /** The "Who can talk to your agent" control. */
  addressing: (form: NewAgentFormState) => ReactNode;
  providerIcon: (providerId: string) => ReactNode;
  /** The app can give this provider a login. */
  loginOffered: (providerId: string) => boolean;
  giveLogin: (device: NewAgentDevice, providerId: string, onClose: () => void) => ReactNode;
  /** Creates the agent on its device; throws, in Switch's words, when it is refused. */
  createAgent: (request: NewAgentRequest) => Promise<{ agentId: string }>;
  /** Sets who can talk to the created agent and whether it can manage agents. */
  finishSetup: (
    agentId: string,
    settings: { addressingPolicy: AddressingPolicy | null; canManageAgents: boolean }
  ) => Promise<void>;
  openAgent: (agentId: string) => void;
  /** The other ways to add an agent, as links under the title; each closes the dialog first. */
  otherWays: { label: string; onClick: () => void }[];
  /** Where a person adds a device. */
  addDevice: () => void;
  /** Keeps the dialog open while a create is under way. */
  setCloseGuard: (active: boolean) => void;
  onClose: () => void;
  ConfirmButton: ComponentType<{
    type: 'button';
    onClick: () => void;
    disabled: boolean;
    children: ReactNode;
  }>;
};

/** The model, which comes before a provider's own fields. */
export const MODEL_FIELD: NewAgentAdvancedField = {
  key: 'model',
  label: 'Model',
  type: 'text',
  help: null,
  placeholder: 'Default — enter a model',
  options: null,
  catalogue: null,
};

type FormValue = string | boolean;

function emptyForm(fields: NewAgentAdvancedField[]): Record<string, FormValue> {
  return Object.fromEntries(
    fields.map((field) => [field.key, field.type === 'boolean' ? false : ''])
  );
}

/** The advanced configuration as a definition carries it: unset fields left out, which Switch requires. */
export function advancedConfigOf(
  fields: NewAgentAdvancedField[],
  form: Record<string, FormValue>
): Record<string, AdvancedConfigValue> {
  const config: Record<string, AdvancedConfigValue> = {};
  for (const field of fields) {
    const value = form[field.key];
    if (field.type === 'boolean') {
      if (value === true) config[field.key] = true;
      continue;
    }
    const text = String(value ?? '').trim();
    if (text === '') continue;
    if (field.type === 'list') {
      const items = text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length > 0) config[field.key] = items;
    } else if (field.type === 'number') config[field.key] = Number(text);
    else config[field.key] = text;
  }
  return config;
}

/** Whether `dir` is a full path on a device running `os`. */
export function isFullPath(dir: string, os: string | null): boolean {
  if (os === 'windows') return /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith('\\\\');
  return dir.startsWith('/');
}

/** The folder a device makes for an agent named `name` in its workspaces; null while either is unknown. */
export function deviceWorkspaceFor(device: NewAgentDevice, name: string): string | null {
  const dir = device.workspacesDir;
  if (dir === null || name.trim() === '') return null;
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${separator}${name.trim()}`;
}

const UNSET = '__unset__';

/** One field of a provider's advanced configuration, as an input of its type. */
export function AdvancedFieldInput({
  field,
  value,
  onChange,
}: {
  field: NewAgentAdvancedField;
  value: FormValue;
  onChange: (value: FormValue) => void;
}) {
  const id = `agent-advanced-${field.key}`;
  if (field.type === 'boolean')
    return <Switch id={id} checked={value === true} onCheckedChange={(next) => onChange(next)} />;
  if (field.type === 'textarea')
    return (
      <Textarea
        id={id}
        value={String(value)}
        rows={5}
        placeholder={field.placeholder ?? undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  if (field.type === 'select') {
    const options = field.options ?? [];
    const selected = String(value).length > 0 ? String(value) : UNSET;
    return (
      <Select
        value={selected}
        onValueChange={(next) => onChange(next === UNSET ? '' : (next ?? ''))}
      >
        <SelectTrigger id={id}>
          <SelectValue>
            {options.find((o) => (o.value.length > 0 ? o.value : UNSET) === selected)?.label ?? ''}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value.length > 0 ? option.value : UNSET}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      id={id}
      type={field.type === 'number' ? 'number' : 'text'}
      value={String(value)}
      placeholder={field.placeholder ?? undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * The New agent dialog for an agent Switch runs on one of the person's
 * devices: its name and icon, the device, the provider that device runs it
 * with (giving the device a login where it needs one), the model and the
 * provider's advanced configuration, and its settings. Switch places the
 * agent on the device, which runs it; the agent opens once it exists.
 *
 * Draw it inside a dialog's content; it supplies the header and footer.
 */
export function NewAgentDialog({ host }: { host: NewAgentHost }) {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [editedDir, setEditedDir] = useState<string | null>(null);
  const [canManageAgents, setCanManageAgents] = useState(false);
  const [advanced, setAdvanced] = useState<Record<string, FormValue>>({});
  const [submitState, setSubmitState] = useState<'idle' | 'creating'>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  /** Created, but its settings could not all be set. */
  const [incomplete, setIncomplete] = useState<{ agentId: string; message: string } | null>(null);

  const form = useNewAgentForm({
    ...host.formRules,
    providerId,
    permissions: host.permissionsFor(providerId),
    initialPolicy: host.initialPolicy,
    thirdPartyAvatarsEnabled: host.thirdPartyAvatarsEnabled,
  });

  const devices = host.devices;
  const device = devices?.find((candidate) => candidate.id === deviceId) ?? null;
  const word = host.machineWord;

  // The first device that can take an agent, once they are listed.
  useEffect(() => {
    if (deviceId !== null || !devices) return;
    const first = devices.find((candidate) => candidate.online) ?? devices[0];
    if (first) setDeviceId(first.id);
  }, [deviceId, devices]);

  // What is chosen below the device belongs to the device: availability and
  // folders are per device, so a choice made on one is cleared on another.
  const chooseDevice = (id: string | null) => {
    if (id === deviceId) return;
    setDeviceId(id);
    setProviderId(null);
    setEditedDir(null);
  };

  const provider = host.providers?.find((candidate) => candidate.id === providerId) ?? null;
  const fields = useMemo(() => (provider ? [MODEL_FIELD, ...provider.fields] : []), [provider]);
  useEffect(() => setAdvanced(emptyForm(fields)), [fields]);

  const options = useMemo(
    () =>
      machineProviderOptions(
        host.providers ?? [],
        device?.providers ?? [],
        device?.providersSettled ?? false
      ),
    [host.providers, device]
  );
  // Picked for the person only where there is nothing to choose.
  const autoSelect = useCallback((ready: string[]) => (ready.length === 1 ? ready[0]! : null), []);

  const suggestedDir = device ? deviceWorkspaceFor(device, form.agentName) : null;
  const dir = (editedDir?.trim() ? editedDir : (suggestedDir ?? '')).trim();
  const dirIsFull = dir === '' || (device !== null && isFullPath(dir, device.os));
  const providerReady = options.some((option) => option.id === providerId && option.ready);
  const nameTaken =
    form.nameIsValid &&
    submitState === 'idle' &&
    incomplete === null &&
    host.takenNames.has(form.agentName);

  const deviceReason =
    devices === undefined || (host.cloudOnly && host.devicesError)
      ? host.devicesError
        ? failureText(host.devicesError, `Your ${word}s could not be listed.`)
        : `Listing your ${word}s…`
      : host.cloudOnly && (device === null || !device.online)
        ? `Your Switch Cloud ${word} is starting. This can take a few minutes.`
        : device === null
          ? devices.length === 0
            ? `You have no ${word} to run the agent on yet.`
            : `Choose a ${word}.`
          : device.online
            ? null
            : `${device.name} is offline. Start its controller, or choose another ${word}.`;

  const canSubmit =
    form.isValid &&
    !nameTaken &&
    device !== null &&
    deviceReason === null &&
    providerReady &&
    dirIsFull &&
    submitState === 'idle' &&
    incomplete === null;

  const disabledReason: string | null =
    submitState !== 'idle' || incomplete !== null
      ? null
      : form.agentName.trim().length === 0
        ? 'Enter a name for the agent.'
        : !form.nameIsValid
          ? 'Fix the agent name: lowercase letters, digits, . - _, starting with a letter or digit.'
          : nameTaken
            ? `An agent called ${form.agentName} already exists ${host.takenWhere}. Pick another name.`
            : form.description.trim().length === 0
              ? 'Add a description so people and agents know what this agent is for.'
              : deviceReason !== null
                ? deviceReason
                : !providerId
                  ? 'Choose an agent provider.'
                  : !providerReady
                    ? `That provider is not installed and signed in on ${device!.name}.`
                    : !dirIsFull
                      ? device!.os === 'windows'
                        ? `Give the full path on ${device!.name}, starting with a drive, like C:\\.`
                        : `Give the full path on ${device!.name}, starting with “/”.`
                      : null;

  const create = async () => {
    if (!canSubmit || !device || !providerId) return;
    setSubmitState('creating');
    setFailure(null);
    host.setCloseGuard(true);
    let agentId: string | null = null;
    try {
      agentId = (
        await host.createAgent({
          name: form.agentName,
          description: form.description.trim(),
          displayName: form.displayName.trim() || null,
          iconUrl: form.iconUrl,
          deviceId: device.id,
          directory: dir || null,
          provider: providerId,
          model: String(advanced[MODEL_FIELD.key] ?? '').trim() || null,
          advancedConfig: advancedConfigOf(provider?.fields ?? [], advanced),
          instructions: form.instructions,
          autoMode: form.autoMode,
          autoApprove: form.autoApprove,
          // A Switch Cloud device runs every agent as a user of its own.
          isolation: device.cloud ? 'isolated' : 'shared',
        })
      ).agentId;
      await host.finishSetup(agentId, {
        addressingPolicy: form.addressingPolicy,
        canManageAgents,
      });
      host.setCloseGuard(false);
      host.onClose();
      host.openAgent(agentId);
    } catch (error) {
      host.setCloseGuard(false);
      setSubmitState('idle');
      if (agentId !== null)
        setIncomplete({
          agentId,
          message: failureText(error, 'Its settings could not be saved.'),
        });
      else
        setFailure(failureText(error, 'Could not add the agent. Nothing was created — try again.'));
    }
  };

  const entries: RunLocationEntry[] = (devices ?? []).map((candidate) => ({
    value: candidate.id,
    label: candidate.online ? candidate.name : `${candidate.name} (offline)`,
    tag: candidate.tag,
    icon: candidate.icon,
    disabled: !candidate.online,
    truncate: true,
  }));

  return (
    <>
      <NewAgentHeader
        closable={submitState === 'idle'}
        otherWays={host.otherWays.map((way) => ({
          label: way.label,
          onClick: () => {
            host.onClose();
            way.onClick();
          },
        }))}
      />
      <DialogContentArea
        data-autofocus
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem-var(--modal-chrome,8.5rem))] gap-4"
      >
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        {incomplete && (
          <Alert variant="destructive">
            <AlertDescription>
              Agent created, but setup is incomplete: {incomplete.message} Open it and check who can
              talk to it, and whether it can manage agents. Do not create it again.
            </AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  host.onClose();
                  host.openAgent(incomplete.agentId);
                }}
              >
                Open the agent
              </Button>
            </AlertAction>
          </Alert>
        )}

        <NewAgentIdentityFields
          form={form}
          nameTaken={nameTaken}
          takenWhere={host.takenWhere}
          iconPicker={host.iconPicker(form)}
        />

        {host.cloudOnly ? (
          host.devicesError ? (
            <p role="alert" className="text-xs text-destructive">
              {deviceReason}
            </p>
          ) : (
            <>
              <RunLocationLine icon="cloud" status>
                {deviceReason ?? `Runs on your Switch Cloud ${word}.`}
              </RunLocationLine>
              {host.cloudNote}
            </>
          )
        ) : (
          <RunLocationField
            value={deviceId ?? ''}
            onValueChange={(value) => chooseDevice(value || null)}
            selected={{
              icon: device?.icon ?? 'server',
              label: device?.name ?? `Choose a ${word}`,
            }}
            entries={entries}
          >
            {device && (
              <RunLocationLine icon={device.cloud ? 'cloud' : 'server'} status={false}>
                {device.online ? `Runs as a managed agent on ${device.name}.` : deviceReason}
              </RunLocationLine>
            )}
            {!device && deviceReason !== null && (
              <p
                className={
                  host.devicesError ? 'text-xs text-destructive' : 'text-xs text-foreground-muted'
                }
              >
                {deviceReason}
              </p>
            )}
            {devices !== undefined && devices.length === 0 && (
              <Button variant="outline" size="sm" className="w-fit" onClick={host.addDevice}>
                Add a {word}
              </Button>
            )}
          </RunLocationField>
        )}

        {device && (
          <MachineProviderPicker
            machineName={device.name}
            reportedTo={host.reportedTo}
            reported={device.providers.length > 0}
            options={options}
            value={providerId}
            onChange={setProviderId}
            autoSelect={autoSelect}
            icon={host.providerIcon}
            acceptsLogins={device.acceptsLogins}
            loginOffered={host.loginOffered}
            loginInCard
            giveLogin={(id, onClose) => host.giveLogin(device, id, onClose)}
          />
        )}
        {host.providersError !== null && host.providersError !== undefined && (
          <p role="alert" className="text-xs text-foreground-destructive">
            {failureText(host.providersError, 'The providers Switch runs could not be read.')}
          </p>
        )}

        {device && provider && (
          <AdvancedConfigSection
            providerLabel={provider.name}
            fields={fields}
            fieldNote={(field) =>
              field.key === MODEL_FIELD.key || field.catalogue
                ? `Couldn't read ${device.name}'s models, so this isn't checked. You can enter a model alias or ID.`
                : undefined
            }
            renderInput={(field) => (
              <AdvancedFieldInput
                field={field}
                value={advanced[field.key] ?? (field.type === 'boolean' ? false : '')}
                onChange={(value) => setAdvanced((current) => ({ ...current, [field.key]: value }))}
              />
            )}
          />
        )}

        {device && (
          <NewAgentSettingsSection
            form={form}
            addressing={host.addressing(form)}
            ownerUnreachable={false}
          >
            <ManagedDirectoryField
              machineWord={word}
              machineLabel={device.name}
              value={editedDir ?? suggestedDir ?? ''}
              suggestedPath={suggestedDir}
              error={null}
              picker={null}
              onChange={setEditedDir}
            />
            <CanManageAgentsToggle
              machineWord={word}
              checked={canManageAgents}
              onChange={setCanManageAgents}
            />
          </NewAgentSettingsSection>
        )}
      </DialogContentArea>
      <NewAgentFooter
        waitingFor={null}
        onBack={null}
        onCancel={host.onClose}
        idle={submitState === 'idle'}
        creating={submitState === 'creating'}
        canSubmit={canSubmit}
        disabledReason={disabledReason}
        onCreate={() => void create()}
        ConfirmButton={host.ConfirmButton}
      />
    </>
  );
}
