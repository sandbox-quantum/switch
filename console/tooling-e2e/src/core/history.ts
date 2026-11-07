import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** What `properties/history/delivery.py --json` reads of the database, and the properties its rows break. */
export interface HistoryReport {
  rows: number;
  rooms: number;
  events: number;
  agents: number;
  violations: string[];
}

export function parseHistoryReport(output: string): HistoryReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`the history check printed something that is not JSON: ${output.slice(0, 400)}`);
  }
  const report = parsed as Partial<HistoryReport>;
  if (
    typeof report.rows !== 'number' ||
    typeof report.events !== 'number' ||
    !Array.isArray(report.violations)
  ) {
    throw new Error(`the history check's report is missing fields: ${output.slice(0, 400)}`);
  }
  return report as HistoryReport;
}

/**
 * The delivery history check, run against the stack's database after a scenario
 * and before its agents and rooms are deleted, which takes their own events with
 * them. Only on a stack the harness started (it needs the database), so it is
 * off unless `SWITCH_E2E_HISTORY_CHECK` names the command.
 */
export class HistoryCheck {
  /** The most own events any check found, to say the checks looked at something. */
  mostEvents = 0;
  checks = 0;

  private readonly command: string;

  constructor(command: string) {
    this.command = command;
  }

  static fromEnv(env: NodeJS.ProcessEnv): HistoryCheck | null {
    const command = env.SWITCH_E2E_HISTORY_CHECK;
    return command === undefined || command === '' ? null : new HistoryCheck(command);
  }

  async verify(): Promise<void> {
    let stdout: string;
    try {
      ({ stdout } = await run(this.command, ['--json']));
    } catch (error) {
      // A violation exits 1 with its report on stdout; anything else is the check failing to run.
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      if (failed.code !== 1 || !failed.stdout) {
        throw new Error(`the history check could not run: ${failed.stderr ?? String(error)}`);
      }
      stdout = failed.stdout;
    }
    const report = parseHistoryReport(stdout);
    this.checks += 1;
    this.mostEvents = Math.max(this.mostEvents, report.events);
    if (report.violations.length > 0) {
      throw new Error(`the run's history breaks a property:\n  ${report.violations.join('\n  ')}\n`);
    }
  }
}
