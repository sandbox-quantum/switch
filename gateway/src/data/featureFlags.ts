/** The deployment's feature flags the dashboard acts on. The server sends
 * every flag it knows (`GET /gateway/feature-flags`); the dashboard keeps its
 * own list, and a key it does not know, or one the server did not send, is
 * off. Flags are set when the server is deployed, so they are read once per
 * page load. */

export const AGENT_MANAGEMENT = "agent_management";
export const SERVICE_CONNECTIONS = "service_connections";
export const ORGANIZATION_CONNECTOR_APPS = "organization_connector_apps";
export const GATEWAY_V2 = "gateway_v2";

const KNOWN = [
  AGENT_MANAGEMENT,
  SERVICE_CONNECTIONS,
  ORGANIZATION_CONNECTOR_APPS,
  GATEWAY_V2,
] as const;

export type FeatureFlagKey = (typeof KNOWN)[number];

export type FeatureFlags = Readonly<Record<FeatureFlagKey, boolean>>;

export interface FeatureFlagState {
  key: string;
  enabled: boolean;
}

export const ALL_OFF: FeatureFlags = Object.fromEntries(
  KNOWN.map((key) => [key, false]),
) as Record<FeatureFlagKey, boolean>;

export function featureFlagsFrom(states: FeatureFlagState[]): FeatureFlags {
  const sent = new Map(states.map((s) => [s.key, s.enabled]));
  return Object.fromEntries(
    KNOWN.map((key) => [key, sent.get(key) === true]),
  ) as Record<FeatureFlagKey, boolean>;
}

/** What an operator adds to the deployment to turn `key` on. */
export function howToTurnOn(key: FeatureFlagKey): string {
  return `An operator turns it on by adding ${key} to FEATURE_FLAGS_ENABLED.`;
}
