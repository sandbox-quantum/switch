import { defineEvent } from '@shared/lib/ipc/events';

export const locationSettingsChangedChannel = defineEvent<{
  locationId: string;
}>('location:settings-changed');
