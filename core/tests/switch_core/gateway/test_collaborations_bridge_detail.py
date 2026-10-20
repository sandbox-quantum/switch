"""Reading a bridge's attention note from its live adapter.

`_attention` is asked for every bridge listed on the connections page; one
adapter whose `attention()` raises must not take the whole list down with it —
it is worth a warning in the log and a connection whose attention is simply
unknown, same as a stopped bridge's.
"""

from __future__ import annotations

import logging

import pytest

from switch_core.gateway.collaborations import _attention


class _RaisingAdapter:
    async def attention(self) -> str | None:
        raise RuntimeError("Microsoft is unreachable")


class _Lifecycle:
    def __init__(self, adapter: object | None) -> None:
        self._adapter = adapter

    def get_adapter(self, bridge_id: str) -> object | None:
        return self._adapter


async def test_a_raising_adapter_is_logged_and_reported_as_unknown(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING):
        note = await _attention("bridge-1", _Lifecycle(_RaisingAdapter()))  # type: ignore[arg-type]

    assert note is None
    assert any(
        "Failed to read the attention note for bridge bridge-1" in r.message
        for r in caplog.records
    )


async def test_a_stopped_bridge_has_no_attention_note() -> None:
    assert await _attention("bridge-1", _Lifecycle(None)) is None  # type: ignore[arg-type]
