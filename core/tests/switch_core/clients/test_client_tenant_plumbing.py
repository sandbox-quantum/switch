"""A client's tenant travels with the row it was built from (CHOO-2623).

There was an eighth exempt lookup, `tenant_of_client`, and it was the most
called of them: every `PostgresTransport` asked it once, and so did every
`AgentClient.start`. Both were built from a `clients` row that names the
tenant in a column, so the question went to the database with the answer
already in hand — and a `SECURITY DEFINER` function nobody needs is still a
function to audit and still one more thing the runtime role's credentials
reach.

So `ClientBase` and `PostgresTransport` take a `tenant_id` the way they take a
`client_id`. That moves the risk rather than removing it: a lookup that
resolves the tenant from a primary key cannot be given the wrong one, and a
parameter can. These tests are what stands in for it.

Three things are pinned:

- **the factory**, which is the one place the value is read off a row, for
  both the client and the transport it is handed;
- **the write path**, because the freshest caller — a puppet minted
  mid-conversation — passes a record that was flushed a moment ago rather than
  read back, and `record.tenant_id` has to be populated by then;
- **every call site**, by scanning for one that names a `client_id` and not a
  tenant, since a constructor test proves nothing about the places that build
  a client wrongly.
"""

from __future__ import annotations

import ast
import pathlib
import uuid
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import switch_core
from switch_core.clients.client_base import ClientBase, ClientConfig
from switch_core.clients.client_factory import ClientFactory
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.models import TENANT_ZERO_ID, Client, Tenant
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.tenant_context import tenant_scope
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus


def _factory(session_factory: async_sessionmaker[AsyncSession]) -> ClientFactory:
    factory = ClientFactory(
        client_store=ClientStore(),
        session_factory=session_factory,
        config=SimpleNamespace(matrix_server_name="test"),  # type: ignore[arg-type]
        room_store=RoomStore(),
        message_store=MessageStore(),
        media_store=MediaStore(),
        listener=MagicMock(),
        invites=InviteBus(),
        ephemeral=EphemeralBus(),
    )
    factory.register("user", ClientBase)
    return factory


def _record(tenant_id: str) -> Client:
    suffix = uuid.uuid4().hex[:8]
    return Client(
        id=f"client-{suffix}",
        tenant_id=tenant_id,
        matrix_user_id=f"@puppet-{suffix}:test",
        display_name="a puppet",
        type="user",
    )


class TestTheFactoryReadsItOffTheRow:
    def test_a_client_gets_its_own_rows_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"

        client = _factory(session_factory).create(_record(tenant_id))

        assert client.tenant_id == tenant_id

    def test_the_transport_gets_the_clients_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`transport_for` is public because a collaboration bridge builds its
        own client, so this is the seam every transport in the process comes
        through — and the one place a transport could be handed the wrong
        tenant for every read and write it will ever do."""
        tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
        factory = _factory(session_factory)

        client = factory.create(_record(tenant_id))
        transport = factory.transport_for(client)

        assert transport.tenant_id == tenant_id  # type: ignore[attr-defined]

    def test_a_client_cannot_be_built_without_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Required rather than defaulted. A client that fell back to whatever
        was ambient would be silently correct in the common case — boot, one
        tenant — and silently wrong for the puppet a bridge mints while
        handling another tenant's message."""
        with pytest.raises(TypeError):
            ClientBase(  # type: ignore[call-arg]
                client_id="c",
                matrix_user_id="@a:test",
                display_name="a client",
                session_factory=session_factory,
                client_store=ClientStore(),
                config=ClientConfig(),
                transport_factory=lambda client: MagicMock(),
            )


class TestAFreshlyWrittenRowAlreadyCarriesIt:
    """`create_client` writes the row and hands it straight to the factory.

    A puppet is created and started inside one inbound message, so the record
    the factory sees has been flushed rather than read back. `tenant_id` is a
    Python-side default (`db/models.py`'s `TenantScoped`) applied at flush, and
    the session factory does not expire on commit, so the value is there — but
    "is there" is exactly the kind of thing that is true until a `SessionMaker`
    argument changes, so it is asserted rather than assumed.
    """

    async def test_the_record_it_returns_names_the_bound_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
            await session.commit()

        service = ClientLifecycleService(
            matrix_admin=MagicMock(),
            client_store=ClientStore(),
            tenant_store=TenantStore(),
            client_factory=MagicMock(),
            session_factory=session_factory,
            config=SimpleNamespace(matrix_server_name="test"),  # type: ignore[arg-type]
        )

        with tenant_scope(tenant_id):
            record = await service.create_client(
                client_type="user", display_name="a puppet"
            )

        assert record.tenant_id == tenant_id

    async def test_the_ambient_tenant_is_what_lands_on_the_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The other direction, so the test above is not satisfied by a
        constant: with tenant zero bound, that is what the row gets."""
        service = ClientLifecycleService(
            matrix_admin=MagicMock(),
            client_store=ClientStore(),
            tenant_store=TenantStore(),
            client_factory=MagicMock(),
            session_factory=session_factory,
            config=SimpleNamespace(matrix_server_name="test"),  # type: ignore[arg-type]
        )

        record = await service.create_client(
            client_type="user", display_name="another puppet"
        )

        assert record.tenant_id == TENANT_ZERO_ID


def test_no_call_site_names_a_client_without_naming_its_tenant() -> None:
    """Catch the caller, which the constructor tests above cannot.

    A client or a transport is built in five places — the factory, the
    collaboration bridge's lifecycle service, and the tests that stand in for
    them — and the failure of passing the wrong tenant is not an exception. It
    is a client reading and writing in somebody else's tenant, or, once the
    policies refuse it, a client silently in no rooms at all. Both are
    invisible in review, so scan for the shape instead: anything constructing
    a thing that takes a `client_id` has to say which tenant it is for.
    """
    package = pathlib.Path(switch_core.__file__).resolve().parent
    offenders: list[str] = []

    for path in package.rglob("*.py"):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func: Any = node.func
            name = getattr(func, "id", None) or getattr(func, "attr", "")
            if not (name.endswith("Client") or name.endswith("Transport")):
                continue
            passed = {keyword.arg for keyword in node.keywords if keyword.arg}
            if "client_id" in passed and "tenant_id" not in passed:
                offenders.append(f"{path.relative_to(package)}: {name}(client_id=…)")

    assert offenders == [], (
        "a client or transport is built without a tenant; these call sites "
        f"name a client_id and no tenant_id: {offenders}. Take it off the "
        "`clients` row the client_id came from — every caller is holding one "
        "— rather than from whatever tenant happens to be bound, which for a "
        "puppet minted mid-conversation is the wrong one."
    )
