"""A Hypothesis state machine over the credential broker and Postgres.

The broker issues a service token only to an agent whose owner connected that
account and granted it to the agent, and a token whose grant is withdrawn is
revoked. The machine is the owners, their agents and controllers: it connects
and re-links accounts, sets, narrows and removes grants, lets sign-ins lapse,
revokes controllers and moves agents between them, removes owners from the
workspace and brings them back, and asks for tokens as an agent's key or as a
controller, its own or someone else's. A reference model says which of those
asks may be answered, and which tokens already issued have lost what they were
issued on. Only the vendor is faked.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import Counter
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, ClassVar

import hypothesis.strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.connections.adapters import ConnectionSecret
from switch_core.connections.broker import Principal, ServiceBroker, ServiceError
from switch_core.connections.loader import CATALOG
from switch_core.connections.maintenance import maintain_once
from switch_core.db.engine import create_session_factory
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentController,
    AgentDefinition,
    ServiceConnection,
    TenantMember,
    User,
)
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.tenant_context import tenant_scope
from tests.conftest import TEST_KEYRING, empty_the_database
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.gateway.agent_route_harness import add_agent

SERVICE = "github"
OWNERS = ("ada", "bob")
AGENTS = {"ada-1": "ada", "ada-2": "ada", "bob-1": "bob"}
CONTROLLERS = {"ada-laptop": "ada", "ada-server": "ada", "bob-laptop": "bob"}
# One Switch user per vendor account in a workspace, so each owner has their own.
ACCOUNTS = ("1", "2")
# Who asks for an agent's token, relative to the agent.
ASKERS = ("its key", "its host", "another of its owner's", "someone else's")
RESOURCES = {"installation_id": 7, "repository_ids": [70, 71]}

COVERAGE: Counter[str] = Counter()
SHOULD_REACH = (
    "issued as the agent's key",
    "issued as a controller",
    "refused",
    "revoked a held token",
    "re-linked a connection",
    "narrowed a grant",
)


@dataclass
class Linked:
    """An owner's connection, as the model holds it."""

    account: str
    consent: str
    active: bool
    # Bumped on every re-link: what was issued on an earlier sign-in is not
    # held on this one.
    epoch: int


@dataclass
class Granted:
    owner: str
    account: str
    access: str


@dataclass
class Held:
    """A token the broker issued, and what it was issued on."""

    token: str
    agent: str
    owner: str
    grant: int
    epoch: int
    controller: str | None


