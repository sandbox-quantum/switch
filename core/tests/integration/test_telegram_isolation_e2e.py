"""Two organisations on the one shared Telegram bot, and nothing crossing.

The distributed Telegram app is one bot serving every organisation, so its
isolation rests on routing each update by the chat it came from and on
row-level security below that — not on anything Telegram separates. This drives
the genuine path end to end: the webhook route, the real installer, the claim
against Postgres under the restricted role, the real bridge lifecycle, the
shared-delivery adapter and `CollaborationCore`, down to the rows a bridged message
writes. Only Telegram itself is faked.

What it asserts is what the design's isolation argument promises: each chat's
messages reach its own organisation's room and appear nowhere in the other's —
not in its messages, its receipts or its seen users — the same Telegram user
in both is two people, one per organisation; a chat nobody claimed and a
direct message leave no row at all and no trace of what they said; and a lookup
that answers the wrong organisation is a miss rather than a cross-tenant read.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from switch_core.bridges.collaboration import install_service as install_service_module
from switch_core.bridges.collaboration.install import MessagingInstallerRegistry
from switch_core.bridges.collaboration.install_routes import (
    create_messaging_install_router,
)
from switch_core.bridges.collaboration.install_service import MessagingInstallService
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.app_client import TelegramAppClient
from switch_core.bridges.collaboration.telegram.install import (
    DIRECT_MESSAGE_REPLY,
    SECRET_TOKEN_HEADER,
    TelegramAppInstaller,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    ExternalUser,
    Message,
    MessagingEventReceipt,
    Room,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.db.stores.messaging_install_store import MessagingInstallStore
from switch_core.db.stores.user_store import UserStore
from switch_core.tenant_context import tenant_scope
from tests.integration.conftest import Harness
from tests.switch_core.bridges.collaboration.test_telegram_adapter import _FakeBot

pytestmark = [
    pytest.mark.integration,
    pytest.mark.collaboration_bridges,
    pytest.mark.asyncio(loop_scope="session"),
]

_ORIGIN = "https://switch.example"
_SECRET = "placeholder-webhook-secret"
_BOT_ID = 555000
_USERNAME = "switch_app_bot"
_ADA = {"id": 4242, "is_bot": False, "first_name": "Ada", "username": "ada"}


class _Me:
    id = _BOT_ID
    username = _USERNAME
    can_read_all_group_messages = True
    can_join_groups = True


class _AppBot(_FakeBot):
    """The adapter tests' fake Telegram, plus what the shared client asks of it."""

    token = f"{_BOT_ID}:placeholder-token"

    async def initialize(self) -> None:
        return None

    async def get_me(self) -> _Me:
        return _Me()

    async def set_webhook(self, **kwargs: Any) -> bool:
        return True

    async def shutdown(self) -> None:
        return None


class _World:
    """One deployment's shared bot, its install service and its webhook."""

    def __init__(self, harness: Harness, bot: _AppBot, client: httpx.AsyncClient):
        self.harness = harness
        self.bot = bot
        self.client = client
        self._update_id = 0

    async def post(self, **update: Any) -> int:
        self._update_id += 1
        response = await self.client.post(
            "/messaging/telegram/events",
            json={"update_id": self._update_id, **update},
            headers={SECRET_TOKEN_HEADER: _SECRET},
        )
        return response.status_code

    @property
    def last_update_id(self) -> int:
        return self._update_id


async def _world(harness: Harness) -> tuple[_World, MessagingInstallService]:
    lifecycle: Any = harness.collab_lifecycle
    lifecycle.register_adapter("telegram", TelegramAdapter, TelegramConnectionConfig)

    async def attach(client: TelegramAppClient) -> None:
        for adapter in lifecycle.iter_adapters():
            if isinstance(adapter, TelegramAdapter):
                adapter.attach_shared_connection(client)

    bot = _AppBot()
    app_client = TelegramAppClient(
        bot=bot,  # type: ignore[arg-type]
        webhook_url=f"{_ORIGIN}/messaging/telegram/events",
        webhook_secret=_SECRET,
        on_connected=attach,
    )
    await app_client.start()
    installers = MessagingInstallerRegistry()
    installers.register(TelegramAppInstaller(client=app_client, webhook_secret=_SECRET))
    service = MessagingInstallService(
        session_factory=harness.session_factory,  # type: ignore[arg-type]
        store=MessagingInstallStore(),
        receipts=MessagingEventReceiptStore(),
        installers=installers,
        lifecycle=lifecycle,
        users=UserStore(),
        rooms=harness.room_service,
        public_origin=_ORIGIN,
        secret="integration-jwt-secret",
    )
    app = FastAPI()
    app.include_router(create_messaging_install_router(service))
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=_ORIGIN)
    return _World(harness, bot, client), service


