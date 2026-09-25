import { parameterize, type ParamSubstitution } from '@switch-console/shared';
import { CheckSquare, FileText, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParsedTemplate } from '@main/core/room-templates/controller';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { prefillForSave } from '@renderer/features/templates/agent-template-data';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useModalContext } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';

type CaptureStep = 'loading' | 'preview' | 'error';

/** Candidate fields the user can promote to params. */
type Candidate = {
  /** Identity of the row. The key is what the user edits, so it cannot be the identity. */
  id: number;
  /** The param key, as suggested, until the user edits it. */
  key: string;
  /** Human label for the field, e.g. "Room name" */
  label: string;
  /** The literal value that will be replaced. */
  value: string;
  checked: boolean;
};

/** Parse the exported YAML to find parameterizable values. */
function extractCandidates(yamlText: string): Candidate[] {
  const candidates: Omit<Candidate, 'id'>[] = [];

  // A one-line scalar. A block header (`|`, `|-`, `>`) is not a value: the
  // exporter writes multi-line text that way, and its body cannot be one
  // literal to replace.
  const scalarOf = (m: RegExpMatchArray | null): string | null => {
    if (!m) return null;
    const raw = m[1].trim();
    if (/^[|>](?:[-+]?\d*|\d*[-+]?)$/.test(raw)) return null;
    const val = raw.replace(/^['"]|['"]$/g, '');
    return val || null;
  };

  const name = scalarOf(yamlText.match(/^\s*name:\s+(.+)$/m));
  if (name) candidates.push({ key: 'name', label: 'Room name', value: name, checked: false });

  const description = scalarOf(yamlText.match(/^\s*description:\s+(.+)$/m));
  if (description) {
    candidates.push({
      key: 'description',
      label: 'Description',
      value: description,
      checked: false,
    });
  }

  const agentSection = yamlText.match(/^\s*agents:\s*\n((?:\s*-\s+.+\n?)*)/m);
  if (agentSection) {
    const lines = agentSection[1].matchAll(/^\s*-\s+(.+)$/gm);
    let i = 0;
    for (const m of lines) {
      const val = m[1].replace(/^['"]|['"]$/g, '');
      if (val) {
        const key = i === 0 ? 'deploy_agent' : `agent_${i}`;
        candidates.push({ key, label: `Agent ${val}`, value: val, checked: false });
        i++;
      }
    }
  }

  // The instructions: a one-line value, or the body of a block scalar,
  // which is every following line indented deeper than the `instructions:`
  // line. A repository URL in there is worth a param.
  const lines = yamlText.split('\n');
  const at = lines.findIndex((l) => /^\s*instructions:/.test(l));
  if (at >= 0) {
    const header = lines[at];
    const indent = header.match(/^ */)?.[0].length ?? 0;
    const inline = header.replace(/^\s*instructions:\s*/, '');
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() !== '' && (l.match(/^ */)?.[0].length ?? 0) <= indent) break;
      body.push(l);
    }
    const instrText = /^[|>]/.test(inline) ? body.join('\n') : inline;
    const repoMatch = instrText.match(/https?:\/\/github\.com\/[\w./-]+/);
    if (repoMatch) {
      candidates.push({
        key: 'repository',
        label: 'Repository in instructions',
        value: repoMatch[0],
        checked: false,
      });
    }
  }

  return candidates.map((c, id) => ({ ...c, id }));
}

// ── Parameterize row ────────────────────────────────────────────────────────

function CandidateRow({
  candidate,
  onToggle,
  onKeyChange,
}: {
  candidate: Candidate;
  onToggle: () => void;
  onKeyChange: (key: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-4 py-2.5">
      <span className="min-w-0 shrink-0 text-sm text-foreground">{candidate.label} →</span>
      <div className="flex flex-1 items-center justify-end gap-2">
        {candidate.checked ? (
          <>
            <span className="font-mono text-sm text-foreground">{'{'}</span>
            <Input
              value={candidate.key}
              onChange={(e) => onKeyChange(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
              className="h-7 w-28 font-mono text-sm"
            />
            <span className="font-mono text-sm text-foreground">{'}'}</span>
            <span className="text-xs text-foreground-passive">
              · was &quot;{candidate.value}&quot;
            </span>
          </>
        ) : (
          <span className="text-sm text-foreground-passive">keep literal</span>
        )}
        <input
          type="checkbox"
          checked={candidate.checked}
          onChange={onToggle}
          className="ml-1 size-4 rounded border-border"
        />
      </div>
    </div>
  );
}

// ── Round-trip check sidebar ────────────────────────────────────────────────

function RoundTripCheck({
  parsed,
  candidates,
  parameterizeOk,
  parameterizeError,
}: {
  parsed: ParsedTemplate | null;
  candidates: Candidate[];
  parameterizeOk: boolean;
  /** Why the substitution was refused, when it was. */
  parameterizeError: string | null;
}) {
  const checkedCount = candidates.filter((c) => c.checked).length;
  const allHaveDefaults = candidates.filter((c) => c.checked).every((c) => c.value !== '');
  const parsesOk = parsed !== null && parsed.warnings.length === 0 && parameterizeOk;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">Round-trip check</h3>
        <div className="space-y-2">
          <CheckItem ok={parsesOk}>Parses as a valid template</CheckItem>
          {parameterizeError && <p className="text-xs text-destructive">{parameterizeError}</p>}
          <CheckItem ok={checkedCount > 0 ? allHaveDefaults : true}>
            {checkedCount > 0
              ? `${checkedCount} param${checkedCount > 1 ? 's' : ''}, ${allHaveDefaults ? 'all' : 'not all'} with defaults`
              : 'No params (literal export)'}
          </CheckItem>
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold text-foreground">Share it</h3>
        <p className="text-xs leading-relaxed text-foreground-passive">
          Post the file in the team channel: &quot;try importing this in your Console.&quot;
          That&apos;s the whole loop — capture here, import on the other side.
        </p>
      </div>
    </div>
  );
}

function CheckItem({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <CheckSquare
        className={`mt-0.5 size-4 shrink-0 ${ok ? 'text-green-600' : 'text-foreground-passive'}`}
      />
      <span className="text-sm text-foreground">{children}</span>
    </div>
  );
}

// ── Main view ───────────────────────────────────────────────────────────────

function useCaptureParams() {
  return useParams('templateCapture').params;
}

const CaptureTitlebar = observer(function CaptureTitlebar() {
  const { serverId, roomId } = useCaptureParams();
  const roomName = switchRoomsStore.roomNameById(roomId);
  return (
    <ServerSectionTitlebar
      serverId={serverId}
      icon={FileText}
      label={roomName ? `${roomName} / Capture as template` : 'Capture as template'}
    />
  );
});

const CapturePanel = observer(function CapturePanel() {
  const { serverId, roomId } = useCaptureParams();
  const roomName = switchRoomsStore.roomNameById(roomId);

  const [step, setStep] = useState<CaptureStep>('loading');
  const [originalYaml, setOriginalYaml] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const workspaceId = workspacesStore.idOnServerInScope(serverId);
        if (workspaceId === null) throw new Error('This server’s workspace is not known yet.');
        const yaml = await rpc.workspaces.exportRoomYaml({ workspaceId, roomId });
        if (cancelled) return;
        setOriginalYaml(yaml);
        setCandidates(extractCandidates(yaml));
        setStep('preview');
      } catch (e) {
        if (!cancelled) {
          setError(failureText(e, 'Could not export this room.'));
          setStep('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, roomId]);

  const handleToggle = useCallback((id: number) => {
    setCandidates((prev) => prev.map((c) => (c.id === id ? { ...c, checked: !c.checked } : c)));
    setSaved(false);
    setCopied(false);
  }, []);

  const handleKeyChange = useCallback((id: number, newKey: string) => {
    setCandidates((prev) => prev.map((c) => (c.id === id ? { ...c, key: newKey } : c)));
    setSaved(false);
    setCopied(false);
  }, []);

  // The check reports on the document that is saved or copied, not on the
  // raw export: a substitution can break a document the export parsed.
  const [outputParsed, setOutputParsed] = useState<ParsedTemplate | null>(null);
  const { parameterizedYaml, parameterizeOk, parameterizeError } = useMemo(() => {
    const checked = candidates.filter((c) => c.checked);
    if (checked.length === 0)
      return { parameterizedYaml: originalYaml, parameterizeOk: true, parameterizeError: null };
    const subs: ParamSubstitution[] = checked.map((c) => ({ key: c.key, value: c.value }));
    try {
      return {
        parameterizedYaml: parameterize(originalYaml, subs),
        parameterizeOk: true,
        parameterizeError: null,
      };
    } catch (e) {
      return {
        parameterizedYaml: originalYaml,
        parameterizeOk: false,
        parameterizeError: failureText(e, 'The params could not be applied.'),
      };
    }
  }, [originalYaml, candidates]);
  useEffect(() => {
    if (step !== 'preview') return;
    let cancelled = false;
    setOutputParsed(null);
    rpc.roomTemplates
      .parse({ yamlText: parameterizedYaml })
      .then((p) => {
        if (!cancelled) setOutputParsed(p);
      })
      .catch(() => {
        if (!cancelled) setOutputParsed(null);
      });
    return () => {
      cancelled = true;
    };
  }, [parameterizedYaml, step]);

  const handleSave = useCallback(async () => {
    const slug = (roomName ?? 'room').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
    const result = await rpc.roomTemplates.saveToFile({
      yamlText: parameterizedYaml,
      defaultName: `${slug}.yaml`,
    });
    if (result) setSaved(true);
  }, [parameterizedYaml, roomName]);

  const { showModal } = useModalContext();
  const { navigate } = useNavigate();
  const handleSaveToWorkspace = useCallback(async () => {
    const prefill = await prefillForSave(parameterizedYaml, null);
    showModal('saveTemplateModal', {
      serverId,
      serverName: switchServersStore.servers.find((sv) => sv.id === serverId)?.name ?? null,
      content: parameterizedYaml,
      ...prefill,
      // `prefillForSave` answers a generic name when the room's name holds a
      // placeholder; a captured room has a real name to use instead.
      name: prefill.name === 'Room template' && roomName ? roomName : prefill.name,
      onSuccess: ({ id }) => navigate('templateDetail', { serverId, templateId: id }),
    });
  }, [parameterizedYaml, serverId, roomName, showModal, navigate]);

  const handleCopy = useCallback(() => {
    void rpc.roomTemplates.copyToClipboard({ text: parameterizedYaml });
    setCopied(true);
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [parameterizedYaml]);

  if (step === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-foreground-passive" />
        <span className="ml-2 text-sm text-foreground-passive">Exporting room…</span>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="mx-auto w-full max-w-4xl p-6">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="relative z-10 flex min-h-0 flex-1 overflow-auto bg-background">
      {/* Main content */}
      <div className="flex-1 p-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <header>
            <h2 className="text-2xl font-semibold text-foreground">Capture as template</h2>
            <p className="mt-1 text-sm text-foreground-muted">
              This room, packaged as a shareable file.
            </p>
          </header>

          {/* Parameterize section */}
          {candidates.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-semibold text-foreground">Parameterize</h3>
              <div className="space-y-2">
                {candidates.map((c) => (
                  <CandidateRow
                    key={c.id}
                    candidate={c}
                    onToggle={() => handleToggle(c.id)}
                    onKeyChange={(newKey) => handleKeyChange(c.id, newKey)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Preview */}
          <div>
            <h3 className="mb-3 text-sm font-semibold text-foreground">Preview</h3>
            <pre className="max-h-80 overflow-auto rounded-md border border-border bg-background-secondary p-4 font-mono text-xs leading-relaxed">
              {parameterizedYaml}
            </pre>
          </div>

          {/* Buttons — stacked full width */}
          <div className="flex flex-col gap-2">
            {/* Every way out carries the same document, so a document the
                substitution refused is offered by none of them. */}
            <Button
              variant="outline"
              className="w-full"
              disabled={!parameterizeOk}
              onClick={handleCopy}
            >
              {copied ? 'Copied!' : 'Copy YAML'}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              disabled={!parameterizeOk}
              onClick={handleSave}
            >
              {saved ? 'Saved!' : 'Save file…'}
            </Button>
            <Button
              className="w-full"
              disabled={!parameterizeOk}
              onClick={() => void handleSaveToWorkspace()}
            >
              Save to workspace
            </Button>
          </div>
        </div>
      </div>

      {/* Right sidebar */}
      <aside className="w-72 shrink-0 border-l border-border p-6">
        <RoundTripCheck
          parsed={outputParsed}
          candidates={candidates}
          parameterizeOk={parameterizeOk}
          parameterizeError={parameterizeError}
        />
      </aside>
    </div>
  );
});

export const templateCaptureView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string; roomId: string }) => (
    <>{children}</>
  ),
  TitlebarSlot: CaptureTitlebar,
  MainPanel: CapturePanel,
  canActivate: (params: unknown): GuardResult => {
    const p = params as { serverId?: unknown; roomId?: unknown } | null;
    if (!p || typeof p.serverId !== 'string' || typeof p.roomId !== 'string') {
      return { ok: false, redirect: 'home' };
    }
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string; roomId: string }>;
