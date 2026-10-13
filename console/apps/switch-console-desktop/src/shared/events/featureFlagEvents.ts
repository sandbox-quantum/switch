import type { ServerFeatureFlags } from '@shared/core/feature-flags/feature-flags';
import { defineEvent } from '@shared/lib/ipc/events';

/** A server's feature flags changed, or reading them started or stopped failing. */
export const featureFlagsChangedChannel = defineEvent<ServerFeatureFlags>('feature-flags:changed');
