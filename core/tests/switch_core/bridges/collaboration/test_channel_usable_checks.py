"""Each platform says why a room cannot use an existing channel: it does not
exist, or the Switch app is not in it. The reason reaches the person who typed
the id, so it is the platform's own, not a server error."""

from __future__ import annotations

import asyncio
from typing import Any

import discord
import pytest
import requests
from mattermostdriver.exceptions import NotEnoughPermissions, ResourceNotFound
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    ChannelNotUsable,
)
from tests.switch_core.bridges.collaboration.test_discord_provisioning import (
    _adapter as _discord_adapter,
)
from tests.switch_core.bridges.collaboration.test_discord_provisioning import (
    _FakeGuild,
    _wire,
)
from tests.switch_core.bridges.collaboration.test_slack_adapter import (
    _adapter as _slack_adapter,
)


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── Slack ────────────────────────────────────────────────────────────────────


class _SlackClient:
    def __init__(
        self, *, channel: dict[str, Any] | None = None, error: str = ""
    ) -> None:
        self._channel = channel or {}
        self._error = error

    async def conversations_info(self, **_: Any) -> dict[str, Any]:
        if self._error:
            raise SlackApiError("refused", {"ok": False, "error": self._error})
        return {"channel": self._channel}


def _slack(client: _SlackClient) -> Any:
    adapter = _slack_adapter()
    adapter._web_client = client  # type: ignore[assignment]
    return adapter


def test_slack_a_channel_the_app_is_in_is_usable() -> None:
    _run(_slack(_SlackClient(channel={"is_member": True})).check_channel_usable("C1"))


def test_slack_a_channel_it_cannot_find_says_so() -> None:
    adapter = _slack(_SlackClient(error="channel_not_found"))
    with pytest.raises(ChannelNotUsable, match="channel_not_found"):
        _run(adapter.check_channel_usable("C1"))


@pytest.mark.parametrize("private", [True, False])
def test_slack_a_channel_the_app_is_not_in_says_so(private: bool) -> None:
    # Public too: the app cannot join a channel or post in one it is not in,
    # so binding it would make a room that never works.
    adapter = _slack(_SlackClient(channel={"is_member": False, "is_private": private}))
    with pytest.raises(ChannelNotUsable, match="not in Slack channel C1"):
        _run(adapter.check_channel_usable("C1"))


def test_slack_a_dm_needs_no_membership_check() -> None:
    _run(
        _slack(
            _SlackClient(channel={"is_im": True, "is_member": False})
        ).check_channel_usable("D1")
    )


@pytest.mark.parametrize("reason", ["missing_scope", "ratelimited"])
def test_slack_any_other_refusal_is_slacks_carrying_its_reason(reason: str) -> None:
    # Not the caller's channel id at fault, so a platform refusal (502).
    adapter = _slack(_SlackClient(error=reason))
    with pytest.raises(BridgeOperationError, match=reason):
        _run(adapter.check_channel_usable("C1"))


# ── Mattermost ───────────────────────────────────────────────────────────────


class _MattermostChannels:
    def __init__(
        self,
        channel: dict[str, Any] | Exception,
        member: bool | Exception = True,
    ) -> None:
        self._channel = channel
        self._member = member

    def get_channel(self, channel_id: str) -> dict[str, Any]:
        if isinstance(self._channel, Exception):
            raise self._channel
        return self._channel

    def get_channel_member(self, channel_id: str, user_id: str) -> dict[str, Any]:
        if isinstance(self._member, Exception):
            raise self._member
        if not self._member:
            raise ResourceNotFound("not a member")
        return {"user_id": user_id}


class _MattermostDriver:
    def __init__(self, channels: _MattermostChannels) -> None:
        self.channels = channels


def _mattermost(channels: _MattermostChannels) -> Any:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm", admin_user="admin", admin_password="pw", team_name="team"
        )
    )
    adapter._admin_driver = _MattermostDriver(channels)  # type: ignore[assignment]
    adapter._admin_user_id = "admin-id"
    adapter._team_id = "team-1"
    return adapter


def _mm_check(channels: _MattermostChannels) -> None:
    async def go() -> None:
        adapter = _mattermost(channels)
        adapter._main_loop = asyncio.get_running_loop()
        await adapter.check_channel_usable("ch1")

    _run(go())


def test_mattermost_a_channel_in_the_team_is_usable() -> None:
    _mm_check(_MattermostChannels({"team_id": "team-1", "type": "O"}, member=False))


def test_mattermost_a_channel_it_cannot_find_says_so() -> None:
    with pytest.raises(ChannelNotUsable, match="cannot find channel ch1"):
        _mm_check(_MattermostChannels(ResourceNotFound("Unable to find the channel")))


def test_mattermost_a_channel_it_may_not_see_says_so() -> None:
    with pytest.raises(ChannelNotUsable, match="will not let"):
        _mm_check(_MattermostChannels(NotEnoughPermissions("no permission")))


def test_mattermost_any_other_failure_is_mattermosts() -> None:
    with pytest.raises(BridgeOperationError, match="would not describe channel ch1"):
        _mm_check(_MattermostChannels(requests.ConnectionError("connection reset")))


def test_mattermost_a_bug_is_not_dressed_up_as_mattermosts() -> None:
    # Only the driver's and requests' errors are the platform's; anything
    # else is ours and must surface as itself.
    with pytest.raises(KeyError):
        _mm_check(_MattermostChannels(KeyError("team_id")))


def test_mattermost_a_private_channel_it_may_not_inspect_asks_to_add_it() -> None:
    with pytest.raises(ChannelNotUsable, match="Add it to the channel"):
        _mm_check(
            _MattermostChannels(
                {"team_id": "team-1", "type": "P"},
                member=NotEnoughPermissions("no permission"),
            )
        )


