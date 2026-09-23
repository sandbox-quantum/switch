import { appSettingsService } from '@main/core/settings/settings-service';
import type { DeployedTelemetry } from '@shared/core/managed-switch-server/managed-switch-server';
import { runningServiceEnv } from './compose';
import { ENV_FILE_NAME } from './constants';
import { readEnvValue, TELEMETRY_ENABLED_KEY } from './env-file';
import type { ServerHost } from './host/types';

/**
 * The "Share usage data" answer, as the managed server needs it (CHOO-2890).
 *
 * One consent decision covers the Console and the server it runs, so there is
 * no separate server-side preference to merge with — this is the toggle, read
 * fresh. It is deliberately not cached anywhere: a start is the moment the
 * answer is applied, and a copy taken earlier could apply an answer the user
 * has since withdrawn.
 *
 * Reading it is allowed to fail the start it is part of. A server started
 * without knowing the answer would be a server reporting on a guess, and the
 * one guess that cannot be defended is the one in favour.
 */
export async function telemetryConsent(): Promise<boolean> {
  return (await appSettingsService.get('telemetry')).enabled;
}

/** The compose service whose environment carries the server's telemetry gate. */
const CORE_SERVICE = 'switch';

/**
 * How pydantic-settings reads a boolean, narrowed to the forms that can reach
 * this variable.
 *
 * Absent means off, and that is a reading rather than a fallback: switch-core's
 * own default for the gate is off, so a stack started before this existed — or
 * by an operator who never set it — is genuinely not reporting.
 */
function envFlag(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Whether the stack on `host` is actually sharing usage data.
 *
 * Prefers the running core container's own environment — the only thing that
 * says what the server is doing right now — and falls back to the `.env`, which
 * is what the last start asked for. The two differ exactly when a start wrote
 * the file and then failed, which is the case this must not paper over.
 *
 * Call it only for a stack that is up. A stopped stack sends nothing, so its
 * answer is not a consent question.
 */
export async function readDeployedTelemetry(host: ServerHost): Promise<DeployedTelemetry> {
  const failures: string[] = [];

  try {
    const env = await runningServiceEnv(host, CORE_SERVICE);
    if (env) return { known: true, enabled: envFlag(env.get(TELEMETRY_ENABLED_KEY)) };
    failures.push(`the ${CORE_SERVICE} service has no running container`);
  } catch (error) {
    failures.push(`container environment: ${errorText(error)}`);
  }

  try {
    const env = await host.readFile(ENV_FILE_NAME);
    if (env !== null) {
      return { known: true, enabled: envFlag(readEnvValue(env, TELEMETRY_ENABLED_KEY)) };
    }
    failures.push(`${ENV_FILE_NAME}: not on the host`);
  } catch (error) {
    failures.push(`${ENV_FILE_NAME}: ${errorText(error)}`);
  }

  return { known: false, reason: failures.join('; ') };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
