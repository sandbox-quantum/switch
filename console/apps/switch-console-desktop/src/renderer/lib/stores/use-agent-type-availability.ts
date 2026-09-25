import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';

function agentTypeAvailabilityQueryKey(sshHost: string | undefined) {
  return ['agent-type-availability', sshHost ?? 'local'] as const;
}

/**
 * Every agent type, each carrying whether it can be onboarded here and — when
 * it cannot — why. Drives the onboarding agent-type picker, which shows the
 * whole roster and greys out what is not set up rather than hiding it
 * (CHOO-1809).
 *
 * When `sshHost` is set, availability is resolved on that remote host over SSH
 * rather than on this machine: a type installed locally and absent on the host
 * being targeted is not available *there*, which is the question being asked.
 */
export function useAgentTypeAvailability(sshHost?: string) {
  return useQuery({
    queryKey: agentTypeAvailabilityQueryKey(sshHost),
    queryFn: () =>
      sshHost ? rpc.agentTypes.listAvailabilityRemote(sshHost) : rpc.agentTypes.listAvailability(),
    staleTime: 30_000,
  });
}
