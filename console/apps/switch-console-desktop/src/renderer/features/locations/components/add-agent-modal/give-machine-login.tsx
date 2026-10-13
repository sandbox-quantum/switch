import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, KeyRound, TriangleAlert, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { MachineLoginInput, OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  type AgentProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';

type LoginKind = 'setup-token' | 'api-key' | 'this-computer' | 'vertex';
type VertexSource = 'key' | 'this-computer';

const VERTEX_SOURCES: { value: VertexSource; label: string }[] = [
  { value: 'key', label: 'Service account key (recommended)' },
  { value: 'this-computer', label: "This computer's Google sign-in" },
];

/** What Claude Code on Vertex AI is set up with at SandboxAQ (`cg-claude-code-starter`). */
const VERTEX_DEFAULTS = { project: 'cg-vertexai', region: 'global' };

/** The ways a machine can be given each provider's login. */
export function loginKindsFor(provider: AgentProviderId): { value: LoginKind; label: string }[] {
  switch (provider) {
    case 'claude':
      return [
        { value: 'setup-token', label: 'Setup token' },
        { value: 'api-key', label: 'API key' },
        { value: 'vertex', label: 'Vertex AI' },
      ];
    case 'codex':
      return [
        { value: 'api-key', label: 'API key' },
        { value: 'this-computer', label: "This computer's sign-in" },
      ];
    case 'cursor':
      return [{ value: 'api-key', label: 'API key' }];
    default:
      return [{ value: 'this-computer', label: "This computer's sign-in" }];
  }
}

function displayName(provider: AgentProviderId): string {
  return providerDisplayName(provider) ?? provider;
}

function hint(provider: AgentProviderId, kind: LoginKind, source: VertexSource): string {
  if (kind === 'vertex')
    return source === 'key'
      ? `${displayName(provider)} signs in to Google Vertex AI with a service account key. Make one for a service account that can use only Vertex AI (roles/aiplatform.user), and paste its JSON or pick its file.`
      : `${displayName(provider)} signs in to Google Vertex AI as you, with the sign-in \`gcloud auth application-default login\` made on this computer.`;
  if (kind === 'setup-token')
    return 'Run `claude setup-token` on any computer signed in to Claude, and paste the token it prints.';
  if (kind === 'this-computer')
    return `The ${displayName(provider)} sign-in on this computer is sent, sealed for the machine.`;
  return `Paste a ${displayName(provider)} API key.`;
}

/**
 * Gives a machine a provider login, on demand: sealed in Console to the
 * machine's own key, so the server only relays it, and taken up by the machine
 * at once. Says whether the provider signs in with it there.
 */
export function GiveMachineLogin({
  serverId,
  machine,
  provider,
  onClose,
}: {
  serverId: string;
  machine: OwnedMachine;
  provider: AgentProviderId;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const kinds = loginKindsFor(provider);
  const [kind, setKind] = useState<LoginKind>(kinds[0]!.value);
  const [credential, setCredential] = useState('');
  const [vertexSource, setVertexSource] = useState<VertexSource>('key');
  const [project, setProject] = useState(VERTEX_DEFAULTS.project);
  const [region, setRegion] = useState(VERTEX_DEFAULTS.region);
  const [pickedFile, setPickedFile] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const name = displayName(provider);

  const give = useMutation({
    mutationFn: () => {
      const login: MachineLoginInput =
        kind === 'vertex'
          ? {
              source: 'vertex',
              project,
              region,
              credentials:
                vertexSource === 'key'
                  ? { from: 'key', json: credential }
                  : { from: 'this-computer' },
            }
          : kind === 'this-computer'
            ? { source: 'this-computer' }
            : { source: 'typed', kind, credential };
      return rpc.managedAgents.giveMachineLogin({
        serverId,
        machineId: machine.id,
        provider,
        login,
      });
    },
    onSuccess: ({ operationId: id }) => {
      setCredential('');
      setPickedFile(null);
      setOperationId(id);
    },
  });

  const outcome = useQuery({
    queryKey: [MANAGED_AGENTS_KEY, serverId, 'machine-login', operationId],
    queryFn: () =>
      rpc.managedAgents.machineLoginOutcome({
        serverId,
        machineId: machine.id,
        operationId: operationId!,
      }),
    enabled: operationId !== null,
    refetchInterval: (query) => (query.state.data?.state === 'pending' ? 1500 : false),
  });

  const result = outcome.data;
  const succeeded = result?.state === 'succeeded';
  // The machine now reports the provider ready: show it without waiting for the next poll.
  useEffect(() => {
    if (succeeded)
      void queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId, 'machines'] });
  }, [succeeded, queryClient, serverId]);
  const waiting =
    give.isPending || (operationId !== null && (!result || result.state === 'pending'));
  const needsCredential = kind === 'vertex' ? vertexSource === 'key' : kind !== 'this-computer';
  const ready =
    (!needsCredential || credential.trim() !== '') &&
    (kind !== 'vertex' || (project.trim() !== '' && region.trim() !== ''));

  const pickKey = async (file: File | undefined) => {
    if (!file) return;
    setPickError(null);
    if (file.size > 16384) {
      setPickError(`${file.name} is too large to be a service account key.`);
      return;
    }
    try {
      setCredential(await file.text());
      setPickedFile(file.name);
      give.reset();
    } catch (error) {
      setPickError(failureText(error, `Could not read ${file.name}.`));
    }
  };

  return (
    <div className="space-y-3 rounded-lg border bg-background-1 p-3 text-sm" role="group">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-foreground-muted" />
        <span>
          Give {machine.name} a {name} login
        </span>
      </div>
      {kinds.length > 1 && (
        <SegmentedControl
          value={kind}
          onChange={(next) => {
            setKind(next);
            setCredential('');
            setPickedFile(null);
            setPickError(null);
            give.reset();
          }}
          options={kinds}
          ariaLabel={`${name} login`}
        />
      )}
      {kind === 'vertex' && (
        <SegmentedControl
          value={vertexSource}
          onChange={(next) => {
            setVertexSource(next);
            setCredential('');
            setPickedFile(null);
            setPickError(null);
            give.reset();
          }}
          options={VERTEX_SOURCES}
          ariaLabel="Google credential"
        />
      )}
      <p className="text-xs text-foreground-muted">{hint(provider, kind, vertexSource)}</p>
      {kind === 'vertex' && vertexSource === 'this-computer' && (
        <p className="flex items-start gap-2 text-xs" role="note">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          This gives {machine.name} all of your Google Cloud access, and agents there run any
          command they choose. A key for a Vertex-only service account gives it only Vertex AI.
        </p>
      )}
      {kind === 'vertex' && vertexSource === 'key' && (
        <div className="space-y-2">
          <Textarea
            aria-label="Service account key"
            autoComplete="off"
            spellCheck={false}
            placeholder='{"type": "service_account", …}'
            className="max-h-32 font-mono text-xs [-webkit-text-security:disc]"
            value={credential}
            onChange={(event) => {
              setCredential(event.target.value);
              setPickedFile(null);
            }}
            disabled={waiting}
          />
          <div className="flex items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label="Service account key file"
              onChange={(event) => {
                void pickKey(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={waiting}
              onClick={() => fileInput.current?.click()}
            >
              <Upload className="mr-1.5 size-3.5" />
              Pick a file…
            </Button>
            {pickedFile && <span className="text-xs text-foreground-muted">Read {pickedFile}</span>}
          </div>
        </div>
      )}
      {kind === 'vertex' && (
        <div className="flex gap-2">
          <label className="flex-1 space-y-1 text-xs text-foreground-muted">
            <span>Google Cloud project</span>
            <Input
              aria-label="Google Cloud project"
              value={project}
              onChange={(event) => setProject(event.target.value)}
              disabled={waiting}
            />
          </label>
          <label className="w-32 space-y-1 text-xs text-foreground-muted">
            <span>Region</span>
            <Input
              aria-label="Region"
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              disabled={waiting}
            />
          </label>
        </div>
      )}
      {kind !== 'this-computer' && kind !== 'vertex' && (
        <Input
          type="password"
          autoComplete="off"
          aria-label={kind === 'setup-token' ? 'Setup token' : 'API key'}
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          disabled={waiting}
        />
      )}
      {waiting && operationId !== null && (
        <p className="flex items-center gap-2 text-xs text-foreground-muted" role="status">
          <Spinner className="size-3.5" />
          Waiting for {machine.name} to check the login…
        </p>
      )}
      {result?.state === 'succeeded' && (
        <p className="flex items-center gap-2 text-xs" role="status">
          <CircleCheck className="size-3.5 text-emerald-500" />
          {name} signs in on {machine.name}.
        </p>
      )}
      {(pickError || give.error || result?.state === 'failed') && (
        <p className="flex items-start gap-2 text-xs" role="alert">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          {pickError ??
            (give.error
              ? String(give.error instanceof Error ? give.error.message : give.error)
              : result?.state === 'failed'
                ? result.message
                : null)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {result?.state === 'succeeded' ? 'Done' : 'Cancel'}
        </Button>
        {result?.state !== 'succeeded' && (
          <Button
            size="sm"
            disabled={waiting || !ready}
            onClick={() => {
              setOperationId(null);
              give.mutate();
            }}
          >
            Give login
          </Button>
        )}
      </div>
    </div>
  );
}
