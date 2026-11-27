import { GiveMachineLogin as GiveLogin } from '@switch-console/chat-ui/components/give-machine-login';
import { providerLoginKinds } from '@switch-console/chat-ui/model/provider-catalogue';
import { Button } from '@switch-console/chat-ui/primitives/button';
import { Spinner } from '@switch-console/chat-ui/primitives/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { MachineSealingKey, OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  type AgentProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';

function Fingerprint({ value }: { value: string }) {
  return <code className="font-mono text-[11px] text-foreground">{value}</code>;
}

/**
 * Where the login goes: the fingerprint of the key it is sealed to, and why
 * Console takes that key for the machine's. A key Switch changed since the
 * first login is shown beside the old one, and sealed to only once trusted.
 */
function SealingKeyNote({
  machineName,
  sealingKey,
  error,
  trusting,
  trustError,
  onTrust,
}: {
  machineName: string;
  sealingKey: MachineSealingKey | undefined;
  error: unknown;
  trusting: boolean;
  trustError: unknown;
  onTrust: (fingerprint: string) => void;
}) {
  if (error)
    return (
      <p className="flex items-start gap-2 text-xs" role="alert">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        {failureText(error, `Could not look up ${machineName}’s key.`)}
      </p>
    );
  if (!sealingKey)
    return (
      <p className="flex items-center gap-2 text-xs text-foreground-muted" role="status">
        <Spinner className="size-3.5" />
        Looking up {machineName}’s key…
      </p>
    );
  switch (sealingKey.state) {
    case 'verified':
      return (
        <p className="flex items-start gap-2 text-xs text-foreground-muted" role="note">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
          <span>
            Sealed to {machineName}’s key <Fingerprint value={sealingKey.fingerprint} />
            {sealingKey.source === 'machine'
              ? ', read from the machine itself.'
              : ', the one Console sealed its first login to.'}
          </span>
        </p>
      );
    case 'first-use':
      return (
        <p className="flex items-start gap-2 text-xs text-foreground-muted" role="note">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Sealed to the key Switch reports for {machineName}:{' '}
            <Fingerprint value={sealingKey.fingerprint} />. Console remembers it and refuses
            another. To be sure it is the machine’s, compare it with the login key{' '}
            <code>switch-agent-controller status</code> shows there.
          </span>
        </p>
      );
    case 'changed':
      return (
        <div className="space-y-2 rounded-md border border-amber-500/40 p-2 text-xs" role="alert">
          <p className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            <span>
              {machineName}’s key changed. Console sealed its logins to{' '}
              <Fingerprint value={sealingKey.previousFingerprint} />, and Switch now sends{' '}
              <Fingerprint value={sealingKey.fingerprint} />. A machine keeps its key until it is
              enrolled again, which makes it a new machine, so whoever runs the server may be trying
              to read the login. Compare the new key with{' '}
              <code>switch-agent-controller status</code> on the machine before trusting it.
            </span>
          </p>
          {trustError ? (
            <p className="text-foreground-muted">
              {failureText(trustError, 'Could not trust the new key.')}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={trusting}
              onClick={() => onTrust(sealingKey.fingerprint)}
            >
              Trust the new key
            </Button>
          </div>
        </div>
      );
    case 'refused':
      return (
        <p className="flex items-start gap-2 text-xs" role="alert">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          {sealingKey.reason}
        </p>
      );
  }
}

/**
 * Gives a machine a provider login, on demand: sealed in Console to the
 * machine's own key (read from it, or the one Console pinned the first time),
 * so the server only relays it, and taken up by the machine at once. Says
 * whether the provider signs in with it there.
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
  const sealingKeyQueryKey = [MANAGED_AGENTS_KEY, serverId, 'sealing-key', machine.id];
  const sealingKey = useQuery({
    queryKey: sealingKeyQueryKey,
    queryFn: () => rpc.managedAgents.machineSealingKey({ serverId, machineId: machine.id }),
    staleTime: 0,
  });
  const trust = useMutation({
    mutationFn: (fingerprint: string) =>
      rpc.managedAgents.trustMachineSealingKey({ serverId, machineId: machine.id, fingerprint }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: sealingKeyQueryKey }),
  });
  const key = sealingKey.data;
  const sealTo =
    key && (key.state === 'verified' || key.state === 'first-use') ? key.fingerprint : null;

  return (
    <GiveLogin
      machineName={machine.name}
      provider={provider}
      providerName={providerDisplayName(provider) ?? provider}
      kinds={providerLoginKinds(provider, true)}
      thisComputer
      queryKey={[MANAGED_AGENTS_KEY, serverId]}
      give={async (login) => {
        if (sealTo === null) throw new Error(`There is no key to seal ${machine.name}’s login to.`);
        try {
          return (
            await rpc.managedAgents.giveMachineLogin({
              serverId,
              machineId: machine.id,
              provider,
              login,
              fingerprint: sealTo,
            })
          ).operationId;
        } catch (error) {
          // A refusal may be a key that changed since it was shown.
          void queryClient.invalidateQueries({ queryKey: sealingKeyQueryKey });
          throw error;
        }
      }}
      outcome={(operationId) =>
        rpc.managedAgents.machineLoginOutcome({ serverId, machineId: machine.id, operationId })
      }
      failureText={failureText}
      sealing={{
        ready: sealTo !== null,
        note: (
          <SealingKeyNote
            machineName={machine.name}
            sealingKey={key}
            error={sealingKey.error}
            trusting={trust.isPending}
            trustError={trust.error}
            onTrust={(fingerprint) => trust.mutate(fingerprint)}
          />
        ),
      }}
      onClose={onClose}
    />
  );
}
