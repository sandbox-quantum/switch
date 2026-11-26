import { Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@switch-console/chat-ui/primitives/field";
import { Input } from "@switch-console/chat-ui/primitives/input";
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
} from "@switch-console/chat-ui/model/decision-routing";
import { useAuth } from "../../data/AuthContext";
import {
  clearDecisionSettings,
  fetchDecisionSettings,
  testDecisionSettings,
  updateDecisionSettings,
} from "../../data/api";
import type { DecisionSettings, DecisionTestOutcome } from "@switch-console/chat-ui/contracts/decision-routing";

function convertSettings(wire: Awaited<ReturnType<typeof fetchDecisionSettings>>): DecisionSettings {
  return {
    source: wire.source,
    effective: wire.effective,
    workspace: wire.workspace
      ? {
          backend: wire.workspace.backend,
          endpoint: wire.workspace.endpoint,
          threshold: wire.workspace.threshold,
          hasApiKey: wire.workspace.has_api_key,
          apiKeyLast4: wire.workspace.api_key_last4,
          apiKeyUnreadable: wire.workspace.api_key_unreadable,
          updatedAt: wire.workspace.updated_at,
        }
      : null,
    serverDefault: {
      configured: wire.server_default.configured,
      endpoint: wire.server_default.endpoint,
      hasApiKey: wire.server_default.has_api_key,
    },
    options: { haikuAnthropic: wire.options.haiku_anthropic, haikuBedrock: wire.options.haiku_bedrock },
  };
}

function convertTestOutcome(wire: Awaited<ReturnType<typeof testDecisionSettings>>): DecisionTestOutcome {
  return {
    ok: wire.ok,
    agent: wire.agent,
    modelChoice: wire.model_choice,
    confidence: wire.confidence,
    latencyMs: wire.latency_ms,
    backend: wire.backend,
    error: wire.error,
  };
}

function resultText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const CHOICE_HINTS: Record<DecisionChoice, string> = {
  server_default: "",
  none: "Auto-route is off in this workspace's rooms, whatever Switch's default.",
  endpoint: "A decision service you run. Room messages are sent to it.",
  haiku_anthropic: "The most accurate picks, at about 1.5 s each. Room messages are sent to Anthropic.",
  haiku_bedrock: "Haiku through Amazon Bedrock, on this Switch deployment's AWS account. No key needed.",
};

type TestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "done"; outcome: DecisionTestOutcome }
  | { phase: "failed"; message: string };

