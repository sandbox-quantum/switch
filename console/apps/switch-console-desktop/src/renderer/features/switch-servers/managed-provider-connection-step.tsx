import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel, FieldDescription } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Spinner } from '@renderer/lib/ui/spinner';
import {
  providerDisplayName,
  type AgentProviderId,
} from '@shared/core/providers/agent-provider-registry';
import type { CloudProviderConnection } from '@shared/core/switch-servers/provider-credential';
import { ManagedClaudeConnectionStep } from './managed-claude-connection-step';

const instructions = {
  codex: {
    command: 'codex login',
    file: '~/.codex/auth.json',
    docs: 'https://developers.openai.com/codex/auth/',
  },
  cursor: { command: '', file: '', docs: 'https://cursor.com/docs/cli/reference/authentication' },
  opencode: {
    command: 'opencode auth login',
    file: '~/.local/share/opencode/auth.json',
    docs: 'https://opencode.ai/docs/providers/',
  },
  antigravity: {
    command: 'antigravity-acp --login',
    file: '~/.local/state/switch/antigravity-acp/antigravity-acp/acp_token.json',
    docs: 'https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp',
  },
};

export function ManagedProviderConnectionStep({
  serverId,
  provider,
  onBack,
  onDone,
  context,
}: {
  serverId: string;
  provider: AgentProviderId;
  onBack: () => void;
  onDone: () => void;
  context: 'onboarding' | 'settings';
}) {
  if (provider === 'claude')
    return (
      <ManagedClaudeConnectionStep
        serverId={serverId}
        onBack={onBack}
        onDone={onDone}
        context={context}
      />
    );
  return (
    <OtherProviderConnectionStep
      key={`${serverId}:${provider}`}
      serverId={serverId}
      provider={provider}
      onBack={onBack}
      onDone={onDone}
      context={context}
    />
  );
}