def test_mattermost_a_bug_in_the_membership_lookup_propagates() -> None:
    with pytest.raises(TypeError):
        _mm_check(
            _MattermostChannels(
                {"team_id": "team-1", "type": "P"}, member=TypeError("bad call")
            )
        )


def test_mattermost_a_channel_in_another_team_is_refused() -> None:
    with pytest.raises(ChannelNotUsable, match="another team"):
        _mm_check(_MattermostChannels({"team_id": "team-2", "type": "O"}))


def test_mattermost_a_private_channel_switch_is_not_in_says_so() -> None:
    with pytest.raises(ChannelNotUsable, match="not in private channel"):
        _mm_check(_MattermostChannels({"team_id": "team-1", "type": "P"}, member=False))


# ── Discord ──────────────────────────────────────────────────────────────────


class _Permissions:
    def __init__(self, *, view: bool, send: bool, send_in_threads: bool) -> None:
        self.view_channel = view
        self.send_messages = send
        self.send_messages_in_threads = send_in_threads


class _DiscordChannel:
    def __init__(
        self,
        guild: Any,
        *,
        view: bool = True,
        send: bool = True,
        send_in_threads: bool = True,
        parent_id: int | None = None,
    ) -> None:
        self.id = 555
        self.guild = guild
        self.parent_id = parent_id
        self._permissions = _Permissions(
            view=view, send=send, send_in_threads=send_in_threads
        )

    def permissions_for(self, member: Any) -> _Permissions:
        return self._permissions


class _ForbiddenResponse:
    status = 403
    reason = "Forbidden"


class _ForbiddingClient:
    def get_channel(self, channel_id: int) -> None:
        return None

    async def fetch_channel(self, channel_id: int) -> Any:
        raise discord.Forbidden(_ForbiddenResponse(), "Missing Access")


def test_discord_a_channel_the_bot_can_post_in_is_usable() -> None:
    adapter = _discord_adapter()
    guild = _FakeGuild()
    _wire(adapter, guild, {555: _DiscordChannel(guild)})
    _run(adapter.check_channel_usable("555"))


def test_discord_a_channel_it_cannot_find_says_so() -> None:
    adapter = _discord_adapter()
    _wire(adapter, _FakeGuild(), {})
    with pytest.raises(ChannelNotUsable, match="cannot find channel 555"):
        _run(adapter.check_channel_usable("555"))


def test_discord_a_channel_it_may_not_see_says_so() -> None:
    adapter = _discord_adapter()
    adapter._connection._client = _ForbiddingClient()  # type: ignore[assignment]
    with pytest.raises(ChannelNotUsable, match="Missing Access"):
        _run(adapter.check_channel_usable("555"))


class _RateLimitedResponse:
    status = 429
    reason = "Too Many Requests"


class _RateLimitingClient:
    def get_channel(self, channel_id: int) -> None:
        return None

    async def fetch_channel(self, channel_id: int) -> Any:
        raise discord.HTTPException(
            _RateLimitedResponse(), "You are being rate limited."
        )


def test_discord_any_other_refusal_is_discords_carrying_its_reason() -> None:
    adapter = _discord_adapter()
    adapter._connection._client = _RateLimitingClient()  # type: ignore[assignment]
    with pytest.raises(BridgeOperationError, match="rate limited"):
        _run(adapter.check_channel_usable("555"))


def test_discord_asking_whose_a_missing_channel_is_says_it_is_missing() -> None:
    # Whose it is is asked before anything else, so it meets a missing channel
    # first, and has to say so rather than fail.
    adapter = _discord_adapter()
    _wire(adapter, _FakeGuild(), {})
    with pytest.raises(ChannelNotUsable, match="cannot find channel 555"):
        _run(adapter.require_bindable_channel("555"))


def test_discord_a_channel_the_bot_cannot_post_in_says_so() -> None:
    adapter = _discord_adapter()
    guild = _FakeGuild()
    _wire(adapter, guild, {555: _DiscordChannel(guild, send=False)})
    with pytest.raises(ChannelNotUsable, match="cannot read and post"):
        _run(adapter.check_channel_usable("555"))


def test_discord_an_id_that_is_not_a_number_says_so() -> None:
    adapter = _discord_adapter()
    _wire(adapter, _FakeGuild(), {})
    with pytest.raises(ChannelNotUsable, match="are numbers"):
        _run(adapter.check_channel_usable("general"))


def test_discord_a_thread_is_judged_by_posting_in_threads() -> None:
    # Thread.permissions_for gives the parent's permissions: a bot that may
    # post in threads but not in the parent can still use the thread.
    adapter = _discord_adapter()
    guild = _FakeGuild()
    thread = _DiscordChannel(guild, send=False, send_in_threads=True, parent_id=1)
    _wire(adapter, guild, {555: thread})
    _run(adapter.check_channel_usable("555"))


def test_discord_a_thread_the_bot_cannot_post_in_says_so() -> None:
    adapter = _discord_adapter()
    guild = _FakeGuild()
    thread = _DiscordChannel(guild, send=True, send_in_threads=False, parent_id=1)
    _wire(adapter, guild, {555: thread})
    with pytest.raises(ChannelNotUsable, match="cannot read and post"):
        _run(adapter.check_channel_usable("555"))


def test_discord_unknown_own_permissions_are_not_taken_as_a_pass() -> None:
    adapter = _discord_adapter()
    guild = _FakeGuild()
    guild.me = None  # type: ignore[attr-defined]
    _wire(adapter, guild, {555: _DiscordChannel(guild)})
    with pytest.raises(BridgeOperationError, match="own permissions"):
        _run(adapter.check_channel_usable("555"))
