import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { CommandRow } from '@renderer/features/settings/agents-page/install-command-row';
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
  cursor: { command: '', file: '', docs: 'https://cursor.com/dashboard/api' },
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
  const localAuthentication = provider !== 'cursor' && kind === 'auth-json';
  const localSignIn = useQuery({
    queryKey: ['local-provider-sign-in', provider],
    queryFn: () => {
      if (provider === 'cursor') throw new Error('Cursor requires an API key.');
      return rpc.switchServers.getLocalProviderSignIn(provider);
    },
    enabled: localAuthentication,
    refetchInterval: localAuthentication ? 2000 : false,
    staleTime: 0,
    retry: false,
  });
  const [credential, setCredential] = useState('');
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
  const attemptedLocalConnection = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
    attemptedLocalConnection.current = true;
    setPending(true);
    setError(null);
    try {
      let saved: CloudProviderConnection | undefined;
      if (remove) await rpc.switchServers.disconnectCloudProvider(serverId, provider);
      else if (localAuthentication)
        saved = await rpc.switchServers.connectLocalProviderSignIn(serverId, provider);
      else
        saved = await rpc.switchServers.connectCloudProvider(serverId, provider, kind, credential);
      if (!mounted.current) return;
      if (saved) queryClient.setQueryData(['cloud-provider', serverId, provider], saved);
      await connection.refetch();
      if (!mounted.current) return;
      if (remove || saved?.status !== 'verifying') {
        setCredential('');
      }
      if (remove) onBack();
      else if (saved?.status === 'connected') onDone();
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  useEffect(() => {
    if (
      localAuthentication &&
      !attemptedLocalConnection.current &&
      !busy &&
      localSignIn.isFetchedAfterMount &&
      !localSignIn.isFetching &&
      !localSignIn.isError &&
      localSignIn.data?.status === 'ready' &&
      connection.isFetchedAfterMount &&
      !connection.isFetching &&
      !connection.isError &&
      connection.data?.status === 'not_connected'
    ) {
      void run(false);
    }
  });
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
                : 'Credential saved. It has not passed a connection check yet.'}
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
            <p className="text-xs text-foreground-muted">Allow about 1–2 minutes for this check.</p>
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
                  ? 'Create a User API Key in your Cursor dashboard.'
                  : 'Create an API key in your OpenAI project. API usage is billed separately from a ChatGPT subscription.'}
              </p>
            ) : (
              <>
                <p>
                  Sign in to {name}
                  {provider === 'codex' ? ' with ChatGPT' : ''} on this computer. Switch checks for
                  your sign-in automatically.
                </p>
                <CommandRow
                  command={
                    localSignIn.data && 'command' in localSignIn.data
                      ? (localSignIn.data.command ?? info.command)
                      : info.command
                  }
                  action={null}
                />
                <p className="font-mono text-xs break-all">{localSignIn.data?.path ?? info.file}</p>
                {provider === 'codex' && (
                  <div className="space-y-2">
                    <p className="text-xs text-foreground-muted">
                      If Codex uses your system keychain, sign in with file storage:
                    </p>
                    <CommandRow
                      command={`codex -c cli_auth_credentials_store='"file"' login`}
                      action={null}
                    />
                  </div>
                )}
                {provider === 'antigravity' && (
                  <p>
                    Use the ACP login installed by Switch. Switch checks GEMINI_HOME when set. A
                    macOS keychain login must first be saved using AGY_ACP_FORCE_FILE_STORAGE=1.
                  </p>
                )}
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => openExternalUrl(info.docs, 'Could not open provider instructions')}
            >
              {provider === 'cursor' ? 'Open API keys' : 'Sign-in instructions'}
            </Button>
          </div>
        )}
        {!verifying &&
          (localAuthentication ? (
            <div className="space-y-2 rounded-lg border p-3 text-sm" role="status">
              {localSignIn.data &&
                'detectionWarning' in localSignIn.data &&
                localSignIn.data.detectionWarning && (
                  <p className="text-muted-foreground">{localSignIn.data.detectionWarning}</p>
                )}
              <p>
                {localSignIn.error
                  ? String(localSignIn.error)
                  : localSignIn.data?.status === 'ready'
                    ? 'Local sign-in found.'
                    : 'Waiting for a local sign-in…'}
              </p>
              <p className="text-xs text-foreground-muted">
                Once found, Switch automatically checks your credential on a temporary cloud worker
                and saves it encrypted for your cloud agents.
              </p>
            </div>
          ) : (
            <Field>
              <FieldLabel>API key</FieldLabel>
              <Input
                type="password"
                autoComplete="off"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
              />
              <FieldDescription>
                Credentials are never shown in chat or stored in the repository.
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
        {(!localAuthentication || error || connection.data?.status === 'failed') && (
          <Button
            disabled={
              busy ||
              (localAuthentication
                ? localSignIn.isError || localSignIn.data?.status !== 'ready'
                : !credential.trim())
            }
            onClick={() => void run(false)}
          >
            {busy
              ? 'Checking connection…'
              : connection.data?.status === 'failed' || localAuthentication
                ? 'Retry connection'
                : 'Save credential'}
          </Button>
        )}
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
