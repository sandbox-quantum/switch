import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, KeyRound, TriangleAlert, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  BrowserSignInHost,
  BrowserSignInState,
  MachineLoginInput,
} from '../contracts/machine-logins';
import { type LoginKind, type LoginKindOption, loginHint } from '../model/provider-catalogue';
import { signInFileCredential } from '../model/seal-login';
import { VERTEX_DEFAULT_REGION } from '../model/vertex-login';
import { Button } from '../primitives/button';
import { Input } from '../primitives/input';
import { SegmentedControl } from '../primitives/segmented-control';
import { Spinner } from '../primitives/spinner';
import { Textarea } from '../primitives/textarea';
import { BrowserSignInPanel } from './browser-sign-in';

/** Where an operation sent to a machine stands: still being worked on, done, or why not. */
export type OperationOutcome =
  | { state: 'pending' }
  | { state: 'succeeded' }
  | { state: 'failed'; message: string };

type VertexSource = 'key' | 'this-computer';

const VERTEX_SOURCES: { value: VertexSource; label: string }[] = [
  { value: 'key', label: 'Service account key (recommended)' },
  { value: 'this-computer', label: "This computer's Google sign-in" },
];

/**
 * Gives a machine a provider login, on demand, and says whether the provider
 * signs in with it there. The app seals and sends it (`give`) and reads how
 * the machine took it up (`outcome`); the app keeps its machines under
 * `[...queryKey, 'machines']`, read again once the provider signs in.
 */
