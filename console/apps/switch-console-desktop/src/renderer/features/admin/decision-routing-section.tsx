import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { RadioGroup, RadioGroupItem } from '@renderer/lib/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import type {
  ClearDecisionSettingsResult,
  DecisionSettings,
  DecisionTestOutcome,
  UpdateDecisionSettingsResult,
} from '@shared/core/switch-servers/switch-servers';
import {
  CHOICE_LABELS,
  choiceFields,
  type DecisionChoice,
  type DecisionForm,
  appliesText,
  formFor,
  formProblem,
  haikuNote,
  inputFor,
  MACHINE_POLL_MS,
  machineOption,
  machineOptionNote,
  machineSettling,
  machineStateLine,
  type MachineStateTone,
  modelLabel,
  offeredChoices,
  offeredModelText,
  serverDefaultText,
  storedKeyText,
  testInputFor,
  testOutcomeText,
  withMachine,
} from './decision-routing';

/** The recoverable failure kinds every decision settings call can produce,
 * worded for someone filling in the form. */
function resultText(result: { kind: string; message?: string }): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session has expired. Sign in again.';
    case 'forbidden':
      return 'Only an admin of this workspace can view or change its decision routing.';
    case 'unsupported':
      return 'This Switch server doesn’t offer decision routing settings. Update it to set them up here.';
    default:
      return result.message ?? 'Could not reach the decision routing settings.';
  }
}

const CHOICE_HINTS: Record<DecisionChoice, string> = {
  server_default: '',
  none: 'Auto-route is off in this workspace’s rooms, whatever the server default.',
  endpoint: 'A decision service you run. Room messages are sent to it.',
  haiku_anthropic:
    'The most accurate picks, at about 1.5 s each. Room messages are sent to Anthropic.',
  haiku_bedrock: 'Haiku through Amazon Bedrock, on this server’s AWS account. No key needed.',
  machine:
    'A computer of yours runs the model. Room messages reach it over its own connection to Switch, and are not kept there.',
};

const TONE_TEXT: Record<MachineStateTone, string> = {
  ok: 'text-foreground-success',
  busy: 'text-foreground',
  problem: 'text-destructive',
  idle: 'text-foreground-muted',
};

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'done'; outcome: DecisionTestOutcome }
  | { phase: 'failed'; message: string };

/**
 * A workspace's decision routing: who decides which agent answers an untagged
 * message in its auto-route rooms. The server's default applies until a
 * workspace admin chooses otherwise — none, a self-hosted endpoint, or Haiku
 * where the server can run it — and a test runs one sample decision against
 * the values as entered, before anything is saved.
 *
 * The form shows what the server says: it is reset from each answer, and a
 * refusal leaves the stored setting as it was, with the reason under it.
 */
