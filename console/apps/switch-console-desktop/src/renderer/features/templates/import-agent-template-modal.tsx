import Editor from '@monaco-editor/react';
import { Upload } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';
import { agentTemplateDataFromContent } from './agent-template-data';

type Props = BaseModalProps<void> & { serverId: string };

function readFileAsText(file: File, onText: (text: string) => void): void {
  const reader = new FileReader();
  reader.onload = () => onText(String(reader.result ?? ''));
  reader.readAsText(file);
}

/**
 * The agent-template counterpart of the room wizard's first step: paste,
 * drop or pick a document, then either create an agent from it right away
 * or put it on the server so it shows in the listing for everyone.
 */
export function ImportAgentTemplateModal({ serverId, onClose, onSuccess }: Props) {
  const { transitionModal } = useModalContext();
  const [yamlText, setYamlText] = useState('');
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'use' | 'save' | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const takeFile = useCallback((file: File) => {
    setSourceName(file.name);
    readFileAsText(file, setYamlText);
    setError(null);
  }, []);

  const parse = async () => {
    setError(null);
    return agentTemplateDataFromContent(
      sourceName?.replace(/\.ya?ml$/i, '') ?? 'Pasted template',
      yamlText,
      null,
      null
    );
  };

  const use = async () => {
    setBusy('use');
    try {
      const template = await parse();
      transitionModal('addAgentModal', { entryPoint: 'server_page', template, onClose });
    } catch (e) {
      setError(failureText(e, 'The document did not parse as an agent template.'));
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      const template = await parse();
      const name = template.agentName ?? sourceName?.replace(/\.ya?ml$/i, '') ?? 'Agent template';
      await rpc.switchServers.saveTemplate({
        serverId,
        name,
        description: template.description,
        kind: 'agent',
        content: yamlText,
      });
      toast({ title: `"${name}" is now on the server` });
      onSuccess();
    } catch (e) {
      setError(failureText(e, 'Could not save the template to the server.'));
      setBusy(null);
    }
  };

  const lineCount = Math.max(yamlText.split('\n').length, 1);
  const editorHeight = Math.min(Math.max(lineCount * 18 + 20, 220), 480);

  return (
    <ModalLayout
      header={
        <DialogHeader showCloseButton={busy === null}>
          <DialogTitle>Import an agent template</DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void save()}
            disabled={!yamlText.trim() || busy !== null}
          >
            {busy === 'save' ? 'Saving…' : 'Save to server'}
          </Button>
          <Button
            type="button"
            onClick={() => void use()}
            disabled={!yamlText.trim() || busy !== null}
          >
            {busy === 'use' ? 'Reading…' : 'Create an agent from it'}
          </Button>
        </DialogFooter>
      }
    >
      <DialogContentArea className="gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel>Agent template (YAML)</FieldLabel>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files[0];
                if (file) takeFile(file);
              }}
              className={`overflow-hidden rounded-md border border-border transition-colors ${dragging ? 'ring-primary ring-2' : ''}`}
            >
              <Editor
                height={editorHeight}
                language="yaml"
                theme="vs-dark"
                value={yamlText}
                onChange={(v) => {
                  setYamlText(v ?? '');
                  setError(null);
                }}
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
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) takeFile(file);
              e.target.value = '';
            }}
          />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="mr-1.5 size-3.5" />
            Choose file
          </Button>
          <span className="text-xs text-foreground-passive">
            or paste YAML above, or drag and drop. The format is described in{' '}
            <span className="font-mono">switch-expert/template.yaml</span>.
          </span>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
}
