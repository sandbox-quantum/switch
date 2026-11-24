import type { ProviderSubscriptionUsageSnapshot } from '@switch-console/agent-providers';

export interface ProviderUsageState {
  revision: number;
  installedProviderIds: string[];
  refreshingProviderIds: string[];
  snapshots: ProviderSubscriptionUsageSnapshot[];
}
