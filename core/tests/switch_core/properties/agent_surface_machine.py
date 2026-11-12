"""A Hypothesis state machine over the agent operations, as agents of two tenants.

`tenancy.agent-surface-no-cross-tenant`: no call an agent makes over the agent
HTTP API reads, names or acts on another tenant's objects. The operations are
one definition served over HTTP and MCP, so calling every one of them through
`POST /agents/{id}/ops/{operation}` covers both doors.

Two tenants each have an owner, agents with API keys, rooms the agents are in
and messages in them, every name and body carrying a token found nowhere else.
Each step is an agent of one tenant calling an operation with arguments drawn
from both tenants' ids and names, as a person asking for what is not theirs
would. After each call, as a role row-level security applies to:

- a 2xx response names nothing of the other tenant that the request did not;
- every row the other tenant has is as it was (a count and a hash per table),
  so a write that reached into it is seen whether or not the response said so.

Seeded as the owner and served as the restricted role, as a deployment runs:
as the owner nothing would separate the tenants but the operations' own filters.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, ClassVar

import hypothesis.strategies as st
from hypothesis.stateful import RuleBasedStateMachine, rule
from sqlalchemy import text

from switch_core.bridges.agent.operations import all_operations
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations.agent_management import (
    disable_agent_management,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.resource.service import ResourceService
from switch_core.config import KNOWN_FEATURE_FLAGS
from switch_core.db.base import Base
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    Organization,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.cloud_controllers import set_cloud_enrollment
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.room_service import RoomService
from switch_core.tenant_context import tenant_scope
from switch_core.transport.invites import InviteBus
from switch_core.trust.client import NullTrustClient
from tests.conftest import restricted_role
from tests.db_buffer import say
from tests.routing import make_room, router_on
from tests.switch_core.management.harness import Harness, build_harness

OTHER_TENANT = "agent-surface-other"
TENANTS = (TENANT_ZERO_ID, OTHER_TENANT)
CALL_SECONDS = 20.0
READS = ("get_", "list_", "read_", "load_")

COVERAGE: Counter[str] = Counter()
# What the calls reached that this machine does not run, and what failed, by
# operation: printed with the run, so a thin reach is seen.
REACHED: Counter[str] = Counter()
RAISED: Counter[str] = Counter()
SHOULD_REACH = (
    "a call answered 2xx",
    "a call refused",
    "a foreign id asked for",
    "a call that wrote",
)


@dataclass
class Reached(Exception):
    """A call passed what it checks and asked a collaborator this machine does
    not run, such as a bridge or a running agent."""


class ReachingCore(AgentCore):
    """The protocol service with the stores and services the operations read
    through it, and nothing it would hand on to a running client or bridge:
    asking it for that is `Reached`."""

    def __getattr__(self, attr: str) -> Any:
        if attr.startswith("__"):
            raise AttributeError(attr)
        raise Reached(f"protocol.{attr}")


def _wire(protocol: AgentCore, factory: Any) -> None:
    """Real stores and the real room and resource services on a protocol the
    management harness built, as one switch-core process builds them."""
    protocol.__class__ = ReachingCore
    protocol.config.template_max_bytes = 1024 * 1024
    protocol.config.deployment_kind = "self_hosted"
    protocol.config.feature_flags = dict.fromkeys(KNOWN_FEATURE_FLAGS, False)
    protocol.collab_lifecycle.get_registered_types = lambda *_: []  # type: ignore[attr-defined]
    protocol.client_lifecycle.get_by_type = lambda *_: []  # type: ignore[attr-defined]
    room_store = RoomStore()
    protocol.external_user_store = ExternalUserStore()
    protocol.bridge_store = CollaborationBridgeStore()
    protocol.room_group_store = RoomGroupStore()
    protocol.message_store = MessageStore()
    protocol.trust_client = NullTrustClient()
    protocol.resource_service = ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=factory,
    )
    provisioning = PostgresProvisioning(
        session_factory=factory,
        room_store=room_store,
        client_store=ClientStore(),
        router=router_on(factory),
        invites=InviteBus(),
    )
    protocol.room_service = RoomService(
        provisioning=provisioning,
        room_store=room_store,
        agent_store=AgentStore(),
        client_lifecycle=protocol.client_lifecycle,
        collab_lifecycle=None,  # type: ignore[arg-type]
        collab_bridge_store=CollaborationBridgeStore(),
        resource_service=protocol.resource_service,
        session_factory=factory,
        room_cache=None,  # type: ignore[arg-type]
    )


@dataclass
class Agent_:
    id: str
    key: str
    name: str
    client_id: str


@dataclass
class World:
    """What a tenant has: whose tokens are its own."""

    tenant: str
    agents: list[Agent_] = field(default_factory=list)
    rooms: list[str] = field(default_factory=list)
    room_names: list[str] = field(default_factory=list)
    user_id: str = ""
    tokens: dict[str, None] = field(default_factory=dict)

    def add(self, *tokens: str) -> None:
        self.tokens.update(dict.fromkeys(tokens))


def _token(kind: str) -> str:
    return f"{kind}-{uuid.uuid4().hex[:10]}"


async def _seed(factory: Any, tenant: str, label: str) -> World:
    """A tenant: an owner, two agents in two rooms, and a message in each room.
    Everything that can be read back carries a token of its own."""
    world = World(tenant=tenant)
    with tenant_scope(tenant):
        async with factory() as session:
            if tenant != TENANT_ZERO_ID:
                session.add(Organization(id=tenant, slug=tenant, name=tenant))
                await session.flush()
                session.add(
                    Tenant(id=tenant, slug=tenant, name=tenant, organization_id=tenant)
                )
                await session.flush()
            user = User(
                name=_token(f"{label}-owner"),
                email=f"{label}-{uuid.uuid4().hex[:6]}@example.invalid",
                role="user",
            )
            session.add(user)
            await session.flush()
            session.add(TenantMember(tenant_id=tenant, user_id=user.id, role="admin"))
            world.user_id = user.id
            world.add(user.id, user.name)
            for number in (1, 2):
                name = _token(f"{label}-agent{number}")
                key = secrets.token_urlsafe(32)
                client = Client(
                    type="agent",
                    transport_user_id=f"@{name}:test",
                    display_name=name,
                )
                api_key = ApiKey(
                    type="agent",
                    key_hash=hashlib.sha256(key.encode()).hexdigest(),
                    encrypted_key="",
                    label=name,
                    user_id=user.id,
                )
                session.add_all([client, api_key])
                await session.flush()
                agent = Agent(
                    name=name,
                    description=_token(f"{label}-desc"),
                    agent_type="auto_session",
                    connector_type="claude_code",
                    integration_profile={"connection_model": "auto_session"},
                    client_id=client.id,
                    api_key_id=api_key.id,
                    owner_id=user.id,
                )
                session.add(agent)
                await session.flush()
                world.agents.append(Agent_(agent.id, key, name, client.id))
                world.add(agent.id, name, client.id, agent.description)
            await session.commit()
    for number in (1, 2):
        room = await make_room(
            factory, _token(f"{label}-room{number}"), tenant_id=tenant
        )
        world.rooms.append(room.id)
        world.room_names.append(room.name)
        world.add(room.id, room.name)
        async with tenant_session(factory, tenant) as session:
            for agent in world.agents:
                await RoomStore().add_client(session, agent.client_id, room.id)
            await session.commit()
        body = _token(f"{label}-said")
        message = await say(
            factory,
            room.id,
            body,
            sender=f"@{world.agents[0].name}:test",
            sender_name=world.agents[0].name,
            tenant_id=tenant,
        )
        world.add(body, message.id)
    return world


def _tenant_tables() -> list[str]:
    return [
        table.name for table in Base.metadata.sorted_tables if "tenant_id" in table.c
    ]


class AgentSurface(RuleBasedStateMachine):
    """Two tenants, their agents, and every operation an agent has."""

    url: ClassVar[str]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._role: Any = None
        self._client: Any = None
        self._previous = op_context._protocol
        try:
            self._set_up()
        except BaseException:
            self._release()
            raise

    def _set_up(self) -> None:
        self._role = restricted_role(self.url)
        self.rls = self.run(self._role.__aenter__())
        self.worlds = {
            tenant: self.run(_seed(self.rls.owner, tenant, label))
            for tenant, label in zip(TENANTS, ("alpha", "bravo"), strict=True)
        }
        self.harness: Harness = build_harness(self.rls.restricted)
        _wire(self.harness.protocol, self.rls.restricted)
        op_context.init_operations_protocol(self.harness.protocol)
        self._client = self.harness.client()
        self.run(self._client.__aenter__())
        self.operations = sorted(all_operations())
        self.tables = _tenant_tables()
        self.given: dict[str, set[str]] = {tenant: set() for tenant in TENANTS}
        self.fingerprints = {
            tenant: self.run(self._fingerprint(tenant)) for tenant in TENANTS
        }

    def run(self, coroutine: Any) -> Any:
        return self.loop.run_until_complete(coroutine)

    def teardown(self) -> None:
        self._release()

    def _release(self) -> None:
        try:
            try:
                if self._client is not None:
                    self.run(self._client.__aexit__(None, None, None))
            finally:
                if self._role is not None:
                    self.run(self._role.__aexit__(None, None, None))
        finally:
            op_context._protocol = self._previous
            disable_agent_management()
            set_cloud_enrollment(None)
            self.loop.close()

    async def _fingerprint(self, tenant: str) -> dict[str, tuple[int, str]]:
        """A count and a hash of every row the tenant has, per table, read as
        the owner in one statement."""
        selects = [
            f"SELECT '{name}' AS name, count(*) AS n, "
            f"md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS h "
            f'FROM "{name}" t WHERE tenant_id = :tenant'
            for name in self.tables
        ]
        async with self.rls.owner() as session:
            rows = await session.execute(
                text(" UNION ALL ".join(selects)), {"tenant": tenant}
            )
            return {row.name: (row.n, row.h) for row in rows}

    def _argument(
        self,
        data: st.DataObject,
        schema: dict[str, Any],
        me: World,
        root: dict[str, Any],
    ) -> Any:
        theirs = self.worlds[next(t for t in TENANTS if t != me.tenant)]
        pool = [*me.tokens, *theirs.tokens, "", "x", "0", "*"]
        if "$ref" in schema:
            target: Any = root
            for part in schema["$ref"].removeprefix("#/").split("/"):
                target = target[part]
            return self._argument(data, target, me, root)
        kind = schema.get("type")
        if "anyOf" in schema:
            options = schema["anyOf"]
            return self._argument(data, data.draw(st.sampled_from(options)), me, root)
        if kind == "string":
            return data.draw(st.sampled_from(pool))
        if kind == "boolean":
            return data.draw(st.booleans())
        if kind == "integer" or kind == "number":
            return data.draw(st.integers(min_value=0, max_value=5))
        if kind == "array":
            item = schema.get("items", {"type": "string"})
            count = data.draw(st.integers(min_value=0, max_value=2))
            return [self._argument(data, item, me, root) for _ in range(count)]
        if kind == "object":
            members = schema.get("properties", {})
            required = set(schema.get("required", []))
            made = {
                key: self._argument(data, spec, me, root)
                for key, spec in members.items()
                if key in required or data.draw(st.booleans())
            }
            if schema.get("additionalProperties") is True or (
                not members and "additionalProperties" not in schema
            ):
                for _ in range(data.draw(st.integers(min_value=0, max_value=2))):
                    made[data.draw(st.sampled_from(pool))] = data.draw(
                        st.sampled_from(pool)
                    )
            return made
        if kind == "null":
            return None
        return data.draw(st.sampled_from(pool))

    @rule(data=st.data())
    def call(self, data: st.DataObject) -> None:
        """An agent of one tenant calls an operation with ids of both."""
        attacker_tenant = data.draw(st.sampled_from(TENANTS))
        victim_tenant = next(t for t in TENANTS if t != attacker_tenant)
        me, them = self.worlds[attacker_tenant], self.worlds[victim_tenant]
        agent = data.draw(st.sampled_from(me.agents))
        name = data.draw(st.sampled_from(self.operations))
        schema = all_operations()[name].input_schema
        properties = schema.get("properties", {})
        required = set(schema.get("required", []))
        arguments = {
            key: self._argument(data, spec, me, schema)
            for key, spec in properties.items()
            if key in required or data.draw(st.booleans())
        }
        before = self.fingerprints[victim_tenant]

        async def go() -> tuple[int, str]:
            try:
                response = await asyncio.wait_for(
                    self._client.post(
                        f"/agents/{agent.id}/ops/{name}",
                        json=arguments,
                        headers={"Authorization": f"Bearer {agent.key}"},
                    ),
                    timeout=CALL_SECONDS,
                )
            except Reached as reached:
                COVERAGE["a call that reached a stand-in"] += 1
                REACHED[f"{name}: {reached}"] += 1
                return 418, str(reached)
            except Exception as failure:
                COVERAGE["a call that raised"] += 1
                RAISED[f"{name}: {type(failure).__name__}: {str(failure)[:80]}"] += 1
                raise AssertionError(
                    f"{agent.name} of {attacker_tenant} called {name}({arguments}) "
                    f"and the server raised {type(failure).__name__}: {failure}"
                ) from failure
            return response.status_code, response.text

        status, said = self.run(go())
        asked = json.dumps(arguments, default=str)
        reading = name.startswith(READS)
        foreign = [
            t
            for t in them.tokens
            if t not in me.tokens and (reading or t not in self.given[attacker_tenant])
        ]
        named = [token for token in foreign if token in asked]
        if 200 <= status < 300 and not reading:
            self.given[attacker_tenant].update(t for t in them.tokens if t in asked)
        if named:
            COVERAGE["a foreign id asked for"] += 1
        COVERAGE[
            "a call answered 2xx" if 200 <= status < 300 else "a call refused"
        ] += 1
        if 200 <= status < 300:
            # What the request itself carried is echoed back by a write; a
            # read of an object by an id of the other tenant is never answered
            # with it.
            leaked = [
                token
                for token in foreign
                if token in said and (reading or token not in asked)
            ]
            assert not leaked, (
                f"{agent.name} of {attacker_tenant} called {name}({asked}) and "
                f"was answered {status} naming {leaked[:5]} of {victim_tenant}: "
                f"{said[:400]}"
            )
        after = self.run(self._fingerprint(victim_tenant))
        changed = sorted(table for table in after if after[table] != before[table])
        assert not changed, (
            f"{agent.name} of {attacker_tenant} called {name}({asked}), answered "
            f"{status}, and {victim_tenant}'s rows changed in {changed}"
        )
        mine = self.run(self._fingerprint(attacker_tenant))
        if mine != self.fingerprints[attacker_tenant]:
            COVERAGE["a call that wrote"] += 1
        self.fingerprints[attacker_tenant] = mine
        self.fingerprints[victim_tenant] = after


def machine_on(url: str) -> type[AgentSurface]:
    """The machine against the database at `url`."""
    return type("AgentSurfaceOnPostgres", (AgentSurface,), {"url": url})
