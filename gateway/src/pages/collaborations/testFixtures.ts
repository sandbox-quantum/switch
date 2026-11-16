import type { BridgeDetail, LinkedIdentity, PendingIdentity } from "../../data/api";

/** A messaging app as `GET /collaborations` describes it, for tests. */
export function bridgeDetail(overrides: Partial<BridgeDetail> = {}): BridgeDetail {
  return {
    bridge_id: "b1",
    bridge_type: "teams",
    display_name: "Acme Corp",
    status: "active",
    agent_greetings_enabled: true,
    channel_creation_supported: true,
    channel_creation_enabled: false,
    room_count: 2,
    created_at: "2026-01-01",
    attention: null,
    team_placement_supported: false,
    can_manage: true,
    can_delete: true,
    is_default: false,
    home_url: null,
    receives_webhooks: false,
    webhook_url: null,
    directory_search_supported: true,
    ...overrides,
  };
}

export function linkedIdentity(overrides: Partial<LinkedIdentity> = {}): LinkedIdentity {
  return {
    id: "acct-1",
    bridge_id: "b1",
    bridge_display_name: "Acme Corp",
    bridge_type: "slack",
    external_user_id: "U1",
    external_username: "ada",
    verified: true,
    linked_at: "2026-01-14T09:00:00Z",
    awaiting_confirmation: false,
    ...overrides,
  };
}

export function pendingIdentity(overrides: Partial<PendingIdentity> = {}): PendingIdentity {
  return {
    id: "acct-1",
    bridge_id: "b1",
    bridge_display_name: "Acme Corp",
    bridge_type: "slack",
    external_user_id: "U1",
    external_username: "ada",
    requested_by_name: null,
    code_expires_at: null,
    ...overrides,
  };
}
