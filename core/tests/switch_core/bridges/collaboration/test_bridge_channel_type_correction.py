"""The bridge corrects rooms whose saved channel type the platform contradicts,
whenever the adapter learns one and, on startup, for every live channel room."""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.tenant_context import current_tenant_id, tenant_scope


class _FakeSession:
    def __init__(self) -> None:
        self.commits = 0

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def commit(self) -> None:
        self.commits += 1


class _RoomStore:
    def __init__(self, rooms: list[SimpleNamespace], corrected: list[str]) -> None:
        self._rooms = rooms
        self._corrected = corrected
        self.corrections: list[tuple[str, str, str]] = []
        self.tenants: list[str | None] = []

    async def get_by_bridge(self, session: Any, bridge_id: str) -> list[Any]:
        assert bridge_id == "bridge-1"
        self.tenants.append(current_tenant_id())
        return self._rooms

    async def correct_channel_type(
        self,
        session: Any,
        *,
        bridge_id: str,
        external_channel_id: str,
        channel_type: str,
    ) -> list[str]:
        self.corrections.append((bridge_id, external_channel_id, channel_type))
        self.tenants.append(current_tenant_id())
        return self._corrected


def _room(
    external_channel_id: str | None, channel_type: str | None, archived: bool
) -> SimpleNamespace:
    return SimpleNamespace(
        external_channel_id=external_channel_id,
        channel_type=channel_type,
        archived_at="2026-01-01T00:00:00Z" if archived else None,
    )


class _Adapter:
    def __init__(self) -> None:
        self.refreshed: list[list[str]] = []

    async def refresh_channel_types(self, channel_ids: list[str]) -> None:
        self.refreshed.append(channel_ids)


def _bridge(store: _RoomStore, adapter: _Adapter) -> SimpleNamespace:
    session = _FakeSession()
    return SimpleNamespace(
        session=session,
        _session_factory=lambda: session,
        _room_store=store,
        _adapter=adapter,
        _bridge_id="bridge-1",
        _bridge_tenant_id="tenant-1",
        _bridge_type="teams",
    )


# ── Recording what the adapter learned ───────────────────────────────────────


@pytest.mark.parametrize(
    ("channel_type", "corrected", "asked"),
    [
        ("channel_private", ["room-1"], True),
        ("channel_private", [], True),
        ("direct", ["room-1"], False),
    ],
    ids=["corrected", "already-right", "chat-type-ignored"],
)
async def test_a_learned_type_corrects_this_bridges_rooms(
    channel_type: str,
    corrected: list[str],
    asked: bool,
    caplog: pytest.LogCaptureFixture,
) -> None:
    store = _RoomStore([], corrected)
    bridge = _bridge(store, _Adapter())

    with caplog.at_level(logging.WARNING):
        await BridgeCore._record_channel_type(
            bridge,  # type: ignore[arg-type]
            "19:p@thread.tacv2",
            channel_type,  # type: ignore[arg-type]
        )

    expected = [("bridge-1", "19:p@thread.tacv2", channel_type)]
    assert store.corrections == (expected if asked else [])
    # Written and committed under the bridge's tenant.
    assert store.tenants == (["tenant-1"] if asked else [])
    assert bridge.session.commits == (1 if asked else 0)
    # One warning per room actually changed, naming it.
    assert len(caplog.records) == (len(corrected) if asked else 0)
    assert all("room-1" in r.getMessage() for r in caplog.records)


