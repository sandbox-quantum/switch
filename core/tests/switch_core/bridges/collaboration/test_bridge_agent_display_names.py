"""An agent's display name reaches the collaboration bridges — and nothing else.

`agents.name` is the identifier every lookup runs on: echo suppression, the
icon resolver, the runtime-indicator dictionaries. `agents.display_name` is
only ever a label. These pin both halves of that: the label reaching the places
a person reads, and the identifier still reaching the places the code matches
on.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import discord
import pytest

from switch_core.agent_icon import default_icon_url
from switch_core.bridges.collaboration.adapter import (
    AgentPresentation,
    CollaborationAdapter,
)
from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.slack.avatar import SLACK_SURFACE
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)

GUILD_ID = 900
CHANNEL_ID = 100
DM_CHANNEL_ID = 555
BOT_USER_ID = 42
WEBHOOK_ID = 77
SLACK_CHANNEL = "C123"
SLACK_BOT_ID = "B999"
TEAMS_CHAT = "a:1chat"
TELEGRAM_CHAT = "-1001234567890"

# A DiceBear URL with no background of its own — the only shape Slack's avatar
# recolour can act on.
_DICEBEAR = "https://api.dicebear.com/9.x/bottts/png?seed=worker&size=256"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── Bridge core plumbing ─────────────────────────────────────────────────────


class _Session:
    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


class _AgentStore:
    def __init__(self, agents: dict[str, SimpleNamespace]) -> None:
        self._agents = agents
        self.lookups: list[str] = []

    async def get_by_name(self, session: Any, name: str) -> SimpleNamespace | None:
        self.lookups.append(name)
        return self._agents.get(name)


def _agent(
    name: str, display_name: str | None, icon_url: str | None = None
) -> SimpleNamespace:
    return SimpleNamespace(name=name, display_name=display_name, icon_url=icon_url)


def _bridge(*agents: SimpleNamespace) -> BridgeCore:
    """A BridgeCore with only the two collaborators the resolver and the echo
    check touch — the rest of `__init__` needs a live Matrix stack."""
    bridge = BridgeCore.__new__(BridgeCore)
    bridge._agent_store = _AgentStore({a.name: a for a in agents})  # type: ignore[assignment]
    bridge._session_factory = _Session  # type: ignore[assignment]
    return bridge


class _BareAdapter(CollaborationAdapter):
    """Concrete only so it can be instantiated: the label plumbing under test
    lives on the base class and no platform method is called."""

    async def start(self, *a: Any, **k: Any) -> Any: ...
    async def stop(self, *a: Any, **k: Any) -> Any: ...
    async def send_message(self, *a: Any, **k: Any) -> Any: ...
    async def send_typing(self, *a: Any, **k: Any) -> Any: ...
    async def update_message(self, *a: Any, **k: Any) -> Any: ...
    async def delete_message(self, *a: Any, **k: Any) -> Any: ...
    async def create_channel(self, *a: Any, **k: Any) -> Any: ...
    async def get_channel_type(self, *a: Any, **k: Any) -> Any: ...
    async def get_channel_agent_names(self, *a: Any, **k: Any) -> Any: ...
    async def add_agents_to_channel(self, *a: Any, **k: Any) -> Any: ...
    async def add_users_to_channel(self, *a: Any, **k: Any) -> Any: ...
    async def create_agent_identity(self, *a: Any, **k: Any) -> Any: ...
    async def remove_agent_identity(self, *a: Any, **k: Any) -> Any: ...
    def translate_inbound(self, *a: Any, **k: Any) -> Any: ...
    def translate_outbound(self, *a: Any, **k: Any) -> Any: ...


class TestBridgeCoreResolver:
    async def test_returns_the_agents_display_name(self) -> None:
        bridge = _bridge(_agent("worker", "Worker Bee"))
        found = await bridge._agent_presentation("worker")
        assert found is not None
        assert found.display_name == "Worker Bee"

    async def test_returns_none_when_the_agent_has_no_display_name(self) -> None:
        bridge = _bridge(_agent("worker", None))
        found = await bridge._agent_presentation("worker")
        assert found is not None
        assert found.display_name is None

    async def test_returns_none_for_a_name_that_is_not_an_agent(self) -> None:
        """Bridges render aliases and third-party bots too. An unknown name is
        not an error — the caller only wants to know whether to override."""
        bridge = _bridge()
        assert await bridge._agent_presentation("some-slack-bot") is None

    async def test_the_label_and_the_icon_come_off_a_single_lookup(self) -> None:
        """They live on the same row, and a send needs both — resolving them
        separately was two round trips per message."""
        bridge = _bridge(_agent("worker", "Worker Bee", _DICEBEAR))

        assert await bridge._agent_presentation("worker") == AgentPresentation(
            display_name="Worker Bee", icon_url=_DICEBEAR
        )
        assert bridge._agent_store.lookups == ["worker"]  # type: ignore[attr-defined]


class TestAdapterLabelSelection:
    async def test_falls_back_to_the_identifier_with_no_resolver(self) -> None:
        adapter = _BareAdapter()
        assert (await adapter.agent_rendering("worker")).field_label == "worker"
        assert await adapter.agent_label_for_body("worker") == "worker"

    async def test_an_end_to_end_override_through_the_bridge_resolver(self) -> None:
        """The two halves wired together, which is the thing that has to work
        and which neither half proves on its own."""
        bridge = _bridge(_agent("worker", "Worker Bee"), _agent("plain", None))
        adapter = _BareAdapter()
        adapter.set_agent_presentation_resolver(bridge._agent_presentation)

        assert (await adapter.agent_rendering("worker")).field_label == "Worker Bee"
        assert (await adapter.agent_rendering("plain")).field_label == "plain"

    async def test_the_body_accessor_runs_the_platform_escape(self) -> None:
        class _Escaping(_BareAdapter):
            def escape_label_for_body(self, label: str) -> str:
                return f"<{label}>"

        adapter = _Escaping()
        bridge = _bridge(_agent("worker", "Worker Bee"))
        adapter.set_agent_presentation_resolver(bridge._agent_presentation)

        assert await adapter.agent_label_for_body("worker") == "<Worker Bee>"
        assert (await adapter.agent_rendering("worker")).field_label == "Worker Bee"

    async def test_the_default_escape_leaves_a_label_alone(self) -> None:
        """A platform whose bodies are plain text needs no escape, so the base
        hook must not invent one."""
        assert _BareAdapter().escape_label_for_body("a*b<c>&d") == "a*b<c>&d"

    async def test_a_label_is_resolved_per_call(self) -> None:
        """Uncached, like the icon: a renamed agent reads correctly on its next
        message rather than at the next restart."""
        names = iter(["First", "Second"])
        adapter = _BareAdapter()

        async def resolver(name: str) -> AgentPresentation | None:
            return AgentPresentation(display_name=next(names), icon_url=None)

        adapter.set_agent_presentation_resolver(resolver)
        assert (await adapter.agent_rendering("worker")).field_label == "First"
        assert (await adapter.agent_rendering("worker")).field_label == "Second"

    async def test_the_paired_accessor_keeps_the_body_label_separate(self) -> None:
        """The one property the two accessors exist to hold: a caller building
        message text cannot reach an unescaped label without saying so."""

        class _Escaping(_BareAdapter):
            def escape_label_for_body(self, label: str) -> str:
                return f"<{label}>"

        adapter = _Escaping()
        bridge = _bridge(_agent("worker", "Worker Bee"))
        adapter.set_agent_presentation_resolver(bridge._agent_presentation)

        rendering = await adapter.agent_rendering("worker")
        assert rendering.field_label == "Worker Bee"
        assert rendering.body_label == "<Worker Bee>"

    async def test_the_paired_accessor_resolves_the_icon_too(self) -> None:
        adapter = _BareAdapter()
        bridge = _bridge(_agent("worker", "Worker Bee", _DICEBEAR))
        adapter.set_agent_presentation_resolver(bridge._agent_presentation)

        assert (await adapter.agent_rendering("worker")).icon_url == _DICEBEAR

    async def test_a_name_that_is_no_agent_renders_as_itself(self) -> None:
        """A resolver answering None must leave the adapter exactly where it
        would be with no resolver at all."""
        adapter = _BareAdapter()
        bridge = _bridge()
        adapter.set_agent_presentation_resolver(bridge._agent_presentation)

        rendering = await adapter.agent_rendering("some-slack-bot")
        assert rendering.field_label == "some-slack-bot"
        assert rendering.icon_url == default_icon_url("some-slack-bot")

    async def test_mattermost_still_pins_the_format_of_its_default_icon(self) -> None:
        """`default_agent_icon` is consulted through `self`, so the platform
        that uploads the bytes rather than passing a link on keeps the response
        format it can accept."""
        adapter = MattermostAdapter.__new__(MattermostAdapter)
        CollaborationAdapter.__init__(adapter)

        assert await adapter.agent_icon_url("worker") == default_icon_url(
            "worker", image_format="png"
        )


def test_the_resolver_is_installed_before_the_adapter_starts() -> None:
    """Every other test here installs the resolver by hand, so without this the
    one line that wires the two halves together in production could be deleted
    and the whole suite would still pass — while every agent silently rendered
    under its identifier."""
    installed: list[Any] = []
    started: list[str] = []

    class _Adapter:
        def set_channel_migration_handler(self, handler: Any) -> None:
            return None

        def set_agent_presentation_resolver(self, resolver: Any) -> None:
            installed.append(resolver)

        async def start(self, **kwargs: Any) -> None:
            started.append("started")
            assert installed, "the resolver must be installed before start()"

    bridge = _bridge(_agent("worker", "Worker Bee"))
    bridge._adapter = _Adapter()  # type: ignore[assignment]
    bridge._identity_task = None

    async def _noop() -> None:
        return None

    bridge._load_channel_map = _noop  # type: ignore[assignment,method-assign]
    bridge._load_existing_puppets = _noop  # type: ignore[assignment,method-assign]
    bridge._ensure_channel_captures = _noop  # type: ignore[assignment,method-assign]
    bridge._create_agent_identities = _noop  # type: ignore[assignment,method-assign]

    asyncio.run(BridgeCore.start(bridge))

    assert started == ["started"]
    assert installed == [bridge._agent_presentation]


# ── Slack ────────────────────────────────────────────────────────────────────


class _FakeSlackClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.uploads: list[dict[str, Any]] = []
        self.deletes: list[dict[str, Any]] = []
        self.streams: list[dict[str, Any]] = []
        self.appends: list[dict[str, Any]] = []

    async def chat_postMessage(self, **kwargs: Any) -> dict[str, str]:
        self.calls.append(kwargs)
        return {"ts": f"10{len(self.calls)}.0"}

    async def chat_delete(self, **kwargs: Any) -> dict[str, bool]:
        self.deletes.append(kwargs)
        return {"ok": True}

    async def files_upload_v2(self, **kwargs: Any) -> dict[str, Any]:
        self.uploads.append(kwargs)
        return {"files": []}

    async def chat_startStream(self, **kwargs: Any) -> dict[str, str]:
        self.streams.append(kwargs)
        return {"ts": "301.0"}

    async def chat_appendStream(self, **kwargs: Any) -> dict[str, str]:
        self.appends.append(kwargs)
        return {"ts": "301.0"}


def _slack_adapter(bridge: BridgeCore | None) -> tuple[SlackAdapter, _FakeSlackClient]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    client = _FakeSlackClient()
    adapter._web_client = client  # type: ignore[assignment]
    adapter._bot_user_id = "U1"
    adapter._bot_id = SLACK_BOT_ID
    adapter._channel_name_cache[SLACK_CHANNEL] = "general"
    if bridge is not None:
        adapter.set_agent_presentation_resolver(bridge._agent_presentation)
    return adapter, client


def test_slack_posts_under_the_display_name() -> None:
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, client = _slack_adapter(bridge)

    _run(adapter.send_message(SLACK_CHANNEL, "worker", "hello"))

    assert client.calls[0]["username"] == "Worker Bee"


def test_slack_posts_under_the_identifier_without_a_display_name() -> None:
    bridge = _bridge(_agent("worker", None))
    adapter, client = _slack_adapter(bridge)

    _run(adapter.send_message(SLACK_CHANNEL, "worker", "hello"))

    assert client.calls[0]["username"] == "worker"


def test_slack_thinking_indicator_uses_the_display_name() -> None:
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, client = _slack_adapter(bridge)

    _run(adapter.send_typing(SLACK_CHANNEL, "worker", True))

    assert client.calls[0]["username"] == "Worker Bee"
    # The indicator is keyed on the identifier, or clearing it would miss.
    assert (SLACK_CHANNEL, "worker") in adapter._thinking_ts


def test_slack_attachment_comment_uses_the_display_name() -> None:
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, client = _slack_adapter(bridge)

    _run(adapter.send_attachment(SLACK_CHANNEL, "worker", "cat.png", "image/png", b"x"))

    assert client.uploads[0]["initial_comment"] == "*Worker Bee* sent `cat.png`"


def test_slack_escapes_the_markup_characters_it_reserves() -> None:
    """`<!channel>` in a label would otherwise be a room-wide ping typed into a
    name field."""
    bridge = _bridge(_agent("worker", "<!channel> & co"))
    adapter, client = _slack_adapter(bridge)

    _run(adapter.send_attachment(SLACK_CHANNEL, "worker", "cat.png", "image/png", b"x"))

    comment = client.uploads[0]["initial_comment"]
    assert "<!channel>" not in comment
    assert comment == "*&lt;!channel&gt; &amp; co* sent `cat.png`"


def test_slack_leaves_the_username_field_unescaped() -> None:
    """`username` is a JSON field Slack renders verbatim, so escaping it would
    show the entities to the reader."""
    bridge = _bridge(_agent("worker", "Ops & Co"))
    adapter, client = _slack_adapter(bridge)

    _run(adapter.send_message(SLACK_CHANNEL, "worker", "hello"))

    assert client.calls[0]["username"] == "Ops & Co"


def test_slack_session_card_opens_under_the_display_name() -> None:
    """The streamed session card names the agent too, and is the one Slack
    surface that goes through neither `send_message` nor `send_typing`."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, client = _slack_adapter(bridge)
    adapter._team_id = "T123"
    adapter._thread_requester[(SLACK_CHANNEL, "500.0")] = "U-asker"

    _run(
        adapter._drive_stream(
            SLACK_CHANNEL,
            "500.0",
            "worker",
            working=True,
            detail="Editing foo.py",
            deeplink_url=None,
        )
    )

    assert client.streams[0]["username"] == "Worker Bee"