function MessageRoutingSection() {
  const [settings, setSettings] = useState<DecisionSettings | null>(null);
  const [form, setForm] = useState<DecisionForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"saving" | "resetting" | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: "idle" });

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setForm(null);
    setLoadError(null);
    fetchDecisionSettings().then(
      (loaded) => {
        if (cancelled) return;
        const settings = convertSettings(loaded);
        setSettings(settings);
        setForm(formFor(settings));
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(resultText(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError !== null) {
    return (
      <Alert variant="destructive">
        <Typography>{loadError}</Typography>
      </Alert>
    );
  }
  if (settings === null || form === null) return <CircularProgress />;

  const edit = (changes: Partial<DecisionForm>) => {
    setForm({ ...form, ...changes });
    setSaved(false);
    setTest({ phase: "idle" });
  };

  const apply = (result: DecisionSettings) => {
    setSettings(result);
    setForm(formFor(result));
    setActionError(null);
    setSaved(true);
  };

  const reset = async () => {
    setBusy("resetting");
    setActionError(null);
    try {
      await clearDecisionSettings();
      const loaded = await fetchDecisionSettings();
      apply(convertSettings(loaded));
    } catch (cause) {
      setActionError(resultText(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const input = inputFor(form);
    if (input === null) return reset();
    setBusy("saving");
    setActionError(null);
    try {
      const wireInput = {
        backend: input.backend,
        ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
        ...(input.apiKey !== undefined ? { api_key: input.apiKey } : {}),
        ...(input.clearApiKey !== undefined ? { clear_api_key: input.clearApiKey } : {}),
        ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
      };
      const saved = await updateDecisionSettings(wireInput);
      apply(convertSettings(saved));
    } catch (cause) {
      setActionError(resultText(cause));
    } finally {
      setBusy(null);
    }
  };

  const testable = testInputFor(form, settings);
  const runTest = async () => {
    if (!("input" in testable)) return;
    setTest({ phase: "testing" });
    try {
      const input = testable.input;
      const wireInput =
        "backend" in input && input.backend === "default"
          ? { backend: "default" as const }
          : {
              backend: input.backend,
              ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
              ...(input.apiKey !== undefined ? { api_key: input.apiKey } : {}),
              ...(input.clearApiKey !== undefined ? { clear_api_key: input.clearApiKey } : {}),
              ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
            };
      const outcome = await testDecisionSettings(wireInput);
      setTest({ phase: "done", outcome: convertTestOutcome(outcome) });
    } catch (cause) {
      setTest({ phase: "failed", message: resultText(cause) });
    }
  };

  const fields = choiceFields(form.choice);
  const problem = form.choice === "server_default" ? null : formProblem(form, settings);
  const keyText = storedKeyText(settings);
  const note = haikuNote(settings);
  const unchanged = form.choice === "server_default" && settings.source === "server_default";

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {appliesText(settings)}
        </Typography>
        {!settings.effective.available && settings.effective.reason && (
          <Box sx={{ mt: 1 }}>
            <Alert variant="warning">
              <Typography>{settings.effective.reason}</Typography>
            </Alert>
          </Box>
        )}
      </Box>

      <Box component="fieldset" sx={{ border: "none", p: 0, m: 0 }}>
        <Typography component="legend" variant="subtitle2" sx={{ mb: 1 }}>
          Backend
        </Typography>
        <Stack spacing={1}>
          {offeredChoices(settings).map((choice) => (
            <Box key={choice} component="label" sx={{ display: "flex", alignItems: "start", gap: 1.5 }}>
              <input
                type="radio"
                name="backend"
                value={choice}
                checked={form.choice === choice}
                onChange={() => edit({ choice: choice as DecisionChoice })}
                style={{ marginTop: "2px" }}
              />
              <Stack>
                <Typography variant="body2">{CHOICE_LABELS[choice]}</Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {choice === "server_default" ? `Currently ${serverDefaultText(settings)}.` : CHOICE_HINTS[choice]}
                </Typography>
              </Stack>
            </Box>
          ))}
        </Stack>
        {note !== null && (
          <Typography variant="caption" sx={{ color: "text.secondary", mt: 1, display: "block" }}>
            {note}
          </Typography>
        )}
      </Box>

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
                {form.choice === "haiku_anthropic" ? "Anthropic API key" : "API key (optional)"}
                {keyText !== null && (
                  <Typography
                    component="span"
                    variant="caption"
                    sx={{
                      ml: 0.5,
                      color: settings.workspace?.apiKeyUnreadable ? "error.main" : "text.secondary",
                    }}
                  >
                    ({keyText})
                  </Typography>
                )}
              </FieldLabel>
              <Input
                id="decision-key"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={keyText !== null ? "Leave blank to keep the current key" : ""}
                value={form.apiKey}
                onChange={(e) => edit({ apiKey: e.target.value })}
              />
              {form.choice === "endpoint" && settings.workspace?.hasApiKey && (
                <Box component="label" sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5 }}>
                  <input
                    type="checkbox"
                    checked={form.clearApiKey}
                    disabled={form.apiKey.trim() !== ""}
                    onChange={(e) => edit({ clearApiKey: e.target.checked })}
                  />
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    Remove the stored key
                  </Typography>
                </Box>
              )}
            </Field>
          )}
          {fields.threshold && (
            <Field>
              <FieldLabel htmlFor="decision-threshold">Confidence threshold</FieldLabel>
              <Box sx={{ maxWidth: 128 }}>
                <Input
                  id="decision-threshold"
                  inputMode="decimal"
                  placeholder="Default"
                  value={form.threshold}
                  onChange={(e) => edit({ threshold: e.target.value })}
                />
              </Box>
              <FieldDescription>
                Between 0 and 1. A pick less confident than this goes to nobody. Leave blank for the decision
                service&apos;s own.
              </FieldDescription>
            </Field>
          )}
        </FieldGroup>
      )}

      {problem !== null && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {problem}
        </Typography>
      )}
      {actionError !== null && (
        <Typography variant="caption" sx={{ color: "error.main" }}>
          Not saved — {actionError}
        </Typography>
      )}

      <Stack direction="row" spacing={1}>
        <Button size="sm" disabled={problem !== null || unchanged || busy !== null} onClick={() => void save()}>
          {busy === "saving" ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!("input" in testable) || test.phase === "testing" || busy !== null}
          title={"blocked" in testable ? testable.blocked : undefined}
          onClick={() => void runTest()}
        >
          {test.phase === "testing" ? "Testing…" : "Test"}
        </Button>
        {settings.source === "workspace" && (
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void reset()}>
            {busy === "resetting" ? "Returning…" : "Use Switch default"}
          </Button>
        )}
        {saved && actionError === null && (
          <Typography variant="caption" sx={{ color: "text.secondary", alignSelf: "center" }}>
            Saved.
          </Typography>
        )}
      </Stack>

      {(test.phase === "done" || test.phase === "failed") && (
        <Box
          role="status"
          aria-label="Test result"
          sx={{
            color: test.phase === "failed" || !test.outcome.ok ? "error.main" : "text.primary",
          }}
        >
          <Typography variant="body2">
            {test.phase === "failed"
              ? `Test failed — ${test.message}`
              : test.outcome.ok
                ? testOutcomeText(test.outcome)
                : `Test failed — ${test.outcome.error?.message ?? "Unknown error"}`}
          </Typography>
        </Box>
      )}
    </Stack>
  );
}

export default function MessageRoutingPage() {
  const { capabilities } = useAuth();
  if (!capabilities.administersWorkspace) {
    return (
      <Box>
        <Typography variant="h5" mb={3}>
          Message routing
        </Typography>
        <Alert variant="warning">
          <Typography>Only a workspace admin can view or change message routing.</Typography>
        </Alert>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h5" mb={3}>
        Message routing
      </Typography>
      <MessageRoutingSection />
    </Box>
  );
}
