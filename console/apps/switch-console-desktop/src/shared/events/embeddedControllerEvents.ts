import type { EmbeddedControllerStateEvent } from '@shared/core/embedded-controller/embedded-controller';
import { defineEvent } from '@shared/lib/ipc/events';

/** The embedded agent controller for a server changed phase. */
export const embeddedControllerStateChannel = defineEvent<EmbeddedControllerStateEvent>(
  'embedded-controller:state'
);