function OtherProviderConnectionStep({
  serverId,
  provider,
  onBack,
  onDone,
  context,
}: {
  serverId: string;
  provider: Exclude<AgentProviderId, 'claude'>;
  onBack: () => void;
  onDone: () => void;
  context: 'onboarding' | 'settings';
}) {
  const [kind, setKind] = useState<'api-key' | 'auth-json'>(
    provider === 'codex' || provider === 'cursor' ? 'api-key' : 'auth-json'
  );
  const localSubscription = provider === 'codex' && kind === 'auth-json';
  const localSignIn = useQuery({
    queryKey: ['local-codex-subscription'],
    queryFn: () => rpc.switchServers.getLocalCodexSubscription(),
    enabled: localSubscription,
    refetchInterval: localSubscription ? 2000 : false,
    staleTime: 0,
    retry: false,
  });
  const [credential, setCredential] = useState('');
  const [filename, setFilename] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = useQuery({
    queryKey: ['cloud-provider', serverId, provider],
    refetchInterval: (query) => (query.state.data?.status === 'verifying' ? 2000 : false),
    queryFn: () => rpc.switchServers.getCloudProviderConnection(serverId, provider),
    retry: false,
  });
  const queryClient = useQueryClient();
  const wasVerifying = useRef(false);
  useEffect(() => {
    const status = connection.data?.status;
    if (status === 'verifying') wasVerifying.current = true;
    else if (status === 'connected' && wasVerifying.current) {
      wasVerifying.current = false;
      onDone();
    } else if (status === 'failed') wasVerifying.current = false;
  }, [connection.data?.status, onDone]);
  const verifying = connection.data?.status === 'verifying';
  const busy = pending || verifying;
  const info = instructions[provider];
  const name = providerDisplayName(provider);
  const run = async (remove: boolean) => {
    setPending(true);
    setError(null);
    try {
      let saved: CloudProviderConnection | undefined;
      if (remove) await rpc.switchServers.disconnectCloudProvider(serverId, provider);
      else if (localSubscription)
        saved = await rpc.switchServers.connectLocalCodexSubscription(serverId);
      else
        saved = await rpc.switchServers.connectCloudProvider(serverId, provider, kind, credential);
      if (saved) queryClient.setQueryData(['cloud-provider', serverId, provider], saved);
      await connection.refetch();
      if (remove || saved?.status !== 'verifying') {
        setCredential('');
        setFilename('');
      }
      if (!remove && saved?.status !== 'verifying') onDone();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect {name}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        {connection.data &&
          (connection.data.status === 'connected' || connection.data.status === 'configured') && (
            <div className="rounded-lg border p-3 text-sm">
              {connection.data.status === 'connected'
                ? 'Verified on a cloud worker.'
                : 'Credential saved. Switch will verify it on the worker before the agent becomes ready.'}
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => void run(true)}>
                Disconnect
              </Button>
            </div>
          )}
        {verifying && (
          <div role="status" className="space-y-2 rounded-lg border p-3 text-sm">
            <p className="flex items-center gap-2">
              <Spinner /> Checking connection…
            </p>
            <p className="text-xs text-foreground-muted">
              Switch is starting a temporary worker and sending a short test request. It will shut
              down automatically. You can leave this screen while the check runs.
            </p>
          </div>
        )}
        {connection.data?.status === 'failed' && (
          <p role="alert" className="text-sm text-destructive">
            {connection.data.error}
          </p>
        )}
        {!verifying && provider === 'codex' && (
          <SegmentedControl
            value={kind}
            onChange={(next) => {
              setKind(next);
              setCredential('');
              setFilename('');
              setError(null);
            }}
            options={[
              { value: 'api-key', label: 'API key' },
              { value: 'auth-json', label: 'Subscription' },
            ]}
            ariaLabel="Codex authentication"
          />
        )}
        {!verifying && (
          <div className="space-y-3 rounded-lg border bg-background-tertiary p-4 text-sm">
            {kind === 'api-key' ? (
              <p>
                {provider === 'cursor'
                  ? 'Create a User API Key in your Cursor dashboard under Integrations.'
                  : 'Create an API key in your OpenAI project. API usage is billed separately from a ChatGPT subscription.'}
              </p>
            ) : (
              <>
                <p>
                  {localSubscription
                    ? 'Sign in to Codex with ChatGPT on this computer. Switch checks for your sign-in automatically.'
                    : 'Sign in locally, then choose the authentication file below. It will be encrypted on Switch and copied only to your worker.'}
                </p>
                <code className="bg-background-primary block rounded border px-3 py-2 font-mono">
                  {info.command}
                </code>
                <p className="font-mono text-xs break-all">
                  {localSubscription ? (localSignIn.data?.path ?? info.file) : info.file}
                </p>
                {localSubscription && (
                  <p className="text-xs text-foreground-muted">
                    If Codex uses your system keychain, sign in with file storage using{' '}
                    <code>codex -c cli_auth_credentials_store='"file"' login</code>.
                  </p>
                )}
                {provider === 'antigravity' && (
                  <p>
                    Use the ACP login. If you set GEMINI_HOME, choose antigravity-acp/acp_token.json
                    inside that directory. A macOS keychain login must first be saved using
                    AGY_ACP_FORCE_FILE_STORAGE=1.
                  </p>
                )}
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => openExternalUrl(info.docs, 'Could not open provider instructions')}
            >
              Sign-in instructions
            </Button>
          </div>
        )}
        {!verifying &&
          (localSubscription ? (
            <div className="space-y-2 rounded-lg border p-3 text-sm" role="status">
              <p>
                {localSignIn.error
                  ? String(localSignIn.error)
                  : localSignIn.data?.status === 'ready'
                    ? 'Local subscription sign-in found.'
                    : 'Waiting for a local subscription sign-in…'}
              </p>
              <p className="text-xs text-foreground-muted">
                Use local sign-in saves your credential encrypted on Switch for your cloud workers.
                Switch will run a short connection check before saving it.
              </p>
            </div>
          ) : (
            <Field>
              <FieldLabel>{kind === 'api-key' ? 'API key' : 'Authentication file'}</FieldLabel>
              {kind === 'api-key' ? (
                <Input
                  type="password"
                  autoComplete="off"
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                />
              ) : (
                <input
                  aria-label="Authentication file"
                  type="file"
                  accept=".json,application/json"
                  onChange={async (event) => {
                    setCredential('');
                    setFilename('');
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > 16384) {
                      setError('Choose an authentication file smaller than 16 KiB.');
                      return;
                    }
                    try {
                      const value = await file.text();
                      JSON.parse(value);
                      setCredential(value);
                      setFilename(file.name);
                      setError(null);
                    } catch {
                      setError('Choose a valid JSON authentication file.');
                    }
                  }}
                />
              )}
              <FieldDescription>
                {filename || 'Credentials are never shown in chat or stored in the repository.'}
              </FieldDescription>
            </Field>
          ))}
        {(error || connection.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error || String(connection.error)}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onBack} disabled={pending}>
          Back
        </Button>
        <Button
          disabled={
            busy ||
            (localSubscription
              ? localSignIn.isError || localSignIn.data?.status !== 'ready'
              : !credential.trim())
          }
          onClick={() => void run(false)}
        >
          {busy
            ? 'Checking connection…'
            : connection.data?.status === 'failed'
              ? 'Retry connection'
              : localSubscription
                ? 'Use local sign-in'
                : 'Save credential'}
        </Button>
        <Button
          disabled={
            busy ||
            !connection.data ||
            !['connected', 'configured'].includes(connection.data.status)
          }
          onClick={onDone}
        >
          {context === 'settings' ? 'Done' : 'Continue'}
        </Button>
      </DialogFooter>
    </>
  );
}
