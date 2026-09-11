import { ArrowRight, Check, Clock, FileText, Library, Loader2, Upload, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  ParamSpec,
  ParsedTemplate,
  RecentTemplate,
} from '@main/core/room-templates/controller';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
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
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { RpcError } from '@shared/lib/ipc/rpc-error';

type Step = 'source' | 'inputs' | 'creating';

/** Interpolate `{param}` and `{$builtin}` patterns with current form values. */
function interpolate(template: string, values: Record<string, string | number | boolean>): string {
  return template.replace(/\{(\$?\w+)\}/g, (match, key: string) => {
    const val = values[key];
    return val !== undefined && val !== '' ? String(val) : match;
  });
}

// ── Source step ─────────────────────────────────────────────────────────────

function readFileAsText(file: File, onText: (text: string) => void): void {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') onText(reader.result);
  };
  reader.readAsText(file);
}

// ── Recents / FTUE section ─────────────────────────────────────────────────

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function RecentsSection({
  serverId,
  onSelect,
}: {
  serverId: string;
  onSelect: (yamlText: string, name: string) => void;
}) {
  const [recents, setRecents] = useState<RecentTemplate[] | null>(null);

  useEffect(() => {
    rpc.roomTemplates
      .getRecents(serverId)
      .then(setRecents)
      .catch(() => setRecents([]));
  }, [serverId]);

  const handleLoadExample = useCallback(async () => {
    const yaml = await rpc.roomTemplates.getExampleTemplate();
    onSelect(yaml, 'red-blue-workroom.template.yaml');
  }, [onSelect]);

  if (recents === null) return null;

  return (
    <>
      <div className="border-t border-border pt-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium">
          <Clock className="size-3.5 text-foreground-muted" />
          Recently used templates
        </h3>

        {recents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center">
            <p className="text-sm text-foreground-muted">No templates used yet.</p>
            <p className="mt-1 text-sm text-foreground-muted">
              Try the{' '}
              <button
                type="button"
                onClick={handleLoadExample}
                className="text-primary hover:text-primary/80 underline underline-offset-2"
              >
                example template
              </button>{' '}
              to get started.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {recents.map((r, i) => (
              <div key={i} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onSelect(r.yamlText, r.name)}
                  className="hover:bg-accent flex flex-1 items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm transition-colors"
                >
                  <span className="flex items-center gap-2 truncate">
                    <FileText className="size-3.5 shrink-0 text-foreground-muted" />
                    {r.name}
                  </span>
                  <span className="shrink-0 text-xs text-foreground-passive">
                    {formatTimeAgo(r.usedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  title="Add to library"
                  onClick={(e) => {
                    e.stopPropagation();
                    rpc.switchServers
                      .addTemplateToLibrary({
                        serverId,
                        name: r.name,
                        content: r.yamlText,
                      })
                      .then(() => toast.success(`"${r.name}" added to library`))
                      .catch((err) => toast.error(failureText(err, 'Could not add to library')));
                  }}
                  className="hover:bg-accent shrink-0 rounded-md p-2 text-foreground-muted transition-colors hover:text-foreground"
                >
                  <Library className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function SourceStep({
  yamlText,
  onYamlChange,
  parseError,
  onNext,
  onFileSelect,
  serverId,
}: {
  yamlText: string;
  onYamlChange: (text: string) => void;
  parseError: string | null;
  onNext: () => void;
  onFileSelect: (name: string) => void;
  serverId: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      onFileSelect(file.name);
      readFileAsText(file, onYamlChange);
      e.target.value = '';
    },
    [onYamlChange, onFileSelect]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (!file) return;
      onFileSelect(file.name);
      readFileAsText(file, onYamlChange);
    },
    [onYamlChange, onFileSelect]
  );

  const handleRecentSelect = useCallback(
    (yaml: string, name: string) => {
      onFileSelect(name);
      onYamlChange(yaml);
    },
    [onYamlChange, onFileSelect]
  );

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel>Paste a room template</FieldLabel>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`rounded-md transition-colors ${dragging ? 'ring-primary ring-2' : ''}`}
          >
            <Textarea
              placeholder="Paste YAML here, or drag and drop a file…"
              value={yamlText}
              onChange={(e) => onYamlChange(e.target.value)}
              className="min-h-64 resize-y font-mono text-xs"
            />
          </div>
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
        <span className="text-xs text-foreground-passive">
          or paste YAML above, or drag and drop
        </span>
      </div>

      {parseError && (
        <Alert variant="destructive">
          <AlertDescription>{parseError}</AlertDescription>
        </Alert>
      )}

      <RecentsSection serverId={serverId} onSelect={handleRecentSelect} />

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

  // Long-text string param: a textarea, because a one-line input strips the
  // newlines out of a pasted brief.
  if (param.multiline) {
    return (
      <Field>
        <FieldLabel>
          {nameLabel}
          {labelSuffix && (
            <span className="ml-1 font-normal text-foreground-muted">{labelSuffix}</span>
          )}
          {isRequired && <span className="ml-1 text-destructive">*</span>}
        </FieldLabel>
        <Textarea
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-40 resize-y font-mono text-xs"
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
  creatorIdentity,
  bridgeName,
}: {
  parsed: ParsedTemplate;
  values: Record<string, string | number | boolean>;
  sourceName: string | null;
  /** How the signed-in user resolves on the template's bridge, or null. */
  creatorIdentity: string | null;
  /** The bridge the room will land on, when known. */
  bridgeName: string | null;
}) {
  const preview = (s: string) => interpolate(s, { ...values, $creator: creatorIdentity ?? 'you' });
  const roomNamePreview = parsed.roomName ? preview(parsed.roomName) : null;

  // Agent names with interpolation applied
  const agentPreviews = parsed.agents.map(preview).filter((a) => !a.includes('{'));
  const userPreviews = parsed.users.map(preview).filter((u) => !u.includes('{'));
  const kickoffPreview = parsed.kickoff ? preview(parsed.kickoff) : null;

  const steps: React.ReactNode[] = [];
  if (roomNamePreview) {
    steps.push(
      <span>
        Room <strong>{roomNamePreview}</strong>
        {bridgeName ? (
          <>
            {' '}
            with its channel on <strong>{bridgeName}</strong>
          </>
        ) : null}
      </span>
    );
  }
  steps.push(<span>Instructions filled with your inputs</span>);
  for (const agent of agentPreviews) {
    steps.push(
      <span>
        Agent <strong>{agent}</strong> added as member
      </span>
    );
  }
  for (const user of userPreviews) {
    steps.push(
      <span>
        {creatorIdentity !== null && user === creatorIdentity ? (
          <>
            <strong>You</strong> invited as <strong>{user}</strong>
          </>
        ) : (
          <>
            <strong>{user}</strong> invited to the channel
          </>
        )}
      </span>
    );
  }
  if (kickoffPreview) {
    steps.push(<span>A kickoff message, posted as you, starts the agents</span>);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-border p-5">
        <h3 className="mb-3 text-sm font-semibold">What this creates</h3>
        <ol className="space-y-2 text-sm">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded border border-border text-xs">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-foreground-muted">Nothing else. One room, from one file.</p>
      </div>

      {parsed.usesCreator && (
        <div className="rounded-lg border border-border p-4">
          <h4 className="mb-1 text-xs font-semibold text-foreground-muted">You in this room</h4>
          {creatorIdentity ? (
            <p className="text-sm">
              The server knows you{bridgeName ? ` on ${bridgeName}` : ''} as{' '}
              <strong>{creatorIdentity}</strong> <Check className="inline size-3" />
            </p>
          ) : (
            <p className="text-sm text-amber-500">
              This template includes you, but you haven't linked your messaging account on this
              server. The server will try to match your account name; if that fails you won't be
              invited and the kickoff can't be posted. Link your account under the server's
              Identities settings first.
            </p>
          )}
        </div>
      )}

      {kickoffPreview && (
        <div className="rounded-lg border border-border p-4">
          <h4 className="mb-1 text-xs font-semibold text-foreground-muted">Kickoff message</h4>
          <pre className="max-h-40 overflow-y-auto text-xs whitespace-pre-wrap text-foreground-muted">
            {kickoffPreview}
          </pre>
        </div>
      )}

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

// ── Editable name list ─────────────────────────────────────────────────────

function EditableNameList({
  label,
  helperText,
  items,
  onChange,
  knownNames,
  nameKind,
  missingLabel = 'not found',
}: {
  label: string;
  helperText: string;
  items: string[];
  onChange: (items: string[]) => void;
  knownNames: string[];
  nameKind: string;
  missingLabel?: string;
}) {
  if (items.length === 0) return null;
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="space-y-1.5">
        {items.map((item, i) => {
          const exists = knownNames.includes(item);
          return (
            <div key={i} className="flex items-center gap-2">
              <div className="relative flex-1">
                <Input value={item} readOnly className="pr-24" />
                <span
                  className={`absolute top-1/2 right-2.5 -translate-y-1/2 text-xs ${
                    exists ? 'text-foreground-muted' : 'text-amber-500'
                  }`}
                >
                  {exists ? (
                    <>
                      exists <Check className="inline size-3" />
                    </>
                  ) : (
                    missingLabel
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="flex size-8 shrink-0 items-center justify-center rounded text-foreground-muted hover:text-destructive"
                title={`Remove ${nameKind}`}
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-foreground-muted">{helperText}</p>
    </Field>
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
  editedAgents,
  onEditedAgentsChange,
  editedUsers,
  onEditedUsersChange,
  knownUserNames,
  creatorIdentity,
  bridgeName,
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
  editedAgents: string[];
  onEditedAgentsChange: (agents: string[]) => void;
  editedUsers: string[];
  onEditedUsersChange: (users: string[]) => void;
  knownUserNames: string[];
  creatorIdentity: string | null;
  bridgeName: string | null;
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
          <EditableNameList
            label="Agents"
            helperText="Pre-configured agents from the template. Remove any that don't exist on this server."
            items={editedAgents}
            onChange={onEditedAgentsChange}
            knownNames={agentNames}
            nameKind="agent"
          />
          <EditableNameList
            label="Users"
            helperText="Pre-configured users from the template. Names the server hasn't seen yet are still looked up in the platform's directory when the room is created."
            items={editedUsers}
            onChange={onEditedUsersChange}
            knownNames={knownUserNames}
            nameKind="user"
            missingLabel="not seen yet"
          />
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
        <SummaryPanel
          parsed={parsed}
          values={values}
          sourceName={sourceName}
          creatorIdentity={creatorIdentity}
          bridgeName={bridgeName}
        />
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
  const [templateSchema, setTemplateSchema] = useState<Record<string, unknown> | null>(null);
  const [editedAgents, setEditedAgents] = useState<string[]>([]);
  const [editedUsers, setEditedUsers] = useState<string[]>([]);
  const [bridges, setBridges] = useState<RemoteBridge[]>([]);
  const [myIdentities, setMyIdentities] = useState<LinkedIdentity[]>([]);
  const [knownUserNames, setKnownUserNames] = useState<string[]>([]);

  useEffect(() => {
    rpc.switchServers
      .fetchTemplateSchema(serverId)
      .then(setTemplateSchema)
      .catch(() => {});
    rpc.switchServers
      .listRemoteBridges(serverId)
      .then(setBridges)
      .catch(() => {});
    rpc.switchServers
      .listMyIdentities(serverId)
      .then(setMyIdentities)
      .catch(() => {});
    rpc.switchServers
      .listRemoteExternalUsers(serverId)
      .then((users) => setKnownUserNames(users.map((u) => u.username)))
      .catch(() => {});
  }, [serverId]);

  // The bridge the room will land on: the one the template names, else the
  // server's default — which is what the server itself falls back to.
  const templateBridge = useMemo(() => {
    if (parsed?.bridge) {
      return bridges.find((b) => b.displayName === parsed.bridge) ?? null;
    }
    return bridges.find((b) => b.isDefault) ?? (bridges.length === 1 ? bridges[0] : null);
  }, [bridges, parsed]);

  // How the signed-in user resolves on that bridge — what `{$creator}`
  // becomes, and whether the kickoff can be posted as them.
  const creatorIdentity = useMemo(() => {
    if (templateBridge) {
      return myIdentities.find((i) => i.bridgeId === templateBridge.id)?.externalUsername ?? null;
    }
    return myIdentities[0]?.externalUsername ?? null;
  }, [myIdentities, templateBridge]);

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

        // Rewrite YAML with the user's edited agents/users lists. Entries
        // still carrying `{...}` (params and `{$creator}`) are not editable
        // in the form and must survive the rewrite for the server to resolve.
        const interpolatedAgents = t.agents.filter((a) => /\{[^}]+\}/.test(a));
        const finalAgents = [...interpolatedAgents, ...editedAgents];
        const interpolatedUsers = t.users.filter((u) => /\{[^}]+\}/.test(u));
        const finalUsers = [...interpolatedUsers, ...editedUsers];
        const finalYaml = await rpc.roomTemplates.rewriteYaml({
          yamlText,
          agents: finalAgents,
          users: finalUsers,
        });

        const result = await rpc.switchServers.createRoomFromTemplate(serverId, finalYaml, inputs);

        // Save to recents on success
        const recentName = sourceName ?? t.roomName ?? 'Untitled template';
        rpc.roomTemplates.saveRecent({ serverId, name: recentName, yamlText }).catch(() => {});

        await refreshSidebarRoomState(true);
        if (result.failedAttachments.length > 0) {
          const names = result.failedAttachments.map((f) => `${f.id} (${f.error})`).join(', ');
          toast.warning('Room created, but some items could not be added', {
            description: names,
            duration: 8000,
          });
        }
        appState.navigation.navigate('room', { roomId: result.roomId });
      } catch (e) {
        const serverDetail =
          e instanceof RpcError && e.code === 'GatewayError' ? e.stringField('detail') : undefined;
        const message =
          serverDetail ?? failureText(e, 'Could not create the room from this template.');
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
    [parsed, values, serverId, yamlText, validateInputs, editedAgents, editedUsers, sourceName]
  );

  const handleParseAndAdvance = useCallback(async () => {
    setParseError(null);
    try {
      const result = await rpc.roomTemplates.parse({
        yamlText,
        schema: templateSchema ?? undefined,
      });
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
      setEditedAgents(result.hardcodedAgents);
      setEditedUsers(result.hardcodedUsers);
      setFieldErrors({});
      setCreateError(null);

      const hasForm =
        result.params.length > 0 ||
        result.hardcodedAgents.length > 0 ||
        result.hardcodedUsers.length > 0;
      if (!hasForm) {
        await handleCreate(result);
      } else {
        setStep('inputs');
      }
    } catch (e) {
      setParseError(failureText(e, 'Could not parse this template.'));
    }
  }, [yamlText, handleCreate, templateSchema]);

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
          serverId={serverId}
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
            editedAgents={editedAgents}
            onEditedAgentsChange={setEditedAgents}
            editedUsers={editedUsers}
            onEditedUsersChange={setEditedUsers}
            knownUserNames={knownUserNames}
            creatorIdentity={creatorIdentity}
            bridgeName={templateBridge?.displayName ?? parsed.bridge}
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
