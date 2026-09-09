import { ArrowLeft, ArrowRight, FileText, Loader2, Upload } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ParamSpec, ParsedTemplate } from '@main/core/room-templates/controller';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { useRemoteAgents } from '@renderer/lib/stores/use-remote-agents';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';

type Step = 'source' | 'inputs' | 'creating';

// ── Source step ─────────────────────────────────────────────────────────────

function SourceStep({
  yamlText,
  onYamlChange,
  parseError,
  onNext,
}: {
  yamlText: string;
  onYamlChange: (text: string) => void;
  parseError: string | null;
  onNext: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') onYamlChange(reader.result);
      };
      reader.readAsText(file);
      // Reset so the same file can be re-picked
      e.target.value = '';
    },
    [onYamlChange]
  );

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel>Paste a room template</FieldLabel>
          <Textarea
            placeholder="Paste YAML here…"
            value={yamlText}
            onChange={(e) => onYamlChange(e.target.value)}
            className="min-h-40 font-mono text-xs"
          />
        </Field>
      </FieldGroup>

      <div className="flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml"
          className="hidden"
          onChange={handleFileChange}
        />
        <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
          <Upload className="mr-1.5 size-3.5" />
          Choose file
        </Button>
        <span className="text-xs text-foreground-passive">or paste YAML above</span>
      </div>

      {parseError && (
        <Alert variant="destructive">
          <AlertDescription>{parseError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end pt-2">
        <Button disabled={!yamlText.trim()} onClick={onNext}>
          Next
          <ArrowRight className="ml-1.5 size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Inputs step ─────────────────────────────────────────────────────────────

function ParamField({
  param,
  value,
  onChange,
  error,
  agentNames,
}: {
  param: ParamSpec;
  value: string | number | boolean;
  onChange: (v: string | number | boolean) => void;
  error: string | null;
  agentNames: string[];
}) {
  const label = param.description ?? param.name;
  const isRequired = param.default === null;

  if (param.type === 'boolean') {
    return (
      <Field>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="size-4 rounded border-border"
          />
          <span className="text-sm">
            {label}
            {isRequired && <span className="ml-1 text-destructive">*</span>}
          </span>
        </label>
      </Field>
    );
  }

  if (param.type === 'enum' && param.enum) {
    return (
      <Field>
        <FieldLabel>
          {label}
          {isRequired && <span className="ml-1 text-destructive">*</span>}
        </FieldLabel>
        <select
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="flex h-9 w-full rounded-md border border-border bg-transparent px-2.5 text-sm"
          aria-invalid={error ? true : undefined}
        >
          <option value="">Select…</option>
          {param.enum.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </Field>
    );
  }

  if (param.type === 'number') {
    return (
      <Field>
        <FieldLabel>
          {label}
          {isRequired && <span className="ml-1 text-destructive">*</span>}
        </FieldLabel>
        <Input
          type="number"
          value={value === '' ? '' : Number(value)}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          aria-invalid={error ? true : undefined}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </Field>
    );
  }

  // String — with agent picker warning if isAgentName
  const agentWarning =
    param.isAgentName && typeof value === 'string' && value.trim() !== ''
      ? !agentNames.includes(value.trim())
        ? `No agent named "${value.trim()}" exists on this server`
        : null
      : null;

  return (
    <Field>
      <FieldLabel>
        {label}
        {isRequired && <span className="ml-1 text-destructive">*</span>}
      </FieldLabel>
      <Input
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={param.isAgentName ? 'Agent name…' : undefined}
        aria-invalid={error || agentWarning ? true : undefined}
        list={param.isAgentName ? `agents-${param.name}` : undefined}
      />
      {param.isAgentName && (
        <datalist id={`agents-${param.name}`}>
          {agentNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      {agentWarning && <p className="text-xs text-amber-500">{agentWarning}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </Field>
  );
}

function InputsStep({
  params,
  values,
  onValuesChange,
  fieldErrors,
  agentNames,
  onBack,
  onSubmit,
}: {
  params: ParamSpec[];
  values: Record<string, string | number | boolean>;
  onValuesChange: (values: Record<string, string | number | boolean>) => void;
  fieldErrors: Record<string, string>;
  agentNames: string[];
  onBack: () => void;
  onSubmit: () => void;
}) {
  const handleChange = useCallback(
    (name: string, value: string | number | boolean) => {
      onValuesChange({ ...values, [name]: value });
    },
    [values, onValuesChange]
  );

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        {params.map((param) => (
          <ParamField
            key={param.name}
            param={param}
            value={values[param.name] ?? ''}
            onChange={(v) => handleChange(param.name, v)}
            error={fieldErrors[param.name] ?? null}
            agentNames={agentNames}
          />
        ))}
      </FieldGroup>
      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-1.5 size-3.5" />
          Back
        </Button>
        <Button onClick={onSubmit}>Create Room</Button>
      </div>
    </div>
  );
}

// ── Main view ───────────────────────────────────────────────────────────────

function useServerId(): string {
  return useParams('roomTemplateImport').params.serverId;
}

const TemplateImportTitlebar = observer(function TemplateImportTitlebar() {
  return (
    <ServerSectionTitlebar serverId={useServerId()} icon={FileText} label="Create from Template" />
  );
});

const TemplateImportPanel = observer(function TemplateImportPanel() {
  const serverId = useServerId();
  const agents = useRemoteAgents(serverId);
  const agentNames = useMemo(() => (agents.data ?? []).map((a) => a.name), [agents.data]);

  const [step, setStep] = useState<Step>('source');
  const [yamlText, setYamlText] = useState('');
  const [parsed, setParsed] = useState<ParsedTemplate | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [createError, setCreateError] = useState<string | null>(null);

  const validateInputs = useCallback((): boolean => {
    if (!parsed) return false;
    const errors: Record<string, string> = {};
    for (const param of parsed.params) {
      const val = values[param.name];
      if (param.default === null) {
        // Required
        if (val === '' || val === undefined) {
          errors[param.name] = 'This field is required';
        }
      }
      if (param.type === 'number' && val !== '' && val !== undefined) {
        if (typeof val === 'string' && isNaN(Number(val))) {
          errors[param.name] = 'Must be a number';
        }
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [parsed, values]);

  const handleCreate = useCallback(
    async (template?: ParsedTemplate) => {
      const t = template ?? parsed;
      if (!t) return;

      if (t.params.length > 0 && !validateInputs()) return;

      setStep('creating');
      setCreateError(null);

      try {
        // Build clean inputs — only non-empty, cast numbers
        const inputs: Record<string, string | number | boolean> = {};
        for (const param of t.params) {
          const val = values[param.name];
          if (val !== '' && val !== undefined) {
            if (param.type === 'number') {
              inputs[param.name] = Number(val);
            } else {
              inputs[param.name] = val;
            }
          }
        }

        const result = await rpc.switchServers.createRoomFromTemplate(serverId, yamlText, inputs);
        appState.navigation.navigate('room', { roomId: result.roomId });
      } catch (e) {
        // Map 400 errors back to fields if possible
        const message = failureText(e, 'Could not create the room from this template.');
        const paramMatch = message.match(/param(?:\(s\))?:?\s*['"]?(\w+)/i);
        if (paramMatch && t.params.some((p) => p.name === paramMatch[1])) {
          setFieldErrors({ [paramMatch[1]]: message });
          setStep('inputs');
        } else {
          setCreateError(message);
          setStep(t.params.length > 0 ? 'inputs' : 'source');
        }
      }
    },
    [parsed, values, serverId, yamlText, validateInputs]
  );

  const handleParseAndAdvance = useCallback(async () => {
    setParseError(null);
    try {
      const result = await rpc.roomTemplates.parse({ yamlText });
      setParsed(result);

      // Pre-fill defaults
      const defaults: Record<string, string | number | boolean> = {};
      for (const param of result.params) {
        if (param.default !== null) {
          defaults[param.name] = param.default;
        } else if (param.type === 'boolean') {
          defaults[param.name] = false;
        } else {
          defaults[param.name] = '';
        }
      }
      setValues((prev) => ({ ...defaults, ...prev }));
      setFieldErrors({});
      setCreateError(null);

      if (result.params.length === 0) {
        // No params — go straight to create
        await handleCreate(result);
      } else {
        setStep('inputs');
      }
    } catch (e) {
      setParseError(failureText(e, 'Could not parse this template.'));
    }
  }, [yamlText, handleCreate]);

  const subtitle =
    step === 'source'
      ? 'Paste a room template or pick a YAML file.'
      : step === 'inputs'
        ? `Fill in the template parameters${parsed?.roomName ? ` for "${parsed.roomName}"` : ''}.`
        : 'Creating room…';

  return (
    <ServerPage title="Create from Template" description={subtitle}>
      {step === 'source' && (
        <SourceStep
          yamlText={yamlText}
          onYamlChange={setYamlText}
          parseError={parseError}
          onNext={handleParseAndAdvance}
        />
      )}

      {step === 'inputs' && parsed && (
        <>
          {parsed.warnings.map((w, i) => (
            <Alert key={i} className="mb-4">
              <AlertDescription>{w}</AlertDescription>
            </Alert>
          ))}
          {createError && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{createError}</AlertDescription>
            </Alert>
          )}
          <InputsStep
            params={parsed.params}
            values={values}
            onValuesChange={setValues}
            fieldErrors={fieldErrors}
            agentNames={agentNames}
            onBack={() => setStep('source')}
            onSubmit={() => handleCreate()}
          />
        </>
      )}

      {step === 'creating' && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-foreground-passive" />
          <span className="ml-2 text-sm text-foreground-passive">Creating room…</span>
        </div>
      )}
    </ServerPage>
  );
});

export const roomTemplateImportView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string }) => <>{children}</>,
  TitlebarSlot: TemplateImportTitlebar,
  MainPanel: TemplateImportPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return { ok: false, redirect: 'home' };
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string }>;