async def _organisation(harness: Harness) -> tuple[str, str]:
    """A tenant with one admin, created the way onboarding creates one.

    The tenant row is written by a session bound to its own id, which is the
    one binding `tenants`' policy accepts (see `create_tenant`).
    """
    factory: Any = harness.session_factory
    tenant_id = str(uuid.uuid4())
    suffix = tenant_id[:8]
    async with factory() as session:
        admin = User(
            name=f"admin-{suffix}", email=f"admin-{suffix}@example.test", role="user"
        )
        session.add(admin)
        await session.commit()
        admin_id = admin.id
    with tenant_scope(tenant_id):
        async with tenant_session(factory, tenant_id) as session:
            session.add(
                Tenant(id=tenant_id, slug=f"org-{suffix}", name=f"Org {suffix}")
            )
            await session.flush()
            session.add(
                TenantMember(tenant_id=tenant_id, user_id=admin_id, role="admin")
            )
            await session.commit()
    return tenant_id, admin_id


async def _claim_code(
    harness: Harness, service: MessagingInstallService, tenant_id: str, admin_id: str
) -> str:
    factory: Any = harness.session_factory
    with tenant_scope(tenant_id):
        async with tenant_session(factory, tenant_id) as session:
            link = await service.begin_claim(
                session, platform="telegram", user_id=admin_id
            )
            await session.commit()
    return link.code


def _group(chat_id: int, title: str) -> dict[str, Any]:
    return {"id": chat_id, "type": "supergroup", "title": title}


def _message(
    chat: dict[str, Any], text: str, sender: dict[str, Any] = _ADA
) -> dict[str, Any]:
    return {
        "message_id": abs(hash(text)) % 100000,
        "date": 0,
        "chat": chat,
        "from": sender,
        "text": text,
    }


async def _eventually(
    check: Callable[[], Awaitable[bool]], what: str, timeout: float = 15.0
) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if await check():
            return
        await asyncio.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what}")


async def _scoped(harness: Harness, tenant_id: str, query: Any) -> list[Any]:
    factory: Any = harness.session_factory
    with tenant_scope(tenant_id):
        async with tenant_session(factory, tenant_id) as session:
            return list((await session.execute(query)).scalars())


async def _bodies(harness: Harness, tenant_id: str) -> list[str]:
    return [
        body
        for body in await _scoped(harness, tenant_id, select(Message.body))
        if body is not None
    ]


async def _connect(
    world: _World,
    service: MessagingInstallService,
    tenant_id: str,
    admin_id: str,
    chat: dict[str, Any],
) -> None:
    code = await _claim_code(world.harness, service, tenant_id, admin_id)
    # The bot being added arrives first, while the chat still belongs to nobody.
    await world.post(
        my_chat_member={
            "chat": chat,
            "from": _ADA,
            "date": 0,
            "old_chat_member": {
                "status": "left",
                "user": {"id": _BOT_ID, "is_bot": True, "first_name": "Switch"},
            },
            "new_chat_member": {
                "status": "member",
                "user": {"id": _BOT_ID, "is_bot": True, "first_name": "Switch"},
            },
        }
    )
    # Then the claim. Telegram retries a 503 — a bridge still starting — so
    # this does too, as Telegram would.
    for _ in range(10):
        status = await world.post(message=_message(chat, f"/start@{_USERNAME} {code}"))
        if status == 200:
            break
        await asyncio.sleep(0.2)

    async def has_room() -> bool:
        rooms = await _scoped(
            world.harness,
            tenant_id,
            select(Room).where(Room.external_channel_id == str(chat["id"])),
        )
        return len(rooms) == 1

    await _eventually(has_room, f"the room for chat {chat['id']}")


