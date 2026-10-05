/**
 * EX_TEMPFAIL, reserved for a hosted worker whose capability Switch no longer
 * accepts: its launch moved to a newer revision. The worker service records
 * the bundle it booted with as obsolete and waits for a current one, so
 * nothing relaunches the daemon on the same bundle.
 */
export const OBSOLETE_BUNDLE_EXIT_CODE = 75;

/** A hosted worker was refused as obsolete; the process exits `OBSOLETE_BUNDLE_EXIT_CODE`. */
export class WorkerObsoleteError extends Error {
  constructor(reason: string) {
    super(`This worker's bundle is obsolete: ${reason}`);
    this.name = 'WorkerObsoleteError';
  }
}
