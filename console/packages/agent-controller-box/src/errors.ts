import type { ReasonCode } from './schemas';

/** A failure that maps to one of the contract's reason codes, for status and operation results. */
export class ReasonedError extends Error {
  constructor(
    readonly reason: ReasonCode,
    message: string
  ) {
    super(message);
    this.name = 'ReasonedError';
  }
}

/**
 * A problem with how the controller was started or set up that starting it
 * again, unchanged, cannot fix: a data directory that belongs to another
 * controller, a missing shared-host bundle, an unsupported platform, no
 * credential on stdin. The CLI exits with code 2 for it, so whatever
 * supervises the process stops instead of retrying.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/** Arguments the CLI cannot run with. A configuration error, answered with the usage text. */
export class UsageError extends ConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