async def test_two_organisations_share_the_bot_and_nothing_else(
    harness: Harness, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    world, service = await _world(harness)
    tenant_a, admin_a = await _organisation(harness)
    tenant_b, admin_b = await _organisation(harness)
    chat_a, chat_b = _group(-1001111, "Acme"), _group(-1002222, "Globex")

    await _connect(world, service, tenant_a, admin_a, chat_a)
    await _connect(world, service, tenant_b, admin_b, chat_b)

    # ── Each chat's messages reach its own organisation, and only it ──────────
    await world.post(message=_message(chat_a, "hello from acme"))
    await world.post(message=_message(chat_b, "hello from globex"))

    async def both_arrived() -> bool:
        return "hello from acme" in await _bodies(
            harness, tenant_a
        ) and "hello from globex" in await _bodies(harness, tenant_b)

    await _eventually(both_arrived, "both messages to be bridged")
    assert "hello from globex" not in await _bodies(harness, tenant_a)
    assert "hello from acme" not in await _bodies(harness, tenant_b)

    a_rooms = await _scoped(harness, tenant_a, select(Room.external_channel_id))
    b_rooms = await _scoped(harness, tenant_b, select(Room.external_channel_id))
    assert str(chat_b["id"]) not in a_rooms
    assert str(chat_a["id"]) not in b_rooms

    # ── Receipts are kept by the organisation that received the update ───────
    a_receipts = set(
        await _scoped(
            harness, tenant_a, select(MessagingEventReceipt.external_event_id)
        )
    )
    b_receipts = set(
        await _scoped(
            harness, tenant_b, select(MessagingEventReceipt.external_event_id)
        )
    )
    assert a_receipts and b_receipts
    assert not a_receipts & b_receipts

    # ── One Telegram user in both chats is two people, one per organisation ──
    a_ada = await _scoped(
        harness,
        tenant_a,
        select(ExternalUser).where(ExternalUser.external_user_id == "4242"),
    )
    b_ada = await _scoped(
        harness,
        tenant_b,
        select(ExternalUser).where(ExternalUser.external_user_id == "4242"),
    )
    assert len(a_ada) == 1 and len(b_ada) == 1
    assert a_ada[0].bridge_id != b_ada[0].bridge_id
    assert a_ada[0].client_id != b_ada[0].client_id

    # ── A chat nobody claimed, and a direct message, leave no trace ──────────
    receipts_before = a_receipts | b_receipts
    with caplog.at_level("DEBUG"):
        assert (
            await world.post(
                message=_message(_group(-1003333, "Nobody"), "unclaimed secret")
            )
            == 200
        )
        assert (
            await world.post(
                message=_message(
                    {"id": 4242, "type": "private", "first_name": "Ada"}, "dm secret"
                )
            )
            == 200
        )
    for tenant in (tenant_a, tenant_b, TENANT_ZERO_ID):
        bodies = await _bodies(harness, tenant)
        assert "unclaimed secret" not in bodies and "dm secret" not in bodies
    receipts_after = set(
        await _scoped(
            harness, tenant_a, select(MessagingEventReceipt.external_event_id)
        )
    ) | set(
        await _scoped(
            harness, tenant_b, select(MessagingEventReceipt.external_event_id)
        )
    )
    assert receipts_after == receipts_before
    assert "unclaimed secret" not in caplog.text
    assert "dm secret" not in caplog.text
    assert {"chat_id": 4242, "text": DIRECT_MESSAGE_REPLY} in [
        {"chat_id": m["chat_id"], "text": m["text"]} for m in world.bot.messages
    ]

    # ── A lookup that answers the wrong organisation is a miss ───────────────
    async def wrong(*_: Any) -> str:
        return tenant_b

    monkeypatch.setattr(install_service_module, "tenant_of_messaging_install", wrong)
    assert await world.post(message=_message(chat_a, "misrouted")) == 200
    await asyncio.sleep(0.5)
    assert "misrouted" not in await _bodies(harness, tenant_a)
    assert "misrouted" not in await _bodies(harness, tenant_b)

    await world.client.aclose()
