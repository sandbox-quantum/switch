import type { InstallMethod } from '@switch-console/core/deps';
import { agentTypeOf } from './agent-type';
import { cliFailureReason } from './cli-failure';
import { startTimer } from './duration';
import type { TelemetryCliAction, TelemetryDurationMs } from './events';
import { installMethodOf } from './narrow';
import { trackEvent } from './telemetry-service';

/** As much of a dependency operation's result as reporting needs. */
type CliActionResult = { success: boolean; error?: { type?: string } };

/** Where the CLI is being installed. The host itself is never named. */
type CliActionTarget = 'local' | 'remote';

function report(
  action: TelemetryCliAction,
  target: CliActionTarget,
  id: string,
  method: InstallMethod | undefined,
  result: CliActionResult,
  durationMs: TelemetryDurationMs
): void {
  trackEvent('agent_cli_action', {
    // The id may be a core dependency rather than an agent, so it goes through
    // the same narrowing as anywhere else and reports `unknown` when it names
    // no provider.
    agent_type: agentTypeOf(id),
    target,
    install_method: installMethodOf(method),
    action,
    outcome: result.success ? 'success' : 'failure',
    failure_reason: cliFailureReason(result),
    duration_ms: durationMs,
  });
}

/**
 * Run a dependency operation — installing, updating or removing an agent's own
 * CLI — and report it whether or not it came back.
 *
 * The event's denominator is attempts. These operations return a `Result`
 * rather than raising, but that is a convention and not a type: one that raises
 * took its attempt out of the count altogether, which is not a failure showing
 * up in the numerator but an absence showing up in neither. `error` is already
 * the code for a throw the union says these paths "are not supposed to do but
 * can", so the event goes out carrying it and the exception is then let
 * through — the caller sees exactly what it saw before.
 *
 * The timer is started here, around the operation alone. Resolving the manager
 * is the caller's and stays outside it: on a remote host that opens the SSH
 * connection, which is not part of how long an install takes and would make the
 * first measurement of a session systematically different from the rest.
 */
export async function reportedCliAction<T extends CliActionResult>(
  action: TelemetryCliAction,
  target: CliActionTarget,
  id: string,
  method: InstallMethod | undefined,
  run: () => Promise<T>
): Promise<T> {
  const elapsed = startTimer();
  let result: T;
  try {
    result = await run();
  } catch (error) {
    report(action, target, id, method, { success: false }, elapsed());
    throw error;
  }
  report(action, target, id, method, result, elapsed());
  return result;
}
