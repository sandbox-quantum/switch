import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { MachineLoginInput, OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  type AgentProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';

type LoginKind = 'setup-token' | 'api-key' | 'this-computer';

/** The ways a machine can be given each provider's login. */
export function loginKindsFor(provider: AgentProviderId): { value: LoginKind; label: string }[] {
  switch (provider) {
    case 'claude':
      return [
        { value: 'setup-token', label: 'Setup token' },
        { value: 'api-key', label: 'API key' },
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

function hint(provider: AgentProviderId, kind: LoginKind): string {
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
  const [operationId, setOperationId] = useState<string | null>(null);
  const name = displayName(provider);

  const give = useMutation({
    mutationFn: () => {
      const login: MachineLoginInput =
        kind === 'this-computer'
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
            give.reset();
          }}
          options={kinds}
          ariaLabel={`${name} login`}
        />
      )}
      <p className="text-xs text-foreground-muted">{hint(provider, kind)}</p>
      {kind !== 'this-computer' && (
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
      {(give.error || result?.state === 'failed') && (
        <p className="flex items-start gap-2 text-xs" role="alert">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          {give.error
            ? String(give.error instanceof Error ? give.error.message : give.error)
            : result?.state === 'failed'
              ? result.message
              : null}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {result?.state === 'succeeded' ? 'Done' : 'Cancel'}
        </Button>
        {result?.state !== 'succeeded' && (
          <Button
            size="sm"
            disabled={waiting || (kind !== 'this-computer' && !credential.trim())}
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