# ── The startup pass ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("rooms", "refreshed"),
    [
        (
            [
                _room("19:b@thread.tacv2", "channel_private", False),
                _room("19:a@thread.tacv2", "channel_public", False),
                _room("19:a@thread.tacv2", "channel_public", False),
                _room("19:old@thread.tacv2", "channel_public", True),
                _room("a:dm", "direct", False),
                _room("19:g@thread.v2", "group", False),
                _room(None, "channel_public", False),
                _room("19:c@thread.tacv2", None, False),
            ],
            [["19:a@thread.tacv2", "19:b@thread.tacv2"]],
        ),
        ([_room("a:dm", "direct", False)], []),
    ],
    ids=["live-channel-rooms-once-each", "no-channel-rooms"],
)
async def test_startup_rereads_every_live_channel_room(
    rooms: list[SimpleNamespace], refreshed: list[list[str]]
) -> None:
    adapter = _Adapter()
    store = _RoomStore(rooms, [])

    await BridgeCore._refresh_channel_types(_bridge(store, adapter))  # type: ignore[arg-type]

    assert adapter.refreshed == refreshed
    assert store.tenants == ["tenant-1"]


async def test_adapters_have_nothing_to_refresh_by_default() -> None:
    adapter: Any = SimpleNamespace()
    await CollaborationAdapter.refresh_channel_types(adapter, ["C1"])


# ── Wiring in start() and stop() ─────────────────────────────────────────────


class _StartableAdapter:
    def __init__(self) -> None:
        self.channel_type_handler: Any = None
        self.handler_set_before_start = False

    def set_channel_type_handler(self, handler: Any) -> None:
        self.channel_type_handler = handler

    def set_channel_migration_handler(self, handler: Any) -> None:
        return None

    def set_agent_presentation_resolver(self, resolver: Any) -> None:
        return None

    async def start(self, **kwargs: Any) -> None:
        self.handler_set_before_start = self.channel_type_handler is not None

    async def stop(self) -> None:
        return None


def _startable_core(refresh: Any) -> tuple[BridgeCore, _StartableAdapter]:
    core = object.__new__(BridgeCore)
    adapter = _StartableAdapter()

    async def _noop() -> None:
        return None

    for name, value in {
        "_bridge_type": "teams",
        "_adapter": adapter,
        "_identity_task": None,
        "_channel_type_refresh_task": None,
        "_load_channel_map": _noop,
        "_load_existing_puppets": _noop,
        "_ensure_channel_captures": _noop,
        "_create_agent_identities": _noop,
        "_refresh_channel_types": refresh,
    }.items():
        setattr(core, name, value)
    for name in (
        "_handle_channel_migrated",
        "_agent_presentation",
        "_handle_inbound_message",
        "_handle_inbound_command",
        "_handle_agent_joined_channel",
        "_handle_user_joined_channel",
        "_handle_app_joined_channel",
    ):
        setattr(core, name, None)
    return core, adapter


async def test_start_installs_the_correction_and_stop_cancels_the_refresh(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Without the handler, a type learned at runtime corrects nothing until the
    # next start. The refresh must not inherit the tenant of whoever started it.
    running = asyncio.Event()
    tenants: list[str | None] = []

    async def _slow() -> None:
        tenants.append(current_tenant_id())
        running.set()
        await asyncio.sleep(30)

    core, adapter = _startable_core(_slow)

    with caplog.at_level(logging.INFO), tenant_scope("request-tenant"):
        await core.start()
        task = core._channel_type_refresh_task
        await asyncio.wait_for(running.wait(), timeout=1)
        await core.stop()
        await asyncio.sleep(0)

    assert adapter.channel_type_handler == core._record_channel_type
    assert adapter.handler_set_before_start
    assert task is not None and task.cancelled()
    assert core._channel_type_refresh_task is None
    assert "channel type refresh cancelled before finishing" in caplog.text
    assert tenants == [None]


async def test_a_failed_refresh_is_logged_rather_than_swallowed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def _explode() -> None:
        raise RuntimeError("refresh blew up")

    core, _ = _startable_core(_explode)

    with caplog.at_level(logging.ERROR):
        await core.start()
        assert core._channel_type_refresh_task is not None
        await core._channel_type_refresh_task
    await core.stop()

    assert "channel type refresh stopped unexpectedly" in caplog.text
