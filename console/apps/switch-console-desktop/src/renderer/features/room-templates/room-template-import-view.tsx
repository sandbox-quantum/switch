import Editor from '@monaco-editor/react';
import { ArrowRight, Save, Upload, FileText } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { prefillForSave } from '@renderer/features/templates/agent-template-data';
import {
  TEMPLATE_ACCESS_OPTIONS,
  type TemplateAccess,
  visibilityOf,
} from '@renderer/features/templates/template-visibility';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useModalContext } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';

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
  editing,
}: {
  yamlText: string;
  onYamlChange: (text: string) => void;
  parseError: string | null;
  onNext: () => void;
  onFileSelect: (name: string) => void;
  onSaveToServer: () => void;
  saving: boolean;
  /** Set when the document belongs to a stored template: the actions become Cancel and Save changes. */
  editing?: { onCancel: () => void; onSave: () => void; canSave: boolean };
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

      {editing ? (
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" disabled={saving} onClick={editing.onCancel}>
            Cancel
          </Button>
          <Button disabled={!editing.canSave || saving} onClick={editing.onSave}>
            <Save className="mr-1.5 size-3.5" />
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" disabled={!yamlText.trim() || saving} onClick={onSaveToServer}>
            <Save className="mr-1.5 size-3.5" />
            {saving ? 'Saving…' : 'Save to workspace'}
          </Button>
          <Button disabled={!yamlText.trim() || saving} onClick={onNext}>
            Next
            <ArrowRight className="ml-1.5 size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────────────────

type EditingTemplate = {
  id: string;
  name: string;
  description: string;
  /** The stored listing label: agent, room or group. */
  kind: string;
  access: TemplateAccess;
  /** Only the owner or an admin decides who may see or change a template. */
  canChangeAccess: boolean;
};

function useServerId(): string {
  return useParams('templateImport').params.serverId;
}

const TemplateImportTitlebar = observer(function TemplateImportTitlebar() {
  const serverId = useServerId();
  return (
    <ServerSectionTitlebar
      serverId={serverId}
      icon={FileText}
      label="Templates"
      item={{ label: useParams('templateImport').params.editingTemplate ? 'Edit' : 'Import' }}
      onSectionClick={() => appState.navigation.navigate('templates', { serverId })}
    />
  );
});

const TemplateImportPanel = observer(function TemplateImportPanel() {
  const serverId = useServerId();
  const { showModal } = useModalContext();
  const {
    yamlText: initialYaml,
    sourceName: initialName,
    templateId: initialTemplateId,
    edit: editing,
    editingTemplate,
  } = useParams('templateImport').params;
  const [yamlText, setYamlText] = useState(initialYaml ?? '');
  const [saving, setSaving] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(initialName ?? null);
  const [name, setName] = useState(editingTemplate?.name ?? '');
  const [description, setDescription] = useState(editingTemplate?.description ?? '');
  const [access, setAccess] = useState<TemplateAccess>(editingTemplate?.access ?? 'shared');

  // Parse before navigating so a syntax error is shown next to the editor,
  // where it can be fixed, rather than on the Use page.
  const handleParseAndAdvance = useCallback(async () => {
    setParseError(null);
    try {
      await rpc.agentTemplates.parseAgents({ yamlText });
      const coreYaml = await rpc.agentTemplates.serverDocument({ yamlText });
      if (coreYaml) await rpc.roomTemplates.parse({ yamlText: coreYaml });
      else if ((await rpc.agentTemplates.parseAgents({ yamlText })).agents.length === 0) {
        throw new Error('Template must have a "room:", "group:" or "agent:" block.');
      }
      appState.navigation.navigate('templateUse', {
        serverId,
        yamlText,
        sourceName: sourceName ?? undefined,
      });
    } catch (e) {
      setParseError(failureText(e, 'Could not parse this template.'));
    }
  }, [yamlText, serverId, sourceName]);

  // Save the document to the workspace without using it. The dialog asks for
  // the name and description, prefilled from the document.
  const handleSaveToServer = useCallback(async () => {
    setSaving(true);
    setParseError(null);
    try {
      const prefill = await prefillForSave(yamlText, sourceName);
      showModal('saveTemplateModal', {
        serverId,
        serverName: switchServersStore.servers.find((sv) => sv.id === serverId)?.name ?? null,
        content: yamlText,
        ...prefill,
        onSuccess: () => appState.navigation.navigate('templates', { serverId }),
      });
    } catch (e) {
      setParseError(failureText(e, 'Could not read this template.'));
    } finally {
      setSaving(false);
    }
  }, [yamlText, sourceName, serverId, showModal]);

  const handleSaveChanges = useCallback(async () => {
    if (!editingTemplate) return;
    setSaving(true);
    setParseError(null);
    try {
      // A document that does not parse could not be used by anyone afterwards.
      await rpc.agentTemplates.parseAgents({ yamlText });
      const coreYaml = await rpc.agentTemplates.serverDocument({ yamlText });
      if (coreYaml) await rpc.roomTemplates.parse({ yamlText: coreYaml });
      // The listing files a template by its stored label, so an edit that
      // changes the document's shape carries the new label with it.
      const kind = yamlText !== initialYaml ? await rpc.agentTemplates.kind({ yamlText }) : null;
      // Each field is sent only when changed, so saving one cannot put back
      // another that someone else changed meanwhile.
      const saved = await rpc.switchServers.updateTemplate({
        serverId,
        templateId: editingTemplate.id,
        ...(name.trim() !== editingTemplate.name.trim() ? { name: name.trim() } : {}),
        ...(description.trim() !== editingTemplate.description.trim()
          ? { description: description.trim() }
          : {}),
        ...(yamlText !== initialYaml ? { content: yamlText } : {}),
        ...(kind !== null && kind !== editingTemplate.kind ? { kind } : {}),
        ...(access !== editingTemplate.access ? visibilityOf(access) : {}),
      });
      toast({ title: `"${saved.name}" saved`, description: `Version ${saved.version}.` });
      appState.navigation.navigate('templateDetail', { serverId, templateId: saved.id });
    } catch (e) {
      setParseError(failureText(e, 'Could not save the changes.'));
    } finally {
      setSaving(false);
    }
  }, [editingTemplate, yamlText, initialYaml, name, description, access, serverId]);

  // When this page is opened with a document already chosen (a dropped file,
  // a recent, a template id), there is nothing to edit here: go on to the
  // Use page.
  const advancedOnce = useRef(false);
  useEffect(() => {
    if (advancedOnce.current) return;
    if (initialTemplateId) {
      advancedOnce.current = true;
      appState.navigation.navigate('templateUse', { serverId, templateId: initialTemplateId });
      return;
    }
    // `edit` is set when the deployer came back from the Use page to change
    // the document, so it must not be sent on again.
    if (initialYaml && initialYaml.trim().length > 0 && !editing) {
      advancedOnce.current = true;
      void handleParseAndAdvance();
    }
  }, [initialTemplateId, initialYaml, editing, serverId, handleParseAndAdvance]);

  if (editingTemplate) {
    const nothingChanged =
      yamlText === initialYaml &&
      name.trim() === editingTemplate.name &&
      description.trim() === editingTemplate.description &&
      access === editingTemplate.access;
    return (
      <ServerPage
        title={`Edit ${editingTemplate.name}`}
        description="The change reaches the workspace as soon as it is saved."
      >
        <div className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="template-name">Name</FieldLabel>
              <Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="template-description">
                Description <span className="text-foreground-muted">(optional)</span>
              </FieldLabel>
              <Input
                id="template-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What it is for, in a line"
              />
            </Field>
            {editingTemplate.canChangeAccess && (
              <Field>
                <FieldLabel>Who can use it</FieldLabel>
                <SegmentedControl
                  value={access}
                  onChange={setAccess}
                  options={TEMPLATE_ACCESS_OPTIONS}
                  ariaLabel="Who can use it"
                  className="w-max"
                />
                <p className="text-xs text-foreground-muted">
                  {TEMPLATE_ACCESS_OPTIONS.find((o) => o.value === access)?.hint}
                </p>
              </Field>
            )}
          </FieldGroup>
          <SourceStep
            yamlText={yamlText}
            onYamlChange={setYamlText}
            parseError={parseError}
            onNext={handleParseAndAdvance}
            onFileSelect={setSourceName}
            onSaveToServer={handleSaveToServer}
            saving={saving}
            editing={{
              onCancel: () =>
                appState.navigation.navigate('templateDetail', {
                  serverId,
                  templateId: editingTemplate.id,
                }),
              onSave: handleSaveChanges,
              canSave: !nothingChanged && name.trim().length > 0 && yamlText.trim().length > 0,
            }}
          />
        </div>
      </ServerPage>
    );
  }

  return (
    <ServerPage
      title="Import a template"
      description="Paste an agent, room or group template, or pick a YAML file. The document says which it is."
    >
      <SourceStep
        yamlText={yamlText}
        onYamlChange={setYamlText}
        parseError={parseError}
        onNext={handleParseAndAdvance}
        onFileSelect={setSourceName}
        onSaveToServer={handleSaveToServer}
        saving={saving}
      />
    </ServerPage>
  );
});

export const templateImportView = {
  WrapView: ({
    children,
  }: {
    children: React.ReactNode;
    serverId: string;
    /** A document to open the editor with. */
    yamlText?: string;
    sourceName?: string;
    /** A workspace template to load and pass on to the Use page. */
    templateId?: string;
    /** Show `yamlText` in the editor instead of passing it on to the Use page. */
    edit?: boolean;
    /** The stored template `yamlText` belongs to. The page then saves changes to it. */
    editingTemplate?: EditingTemplate;
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
  edit?: boolean;
  editingTemplate?: EditingTemplate;
}>;