def test_slack_session_card_opens_under_the_identifier_without_one() -> None:
    bridge = _bridge(_agent("worker", None))
    adapter, client = _slack_adapter(bridge)
    adapter._team_id = "T123"
    adapter._thread_requester[(SLACK_CHANNEL, "500.0")] = "U-asker"

    _run(
        adapter._drive_stream(
            SLACK_CHANNEL,
            "500.0",
            "worker",
            working=True,
            detail="Editing foo.py",
            deeplink_url=None,
        )
    )

    assert client.streams[0]["username"] == "worker"


def test_slack_still_draws_an_agent_icon_on_its_own_background() -> None:
    """Slack flattens a transparent avatar onto white, so it alone recolours the
    URL. The adjustment hangs off the shared lookup, which is exactly the sort
    of thing a refactor of that lookup drops silently."""
    bridge = _bridge(_agent("worker", "Worker Bee", _DICEBEAR))
    adapter, client = _slack_adapter(bridge)

    _run(adapter.send_message(SLACK_CHANNEL, "worker", "hello"))

    assert f"backgroundColor={SLACK_SURFACE}" in client.calls[0]["icon_url"]


def test_slack_resolves_an_agent_once_per_send() -> None:
    """One post needs the label and the icon; they come off one row, so it must
    be one query. Two accessors awaited back to back made it two."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, _client = _slack_adapter(bridge)

    _run(adapter.send_message(SLACK_CHANNEL, "worker", "hello"))

    assert bridge._agent_store.lookups == ["worker"]  # type: ignore[attr-defined]


def test_slack_awaiting_input_ping_uses_the_display_name_in_both_header_and_body() -> (
    None
):
    """The awaiting-input ping posts with the display label as username AND
    inlines it into the body — the identifier must not leak into the prose."""
    bridge = _bridge(_agent("switchdev", "Switch Dev"))
    adapter, client = _slack_adapter(bridge)

    _run(
        adapter._apply_runtime_state(
            SLACK_CHANNEL,
            "switchdev",
            "awaiting-input",
            mention_handle="U123",
            thread_root_id=None,
            deeplink_url=None,
        )
    )

    assert client.calls[-1]["username"] == "Switch Dev"
    body = client.calls[-1]["text"]
    assert "Switch Dev" in body
    assert "switchdev" not in body


def test_slack_does_not_reimport_its_own_post_made_under_a_display_name() -> None:
    """The echo test that matters: the real send, the real inbound handler, and
    the bridge core's real `_handle_inbound_message` behind it."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, client = _slack_adapter(bridge)

    routed: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        routed.append(msg)
        await bridge._handle_inbound_message(msg)

    adapter._on_message = on_message

    _run(adapter.send_message(SLACK_CHANNEL, "worker", "hello"))
    posted = client.calls[0]

    echo = {
        "bot_id": SLACK_BOT_ID,
        "subtype": "bot_message",
        "channel": SLACK_CHANNEL,
        "channel_type": "channel",
        "ts": "101.0",
        "text": posted["text"],
        "username": posted["username"],
    }
    _run(adapter._handle_message_event(echo))

    assert routed == []


