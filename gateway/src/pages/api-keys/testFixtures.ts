import type { ApiKeyDetail } from "../../data/api";

/** A key as the server lists it: one of `owner`'s for adding agents, unless
 *  `overrides` say otherwise. */
export function apiKey(id: string, overrides: Partial<ApiKeyDetail> = {}): ApiKeyDetail {
  return {
    id,
    label: id,
    type: "registration",
    key_prefix: `fp_${id}`,
    created_at: "2026-10-01T00:00:00Z",
    expires_at: null,
    owner_id: "user-1",
    owner_name: "Ada",
    agent_id: null,
    agent_name: null,
    can_reveal: true,
    can_delete: true,
    ...overrides,
  };
}
