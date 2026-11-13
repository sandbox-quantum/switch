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
    consent: null,
    external_identity: null,
    can_revoke: false,
    ...overrides,
  };
}
