import Editor from '@monaco-editor/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, FileText, Loader2, Save, Upload } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ParamSpec, ParsedTemplate } from '@main/core/room-templates/controller';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { agentTemplateDataFromContent } from '@renderer/features/templates/agent-template-data';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useModalContext } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { remoteAgentsQueryKey, useRemoteAgents } from '@renderer/lib/stores/use-remote-agents';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';
import { isEntityParamType } from '@shared/core/switch-servers/room-template-params';
import { RpcError } from '@shared/lib/ipc/rpc-error';
import { type BlockedHandoff, blockedHandoffs } from './agent-handoff';
import {
  AgentField,
  AgentListField,
  BridgeField,
  type EntityLists,
  RoomField,
  UserField,
  UserListField,
} from './entity-fields';

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

function SourceStep({
  yamlText,
  onYamlChange,
  parseError,
  onNext,
  onFileSelect,
  onSaveToServer,
  saving,
}: {
  yamlText: string;
  onYamlChange: (text: string) => void;
  parseError: string | null;
  onNext: () => void;
  onFileSelect: (name: string) => void;
  onSaveToServer: () => void;
  saving: boolean;
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

  // Auto-expand: 18px per line, min 256px, max 600px
  const lineCount = Math.max(yamlText.split('\n').length, 1);
  const editorHeight = Math.min(Math.max(lineCount * 18 + 20, 256), 600);

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel>Paste a template</FieldLabel>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`overflow-hidden rounded-md border border-border transition-colors ${dragging ? 'ring-primary ring-2' : ''}`}
          >
            <Editor
              height={editorHeight}
              language="yaml"
              theme="vs-dark"
              value={yamlText}
              onChange={(v) => onYamlChange(v ?? '')}
              options={{
                minimap: { enabled: false },
                lineNumbers: 'on',
                folding: true,
                tabSize: 2,
                fontSize: 13,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                renderLineHighlight: 'none',
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
                scrollbar: { vertical: 'auto', horizontal: 'auto' },
              }}
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
          or paste YAML above, or drag and drop, or start from the{' '}
          <button
            type="button"
            onClick={() => {
              void rpc.roomTemplates.getExampleTemplate().then((yaml) => {
                onFileSelect('red-blue-workroom.template.yaml');
                onYamlChange(yaml);
              });
            }}
            className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          >
            example room template
          </button>
        </span>
      </div>

      {parseError && (
        <Alert variant="destructive">
          <AlertDescription>{parseError}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="outline" disabled={!yamlText.trim() || saving} onClick={onSaveToServer}>
          <Save className="mr-1.5 size-3.5" />
          {saving ? 'Saving…' : 'Save to server'}
        </Button>
        <Button disabled={!yamlText.trim() || saving} onClick={onNext}>
          Next
          <ArrowRight className="ml-1.5 size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Param field ────────────────────────────────────────────────────────────

/** The label, description and error every param field shares, around
 * whatever control the param's type calls for. */
function ParamFieldShell({
  param,
  value,
  error,
  children,
}: {
  param: ParamSpec;
  value: string | number | boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  const isRequired = param.default === null;
  const defaultKept = param.default !== null && value === param.default;
  // Label: param name (humanized) + default annotation
  const nameLabel = param.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <Field>
      <FieldLabel>
        {nameLabel}
        {defaultKept && (
          <span className="ml-1 font-normal text-foreground-muted">(default kept)</span>
        )}
        {isRequired && <span className="ml-1 text-destructive">*</span>}
      </FieldLabel>
      {children}
      {param.description && (
        <p className="mt-1 text-xs text-foreground-muted">{param.description}</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </Field>
  );
}

function ParamField({
  param,
  value,
  onChange,
  error,
  lists,
}: {
  param: ParamSpec;
  value: string | number | boolean;
  onChange: (v: string | number | boolean) => void;
  error: string | null;
  lists: EntityLists;
}) {
  if (param.type === 'boolean') {
    const isRequired = param.default === null;
    const nameLabel = param.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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

  // Entity-typed params pick from what the server has, the same way the
  // new-room dialog does; the value is the entity's name as the template
  // would spell it, and the server checks it again on create.
  if (isEntityParamType(param.type)) {
    const strVal = typeof value === 'string' ? value : String(value ?? '');
    const control =
      param.type === 'agent' ? (
        <AgentField value={strVal} onChange={onChange} lists={lists} />
      ) : param.type === 'room' ? (
        <RoomField value={strVal} onChange={onChange} lists={lists} />
      ) : param.type === 'bridge' ? (
        <BridgeField value={strVal} onChange={onChange} lists={lists} />
      ) : (
        <UserField value={strVal} onChange={onChange} lists={lists} />
      );
    return (
      <ParamFieldShell param={param} value={value} error={error}>
        {control}
      </ParamFieldShell>
    );
  }

  if (param.type === 'enum' && param.enum) {
    return (
      <ParamFieldShell param={param} value={value} error={error}>
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
      </ParamFieldShell>
    );
  }

  if (param.type === 'number') {
    return (
      <ParamFieldShell param={param} value={value} error={error}>
        <Input
          type="number"
          value={value === '' ? '' : Number(value)}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          aria-invalid={error ? true : undefined}
        />
      </ParamFieldShell>
    );
  }

  // Long-text string param: a textarea, because a one-line input strips the
  // newlines out of a pasted brief.
  if (param.multiline) {
    return (
      <ParamFieldShell param={param} value={value} error={error}>
        <Textarea
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-40 resize-y font-mono text-xs"
          aria-invalid={error ? true : undefined}
        />
      </ParamFieldShell>
    );
  }

  return (
    <ParamFieldShell param={param} value={value} error={error}>
      <Input
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
      />
    </ParamFieldShell>
  );
}

// ── Summary panel ──────────────────────────────────────────────────────────

function SummaryPanel({
  parsed,
  values,
  sourceName,
  creatorIdentity,
  bridgeName,
  onLinkAccount,
}: {
  parsed: ParsedTemplate;
  values: Record<string, string | number | boolean>;
  sourceName: string | null;
  /** How the signed-in user resolves on the template's bridge, or null. */
  creatorIdentity: string | null;
  /** The bridge the room will land on, when known. */
  bridgeName: string | null;
  /** Opens the link-account flow for the template's bridge; null when the
   * bridge is not known, so there is nothing to link to yet. */
  onLinkAccount: (() => void) | null;
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
    steps.push(<span>Switch posts the kickoff on your behalf to start the agents</span>);
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
            <div className="flex flex-col gap-2">
              <p className="text-sm text-amber-600 dark:text-amber-500">
                This template puts you in the room, and the server does not know which account is
                yours{bridgeName ? ` on ${bridgeName}` : ''}. Link it first; the room cannot be
                created until then, or you would end up with a channel you cannot enter.
              </p>
              {onLinkAccount ? (
                <Button variant="outline" size="sm" className="self-start" onClick={onLinkAccount}>
                  Link your account
                </Button>
              ) : (
                <p className="text-xs text-foreground-muted">
                  Pick the messaging app first, then link your account there.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {kickoffPreview && (
        <div className="rounded-lg border border-border p-4">
          <h4 className="mb-1 text-xs font-semibold text-foreground-muted">Kickoff message</h4>
          <p className="mb-2 text-xs text-foreground-muted">
            Posted by Switch on your behalf: a one-line headline in the channel, with this text in
            its thread. Each agent it mentions checks whether you may address it, the same as if you
            had typed it, and answers in that thread.
          </p>
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

// ── Inputs step ────────────────────────────────────────────────────────────

function InputsStep({
  parsed,
  values,
  onValuesChange,
  fieldErrors,
  lists,
  onBack,
  onSubmit,
  sourceName,
  createError,
  editedAgents,
  onEditedAgentsChange,
  editedUsers,
  onEditedUsersChange,
  creatorIdentity,
  bridgeName,
  creatorBlocked,
  onLinkAccount,
  handoffBlocked,
  onAllowHandoffs,
  allowingHandoffs,
}: {
  parsed: ParsedTemplate;
  values: Record<string, string | number | boolean>;
  onValuesChange: (values: Record<string, string | number | boolean>) => void;
  fieldErrors: Record<string, string>;
  lists: EntityLists;
  onBack: () => void;
  onSubmit: () => void;
  sourceName: string | null;
  createError: string | null;
  editedAgents: string[];
  onEditedAgentsChange: (agents: string[]) => void;
  editedUsers: string[];
  onEditedUsersChange: (users: string[]) => void;
  creatorIdentity: string | null;
  bridgeName: string | null;
  /** The template needs the creator's account on the bridge and none is linked. */
  creatorBlocked: boolean;
  onLinkAccount: (() => void) | null;
  /** Agents in this room that will not hear each other. */
  handoffBlocked: BlockedHandoff[];
  /** Widen the blocked agents' policies so the hand-offs go through. */
  onAllowHandoffs: () => void;
  allowingHandoffs: boolean;
}) {
  // The template's fixed members are editable only when it has any: a
  // template that names no agents gets no empty "Agents" section to puzzle
  // over, the same way the params list only shows what is declared.
  const showAgents = parsed.hardcodedAgents.length > 0 || editedAgents.length > 0;
  const showUsers = parsed.hardcodedUsers.length > 0 || editedUsers.length > 0;

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
        {handoffBlocked.length > 0 && (
          <Alert>
            <AlertDescription>
              <div className="flex flex-col gap-2">
                <span>
                  These agents will not hear each other:{' '}
                  {handoffBlocked.map((b) => `${b.to} ignores ${b.from}`).join(', ')}. An agent
                  created from the Console answers only its owner, so the hand-offs in this template
                  would bounce.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={allowingHandoffs}
                  onClick={onAllowHandoffs}
                >
                  {allowingHandoffs ? 'Updating…' : 'Let them hear each other'}
                </Button>
              </div>
            </AlertDescription>
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
              lists={lists}
            />
          ))}
          {showAgents && (
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel>Agents</FieldLabel>
                {editedAgents.length > 0 && (
                  <span className="text-sm text-foreground-muted">{editedAgents.length} added</span>
                )}
              </div>
              <AgentListField items={editedAgents} onChange={onEditedAgentsChange} lists={lists} />
              <p className="mt-1 text-xs text-foreground-muted">
                Agents the template puts in the room. Drop any the server does not have, or add
                more.
              </p>
            </Field>
          )}
          {showUsers && (
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel>Users</FieldLabel>
                {editedUsers.length > 0 && (
                  <span className="text-sm text-foreground-muted">{editedUsers.length} added</span>
                )}
              </div>
              <UserListField items={editedUsers} onChange={onEditedUsersChange} lists={lists} />
              <p className="mt-1 text-xs text-foreground-muted">
                People the template invites. A name the server has not seen is looked up in the
                messaging app&apos;s directory when the room is created.
              </p>
            </Field>
          )}
        </FieldGroup>
        <div className="flex flex-col gap-2 pt-2">
          <Button variant="outline" className="w-full" onClick={onBack}>
            Back to template
          </Button>
          <Button className="w-full" onClick={onSubmit} disabled={creatorBlocked}>
            Create room
          </Button>
          {creatorBlocked && (
            <p className="text-center text-xs text-foreground-muted">
              Link your messaging account first, on the right.
            </p>
          )}
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
          onLinkAccount={onLinkAccount}
        />
      </div>
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────────────────

function useServerId(): string {
  return useParams('templateImport').params.serverId;
}

/** Whether a document is an agent template: the top-level key says so. */
function looksLikeAgentTemplate(yamlText: string): boolean {
  return /^agent:\s*$/m.test(yamlText) || /^agent:\s+\S/m.test(yamlText);
}

const TemplateImportTitlebar = observer(function TemplateImportTitlebar() {
  const serverId = useServerId();
  return (
    <ServerSectionTitlebar
      serverId={serverId}
      icon={FileText}
      label="Templates"
      item={{ label: 'Import' }}
      onSectionClick={() => appState.navigation.navigate('templates', { serverId })}
    />
  );
});

const TemplateImportPanel = observer(function TemplateImportPanel() {
  const serverId = useServerId();
  const agents = useRemoteAgents(serverId);
  const roomsQuery = useQuery({
    queryKey: ['remote-rooms', serverId],
    queryFn: () => rpc.switchServers.listRemoteRooms(serverId),
  });
  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId),
  });
  const knownUsersQuery = useQuery({
    queryKey: ['remote-external-users', serverId],
    queryFn: () => rpc.switchServers.listRemoteExternalUsers(serverId),
  });
  // Null from a server without the endpoint: the parser then falls back to
  // its own shape check and the server validates on create.
  const schemaQuery = useQuery({
    queryKey: ['template-schema', serverId],
    queryFn: () => rpc.switchServers.fetchTemplateSchema(serverId),
  });
  const { identities, refresh: refreshIdentities } = useMyIdentities(serverId);
  const { showModal } = useModalContext();
  const bridges = useMemo(() => bridgesQuery.data ?? [], [bridgesQuery.data]);
  const templateSchema = schemaQuery.data ?? null;

  const {
    yamlText: initialYaml,
    sourceName: initialName,
    templateId: initialTemplateId,
  } = useParams('templateImport').params;
  const [step, setStep] = useState<Step>('source');
  const [yamlText, setYamlText] = useState(initialYaml ?? '');
  const [saving, setSaving] = useState(false);
  const [parsed, setParsed] = useState<ParsedTemplate | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(initialName ?? null);
  const [editedAgents, setEditedAgents] = useState<string[]>([]);
  const [editedUsers, setEditedUsers] = useState<string[]>([]);

  // The bridge the room will land on: what a bridge-typed param has been set
  // to, else the one the template names, else the server's default, which is
  // what the server itself falls back to. Following the param means the
  // summary and the creator identity move with the pick.
  const templateBridge = useMemo(() => {
    const bridgeParam = parsed?.params.find((p) => p.type === 'bridge');
    const picked = bridgeParam ? String(values[bridgeParam.name] ?? '') : '';
    const named = picked !== '' ? picked : (parsed?.bridge ?? null);
    if (named) {
      return bridges.find((b) => b.displayName === named) ?? null;
    }
    return bridges.find((b) => b.isDefault) ?? (bridges.length === 1 ? bridges[0] : null);
  }, [bridges, parsed, values]);

  // How the signed-in user resolves on that bridge: what `{$creator}`
  // becomes.
  const creatorIdentity = useMemo(() => {
    if (identities === null) return null;
    if (templateBridge) {
      return identities.find((i) => i.bridgeId === templateBridge.id)?.externalUsername ?? null;
    }
    return identities[0]?.externalUsername ?? null;
  }, [identities, templateBridge]);

  // The server refuses a template that needs the creator on the bridge when
  // no account is linked; saying so here, with the fix one click away, beats
  // a rejected create. Unknown identities (still loading) do not block.
  const creatorBlocked =
    parsed?.usesCreator === true && identities !== null && creatorIdentity === null;
  const onLinkAccount = useMemo(() => {
    if (!templateBridge) return null;
    return () =>
      showModal('claimIdentityModal', {
        serverId,
        bridgeId: templateBridge.id,
        onSuccess: () => refreshIdentities(),
      });
  }, [templateBridge, serverId, showModal, refreshIdentities]);

  // Every agent the room will hold: the template's fixed ones as edited, and
  // whatever the agent-typed params have been set to.
  const handoffBlocked = useMemo(() => {
    if (!parsed) return [];
    const names = new Set<string>(editedAgents);
    for (const param of parsed.params) {
      if (param.type === 'agent') {
        const v = values[param.name];
        if (typeof v === 'string' && v !== '') names.add(v);
      }
    }
    const inRoom = (agents.data ?? []).filter((a) => names.has(a.name));
    return blockedHandoffs(inRoom);
  }, [parsed, editedAgents, values, agents.data]);

  // The template implies these agents talk to each other, so the fix is
  // offered here rather than found later in each agent's settings. Same
  // owner gets "my agents" on every rule; a stranger is named outright.
  const queryClient = useQueryClient();
  const [allowingHandoffs, setAllowingHandoffs] = useState(false);
  const allowHandoffs = useCallback(async () => {
    const byName = new Map((agents.data ?? []).map((a) => [a.name, a]));
    setAllowingHandoffs(true);
    try {
      const targets = new Set(handoffBlocked.map((b) => b.to));
      for (const targetName of targets) {
        const target = byName.get(targetName);
        if (!target) continue;
        const sources = handoffBlocked
          .filter((b) => b.to === targetName)
          .map((b) => byName.get(b.from))
          .filter((a): a is NonNullable<typeof a> => a !== undefined);
        const rules = (target.addressingPolicy?.rules ?? []).map((rule) => {
          const next = { ...rule };
          for (const source of sources) {
            if (target.ownerId !== null && source.ownerId === target.ownerId) {
              next.owner_agents = true;
            } else if (next.agents !== '*' && !next.agents.includes(source.id)) {
              next.agents = [...next.agents, source.id];
            }
          }
          return next;
        });
        await rpc.switchServers.updateAddressingPolicy({
          serverId,
          agentId: target.id,
          policy: { rules },
        });
      }
      await queryClient.invalidateQueries({ queryKey: remoteAgentsQueryKey(serverId) });
    } catch (e) {
      toast.error(failureText(e, 'Could not update the agents.'));
    } finally {
      setAllowingHandoffs(false);
    }
  }, [agents.data, handoffBlocked, serverId, queryClient]);

  const lists = useMemo(
    (): EntityLists => ({
      serverId,
      agents: agents.data ?? [],
      agentsLoading: agents.isLoading,
      rooms: roomsQuery.data ?? [],
      roomsLoading: roomsQuery.isLoading,
      bridges,
      identities,
      knownUsers: knownUsersQuery.data ?? [],
      bridgeId: templateBridge?.id ?? null,
    }),
    [
      serverId,
      agents.data,
      agents.isLoading,
      roomsQuery.data,
      roomsQuery.isLoading,
      bridges,
      identities,
      knownUsersQuery.data,
      templateBridge,
    ]
  );

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
        // Remembered here, after it worked: a document that failed is not
        // one to offer again.
        rpc.roomTemplates
          .saveRecent({
            serverId,
            name: sourceName ?? t.roomName ?? 'Untitled template',
            yamlText,
          })
          .catch(() => {});
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
    [parsed, values, serverId, yamlText, validateInputs, editedAgents, editedUsers]
  );

  const handleParseAndAdvance = useCallback(async () => {
    setParseError(null);
    // An agent document does not go through the room steps: the add-agent
    // dialog is its second step, prefilled from it.
    if (looksLikeAgentTemplate(yamlText)) {
      try {
        const template = await agentTemplateDataFromContent(
          sourceName?.replace(/(\.template)?\.ya?ml$/i, '') ?? 'Pasted template',
          yamlText,
          null,
          null
        );
        rpc.roomTemplates
          .saveRecent({
            serverId,
            name: sourceName ?? template.agentName ?? 'Agent template',
            yamlText,
          })
          .catch(() => {});
        showModal('addAgentModal', { entryPoint: 'server_page', template });
      } catch (e) {
        setParseError(failureText(e, 'Could not parse this agent template.'));
      }
      return;
    }
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
  }, [yamlText, handleCreate, templateSchema, serverId, sourceName, showModal]);

  // Either kind, straight from the first step: the server keeps it under the
  // document's own name, and the listing shows it to everyone on the server.
  const handleSaveToServer = useCallback(async () => {
    setSaving(true);
    setParseError(null);
    try {
      const isAgent = looksLikeAgentTemplate(yamlText);
      let name = sourceName?.replace(/(\.template)?\.ya?ml$/i, '') ?? null;
      let description = '';
      if (isAgent) {
        const t = await agentTemplateDataFromContent(
          name ?? 'Agent template',
          yamlText,
          null,
          null
        );
        name = t.agentName ?? name ?? 'Agent template';
        description = t.description;
      } else {
        const t = await rpc.roomTemplates.parse({ yamlText, schema: templateSchema ?? undefined });
        name = name ?? t.roomName ?? 'Room template';
      }
      await rpc.switchServers.saveTemplate({
        serverId,
        name,
        description,
        kind: isAgent ? 'agent' : 'room',
        content: yamlText,
      });
      toast.success(`"${name}" is now on the server`);
      appState.navigation.navigate('templates', { serverId });
    } catch (e) {
      setParseError(failureText(e, 'Could not save this template to the server.'));
    } finally {
      setSaving(false);
    }
  }, [yamlText, sourceName, serverId, templateSchema]);

  // Opened with a document already chosen (a dropped file, a recent, a room
  // card's Use): go straight past the first step.
  const advancedOnce = useRef(false);
  useEffect(() => {
    if (advancedOnce.current) return;
    if (initialTemplateId) {
      advancedOnce.current = true;
      rpc.switchServers
        .getTemplateDetail({ serverId, templateId: initialTemplateId })
        .then((detail) => {
          setSourceName(detail.name);
          setYamlText(detail.definition);
        })
        .catch((e: unknown) => setParseError(failureText(e, 'Could not load this template.')));
      return;
    }
    if (initialYaml && initialYaml.trim().length > 0) {
      advancedOnce.current = true;
      void handleParseAndAdvance();
    }
  }, [initialTemplateId, initialYaml, serverId, handleParseAndAdvance]);
  // A template fetched by id arrives a moment later; advance once it has.
  const advancedFetched = useRef(false);
  useEffect(() => {
    if (!initialTemplateId || advancedFetched.current || yamlText.trim().length === 0) return;
    advancedFetched.current = true;
    void handleParseAndAdvance();
  }, [initialTemplateId, yamlText, handleParseAndAdvance]);

  const stepNumber = step === 'source' ? 1 : 2;
  const totalSteps = 2;

  const subtitle =
    step === 'source'
      ? 'Paste an agent or room template, or pick a YAML file. The document says which it is.'
      : `${sourceName ?? 'template'}: ${parsed?.params.length ?? 0} input${(parsed?.params.length ?? 0) !== 1 ? 's' : ''}. The room is created only when you hit Create.`;

  return (
    <ServerPage
      title={step === 'source' ? 'Import a template' : 'Create the room'}
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
          onSaveToServer={handleSaveToServer}
          saving={saving}
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
            lists={lists}
            onBack={() => setStep('source')}
            onSubmit={() => handleCreate()}
            sourceName={sourceName}
            createError={createError}
            editedAgents={editedAgents}
            onEditedAgentsChange={setEditedAgents}
            editedUsers={editedUsers}
            onEditedUsersChange={setEditedUsers}
            creatorIdentity={creatorIdentity}
            bridgeName={templateBridge?.displayName ?? parsed.bridge}
            creatorBlocked={creatorBlocked}
            onLinkAccount={onLinkAccount}
            handoffBlocked={handoffBlocked}
            onAllowHandoffs={() => void allowHandoffs()}
            allowingHandoffs={allowingHandoffs}
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

export const templateImportView = {
  WrapView: ({
    children,
  }: {
    children: React.ReactNode;
    serverId: string;
    /** A document to start from, when the person arrived with one. */
    yamlText?: string;
    sourceName?: string;
    /** A registry row to load and go straight to its inputs. */
    templateId?: string;
  }) => <>{children}</>,
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
} satisfies ViewDefinition<{
  serverId: string;
  yamlText?: string;
  sourceName?: string;
  templateId?: string;
}>;
