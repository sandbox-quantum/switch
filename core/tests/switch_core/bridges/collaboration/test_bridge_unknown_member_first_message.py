from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from switch_core.bridges.collaboration import bridge_core as bridge_core_module
from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import InboundMessage

# CHOO-1781: the first message from a channel member not yet known to the room
# must not be dropped. Provisioning only *invites* the external user's puppet —
# the join lands asynchronously from the puppet's own sync loop. Relaying before
# that join is rejected by the homeserver, so the triggering message vanishes.
# _ensure_user_in_matrix_room must therefore block until the join is observed,
# and must refuse to hand back a puppet that never joined.
#
# For a Slack app the same drop is not a race but a certainty. Joins are keyed on
# the `user` of a member_joined_channel event, whereas an app posting without a
# `user` is keyed on its `bot_id` (see SlackAdapter._handle_message_event). A
# `B…` id therefore never matches a join-time identity, so an app is never
# pre-warmed and always arrives here unknown — its first post hits the unjoined
# window every single time.

MATRIX_ROOM_ID = "!matrix:switch.local"

# Slack bot id of a third-party app, as the adapter reports it for a post with no
# `user` field.
APP_SENDER_ID = "BDATADOG"


async def _noop_repair(*_args: object, **_kwargs: object) -> None:
    """Correcting a name recorded as a platform id — not what these tests turn on."""
    return None


class _FakePuppet:
    """Stands in for a ClientBase puppet whose join lands after the invite."""

    def __init__(self) -> None:
        self.matrix_user_id = "@ext_alice:switch.local"
        self._joined = asyncio.Event()
        self.sent: list[tuple[str, str]] = []
        self.wait_joined_calls: list[tuple[str, float]] = []

    async def wait_ready(self) -> None:
        return None

    def complete_join(self) -> None:
        self._joined.set()

    async def wait_joined(self, room_id: str, timeout: float) -> bool:
        self.wait_joined_calls.append((room_id, timeout))
        try:
            await asyncio.wait_for(self._joined.wait(), timeout)
        except TimeoutError:
            return False
        return True

    async def send_message(self, room_id: str, content: str, **_kw: object) -> str:
        if not self._joined.is_set():
            # Mirrors the homeserver rejecting a send from a non-member.
            raise AssertionError("puppet sent into a room it has not joined")
        self.sent.append((room_id, content))
        return "$event-1"


def _bridge(
    puppet: _FakePuppet, *, known_puppets: dict[str, str] | None = None
) -> SimpleNamespace:
    async def _ensure_client_in_room(room_id: str, client_id: str) -> None:
        return None  # invite only — the join is asynchronous, as in production

    created: list[tuple[str, str]] = []

    async def _create_puppet(external_user_id: str, external_username: str) -> str:
        created.append((external_user_id, external_username))
        return "client-new"

    bridge = SimpleNamespace(
        _repair_placeholder_username=_noop_repair,
        _user_puppets={"ext-alice": "client-1"}
        if known_puppets is None
        else known_puppets,
        _client_lifecycle=SimpleNamespace(get=lambda _id: puppet),
        _room_service=SimpleNamespace(ensure_client_in_room=_ensure_client_in_room),
        _create_puppet=_create_puppet,
    )
    bridge.created_puppets = created
    return bridge


async def test_waits_for_puppet_join_before_returning() -> None:
    puppet = _FakePuppet()
    bridge = _bridge(puppet)

    task = asyncio.create_task(
        BridgeCore._ensure_user_in_matrix_room(
            bridge,
            external_user_id="ext-alice",
            external_username="alice",
            room_id="room-uuid",
            matrix_room_id=MATRIX_ROOM_ID,
        )
    )
    await asyncio.sleep(0)

    # Still blocked: the puppet has been invited but has not joined yet.
    assert not task.done()

    puppet.complete_join()
    assert await task is puppet
    assert puppet.wait_joined_calls == [
        (MATRIX_ROOM_ID, bridge_core_module.PUPPET_JOIN_TIMEOUT)
    ]


async def test_returns_none_when_join_never_lands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(bridge_core_module, "PUPPET_JOIN_TIMEOUT", 0.01)
    puppet = _FakePuppet()  # never joins

    result = await BridgeCore._ensure_user_in_matrix_room(
        _bridge(puppet),
        external_user_id="ext-alice",
        external_username="alice",
        room_id="room-uuid",
        matrix_room_id=MATRIX_ROOM_ID,
    )

    # Fail loud, never fake: no puppet handed back, so nothing is relayed into a
    # room the sender is not a member of.
    assert result is None


