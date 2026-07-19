import type { AgentStatus, NotificationType } from '@shared/core/providers/agentEvents';
import type { Session } from '@shared/core/sessions/sessions';
import { defineEvent } from '@shared/lib/ipc/events';

export const sessionCreatedChannel = defineEvent<{ session: Session }>('session:created');

export const sessionChangedChannel = defineEvent<{
  sessionId: string;
  changes: Partial<Pick<Session, 'lastInteractedAt' | 'title' | 'providerSessionId'>>;
}>('session:changed');

export const sessionAgentStatusChangedChannel = defineEvent<{
  sessionId: string;
  status: AgentStatus;
  seen: boolean;
  soundEvent?: 'needs_attention' | 'session_complete';
  /**
   * For status changes driven by a notification hook, the specific kind. Lets
   * consumers distinguish an idle agent waiting at its prompt (`idle_prompt`)
   * from one genuinely blocked on a dialog (`permission_prompt`), which both map
   * to the `awaiting-input` status.
   */
  notificationType?: NotificationType;
}>('session:agent-status-changed');

/**
 * A session was removed by the main process out-of-band — i.e. NOT by this
 * renderer initiating a delete (which updates its own store). Emitted when a
 * remote client terminates a shared session or the reconciler prunes a VM
 * session the sidecar stopped reporting, so every attached window drops the
 * row from its sidebar instead of showing a ghost until restart (CHOO-1181).
 */
export const sessionDeletedChannel = defineEvent<{
  sessionId: string;
}>('session:deleted');

export const sessionStatusUpdatedChannel = defineEvent<{
  sessionId: string;
  status: string;
}>('session:status-updated');

export type ProvisionStep =
  | 'initialising-location'
  | 'running-provision-script'
  | 'connecting'
  | 'starting-sessions';

export const sessionProvisionProgressChannel = defineEvent<{
  sessionId: string;
  step: ProvisionStep;
  message: string;
}>('session:provision-progress');

export type LifecycleScriptType = 'setup' | 'run' | 'teardown';
export type LifecycleScriptOrigin = 'auto-setup' | 'auto-run' | 'manual' | 'location-destroy';

export type LifecycleScriptStatusEvent = {
  sessionId: string;
  locationId: string;
  type: LifecycleScriptType;
  origin: LifecycleScriptOrigin;
} & (
  | { status: 'running' }
  | { status: 'succeeded'; exitCode?: number }
  | {
      status: 'failed';
      message: string;
      surfaceFailure: boolean;
      exitCode?: number;
      signal?: string | number;
    }
  | { status: 'stopped'; message?: string }
);

export const lifecycleScriptStatusChannel = defineEvent<LifecycleScriptStatusEvent>(
  'session:lifecycle-script-status'
);

export const sessionProvisionedChannel = defineEvent<{
  sessionId: string;
  path: string;
  locationId: string;
  sshConnectionId?: string;
}>('session:provisioned');
