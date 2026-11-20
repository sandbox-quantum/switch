import type { ServiceConnection } from "../data/api";

/** A catalog connector as `GET /service-connections` lists it to someone not
 * connected, with placeholder values. */
export function serviceConnection(overrides: Partial<ServiceConnection> = {}): ServiceConnection {
  return {
    slug: "example",
    name: "Example",
    category: "Project management",
    description: "Example work items.",
    enabled: true,
    connectable: true,
    configured: true,
    unavailable_reason: null,
    unavailable_code: null,
    server_setup_needed: false,
    app_source: "server",
    read_only_reason: null,
    status: "not_connected",
    pass_through: true,
    token_lifetime: 3600,
    key: null,
    auth_type: "oauth",
    publisher: "Example",
    links: {
      documentation: "https://docs.example.test",
      support: "https://support.example.test",
      privacy: "https://example.test/privacy",
    },
    mcp_urls: ["https://mcp.example.test/mcp"],
    workspace_enabled: true,
    organization_locked: false,
    decided_by: "workspace",
    web_sign_in: false,
    sign_in_choices: null,
    paste: [],
    reconnect_code: null,
    reconnect_reason: null,
    consent: null,
    external_identity: null,
    can_revoke: false,
    method: null,
    choices: null,
    access_note: null,
    ...overrides,
  };
}

/** Datadog as the server lists it: a sign-in that finishes only in Switch
 * Console, at a site picked first, or a token, or keys, pasted in its place. */
export function pastedConnector(overrides: Partial<ServiceConnection> = {}): ServiceConnection {
  return serviceConnection({
    slug: "datadog",
    name: "Datadog",
    category: "Observability",
    publisher: "Datadog",
    sign_in_choices: [
      { name: "site", label: "Datadog site", secret: false, help: null, choices: ["datadoghq.com", "datadoghq.eu"] },
    ],
    paste: [
      {
        method: "token",
        label: "Personal access token",
        fields: [{ name: "pat", label: "Personal access token", secret: true, help: null, choices: null }],
        help_url: "https://docs.example.test/tokens",
        expires: "vendor",
        access_note: "Reaches what your token allows.",
      },
      {
        method: "keys",
        label: "API and application keys",
        fields: [
          { name: "api_key", label: "API key", secret: true, help: null, choices: null },
          { name: "application_key", label: "Application key", secret: true, help: null, choices: null },
        ],
        help_url: null,
        expires: "never",
        access_note: "Reaches what your keys allow.",
      },
    ],
    ...overrides,
  });
}
