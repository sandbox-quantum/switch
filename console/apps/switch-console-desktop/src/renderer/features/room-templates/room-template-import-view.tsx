import Editor from '@monaco-editor/react';
import { ArrowRight, Save, Upload, FileText } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { prefillForSave } from '@renderer/features/templates/agent-template-data';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useModalContext } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';

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
          {saving ? 'Saving…' : 'Save to workspace'}
        </Button>
        <Button disabled={!yamlText.trim() || saving} onClick={onNext}>
          Next
          <ArrowRight className="ml-1.5 size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────────────────

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
      item={{ label: 'Import' }}
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
  } = useParams('templateImport').params;
  const [yamlText, setYamlText] = useState(initialYaml ?? '');
  const [saving, setSaving] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(initialName ?? null);

  // The document says what it is; the Use page takes it from here. Parsing
  // first means a typo is reported beside the editor, not on the next page.
  const handleParseAndAdvance = useCallback(async () => {
    setParseError(null);
    try {
      await rpc.agentTemplates.parseAgents({ yamlText });
      const coreYaml = await rpc.agentTemplates.coreDocument({ yamlText });
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

  // Either kind, straight from the first step: the dialog asks what to call
  // it on the server, prefilled from the document.
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

  // Opened with a document already chosen (a dropped file, a recent, a card's
  // Use): this page has nothing to add, so go straight on.
  const advancedOnce = useRef(false);
  useEffect(() => {
    if (advancedOnce.current) return;
    if (initialTemplateId) {
      advancedOnce.current = true;
      appState.navigation.navigate('templateUse', { serverId, templateId: initialTemplateId });
      return;
    }
    if (initialYaml && initialYaml.trim().length > 0) {
      advancedOnce.current = true;
      void handleParseAndAdvance();
    }
  }, [initialTemplateId, initialYaml, serverId, handleParseAndAdvance]);

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
