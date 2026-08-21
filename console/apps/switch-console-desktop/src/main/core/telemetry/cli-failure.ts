import type { TelemetryCliFailure } from './events';

/**
 * The codes the three dependency operations return.
 *
 * Install, update and uninstall each have their own error union, and they
 * overlap without being identical — a shared set of command failures at the
 * centre, and their own ends. Rather than three near-duplicate telemetry unions,
 * this maps every discriminant any of them can produce onto one, and refuses to
 * guess at anything else.
 *
 * A code that arrives here unrecognised becomes `error` rather than being passed
 * through: these are read off a `Result` whose type says what they can be, but
 * the value crossed a package boundary and a new variant added upstream must not
 * become free text in a payload.
 */
const CLI_FAILURE_CODES: Record<string, TelemetryCliFailure> = {
  'unknown-dependency': 'unknown_dependency',
  'no-install-command': 'no_install_command',
  'no-update-strategy': 'no_update_strategy',
  'no-uninstall-strategy': 'no_uninstall_strategy',
  'no-uninstall-command': 'no_uninstall_command',
  'permission-denied': 'permission_denied',
  'command-failed': 'command_failed',
  'pty-open-failed': 'pty_open_failed',
  'not-detected-after-install': 'not_detected_after_install',
  'not-detected-after-update': 'not_detected_after_update',
  'still-present': 'still_present',
};

export function cliFailureReason(result: {
  success: boolean;
  error?: { type?: string };
}): TelemetryCliFailure {
  if (result.success) return 'none';
  const type = result.error?.type;
  return (type && CLI_FAILURE_CODES[type]) || 'error';
}
