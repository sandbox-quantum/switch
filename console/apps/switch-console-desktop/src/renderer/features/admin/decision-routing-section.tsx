import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { RadioGroup, RadioGroupItem } from '@renderer/lib/ui/radio-group';
import { Spinner } from '@renderer/lib/ui/spinner';
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
  offeredChoices,
  serverDefaultText,
  storedKeyText,
  testInputFor,
  testOutcomeText,
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