def test_slack_still_bridges_a_foreign_app_posting_under_the_same_label() -> None:
    """Proves the echo above is dropped on the bridge's own bot id and not by
    accident on the name — otherwise a display name would silently start
    swallowing third-party posts."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, _client = _slack_adapter(bridge)

    routed: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        routed.append(msg)

    adapter._on_message = on_message

    _run(
        adapter._handle_message_event(
            {
                "bot_id": "B-other",
                "subtype": "bot_message",
                "channel": SLACK_CHANNEL,
                "channel_type": "channel",
                "ts": "202.0",
                "text": "hello",
                "username": "Worker Bee",
            }
        )
    )

    assert [m.sender_name for m in routed] == ["Worker Bee"]


async def test_the_bridge_echo_check_still_matches_on_the_identifier() -> None:
    """A display name must not move the name `_is_registered_agent` looks up.

    The bridge is built without `_channel_to_room`, so anything that got past
    the echo check would raise rather than quietly pass.
    """
    bridge = _bridge(_agent("worker", "Worker Bee"))

    await bridge._handle_inbound_message(
        InboundMessage(
            channel_id=SLACK_CHANNEL,
            channel_type="channel_public",
            sender_id="B1",
            sender_name="worker",
            content="hello",
            message_ref=f"{SLACK_CHANNEL}:1",
            root_id=None,
            channel_name="general",
        )
    )

    assert bridge._agent_store.lookups == ["worker"]  # type: ignore[attr-defined]


async def test_the_bridge_echo_check_does_not_match_on_the_display_name() -> None:
    """The other side of the invariant, stated so it cannot drift: the label is
    not an identity. Anything that routes an agent by the name a platform
    reports has to be handed the identifier.
    """
    bridge = _bridge(_agent("worker", "Worker Bee"))

    assert await bridge._is_registered_agent("worker") is True
    assert await bridge._is_registered_agent("Worker Bee") is False


def test_a_slack_display_name_cannot_forge_a_usergroup_mention() -> None:
    """Escaping `&<>` stops a label writing Slack's own markup, but
    `_translate_mentions_to_slack` runs over the finished body and turns a
    plain `@opsbot` in the label into a real usergroup ping."""
    bridge = _bridge(_agent("switchdev", "@opsbot"), _agent("opsbot", None))
    adapter, client = _slack_adapter(bridge)
    adapter._remember_agent_group("S999", "opsbot")

    _run(
        adapter._apply_runtime_state(
            SLACK_CHANNEL,
            "switchdev",
            "awaiting-input",
            mention_handle="U123",
            thread_root_id=None,
            deeplink_url=None,
        )
    )

    text = client.calls[-1]["text"]
    assert "<!subteam^S999>" not in text
    assert "@\u200bopsbot" in text


# ── Discord ──────────────────────────────────────────────────────────────────


class _FakeResponse:
    def __init__(self, status: int = 404) -> None:
        self.status = status
        self.reason = "Bad Request" if status == 400 else "Not Found"


class _FakeGuild:
    def __init__(self) -> None:
        self.id = GUILD_ID


class _FakeMessage:
    def __init__(self, channel: Any, message_id: int) -> None:
        self.id = message_id
        self.channel = channel


class _FakeWebhook:
    def __init__(self) -> None:
        self.id = WEBHOOK_ID
        self.name = "Switch Bridge"
        self.token = "tok"
        self.sent: list[dict[str, Any]] = []
        self.uploaded: list[bytes] = []
        self.reject_usernames: set[str] = set()

    async def send(self, **kwargs: Any) -> Any:
        file = kwargs.get("file")
        if file is not None:
            # The real client streams the attachment out, so an attempt — even
            # a refused one — leaves the buffer at its end. What each attempt
            # would actually have uploaded is recorded here.
            self.uploaded.append(file.fp.read())
        self.sent.append(kwargs)
        if kwargs.get("username") in self.reject_usernames:
            raise discord.HTTPException(_FakeResponse(400), "Invalid Form Body")
        return _FakeMessage(_FakeChannel(), 900 + len(self.sent))


class _FakeChannel:
    def __init__(self, channel_id: int = CHANNEL_ID, *, dm: bool = False) -> None:
        self.id = channel_id
        self.guild = None if dm else _FakeGuild()
        self.name = None if dm else "general"
        self.sent: list[dict[str, Any]] = []
        self.webhook = _FakeWebhook()

    async def send(self, content: str, **kwargs: Any) -> Any:
        self.sent.append({"content": content, **kwargs})
        return _FakeMessage(self, 500 + len(self.sent))

    async def webhooks(self) -> list[Any]:
        return [self.webhook]


class _FakeDiscordClient:
    def __init__(self, channels: dict[int, Any]) -> None:
        self._channels = channels

    def get_channel(self, channel_id: int) -> Any | None:
        return self._channels.get(channel_id)


class _Author:
    def __init__(self, user_id: int, name: str) -> None:
        self.id = user_id
        self.name = name


def _gateway_message(
    *,
    channel: Any,
    content: str,
    author: _Author,
    webhook_id: int | None = None,
    message_id: int = 1000,
) -> Any:
    return SimpleNamespace(
        id=message_id,
        channel=channel,
        guild=channel.guild,
        author=author,
        content=content,
        webhook_id=webhook_id,
        type=discord.MessageType.default,
        attachments=[],
    )


def _discord_adapter(
    bridge: BridgeCore | None,
) -> tuple[DiscordAdapter, _FakeChannel, _FakeChannel]:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )
    adapter._bot_user_id = BOT_USER_ID
    channel = _FakeChannel()
    dm = _FakeChannel(DM_CHANNEL_ID, dm=True)
    adapter._client = _FakeDiscordClient({CHANNEL_ID: channel, DM_CHANNEL_ID: dm})  # type: ignore[assignment]
    if bridge is not None:
        adapter.set_agent_presentation_resolver(bridge._agent_presentation)
    return adapter, channel, dm


def test_discord_guild_webhook_posts_under_the_display_name() -> None:
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, channel, _dm = _discord_adapter(bridge)

    _run(adapter.send_message(str(CHANNEL_ID), "worker", "hello"))

    assert channel.webhook.sent[0]["username"] == "Worker Bee"


def test_discord_guild_webhook_posts_under_the_identifier_without_one() -> None:
    bridge = _bridge(_agent("worker", None))
    adapter, channel, _dm = _discord_adapter(bridge)

    _run(adapter.send_message(str(CHANNEL_ID), "worker", "hello"))

    assert channel.webhook.sent[0]["username"] == "worker"


def test_discord_dm_prefix_uses_the_display_name() -> None:
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, _channel, dm = _discord_adapter(bridge)

    _run(adapter.send_message(str(DM_CHANNEL_ID), "worker", "hello"))

    assert dm.sent[0]["content"] == "**Worker Bee**: hello"


def test_discord_dm_prefix_uses_the_identifier_without_one() -> None:
    bridge = _bridge(_agent("worker", None))
    adapter, _channel, dm = _discord_adapter(bridge)

    _run(adapter.send_message(str(DM_CHANNEL_ID), "worker", "hello"))

    assert dm.sent[0]["content"] == "**worker**: hello"


def test_discord_dm_attachment_prefix_uses_the_display_name() -> None:
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, _channel, dm = _discord_adapter(bridge)

    _run(
        adapter.send_attachment(
            str(DM_CHANNEL_ID), "worker", "cat.png", "image/png", b"x"
        )
    )

    assert dm.sent[0]["content"] == "**Worker Bee**"


def test_discord_dm_attachment_does_not_let_a_display_name_ping_the_channel() -> None:
    """The attachment branch builds its own body and passes its own send
    options, so it has to close the same hole `send_message` does rather than
    inherit the fix."""
    bridge = _bridge(_agent("worker", "@everyone"))
    adapter, _channel, dm = _discord_adapter(bridge)

    _run(
        adapter.send_attachment(
            str(DM_CHANNEL_ID), "worker", "cat.png", "image/png", b"x"
        )
    )

    sent = dm.sent[0]
    assert sent["content"] == "**@\u200beveryone**"
    assert sent["allowed_mentions"].everyone is False


def test_discord_dm_attachment_escapes_markdown_in_a_display_name() -> None:
    bridge = _bridge(_agent("worker", "Bo*b"))
    adapter, _channel, dm = _discord_adapter(bridge)

    _run(
        adapter.send_attachment(
            str(DM_CHANNEL_ID), "worker", "cat.png", "image/png", b"x"
        )
    )

    assert dm.sent[0]["content"] == r"**Bo\*b**"


def test_discord_guild_attachment_posts_under_the_display_name() -> None:
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, channel, _dm = _discord_adapter(bridge)

    _run(
        adapter.send_attachment(str(CHANNEL_ID), "worker", "cat.png", "image/png", b"x")
    )

    assert channel.webhook.sent[0]["username"] == "Worker Bee"


def test_discord_guild_attachment_posts_under_the_identifier_without_one() -> None:
    bridge = _bridge(_agent("worker", None))
    adapter, channel, _dm = _discord_adapter(bridge)

    _run(
        adapter.send_attachment(str(CHANNEL_ID), "worker", "cat.png", "image/png", b"x")
    )

    assert channel.webhook.sent[0]["username"] == "worker"


def test_a_refused_attachment_username_is_retried_with_a_fresh_file() -> None:
    """The reason the attachment payload is rebuilt per attempt: the first
    attempt reads the stream, so a retry that reused the same `discord.File`
    would upload an empty file under the right name."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, channel, _dm = _discord_adapter(bridge)
    channel.webhook.reject_usernames = {"Worker Bee"}

    _run(
        adapter.send_attachment(
            str(CHANNEL_ID), "worker", "cat.png", "image/png", b"cat-bytes"
        )
    )

    attempts = channel.webhook.sent
    assert [call["username"] for call in attempts] == ["Worker Bee", "worker"]
    first, second = attempts[0]["file"], attempts[1]["file"]
    assert isinstance(first, discord.File) and isinstance(second, discord.File)
    assert first is not second
    # The retry carried the whole file, not the empty tail of the first one.
    assert channel.webhook.uploaded == [b"cat-bytes", b"cat-bytes"]


