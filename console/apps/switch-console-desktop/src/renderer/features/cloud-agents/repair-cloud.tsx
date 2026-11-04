import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { GiveMachineLogin } from '@renderer/features/locations/components/add-agent-modal/give-machine-login';
import { useOwnedMachines } from '@renderer/features/managed-agents/use-managed-agents';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import {
  copiedLoginLine,
  REPAIR_FAILED,
  type ResealResult,
} from '@shared/core/managed-agents/repair';
import {
  isValidProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';
import { CLOUD_MACHINES_KEY } from './use-cloud-agents';

// V3b, Repair my cloud (design v1.2; the designer's copy, word for word). Two moments: the
// owner's Repair button, shown only when Core says a repair would be accepted, and afterwards
// the re-seal, which the main process does by itself where it may, or asks for.

export const RESEAL_KEY = 'v3b-reseal';

const COPY = {
  needsRepair: 'Your cloud needs repairing',
  button: 'Repair my cloud',
  title: 'Repair your cloud?',
  whatHappens:
    "Your cloud lost its saved settings and needs setting up again as the same box. Your agents and their work aren't touched. Repair doesn't work on a cloud that Switch has paused or your admin has turned off.",
  // One line per provider copied (`copiedLoginLine`), then this one under them, grey.
  loginSealed: 'Your AI login is sealed so only your cloud can read it.',
  loginTyped:
    "Switch doesn't keep pasted keys, so you'll be asked to enter your key again once your cloud is repaired.",
  copying: 'Setting up your AI login again…',
  done: 'Your cloud is repaired and your AI login is back. Your agents can reply again.',
  keyNeeded: 'Your cloud is repaired. Enter your AI key again to let your agents reply.',
  setUp: 'Set up AI provider',
} as const;
export const REPAIR_COPY = COPY;

/** The re-seal this Console ran for the machine's current controller, if it has: the agent card's
 * "Finishing your cloud's repair" line shows only before any has. */
export function useResealResult(
  serverId: string | null,
  machine: Pick<CloudMachine, 'machine_id' | 'controller_id'> | null
): ResealResult | undefined {
  return useQuery<ResealResult>({
    queryKey: [RESEAL_KEY, serverId, machine?.machine_id, machine?.controller_id],
    queryFn: () => Promise.reject(new Error('read only')),
    enabled: false,
  }).data;
}

export function RepairCloud({ machine, serverId }: { machine: CloudMachine; serverId: string }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCopied, setLastCopied] = useState(false);
  const [giving, setGiving] = useState<string | null>(null);
  const resealWanted = (machine.reseal_providers ?? []).length > 0;
  const controllerId = machine.controller_id;

  const sources = useQuery({
    queryKey: [RESEAL_KEY, 'sources', controllerId],
    queryFn: () => rpc.managedAgents.loginSources({ controllerId: controllerId ?? '' }),
    enabled: confirming && controllerId !== null,
  });
  const reseal = useQuery<ResealResult>({
    queryKey: [RESEAL_KEY, serverId, machine.machine_id, controllerId],
    queryFn: () => rpc.managedAgents.resealAfterRepair({ serverId, machineId: machine.machine_id }),
    enabled: resealWanted && controllerId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const owned = useOwnedMachines(serverId);
  useEffect(() => {
    if (reseal.data && reseal.data.copied.length > 0) setLastCopied(true);
  }, [reseal.data]);

  const repair = async () => {
    if (!controllerId) return;
    setPending(true);
    setError(null);
    try {
      await rpc.managedAgents.repairCloud({
        serverId,
        machineId: machine.machine_id,
        controllerId,
      });
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: [CLOUD_MACHINES_KEY] });
    } catch (failure) {
      // The main process only ever throws one of its fixed lines here.
      setError(failure instanceof Error && failure.message ? failure.message : REPAIR_FAILED);
    } finally {
      setPending(false);
    }
  };

  const ownedMachine = owned.data?.find((candidate) => candidate.id === controllerId) ?? null;
  const views = Object.entries(sources.data ?? {});
  const copiedHere = views.filter(([, view]) => view.kind === 'this-computer');
  const typed = views.some(([, view]) => view.kind === 'typed');

  if (resealWanted && reseal.isFetching)
    return <p className="mt-2 text-xs text-foreground-muted">{COPY.copying}</p>;
  // The ones still waiting, from Core's current note rather than the cached run: Core drops a
  // provider once its login is given again, so each one left can be reached (QA). One this run
  // has just copied is left out while Core catches up.
  const copied = reseal.data?.copied ?? [];
  const waiting = reseal.data
    ? (machine.reseal_providers ?? []).filter((provider) => !copied.includes(provider))
    : [];
  if (resealWanted && waiting.length > 0)
    return (
      <div className="mt-2 space-y-2">
        <p className="text-xs">{COPY.keyNeeded}</p>
        {giving && ownedMachine && isValidProviderId(giving) ? (
          <GiveMachineLogin
            serverId={serverId}
            machine={ownedMachine}
            provider={giving}
            onClose={() => setGiving(null)}
          />
        ) : (
          // One button per provider still waiting, so each one can be reached (designer).
          <div className="flex flex-wrap gap-1">
            {waiting.map((provider) => (
              <Button
                key={provider}
                variant="outline"
                size="sm"
                onClick={() => setGiving(provider)}
              >
                {waiting.length === 1
                  ? COPY.setUp
                  : `Set up ${providerDisplayName(provider) ?? provider}`}
              </Button>
            ))}
          </div>
        )}
      </div>
    );
  if (!resealWanted && lastCopied) return <p className="mt-2 text-xs">{COPY.done}</p>;
  if (machine.repair_available !== true || !controllerId) return null;

  return (
    <div className="mt-2 space-y-2">
      {!confirming ? (
        <div className="flex items-center gap-2">
          <p className="text-xs text-foreground-warning">{COPY.needsRepair}</p>
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            {COPY.button}
          </Button>
        </div>
      ) : (
        <div
          role="dialog"
          aria-label={COPY.title}
          className="max-w-[420px] space-y-2 rounded-md border p-3"
        >
          <p className="text-sm font-medium">{COPY.title}</p>
          <p className="text-xs">{COPY.whatHappens}</p>
          {copiedHere.length > 0 && (
            <div className="space-y-0.5">
              {/* Plain text only: the label is this computer's own, capped and never markup. */}
              {copiedHere.map(([provider, view]) => (
                <p key={provider} className="text-xs">
                  {copiedLoginLine(providerDisplayName(provider) ?? provider, view.label)}
                </p>
              ))}
              <p className="text-xs text-foreground-muted">{COPY.loginSealed}</p>
            </div>
          )}
          {typed && <p className="text-xs">{COPY.loginTyped}</p>}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void repair()} disabled={pending}>
              Repair
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
