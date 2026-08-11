import type { FileWatchEvent } from '@shared/core/fs/fs';
import { defineEvent } from '@shared/lib/ipc/events';

export const fsWatchEventChannel = defineEvent<{
  locationId: string;
  events: FileWatchEvent[];
}>('fs:watch-event');
