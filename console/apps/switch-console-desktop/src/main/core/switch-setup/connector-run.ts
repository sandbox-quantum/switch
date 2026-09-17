import type { TelemetryConnectorFailure } from '@main/core/telemetry/events';

/** Outcome of a mutating operation, mirroring the providers controller shape. */
export type SwitchSetupResult = { success: boolean; message?: string };

/**
 * A completed connector operation: what the caller gets back, and the
 * enumerated reason it failed.
 *
 * The two travel together because a `SwitchSetupResult` carries only a message,
 * and a message cannot be reported — so the code has to be named where the
 * failure is known rather than recovered from the text afterwards.
 *
 * This is a leaf on purpose. Both the local and the remote driver build these,
 * and the local one's module ends in `new SwitchSetupService()` over a
 * `LocalExecutionContext` — so putting the constructors there made the remote
 * driver import a local execution context to get three pure functions. See the
 * same lesson recorded on `telemetry/agent-type.ts`.
 */
export type ConnectorRun = {
  result: SwitchSetupResult;
  failure: TelemetryConnectorFailure;
};

/** A connector operation that did what was asked. */
export function connectorSucceeded(): ConnectorRun {
  return { result: { success: true }, failure: 'none' };
}

export function connectorFailed(message: string, failure: TelemetryConnectorFailure): ConnectorRun {
  return { result: { success: false, message }, failure };
}

/** The answer for an agent whose connector nothing here can manage. */
export function connectorUnsupported(): ConnectorRun {
  return connectorFailed('Switch setup is not supported for this agent.', 'unsupported');
}