def test_discord_dm_prefix_escapes_markdown_in_a_display_name() -> None:
    """`**Bo*b**: hi` renders as broken bold. The label is body text, so it is
    escaped; the identifier the send was made for is untouched."""
    bridge = _bridge(_agent("worker", "Bo*b _the_ ~builder~"))
    adapter, _channel, dm = _discord_adapter(bridge)

    _run(adapter.send_message(str(DM_CHANNEL_ID), "worker", "hello"))

    assert dm.sent[0]["content"] == r"**Bo\*b \_the\_ \~builder\~**: hello"


def test_discord_dm_does_not_let_a_display_name_ping_the_channel() -> None:
    """`@everyone` in a name is an abuse vector, not a cosmetic bug. Discord
    decides who a message pings from the raw content, so the text is defused
    AND the send withholds the permission."""
    bridge = _bridge(_agent("worker", "@everyone"))
    adapter, _channel, dm = _discord_adapter(bridge)

    _run(adapter.send_message(str(DM_CHANNEL_ID), "worker", "hello"))

    sent = dm.sent[0]
    assert "@everyone" not in sent["content"]
    assert sent["content"] == "**@\u200beveryone**: hello"
    assert sent["allowed_mentions"].everyone is False


def test_discord_dm_still_delivers_a_mention_the_agent_wrote() -> None:
    """Only the mass mentions are withheld — muting everything would silently
    break an agent that meant to tag someone."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, _channel, dm = _discord_adapter(bridge)

    _run(adapter.send_message(str(DM_CHANNEL_ID), "worker", "ping <@12345>"))

    mentions = dm.sent[0]["allowed_mentions"]
    assert mentions.everyone is False
    assert mentions.users is not False


def test_discord_leaves_the_webhook_username_unescaped() -> None:
    """The webhook `username` is a JSON field rendered verbatim — the escaping
    that the DM body needs would show as backslashes here."""
    bridge = _bridge(_agent("worker", "Bo*b"))
    adapter, channel, _dm = _discord_adapter(bridge)

    _run(adapter.send_message(str(CHANNEL_ID), "worker", "hello"))

    assert channel.webhook.sent[0]["username"] == "Bo*b"


def test_a_username_discord_refuses_falls_back_to_the_identifier() -> None:
    """Discord validates a webhook username server-side and answers a name it
    dislikes with a 400. Without the retry every chunk — and the truncation
    notice — would be refused the same way and the message would be lost."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, channel, _dm = _discord_adapter(bridge)
    channel.webhook.reject_usernames = {"Worker Bee"}

    ref = _run(adapter.send_message(str(CHANNEL_ID), "worker", "hello"))

    assert [call["username"] for call in channel.webhook.sent] == [
        "Worker Bee",
        "worker",
    ]
    assert [call["content"] for call in channel.webhook.sent] == ["hello", "hello"]
    assert ref is not None


