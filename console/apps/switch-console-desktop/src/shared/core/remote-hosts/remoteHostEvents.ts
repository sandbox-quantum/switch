import { defineEvent } from '@shared/lib/ipc/events';
import type { HostReachability } from './reachability';
import type { HostSetupActivity, HostSetupPlan } from './setup';

/** Pushed to the renderer on every plan transition, so the UI never polls. */
export const hostSetupPlanEventChannel = defineEvent<HostSetupPlan>('remote-hosts:setup-changed');

export const hostSetupActivityEventChannel = defineEvent<HostSetupActivity>(
  'remote-hosts:setup-activity'
);

/** Pushed to the renderer whenever a host's reachability record changes. */
export const hostReachabilityEventChannel = defineEvent<HostReachability>(
  'remote-hosts:reachability-changed'
);
