import type { TelemetryConnectorFailure } from '@main/core/telemetry/events';
import { log } from '@main/lib/logger';
import { getPlugin } from '../providers/plugin-registry';
import type { RegisteredMarketplace } from './switch-setup-cli-dialect';

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
 * This module is the leaf both drivers share. Everything here is either pure or
 * reads the plugin registry; nothing in it touches an execution context. That is
 * what lets the remote driver import it without pulling in the local one, whose
 * module body ends in `new SwitchSetupService()` over a `LocalExecutionContext`.
 * Anything added here has to keep that true. See the same lesson recorded on
 * `telemetry/agent-type.ts`.
 */
export type ConnectorRun = {
  result: SwitchSetupResult;
  failure: TelemetryConnectorFailure;
};

/** Status of an agent type's Switch connector plugin. */
export type SwitchSetupStatus = {
  agentId: string;
  /** False when the agent type declares no Switch setup (kind: 'none'). */
  supported: boolean;
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /**
   * Set when the returned versions are not known to be current: a checkForUpdates
   * marketplace refresh that failed, so they come from the stale local cache, or
   * a status read that could not be answered at all. Null when the status is
   * simply what it says.
   */
  refreshError: string | null;
};

/** Every command a connector driver runs is bounded by this. */
export const EXEC_TIMEOUT_MS = 120_000;

/** Whether a registered marketplace entry points at the expected source. */
export function marketplaceMatchesSource(entry: RegisteredMarketplace, source: string): boolean {
  return entry.source === source;
}

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

/**
 * The status for an agent type that declares no Switch connector, or whose
 * connector nothing here can resolve.
 */
export function unsupportedStatus(agentId: string): SwitchSetupStatus {
  return {
    agentId,
    supported: false,
    installed: false,
    installedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    refreshError: null,
  };
}

/**
 * Whether the agent type declares no Switch connector at all.
 *
 * Such an agent did not *fail* to install one, so the mutating entry points
 * return before their timer starts and report nothing. Without the distinction
 * every agent that has no connector would read as a failing install.
 */
export function declaresNoConnector(agentId: string): boolean {
  return getPlugin(agentId).capabilities.switchSetup.kind === 'none';
}

/** The result those entry points return, which is not reported. */
export const CONNECTOR_UNSUPPORTED_RESULT: SwitchSetupResult = connectorUnsupported().result;

/**
 * An agent that declares a file-based connector and ships no behavior for it.
 *
 * Its own class so the driver can tell it from every other way resolving can
 * fail. A dead SSH channel and a plugin that was authored wrong are different
 * walls, and reporting the first as the second puts a claim about the shipped
 * app on a host-side fault.
 */
export class FilesConnectorUnimplementedError extends Error {
  constructor(agentId: string) {
    super(
      `Agent '${agentId}' declares a file-based Switch connector but implements no behavior for it.`
    );
    this.name = 'FilesConnectorUnimplementedError';
  }
}

/**
 * Run a connector operation so that it always comes back as a result.
 *
 * The drivers resolve a binary over SSH and build a remote filesystem before
 * they reach anything that returns a `ConnectorRun`, and both of those reject on
 * a transport failure rather than reporting absence. Without this the rejection
 * escapes the entry point: no event is emitted for an attempt the user
 * definitely made, and the renderer gets a stack instead of a message. `error`
 * is the residue that has no better name — everything with one is classified
 * before it gets here.
 */
export async function runReportedOperation(
  logPrefix: string,
  agentId: string,
  op: () => Promise<ConnectorRun>
): Promise<ConnectorRun> {
  try {
    return await op();
  } catch (err) {
    log.error(`${logPrefix}: connector operation threw`, { agentId, err });
    return connectorFailed(err instanceof Error ? err.message : String(err), 'error');
  }
}
