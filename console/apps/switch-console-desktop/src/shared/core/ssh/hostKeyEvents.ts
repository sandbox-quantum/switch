import { defineEvent } from '@shared/lib/ipc/events';
import type { HostKeyProblem } from './host-keys';

/** The host keys waiting for a decision, pushed whole on every change. */
export const hostKeyProblemsChannel = defineEvent<HostKeyProblem[]>('ssh:host-key-problems');
