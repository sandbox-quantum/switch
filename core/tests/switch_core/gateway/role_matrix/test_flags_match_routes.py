"""Every capability flag says what its route does.

Each persona reads a flag where the Gateway shows it, then asks the route it
speaks for. A flag that says yes must be let through, and one that says no
must be refused: so a wrong flag can't hide behind a correct route. A check
names the refusals a flag leaves to the moment it is asked (the workspace
isn't empty, say), which count as let through; any other answer, a server
error above all, fails it either way.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tests.switch_core.gateway.role_matrix.access import OK
from tests.switch_core.gateway.role_matrix.harness import (
    Persona,
    build_gateway,
    client,
    seed_people,
)
from tests.switch_core.gateway.role_matrix.routes import Ask
from tests.switch_core.gateway.role_matrix.world import World

G = "/gateway"
REFUSED = frozenset({403, 404, 410})


@dataclass(frozen=True)
class Check:
    flag: str
    read: Ask
    act: Ask
    # Where the thing is in what `read` answers: the key of the list holding
    # it (None for a list answered bare), and the field and `World` name that
    # pick it out of the list; no `match` for a detail answered alone.
    match: tuple[str, str] | None = None
    within: str | None = None
    # What the route answers when it says no to what the flag covers.
    refused: frozenset[int] = REFUSED
    # What it answers, past what the flag covers, when the thing can't be
    # done just then: let through as far as the flag is concerned.
    later: frozenset[int] = frozenset()


def _get(path: str, **params: str) -> Ask:
    return Ask("GET", path, params=params)


def _act(method: str, path: str, json: Any = None, **params: str) -> Ask:
    return Ask(method, path, json=json, params=params)


def _transfer(kind: str, thing: str) -> Ask:
    return _act(
        "POST",
        f"{G}/ownership/transfer",
        {"kind": kind, "id": thing, "new_owner_id": "{member_target}"},
    )


def _resource(kind: str, path: str, transfers: bool) -> list[Check]:
    detail = _get(f"{G}/{path}/{{{kind}}}")
    checks = [
        Check(
            "can_edit",
            detail,
            _act("PATCH", f"{G}/{path}/{{{kind}}}", {"description": "x"}),
        ),
        Check("can_manage", detail, _act("DELETE", f"{G}/{path}/{{{kind}}}")),
    ]
    if transfers:
        checks.append(Check("can_transfer", detail, _transfer(kind, f"{{{kind}}}")))
    return checks


AGENT = _get(f"{G}/agents/{{agent}}")
MEMBERS = _get(f"{G}/tenants/{{tenant}}/members")
ORG_MEMBERS = _get(f"{G}/organizations/current/members")
WORKSPACE_SERVICES = _get(f"{G}/workspace/services")

CHECKS: dict[str, Check] = {
    f"{check.flag} on {name}, asking {check.act.method} {check.act.path}": check
    for name, checks in {
        "a reference": [
            *_resource("reference", "references", transfers=False),
            Check(
                "can_manage",
                _get(f"{G}/references/{{reference}}"),
                _transfer("reference", "{reference}"),
            ),
        ],
        "a document": _resource("document", "documents", transfers=True),
        "a room's own document": [
            Check(
                flag,
                _get(f"{G}/documents/{{room_document_itself}}"),
                act,
                refused=REFUSED | {409},
            )
            for flag, act in (
                (
                    "can_edit",
                    _act(
                        "PATCH",
                        f"{G}/documents/{{room_document_itself}}",
                        {"description": "x"},
                    ),
                ),
                (
                    "can_manage",
                    _act("DELETE", f"{G}/documents/{{room_document_itself}}"),
                ),
                ("can_transfer", _transfer("document", "{room_document_itself}")),
            )
        ],
        "a package": [
            *_resource("package", "packages", transfers=False),
            Check(
                "can_manage",
                _get(f"{G}/packages/{{package}}"),
                _transfer("package", "{package}"),
            ),
        ],
        # A list may name a private item to whoever may read what holds it;
        # its `can_read` says whether its own page opens for them.
        **{
            f"a private {kind} in a {holder}": [
                Check(
                    "can_read",
                    _get(f"{G}/{holders}/{{{held_by}}}/{kind}s"),
                    _get(f"{G}/{kind}s/{{{thing}}}"),
                    match=("id", thing),
                )
            ]
            for kind, holder, holders, held_by, thing in (
                (
                    "reference",
                    "package",
                    "packages",
                    "readable_package",
                    "packaged_reference",
                ),
                (
                    "document",
                    "package",
                    "packages",
                    "readable_package",
                    "packaged_document",
                ),
                ("reference", "room", "rooms", "readable_room", "shown_reference"),
                ("document", "room", "rooms", "readable_room", "shown_document"),
            )
        },
        "a template": [
            Check(
                "can_edit",
                _get(f"{G}/templates/{{template}}"),
                _act("PATCH", f"{G}/templates/{{template}}", {"description": "x"}),
            ),
            Check(
                "can_manage",
                _get(f"{G}/templates/{{template}}"),
                _act("DELETE", f"{G}/templates/{{template}}"),
            ),
        ],
        "a reference type": [
            Check(
                "can_edit",
                _get(f"{G}/references/reference-types/owned"),
                _act(
                    "PATCH",
                    f"{G}/references/reference-types/{{reference_type}}",
                    {"display_name": "x"},
                ),
                match=("type", "reference_type"),
            ),
            Check(
                "can_manage",
                _get(f"{G}/references/reference-types/owned"),
                _act("DELETE", f"{G}/references/reference-types/{{reference_type}}"),
                match=("type", "reference_type"),
            ),
        ],
        **{
            f"a room ({who})": [
                Check(
                    "can_write",
                    _get(f"{G}/rooms/{{{room}}}"),
                    _act("PATCH", f"{G}/rooms/{{{room}}}", {"description": "x"}),
                ),
                Check(
                    "can_manage",
                    _get(f"{G}/rooms/{{{room}}}"),
                    _act("DELETE", f"{G}/rooms/{{{room}}}"),
                ),
                Check(
                    "can_archive",
                    _get(f"{G}/rooms/{{{room}}}"),
                    _act("POST", f"{G}/rooms/{{{room}}}/archive"),
                ),
                Check(
                    "can_manage_admins",
                    _get(f"{G}/rooms/{{{room}}}"),
                    _act("PUT", f"{G}/rooms/{{{room}}}/admins/{{member_target}}"),
                    # The target isn't in the room: allowed to ask, refused for them.
                    later=frozenset({400}),
                ),
                Check(
                    "can_transfer",
                    _get(f"{G}/rooms/{{{room}}}"),
                    _transfer("room", f"{{{room}}}"),
                ),
                Check(
                    "can_attach",
                    _get(f"{G}/rooms/{{{room}}}"),
                    _act("POST", f"{G}/rooms/{{{room}}}/documents/{{public_document}}"),
                ),
                Check(
                    "can_invite_agents",
                    _get(f"{G}/rooms/{{{room}}}"),
                    _act(
                        "POST",
                        f"{G}/rooms/{{{room}}}/agents",
                        {"agent_ids": ["{open_agent}"]},
                    ),
                ),
                *(
                    Check(
                        flag,
                        _get(f"{G}/rooms/{{{room}}}"),
                        _act("DELETE", f"{G}/rooms/{{{room}}}/agents/{{agent}}"),
                    )
                    for flag in ("can_remove_members", "can_change_members")
                ),
                Check(
                    "can_unlink",
                    _get(f"{G}/rooms/{{{room}}}"),
                    _act("DELETE", f"{G}/rooms/{{{room}}}/references/{{reference}}"),
                ),
            ]
            for who, room in (
                ("everyone reads it", "readable_room"),
                ("the member is in it", "joined_room"),
                ("the member is a room admin", "administered_room"),
            )
        },
        "a direct conversation": [
            Check(
                "can_invite_agents",
                _get(f"{G}/rooms/{{direct_room}}"),
                _act(
                    "POST",
                    f"{G}/rooms/{{direct_room}}/agents",
                    {"agent_ids": ["{agent}"]},
                ),
                refused=REFUSED | {409},
            ),
            Check(
                "can_change_members",
                _get(f"{G}/rooms/{{direct_room}}"),
                _act(
                    "POST",
                    f"{G}/rooms/{{direct_room}}/users",
                    {"user_names": ["someone"]},
                ),
                refused=REFUSED | {409},
            ),
        ],
        "a chat": [
            Check(
                "can_transfer",
                _get(f"{G}/rooms/{{chat}}"),
                _transfer("room", "{chat}"),
                refused=REFUSED | {409},
            ),
        ],
        "an agent": [
            Check(
                "can_manage",
                AGENT,
                _act("PUT", f"{G}/agents/{{agent}}/description", {"description": "x"}),
            ),
            Check(
                "can_rename",
                AGENT,
                _act(
                    "PUT",
                    f"{G}/agents/{{agent}}/name",
                    {"name": "{tag}-renamed", "display_name": None},
                ),
            ),
            Check("can_transfer", AGENT, _transfer("agent", "{agent}")),
            Check(
                "can_change_manage_agents",
                AGENT,
                _act(
                    "PUT", f"{G}/agents/{{agent}}/can-manage-agents", {"enabled": False}
                ),
            ),
            Check(
                "can_edit_options",
                AGENT,
                _act("PATCH", f"{G}/agents/{{agent}}/options", {"options": {}}),
                refused=REFUSED | {400},
            ),
            Check(
                "can_grant_services",
                AGENT,
                _act(
                    "PUT",
                    f"{G}/agents/{{agent}}/service-grants/github",
                    {"access": "read", "resources": {}},
                ),
                refused=REFUSED | {422},
            ),
        ],
        "an agent Switch Console runs": [
            Check(
                "can_edit_options",
                _get(f"{G}/agents/{{console_agent}}"),
                _act("PATCH", f"{G}/agents/{{console_agent}}/options", {"options": {}}),
            ),
            Check(
                "can_grant_services",
                _get(f"{G}/agents/{{console_agent}}"),
                _act(
                    "PUT",
                    f"{G}/agents/{{console_agent}}/service-grants/github",
                    {"access": "read", "resources": {}},
                ),
            ),
        ],
        "a sub-agent": [
            Check(
                "can_rename",
                _get(f"{G}/agents/{{sub_agent}}"),
                _act(
                    "PUT",
                    f"{G}/agents/{{sub_agent}}/name",
                    {"name": "{tag}-renamed", "display_name": None},
                ),
                refused=REFUSED | {400},
            ),
            Check(
                "can_transfer",
                _get(f"{G}/agents/{{sub_agent}}"),
                _transfer("agent", "{sub_agent}"),
                refused=REFUSED | {409},
            ),
        ],
        "a workspace member": [
            Check(
                "can_change_role",
                MEMBERS,
                _act(
                    "PATCH",
                    f"{G}/tenants/{{tenant}}/members/{{member_target}}",
                    {"role": "member"},
                ),
                match=("user_id", "member_target"),
            ),
            Check(
                "can_remove",
                MEMBERS,
                _act("DELETE", f"{G}/tenants/{{tenant}}/members/{{member_target}}"),
                match=("user_id", "member_target"),
            ),
        ],
        "your own membership": [
            Check(
                "can_change_role",
                MEMBERS,
                _act(
                    "PATCH",
                    f"{G}/tenants/{{tenant}}/members/{{self_id}}",
                    {"role": "member"},
                ),
                match=("user_id", "self_id"),
                refused=REFUSED | {409},  # The last admin stays.
            ),
            Check(
                "can_remove",
                MEMBERS,
                _act("DELETE", f"{G}/tenants/{{tenant}}/members/{{self_id}}"),
                match=("user_id", "self_id"),
                refused=REFUSED | {409},  # The last admin stays.
                later=frozenset({409}),  # Still owning agents.
            ),
        ],
        "your own organization membership": [
            Check(
                "can_change_role",
                ORG_MEMBERS,
                _act(
                    "PATCH",
                    f"{G}/organizations/current/members/{{self_id}}",
                    {"role": "member"},
                ),
                match=("user_id", "self_id"),
                later=frozenset({409}),  # The last organization admin stays.
            ),
            Check(
                "can_remove",
                ORG_MEMBERS,
                _act("DELETE", f"{G}/organizations/current/members/{{self_id}}"),
                match=("user_id", "self_id"),
                later=frozenset({409}),  # The last one, or still in a workspace.
            ),
        ],
        "the workspace": [
            Check(
                "can_delete",
                _get(f"{G}/tenants/current"),
                _act("DELETE", f"{G}/tenants/{{tenant}}", {"name": "{tenant}"}),
                later=frozenset({409}),  # Still has other members in it.
            ),
            Check(
                "administers",
                _get(f"{G}/tenants/current"),
                _act("PATCH", f"{G}/tenants/{{tenant}}", {"name": "{tag}-renamed"}),
            ),
            Check(
                "can_manage_data_protection",
                _get(f"{G}/tenants/current"),
                _act(
                    "PUT",
                    f"{G}/tenants/{{tenant}}/retention",
                    {"message_retention_days": 30},
                ),
            ),
            Check(
                "can_manage_data_protection",
                _get(f"{G}/tenants/current"),
                _get(f"{G}/tenants/{{tenant}}/people"),
            ),
            Check(
                "can_manage_data_protection",
                _get(f"{G}/tenants/current"),
                _act(
                    "POST",
                    f"{G}/tenants/{{tenant}}/erasures",
                    {"external_user_ids": ["{tag}-nobody"]},
                ),
                later=frozenset({404}),  # Nobody has that id.
            ),
        ],
        "the organization": [
            Check(
                "can_manage_members", _get(f"{G}/organizations/current"), ORG_MEMBERS
            ),
            Check(
                "administers",
                _get(f"{G}/organizations/current"),
                _get(f"{G}/organizations/current/audit-events"),
            ),
            Check(
                "administers",
                _get(f"{G}/organizations/current"),
                _act("PATCH", f"{G}/organizations/current", {"name": "{tag}-org"}),
            ),
        ],
        "an organization member": [
            Check(
                "can_change_role",
                ORG_MEMBERS,
                _act(
                    "PATCH",
                    f"{G}/organizations/current/members/{{org_target}}",
                    {"role": "member"},
                ),
                match=("user_id", "org_target"),
            ),
            Check(
                "can_remove",
                ORG_MEMBERS,
                _act("DELETE", f"{G}/organizations/current/members/{{org_target}}"),
                match=("user_id", "org_target"),
            ),
        ],
        "an API key": [
            Check(
                "can_reveal",
                _get(f"{G}/api-keys"),
                _get(f"{G}/api-keys/{{registration_key}}/reveal"),
                match=("id", "registration_key"),
            ),
            Check(
                "can_delete",
                _get(f"{G}/api-keys"),
                _act("DELETE", f"{G}/api-keys/{{registration_key}}"),
                match=("id", "registration_key"),
            ),
        ],
        "an agent's key": [
            Check(
                "can_delete",
                _get(f"{G}/api-keys"),
                _act("DELETE", f"{G}/api-keys/{{agent_key}}"),
                match=("id", "agent_key"),
                refused=REFUSED | {409},
            ),
        ],
        "an API key, among the workspace's": [
            Check(
                "can_reveal",
                _get(f"{G}/api-keys/workspace"),
                _get(f"{G}/api-keys/{{registration_key}}/reveal"),
                match=("id", "registration_key"),
            ),
            Check(
                "can_delete",
                _get(f"{G}/api-keys/workspace"),
                _act("DELETE", f"{G}/api-keys/{{registration_key}}"),
                match=("id", "registration_key"),
            ),
        ],
        "an agent's key, among the workspace's": [
            Check(
                "can_delete",
                _get(f"{G}/api-keys/workspace"),
                _act("DELETE", f"{G}/api-keys/{{agent_key}}"),
                match=("id", "agent_key"),
                refused=REFUSED | {409},
            ),
        ],
        "a machine": [
            Check(
                "can_edit",
                _get(f"{G}/management/controllers"),
                _act(
                    "PATCH",
                    f"{G}/management/controllers/{{controller}}",
                    {"description": "x"},
                ),
                match=("id", "controller"),
            ),
            Check(
                "can_remove",
                _get(f"{G}/management/controllers"),
                _act("DELETE", f"{G}/management/controllers/{{controller}}"),
                match=("id", "controller"),
            ),
        ],
        "a managed agent": [
            Check(
                "can_edit",
                _get(f"{G}/management/agents"),
                _act(
                    "PATCH",
                    f"{G}/management/agents/{{managed_agent}}",
                    {"desired_state": "stopped"},
                ),
                match=("agent_id", "managed_agent"),
            ),
            Check(
                "can_delete",
                _get(f"{G}/management/agents"),
                _act("DELETE", f"{G}/management/agents/{{managed_agent}}"),
                match=("agent_id", "managed_agent"),
            ),
        ],
        "a device, among the workspace's": [
            Check(
                "can_edit",
                _get(f"{G}/management/workspace"),
                _act(
                    "PATCH",
                    f"{G}/management/controllers/{{controller}}",
                    {"description": "x"},
                ),
                match=("id", "controller"),
                within="devices",
            ),
            Check(
                "can_recheck",
                _get(f"{G}/management/workspace"),
                _act(
                    "POST",
                    f"{G}/management/operations",
                    {
                        "controller_id": "{controller}",
                        "agent_id": None,
                        "kind": "provider.recheck",
                        "params": {"provider": "claude"},
                    },
                ),
                match=("id", "controller"),
                within="devices",
            ),
            Check(
                "can_remove",
                _get(f"{G}/management/workspace"),
                _act("DELETE", f"{G}/management/controllers/{{controller}}"),
                match=("id", "controller"),
                within="devices",
            ),
        ],
        "a managed agent, among the workspace's": [
            Check(
                "can_edit",
                _get(f"{G}/management/workspace"),
                _act(
                    "PATCH",
                    f"{G}/management/agents/{{managed_agent}}",
                    {"desired_state": "stopped"},
                ),
                match=("agent_id", "managed_agent"),
                within="managed_agents",
            ),
            Check(
                "can_delete",
                _get(f"{G}/management/workspace"),
                _act("DELETE", f"{G}/management/agents/{{managed_agent}}"),
                match=("agent_id", "managed_agent"),
                within="managed_agents",
            ),
        ],
        "a messaging app": [
            Check(
                "can_manage",
                _get(f"{G}/collaborations"),
                _act(
                    "PATCH",
                    f"{G}/collaborations/{{bridge}}",
                    {"agent_greetings_enabled": True},
                ),
                match=("bridge_id", "bridge"),
            ),
            Check(
                "can_delete",
                _get(f"{G}/collaborations"),
                _act("DELETE", f"{G}/collaborations/{{bridge}}"),
                match=("bridge_id", "bridge"),
            ),
        ],
        "the workspace's connectors": [
            Check(
                "can_change",
                WORKSPACE_SERVICES,
                _act(
                    "PUT",
                    f"{G}/workspace/services/{{workspace_service}}",
                    {"enabled": True},
                ),
            ),
        ],
        "a workspace connector": [
            Check(
                "can_change",
                WORKSPACE_SERVICES,
                _act(
                    "PUT",
                    f"{G}/workspace/services/{{workspace_service}}",
                    {"enabled": True},
                ),
                match=("slug", "workspace_service"),
                within="services",
            ),
            Check(
                "can_change",
                WORKSPACE_SERVICES,
                _act("DELETE", f"{G}/workspace/services/{{workspace_service}}"),
                match=("slug", "workspace_service"),
                within="services",
            ),
        ],
        "an install": [
            Check(
                "can_disconnect",
                _get(f"{G}/messaging-apps/installs"),
                _act("DELETE", f"{G}/messaging-apps/installs/{{oauth_install}}"),
                match=("id", "oauth_install"),
                within="installs",
            ),
        ],
        "a claim on a chat account": [
            Check(
                "can_unlink",
                _get(f"{G}/collaborations/{{bridge}}/users"),
                _act(
                    "DELETE",
                    f"{G}/collaborations/{{bridge}}/identities/{{identity}}",
                    user_id="{owner}",
                ),
                match=("id", "identity"),
            ),
        ],
        "a connection": [
            Check(
                "can_revoke",
                _get(f"{G}/service-connections"),
                _act("DELETE", f"{G}/service-connections/{{connection}}"),
                match=("slug", "connection"),
                within="connections",
            ),
        ],
        "an account": [
            Check(
                "can_delete",
                _get(f"{G}/users"),
                _act("DELETE", f"{G}/users/{{user_target}}"),
                match=("id", "user_target"),
            ),
        ],
    }.items()
    for check in checks
}


def _claim(thing: dict[str, Any], owner_id: str) -> dict[str, Any]:
    """A platform account's claim by the owner, which carries the flag."""
    return next(claim for claim in thing["claimed_by"] if claim["user_id"] == owner_id)


