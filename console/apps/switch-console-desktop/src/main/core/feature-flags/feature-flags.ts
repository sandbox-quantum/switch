import { fetchFeatureFlags } from '@main/core/switch-servers/gateway-client';
import { listServers } from '@main/core/switch-servers/servers-store';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { featureFlagsChangedChannel } from '@shared/events/featureFlagEvents';
import { FEATURE_FLAGS_POLL_INTERVAL_MS, FeatureFlagsService } from './feature-flags-service';

export const featureFlagsService = new FeatureFlagsService({
  listServers,
  fetchFlags: fetchFeatureFlags,
  onChange: (state) => events.emit(featureFlagsChangedChannel, state),
  warn: (message, error) => log.warn(message, error),
  intervalMs: FEATURE_FLAGS_POLL_INTERVAL_MS,
});
