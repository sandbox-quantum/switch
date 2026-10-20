import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { BUILD_FEATURE_FLAGS } from '@shared/core/feature-flags/feature-flags';
import { buddyIsPending } from './buddy-identity';

/** @see buddyIsPending, on the server given. */
export function useBuddyPending(serverId: string | null): boolean {
  const flags = useFeatureFlags(serverId);
  const agents = useManagedAgents(serverId);
  return buddyIsPending({
    onboardingBuilt: BUILD_FEATURE_FLAGS.onboarding,
    serverId,
    flags,
    agents: agents.data,
  });
}
