import type { ProviderAdapter } from '../adapter';
import type { ProviderLogger } from '../transport/stdio-json-rpc';

export interface PiAdapterOptions {
  /** The Pi executable; `pi` on PATH when undefined. */
  binaryPath?: string | undefined;
  logger?: ProviderLogger;
}

/**
 * STAGE-5 PLACEHOLDER (#777 plan, stage 6 leaves it): the registry entry
 * needs a factory to name. The adapter itself (sessions, queue, interrupt,
 * resume, models, approvals) is stage 5 and replaces this whole body; until
 * then every Pi session fails here, before any Pi is started.
 */
export function createPiAdapter(_options: PiAdapterOptions = {}): ProviderAdapter {
  throw new Error('Pi adapter: not implemented (stage 5).');
}