async def test_app_sender_puppet_is_provisioned_then_awaited() -> None:
    # An app is never pre-warmed by a join, so it always arrives with no puppet:
    # the provisioning branch runs, and the join must still be awaited before the
    # puppet is handed back. Without the wait this returns a puppet that is only
    # invited, and the app's very first post is lost — every time, not sometimes.
    puppet = _FakePuppet()
    bridge = _bridge(puppet, known_puppets={})

    task = asyncio.create_task(
        BridgeCore._ensure_user_in_matrix_room(
            bridge,
            external_user_id=APP_SENDER_ID,
            external_username="Datadog",
            room_id="room-uuid",
            matrix_room_id=MATRIX_ROOM_ID,
        )
    )
    await asyncio.sleep(0)

    assert bridge.created_puppets == [(APP_SENDER_ID, "Datadog")]
    assert not task.done()

    puppet.complete_join()
    assert await task is puppet
    assert puppet.wait_joined_calls == [
        (MATRIX_ROOM_ID, bridge_core_module.PUPPET_JOIN_TIMEOUT)
    ]


async def test_first_message_from_app_sender_is_relayed() -> None:
    # End-to-end for the guaranteed case: a third-party app posts into a channel
    # for the first time (bot-id sender, no puppet anywhere) and the post must
    # land in the room rather than being swallowed.
    puppet = _FakePuppet()
    relayed: list[tuple[str, str]] = []

    async def _is_registered_agent(_name: str) -> bool:
        return False

    async def _record_message_map(**kwargs: str) -> None:
        relayed.append((kwargs["transport_event_id"], kwargs["external_post_id"]))

    inner = _bridge(puppet, known_puppets={})

    async def _ensure_user_in_matrix_room(**kwargs: object) -> object:
        # Complete the join as the real invite/join round-trip would, so the
        # relay below exercises the post-join send rather than a stubbed one.
        asyncio.get_running_loop().call_soon(puppet.complete_join)
        return await BridgeCore._ensure_user_in_matrix_room(inner, **kwargs)  # type: ignore[arg-type]

    bridge = SimpleNamespace(
        _repair_placeholder_username=_noop_repair,
        _is_registered_agent=_is_registered_agent,
        _ensure_user_in_matrix_room=_ensure_user_in_matrix_room,
        _record_message_map=_record_message_map,
        _adapter=SimpleNamespace(translate_inbound=lambda text: text),
        _channel_to_room={"chan-1": ("room-uuid", MATRIX_ROOM_ID)},
        _channel_locks={},
    )

    await BridgeCore._handle_inbound_message(
        bridge,
        InboundMessage(
            channel_id="chan-1",
            channel_type="channel_public",
            sender_id=APP_SENDER_ID,
            sender_name="Datadog",
            content="Triggered: container restart spike",
            message_ref="slack-post-1",
        ),
    )

    assert inner.created_puppets == [(APP_SENDER_ID, "Datadog")]
    assert puppet.sent == [(MATRIX_ROOM_ID, "Triggered: container restart spike")]
    assert relayed == [("$event-1", "slack-post-1")]


async def test_first_message_from_unknown_member_is_relayed() -> None:
    puppet = _FakePuppet()
    relayed: list[tuple[str, str]] = []

    async def _is_registered_agent(_name: str) -> bool:
        return False

    async def _ensure_user_in_matrix_room(**_kw: object) -> _FakePuppet:
        # Provisioning completes the join, as the real path now guarantees.
        puppet.complete_join()
        return puppet

    async def _record_message_map(**kwargs: str) -> None:
        relayed.append((kwargs["transport_event_id"], kwargs["external_post_id"]))

    bridge = SimpleNamespace(
        _repair_placeholder_username=_noop_repair,
        _is_registered_agent=_is_registered_agent,
        _ensure_user_in_matrix_room=_ensure_user_in_matrix_room,
        _record_message_map=_record_message_map,
        _adapter=SimpleNamespace(translate_inbound=lambda text: text),
        _channel_to_room={"chan-1": ("room-uuid", MATRIX_ROOM_ID)},
        _channel_locks={},
    )

    await BridgeCore._handle_inbound_message(
        bridge,
        InboundMessage(
            channel_id="chan-1",
            channel_type="channel_public",
            sender_id="ext-alice",
            sender_name="alice",
            content="hello from a brand new member",
            message_ref="mm-post-1",
        ),
    )

    assert puppet.sent == [(MATRIX_ROOM_ID, "hello from a brand new member")]
    assert relayed == [("$event-1", "mm-post-1")]