def test_a_refused_username_is_decided_once_for_the_whole_send(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The retry lives inside the per-chunk callback, so a long message once
    re-offered the same rejected name for every part — doubling the requests
    and logging the substitution over and over. The refusal is latched for the
    rest of the send instead."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, channel, _dm = _discord_adapter(bridge)
    channel.webhook.reject_usernames = {"Worker Bee"}

    with caplog.at_level("WARNING"):
        _run(adapter.send_message(str(CHANNEL_ID), "worker", "x" * 5000))

    assert [call["username"] for call in channel.webhook.sent] == [
        "Worker Bee",
        "worker",
        "worker",
        "worker",
    ]
    refusals = [
        r for r in caplog.records if "refused the display name" in r.getMessage()
    ]
    assert len(refusals) == 1


def test_discord_resolves_an_agent_once_per_send() -> None:
    """One webhook post needs the label and the avatar; they come off one row,
    so it must be one query."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, _channel, _dm = _discord_adapter(bridge)

    _run(adapter.send_message(str(CHANNEL_ID), "worker", "hello"))

    assert bridge._agent_store.lookups == ["worker"]  # type: ignore[attr-defined]


def test_a_400_is_not_retried_when_there_is_no_display_name() -> None:
    """Retrying under the same name would just double a failure that is about
    something other than the username."""
    bridge = _bridge(_agent("worker", None))
    adapter, channel, _dm = _discord_adapter(bridge)
    channel.webhook.reject_usernames = {"worker"}

    _run(adapter.send_message(str(CHANNEL_ID), "worker", "hello"))

    attempts = [call for call in channel.webhook.sent if call["content"] == "hello"]
    assert [call["username"] for call in attempts] == ["worker"]


def test_discord_does_not_reimport_its_own_webhook_post() -> None:
    """The guild echo path end to end: the real send registers the webhook id,
    and the platform's echo of it is dropped before the bridge core sees it."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, channel, _dm = _discord_adapter(bridge)

    routed: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        routed.append(msg)
        await bridge._handle_inbound_message(msg)

    adapter._on_message = on_message

    _run(adapter.send_message(str(CHANNEL_ID), "worker", "hello"))
    posted = channel.webhook.sent[0]

    _run(
        adapter._handle_message(
            _gateway_message(
                channel=channel,
                content=posted["content"],
                author=_Author(555_001, posted["username"]),
                webhook_id=WEBHOOK_ID,
            )
        )
    )

    assert routed == []


def test_discord_does_not_reimport_its_own_dm_post() -> None:
    """The DM path posts as the bot, so the bot's own user id is what drops the
    echo — again not the rendered name."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, _channel, dm = _discord_adapter(bridge)

    routed: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        routed.append(msg)
        await bridge._handle_inbound_message(msg)

    adapter._on_message = on_message

    _run(adapter.send_message(str(DM_CHANNEL_ID), "worker", "hello"))

    _run(
        adapter._handle_message(
            _gateway_message(
                channel=dm,
                content=dm.sent[0]["content"],
                author=_Author(BOT_USER_ID, "Worker Bee"),
            )
        )
    )

    assert routed == []


def test_discord_still_bridges_a_foreign_webhook_using_the_same_label() -> None:
    """As on Slack: the drop is keyed on the bridge's own webhook id, so a
    display name cannot start swallowing third-party posts."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, channel, _dm = _discord_adapter(bridge)

    routed: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        routed.append(msg)

    adapter._on_message = on_message
    adapter._webhook_ids.add(WEBHOOK_ID)

    _run(
        adapter._handle_message(
            _gateway_message(
                channel=channel,
                content="hello",
                author=_Author(555_002, "Worker Bee"),
                webhook_id=WEBHOOK_ID + 1,
            )
        )
    )

    assert [m.sender_name for m in routed] == ["Worker Bee"]


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("plain", "plain"),
        ("Bo*b", r"Bo\*b"),
        ("@here", "@\u200bhere"),
        ("<@123456789012345678>", "<\u200b@\u200b123456789012345678>"),
        ("a`b`c", r"a\`b\`c"),
        # Everything else Discord resolves from `<…>`: a channel link, a
        # timestamp, a custom emoji, a slash-command link. `escape_mentions`
        # covers none of them and backslash does not escape `<`, so the opener
        # is broken instead.
        ("<#123456789012345678>", "<\u200b#123456789012345678>"),
        ("<t:1700000000:R>", "<\u200bt:1700000000:R>"),
        ("<:name:123456789012345678>", "<\u200b:name:123456789012345678>"),
        ("</deploy:123456789012345678>", "<\u200b/deploy:123456789012345678>"),
    ],
)
def test_discord_body_escape_cases(label: str, expected: str) -> None:
    adapter, _channel, _dm = _discord_adapter(None)
    assert adapter.escape_label_for_body(label) == expected


