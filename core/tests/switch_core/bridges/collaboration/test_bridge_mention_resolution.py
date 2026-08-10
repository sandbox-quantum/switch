from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)

# Outbound `@name` mentions are rewritten to real Slack `<@U…>` mentions from a
# name → id map held in the adapter. The map used to be filled only as a side
# effect of resolving an inbound sender, so it was empty after every restart and
# a person was mentionable only once they happened to post again — the mention
# went out as plain text and they were never notified. The `external_users` table
# holds both halves of that mapping permanently, so the bridge (which has DB
# access; the adapter deliberately does not) primes the adapter from it.

BRIDGE_ID = "bridge-1"


def _adapter() -> SlackAdapter:
    return SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test",
            app_token="xapp-test",
            workspace_id="T123",
        )
    )


def _external_user(username: str, external_id: str, client_id: str) -> SimpleNamespace:
    return SimpleNamespace(
        external_username=username,
        external_user_id=external_id,
        client_id=client_id,
    )


def _session_factory() -> Any:
    async def _commit() -> None:
        return None

    @asynccontextmanager
    async def _factory() -> AsyncIterator[object]:
        yield SimpleNamespace(commit=_commit)

    return _factory


def _loading_bridge(adapter: SlackAdapter, users: list[SimpleNamespace]) -> Any:
    """A BridgeCore stand-in with just what `_load_existing_puppets` touches."""

    async def _get_by_bridge(_session: object, bridge_id: str) -> list[SimpleNamespace]:
        assert bridge_id == BRIDGE_ID
        return users

    async def _get_client(_session: object, _client_id: str) -> None:
        return None

    return SimpleNamespace(
        _adapter=adapter,
        _bridge_id=BRIDGE_ID,
        _session_factory=_session_factory(),
        _external_user_store=SimpleNamespace(get_by_bridge=_get_by_bridge),
        _client_store=SimpleNamespace(get=_get_client),
        _client_lifecycle=SimpleNamespace(get=lambda _id: None),
        _user_puppets={},
        _puppet_matrix_ids=set(),
    )


async def test_startup_priming_makes_a_never_seen_user_mentionable() -> None:
    adapter = _adapter()
    bridge = _loading_bridge(adapter, [_external_user("doe.jane", "U123", "client-1")])

    # Nothing has posted since startup, so the live-resolution path has not run.
    assert adapter.translate_outbound("@doe.jane ping") == "@doe.jane ping"

    await BridgeCore._load_existing_puppets(bridge)

    assert adapter.translate_outbound("@doe.jane ping") == "<@U123> ping"


async def test_priming_resolves_a_handle_with_capitals() -> None:
    adapter = _adapter()
    bridge = _loading_bridge(
        adapter, [_external_user("Timo.Meyer", "U456", "client-2")]
    )

    await BridgeCore._load_existing_puppets(bridge)

    # The mention pattern and the lookup are both case-insensitive: Slack handles
    # are, and the token a sender types need not match the stored casing.
    assert adapter.translate_outbound("@Timo.Meyer ping") == "<@U456> ping"
    assert adapter.translate_outbound("@timo.meyer ping") == "<@U456> ping"


async def test_app_rows_are_skipped_while_human_rows_are_primed() -> None:
    adapter = _adapter()
    # An app's row stores its display name against a `B…` bot id, which cannot
    # form a valid user mention. Priming must skip it while still taking the
    # human row alongside it — asserting both in one pass so this cannot pass by
    # virtue of nothing being primed at all.
    bridge = _loading_bridge(
        adapter,
        [
            _external_user("datadog", "BDATADOG", "client-3"),
            _external_user("doe.jane", "U123", "client-1"),
        ],
    )

    await BridgeCore._load_existing_puppets(bridge)

    assert adapter.translate_outbound("@datadog alert") == "@datadog alert"
    assert adapter.translate_outbound("@doe.jane alert") == "<@U123> alert"


async def test_new_puppet_is_mentionable_without_waiting_for_a_restart() -> None:
    adapter = _adapter()
    created_client = SimpleNamespace(
        client_id="client-9", matrix_user_id="@ext_new:switch.local"
    )

    async def _get_by_name(_session: object, _name: str) -> None:
        return None

    async def _create_and_start(**_kwargs: Any) -> SimpleNamespace:
        return created_client

    async def _create(_session: object, _user: object) -> None:
        return None

    bridge = SimpleNamespace(
        _adapter=adapter,
        _bridge_id=BRIDGE_ID,
        _bridge_type="slack",
        _session_factory=_session_factory(),
        _puppet_locks={},
        _user_puppets={},
        _puppet_matrix_ids=set(),
        _agent_store=SimpleNamespace(get_by_name=_get_by_name),
        _client_lifecycle=SimpleNamespace(create_and_start=_create_and_start),
        _external_user_store=SimpleNamespace(create=_create),
    )

    await BridgeCore._create_puppet(bridge, "U789", "new.person")

    assert adapter.translate_outbound("@new.person welcome") == "<@U789> welcome"


def test_unknown_name_is_still_left_as_plain_text() -> None:
    # Agents have no Slack id, so their names must survive untouched rather than
    # being rewritten into something Slack cannot render.
    adapter = _adapter()
    adapter.prime_mention_targets({"doe.jane": "U123"})

    assert adapter.translate_outbound("@some-agent hello") == "@some-agent hello"
