import { INSTALL_METHODS } from '@switch-console/core/deps';
import {
  AGENT_REMOVE_TRIGGERS,
  ROOM_AGENTS_DIRECTIONS,
  SESSION_PROVISION_TRIGGERS,
  SESSION_START_SOURCES,
  UI_ENTRY_POINTS,
  UPDATE_TRIGGERS,
} from '@shared/core/telemetry/reporting';
import type {
  TelemetryAgentRemoveTrigger,
  TelemetryEntryPoint,
  TelemetryInstallMethod,
  TelemetryRoomAgentsDirection,
  TelemetrySessionProvisionTrigger,
  TelemetrySessionStartSource,
  TelemetryUpdateTrigger,
} from './events';

/**
 * Dimensions the interface supplies, checked rather than trusted.
 *
 * The events the renderer reports directly go through a schema in
 * `./renderer-events`, on the stated grounds that a type does not survive a
 * process boundary. These values cross the same boundary — they ride along on
 * ordinary operations like "add this agent" or "retry this session" — and the
 * reasoning does not stop applying because the event is emitted from the main
 * process. Nothing validates an RPC argument at the boundary itself, so this is
 * where it happens.
 *
 * Every one falls back rather than throwing. A wrong value is a bug in a call
 * site, not something to fail a user's operation over — and reporting it as
 * unrecognised is what makes the bug visible instead of putting free text in a
 * payload.
 */

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function entryPointOf(value: unknown): TelemetryEntryPoint {
  return oneOf(UI_ENTRY_POINTS, value, 'unknown');
}

export function startSourceOf(value: unknown): TelemetrySessionStartSource {
  return oneOf(SESSION_START_SOURCES, value, 'user');
}

/**
 * `initial` is the honest fallback: an unrecognised trigger is not evidence
 * anybody retried anything, and `initial` is the value that reports nothing.
 */
export function provisionTriggerOf(value: unknown): TelemetrySessionProvisionTrigger | 'initial' {
  return oneOf(SESSION_PROVISION_TRIGGERS, value, 'initial');
}

export function agentRemoveTriggerOf(value: unknown): TelemetryAgentRemoveTrigger {
  return oneOf(AGENT_REMOVE_TRIGGERS, value, 'user');
}

export function roomAgentsDirectionOf(value: unknown): TelemetryRoomAgentsDirection {
  return oneOf(ROOM_AGENTS_DIRECTIONS, value, 'agents_to_room');
}

export function updateTriggerOf(value: unknown): TelemetryUpdateTrigger {
  return oneOf(UPDATE_TRIGGERS, value, 'user');
}

export function installMethodOf(value: unknown): TelemetryInstallMethod {
  return oneOf<TelemetryInstallMethod>([...INSTALL_METHODS, 'unspecified'], value, 'unspecified');
}
