import { BUILD_FEATURE_FLAGS } from '@shared/core/feature-flags/feature-flags';
import type { TelemetryFlintEnv } from '../../telemetry/config';
import { LOCAL_SERVER_ADMIN_EMAIL, LOCAL_SERVER_BIND_ADDR } from '../constants';
import {
  managedServerFeatureFlags,
  TELEMETRY_ENABLED_KEY,
  TELEMETRY_ENDPOINT_KEY,
} from '../env-file';
import type { LocalServerSecrets } from '../secret-values';
import { DATABASE, OWNER_ROLE, RUNTIME_ROLE } from './postgres-cluster';

export type NativeCoreSettingsParams = {
  /** switch-core's port on loopback, which serves both the agent API and the
   * gateway API — there is no separate dashboard process in native mode. */
  apiPort: number;
  postgresPort: number;
  secrets: LocalServerSecrets;
  telemetryEnabled: boolean;
  telemetryEnvironment: TelemetryFlintEnv;
  telemetryInternal: boolean;
  /** The relay the server sends its usage to: the one the app reports to. */
  telemetryEndpoint: string;
  /** Whether switch-core runs from this repo's checkout rather than the pin. */
  fromCheckout: boolean;
};

export function nativeApiUrl(apiPort: number): string {
  return `http://localhost:${apiPort}`;
}

/**
 * The environment switch-core runs with in native mode: the Docker stack's
 * settings (see `buildEnvFile`), with the addresses a process on this machine
 * uses instead of compose service names, and every listener held to loopback.
 * Pure, so the exact output is unit-testable.
 */
export function buildNativeCoreSettings(params: NativeCoreSettingsParams): Record<string, string> {
  const { apiPort, postgresPort, secrets, telemetryEnabled, fromCheckout } = params;
  const apiUrl = nativeApiUrl(apiPort);
  return {
    SERVER_HOST: LOCAL_SERVER_BIND_ADDR,
    SERVER_PORT: String(apiPort),
    DB_HOST: '127.0.0.1',
    DB_PORT: String(postgresPort),
    DB_USER: RUNTIME_ROLE,
    DB_PASSWORD: secrets.dbRuntimePassword,
    DB_OWNER_USER: OWNER_ROLE,
    DB_OWNER_PASSWORD: secrets.dbPassword,
    DB_NAME: DATABASE,
    ID_SERVER_NAME: 'localhost',
    AGENT_REGISTRATION_TOKEN: secrets.agentRegistrationToken,
    JWT_SECRET_KEY: secrets.jwtSecretKey,
    SECRET_KEYS: secrets.secretKeys,
    FEATURE_FLAGS_ENABLED: managedServerFeatureFlags(
      BUILD_FEATURE_FLAGS.onboarding,
      fromCheckout
    ).join(','),
    CONTROLLER_TOKEN_SECRET: secrets.controllerTokenSecret,
    GATEWAY_ADMIN_EMAIL: LOCAL_SERVER_ADMIN_EMAIL,
    GATEWAY_ADMIN_PASSWORD: secrets.gatewayAdminPassword,
    FRONTEND_BASE_URL: apiUrl,
    GATEWAY_COOKIE_SECURE: 'false',
    GATEWAY_PUBLIC_URL: apiUrl,
    // A single-user server on this machine may call services on loopback.
    OUTBOUND_ALLOWED_PRIVATE_HOSTS: 'localhost,127.0.0.1',
    [TELEMETRY_ENABLED_KEY]: telemetryEnabled ? 'true' : 'false',
    TELEMETRY_ENVIRONMENT: params.telemetryEnvironment,
    TELEMETRY_INTERNAL: params.telemetryInternal ? 'true' : 'false',
    // Named for the same reason the Docker stack's `.env` names it.
    [TELEMETRY_ENDPOINT_KEY]: params.telemetryEndpoint,
    // Tells the server's agents that Switch Console runs it, as the Docker
    // stack's `.env` does.
    MANAGED_BY_CONSOLE: 'true',
  };
}
