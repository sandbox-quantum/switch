"""A shared-delivery Discord bridge is constructible and inert.

The distributed app's per-guild bridge (decision #3) opens no Gateway connection
of its own — it will register its guild with the one shared connection once that
is built. Until then it exists as a bridge but neither sends nor receives, and
any outbound path fails loud rather than pretending. This pins that state so a
completing install can produce such a bridge without it crashing on start and
without it silently swallowing sends.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.models import (
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

GUILD_ID = "900"


def _shared_adapter() -> DiscordAdapter:
    return DiscordAdapter(
        config=DiscordConnectionConfig(guild_id=GUILD_ID, event_delivery="shared")
    )


async def _noop_message(_: InboundMessage) -> None: ...
async def _noop_command(_: InboundCommand) -> None: ...
async def _noop_agent(_: InboundAgentJoin) -> None: ...
async def _noop_user(_: InboundUserJoin) -> None: ...
async def _noop_app(_: InboundAppJoin) -> None: ...


async def _start(adapter: DiscordAdapter) -> None:
    await adapter.start(
        _noop_message, _noop_command, _noop_agent, _noop_user, _noop_app
    )


def test_a_shared_config_builds_an_adapter_with_no_connection() -> None:
    adapter = _shared_adapter()
    assert adapter._connection is None


def test_an_own_connection_config_still_builds_its_connection() -> None:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(guild_id=GUILD_ID, bot_token="token")
    )
    assert adapter._connection is not None


async def test_inert_start_opens_no_connection() -> None:
    """start() returns without dialling Discord and stores the callbacks for the
    moment the shared connection attaches; nothing is opened."""
    adapter = _shared_adapter()
    await _start(adapter)
    assert adapter._connection is None
    assert adapter._on_message is _noop_message


async def test_stopping_an_inert_bridge_is_safe() -> None:
    adapter = _shared_adapter()
    await _start(adapter)
    await adapter.stop()  # no connection to close


async def test_an_outbound_path_fails_loud_while_inert() -> None:
    """It does not silently no-op: reaching the client before the shared
    connection is attached is a bug, and it surfaces as one."""
    adapter = _shared_adapter()
    with pytest.raises(RuntimeError, match="shared delivery"):
        adapter._require_client()
