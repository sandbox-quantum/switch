"""What the matrix asks about: one of each thing, owned by `Persona.OWNER`.

Each is made the first time a case asks for it, so a case pays only for what
its route reads. Everything is private where it has a visibility, so reading,
changing and deleting it is its owner's and an admin's, and nobody else's.

Each persona asks about a world of its own, `tag` keeping its names apart, so
what one is let do never changes what the next is asked about.
"""

from __future__ import annotations

import base64
import re
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import httpx
from fastapi import FastAPI
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.flows import KIND as SERVICE_FLOW
from switch_core.db.models import (
    Agent,
    AgentDefinition,
    ApiKey,
    Client,
    CollaborationBridge,
    Document,
    ExternalUser,
    ExternalUserClaim,
    OrganizationMember,
    Package,
    Reference,
    ReferenceType,
    Room,
    RoomGroup,
    RoomLink,
    RoomRole,
    RoomSchedule,
    Template,
    TenantMember,
    UsageMetric,
    User,
    package_documents,
    package_references,
    room_agents,
    room_documents,
    room_packages,
    room_references,
)
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.join_domain_store import JoinDomainStore
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.tenant_context import tenant_scope
from tests.switch_core.connections.github_seed import connect_github, grant_repository
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.gateway.role_matrix.harness import (
    ORGANIZATION,
    TENANT,
    People,
    Persona,
    config,
    domain_of,
)
from tests.switch_core.gateway.role_matrix.routes import Ask
from tests.switch_core.management.harness import definition, platform

_PRIVATE = {"read_visibility": "private", "write_visibility": "private"}

_PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")


