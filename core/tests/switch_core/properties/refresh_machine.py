"""A Hypothesis state machine over concurrent token refreshes.

A vendor that rotates refresh tokens spends the old one on every refresh, and
one that detects reuse refuses a spent one and ends the sign-in, so two
refreshes that overlap leave the owner signed out. The broker keeps them apart
two ways: callers in one process share one fetch, and processes take the
connection's lock. The machine is several such processes, each its own
`ServiceBroker` on one database, whose agents ask for tokens in bursts while
the owner's token is fresh, about to expire or expired; some callers give up
part way, refreshes fail now and then, and the owner signs in again in the
middle of a burst. The vendor counts every refresh and refuses a spent token.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import Counter
from datetime import timedelta
from typing import Any, ClassVar

import hypothesis.strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.connections.adapters import (
    ConnectionSecret,
    ReauthorizationRequiredError,
    ServiceUnavailableError,
)
from switch_core.connections.broker import (
    REFRESH_BEFORE,
    Principal,
    ServiceBroker,
    ServiceError,
)
from switch_core.connections.loader import CATALOG
from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID, TenantMember, User
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.tenant_context import tenant_scope
from tests.conftest import TEST_KEYRING, empty_the_database
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.gateway.agent_route_harness import add_agent

SERVICE = "github"
PROCESSES = 3
AGENTS = ("one", "two")
RESOURCES = {"installation_id": 7, "repository_ids": [70, 71]}
# Long enough that a second refresh that is not kept apart starts inside it.
REFRESH_SECONDS = 0.05
BURST_SECONDS = 30.0

COVERAGE: Counter[str] = Counter()
SHOULD_REACH = (
    "refreshed in a burst",
    "a burst across processes",
    "a caller gave up",
    "a refresh failed",
    "signed in again during a burst",
)


class RotatingVendor(FakeVendor):
    """A vendor whose refresh tokens rotate: each refresh spends the token it
    was given, and a spent one is refused as reuse, which ends the sign-in."""

    def __init__(self) -> None:
        super().__init__()
        self.current: dict[str, str] = {}
        self.family: dict[str, str] = {}
        self.reused: list[str] = []
        self.failing = 0
        self.spent = 0

    def sign_in(self, name: str) -> dict[str, Any]:
        token = f"{name}.0"
        self.current[name] = token
        self.family[token] = name
        return {
            "access_token": f"gho_{name}.0",
            "expires_at": time.time() + 8 * 3600,
            "refresh_token": token,
            "refresh_expires_at": time.time() + 180 * 86400,
        }

    async def refresh(self, secret: ConnectionSecret) -> ConnectionSecret:
        self.refreshes += 1
        given = secret.values["refresh_token"]
        family = self.family[given]
        if self.current[family] != given:
            self.reused.append(given)
            raise ReauthorizationRequiredError(f"{given} was already used.")
        await asyncio.sleep(REFRESH_SECONDS)
        if self.failing:
            self.failing -= 1
            raise ServiceUnavailableError("The vendor is unavailable.")
        self.spent += 1
        number = int(given.rsplit(".", 1)[1]) + 1
        token = f"{family}.{number}"
        self.current[family] = token
        self.family[token] = family
        return ConnectionSecret(
            {
                **secret.values,
                "access_token": f"gho_{token}",
                "expires_at": time.time() + 8 * 3600,
                "refresh_token": token,
            }
        )


class RefreshMachine(RuleBasedStateMachine):
    url: ClassVar[str]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._scope = tenant_scope(TENANT_ZERO_ID)
        self._scope.__enter__()
        self.engine = create_async_engine(self.url, pool_size=20)
        try:
            self._set_up()
        except BaseException:
            self._release()
            raise

    def _set_up(self) -> None:
        self.run(empty_the_database(self.engine))
        self.factory = create_session_factory(self.engine)
        self.vendor = RotatingVendor()
        self.store = ServiceConnectionStore()
        self.brokers = [
            ServiceBroker(
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
            for _ in range(PROCESSES)
        ]
        self.agent_ids: dict[str, str] = {}
        self.sign_ins = 0
        self.run(self._seed())

    async def _seed(self) -> None:
        async with self.factory() as session:
            owner = User(name="ada", email="ada@example.invalid", role="user")
            session.add(owner)
            await session.flush()
            session.add(
                TenantMember(tenant_id=TENANT_ZERO_ID, user_id=owner.id, role="member")
            )
            for name in AGENTS:
                agent = await add_agent(session, name=name, owner_id=owner.id)
                self.agent_ids[name] = agent.id
            await session.commit()
            self.owner_id = owner.id
        await self._sign_in()
        for agent_id in self.agent_ids.values():
            async with self.factory() as session:
                await self.store.save_grant(
                    session,
                    agent_id=agent_id,
                    owner_id=self.owner_id,
                    service=SERVICE,
                    access="write",
                    tool_mode="deny",
                    tools=[],
                    resources=RESOURCES,
                    account_id="1001",
                    created_by=self.owner_id,
                )
                await session.commit()

    async def _sign_in(self) -> None:
        """The owner signs in, or again over the sign-in they have."""
        self.sign_ins += 1
        values = self.vendor.sign_in(f"s{self.sign_ins}")
        async with self.factory() as session:
            await self.brokers[0].connect(
                session,
                user_id=self.owner_id,
                service=SERVICE,
                consent="write",
                granted_scopes=[],
                account_id="1001",
                external_identity="ada-gh",
                secret=ConnectionSecret(values),
                oauth_client_id=None,
            )

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

    async def _stored(self) -> tuple[dict[str, Any], str, int]:
        async with self.factory() as session:
            connection = await self.store.get_connection(
                session, self.owner_id, SERVICE
            )
            assert connection is not None
            return (
                json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret)),
                connection.status,
                connection.secret_revision,
            )

    # ── Steps ────────────────────────────────────────────────────────────────

    async def _age(self, when: str) -> None:
        """Time passes for the owner's access token."""
        expires_in = {
            "fresh": 8 * 3600,
            "about to expire": REFRESH_BEFORE.total_seconds() / 2,
            "expired": -60,
        }[when]

        values, _, revision = await self._stored()
        values["expires_at"] = time.time() + expires_in
        async with self.factory() as session:
            await self.store.replace_secret(
                session,
                self.owner_id,
                SERVICE,
                revision=revision,
                encrypted_secret=TEST_KEYRING.encrypt(json.dumps(values)),
            )
            await session.commit()

    @rule(times=st.integers(min_value=1, max_value=2))
    def fail_refreshes(self, times: int) -> None:
        """The vendor is unavailable for the next refreshes; the refresh
        token is not spent by a refresh that fails."""
        self.vendor.failing = times

    @rule(
        callers=st.lists(
            st.tuples(
                st.integers(min_value=0, max_value=PROCESSES - 1),
                st.sampled_from(AGENTS),
                st.integers(min_value=0, max_value=3).map(lambda n: n == 0),
            ),
            min_size=2,
            max_size=8,
        ),
        when=st.sampled_from(("fresh", "about to expire", "expired")),
        sign_in_again=st.integers(min_value=0, max_value=4).map(lambda n: n == 0),
    )
    def burst(
        self, callers: list[tuple[int, str, bool]], when: str, sign_in_again: bool
    ) -> None:
        """The owner's token is `when`, and agents ask at once, through any of
        the processes. A caller that gives up is cancelled while the refresh
        is under way."""

        async def go() -> list[object]:
            await self._age(when)
            values, _, _ = await self._stored()
            stale = values["expires_at"] <= time.time() + REFRESH_BEFORE.total_seconds()
            spent = self.vendor.spent
            failing = self.vendor.failing

            async def ask(process: int, agent: str) -> object:
                async with self.factory() as session:
                    return await self.brokers[process].issue(
                        session, self.agent_ids[agent], Principal.agent_key(), SERVICE
                    )

            tasks = [
                asyncio.create_task(ask(process, agent))
                for process, agent, _ in callers
            ]
            extra: list[asyncio.Task[None]] = []
            if sign_in_again:
                extra.append(asyncio.create_task(self._sign_in()))
                COVERAGE["signed in again during a burst"] += 1
            await asyncio.sleep(REFRESH_SECONDS / 2)
            for task, (_, _, gives_up) in zip(tasks, callers, strict=True):
                if gives_up:
                    task.cancel()
                    COVERAGE["a caller gave up"] += 1
            async with asyncio.timeout(BURST_SECONDS):
                outcomes = await asyncio.gather(*tasks, *extra, return_exceptions=True)
            # A refresh is under way in a shielded task after its callers gave
            # up; it must finish, and store what the vendor rotated, before
            # anything else asks.
            async with asyncio.timeout(BURST_SECONDS):
                for broker in self.brokers:
                    while broker._fetching:
                        await asyncio.sleep(0.01)
            refreshed = self.vendor.spent - spent
            assert refreshed <= 1 + int(sign_in_again), (
                f"one burst spent {refreshed} refresh tokens"
            )
            if stale and not sign_in_again and not failing:
                assert refreshed == 1, (
                    f"an expiring token was refreshed {refreshed} times in a burst"
                )
            if refreshed:
                COVERAGE["refreshed in a burst"] += 1
            if failing:
                COVERAGE["a refresh failed"] += 1
            if len({process for process, _, _ in callers}) > 1:
                COVERAGE["a burst across processes"] += 1
            return outcomes[: len(callers)]

        outcomes = self.run(go())
        for (process, agent, gives_up), outcome in zip(callers, outcomes, strict=True):
            if isinstance(outcome, asyncio.CancelledError):
                assert gives_up, (
                    f"{agent} asking through process {process} was cancelled, "
                    "though it kept waiting: another caller's giving up ended "
                    "the fetch it shared"
                )
                continue
            if isinstance(outcome, ServiceError):
                # Only a refresh the vendor could not answer, which the caller
                # may retry.
                assert outcome.retryable and outcome.status_code == 503, (
                    f"{agent} asking through process {process} was refused: "
                    f"{outcome.code} {outcome.message}"
                )
                continue
            assert not isinstance(outcome, BaseException), (
                f"{agent} asking through process {process} raised {outcome!r}"
            )

    # ── Invariants ───────────────────────────────────────────────────────────

    @invariant()
    def no_refresh_token_was_used_twice(self) -> None:
        assert not self.vendor.reused, (
            f"the vendor saw {self.vendor.reused} again after they were spent"
        )

    @invariant()
    def the_stored_sign_in_is_the_vendors_current_one(self) -> None:
        values, status, _ = self.run(self._stored())
        assert status == "active", f"the connection is {status}"
        token = values["refresh_token"]
        family = self.vendor.family[token]
        assert self.vendor.current[family] == token, (
            f"stored {token}, but the vendor's current one is "
            f"{self.vendor.current[family]}"
        )
        assert family == f"s{self.sign_ins}", (
            f"stored sign-in {family}, but the last one was s{self.sign_ins}"
        )


def machine_on(url: str) -> type[RefreshMachine]:
    """The machine against the database at `url`."""
    return type("RefreshMachineOnPostgres", (RefreshMachine,), {"url": url})
