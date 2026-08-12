"""Install links reaching the operator dashboard, and failing visibly.

`GET /gateway/collaborations` builds each bridge's "add the app to a chat"
links from the *live* adapter, the same way it builds the home link. Both ways
that can come up empty are deliberate — a bridge that is not running has no
adapter to ask, and an adapter that raises must not take the bridge list down
with it — so both are pinned here rather than left to be discovered as a blank
dialog with nothing in the logs.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from switch_core.bridges.collaboration.models import BridgeInstallLink
from switch_core.gateway.collaborations import _install_links, _install_note

LINK = BridgeInstallLink(
    key="group",
    label="Add to a Telegram group",
    description="Pick a group and confirm.",
    url="https://t.me/acme_switch_bot?startgroup=switch",
)


class _Lifecycle:
    """Only the one method the helper reaches for."""

    def __init__(self, adapter: Any) -> None:
        self._adapter = adapter

    def get_adapter(self, bridge_id: str) -> Any:
        return self._adapter


class _Adapter:
    def __init__(
        self,
        links: list[BridgeInstallLink] | Exception,
        note: str | Exception | None = None,
    ) -> None:
        self._links = links
        self._note = note

    async def install_links(self) -> list[BridgeInstallLink]:
        if isinstance(self._links, Exception):
            raise self._links
        return self._links

    async def install_note(self) -> str | None:
        if isinstance(self._note, Exception):
            raise self._note
        return self._note


async def test_a_running_adapters_links_are_served() -> None:
    lifecycle = _Lifecycle(_Adapter([LINK]))

    links = await _install_links("bridge-1", lifecycle)  # type: ignore[arg-type]

    assert [link.url for link in links] == [LINK.url]


async def test_a_bridge_that_is_not_running_offers_none() -> None:
    # There is no adapter to ask, and a link built from stale config could
    # point at a bot the bridge no longer uses.
    lifecycle = _Lifecycle(None)

    assert await _install_links("bridge-1", lifecycle) == []  # type: ignore[arg-type]


async def test_an_adapter_that_raises_is_logged_not_swallowed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # The dashboard still lists its bridges; the reason the button is missing
    # is in the log rather than nowhere.
    lifecycle = _Lifecycle(_Adapter(RuntimeError("telegram is down")))

    with caplog.at_level(logging.WARNING):
        links = await _install_links("bridge-1", lifecycle)  # type: ignore[arg-type]

    assert links == []
    assert "bridge-1" in caplog.text


async def test_the_note_for_what_no_link_covers_is_served() -> None:
    lifecycle = _Lifecycle(_Adapter([LINK], "Channels are added by hand."))

    assert await _install_note("bridge-1", lifecycle) == (  # type: ignore[arg-type]
        "Channels are added by hand."
    )


async def test_a_bridge_that_is_not_running_has_no_note() -> None:
    lifecycle = _Lifecycle(None)

    assert await _install_note("bridge-1", lifecycle) is None  # type: ignore[arg-type]


async def test_a_note_that_raises_is_logged_not_swallowed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    lifecycle = _Lifecycle(_Adapter([LINK], RuntimeError("telegram is down")))

    with caplog.at_level(logging.WARNING):
        note = await _install_note("bridge-1", lifecycle)  # type: ignore[arg-type]

    assert note is None
    assert "bridge-1" in caplog.text