export function GiveMachineLogin({
  machineName,
  provider,
  providerName,
  kinds,
  thisComputer,
  browser,
  queryKey,
  give,
  outcome: readOutcome,
  failureText,
  onClose,
}: {
  machineName: string;
  provider: string;
  providerName: string;
  /** The ways the app can give this provider's login, the first picked at first. */
  kinds: LoginKindOption[];
  /** The app runs on a computer whose own Google sign-in it can send (Console), not in a browser. */
  thisComputer: boolean;
  /** How the app runs a browser sign-in on the machine, when `kinds` offers one; else null. */
  browser: BrowserSignInHost | null;
  queryKey: readonly unknown[];
  /** Seals and sends the login; answers the operation the machine takes it up with. */
  give: (login: MachineLoginInput) => Promise<string>;
  outcome: (operationId: string) => Promise<OperationOutcome>;
  failureText: (error: unknown, fallback: string) => string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<LoginKind>(kinds[0]!.value);
  const [credential, setCredential] = useState('');
  const [vertexSource, setVertexSource] = useState<VertexSource>('key');
  const [project, setProject] = useState('');
  const [region, setRegion] = useState(VERTEX_DEFAULT_REGION);
  const [pickedFile, setPickedFile] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const announced = useRef<string | null>(null);
  const [signInId, setSignInId] = useState<string | null>(null);
  const name = providerName;
  if (kinds.some((each) => each.value === 'browser') && !browser)
    throw new Error('A browser sign-in is offered without a way to run it.');

  const giving = useMutation({
    mutationFn: () => {
      if (kind === 'browser') throw new Error('A browser sign-in is started, not given.');
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
      return give(login);
    },
    onSuccess: (id) => {
      setCredential('');
      setPickedFile(null);
      setOperationId(id);
    },
  });

  const outcome = useQuery({
    queryKey: [...queryKey, 'machine-login', operationId],
    queryFn: () => readOutcome(operationId!),
    enabled: operationId !== null,
    refetchInterval: (query) => (query.state.data?.state === 'pending' ? 1500 : false),
  });

  const starting = useMutation({
    mutationFn: () => browser!.start(),
    onSuccess: (id) => setSignInId(id),
  });
  const signIn = useQuery({
    queryKey: [...queryKey, 'browser-sign-in', signInId],
    queryFn: () => browser!.read(signInId!),
    enabled: signInId !== null,
    refetchInterval: (query) => (ended(query.state.data) ? false : 1500),
  });
  const signInState: BrowserSignInState =
    signInId === null ? { state: 'starting' } : (signIn.data ?? { state: 'starting' });
  const signingIn = starting.isPending || (signInId !== null && !ended(signIn.data));

  const result = kind === 'browser' ? undefined : outcome.data;
  const succeeded =
    kind === 'browser' ? signIn.data?.state === 'succeeded' : result?.state === 'succeeded';
  const settledId = kind === 'browser' ? signInId : operationId;
  // The machine now reports the provider ready: show it without waiting for the next poll.
  useEffect(() => {
    if (!succeeded || announced.current === settledId) return;
    announced.current = settledId;
    void queryClient.invalidateQueries({ queryKey: [...queryKey, 'machines'] });
  }, [succeeded, settledId, queryClient, queryKey]);
  const waiting =
    giving.isPending || (operationId !== null && (!result || result.state === 'pending'));
  const needsCredential =
    kind === 'vertex' ? vertexSource === 'key' : kind !== 'this-computer' && kind !== 'browser';
  const ready =
    (!needsCredential || credential.trim() !== '') &&
    (kind !== 'vertex' || (project.trim() !== '' && region.trim() !== ''));

  const pickKey = async (file: File | undefined) => {
    if (!file) return;
    setPickError(null);
    if (file.size > 16384) {
      setPickError(
        `${file.name} is too large to be a ${kind === 'auth-json' ? 'sign-in file' : 'service account key'}.`
      );
      return;
    }
    try {
      const text = await file.text();
      setCredential(kind === 'auth-json' ? signInFileCredential(text) : text);
      setPickedFile(file.name);
      giving.reset();
    } catch (error) {
      setPickError(
        failureText(
          error,
          kind === 'auth-json' ? `${file.name} cannot be used.` : `Could not read ${file.name}.`
        )
      );
    }
  };

  return (
    <div className="space-y-3 rounded-lg border bg-background-1 p-3 text-sm" role="group">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-foreground-muted" />
        <span>
          Give {machineName} a login for {name}
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
            giving.reset();
            starting.reset();
            setSignInId(null);
          }}
          options={kinds}
          ariaLabel={`${name} login`}
        />
      )}
      {kind === 'vertex' && thisComputer && (
        <SegmentedControl
          value={vertexSource}
          onChange={(next) => {
            setVertexSource(next);
            setCredential('');
            setPickedFile(null);
            setPickError(null);
            giving.reset();
          }}
          options={VERTEX_SOURCES}
          ariaLabel="Google credential"
        />
      )}
      <p className="text-xs text-foreground-muted">
        {loginHint(provider, name, kind, vertexSource)}
      </p>
      {kind === 'vertex' && vertexSource === 'this-computer' && (
        <p className="flex items-start gap-2 text-xs" role="note">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          This gives {machineName} all of your Google Cloud access, and agents there run any command
          they choose. A key for a Vertex-only service account gives it only Vertex AI.
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
              placeholder="my-gcp-project"
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
      {kind === 'auth-json' && (
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label={`${name} sign-in file`}
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
      )}
      {kind === 'browser' && (starting.isPending || signInId !== null) && (
        <BrowserSignInPanel
          key={signInId ?? 'starting'}
          machineName={machineName}
          provider={provider}
          providerName={name}
          state={signInState}
          sendCode={(code) => browser!.sendCode(signInId!, code)}
          failureText={failureText}
        />
      )}
      {kind === 'browser' && starting.error && (
        <p className="flex items-start gap-2 text-xs" role="alert">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          {failureText(starting.error, `The sign-in could not be started on ${machineName}.`)}
        </p>
      )}
      {kind !== 'this-computer' &&
        kind !== 'vertex' &&
        kind !== 'auth-json' &&
        kind !== 'browser' && (
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
          Waiting for {machineName} to check the login…
        </p>
      )}
      {result?.state === 'succeeded' && (
        <p className="flex items-center gap-2 text-xs" role="status">
          <CircleCheck className="size-3.5 text-emerald-500" />
          {name} signs in on {machineName}.
        </p>
      )}
      {(pickError || giving.error || result?.state === 'failed') && (
        <p className="flex items-start gap-2 text-xs" role="alert">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          {pickError ??
            (giving.error
              ? String(giving.error instanceof Error ? giving.error.message : giving.error)
              : result?.state === 'failed'
                ? result.message
                : null)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {succeeded ? 'Done' : 'Cancel'}
        </Button>
        {kind === 'browser' && !succeeded && !signingIn && (
          <Button
            size="sm"
            onClick={() => {
              setSignInId(null);
              starting.mutate();
            }}
          >
            {signInId === null && !starting.error ? 'Start sign-in' : 'Start again'}
          </Button>
        )}
        {kind !== 'browser' && !succeeded && (
          <Button
            size="sm"
            disabled={waiting || !ready}
            onClick={() => {
              setOperationId(null);
              giving.mutate();
            }}
          >
            Give login
          </Button>
        )}
      </div>
    </div>
  );
}

function ended(state: BrowserSignInState | undefined): boolean {
  return state?.state === 'succeeded' || state?.state === 'failed';
}
