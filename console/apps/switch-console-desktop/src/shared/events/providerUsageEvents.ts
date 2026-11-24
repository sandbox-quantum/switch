import type { ProviderUsageState } from '@shared/core/provider-usage/provider-usage';
import { defineEvent } from '@shared/lib/ipc/events';

export const providerUsageUpdatedChannel =
  defineEvent<ProviderUsageState>('provider-usage:updated');
