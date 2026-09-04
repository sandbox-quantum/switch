"""One setting picks the transport, and the recorder that goes with it.

The pairing is the thing worth a test. A transport that stores what it carries
paired with a recorder that also writes would double every row; the other way
round would leave the log empty. Both are silent until someone reads the table,
which is why the decision is made in one place and checked here.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.client_base import ClientBase
from switch_core.clients.client_factory import ClientFactory
from switch_core.config import SwitchConfig
from switch_core.db.models import Client
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.messages import MessageRecorder
from switch_core.messages.notify import MessageListener
from switch_core.messages.recording import NoRecording
from switch_core.transport.invites import InviteBus
from switch_core.transport.matrix import MatrixTransport
from switch_core.transport.postgres import PostgresTransport


def _factory(
    session_factory: async_sessionmaker[AsyncSession], transport: str
) -> ClientFactory:
    config = SwitchConfig(
        db_host="db",
        db_port="5432",
        db_user="postgres",
        db_password="pw",
        db_name="switch",
        matrix_server="http://nowhere",
        matrix_server_name="switch.local",
        matrix_admin_user="admin",
        matrix_admin_password="pw",
        matrix_registration_shared_secret="secret",
        agent_registration_token="token",
        jwt_secret_key="jwt",
        gateway_admin_email="admin@example.com",
        gateway_admin_password="pw",
        message_transport=transport,  # type: ignore[arg-type]
    )
    recorder = MessageRecorder(
        session_factory=session_factory,
        room_store=RoomStore(),
        message_store=MessageStore(),
    )
    factory = ClientFactory(
        client_store=ClientStore(),
        session_factory=session_factory,
        config=config,
        message_recorder=recorder,
        room_store=RoomStore(),
        message_store=MessageStore(),
        media_store=MediaStore(),
        listener=MessageListener(lambda: None),  # type: ignore[arg-type,return-value]
        invites=InviteBus(),
    )
    factory.register("user", ClientBase)
    return factory


def _record() -> Client:
    return Client(
        id="client-1",
        matrix_user_id="@someone:test",
        display_name="someone",
        type="user",
        password="x",
    )


@pytest.mark.parametrize(
    ("setting", "transport_class", "records_separately"),
    [
        ("matrix", MatrixTransport, True),
        ("postgres", PostgresTransport, False),
    ],
)
def test_the_setting_picks_both_halves(
    session_factory: async_sessionmaker[AsyncSession],
    setting: str,
    transport_class: type,
    records_separately: bool,
) -> None:
    client: Any = _factory(session_factory, setting).create(_record())

    assert isinstance(client._transport_factory(client), transport_class)
    assert isinstance(client.message_recorder, MessageRecorder) is records_separately
    assert isinstance(client.message_recorder, NoRecording) is not records_separately