class World:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        people: People,
        tag: str,
        http: httpx.AsyncClient,
        gateway: FastAPI,
    ) -> None:
        self.session_factory = session_factory
        self.people = people
        self.tag = tag
        # For what is made the way a person makes it, through the app.
        self.http = http
        self._clients = gateway.state.matrix_lifecycle
        self._sign_in_flows = gateway.state.sign_in_flows
        self._made: dict[str, Any] = {}

    async def fill(self, ask: Ask) -> Ask:
        """`ask` with each `{name}` it holds replaced by this world's thing of
        that name; a body value that is nothing but one takes the thing
        itself, so it can be an object."""
        return Ask(
            ask.method,
            await self._text(ask.path),
            await self._value(ask.json),
            {key: await self._text(value) for key, value in ask.params.items()},
        )

    async def _value(self, value: Any) -> Any:
        if isinstance(value, str):
            whole = _PLACEHOLDER.fullmatch(value)
            return (
                await self._lookup(whole.group(1)) if whole else await self._text(value)
            )
        if isinstance(value, dict):
            return {key: await self._value(item) for key, item in value.items()}
        if isinstance(value, list):
            return [await self._value(item) for item in value]
        return value

    async def _text(self, text: str) -> str:
        names = _PLACEHOLDER.findall(text)
        for name in names:
            text = text.replace(f"{{{name}}}", str(await self._lookup(name)))
        return text

    async def _lookup(self, name: str) -> Any:
        found = getattr(self, name)
        return await found() if callable(found) else found

    async def _as_owner(self, method: str, path: str, json: Any = None) -> Any:
        return await self._as(Persona.OWNER, method, path, json)

    async def _as(self, persona: Persona, method: str, path: str, json: Any) -> Any:
        response = await self.http.request(
            method, path, json=json, headers=self.people.headers(persona)
        )
        assert response.status_code < 300, f"{method} {path}: {response.text}"
        return response.json()

    async def tenant(self) -> str:
        return TENANT

    async def self_id(self) -> str:
        """The asking persona's own id."""
        return self.id_of(Persona(self.tag))

    async def owner(self) -> str:
        return self.owner_id

    async def member(self) -> str:
        return self.id_of(Persona.MEMBER)

    async def definition(self) -> dict[str, Any]:
        return definition()

    async def slug(self) -> str:
        """A name of this world's that may be a reference type's slug."""
        return "matrix_" + self.tag.replace("-", "_")

    async def email_domain(self) -> str:
        """The domain of the asking persona's own e-mail (`harness.email_of`)."""
        return domain_of(Persona(self.tag))

    async def flow_state(self) -> str:
        return base64.urlsafe_b64encode(uuid.uuid4().bytes * 2).decode()[:43]

    async def flow_secret(self) -> str:
        return base64.urlsafe_b64encode(uuid.uuid4().bytes * 2).decode()[:43]

    async def room_yaml(self) -> str:
        """A room template with nothing in it but its name."""
        return f"room:\n  name: {self.name('yaml-room')}\n  description: matrix\n"

    async def sealed_login(self) -> dict[str, str]:
        """A provider login as a client seals it; only its shape matters here."""
        return {
            "alg": "X25519-HKDF-SHA256-A256GCM",
            "key_id": "matrix-key",
            "ephemeral_key": base64.urlsafe_b64encode(bytes(32)).decode(),
            "nonce": base64.urlsafe_b64encode(bytes(12)).decode(),
            "ciphertext": base64.urlsafe_b64encode(bytes(32)).decode(),
        }

    def name(self, kind: str) -> str:
        return f"matrix-{kind}-{self.tag}"

    def id_of(self, persona: Persona) -> str:
        return self.people.ids[persona]

    @property
    def owner_id(self) -> str:
        return self.people.ids[Persona.OWNER]

    async def _once(self, kind: str, make: Any) -> Any:
        if kind not in self._made:
            with tenant_scope(TENANT):
                async with self.session_factory() as session:
                    self._made[kind] = await make(session)
                    await session.commit()
        return self._made[kind]

    # ── Agents ───────────────────────────────────────────────────────────

    async def agent(self) -> str:
        return str(await self._once("agent", self._agent("agent")))

    def _agent(self, kind: str) -> Any:
        """An agent of the owner's, with a running client as far as the room
        and chat services can tell."""

        async def make(session: AsyncSession) -> str:
            agent = await add_agent(
                session, name=self.name(kind), owner_id=self.owner_id
            )
            client = await session.get(Client, agent.client_id)
            assert client is not None
            self._clients.agents[agent.id] = SimpleNamespace(
                client_id=client.id, transport_user_id=client.transport_user_id
            )
            return agent.id

        return make

    async def console_agent(self) -> str:
        """An agent of the owner's that Switch Console runs, registered from
        the Claude Code spec, so it has options and may be granted services on
        the owner's GitHub connection."""
        agent_id = str(await self._once("console_agent", self._agent("console-agent")))
        await self.connection()

        async def make(session: AsyncSession) -> str:
            agent = await session.get(Agent, agent_id)
            assert agent is not None
            agent.metadata_ = {
                "known_agent_type": "claude-code",
                "known_agent_options": {},
            }
            await session.flush()
            return agent_id

        return str(await self._once("console_agent_registered", make))

    async def agent_name(self) -> str:
        await self.agent()
        return self.name("agent")

    async def sub_agent(self) -> str:
        """A sub-agent of the owner's agent."""
        parent_id = await self.agent()
        sub_id = str(await self._once("sub_agent", self._agent("sub-agent")))

        async def make(session: AsyncSession) -> str:
            sub = await session.get(Agent, sub_id)
            assert sub is not None
            sub.parent_agent_id = parent_id
            await session.flush()
            return sub_id

        return str(await self._once("sub_agent_parented", make))

    async def other_agent(self) -> str:
        return str(await self._once("other_agent", self._agent("other-agent")))

    async def granted_agent(self) -> str:
        """The agent, with service access on its owner's GitHub connection."""
        agent_id = await self.agent()
        await self.connection()

        async def make(session: AsyncSession) -> str:
            await grant_repository(session, agent_id, self.owner_id)
            return agent_id

        return str(await self._once("granted_agent", make))

    async def agent_key(self) -> str:
        """The owner's agent's own API key."""
        agent_id = await self.agent()

        async def make(session: AsyncSession) -> str:
            agent = await session.get(Agent, agent_id)
            assert agent is not None
            return agent.api_key_id

        return str(await self._once("agent_key", make))

    async def registration_key(self) -> str:
        async def make(session: AsyncSession) -> str:
            key = ApiKey(
                user_id=self.owner_id,
                key_hash=f"matrix-{uuid.uuid4().hex}",
                encrypted_key=config().keyring.encrypt("matrix-secret"),
                label="matrix",
                type="registration",
            )
            session.add(key)
            await session.flush()
            return key.id

        return str(await self._once("registration_key", make))

    # ── People to act on ─────────────────────────────────────────────────

    async def _person(self, kind: str, *, workspace: bool, organization: bool) -> str:
        async def make(session: AsyncSession) -> str:
            user = User(
                name=self.name(kind),
                email=f"{self.name(kind)}@example.invalid",
                role="user",
            )
            session.add(user)
            await session.flush()
            if workspace:
                session.add(
                    TenantMember(tenant_id=TENANT, user_id=user.id, role="member")
                )
            if organization:
                session.add(
                    OrganizationMember(
                        organization_id=ORGANIZATION, user_id=user.id, role="member"
                    )
                )
            await session.flush()
            return user.id

        return str(await self._once(kind, make))

    async def member_target(self) -> str:
        """A member of the workspace, to change or remove."""
        return await self._person("member-target", workspace=True, organization=True)

    async def org_target(self) -> str:
        """A member of the organization in none of its workspaces, to change or
        remove from it."""
        return await self._person("org-target", workspace=False, organization=True)

    async def user_target(self) -> str:
        """An account in no workspace, for the operator to delete."""
        return await self._person("user-target", workspace=False, organization=False)

    # ── Rooms and resources ──────────────────────────────────────────────

    async def room(self) -> str:
        return str(await self._once("room", self._room(self.name("room"))))

    async def readable_room(self) -> str:
        """A room of the owner's that everyone may read and only its owner
        and admins may change."""

        async def make(session: AsyncSession) -> str:
            room = Room(
                transport_room_id=f"!{self.name('readable-room')}:test",
                name=self.name("readable-room"),
                description="",
                owner_id=self.owner_id,
                read_visibility="public",
                write_visibility="private",
            )
            session.add(room)
            await session.flush()
            return room.id

        return str(await self._once("readable_room", make))

    async def direct_room(self) -> str:
        """A DM the bridge adopted: anyone may read it, and its owner and
        admins write to it, but nobody changes who is in it from outside."""

        async def make(session: AsyncSession) -> str:
            room = Room(
                transport_room_id=f"!{self.name('direct-room')}:test",
                name=self.name("direct-room"),
                description="",
                owner_id=self.owner_id,
                read_visibility="public",
                write_visibility="private",
                channel_type="direct",
            )
            session.add(room)
            await session.flush()
            return room.id

        return str(await self._once("direct_room", make))

    async def room_document_itself(self) -> str:
        """A document of the room's own, as an agent writes one there."""
        room_id = await self.room()

        async def make(session: AsyncSession) -> str:
            document = Document(
                owner_id=self.owner_id,
                room_id=room_id,
                name=self.name("room-own-document"),
                description="",
                instructions="",
                content="",
                **_PRIVATE,
            )
            session.add(document)
            await session.flush()
            return document.id

        return str(await self._once("room_document_itself", make))

    async def other_room(self) -> str:
        return str(await self._once("other_room", self._room(self.name("other-room"))))

    def _room(self, name: str) -> Any:
        async def make(session: AsyncSession) -> str:
            room = Room(
                transport_room_id=f"!{name}-{uuid.uuid4().hex[:6]}:test",
                name=name,
                description=name,
                owner_id=self.owner_id,
                **_PRIVATE,
            )
            session.add(room)
            await session.flush()
            return room.id

        return make

    async def room_role(self) -> str:
        """The room, holding a role named `reviewer`."""
        room_id = await self.room()

        async def make(session: AsyncSession) -> str:
            session.add(
                RoomRole(room_id=room_id, name="reviewer", instructions="Review.")
            )
            await session.flush()
            return room_id

        return str(await self._once("room_role", make))

    async def room_schedule(self) -> str:
        """A daily schedule in the room, addressed to the agent in it."""
        room_id = await self.room_agent()
        agent_id = await self.agent()

        async def make(session: AsyncSession) -> str:
            schedule = RoomSchedule(
                room_id=room_id,
                author_id=self.owner_id,
                agent_ids=[agent_id],
                text="Summarise the new issues.",
                cron="0 9 * * *",
                run_at=None,
                timezone="UTC",
                paused=False,
                next_run_at=datetime.now(UTC) + timedelta(days=1),
            )
            session.add(schedule)
            await session.flush()
            return schedule.id

        return str(await self._once("room_schedule", make))

    async def room_agent(self) -> str:
        """The room, with the agent in it."""
        return await self._linked(
            "room_agent", self.room, self.agent, room_agents, "agent_id"
        )

    async def room_reference(self) -> str:
        return await self._linked(
            "room_reference", self.room, self.reference, room_references, "reference_id"
        )

    async def room_document(self) -> str:
        return await self._linked(
            "room_document", self.room, self.document, room_documents, "document_id"
        )

    async def room_package(self) -> str:
        return await self._linked(
            "room_package", self.room, self.package, room_packages, "package_id"
        )

    async def package_reference(self) -> str:
        return await self._linked(
            "package_reference",
            self.package,
            self.reference,
            package_references,
            "reference_id",
            holder="package_id",
        )

    async def package_document(self) -> str:
        return await self._linked(
            "package_document",
            self.package,
            self.document,
            package_documents,
            "document_id",
            holder="package_id",
        )

    async def packaged_reference(self) -> str:
        """The private reference, in a package everyone may read."""
        return await self._held_in(
            "packaged_reference",
            self.readable_package,
            self.reference,
            package_references,
            "reference_id",
            holder="package_id",
        )

    async def packaged_document(self) -> str:
        """The private document, in a package everyone may read."""
        return await self._held_in(
            "packaged_document",
            self.readable_package,
            self.document,
            package_documents,
            "document_id",
            holder="package_id",
        )

    async def shown_reference(self) -> str:
        """The private reference, in a room everyone may read."""
        return await self._held_in(
            "shown_reference",
            self.readable_room,
            self.reference,
            room_references,
            "reference_id",
        )

    async def shown_document(self) -> str:
        """The private document, in a room everyone may read."""
        return await self._held_in(
            "shown_document",
            self.readable_room,
            self.document,
            room_documents,
            "document_id",
        )

    async def _held_in(
        self,
        kind: str,
        holder_of: Any,
        held_of: Any,
        table: Any,
        held: str,
        *,
        holder: str = "room_id",
    ) -> str:
        """As `_linked`, but the held thing's id: what a list names it by."""
        await self._linked(kind, holder_of, held_of, table, held, holder=holder)
        return str(await held_of())

    async def _linked(
        self,
        kind: str,
        holder_of: Any,
        held_of: Any,
        table: Any,
        held: str,
        *,
        holder: str = "room_id",
    ) -> str:
        """The holder (a room, or a package), with the held thing in it."""
        holder_id = await holder_of()
        held_id = await held_of()

        async def make(session: AsyncSession) -> str:
            await session.execute(
                insert(table).values({holder: holder_id, held: held_id})
            )
            return holder_id

        return str(await self._once(kind, make))

    async def linked_room(self) -> str:
        """The room, linked to the other room."""
        room_id = await self.room()
        other_id = await self.other_room()

        async def make(session: AsyncSession) -> str:
            session.add(
                RoomLink(
                    source_room_id=room_id, target_room_id=other_id, label="related"
                )
            )
            await session.flush()
            return room_id

        return str(await self._once("linked_room", make))

    async def room_group(self) -> str:
        async def make(session: AsyncSession) -> str:
            group = RoomGroup(name=self.name("group"))
            session.add(group)
            await session.flush()
            return group.id

        return str(await self._once("room_group", make))

    async def reference(self) -> str:
        async def make(session: AsyncSession) -> str:
            reference = Reference(
                owner_id=self.owner_id,
                type="github",
                name=self.name("reference"),
                description="",
                instructions="",
                value={"urls": ["https://github.com/example/project"]},
                **_PRIVATE,
            )
            session.add(reference)
            await session.flush()
            return reference.id

        return str(await self._once("reference", make))

    async def reference_type(self) -> str:
        async def make(session: AsyncSession) -> str:
            session.add(
                ReferenceType(
                    type=self.name("type"),
                    owner_id=self.owner_id,
                    display_name="Matrix",
                    instructions="",
                    value_hint="",
                    **_PRIVATE,
                )
            )
            await session.flush()
            return self.name("type")

        return str(await self._once("reference_type", make))

    async def document(self) -> str:
        async def make(session: AsyncSession) -> str:
            document = Document(
                owner_id=self.owner_id,
                name=self.name("document"),
                description="",
                instructions="",
                content="",
                **_PRIVATE,
            )
            session.add(document)
            await session.flush()
            return document.id

        return str(await self._once("document", make))

    async def package(self) -> str:
        async def make(session: AsyncSession) -> str:
            package = Package(
                owner_id=self.owner_id,
                name=self.name("package"),
                description="",
                instructions="",
                **_PRIVATE,
            )
            session.add(package)
            await session.flush()
            return package.id

        return str(await self._once("package", make))

    async def readable_package(self) -> str:
        """A package of the owner's that everyone may read and only its owner
        and admins may change."""

        async def make(session: AsyncSession) -> str:
            package = Package(
                owner_id=self.owner_id,
                name=self.name("readable-package"),
                description="",
                instructions="",
                read_visibility="public",
                write_visibility="private",
            )
            session.add(package)
            await session.flush()
            return package.id

        return str(await self._once("readable_package", make))

    async def template(self) -> str:
        async def make(session: AsyncSession) -> str:
            template = Template(
                owner_id=self.owner_id,
                name=self.name("template"),
                description="",
                kind="room",
                content="name: matrix\n",
                **_PRIVATE,
            )
            session.add(template)
            await session.flush()
            return template.id

        return str(await self._once("template", make))

    # ── Workspace ────────────────────────────────────────────────────────

    async def invitation(self) -> str:
        async def make(session: AsyncSession) -> str:
            invitation, _token = await InvitationStore().create(
                session,
                role="member",
                email=None,
                expires_at=datetime.now(UTC) + timedelta(days=7),
                uses_remaining=1,
                created_by=self.id_of(Persona.WORKSPACE_ADMIN),
            )
            return invitation.id

        return str(await self._once("invitation", make))

    async def budget(self) -> str:
        async def make(session: AsyncSession) -> str:
            budget = await BudgetStore().create(
                session,
                tenant_id=TENANT,
                agent_id=None,
                metric=UsageMetric.INPUT_TOKENS,
                model=self.tag,
                amount_limit=100,
                period_hours=24,
            )
            return budget.id

        return str(await self._once("budget", make))

    async def join_domain(self) -> str:
        async def make(session: AsyncSession) -> str:
            domain = f"{self.tag}.matrix.example"
            await JoinDomainStore().add(
                session, domain=domain, created_by=self.id_of(Persona.WORKSPACE_ADMIN)
            )
            return domain

        return str(await self._once("join_domain", make))

    async def workspace_service(self) -> str:
        """GitHub, switched on for the workspace by its admin."""

        async def make(session: AsyncSession) -> str:
            await WorkspaceServiceStore().set_enabled(
                session, "github", True, self.id_of(Persona.WORKSPACE_ADMIN)
            )
            return "github"

        return str(await self._once("workspace_service", make))

    # ── Messaging apps ───────────────────────────────────────────────────

    async def bridge(self) -> str:
        async def make(session: AsyncSession) -> str:
            client = Client(
                transport_user_id=f"@matrix-bridge-{uuid.uuid4().hex[:8]}:test",
                display_name="bridge",
                type="bridge",
            )
            session.add(client)
            await session.flush()
            bridge = CollaborationBridge(
                type="mattermost",
                display_name=self.name("bridge"),
                client_id=client.id,
                status="active",
                is_default=False,
            )
            session.add(bridge)
            await session.flush()
            return bridge.id

        return str(await self._once("bridge", make))

    async def identity(self) -> str:
        """A platform account on the bridge, claimed by the owner."""
        bridge_id = await self.bridge()

        async def make(session: AsyncSession) -> str:
            client = Client(
                transport_user_id=f"@matrix-human-{uuid.uuid4().hex[:8]}:test",
                display_name="human",
                type="human",
            )
            session.add(client)
            await session.flush()
            account = ExternalUser(
                bridge_id=bridge_id,
                external_user_id=f"U-{self.tag}",
                external_username=self.name("account"),
                client_id=client.id,
            )
            session.add(account)
            await session.flush()
            session.add(
                ExternalUserClaim(
                    external_user_id=account.id,
                    user_id=self.owner_id,
                    verified_at=datetime.now(UTC),
                )
            )
            await session.flush()
            return account.id

        return str(await self._once("identity", make))

    # ── Devices and connections ──────────────────────────────────────────

    async def controller(self) -> str:
        """A machine the owner enrolled from Switch Console."""
        if "controller" not in self._made:
            enrolled = await self._as_owner(
                "POST",
                "/gateway/management/controllers",
                {
                    "name": self.name("machine"),
                    "kind": "console",
                    "platform": platform(),
                    "version": "0.1.0",
                },
            )
            self._made["controller"] = enrolled["controller_id"]
        return str(self._made["controller"])

    async def managed_agent(self) -> str:
        agent_id = await self.agent()
        controller_id = await self.controller()

        async def make(session: AsyncSession) -> str:
            session.add(
                AgentDefinition(
                    agent_id=agent_id,
                    owner_id=self.owner_id,
                    controller_id=controller_id,
                    revision=1,
                    desired_state="running",
                    definition=definition(),
                )
            )
            await session.flush()
            return agent_id

        return str(await self._once("managed_agent", make))

    async def connection(self) -> str:
        """The owner's GitHub connection, the one every world shares: a person
        holds one connection to each service."""

        async def make(session: AsyncSession) -> str:
            existing = await ServiceConnectionStore().get_connection(
                session, self.owner_id, "github"
            )
            if existing is None:
                await connect_github(session, self.owner_id, config().keyring)
            return "github"

        return str(await self._once("connection", make))

    async def service_flow(self) -> str:
        """A sign-in to Atlassian the owner started from Switch Console. Made
        in the flow store: this server has no Atlassian app to start one."""
        if "service_flow" not in self._made:
            state = await self.flow_state()
            await self._sign_in_flows.start(
                kind=SERVICE_FLOW,
                service="atlassian",
                tenant_id=TENANT,
                user_id=self.owner_id,
                state=state,
                mode="loopback",
                port=39231,
                redirect_uri="http://127.0.0.1:39231/callback",
                owner_label="owner",
                details={"name": "Atlassian"},
                completion_secret=await self.flow_secret(),
            )
            self._made["service_flow"] = state
        return str(self._made["service_flow"])

    async def github_flow(self) -> str:
        """A GitHub connection the owner started."""
        if "github_flow" not in self._made:
            started = await self._as_owner(
                "POST", "/gateway/provider-connections/github/flows", await self._flow()
            )
            self._made["github_flow"] = started["id"]
        return str(self._made["github_flow"])

    async def _flow(self) -> dict[str, Any]:
        """What Switch Console sends to start a sign-in it waits for."""
        return {
            "port": 39231,
            "state": await self.flow_state(),
            "completion_secret": await self.flow_secret(),
        }

    async def organization_service(self) -> str:
        """GitHub, with a setting of the organization's own."""
        if "organization_service" not in self._made:
            await self._as(
                Persona.ORG_ADMIN,
                "PUT",
                "/gateway/organizations/current/services/github",
                {"enabled": True, "locked": False},
            )
            self._made["organization_service"] = "github"
        return str(self._made["organization_service"])

    # ── Chats ────────────────────────────────────────────────────────────

    async def chat(self) -> str:
        """A chat the owner started with their agent."""
        if "chat" not in self._made:
            agent_id = await self.agent()
            started = await self._as_owner(
                "POST",
                "/gateway/chats",
                {"agentId": agent_id, "requestId": f"{self.tag}-chat"},
            )
            self._made["chat"] = started["chat"]["roomId"]
        return str(self._made["chat"])

    async def chat_guest(self) -> str:
        """Someone the owner brought into the chat."""
        if "chat_guest" not in self._made:
            chat_id = await self.chat()
            guest = await self._person("chat-guest", workspace=True, organization=True)
            await self._as_owner(
                "POST", f"/gateway/chats/{chat_id}/members", {"userId": guest}
            )
            self._made["chat_guest"] = guest
        return str(self._made["chat_guest"])

    async def oauth_install(self) -> str:
        """The workspace's Slack install (`harness.Installs`)."""
        return "s1"