def test_a_discord_display_name_cannot_forge_a_role_mention() -> None:
    """`escape_mentions` breaks Discord's own `@everyone`/`<@id>` syntax, but a
    label needs no Discord syntax: `translate_outbound` resolves a bare handle
    into a real mention after the label is already in the body."""
    bridge = _bridge(_agent("switchdev", "@opsbot"), _agent("opsbot", None))
    adapter, channel, _dm = _discord_adapter(bridge)
    adapter._agent_role_ids["opsbot"] = 4242

    _run(
        adapter._apply_runtime_state(
            str(CHANNEL_ID),
            "switchdev",
            "awaiting-input",
            mention_handle="123",
            thread_root_id=None,
            deeplink_url=None,
        )
    )

    content = channel.webhook.sent[-1]["content"]
    assert "<@&4242>" not in content
    assert "@\u200bopsbot" in content


def test_a_discord_display_name_cannot_forge_a_user_mention() -> None:
    bridge = _bridge(_agent("switchdev", "@alice"))
    adapter, channel, _dm = _discord_adapter(bridge)
    adapter._username_to_id["alice"] = 777

    _run(
        adapter._apply_runtime_state(
            str(CHANNEL_ID),
            "switchdev",
            "awaiting-input",
            mention_handle="123",
            thread_root_id=None,
            deeplink_url=None,
        )
    )

    content = channel.webhook.sent[-1]["content"]
    assert "<@777>" not in content
    assert "@\u200balice" in content


# ── Teams ────────────────────────────────────────────────────────────────────


class _FakeTeamsConnector:
    def __init__(self) -> None:
        self.sends: list[dict[str, Any]] = []

    async def send_to_conversation(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> str:
        self.sends.append(activity)
        return f"MSG{len(self.sends)}"

    async def update_activity(
        self,
        *,
        service_url: str,
        conversation_id: str,
        activity_id: str,
        activity: dict[str, Any],
    ) -> None:
        self.sends.append(activity)


def _teams_adapter(
    bridge: BridgeCore | None,
) -> tuple[TeamsAdapter, _FakeTeamsConnector]:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-1",
            team_id="team-1",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )
    connector = _FakeTeamsConnector()
    adapter._connector = connector  # type: ignore[assignment]
    adapter._default_service_url = "https://smba.example/amer/"
    # A flat chat, so the send is one call and nothing consults Graph for a
    # channel layout.
    adapter._channel_type[TEAMS_CHAT] = "direct"
    if bridge is not None:
        adapter.set_agent_presentation_resolver(bridge._agent_presentation)
    return adapter, connector


def _teams_card(activity: dict[str, Any]) -> dict[str, Any]:
    return activity["attachments"][0]["content"]  # type: ignore[no-any-return]


def _teams_header(activity: dict[str, Any]) -> str:
    return _teams_card(activity)["body"][0]["columns"][1]["items"][0]["text"]  # type: ignore[no-any-return]


def _teams_body(activity: dict[str, Any]) -> str:
    return _teams_card(activity)["body"][1]["text"]  # type: ignore[no-any-return]


def test_teams_card_names_the_agent_by_its_identifier_without_one() -> None:
    bridge = _bridge(_agent("worker", None))
    adapter, connector = _teams_adapter(bridge)

    _run(adapter.send_message(TEAMS_CHAT, "worker", "hello"))

    activity = connector.sends[0]
    assert _teams_header(activity) == "worker"
    assert _teams_card(activity)["fallbackText"] == "worker: hello"
    assert activity["summary"] == "worker: hello"