@pytest.mark.parametrize("name", sorted(CHECKS))
async def test_a_flag_says_what_its_route_does(
    session_factory: async_sessionmaker[AsyncSession], name: str
) -> None:
    check = CHECKS[name]
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    wrong: list[str] = []
    told: dict[bool, int] = {True: 0, False: 0}
    async with client(gateway) as http:
        for persona in Persona:
            world = World(session_factory, people, persona.value, http, gateway)
            # Made before it is read about, so the list holds it.
            wanted = (
                None
                if check.match is None
                else (await world.fill(Ask("GET", f"{{{check.match[1]}}}"))).path
            )
            read = await world.fill(check.read)
            shown = await http.request(
                read.method,
                read.path,
                params=read.params,
                headers=people.headers(persona),
            )
            if shown.status_code != 200:
                continue  # Not shown to them at all: nothing to say what it means.
            found = shown.json()
            if check.within is not None:
                found = found[check.within]
            if check.match is not None:
                field = check.match[0]
                found = next((row for row in found if row[field] == wanted), None)
                if found is None:
                    continue
            if "on a claim on a chat account" in name:
                found = _claim(found, people.ids[Persona.OWNER])
            flag = bool(found[check.flag])
            told[flag] += 1
            act = await world.fill(check.act)
            answered = await http.request(
                act.method,
                act.path,
                json=act.json,
                params=act.params,
                headers=people.headers(persona),
            )
            if answered.status_code not in (
                OK | check.later if flag else check.refused
            ):
                wrong.append(
                    f"{persona.value}: {check.flag} is {flag}, but {act.method} "
                    f"{act.path} answered {answered.status_code} {answered.text[:200]}"
                )
    assert told[True] + told[False] > 0, "nobody was shown the flag"
    assert not wrong, f"{name}:\n" + "\n".join(wrong)
