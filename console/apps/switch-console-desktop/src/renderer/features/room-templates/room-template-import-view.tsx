import { ArrowRight, Check, FileText, Loader2, Upload } from 'lucide-react';
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

/** Interpolate `{param}` patterns in a string with current form values. */
function interpolate(template: string, values: Record<string, string | number | boolean>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const val = values[key];
    return val !== undefined && val !== '' ? String(val) : match;
  });
}

// ── Source step ─────────────────────────────────────────────────────────────

function SourceStep({
  yamlText,
  onYamlChange,
  parseError,
  onNext,
  onFileSelect,
}: {
  yamlText: string;
  onYamlChange: (text: string) => void;
  parseError: string | null;
  onNext: () => void;
  onFileSelect: (name: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      onFileSelect(file.name);
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') onYamlChange(reader.result);
      };
      reader.readAsText(file);
      e.target.value = '';
    },
    [onYamlChange, onFileSelect]
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

// ── Param field ────────────────────────────────────────────────────────────

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
  const isRequired = param.default === null;
  const hasDefault = param.default !== null;
  const defaultKept = hasDefault && value === param.default;

  // Label: param name (humanized) + default annotation
  const nameLabel = param.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const labelSuffix = defaultKept ? ' (default kept)' : '';

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
          <span className="text-sm font-medium">
            {nameLabel}
            {isRequired && <span className="ml-1 text-destructive">*</span>}
          </span>
        </label>
        {param.description && (
          <p className="mt-1 text-xs text-foreground-muted">{param.description}</p>
        )}
      </Field>
    );
  }

  if (param.type === 'enum' && param.enum) {
    return (
      <Field>
        <FieldLabel>
          {nameLabel}
          {labelSuffix && (
            <span className="ml-1 font-normal text-foreground-muted">{labelSuffix}</span>
          )}
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
        {param.description && (
          <p className="mt-1 text-xs text-foreground-muted">{param.description}</p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </Field>
    );
  }

  if (param.type === 'number') {
    return (
      <Field>
        <FieldLabel>
          {nameLabel}
          {labelSuffix && (
            <span className="ml-1 font-normal text-foreground-muted">{labelSuffix}</span>
          )}
          {isRequired && <span className="ml-1 text-destructive">*</span>}
        </FieldLabel>
        <Input
          type="number"
          value={value === '' ? '' : Number(value)}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          aria-invalid={error ? true : undefined}
        />
        {param.description && (
          <p className="mt-1 text-xs text-foreground-muted">{param.description}</p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </Field>
    );
  }

  // String field — with inline agent validation
  const strVal = typeof value === 'string' ? value.trim() : '';
  const agentMatch = param.isAgentName && strVal !== '' ? agentNames.includes(strVal) : null;

  return (
    <Field>
      <FieldLabel>
        {nameLabel}
        {labelSuffix && (
          <span className="ml-1 font-normal text-foreground-muted">{labelSuffix}</span>
        )}
        {isRequired && <span className="ml-1 text-destructive">*</span>}
      </FieldLabel>
      <div className="relative">
        <Input
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={param.isAgentName ? 'Agent' : undefined}
          aria-invalid={error || agentMatch === false ? true : undefined}
          list={param.isAgentName ? `agents-${param.name}` : undefined}
          className={param.isAgentName ? 'pr-36' : undefined}
        />
        {param.isAgentName && strVal !== '' && (
          <span
            className={`absolute top-1/2 right-2.5 -translate-y-1/2 text-xs ${
              agentMatch ? 'text-foreground-muted' : 'text-amber-500'
            }`}
          >
            {agentMatch ? (
              <>
                {strVal} · exists <Check className="inline size-3" />
              </>
            ) : (
              `not found`
            )}
          </span>
        )}
        {param.isAgentName && (
          <datalist id={`agents-${param.name}`}>
            {agentNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
      </div>
      {param.description && (
        <p className="mt-1 text-xs text-foreground-muted">{param.description}</p>
      )}
      {param.isAgentName && (
        <p className="mt-0.5 text-xs text-foreground-muted">
          Must be an existing agent — resolved against this server's agent list.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </Field>
  );
}

// ── Summary panel ──────────────────────────────────────────────────────────

function SummaryPanel({
  parsed,
  values,
  sourceName,
}: {
  parsed: ParsedTemplate;
  values: Record<string, string | number | boolean>;
  sourceName: string | null;
}) {
  const roomNamePreview = parsed.roomName ? interpolate(parsed.roomName, values) : null;

  // Agent names with interpolation applied
  const agentPreviews = parsed.agents
    .map((a) => interpolate(a, values))
    .filter((a) => !a.includes('{'));

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-border p-5">
        <h3 className="mb-3 text-sm font-semibold">What this creates</h3>
        <ol className="space-y-2 text-sm">
          {roomNamePreview && (
            <li className="flex items-start gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded border border-border text-xs">
                1
              </span>
              <span>
                Room <strong>{roomNamePreview}</strong>
              </span>
            </li>
          )}
          <li className="flex items-start gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded border border-border text-xs">
              {roomNamePreview ? 2 : 1}
            </span>
            <span>Instructions filled with your inputs</span>
          </li>
          {agentPreviews.map((agent, i) => (
            <li key={agent} className="flex items-start gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded border border-border text-xs">
                {(roomNamePreview ? 3 : 2) + i}
              </span>
              <span>
                <strong>{agent}</strong> added as member
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-foreground-muted">Nothing else. One room, from one file.</p>
      </div>

      <div className="rounded-lg border border-border p-4">
        <h4 className="mb-1 text-xs font-semibold text-foreground-muted">Template source</h4>
        <p className="text-sm font-medium">{sourceName ?? 'pasted template'}</p>
        <p className="text-xs text-foreground-muted">
          {sourceName ? 'file' : 'pasted'} · {parsed.params.length} param
          {parsed.params.length !== 1 ? 's' : ''} · valid{' '}
          <Check className="inline size-3 text-foreground-muted" />
        </p>
      </div>
    </div>
  );
}

// ── Inputs step ────────────────────────────────────────────────────────────

function InputsStep({
  parsed,
  values,
  onValuesChange,
  fieldErrors,
  agentNames,
  onBack,
  onSubmit,
  sourceName,
  createError,
}: {
  parsed: ParsedTemplate;
  values: Record<string, string | number | boolean>;
  onValuesChange: (values: Record<string, string | number | boolean>) => void;
  fieldErrors: Record<string, string>;
  agentNames: string[];
  onBack: () => void;
  onSubmit: () => void;
  sourceName: string | null;
  createError: string | null;
}) {
  const handleChange = useCallback(
    (name: string, value: string | number | boolean) => {
      onValuesChange({ ...values, [name]: value });
    },
    [values, onValuesChange]
  );

  return (
    <div className="flex gap-8">
      {/* Left: form */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {createError && (
          <Alert variant="destructive">
            <AlertDescription>{createError}</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          {parsed.params.map((param) => (
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
        <div className="flex flex-col gap-2 pt-2">
          <Button variant="outline" className="w-full" onClick={onBack}>
            Back to template
          </Button>
          <Button className="w-full" onClick={onSubmit}>
            Create room
          </Button>
        </div>
      </div>

      {/* Right: summary */}
      <div className="hidden w-80 shrink-0 lg:block">
        <SummaryPanel parsed={parsed} values={values} sourceName={sourceName} />
      </div>
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────────────────

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
  const [sourceName, setSourceName] = useState<string | null>(null);

  const validateInputs = useCallback((): boolean => {
    if (!parsed) return false;
    const errors: Record<string, string> = {};
    for (const param of parsed.params) {
      const val = values[param.name];
      if (param.default === null) {
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
        await handleCreate(result);
      } else {
        setStep('inputs');
      }
    } catch (e) {
      setParseError(failureText(e, 'Could not parse this template.'));
    }
  }, [yamlText, handleCreate]);

  const stepNumber = step === 'source' ? 1 : 2;
  const totalSteps = 2;

  const subtitle =
    step === 'source'
      ? 'Paste a room template or pick a YAML file.'
      : `${sourceName ?? 'template'} — ${parsed?.params.length ?? 0} input${(parsed?.params.length ?? 0) !== 1 ? 's' : ''}. The room is created only when you hit Create.`;

  return (
    <ServerPage
      title="Create from template"
      description={subtitle}
      action={
        <span className="text-xs text-foreground-muted">
          Step {stepNumber} of {totalSteps}
        </span>
      }
    >
      {step === 'source' && (
        <SourceStep
          yamlText={yamlText}
          onYamlChange={setYamlText}
          parseError={parseError}
          onNext={handleParseAndAdvance}
          onFileSelect={setSourceName}
        />
      )}

      {step === 'inputs' && parsed && (
        <>
          {parsed.warnings.map((w, i) => (
            <Alert key={i} className="mb-4">
              <AlertDescription>{w}</AlertDescription>
            </Alert>
          ))}
          <InputsStep
            parsed={parsed}
            values={values}
            onValuesChange={setValues}
            fieldErrors={fieldErrors}
            agentNames={agentNames}
            onBack={() => setStep('source')}
            onSubmit={() => handleCreate()}
            sourceName={sourceName}
            createError={createError}
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
