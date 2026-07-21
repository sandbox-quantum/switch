from __future__ import annotations

import asyncio
from typing import Any

import pytest

from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)


def _config() -> TeamsConnectionConfig:
    return TeamsConnectionConfig(
        app_id="app-123",
        app_password="secret",
        tenant_id="tenant-9",
        team_id="team-7",
        public_base_url="https://switch.example",
        client_state="s3cr3t",
    )


def _adapter() -> TeamsAdapter:
    return TeamsAdapter(config=_config())


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeGraph:
    def __init__(self, *, membership_type: str = "standard") -> None:
        self.created_channels: list[dict[str, Any]] = []
        self.channel_members: list[dict[str, Any]] = []
        self.team_members: list[dict[str, Any]] = []
        self._membership_type = membership_type

    async def create_channel(
        self,
        *,
        team_id: str,
        display_name: str,
        description: str,
        membership_type: str,
    ) -> dict[str, Any]:
        self.created_channels.append(
            {
                "team_id": team_id,
                "display_name": display_name,
                "description": description,
                "membership_type": membership_type,
            }
        )
        return {"id": "19:new@thread.tacv2", "membershipType": membership_type}

    async def get_channel(self, *, team_id: str, channel_id: str) -> dict[str, Any]:
        return {"membershipType": self._membership_type}

    async def add_channel_member(
        self, *, team_id: str, channel_id: str, user_aad_id: str
    ) -> None:
        self.channel_members.append({"channel_id": channel_id, "user": user_aad_id})

    async def add_team_member(self, *, team_id: str, user_aad_id: str) -> None:
        self.team_members.append({"team_id": team_id, "user": user_aad_id})

    async def create_subscription(self, **kwargs: Any) -> dict[str, Any]:
        return {"id": "SUB-X"}


# ── create_channel ───────────────────────────────────────────────────────────


def test_create_standard_channel() -> None:
    adapter = _adapter()
    fake = _FakeGraph()
    adapter._graph = fake  # type: ignore[assignment]

    channel_id = _run(adapter.create_channel("My Room", "the topic"))

    assert channel_id == "19:new@thread.tacv2"
    assert len(fake.created_channels) == 1
    created = fake.created_channels[0]
    assert created["team_id"] == "team-7"
    assert created["membership_type"] == "standard"
    # Type + team are recorded so outbound + subscription know how to reach it.
    assert adapter._channel_type["19:new@thread.tacv2"] == "channel_public"
    assert adapter._team_of_channel["19:new@thread.tacv2"] == "team-7"


def test_create_private_channel_uses_private_membership() -> None:
    adapter = _adapter()
    fake = _FakeGraph()
    adapter._graph = fake  # type: ignore[assignment]

    _run(adapter.create_channel("Secret", "x", channel_type="channel_private"))

    assert fake.created_channels[0]["membership_type"] == "private"


def test_create_channel_rejects_group_and_direct() -> None:
    adapter = _adapter()
    adapter._graph = _FakeGraph()  # type: ignore[assignment]

    for bad in ("group", "direct"):
        try:
            _run(adapter.create_channel("x", "y", channel_type=bad))  # type: ignore[arg-type]
            raised = False
        except ValueError:
            raised = True
        assert raised, bad


def test_channel_name_is_sanitized() -> None:
    assert TeamsAdapter._sanitize_channel_name("bug/fix #42: urgent!") == (
        "bug-fix -42- urgent!"
    )
    assert TeamsAdapter._sanitize_channel_name("  ...  ") == "switch"
    assert len(TeamsAdapter._sanitize_channel_name("x" * 80)) == 50


# ── get_channel_type ─────────────────────────────────────────────────────────


def test_get_channel_type_uses_cache() -> None:
    adapter = _adapter()
    adapter._channel_type["19:c@thread.tacv2"] = "channel_private"
    # No Graph client needed — the learned type wins.
    assert _run(adapter.get_channel_type("19:c@thread.tacv2")) == "channel_private"


def test_get_channel_type_falls_back_to_graph() -> None:
    adapter = _adapter()
    adapter._graph = _FakeGraph(membership_type="private")  # type: ignore[assignment]

    resolved = _run(adapter.get_channel_type("19:unknown@thread.tacv2"))

    assert resolved == "channel_private"
    # And it is cached for next time.
    assert adapter._channel_type["19:unknown@thread.tacv2"] == "channel_private"


# ── deeplink ─────────────────────────────────────────────────────────────────


def test_channel_deeplink_is_built_from_ids() -> None:
    adapter = _adapter()
    adapter._team_of_channel["19:c@thread.tacv2"] = "team-7"

    link = _run(adapter.channel_deeplink("19:c@thread.tacv2"))

    assert link is not None
    assert "teams.microsoft.com/l/channel/" in link
    # The channel id is URL-encoded, and team + tenant are query params.
    assert "19%3Ac%40thread.tacv2" in link
    assert "groupId=team-7" in link
    assert "tenantId=tenant-9" in link


# ── add_users_to_channel ─────────────────────────────────────────────────────


def test_add_users_private_channel_adds_channel_members() -> None:
    adapter = _adapter()
    fake = _FakeGraph()
    adapter._graph = fake  # type: ignore[assignment]
    adapter._channel_type["19:c@thread.tacv2"] = "channel_private"

    _run(adapter.add_users_to_channel("19:c@thread.tacv2", ["alice"], ["aad-a"]))

    assert fake.channel_members == [
        {"channel_id": "19:c@thread.tacv2", "user": "aad-a"}
    ]
    assert fake.team_members == []


def test_add_users_standard_channel_adds_team_members() -> None:
    adapter = _adapter()
    fake = _FakeGraph()
    adapter._graph = fake  # type: ignore[assignment]
    adapter._channel_type["19:c@thread.tacv2"] = "channel_public"

    _run(adapter.add_users_to_channel("19:c@thread.tacv2", ["bob"], ["aad-b"]))

    assert fake.team_members == [{"team_id": "team-7", "user": "aad-b"}]
    assert fake.channel_members == []


class _FailingGraph(_FakeGraph):
    async def add_team_member(self, *, team_id: str, user_aad_id: str) -> None:
        if user_aad_id == "aad-bad":
            raise RuntimeError("Graph rejected the member add")
        await super().add_team_member(team_id=team_id, user_aad_id=user_aad_id)


def test_add_users_raises_on_partial_failure() -> None:
    # A user that fails to add must surface as an error — the caller cannot be
    # told the add succeeded when it did not (fail-loud). The good user is still
    # added; the failure is reported afterwards.
    adapter = _adapter()
    fake = _FailingGraph()
    adapter._graph = fake  # type: ignore[assignment]
    adapter._channel_type["19:c@thread.tacv2"] = "channel_public"

    with pytest.raises(RuntimeError, match="aad-bad"):
        _run(
            adapter.add_users_to_channel(
                "19:c@thread.tacv2",
                ["good", "bad"],
                ["aad-good", "aad-bad"],
            )
        )

    # The user that could be added was still added before the error surfaced.
    assert fake.team_members == [{"team_id": "team-7", "user": "aad-good"}]