class BrokerMachine(RuleBasedStateMachine):
    url: ClassVar[str]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._scope = tenant_scope(TENANT_ZERO_ID)
        self._scope.__enter__()
        self.engine = create_async_engine(self.url)
        try:
            self._set_up()
        except BaseException:
            self._release()
            raise

    def _set_up(self) -> None:
        self.run(empty_the_database(self.engine))
        self.factory = create_session_factory(self.engine)
        self.vendor = FakeVendor()
        self.store = ServiceConnectionStore()
        self.broker = ServiceBroker(
            session_factory=self.factory,
            keyring=TEST_KEYRING,
            catalog=CATALOG,
            adapters={SERVICE: self.vendor},
            organization_apps=None,
            disabled={},
            store=self.store,
            token_retention=timedelta(days=30),
            workspace_services=WorkspaceServiceStore(),
            workspace_gate=False,
            public_url=None,
        )
        self.user_ids: dict[str, str] = {}
        self.agent_ids: dict[str, str] = {}
        self.run(self._seed())
        # The model.
        self.member = dict.fromkeys(OWNERS, True)
        self.linked: dict[str, Linked | None] = dict.fromkeys(OWNERS)
        self.granted: dict[str, Granted | None] = dict.fromkeys(AGENTS)
        # A grant's identity, as far as the model is concerned: a new one each
        # time a grant is made where there was none.
        self.grant_number: dict[str, int] = dict.fromkeys(AGENTS, 0)
        self.live = dict.fromkeys(CONTROLLERS, True)
        self.host = {agent: f"{owner}-laptop" for agent, owner in AGENTS.items()}
        self.held: list[Held] = []
        self.epochs = dict.fromkeys(OWNERS, 0)
        self.sign_ins = 0
        # Start where tokens can be issued: every owner connected for writing,
        # every agent granted. The steps take that apart and put it back.
        for owner in OWNERS:
            self.connect(owner, ACCOUNTS[0], "write")
        for agent, owner in sorted(AGENTS.items()):
            self.set_grant(agent, 1, "write")

    async def _seed(self) -> None:
        async with self.factory() as session:
            for name in OWNERS:
                user = User(name=name, email=f"{name}@example.invalid", role="user")
                session.add(user)
                await session.flush()
                session.add(
                    TenantMember(
                        tenant_id=TENANT_ZERO_ID, user_id=user.id, role="member"
                    )
                )
                self.user_ids[name] = user.id
            await session.flush()
            for name, owner in AGENTS.items():
                agent = await add_agent(
                    session, name=name, owner_id=self.user_ids[owner]
                )
                self.agent_ids[name] = agent.id
            for name, owner in CONTROLLERS.items():
                session.add(
                    AgentController(
                        id=name,
                        owner_id=self.user_ids[owner],
                        name=name,
                        kind="console",
                    )
                )
            await session.flush()
            for name, owner in AGENTS.items():
                session.add(
                    AgentDefinition(
                        agent_id=self.agent_ids[name],
                        owner_id=self.user_ids[owner],
                        controller_id=f"{owner}-laptop",
                        revision=1,
                        desired_state="running",
                        definition={},
                    )
                )
            await session.commit()

    def run(self, coroutine: Any) -> Any:
        return self.loop.run_until_complete(coroutine)

    def teardown(self) -> None:
        self._release()

    def _release(self) -> None:
        try:
            self.run(self.engine.dispose())
        finally:
            self.loop.close()
            self._scope.__exit__(None, None, None)

    # ── The model ────────────────────────────────────────────────────────────

    def _refusal(self, agent: str, controller: str | None) -> str | None:
        """Why the model refuses `agent` a token asked for as `controller` (the
        agent's own key when None), or None when it may have one."""
        owner = AGENTS[agent]
        if not self.member[owner]:
            return "its owner is not a member"
        grant = self.granted[agent]
        if grant is None:
            return "it has no grant"
        if grant.owner != owner:
            return "its grant was made by someone else"
        if controller is not None:
            if CONTROLLERS[controller] != owner:
                return "the controller is someone else's"
            if not self.live[controller]:
                return "the controller is revoked"
            if self.host[agent] != controller:
                return "the controller does not host it"
        linked = self.linked[owner]
        if linked is None:
            return "its owner has not connected"
        if not linked.active:
            return "its owner's sign-in lapsed"
        if grant.account != linked.account:
            return "the grant is on another account"
        if grant.access == "write" and linked.consent != "write":
            return "the grant writes and the connection only reads"
        return None

    def _withdrawn(self, held: Held) -> str | None:
        """Why a token already issued has lost what it was issued on."""
        if not self.member[held.owner]:
            return "its owner is not a member"
        if (
            self.granted[held.agent] is None
            or self.grant_number[held.agent] != held.grant
        ):
            return "its grant is gone"
        if self.epochs[held.owner] != held.epoch:
            return "its owner's connection was re-linked or removed"
        if held.controller is not None:
            if not self.live[held.controller]:
                return "its controller is revoked"
            if self.host[held.agent] != held.controller:
                return "its controller no longer hosts the agent"
        return None

    def _drop_grants_of(self, owner: str) -> None:
        for agent, grant in self.granted.items():
            if grant is not None and grant.owner == owner:
                self.granted[agent] = None

    # ── Steps: the owner's connection ────────────────────────────────────────

    @rule(
        owner=st.sampled_from(OWNERS),
        account=st.sampled_from(ACCOUNTS),
        consent=st.sampled_from(("read", "write")),
    )
    def connect(self, owner: str, account: str, consent: str) -> None:
        """The owner connects an account, or signs in again over the one they
        have: what was issued on the old sign-in is revoked, the grants stay."""
        self.sign_ins += 1
        secret = ConnectionSecret(
            {
                "access_token": f"gho_{owner}_{self.sign_ins}",
                "expires_at": time.time() + 8 * 3600,
                "refresh_token": f"ghr_{owner}_{self.sign_ins}",
                "refresh_expires_at": time.time() + 180 * 86400,
            }
        )

        async def go() -> None:
            async with self.factory() as session:
                await self.broker.connect(
                    session,
                    user_id=self.user_ids[owner],
                    service=SERVICE,
                    consent=consent,  # type: ignore[arg-type]
                    granted_scopes=[],
                    account_id=f"{owner}-{account}",
                    external_identity=f"{owner}-{account}",
                    secret=secret,
                    oauth_client_id=None,
                )

        self.run(go())
        if self.linked[owner] is not None:
            COVERAGE["re-linked a connection"] += 1
        self.epochs[owner] += 1
        self.linked[owner] = Linked(
            f"{owner}-{account}", consent, True, self.epochs[owner]
        )

    @rule(owner=st.sampled_from(OWNERS))
    def disconnect(self, owner: str) -> None:
        async def go() -> None:
            async with self.factory() as session:
                await self.broker.disconnect(session, self.user_ids[owner], SERVICE)

        if self.linked[owner] is None:
            try:
                self.run(go())
            except ServiceError as error:
                assert error.code == "connector_not_connected", error
                return
            raise AssertionError(f"{owner} disconnected a connection they lack")
        self.run(go())
        self.linked[owner] = None
        self.epochs[owner] += 1
        self._drop_grants_of(owner)

    @rule(owner=st.sampled_from(OWNERS))
    def lapse(self, owner: str) -> None:
        """The vendor refuses the sign-in, as a failed refresh finds it."""

        async def go() -> None:
            async with self.factory() as session:
                await session.execute(
                    update(ServiceConnection)
                    .where(ServiceConnection.user_id == self.user_ids[owner])
                    .values(status="needs_reauthorization")
                )
                await session.commit()

        self.run(go())
        linked = self.linked[owner]
        if linked is not None:
            linked.active = False

    # ── Steps: grants ────────────────────────────────────────────────────────

    @rule(
        agent=st.sampled_from(sorted(AGENTS)),
        by=st.integers(min_value=0, max_value=3),
        access=st.sampled_from(("read", "write")),
    )
    def set_grant(self, agent: str, by: int, access: str) -> None:
        """Someone grants the agent the service: only its owner can, on their
        own connection while it is active. Mostly it is the owner who tries."""
        owner = AGENTS[agent]
        actor = owner if by else next(o for o in OWNERS if o != owner)

        async def go() -> None:
            async with self.factory() as session:
                row = await session.scalar(
                    select(Agent).where(Agent.id == self.agent_ids[agent])
                )
                assert row is not None
                await self.broker.set_grant(
                    session,
                    agent=row,
                    actor_id=self.user_ids[actor],
                    service=SERVICE,
                    access=access,  # type: ignore[arg-type]
                    tool_mode=None,
                    tools=None,
                    resources=RESOURCES,
                )

        linked = self.linked[owner]
        allowed = (
            actor == owner
            and self.member[owner]
            and linked is not None
            and linked.active
            and (access == "read" or linked.consent == "write")
        )
        try:
            self.run(go())
        except ServiceError as error:
            assert not allowed, (
                f"{actor} granting {agent} {access} was refused: {error.code} "
                f"{error.message}"
            )
            return
        assert allowed or (actor == owner and linked is not None and linked.active), (
            f"{actor} granted {agent} {access}, which the model refuses"
        )
        assert linked is not None
        previous = self.granted[agent]
        if previous is None:
            self.grant_number[agent] += 1
        elif (
            previous.access == "write"
            and access == "read"
            or (previous.account != linked.account)
        ):
            # A grant that reaches less, or another account, is a new grant
            # for what was issued under the old one.
            COVERAGE["narrowed a grant"] += 1
            self.grant_number[agent] += 1
        self.granted[agent] = Granted(owner, linked.account, access)

    @rule(agent=st.sampled_from(sorted(AGENTS)))
    def revoke_grant(self, agent: str) -> None:
        async def go() -> bool:
            async with self.factory() as session:
                grant = await self.store.get_grant(
                    session, self.agent_ids[agent], SERVICE
                )
                if grant is None:
                    return False
                await self.broker.revoke_grant(
                    session, grant, self.user_ids[AGENTS[agent]]
                )
                return True

        removed = self.run(go())
        assert removed == (self.granted[agent] is not None), (
            f"{agent}'s grant was {'there' if removed else 'missing'}, "
            f"the model has {self.granted[agent]}"
        )
        self.granted[agent] = None

    # ── Steps: the workspace and the controllers ─────────────────────────────

    @rule(owner=st.sampled_from(OWNERS))
    def leave(self, owner: str) -> None:
        async def go() -> None:
            async with self.factory() as session:
                await session.execute(
                    delete(TenantMember).where(
                        TenantMember.tenant_id == TENANT_ZERO_ID,
                        TenantMember.user_id == self.user_ids[owner],
                    )
                )
                await session.commit()

        self.run(go())
        self.member[owner] = False

    @rule(owner=st.sampled_from(OWNERS))
    def rejoin(self, owner: str) -> None:
        if self.member[owner]:
            return

        async def go() -> None:
            async with self.factory() as session:
                session.add(
                    TenantMember(
                        tenant_id=TENANT_ZERO_ID,
                        user_id=self.user_ids[owner],
                        role="member",
                    )
                )
                await session.commit()

        self.run(go())
        self.member[owner] = True

    @rule(controller=st.sampled_from(sorted(CONTROLLERS)))
    def restore_controller(self, controller: str) -> None:
        """The controller is enrolled again under the same id."""

        async def go() -> None:
            async with self.factory() as session:
                await session.execute(
                    update(AgentController)
                    .where(AgentController.id == controller)
                    .values(revoked_at=None)
                )
                await session.commit()

        self.run(go())
        self.live[controller] = True

    @rule(controller=st.sampled_from(sorted(CONTROLLERS)))
    def revoke_controller(self, controller: str) -> None:
        async def go() -> None:
            async with self.factory() as session:
                await session.execute(
                    update(AgentController)
                    .where(AgentController.id == controller)
                    .values(revoked_at=AgentController.created_at)
                )
                await session.commit()

        self.run(go())
        self.live[controller] = False

    @rule(agent=st.sampled_from(sorted(AGENTS)), data=st.data())
    def move(self, agent: str, data: st.DataObject) -> None:
        """The agent moves to another of its owner's controllers."""
        owner = AGENTS[agent]
        to = data.draw(
            st.sampled_from(sorted(c for c, o in CONTROLLERS.items() if o == owner))
        )

        async def go() -> None:
            async with self.factory() as session:
                await session.execute(
                    update(AgentDefinition)
                    .where(AgentDefinition.agent_id == self.agent_ids[agent])
                    .values(controller_id=to)
                )
                await session.commit()

        self.run(go())
        self.host[agent] = to

    # ── Steps: asking for a token ────────────────────────────────────────────

    @rule(
        agent=st.sampled_from(sorted(AGENTS)),
        asker=st.sampled_from(ASKERS),
    )
    def issue(self, agent: str, asker: str) -> None:
        self._issue(agent, self._asker(agent, asker))

    def _asker(self, agent: str, asker: str) -> str | None:
        """The controller that asks for `agent`, or None for its own key."""
        owner = AGENTS[agent]
        if asker == "its host":
            return self.host[agent]
        if asker == "another of its owner's":
            return next(
                (
                    c
                    for c, o in sorted(CONTROLLERS.items())
                    if o == owner and c != self.host[agent]
                ),
                self.host[agent],
            )
        if asker == "someone else's":
            return next(c for c, o in sorted(CONTROLLERS.items()) if o != owner)
        return None

    def _issue(self, agent: str, controller: str | None) -> None:
        principal = (
            Principal.agent_key()
            if controller is None
            else Principal.controller(
                controller, self.user_ids[CONTROLLERS[controller]]
            )
        )
        asked = len(self.vendor.issued)

        async def go() -> str:
            async with self.factory() as session:
                token = await self.broker.issue(
                    session, self.agent_ids[agent], principal, SERVICE
                )
                return token.token

        refusal = self._refusal(agent, controller)
        as_whom = "its key" if controller is None else controller
        try:
            token = self.run(go())
        except ServiceError as error:
            assert refusal is not None, (
                f"{agent} asking as {as_whom} was refused ({error.code}: "
                f"{error.message}), and the model allows it"
            )
            assert len(self.vendor.issued) == asked, (
                f"{agent} was refused, but the vendor was asked for a token"
            )
            COVERAGE["refused"] += 1
            return
        assert refusal is None, (
            f"{agent} asking as {as_whom} was issued a token, though {refusal}"
        )
        owner = AGENTS[agent]
        [(access_token, issued)] = self.vendor.issued[asked:]
        assert issued == token
        assert access_token.startswith(f"gho_{owner}_"), (
            f"{agent}'s token was issued on {access_token}, not on {owner}'s connection"
        )
        COVERAGE[
            "issued as the agent's key"
            if controller is None
            else "issued as a controller"
        ] += 1
        self.held.append(
            Held(
                token=token,
                agent=agent,
                owner=owner,
                grant=self.grant_number[agent],
                epoch=self.epochs[owner],
                controller=controller,
            )
        )

    @rule()
    def tick(self) -> None:
        self._tick()

    def _tick(self) -> None:
        """The five-minute upkeep: after it, nothing withdrawn is still live."""
        self.run(maintain_once(self.factory, self.broker, prune=False))
        revoked = set(self.vendor.revoked)
        for held in self.held:
            reason = self._withdrawn(held)
            assert reason is None or held.token in revoked, (
                f"{held.agent}'s token from "
                f"{'its key' if held.controller is None else held.controller} "
                f"is still live after the upkeep, though {reason}"
            )
        before = len(self.held)
        self.held = [held for held in self.held if held.token not in revoked]
        COVERAGE["revoked a held token"] += before - len(self.held)

    # Asking and the upkeep are what the property is about, and each needs a
    # withdrawal between them to say anything: drawn three times as often as
    # any one way of withdrawing.
    @rule(
        agent=st.sampled_from(sorted(AGENTS)),
        asker=st.sampled_from(ASKERS),
    )
    def issue_again(self, agent: str, asker: str) -> None:
        self._issue(agent, self._asker(agent, asker))

    @rule(
        agent=st.sampled_from(sorted(AGENTS)),
        asker=st.sampled_from(ASKERS),
    )
    def issue_once_more(self, agent: str, asker: str) -> None:
        self._issue(agent, self._asker(agent, asker))

    @rule()
    def tick_again(self) -> None:
        self._tick()

    @rule()
    def tick_once_more(self) -> None:
        self._tick()

    # ── Invariants ───────────────────────────────────────────────────────────

    @invariant()
    def nothing_revoked_is_issued_again(self) -> None:
        tokens = [token for _, token in self.vendor.issued]
        assert len(tokens) == len(set(tokens))

    @invariant()
    def secrets_are_never_stored_in_the_clear(self) -> None:
        async def go() -> list[str]:
            async with self.factory() as session:
                return list(
                    await session.scalars(select(ServiceConnection.encrypted_secret))
                )

        for stored in self.run(go()):
            assert "gho_" not in stored and "ghr_" not in stored
            json.loads(TEST_KEYRING.decrypt(stored))


def machine_on(url: str) -> type[BrokerMachine]:
    """The machine against the database at `url`."""
    return type("BrokerMachineOnPostgres", (BrokerMachine,), {"url": url})
