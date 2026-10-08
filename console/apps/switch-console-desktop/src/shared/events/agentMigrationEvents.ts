import type { AgentMigrationEvent } from '@shared/core/agent-migration/agent-migration';
import { defineEvent } from '@shared/lib/ipc/events';

/** An agent moved to or from managed, or a move or return reached a new stage. */
export const agentMigrationChannel = defineEvent<AgentMigrationEvent>('agent-migration:state');