export function DecisionRoutingSection({ workspaceId }: { workspaceId: string }) {
  const [settings, setSettings] = useState<DecisionSettings | null>(null);
  const [form, setForm] = useState<DecisionForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'saving' | 'resetting' | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setForm(null);
    setLoadError(null);
    rpc.switchServers.getDecisionSettings(workspaceId).then(
      (result) => {
        if (cancelled) return;
        if (result.kind === 'loaded') {
          setSettings(result.settings);
          setForm(formFor(result.settings));
        } else {
          setLoadError(resultText(result));
        }
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(failureText(error, 'Could not load decision routing.'));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // While the chosen machine downloads and starts its model (or is offline),
  // ask again every few seconds, so the state line follows it. Only the
  // settings are replaced: whatever is being edited in the form stays.
  const settling = settings !== null && machineSettling(settings);
  useEffect(() => {
    if (!settling) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc.switchServers.getDecisionSettings(workspaceId).then(
        (result) => {
          if (!cancelled && result.kind === 'loaded') setSettings(result.settings);
        },
        () => {}
      );
    }, MACHINE_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [settling, settings, workspaceId]);

  if (loadError !== null) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }
  if (settings === null || form === null) return <Spinner />;

  const edit = (changes: Partial<DecisionForm>) => {
    setForm({ ...form, ...changes });
    setSaved(false);
    setTest({ phase: 'idle' });
  };

  const apply = (result: UpdateDecisionSettingsResult | ClearDecisionSettingsResult) => {
    if (result.kind === 'saved' || result.kind === 'cleared') {
      setSettings(result.settings);
      setForm(formFor(result.settings));
      setActionError(null);
      setSaved(true);
    } else {
      setActionError(resultText(result));
    }
  };

  const reset = async () => {
    setBusy('resetting');
    setActionError(null);
    try {
      apply(await rpc.switchServers.clearDecisionSettings(workspaceId));
    } catch (cause) {
      setActionError(failureText(cause, 'Could not return to the server default.'));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const input = inputFor(form);
    if (input === null) return reset();
    setBusy('saving');
    setActionError(null);
    try {
      apply(await rpc.switchServers.updateDecisionSettings({ workspaceId, ...input }));
    } catch (cause) {
      setActionError(failureText(cause, 'Could not save decision routing.'));
    } finally {
      setBusy(null);
    }
  };

  const testable = testInputFor(form, settings);
  const runTest = async () => {
    if (!('input' in testable)) return;
    setTest({ phase: 'testing' });
    try {
      const result = await rpc.switchServers.testDecisionSettings({
        workspaceId,
        ...testable.input,
      });
      setTest(
        result.kind === 'tested'
          ? { phase: 'done', outcome: result.outcome }
          : { phase: 'failed', message: resultText(result) }
      );
    } catch (cause) {
      setTest({ phase: 'failed', message: failureText(cause, 'Could not run the test.') });
    }
  };

  const fields = choiceFields(form.choice);
  const problem = form.choice === 'server_default' ? null : formProblem(form, settings);
  const keyText = storedKeyText(settings);
  const note = haikuNote(settings);
  const unchanged = form.choice === 'server_default' && settings.source === 'server_default';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2" aria-label="Setting that applies">
        <p className="text-sm text-foreground">{appliesText(settings)}</p>
        <MachineState settings={settings} />
        {!settings.effective.available && settings.effective.reason && (
          <Alert variant="warning">
            <AlertDescription>{settings.effective.reason}</AlertDescription>
          </Alert>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-foreground">Backend</legend>
        <RadioGroup
          value={form.choice}
          onValueChange={(value) => edit({ choice: value as DecisionChoice })}
          className="gap-2.5"
          aria-label="Decision backend"
        >
          {offeredChoices(settings).map((choice) => (
            <label key={choice} className="flex items-start gap-2.5 text-sm">
              <RadioGroupItem value={choice} className="mt-0.5" />
              <span className="flex flex-col">
                <span className="text-foreground">{CHOICE_LABELS[choice]}</span>
                <span className="text-xs text-foreground-muted">
                  {choice === 'server_default'
                    ? `Currently ${serverDefaultText(settings)}.`
                    : CHOICE_HINTS[choice]}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
        {note !== null && <p className="text-xs text-foreground-muted">{note}</p>}
      </fieldset>

      {form.choice === 'machine' && <MachinePicker settings={settings} form={form} edit={edit} />}

      {(fields.endpoint || fields.key || fields.threshold) && (
        <FieldGroup>
          {fields.endpoint && (
            <Field>
              <FieldLabel htmlFor="decision-endpoint">Endpoint URL</FieldLabel>
              <Input
                id="decision-endpoint"
                value={form.endpoint}
                placeholder="https://decision.example.com"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => edit({ endpoint: e.target.value })}
              />
            </Field>
          )}
          {fields.key && (
            <Field>
              <FieldLabel htmlFor="decision-key">
                {form.choice === 'haiku_anthropic' ? 'Anthropic API key' : 'API key (optional)'}
                {keyText !== null && (
                  <span
                    className={
                      settings.workspace?.apiKeyUnreadable
                        ? 'ml-1 font-normal text-destructive'
                        : 'ml-1 font-normal text-foreground-muted'
                    }
                  >
                    ({keyText})
                  </span>
                )}
              </FieldLabel>
              <Input
                id="decision-key"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={keyText !== null ? 'Leave blank to keep the current key' : ''}
                value={form.apiKey}
                onChange={(e) => edit({ apiKey: e.target.value })}
              />
              {form.choice === 'endpoint' && settings.workspace?.hasApiKey && (
                <label className="flex items-center gap-2 text-xs text-foreground-muted">
                  <Checkbox
                    checked={form.clearApiKey}
                    disabled={form.apiKey.trim() !== ''}
                    onCheckedChange={(checked) => edit({ clearApiKey: checked === true })}
                  />
                  Remove the stored key
                </label>
              )}
            </Field>
          )}
          {fields.threshold && (
            <Field>
              <FieldLabel htmlFor="decision-threshold">Confidence threshold</FieldLabel>
              <Input
                id="decision-threshold"
                inputMode="decimal"
                className="w-32"
                placeholder="Default"
                value={form.threshold}
                onChange={(e) => edit({ threshold: e.target.value })}
              />
              <FieldDescription className="text-xs">
                Between 0 and 1. A pick less confident than this goes to nobody. Leave blank for the
                decision service’s own.
              </FieldDescription>
            </Field>
          )}
        </FieldGroup>
      )}

      {problem !== null && <p className="text-xs text-foreground-muted">{problem}</p>}
      {actionError !== null && (
        <p className="text-xs text-destructive">Not saved — {actionError}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={problem !== null || unchanged || busy !== null}
          onClick={() => void save()}
        >
          {busy === 'saving' ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!('input' in testable) || test.phase === 'testing' || busy !== null}
          title={'blocked' in testable ? testable.blocked : undefined}
          onClick={() => void runTest()}
        >
          {test.phase === 'testing' ? 'Testing…' : 'Test'}
        </Button>
        {settings.source === 'workspace' && (
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void reset()}>
            {busy === 'resetting' ? 'Returning…' : 'Use server default'}
          </Button>
        )}
        {saved && actionError === null && (
          <span className="text-xs text-foreground-muted">Saved.</span>
        )}
      </div>

      <TestResult state={test} />
    </div>
  );
}

function TestResult({ state }: { state: TestState }) {
  if (state.phase === 'idle' || state.phase === 'testing') return null;
  const failed = state.phase === 'failed' || !state.outcome.ok;
  const text = state.phase === 'failed' ? state.message : testOutcomeText(state.outcome);
  return (
    <p
      role="status"
      aria-label="Test result"
      className={failed ? 'text-sm text-destructive' : 'text-sm text-foreground'}
    >
      {failed ? `Test failed — ${text}` : text}
    </p>
  );
}

/**
 * Where the chosen machine's decision model stands, while the workspace runs
 * auto-route on one of its admin's machines.
 */
function MachineState({ settings }: { settings: DecisionSettings }) {
  const machine = settings.effective.machine;
  if (settings.effective.backend !== 'machine' || machine === null) return null;
  const line = machineStateLine(machine, machineOption(settings, machine.id));
  return (
    <p role="status" aria-label="Machine state" className="text-sm text-foreground">
      <span className="text-foreground-muted">Decision model on {machine.name}: </span>
      <span className={TONE_TEXT[line.tone]}>{line.text}</span>
    </p>
  );
}

/**
 * The admin's own machines in this workspace, and the models the one picked
 * offers. A machine that can't run the model is listed but can't be picked,
 * with the reason; one that isn't connected now is flagged, and can still be
 * picked: it starts when it next connects.
 */
function MachinePicker({
  settings,
  form,
  edit,
}: {
  settings: DecisionSettings;
  form: DecisionForm;
  edit: (changes: Partial<DecisionForm>) => void;
}) {
  const machines = settings.options.machines ?? [];
  const picked = machineOption(settings, form.machineId);
  if (machines.length === 0) {
    return (
      <p className="text-sm text-foreground-muted" aria-label="Machine">
        None of your machines is enrolled in this workspace. Turn on “Run managed agents on this
        computer”, or enroll an agent controller, then come back here.
      </p>
    );
  }
  const offered = picked?.decision.supported ? picked.decision.offered : [];
  return (
    <FieldGroup>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-foreground">Machine</legend>
        <RadioGroup
          value={form.machineId}
          onValueChange={(value) => {
            const option = machineOption(settings, value as string);
            if (option) {
              const next = withMachine(form, option);
              edit({ machineId: next.machineId, model: next.model });
            }
          }}
          className="gap-2.5"
          aria-label="Machine"
        >
          {machines.map((machine) => (
            <label
              key={machine.id}
              className={cn(
                'flex items-start gap-2.5 text-sm',
                !machine.decision.supported && 'cursor-not-allowed'
              )}
              data-machine={machine.id}
            >
              <RadioGroupItem
                value={machine.id}
                className="mt-0.5"
                disabled={!machine.decision.supported}
              />
              <span className="flex flex-col">
                <span
                  className={
                    machine.decision.supported ? 'text-foreground' : 'text-foreground-muted'
                  }
                >
                  {machine.name}
                </span>
                <span
                  className={cn(
                    'text-xs',
                    !machine.decision.supported || !machine.connected
                      ? 'text-foreground-warning'
                      : 'text-foreground-muted'
                  )}
                >
                  {machineOptionNote(machine)}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      {picked !== null && offered.length > 0 && (
        <Field>
          <FieldLabel>Model</FieldLabel>
          <Select
            value={form.model}
            onValueChange={(next) => {
              if (typeof next === 'string') edit({ model: next });
            }}
          >
            <SelectTrigger aria-label="Model" className="w-80">
              <SelectValue>
                {form.model ? modelLabel(form.model, picked) : 'Choose a model'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {offered.map((offer) => (
                <SelectItem key={offer.model} value={offer.model}>
                  {offeredModelText(offer)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription className="text-xs">
            The machine downloads it once, checks it, and runs it for this workspace only.
          </FieldDescription>
        </Field>
      )}
    </FieldGroup>
  );
}