def test_teams_resolves_an_agent_once_per_send() -> None:
    """The card needs the label and the avatar; they come off one row, so the
    single icon lookup this replaced must not have become two."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, _connector = _teams_adapter(bridge)

    _run(adapter.send_message(TEAMS_CHAT, "worker", "hello"))

    assert bridge._agent_store.lookups == ["worker"]  # type: ignore[attr-defined]


def test_a_teams_display_name_cannot_forge_a_mention_of_a_real_person() -> None:
    """`@alice` in a display name is a ping of whoever alice is, not a cosmetic
    bug: the base ping inlines the label into Markdown source that
    `translate_outbound` then runs the mention pass over, so both halves of a
    real Teams mention are forgeable from a name alone."""
    bridge = _bridge(_agent("switchdev", "@alice the Bot"))
    adapter, connector = _teams_adapter(bridge)
    adapter.prime_mention_targets({"alice": "aad-alice"})

    _run(
        adapter._apply_runtime_state(
            TEAMS_CHAT,
            "switchdev",
            "awaiting-input",
            mention_handle=None,
            thread_root_id=None,
            deeplink_url=None,
        )
    )

    activity = connector.sends[-1]
    assert "msteams" not in _teams_card(activity)
    assert "<at>" not in _teams_body(activity)
    assert "<at>" not in _teams_header(activity)


def test_a_teams_display_name_cannot_carry_the_mention_markup_itself() -> None:
    """The other half of the same hole: `<at>…</at>` written straight into a
    name skips the marking pass, but the entity pass reads the markup back out
    of the rendered body and pairs it."""
    bridge = _bridge(_agent("switchdev", "<at>alice</at>"))
    adapter, connector = _teams_adapter(bridge)
    adapter.prime_mention_targets({"alice": "aad-alice"})

    _run(
        adapter._apply_runtime_state(
            TEAMS_CHAT,
            "switchdev",
            "awaiting-input",
            mention_handle=None,
            thread_root_id=None,
            deeplink_url=None,
        )
    )

    activity = connector.sends[-1]
    assert "msteams" not in _teams_card(activity)
    assert "<at>alice</at>" not in _teams_body(activity)


def test_teams_still_delivers_a_mention_the_agent_wrote() -> None:
    """The defusal must land on the label alone — an agent that meant to tag
    someone still tags them."""
    bridge = _bridge(_agent("worker", "Worker Bee"))
    adapter, connector = _teams_adapter(bridge)
    adapter.prime_mention_targets({"alice": "aad-alice"})

    _run(
        adapter.send_message(
            TEAMS_CHAT, "worker", adapter.translate_outbound("hi @alice")
        )
    )

    entities = _teams_card(connector.sends[0])["msteams"]["entities"]
    assert entities[0]["mentioned"]["id"] == "aad-alice"


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("plain", "plain"),
        ("@alice the Bot", "@\u200balice the Bot"),
        ("<at>alice</at>", "<\u200bat>alice<\u200b/at>"),
        ("mail@example.test", "mail@\u200bexample.test"),
        (
            "[Switch Support](https://evil.example)",
            "[Switch Support]\u200b(https://evil.example)",
        ),
    ],
)
def test_teams_body_escape_cases(label: str, expected: str) -> None:
    adapter, _connector = _teams_adapter(None)
    assert adapter.escape_label_for_body(label) == expected


def test_a_teams_display_name_cannot_forge_a_link_in_the_header() -> None:
    """An Adaptive Card TextBlock renders markdown links, and the header is
    where the speaker's name goes — so `[text](url)` in a name is a destination
    of the name's choosing wearing the speaker's identity."""
    bridge = _bridge(_agent("switchdev", "[Switch Support](https://evil.example)"))
    adapter, connector = _teams_adapter(bridge)

    _run(adapter.send_message(TEAMS_CHAT, "switchdev", "hello"))

    activity = connector.sends[0]
    for rendered in (
        _teams_header(activity),
        _teams_card(activity)["fallbackText"],
        _teams_body(activity),
    ):
        assert "](" not in rendered
        assert "](https://evil.example)" not in rendered


# ── Telegram ─────────────────────────────────────────────────────────────────


class _FakeTelegramBot:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.photos: list[dict[str, Any]] = []
        self.albums: list[dict[str, Any]] = []
        self.edits: list[dict[str, Any]] = []
        self._next_id = 500

    def _mint(self, chat_id: Any) -> Any:
        self._next_id += 1
        return SimpleNamespace(
            chat=SimpleNamespace(id=int(chat_id)), message_id=self._next_id
        )

    async def send_message(self, **kwargs: Any) -> Any:
        self.messages.append(kwargs)
        return self._mint(kwargs["chat_id"])

    async def send_photo(self, **kwargs: Any) -> Any:
        self.photos.append(kwargs)
        return self._mint(kwargs["chat_id"])

    async def send_media_group(self, **kwargs: Any) -> list[Any]:
        self.albums.append(kwargs)
        return [self._mint(kwargs["chat_id"]) for _ in kwargs["media"]]

    async def edit_message_text(self, **kwargs: Any) -> None:
        self.edits.append(kwargs)


def _telegram_adapter(
    bridge: BridgeCore | None,
) -> tuple[TelegramAdapter, _FakeTelegramBot]:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(
            bot_token="token", bot_username="acme_switch_bot"
        )
    )
    bot = _FakeTelegramBot()
    adapter._bot = bot  # type: ignore[assignment]
    adapter._bot_user_id = BOT_USER_ID
    if bridge is not None:
        adapter.set_agent_presentation_resolver(bridge._agent_presentation)
    return adapter, bot


def _telegram_mark(text: str) -> str:
    return text.split()[0]


def test_telegram_prefixes_a_message_with_the_identifier_without_one() -> None:
    bridge = _bridge(_agent("switchdev", None))
    adapter, bot = _telegram_adapter(bridge)

    _run(adapter.send_message(TELEGRAM_CHAT, "switchdev", "on it"))

    assert bot.messages[0]["text"].endswith("<b>switchdev</b>: on it")


def test_a_telegram_agents_mark_does_not_move_when_it_is_renamed() -> None:
    """A mark that jumped on a rename would stop being something a reader can
    learn, so it stays keyed on the identifier."""
    named, _bot_named = _telegram_adapter(_bridge(_agent("scout", "Switch Dev")))
    plain, _bot_plain = _telegram_adapter(_bridge(_agent("scout", None)))

    _run(named.send_message(TELEGRAM_CHAT, "scout", "one"))
    _run(plain.send_message(TELEGRAM_CHAT, "scout", "one"))

    assert _telegram_mark(_bot_named.messages[0]["text"]) == _telegram_mark(
        _bot_plain.messages[0]["text"]
    )


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("plain", "plain"),
        ("@ceo_person", "@\u200bceo_person"),
        (
            "[Switch Support](https://evil.example)",
            "[Switch Support]\u200b(https://evil.example)",
        ),
        # No entities inserted, which is what lets the prefix and the ping each
        # stay a single escape.
        ("R&D <Bot>", "R&D <Bot>"),
    ],
)
def test_telegram_body_escape_cases(label: str, expected: str) -> None:
    adapter, _bot = _telegram_adapter(None)
    assert adapter.escape_label_for_body(label) == expected


def test_a_telegram_display_name_cannot_forge_a_mention_of_a_real_person() -> None:
    """A `tg://user?id=` anchor is a hard mention: Telegram notifies that
    account whatever the visible text says. The ping inlines the label into
    Markdown source the mention pass then runs over, so one is forgeable from a
    display name alone."""
    bridge = _bridge(_agent("switchdev", "@ceo_person"))
    adapter, bot = _telegram_adapter(bridge)
    adapter._username_to_id["ceo_person"] = 777

    _run(
        adapter._apply_runtime_state(
            TELEGRAM_CHAT,
            "switchdev",
            "awaiting-input",
            mention_handle="opslead",
            thread_root_id=None,
        )
    )

    text = bot.messages[-1]["text"]
    assert "tg://user?id=777" not in text
    assert "tg://user" not in text


def test_a_telegram_display_name_cannot_forge_a_link() -> None:
    """Both halves of `[text](url)` are the name's to choose, and the anchor
    lands in the sentence naming who is speaking."""
    bridge = _bridge(_agent("switchdev", "[Switch Support](https://evil.example)"))
    adapter, bot = _telegram_adapter(bridge)

    _run(
        adapter._apply_runtime_state(
            TELEGRAM_CHAT,
            "switchdev",
            "awaiting-input",
            mention_handle="opslead",
            thread_root_id=None,
        )
    )

    text = bot.messages[-1]["text"]
    assert 'href="https://evil.example"' not in text
    assert "<a href" not in text


def test_telegram_still_delivers_a_mention_the_agent_wrote() -> None:
    """The defusal must land on the label alone — an agent that meant to tag
    someone still tags them."""
    bridge = _bridge(_agent("switchdev", "Switch Dev"))
    adapter, bot = _telegram_adapter(bridge)
    adapter.prime_mention_targets({"opslead": "777"})

    _run(
        adapter.send_message(
            TELEGRAM_CHAT, "switchdev", adapter.translate_outbound("ping @opslead")
        )
    )

    assert '<a href="tg://user?id=777">@opslead</a>' in bot.messages[-1]["text"]


# ── Mattermost ───────────────────────────────────────────────────────────────


MATTERMOST_CHANNEL = "mm-channel-1"


def _mattermost_adapter(
    bridge: BridgeCore | None,
) -> tuple[MattermostAdapter, list[str]]:
    """Mattermost reaches the label through the inherited operator ping alone,
    so the capture is of `send_message` rather than of a platform client."""
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mattermost.invalid",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    sent: list[str] = []

    async def send_message(
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str:
        sent.append(content)
        return "post-1"

    adapter.send_message = send_message  # type: ignore[method-assign]
    if bridge is not None:
        adapter.set_agent_presentation_resolver(bridge._agent_presentation)
    return adapter, sent


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("plain", "plain"),
        ("Switch Dev", "Switch Dev"),
        ("@channel", "@\u200bchannel"),
        ("@here", "@\u200bhere"),
        ("@all", "@\u200ball"),
        (
            "[Switch Support](https://evil.example)",
            "[Switch Support]\u200b(https://evil.example)",
        ),
        ("Bo*b_x", "Bo*b_x"),
    ],
)
def test_mattermost_body_escape_cases(label: str, expected: str) -> None:
    adapter, _sent = _mattermost_adapter(None)
    assert adapter.escape_label_for_body(label) == expected


def test_mattermost_awaiting_input_ping_uses_the_display_name() -> None:
    bridge = _bridge(_agent("switchdev", "Switch Dev"))
    adapter, sent = _mattermost_adapter(bridge)

    _run(
        adapter._apply_runtime_state(
            MATTERMOST_CHANNEL,
            "switchdev",
            "awaiting-input",
            mention_handle="opslead",
            thread_root_id=None,
        )
    )

    assert "**Switch Dev**" in sent[-1]
    assert "switchdev" not in sent[-1]


def test_a_mattermost_display_name_cannot_address_the_whole_channel() -> None:
    """Switch ships Markdown verbatim, so an undefused `@channel` in the label
    is resolved by Mattermost itself and notifies everyone in the room."""
    bridge = _bridge(_agent("switchdev", "@channel"))
    adapter, sent = _mattermost_adapter(bridge)

    _run(
        adapter._apply_runtime_state(
            MATTERMOST_CHANNEL,
            "switchdev",
            "awaiting-input",
            mention_handle="opslead",
            thread_root_id=None,
        )
    )

    assert "@\u200bchannel" in sent[-1]
    assert "@channel" not in sent[-1]


def test_a_mattermost_display_name_cannot_forge_a_link() -> None:
    bridge = _bridge(_agent("switchdev", "[Switch Support](https://evil.example)"))
    adapter, sent = _mattermost_adapter(bridge)

    _run(
        adapter._apply_runtime_state(
            MATTERMOST_CHANNEL,
            "switchdev",
            "awaiting-input",
            mention_handle="opslead",
            thread_root_id=None,
        )
    )

    assert "](https://evil.example)" not in sent[-1]
    assert "]\u200b(https://evil.example)" in sent[-1]


def test_mattermost_still_delivers_the_owner_ping() -> None:
    """The defusal lands on the label alone — the operator handle the ping is
    built around is not the label and must still resolve."""
    bridge = _bridge(_agent("switchdev", "@channel"))
    adapter, sent = _mattermost_adapter(bridge)

    _run(
        adapter._apply_runtime_state(
            MATTERMOST_CHANNEL,
            "switchdev",
            "awaiting-input",
            mention_handle="opslead",
            thread_root_id=None,
        )
    )

    assert sent[-1].startswith("@opslead ")
