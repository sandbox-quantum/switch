"""Who may use each gateway route, and how the matrix asks it.

Keyed as the committed route snapshot keys them, so `test_role_matrix.py` can
hold this table to every route the server mounts: a route added without a
line here fails, and so does a line for a route that is gone.

`{name}` in a path or body is filled from the asking persona's `World`: the
thing of that kind, owned by `Persona.OWNER`. A rule that is not the plain
one for its kind says why.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from tests.switch_core.gateway.role_matrix.access import (
    Expected,
    admin_by_membership,
    admins,
    anyone,
    operator,
    org_admin,
    owner,
    owner_or_admins,
)
from tests.switch_core.gateway.role_matrix.harness import Persona


@dataclass(frozen=True)
class Ask:
    method: str
    path: str
    json: Any = None
    params: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Case:
    ask: Ask
    expect: dict[Persona, Expected]
    why: str = ""


def get(
    path: str, expect: dict[Persona, Expected], why: str = "", **params: str
) -> Case:
    return Case(Ask("GET", path, params=params), expect, why)


def post(
    path: str, expect: dict[Persona, Expected], json: Any = None, why: str = ""
) -> Case:
    return Case(Ask("POST", path, json=json), expect, why)


def put(
    path: str, expect: dict[Persona, Expected], json: Any = None, why: str = ""
) -> Case:
    return Case(Ask("PUT", path, json=json), expect, why)


def patch(
    path: str, expect: dict[Persona, Expected], json: Any = None, why: str = ""
) -> Case:
    return Case(Ask("PATCH", path, json=json), expect, why)


def delete(
    path: str, expect: dict[Persona, Expected], why: str = "", **params: str
) -> Case:
    return Case(Ask("DELETE", path, params=params), expect, why)


G = "/gateway"
FLOW = {"port": 39231, "state": "{flow_state}", "completion_secret": "{flow_secret}"}
W = f"{G}/tenants/{{tenant}}"

# Each persona acting on its own account or its own things.
SELF = anyone()

ROUTES: dict[str, Case] = {
    # ── Agents ───────────────────────────────────────────────────────────
    "GET /gateway/agents": get(f"{G}/agents", anyone()),
    "GET /gateway/agents/avatar-settings": get(f"{G}/agents/avatar-settings", anyone()),
    "GET /gateway/agents/icon-choices": get(
        f"{G}/agents/icon-choices", anyone(), name="matrix"
    ),
    "GET /gateway/agents/{agent_id}": get(f"{G}/agents/{{agent}}", anyone()),
    "DELETE /gateway/agents/{agent_id}": delete(
        f"{G}/agents/{{agent}}", owner_or_admins()
    ),
    "DELETE /gateway/agents/by-name/{agent_name}": delete(
        f"{G}/agents/by-name/{{agent_name}}", owner_or_admins()
    ),
    "PATCH /gateway/agents/{agent_id}/options": patch(
        f"{G}/agents/{{console_agent}}/options", owner_or_admins(), json={"options": {}}
    ),
    "PUT /gateway/agents/{agent_id}/icon": put(
        f"{G}/agents/{{agent}}/icon", owner_or_admins(), json={"icon_url": None}
    ),
    "PUT /gateway/agents/{agent_id}/name": put(
        f"{G}/agents/{{agent}}/name",
        owner_or_admins(),
        json={"name": "{tag}-renamed", "display_name": None},
    ),
    "PUT /gateway/agents/{agent_id}/display-name": put(
        f"{G}/agents/{{agent}}/display-name",
        owner_or_admins(),
        json={"display_name": "Renamed"},
    ),
    "PUT /gateway/agents/{agent_id}/description": put(
        f"{G}/agents/{{agent}}/description",
        owner_or_admins(),
        json={"description": "changed"},
    ),
    "PUT /gateway/agents/{agent_id}/addressing-policy": put(
        f"{G}/agents/{{agent}}/addressing-policy",
        owner_or_admins(),
        json={"policy": None},
    ),
    "PUT /gateway/agents/{agent_id}/can-manage-agents": put(
        f"{G}/agents/{{agent}}/can-manage-agents",
        owner(refused=403),
        json={"enabled": False},
        why="Its owner's alone: the agent would act on the owner's own machines.",
    ),
    "GET /gateway/agents/{agent_id}/service-grants": get(
        f"{G}/agents/{{agent}}/service-grants",
        owner(),
        why="Made on the owner's own connections; anyone else is told it isn't there.",
    ),
    "PUT /gateway/agents/{agent_id}/service-grants/{service}": put(
        f"{G}/agents/{{console_agent}}/service-grants/github",
        owner(),
        json={"access": "read", "resources": {}},
        why="Made on the owner's own connections; anyone else is told it isn't there.",
    ),
    "DELETE /gateway/agents/{agent_id}/service-grants/{service}": delete(
        f"{G}/agents/{{granted_agent}}/service-grants/github", owner()
    ),
    "POST /gateway/agents/register": post(
        f"{G}/agents/register",
        SELF,
        json={"agent_type": "claude-code", "name": "{tag}-new", "description": ""},
    ),
    "POST /gateway/agents/register-other": post(
        f"{G}/agents/register-other",
        SELF,
        json={"name": "{tag}-other", "description": ""},
    ),
    "POST /gateway/agents/register-known-bulk": post(
        f"{G}/agents/register-known-bulk",
        owner_or_admins(),
        json={
            "agent_type": "claude-code",
            "parent_agent_id": "{agent}",
            "subagents": [{"subagent_name": "reviewer", "description": ""}],
        },
    ),
    "GET /gateway/agent-sessions/approvals": get(f"{G}/agent-sessions/approvals", SELF),
    "POST /gateway/agent-sessions/{agent_id}/{session_id}/approvals/{request_id}/answer": post(
        f"{G}/agent-sessions/{{agent}}/session-1/approvals/request-1/answer",
        anyone(ok=404),
        json={"answer": "allow"},
        why="Whoever may address the agent, which is open; there is no such request.",
    ),
    # ── API keys ─────────────────────────────────────────────────────────
    "GET /gateway/api-keys": get(f"{G}/api-keys", SELF),
    "POST /gateway/api-keys": post(f"{G}/api-keys", SELF, json={"label": "mine"}),
    "GET /gateway/api-keys/{key_id}/reveal": get(
        f"{G}/api-keys/{{registration_key}}/reveal",
        owner(refused=403),
        why="A key is a credential: not even an admin may read another's.",
    ),
    "DELETE /gateway/api-keys/{key_id}": delete(
        f"{G}/api-keys/{{registration_key}}", owner(refused=403)
    ),
    # ── Your account ─────────────────────────────────────────────────────
    "GET /gateway/version": get(f"{G}/version", SELF),
    "GET /gateway/feature-flags": get(f"{G}/feature-flags", SELF),
    "GET /gateway/auth/me": get(f"{G}/auth/me", SELF),
    "GET /gateway/auth/me/identities": get(f"{G}/auth/me/identities", SELF),
    "GET /gateway/auth/me/identities/pending": get(
        f"{G}/auth/me/identities/pending", SELF
    ),
    "GET /gateway/auth/session": get(f"{G}/auth/session", SELF),
    "POST /gateway/auth/refresh": post(f"{G}/auth/refresh", SELF),
    "PATCH /gateway/auth/me": patch(f"{G}/auth/me", SELF, json={"name": "Renamed"}),
    "PUT /gateway/auth/me/password": put(
        f"{G}/auth/me/password",
        anyone(ok=403),
        json={"current_password": "wrong-password", "new_password": "a-new-password-1"},
        why="Your own: refused, the current password being wrong.",
    ),
    "DELETE /gateway/auth/me": Case(
        Ask("DELETE", f"{G}/auth/me"),
        anyone(ok=422),
        why="Your own: refused without the account's e-mail typed to confirm it.",
    ),
    # ── Workspaces ───────────────────────────────────────────────────────
    "GET /gateway/tenants": get(f"{G}/tenants", SELF),
    "GET /gateway/tenants/counts": get(f"{G}/tenants/counts", SELF),
    "GET /gateway/tenants/current": get(f"{G}/tenants/current", SELF),
    "POST /gateway/tenants": post(f"{G}/tenants", SELF, json={"name": "{tag}-ws"}),
    "POST /gateway/tenants/{tenant_id}/switch": post(f"{W}/switch", SELF),
    "DELETE /gateway/tenants/{tenant_id}": Case(
        Ask("DELETE", W, json={"name": "{tenant}"}),
        admin_by_membership(ok=409),
        why=(
            "Its admins by their own membership, not the organization's admin "
            "or the operator; let through, then refused while it isn't empty."
        ),
    ),
    "GET /gateway/tenants/{tenant_id}/retention": get(f"{W}/retention", admins()),
    "GET /gateway/tenants/{tenant_id}/retention/preview": get(
        f"{W}/retention/preview", admins(), days="30"
    ),
    "PUT /gateway/tenants/{tenant_id}/retention": put(
        f"{W}/retention",
        admin_by_membership(),
        json={"message_retention_days": 30},
        why="Deleting messages can't be undone: its admins by their own membership.",
    ),
    "DELETE /gateway/tenants/{tenant_id}/retention": delete(f"{W}/retention", admins()),
    "GET /gateway/tenants/{tenant_id}/people": get(
        f"{W}/people",
        admin_by_membership(),
        why="The list a person is erased from: its admins by their own membership.",
    ),
    "GET /gateway/tenants/{tenant_id}/erasures": get(
        f"{W}/erasures", admin_by_membership()
    ),
    "POST /gateway/tenants/{tenant_id}/erasures": post(
        f"{W}/erasures",
        admin_by_membership(ok=404),
        json={"external_user_ids": ["{tag}-nobody"]},
        why=(
            "Erasing a person can't be undone: its admins by their own "
            "membership; let through, then told nobody has that id."
        ),
    ),
    "GET /gateway/operator/workspaces": get(f"{G}/operator/workspaces", operator()),
    "GET /gateway/tenants/{tenant_id}/members": get(f"{W}/members", anyone()),
    "PATCH /gateway/tenants/{tenant_id}/members/{user_id}": patch(
        f"{W}/members/{{member_target}}", admins(), json={"role": "member"}
    ),
    "DELETE /gateway/tenants/{tenant_id}/members/{user_id}": delete(
        f"{W}/members/{{member_target}}", admins()
    ),
    "GET /gateway/tenants/{tenant_id}/invitations": get(f"{W}/invitations", admins()),
    "POST /gateway/tenants/{tenant_id}/invitations": post(
        f"{W}/invitations", admins(), json={"role": "member"}
    ),
    "DELETE /gateway/tenants/{tenant_id}/invitations/{invitation_id}": delete(
        f"{W}/invitations/{{invitation}}", admins()
    ),
    "GET /gateway/tenants/{tenant_id}/audit-events": get(f"{W}/audit-events", admins()),
    "GET /gateway/tenants/{tenant_id}/usage": get(
        f"{W}/usage",
        admins(),
        since="2026-01-01T00:00:00Z",
        until="2026-02-01T00:00:00Z",
    ),
    "GET /gateway/tenants/{tenant_id}/budgets": get(f"{W}/budgets", admins()),
    "POST /gateway/tenants/{tenant_id}/budgets": post(
        f"{W}/budgets",
        admins(),
        json={
            "agent_id": None,
            "metric": "input_tokens",
            "model": "{tag}",
            "amount_limit": 10,
            "period_hours": 24,
        },
    ),
    "PUT /gateway/tenants/{tenant_id}/budgets/{budget_id}": put(
        f"{W}/budgets/{{budget}}",
        admins(),
        json={"amount_limit": 20, "period_hours": 24},
    ),
    "DELETE /gateway/tenants/{tenant_id}/budgets/{budget_id}": delete(
        f"{W}/budgets/{{budget}}", admins()
    ),
    "GET /gateway/tenants/{tenant_id}/join-domains": get(f"{W}/join-domains", admins()),
    "POST /gateway/tenants/{tenant_id}/join-domains": post(
        f"{W}/join-domains",
        admins(),
        json={"domain": "{email_domain}"},
        why="Each admin opens it to the domain of their own e-mail.",
    ),
    "DELETE /gateway/tenants/{tenant_id}/join-domains/{domain}": delete(
        f"{W}/join-domains/{{join_domain}}", admins()
    ),
    "POST /gateway/invitations/accept": post(
        f"{G}/invitations/accept",
        anyone(ok=404),
        json={"token": "no-such-invitation"},
        why="Whoever holds the token; this one matches no invitation.",
    ),
    "GET /gateway/invitations/mine": get(f"{G}/invitations/mine", SELF),
    "POST /gateway/invitations/mine/accept": post(
        f"{G}/invitations/mine/accept",
        anyone(ok=404),
        json={"tenant_id": "{tenant}", "invitation_id": "no-such-invitation"},
        why="Your own invitations; nobody here has one.",
    ),
    "GET /gateway/joinable-tenants": get(f"{G}/joinable-tenants", SELF),
    "POST /gateway/joinable-tenants/{tenant_id}/join": post(
        f"{G}/joinable-tenants/{{tenant}}/join",
        anyone(ok=404),
        why="Offered only to the domains it lists, and it lists none.",
    ),
    "GET /gateway/workspace/services": get(f"{G}/workspace/services", admins()),
    "PUT /gateway/workspace/services/{service}": put(
        f"{G}/workspace/services/github", admins(), json={"enabled": True}
    ),
    "DELETE /gateway/workspace/services/{service}": delete(
        f"{G}/workspace/services/{{workspace_service}}", admins()
    ),
    "POST /gateway/ownership/transfer": post(
        f"{G}/ownership/transfer",
        owner_or_admins(),
        json={"kind": "reference", "id": "{reference}", "new_owner_id": "{member}"},
        why="Its owner or an admin; the member receiving it can't take it for themselves.",
    ),
    # ── Organizations ────────────────────────────────────────────────────
    "GET /gateway/organizations": get(f"{G}/organizations", SELF),
    "POST /gateway/organizations": post(
        f"{G}/organizations", SELF, json={"name": "{tag}-org"}
    ),
    "GET /gateway/organizations/current": get(f"{G}/organizations/current", anyone()),
    "GET /gateway/organizations/current/workspaces": get(
        f"{G}/organizations/current/workspaces", anyone()
    ),
    "POST /gateway/organizations/current/workspaces": post(
        f"{G}/organizations/current/workspaces", org_admin(), json={"name": "{tag}-ws"}
    ),
    "GET /gateway/organizations/current/audit-events": get(
        f"{G}/organizations/current/audit-events", org_admin()
    ),
    "GET /gateway/organizations/current/issues": get(
        f"{G}/organizations/current/issues", org_admin()
    ),
    "GET /gateway/organizations/current/members": get(
        f"{G}/organizations/current/members", org_admin()
    ),
    "PATCH /gateway/organizations/current/members/{user_id}": patch(
        f"{G}/organizations/current/members/{{org_target}}",
        org_admin(),
        json={"role": "member"},
    ),
    "DELETE /gateway/organizations/current/members/{user_id}": delete(
        f"{G}/organizations/current/members/{{org_target}}", org_admin()
    ),
    "GET /gateway/organizations/current/services": get(
        f"{G}/organizations/current/services", org_admin()
    ),
    "PUT /gateway/organizations/current/services/{service}": put(
        f"{G}/organizations/current/services/github",
        org_admin(),
        json={"enabled": True, "locked": False},
    ),
    "DELETE /gateway/organizations/current/services/{service}": delete(
        f"{G}/organizations/current/services/{{organization_service}}", org_admin()
    ),
    "GET /gateway/organizations/current/connector-apps": get(
        f"{G}/organizations/current/connector-apps", org_admin()
    ),
    "PUT /gateway/organizations/current/connector-apps/{service}": put(
        f"{G}/organizations/current/connector-apps/github",
        org_admin(),
        json={"client_id": "example", "replace": False},
    ),
    "POST /gateway/organizations/current/connector-apps/{service}/check": post(
        f"{G}/organizations/current/connector-apps/github/check", org_admin()
    ),
    "GET /gateway/organizations/current/connector-apps/{service}/impact": get(
        f"{G}/organizations/current/connector-apps/github/impact",
        org_admin(),
        client_id="example",
    ),
    "DELETE /gateway/organizations/current/connector-apps/{service}": delete(
        f"{G}/organizations/current/connector-apps/github", org_admin()
    ),
    "GET /gateway/auth/workos/organization": get(
        f"{G}/auth/workos/organization",
        anyone(ok=404),
        why="An organization admin's; this server sends nothing to WorkOS, and says so first.",
        return_to="/organization",
    ),
    "GET /gateway/auth/workos/callback": get(
        f"{G}/auth/workos/callback",
        anyone(ok=404),
        why="Your own sign-in coming back; this server sends nothing to WorkOS.",
        code="matrix",
        state="matrix",
    ),
    # ── Operator ─────────────────────────────────────────────────────────
    "GET /gateway/users": get(f"{G}/users", operator()),
    "POST /gateway/users": post(
        f"{G}/users",
        operator(),
        json={
            "name": "New",
            "email": "{tag}-new@example.invalid",
            "password": "a-long-enough-password",
        },
    ),
    "DELETE /gateway/users/{user_id}": delete(f"{G}/users/{{user_target}}", operator()),
    "POST /gateway/users/{user_id}/sessions/revoke": post(
        f"{G}/users/{{user_target}}/sessions/revoke", operator()
    ),
    "POST /gateway/auth/sessions/revoke": post(
        f"{G}/auth/sessions/revoke",
        SELF,
        why="Signing yourself out of every device.",
    ),
    "GET /gateway/trust-settings": get(f"{G}/trust-settings", operator()),
    "PUT /gateway/trust-settings": put(
        f"{G}/trust-settings",
        operator(),
        json={"endpoint": "https://trust.example.invalid", "policy_id": None},
    ),
    "DELETE /gateway/trust-settings": delete(f"{G}/trust-settings", operator()),
    "GET /gateway/connector-apps": get(f"{G}/connector-apps", operator()),
    "PUT /gateway/connector-apps/{service}": put(
        f"{G}/connector-apps/github",
        operator(),
        json={"client_id": "example", "replace": False},
    ),
    "POST /gateway/connector-apps/{service}/import": post(
        f"{G}/connector-apps/github/import", operator()
    ),
    "POST /gateway/connector-apps/{service}/check": post(
        f"{G}/connector-apps/github/check", operator()
    ),
    "GET /gateway/connector-apps/{service}/impact": get(
        f"{G}/connector-apps/github/impact", operator(), client_id="example"
    ),
    "DELETE /gateway/connector-apps/{service}": delete(
        f"{G}/connector-apps/github", operator()
    ),
    # ── Rooms ────────────────────────────────────────────────────────────
    "GET /gateway/rooms": get(f"{G}/rooms", anyone()),
    "GET /gateway/rooms/template-schema": get(f"{G}/rooms/template-schema", anyone()),
    "POST /gateway/rooms": post(
        f"{G}/rooms",
        SELF,
        json={"name": "{tag}-new-room", "description": "", "agent_ids": ["{agent}"]},
    ),
    "POST /gateway/rooms/from-yaml": post(
        f"{G}/rooms/from-yaml",
        SELF,
        json={"yaml": "{room_yaml}", "template_name": "matrix"},
    ),
    "POST /gateway/rooms/from-template": post(
        f"{G}/rooms/from-template",
        SELF,
        json={"agents": [], "yaml": "{room_yaml}", "template_name": "matrix"},
        why="From a document the caller supplies.",
    ),
    "POST /gateway/rooms/from-template-document": post(
        f"{G}/rooms/from-template-document",
        owner_or_admins(refused=404),
        json={
            "template": "{room_yaml}",
            "template_name": "matrix",
            "template_id": "{template}",
            "filled": {},
        },
        why="Run as a saved template the caller may read: a private one isn't there to anyone else.",
    ),
    "GET /gateway/rooms/{room_id}": get(f"{G}/rooms/{{room}}", owner_or_admins()),
    "GET /gateway/rooms/{room_id}/yaml": get(
        f"{G}/rooms/{{room}}/yaml", owner_or_admins()
    ),
    "PATCH /gateway/rooms/{room_id}": patch(
        f"{G}/rooms/{{room}}", owner_or_admins(), json={"description": "changed"}
    ),
    "DELETE /gateway/rooms/{room_id}": delete(f"{G}/rooms/{{room}}", owner_or_admins()),
    "POST /gateway/rooms/{room_id}/archive": post(
        f"{G}/rooms/{{room}}/archive", owner_or_admins()
    ),
    "POST /gateway/rooms/{room_id}/unarchive": post(
        f"{G}/rooms/{{room}}/unarchive", owner_or_admins()
    ),
    "POST /gateway/rooms/{room_id}/sync-name": post(
        f"{G}/rooms/{{room}}/sync-name",
        owner_or_admins(ok=409),
        why="Let through, then refused: the room has no platform channel to name.",
    ),
    "GET /gateway/rooms/{room_id}/roles": get(
        f"{G}/rooms/{{room}}/roles", owner_or_admins()
    ),
    "POST /gateway/rooms/{room_id}/roles": post(
        f"{G}/rooms/{{room}}/roles",
        owner_or_admins(),
        json={"name": "reviewer", "instructions": "Review.", "exclusive": False},
    ),
    "PATCH /gateway/rooms/{room_id}/roles/{name}": patch(
        f"{G}/rooms/{{room_role}}/roles/reviewer",
        owner_or_admins(),
        json={"instructions": "Review again."},
    ),
    "DELETE /gateway/rooms/{room_id}/roles/{name}": delete(
        f"{G}/rooms/{{room_role}}/roles/reviewer", owner_or_admins()
    ),
    "GET /gateway/decision-settings": get(f"{G}/decision-settings", admins()),
    "PUT /gateway/decision-settings": put(
        f"{G}/decision-settings", admins(), json={"backend": "none"}
    ),
    "DELETE /gateway/decision-settings": delete(f"{G}/decision-settings", admins()),
    "POST /gateway/decision-settings/test": post(
        f"{G}/decision-settings/test", admins(), json={"backend": "none"}
    ),
    "PUT /gateway/rooms/{room_id}/auto-route": put(
        f"{G}/rooms/{{room}}/auto-route",
        owner_or_admins(),
        json={"on": False},
        why="Write access to the room; this room's write access is private.",
    ),
    "PUT /gateway/rooms/{room_id}/protection": put(
        f"{G}/rooms/{{room}}/protection",
        owner_or_admins(),
        json={"protection_config": {}},
    ),
    "PUT /gateway/rooms/{room_id}/observe": put(
        f"{G}/rooms/{{room}}/observe", owner_or_admins(), json={"observe_config": {}}
    ),
    "POST /gateway/rooms/{room_id}/agents": post(
        f"{G}/rooms/{{room}}/agents", owner_or_admins(), json={"agent_ids": ["{agent}"]}
    ),
    "PATCH /gateway/rooms/{room_id}/agents/{agent_id}": patch(
        f"{G}/rooms/{{room_agent}}/agents/{{agent}}",
        owner_or_admins(),
        json={"receives_join_events": True},
    ),
    "DELETE /gateway/rooms/{room_id}/agents/{agent_id}": delete(
        f"{G}/rooms/{{room_agent}}/agents/{{agent}}", owner_or_admins()
    ),
    "POST /gateway/rooms/{room_id}/users": post(
        f"{G}/rooms/{{room}}/users",
        owner_or_admins(ok=400),
        json={"user_names": []},
        why="Let through, then refused: people join through the room's platform channel, and it has none.",
    ),
    "PUT /gateway/rooms/{room_id}/group": put(
        f"{G}/rooms/{{room}}/group",
        admins(),
        json={"group_id": "{room_group}"},
        why="Filing a room in a group is an admin's: groups feed addressing policies.",
    ),
    "POST /gateway/rooms/bulk-delete": post(
        f"{G}/rooms/bulk-delete",
        anyone(ok=200),
        json={"room_ids": ["{room}"]},
        why="Skips each room the caller may not delete; see `test_bulk_room_actions`.",
    ),
    "POST /gateway/rooms/bulk-archive": post(
        f"{G}/rooms/bulk-archive",
        anyone(ok=200),
        json={"room_ids": ["{room}"], "archived": True},
        why="Skips each room the caller may not change; see `test_bulk_room_actions`.",
    ),
    "GET /gateway/linked-rooms/graph": get(f"{G}/linked-rooms/graph", anyone()),
    "GET /gateway/rooms/{room_id}/linked-rooms": get(
        f"{G}/rooms/{{room}}/linked-rooms", owner_or_admins()
    ),
    "GET /gateway/rooms/{room_id}/linked-rooms/inbound": get(
        f"{G}/rooms/{{room}}/linked-rooms/inbound", owner_or_admins()
    ),
    "POST /gateway/rooms/{room_id}/linked-rooms": post(
        f"{G}/rooms/{{room}}/linked-rooms",
        owner_or_admins(),
        json={"target_room_id": "{other_room}", "label": "related"},
    ),
    "DELETE /gateway/rooms/{room_id}/linked-rooms/{target_room_id}": delete(
        f"{G}/rooms/{{linked_room}}/linked-rooms/{{other_room}}", owner_or_admins()
    ),
    "GET /gateway/rooms/{room_id}/references": get(
        f"{G}/rooms/{{room}}/references", owner_or_admins()
    ),
    "POST /gateway/rooms/{room_id}/references/{reference_id}": post(
        f"{G}/rooms/{{room}}/references/{{reference}}", owner_or_admins()
    ),
    "DELETE /gateway/rooms/{room_id}/references/{reference_id}": delete(
        f"{G}/rooms/{{room_reference}}/references/{{reference}}", owner_or_admins()
    ),
    "GET /gateway/rooms/{room_id}/documents": get(
        f"{G}/rooms/{{room}}/documents", owner_or_admins()
    ),
    "GET /gateway/rooms/{room_id}/documents/{document_id}": get(
        f"{G}/rooms/{{room_document}}/documents/{{document}}", owner_or_admins()
    ),
    "POST /gateway/rooms/{room_id}/documents/{document_id}": post(
        f"{G}/rooms/{{room}}/documents/{{document}}", owner_or_admins()
    ),
    "DELETE /gateway/rooms/{room_id}/documents/{document_id}": delete(
        f"{G}/rooms/{{room_document}}/documents/{{document}}", owner_or_admins()
    ),
    "GET /gateway/rooms/{room_id}/packages": get(
        f"{G}/rooms/{{room}}/packages", owner_or_admins()
    ),
    "POST /gateway/rooms/{room_id}/packages/{package_id}": post(
        f"{G}/rooms/{{room}}/packages/{{package}}", owner_or_admins()
    ),
    "DELETE /gateway/rooms/{room_id}/packages/{package_id}": delete(
        f"{G}/rooms/{{room_package}}/packages/{{package}}", owner_or_admins()
    ),
    # ── Room groups ──────────────────────────────────────────────────────
    "GET /gateway/room-groups": get(f"{G}/room-groups", anyone()),
    "POST /gateway/room-groups": post(
        f"{G}/room-groups", admins(), json={"name": "{tag}-new-group"}
    ),
    "PATCH /gateway/room-groups/{group_id}": patch(
        f"{G}/room-groups/{{room_group}}", admins(), json={"description": "changed"}
    ),
    "DELETE /gateway/room-groups/{group_id}": delete(
        f"{G}/room-groups/{{room_group}}", admins()
    ),
    "PUT /gateway/room-groups/{group_id}/rooms": put(
        f"{G}/room-groups/{{room_group}}/rooms",
        admins(),
        json={"room_ids": ["{room}"]},
    ),
    # ── References, documents, packages ──────────────────────────────────
    "GET /gateway/references": get(f"{G}/references", anyone()),
    "POST /gateway/references": post(
        f"{G}/references",
        SELF,
        json={
            "type": "github",
            "name": "{tag}-new",
            "description": "",
            "instructions": "",
            "value": {"urls": ["https://github.com/example/project"]},
        },
    ),
    "GET /gateway/references/{reference_id}": get(
        f"{G}/references/{{reference}}", owner_or_admins()
    ),
    "PATCH /gateway/references/{reference_id}": patch(
        f"{G}/references/{{reference}}", owner_or_admins(), json={"description": "x"}
    ),
    "DELETE /gateway/references/{reference_id}": delete(
        f"{G}/references/{{reference}}", owner_or_admins()
    ),
    "GET /gateway/references/{reference_id}/rooms": get(
        f"{G}/references/{{reference}}/rooms", owner_or_admins()
    ),
    "GET /gateway/references/reference-types": get(
        f"{G}/references/reference-types", anyone()
    ),
    "GET /gateway/references/reference-types/owned": get(
        f"{G}/references/reference-types/owned", anyone()
    ),
    "POST /gateway/references/reference-types": post(
        f"{G}/references/reference-types",
        SELF,
        json={
            "type": "{slug}",
            "display_name": "New",
            "instructions": "",
            "value_hint": "",
        },
    ),
    "PATCH /gateway/references/reference-types/{type}": patch(
        f"{G}/references/reference-types/{{reference_type}}",
        owner_or_admins(),
        json={"display_name": "Changed"},
    ),
    "DELETE /gateway/references/reference-types/{type}": delete(
        f"{G}/references/reference-types/{{reference_type}}", owner_or_admins()
    ),
    "GET /gateway/documents": get(f"{G}/documents", anyone()),
    "POST /gateway/documents": post(
        f"{G}/documents",
        SELF,
        json={
            "name": "{tag}-new",
            "description": "",
            "instructions": "",
            "content": "",
        },
    ),
    "GET /gateway/documents/{document_id}": get(
        f"{G}/documents/{{document}}", owner_or_admins()
    ),
    "PATCH /gateway/documents/{document_id}": patch(
        f"{G}/documents/{{document}}", owner_or_admins(), json={"description": "x"}
    ),
    "DELETE /gateway/documents/{document_id}": delete(
        f"{G}/documents/{{document}}", owner_or_admins()
    ),
    "GET /gateway/documents/{document_id}/rooms": get(
        f"{G}/documents/{{document}}/rooms", owner_or_admins()
    ),
    "GET /gateway/packages": get(f"{G}/packages", anyone()),
    "POST /gateway/packages": post(
        f"{G}/packages",
        SELF,
        json={"name": "{tag}-new", "description": "", "instructions": ""},
    ),
    "GET /gateway/packages/{package_id}": get(
        f"{G}/packages/{{package}}", owner_or_admins()
    ),
    "PATCH /gateway/packages/{package_id}": patch(
        f"{G}/packages/{{package}}", owner_or_admins(), json={"description": "x"}
    ),
    "DELETE /gateway/packages/{package_id}": delete(
        f"{G}/packages/{{package}}", owner_or_admins()
    ),
    "GET /gateway/packages/{package_id}/rooms": get(
        f"{G}/packages/{{package}}/rooms", owner_or_admins()
    ),
    "GET /gateway/packages/{package_id}/references": get(
        f"{G}/packages/{{package}}/references", owner_or_admins()
    ),
    "POST /gateway/packages/{package_id}/references/{reference_id}": post(
        f"{G}/packages/{{package}}/references/{{reference}}", owner_or_admins()
    ),
    "DELETE /gateway/packages/{package_id}/references/{reference_id}": delete(
        f"{G}/packages/{{package_reference}}/references/{{reference}}",
        owner_or_admins(),
    ),
    "GET /gateway/packages/{package_id}/documents": get(
        f"{G}/packages/{{package}}/documents", owner_or_admins()
    ),
    "POST /gateway/packages/{package_id}/documents/{document_id}": post(
        f"{G}/packages/{{package}}/documents/{{document}}", owner_or_admins()
    ),
    "DELETE /gateway/packages/{package_id}/documents/{document_id}": delete(
        f"{G}/packages/{{package_document}}/documents/{{document}}",
        owner_or_admins(),
    ),
    # ── Templates ────────────────────────────────────────────────────────
    "GET /gateway/templates": get(f"{G}/templates", anyone()),
    "POST /gateway/templates": post(
        f"{G}/templates", SELF, json={"name": "{tag}-new", "content": "name: x\n"}
    ),
    "POST /gateway/templates/validate": post(
        f"{G}/templates/validate", SELF, json={"content": "name: x\n"}
    ),
    "GET /gateway/templates/{template_id}": get(
        f"{G}/templates/{{template}}",
        owner_or_admins(refused=404),
        why="A private template is not there for whoever may not read it.",
    ),
    "GET /gateway/templates/{template_id}/content": get(
        f"{G}/templates/{{template}}/content", owner_or_admins(refused=404)
    ),
    "PATCH /gateway/templates/{template_id}": patch(
        f"{G}/templates/{{template}}",
        owner_or_admins(refused=404),
        json={"description": "changed"},
    ),
    "DELETE /gateway/templates/{template_id}": delete(
        f"{G}/templates/{{template}}", owner_or_admins(refused=404)
    ),
    "GET /gateway/template-runs": get(f"{G}/template-runs", anyone()),
    "POST /gateway/template-runs/{root_room_id}/stop": post(
        f"{G}/template-runs/{{room}}/stop",
        admins(),
        why=(
            "An admin, an owner of an agent in the run, or whoever ran it: "
            "owning its first room is none of those."
        ),
    ),
    "POST /gateway/template-runs/{root_room_id}/continue": post(
        f"{G}/template-runs/{{room}}/continue", admins()
    ),
    # ── Messaging apps ───────────────────────────────────────────────────
    "GET /gateway/collaborations": get(f"{G}/collaborations", anyone()),
    "GET /gateway/collaborations/types": get(f"{G}/collaborations/types", anyone()),
    "GET /gateway/collaborations/setup/slack": get(
        f"{G}/collaborations/setup/slack", admins()
    ),
    "POST /gateway/collaborations/setup/slack/check": post(
        f"{G}/collaborations/setup/slack/check",
        admins(ok=422),
        json={"bot_token": "not-a-bot-token", "app_token": "not-an-app-token"},
        why="Let through, then refused before Slack is asked: neither token is one.",
    ),
    "POST /gateway/collaborations": post(
        f"{G}/collaborations",
        admins(),
        json={
            "bridge_type": "mattermost",
            "display_name": "{tag}-new-bridge",
            "connection_config": {},
        },
    ),
    "PATCH /gateway/collaborations/{bridge_id}": patch(
        f"{G}/collaborations/{{bridge}}",
        admins(),
        json={"agent_greetings_enabled": True},
    ),
    "POST /gateway/collaborations/{bridge_id}/default": post(
        f"{G}/collaborations/{{bridge}}/default", admins()
    ),
    "DELETE /gateway/collaborations/{bridge_id}": delete(
        f"{G}/collaborations/{{bridge}}", admins()
    ),
    "GET /gateway/collaborations/{bridge_id}/users": get(
        f"{G}/collaborations/{{bridge}}/users", anyone()
    ),
    "GET /gateway/collaborations/{bridge_id}/directory": get(
        f"{G}/collaborations/{{bridge}}/directory",
        anyone(ok=409),
        why="Anyone in the workspace; the bridge isn't running to search.",
        query="matrix",
    ),
    "POST /gateway/collaborations/{bridge_id}/identities": post(
        f"{G}/collaborations/{{bridge}}/identities",
        owner_or_admins(ok=409),
        json={
            "external_user_id": "U-{tag}-claimed",
            "username": "claimed",
            "user_id": "{owner}",
            "expects_confirmation": True,
        },
        why=(
            "Claiming an account for someone: themselves, or anyone for an "
            "admin; then refused, the bridge not running to check the account."
        ),
    ),
    "DELETE /gateway/collaborations/{bridge_id}/identities/{external_user_row_id}": Case(
        Ask(
            "DELETE",
            f"{G}/collaborations/{{bridge}}/identities/{{identity}}",
            params={"user_id": "{owner}"},
        ),
        owner_or_admins(),
        why="Dropping someone's claim: their own, or anyone's for an admin.",
    ),
    "DELETE /gateway/collaborations/{bridge_id}/identities/{external_user_row_id}/request": Case(
        Ask(
            "DELETE",
            f"{G}/collaborations/{{bridge}}/identities/{{identity}}/request",
            params={"user_id": "{owner}"},
        ),
        owner_or_admins(ok=404),
        why="Their own, or anyone's for an admin; there is no link waiting to drop.",
    ),
    "POST /gateway/collaborations/{bridge_id}/identities/{external_user_row_id}/code": post(
        f"{G}/collaborations/{{bridge}}/identities/{{identity}}/code",
        anyone(ok=409),
        why="For the caller's own link; the bridge isn't running to check the account.",
    ),
    "POST /gateway/collaborations/{bridge_id}/identities/{external_user_row_id}/verify-session": post(
        f"{G}/collaborations/{{bridge}}/identities/{{identity}}/verify-session",
        anyone(ok=404),
        json={"token": "session-token"},
        why="For the caller's own link waiting to be confirmed; nobody has one.",
    ),
    "GET /gateway/collaborations/{bridge_id}/identities/unconfirmed": get(
        f"{G}/collaborations/{{bridge}}/identities/unconfirmed", admins()
    ),
    "POST /gateway/collaborations/{bridge_id}/identities/require-confirmation": post(
        f"{G}/collaborations/{{bridge}}/identities/require-confirmation",
        admins(),
        json={"links": []},
    ),
    "GET /gateway/collaborations/{bridge_id}/teams": get(
        f"{G}/collaborations/{{bridge}}/teams", admins(ok=404)
    ),
    "POST /gateway/collaborations/{bridge_id}/teams/{team_id}": post(
        f"{G}/collaborations/{{bridge}}/teams/team-1", admins(ok=404)
    ),
    "DELETE /gateway/collaborations/{bridge_id}/teams/{team_id}": delete(
        f"{G}/collaborations/{{bridge}}/teams/team-1", admins(ok=404)
    ),
    "GET /gateway/collaborations/{bridge_id}/teams-package": get(
        f"{G}/collaborations/{{bridge}}/teams-package", admins(ok=404)
    ),
    "GET /gateway/messaging-apps": get(f"{G}/messaging-apps", anyone()),
    "POST /gateway/messaging-apps/{platform}/claim": post(
        f"{G}/messaging-apps/telegram/claim",
        admins(),
        why="A member adds a chat only once an admin has connected the platform.",
    ),
    "POST /gateway/messaging-apps/{platform}/install": post(
        f"{G}/messaging-apps/slack/install", admins()
    ),
    "GET /gateway/messaging-apps/installs": get(
        f"{G}/messaging-apps/installs", anyone()
    ),
    "DELETE /gateway/messaging-apps/installs/{install_id}": delete(
        f"{G}/messaging-apps/installs/{{oauth_install}}",
        admins(),
        why="An OAuth install is the workspace's admins'.",
    ),
    # ── Devices ──────────────────────────────────────────────────────────
    "POST /gateway/management/enrollment-codes": post(
        f"{G}/management/enrollment-codes", SELF
    ),
    "POST /gateway/management/controllers": post(
        f"{G}/management/controllers",
        SELF,
        json={
            "name": "{tag}-console",
            "kind": "console",
            "platform": {"os": "linux", "arch": "x64", "os_version": "6.1.0"},
            "version": "0.1.0",
        },
    ),
    "GET /gateway/management/controllers": get(f"{G}/management/controllers", SELF),
    "PATCH /gateway/management/controllers/{controller_id}": patch(
        f"{G}/management/controllers/{{controller}}",
        owner(),
        json={"description": "changed"},
        why="Every machine is its owner's alone; anyone else is told it isn't there.",
    ),
    "DELETE /gateway/management/controllers/{controller_id}": delete(
        f"{G}/management/controllers/{{controller}}", owner()
    ),
    "GET /gateway/management/controllers/{controller_id}/provider-logins": get(
        f"{G}/management/controllers/{{controller}}/provider-logins", owner()
    ),
    "PUT /gateway/management/controllers/{controller_id}/provider-logins/{provider}": put(
        f"{G}/management/controllers/{{controller}}/provider-logins/claude",
        owner(ok=409),
        json={"sealed": "{sealed_login}"},
        why="Its owner's; refused then, the machine having no key to seal to.",
    ),
    "DELETE /gateway/management/controllers/{controller_id}/provider-logins/{provider}": delete(
        f"{G}/management/controllers/{{controller}}/provider-logins/claude",
        owner(ok=404),
        why="Its owner's; it has no login for this provider to withdraw.",
    ),
    "GET /gateway/management/agents": get(f"{G}/management/agents", SELF),
    "POST /gateway/management/agents": post(
        f"{G}/management/agents",
        SELF,
        json={
            "name": "{tag}-managed",
            "description": "",
            "controller_id": None,
            "desired_state": "stopped",
            "definition": "{definition}",
        },
    ),
    "GET /gateway/management/agents/{agent_id}": get(
        f"{G}/management/agents/{{managed_agent}}", owner()
    ),
    "PUT /gateway/management/agents/{agent_id}": put(
        f"{G}/management/agents/{{managed_agent}}",
        owner(),
        json={
            "controller_id": None,
            "desired_state": "stopped",
            "definition": "{definition}",
        },
    ),
    "PATCH /gateway/management/agents/{agent_id}": patch(
        f"{G}/management/agents/{{managed_agent}}",
        owner(),
        json={"desired_state": "stopped"},
    ),
    "DELETE /gateway/management/agents/{agent_id}": delete(
        f"{G}/management/agents/{{managed_agent}}", owner()
    ),
    "POST /gateway/management/operations": post(
        f"{G}/management/operations",
        owner(),
        json={
            "controller_id": "{controller}",
            "kind": "provider.recheck",
            "params": {"provider": "claude"},
        },
    ),
    "GET /gateway/management/operations": get(
        f"{G}/management/operations", owner(), controller_id="{controller}"
    ),
    "GET /gateway/management/providers": get(f"{G}/management/providers", anyone()),
    "GET /gateway/management/advanced-config": get(
        f"{G}/management/advanced-config", anyone(), provider="claude"
    ),
    "GET /gateway/hosted-machines": get(f"{G}/hosted-machines", SELF),
    "POST /gateway/hosted-machines/ensure": post(
        f"{G}/hosted-machines/ensure",
        anyone(ok=503),
        why="Your own; this server offers no cloud machines.",
    ),
    "GET /gateway/hosted-machines/{machine_id}": get(
        f"{G}/hosted-machines/no-such-machine",
        anyone(ok=404),
        why="Your own machine; nobody here has one.",
    ),
    "POST /gateway/hosted-machines/{machine_id}/lifecycle": post(
        f"{G}/hosted-machines/no-such-machine/lifecycle",
        anyone(ok=404),
        json={"action": "stop", "revision": 1},
        why="Your own machine; nobody here has one.",
    ),
    # ── Connections ──────────────────────────────────────────────────────
    "GET /gateway/provider-connections/catalog": get(
        f"{G}/provider-connections/catalog", SELF
    ),
    "GET /gateway/service-connections": get(f"{G}/service-connections", SELF),
    "GET /gateway/service-connections/{service}/agents": get(
        f"{G}/service-connections/github/agents", SELF
    ),
    "PUT /gateway/service-connections/{service}/key": put(
        f"{G}/service-connections/datadog/key",
        anyone(ok=403),
        json={"fields": {"api_key": "matrix", "application_key": "matrix"}},
        why="Your own connection; refused for anyone, Datadog keys never being handed to agents.",
    ),
    "DELETE /gateway/service-connections/{service}": delete(
        f"{G}/service-connections/github",
        anyone(ok=404),
        why="Ends the caller's own connection, and none of them has one.",
    ),
    "POST /gateway/service-connections/{service}/flows": post(
        f"{G}/service-connections/atlassian/flows",
        anyone(ok=503),
        json=FLOW,
        why="Your own sign-in; this server has no Atlassian app to sign in through.",
    ),
    "GET /gateway/service-connections/{service}/flows/{flow_id}": get(
        f"{G}/service-connections/atlassian/flows/{{service_flow}}",
        owner(refused=410),
        why="Its owner's; anyone else is told it was interrupted, as if it were gone.",
    ),
    "DELETE /gateway/service-connections/{service}/flows/{flow_id}": delete(
        f"{G}/service-connections/atlassian/flows/{{service_flow}}",
        owner(refused=410),
    ),
    "POST /gateway/service-connections/{service}/flows/{flow_id}/complete": post(
        f"{G}/service-connections/atlassian/flows/{{service_flow}}/complete",
        owner(ok=503, refused=410),
        json={"completion_secret": "{flow_secret}", "code": "matrix"},
        why="Its owner's; refused then, this server having no Atlassian app.",
    ),
    "GET /gateway/provider-connections/github": get(
        f"{G}/provider-connections/github", SELF
    ),
    "DELETE /gateway/provider-connections/github": delete(
        f"{G}/provider-connections/github", SELF
    ),
    "POST /gateway/provider-connections/github/flows": post(
        f"{G}/provider-connections/github/flows", SELF, json=FLOW
    ),
    "GET /gateway/provider-connections/github/flows/{flow_id}": get(
        f"{G}/provider-connections/github/flows/{{github_flow}}", owner()
    ),
    "DELETE /gateway/provider-connections/github/flows/{flow_id}": delete(
        f"{G}/provider-connections/github/flows/{{github_flow}}", owner()
    ),
    "POST /gateway/provider-connections/github/flows/{flow_id}/complete": post(
        f"{G}/provider-connections/github/flows/{{github_flow}}/complete",
        owner(ok=400),
        json={"completion_secret": "{flow_secret}", "code": "matrix"},
        why="Its owner's; refused then, the secret not being the one it was started with.",
    ),
    # ── Overview ─────────────────────────────────────────────────────────
    "GET /gateway/ecosystem/graph": get(f"{G}/ecosystem/graph", anyone()),
}

# Chats: a Switch Console chat is a room only the people in it may open, so
# everyone else is refused whatever they administer; its owner manages it.
CHAT = f"{G}/chats/{{chat}}"
MEMBERS_OF_IT = owner(refused=403)

ROUTES.update(
    {
        "GET /gateway/chats": get(f"{G}/chats", SELF),
        "GET /gateway/chats/archived": get(f"{G}/chats/archived", SELF),
        "GET /gateway/chats/agent-candidates": get(f"{G}/chats/agent-candidates", SELF),
        "POST /gateway/chats": post(
            f"{G}/chats",
            SELF,
            json={"agentId": "{agent}", "requestId": "{tag}-new-chat"},
            why="Anyone may start a chat with an agent open to them.",
        ),
        "GET /gateway/chats/{room_id}/activity": get(f"{CHAT}/activity", MEMBERS_OF_IT),
        "GET /gateway/chats/{room_id}/messages": get(f"{CHAT}/messages", MEMBERS_OF_IT),
        "GET /gateway/chats/{room_id}/threads/{root_id}/messages": get(
            f"{CHAT}/threads/no-such-root/messages",
            owner(ok=404, refused=403),
            why="The people in it; there is no such thread.",
        ),
        "GET /gateway/chats/{room_id}/media": get(
            f"{CHAT}/media",
            owner(ok=404, refused=403),
            why="The people in it; there is no such file.",
            uri="mxc://switch.test/no-such-file",
        ),
        "GET /gateway/chats/{room_id}/members": get(f"{CHAT}/members", MEMBERS_OF_IT),
        "GET /gateway/chats/{room_id}/commands": get(f"{CHAT}/commands", MEMBERS_OF_IT),
        "POST /gateway/chats/{room_id}/messages": post(
            f"{CHAT}/messages",
            MEMBERS_OF_IT,
            json={"requestId": "{tag}-message", "body": "hello"},
        ),
        "POST /gateway/chats/{room_id}/controls": post(
            f"{CHAT}/controls",
            owner(ok=409, refused=403),
            json={
                "requestId": "{tag}-control",
                "agentId": "{agent}",
                "command": "interrupt",
            },
            why="The people in it; nothing is running to interrupt.",
        ),
        "POST /gateway/chats/{room_id}/warm": post(
            f"{CHAT}/warm", MEMBERS_OF_IT, json={"agentId": "{agent}"}
        ),
        "PUT /gateway/chats/{room_id}/read": put(
            f"{CHAT}/read", MEMBERS_OF_IT, json={"seq": 0}
        ),
        "PUT /gateway/chats/{room_id}/hidden": put(f"{CHAT}/hidden", MEMBERS_OF_IT),
        "DELETE /gateway/chats/{room_id}/hidden": delete(
            f"{CHAT}/hidden", MEMBERS_OF_IT
        ),
        "POST /gateway/chats/{room_id}/members": post(
            f"{CHAT}/members",
            owner_or_admins(),
            json={"userId": "{member}"},
            why="Its owner, or an admin, manages who is in it.",
        ),
        "DELETE /gateway/chats/{room_id}/members/{member_user_id}": delete(
            f"{CHAT}/members/{{chat_guest}}", owner_or_admins()
        ),
        "POST /gateway/chats/{room_id}/agents": post(
            f"{CHAT}/agents", owner_or_admins(), json={"agentId": "{other_agent}"}
        ),
        "DELETE /gateway/chats/{room_id}/agents/{agent_id}": delete(
            f"{CHAT}/agents/{{agent}}", owner_or_admins()
        ),
        "POST /gateway/chats/{room_id}/archive": post(
            f"{CHAT}/archive",
            MEMBERS_OF_IT,
            why="Archiving is for the people in it, whoever administers the workspace.",
        ),
        "POST /gateway/chats/{room_id}/unarchive": post(
            f"{CHAT}/unarchive", MEMBERS_OF_IT
        ),
    }
)

# Routes whose answers stream, asked by `test_streams_answer_whom_they_should`.
STREAMS: dict[str, Case] = {
    "GET /gateway/chats/events": get(f"{G}/chats/events", SELF),
    "GET /gateway/chats/activity/events": get(f"{G}/chats/activity/events", SELF),
    "WS /gateway/changes/ws": get(f"{G}/changes/ws", SELF),
    "POST /gateway/chats/{room_id}/attachments": post(
        f"{CHAT}/attachments", MEMBERS_OF_IT
    ),
}

# Routes that take no session, or the hosted controller's token: no persona
# changes their answer, so each is asked once and must answer the same to all.
UNAUTHENTICATED: dict[str, str] = {
    "GET /gateway/agents/known-types": "The agent types any client may register.",
    "GET /gateway/auth/config": "How to sign in, read before anyone has.",
    "GET /gateway/auth/oidc/callback": "A sign-in coming back from the identity provider.",
    "GET /gateway/auth/oidc/login": "Starting a sign-in.",
    "POST /gateway/auth/oidc/exchange": "Finishing a sign-in with its one-time code.",
    "POST /gateway/auth/login": "Signing in.",
    "POST /gateway/auth/logout": "Signing out, which only clears the cookie.",
    "POST /gateway/auth/signup": "Signing up.",
    "GET /gateway/docs": "The API's own documentation.",
    "GET /gateway/docs/oauth2-redirect": "The API's own documentation.",
    "GET /gateway/openapi.json": "The API's own documentation.",
    "GET /gateway/redoc": "The API's own documentation.",
    "GET /gateway/provider-connections/github/authorize": (
        "A browser handoff, tied to its flow by the state it carries."
    ),
    "GET /gateway/provider-connections/github/callback": (
        "A browser handoff, tied to its flow by the state it carries."
    ),
    "GET /gateway/service-connections/{service}/flows/authorize": (
        "A browser handoff, tied to its flow by the state it carries."
    ),
    "GET /gateway/service-connections/{service}/flows/callback": (
        "A browser handoff, tied to its flow by the state it carries."
    ),
    "GET /gateway/hosted-controller/machines": (
        "The hosted controller's, with its operator token; no session reaches it."
    ),
    "POST /gateway/hosted-controller/machines/{machine_id}/observation": (
        "The hosted controller's, with its operator token; no session reaches it."
    ),
    "POST /gateway/hosted-controller/machines/{machine_id}/prepare": (
        "The hosted controller's, with its operator token; no session reaches it."
    ),
}
