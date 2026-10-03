import type { HostControllerStateEvent } from '@shared/core/host-controllers/host-controllers';
import { defineEvent } from '@shared/lib/ipc/events';

/** The agents controller on an SSH host changed: installed, removed, or a step of either. */
export const hostControllerStateChannel =
  defineEvent<HostControllerStateEvent>('host-controller:state');
