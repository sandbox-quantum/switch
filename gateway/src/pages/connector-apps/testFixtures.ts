import type { ConnectorApp } from "../../data/api";

/** A connector app as the server lists it, with placeholder values. */
export function app(overrides: Partial<ConnectorApp> = {}): ConnectorApp {
  return {
    slug: "google-workspace",
    name: "Google Workspace",
    kind: "oauth_client",
    source: "saved",
    configuration_variables: ["GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH"],
    deprecated: false,
    client_id: "example-client-id",
    saved_client_id: "example-client-id",
    fields: {},
    secrets: { client_secret: { set: true, last4: "ab12" } },
    saved_ignored: false,
    unreadable: false,
    load_error: null,
    redirect_uri:
      "https://switch.example.test/gateway/service-connections/google-workspace/flows/callback",
    redirect_uris: [
      "https://switch.example.test/gateway/service-connections/google-workspace/flows/callback",
    ],
    needs_public_url: true,
    scopes: [],
    setup_blocked: null,
    install_url: null,
    updated_by_name: "Ada",
    updated_at: "2026-10-15T10:00:00Z",
    connected_members: 12,
    workspaces: 3,
    stale_connections: 0,
    ...overrides,
  };
}
