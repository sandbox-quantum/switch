import { appendFileSync } from 'node:fs';

/**
 * Credentials the server issues during a run — agent API keys, gateway session
 * cookies — written one per line to `SWITCH_E2E_SECRETS_FILE`, so CI can scan
 * the run's output for them before uploading it. On a long-lived deployment
 * they outlive the run, and an opaque token is exactly what a pattern scanner
 * misses. Without the variable nothing is written: a local run uploads nothing.
 */
export class IssuedSecrets {
  private readonly path: string | null;

  constructor(path: string | null) {
    this.path = path;
  }

  record(value: string): void {
    if (this.path === null || value === '') return;
    appendFileSync(this.path, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}
