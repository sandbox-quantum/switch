"""IRC as a messaging platform: a bot that dials out over TCP/TLS (SASL PLAIN
where configured) to one network and a fixed list of channels.

Self-created mode only: the operator runs their own bot and types its
network, nick and credentials into the connect form. There is no distributed
app and no webhook — IRC has nothing to install and nothing that calls in.

One IRC connection and one nick serve every agent, so an agent's name is
written at the start of each line rather than carried by a separate identity
the way Slack's per-message username override or Mattermost's per-agent bot
would — IRC has neither. That single shared identity is also why so much of
`PlatformAdapter`'s per-agent surface (`create_agent_identity`,
`add_agents_to_channel`, `get_channel_agent_names`, …) is a no-op here: there
is nothing on the platform to create, add to, or list.

What IRC genuinely cannot do is declared rather than faked:

- No threads: every reply posts to the channel at the top level.
- No native edit or delete: `update_message` and `delete_message` post a
  disclosed follow-up line instead of rewriting or removing anything, since
  IRC has no protocol operation that would.
- No channel creation, no user directory, no reactions.

`draws_session_activity` is still True: a turn's status and a request's card
reach the channel as the plain-text fallback `PlatformAdapter.post_rich` /
`update_rich` already render for a platform with no card renderer of its
own — IRC needs none of Telegram's or Slack's native card code to satisfy
"the agent shows it's working" and "a question can be answered from the
platform" with ordinary text and a typed reply.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import ssl
import time
from collections.abc import Awaitable, Callable
from typing import ClassVar

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.irc.chunking import (
    render_markup,
    split_to_lines,
    strip_formatting,
)
from switch_core.bridges.collaboration.irc.client import IRCClient, IRCConnectionParams
from switch_core.bridges.collaboration.irc.protocol import (
    MAX_LINE_BYTES,
    RESERVED_FOR_SERVER_PREFIX,
    ParsedLine,
    format_line,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    ChannelCreationUnsupported,
    ChannelRetirement,
    ChannelType,
    CreatedChannel,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.session.renderers import Markup

logger = logging.getLogger(__name__)


class IRCConnectionConfig(BridgeConnectionConfig):
    host: str
    port: int = 6697
    use_tls: bool = True
    #: Off only for a network with no certificate to check (a private test
    #: server). Never disabled silently: this is the one flag that does it,
    #: and the console form has to say so next to it.
    verify_tls: bool = True
    nick: str
    #: The ident sent in USER; most networks ignore it when SASL/ident-based
    #: cloaking is in play. Defaults to the nick so the common case needs one
    #: field, not two.
    username: str | None = None
    realname: str = "Switch"
    channels: list[str]
    sasl_username: str | None = None
    sasl_password: str | None = None
    #: The network's connection password (PASS), not an account password —
    #: most networks need neither this nor SASL, some need one or the other.
    server_password: str | None = None


class _IRCMarkup(Markup):
    """mIRC bold is close to universally rendered; nothing else here is, so
    only bold gets a native mark. A code span stays backtick-fenced — plain
    text that reads correctly on every client, which the base already does."""

    def bold(self, text: str) -> str:
        return f"\x02{text}\x02"


_IRC_MARKUP = _IRCMarkup()


def _client_params(config: IRCConnectionConfig) -> IRCConnectionParams:
    return IRCConnectionParams(
        host=config.host,
        port=config.port,
        use_tls=config.use_tls,
        verify_tls=config.verify_tls,
        nick=config.nick,
        username=config.username or config.nick,
        realname=config.realname,
        channels=list(config.channels),
        sasl_username=config.sasl_username,
        sasl_password=config.sasl_password,
        server_password=config.server_password,
    )


async def _ignore_line(_nick: str, _line: ParsedLine) -> None:
    return None


class IRCAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "IRC"
    docs_slug: ClassVar[str | None] = None

    keeps_quiet_unless_listening: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    # No native card renderer — `post_rich`/`update_rich` fall back to plain
    # text (see the module docstring), which is all this needs to be True for.
    draws_session_activity: ClassVar[bool] = True
    channel_on_delete: ClassVar[ChannelRetirement] = "left"

    def __init__(self, *, config: IRCConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._client: IRCClient | None = None
        self._run_task: asyncio.Task[None] | None = None
        self._ref_counter = 0

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Actually connect and register, so a wrong SASL password or server
        password is reported now rather than discovered in the background."""
        config = IRCConnectionConfig.model_validate(connection_config)
        client = IRCClient(_client_params(config), on_line=_ignore_line)
        try:
            await client.connect_once()
        except BridgeCredentialError:
            raise
        except Exception as exc:
            raise BridgeCredentialError(
                f"Could not connect to {config.host}:{config.port} to check "
                f"these credentials: {exc}. Try again."
            ) from exc
        finally:
            await client.disconnect()

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        """A certificate failure is a transport failure, not a credential
        one — `ssl.SSLError` is not a subclass of the stdlib `ConnectionError`
        the shared classifier already recognises."""
        if isinstance(exc, ssl.SSLError):
            return "network"
        return None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        # IRC dials a bare host:port, not an http(s) URL. The shared
        # OutboundPolicy check only resolves a hostname and refuses a
        # private or metadata address — it never makes a request — so an
        # https:// URL carrying the real host and port gets this
        # operator-supplied endpoint the same SSRF check every other
        # adapter's own server address gets, without adding a second URL
        # scheme to shared code for one platform.
        config = IRCConnectionConfig.model_validate(connection_config)
        return [f"https://{config.host}:{config.port}"]

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        self._on_message = on_message
        self._on_command = on_command
        # Single shared-nick model, same as Slack's single-bot identity: no
        # per-agent join to detect, so this is never called.
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

        if not self._listening:
            logger.info(
                "IRC adapter running quietly: another process holds this "
                "bridge's connection. IRC has no separate API, so this "
                "process opens nothing and serves nothing for this bridge."
            )
            return

        self._client = IRCClient(
            _client_params(self._config), on_line=self._handle_line
        )
        await self._client.connect_once()
        await self._client.join_configured_channels()
        self._run_task = asyncio.create_task(self._client.run())

    async def stop(self) -> None:
        if self._run_task is not None:
            self._run_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._run_task
            self._run_task = None
        if self._client is not None:
            await self._client.stop()
            self._client = None

    def _require_client(self) -> IRCClient:
        if self._client is None:
            raise RuntimeError("IRC adapter is not connected")
        return self._client

    def _line_budget(self, channel_id: str) -> int:
        framing = len(format_line("PRIVMSG", [channel_id, ""]).encode("utf-8")) + 2
        return MAX_LINE_BYTES - RESERVED_FOR_SERVER_PREFIX - framing

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        client = self._require_client()
        prefix = f"<{sender_name}> "
        lines = split_to_lines(
            content, prefix=prefix, max_bytes=self._line_budget(channel_id)
        )
        for line in lines:
            await client.send_line("PRIVMSG", [channel_id, line])
        self._ref_counter += 1
        return f"{channel_id}:{self._ref_counter}"

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        # IRC has no edit. The disclosed next-best thing: a new line showing
        # what the message now says, same as a human correcting themselves.
        await self.send_message(
            channel_id, self._bridge_display_name(), f"(edited) {new_content}"
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        # IRC has no delete either; say so rather than silently doing nothing,
        # which would read as a deletion that worked.
        await self.send_message(
            channel_id, self._bridge_display_name(), "(message removed)"
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # No typing indicator in the IRC protocol.
        return None

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        raise ChannelCreationUnsupported(
            "IRC channels are joined, not provisioned — add the channel to "
            "this bridge's connection config and invite/op the bot on the "
            "network, then reconnect."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_public"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        # IRC has no API to add a person to a channel from the outside — at
        # best an INVITE, which only works on an invite-only channel and only
        # if they choose to join. None can be added from here.
        return list(user_external_ids)

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        try:
            client = self._require_client()
        except RuntimeError as exc:
            return RetireOutcome.failed(str(exc))
        try:
            await client.send_line(
                "PART", [external_channel_id, "Room deleted in Switch"]
            )
        except Exception as exc:
            return RetireOutcome.failed(str(exc))
        return RetireOutcome(outcome="left")

    # ── Translation ──────────────────────────────────────────────────────

    def rich_markup(self) -> Markup:
        return _IRC_MARKUP

    def _render_outbound(self, content: str) -> str:
        return render_markup(content)

    def translate_inbound(self, raw_message: str) -> str:
        # Neutralises every mIRC control code, including a literal CR/LF,
        # so a user cannot forge formatting or smuggle a second line in.
        return strip_formatting(raw_message)

    # ── Inbound dispatch ─────────────────────────────────────────────────

    def _event_id(
        self, tags: dict[str, str], channel: str, nick: str, text: str
    ) -> str:
        msgid = tags.get("msgid")
        if msgid:
            return msgid
        # No IRCv3 message-tags on this network: derive one. Two identical
        # lines from the same person in the same channel within the same
        # 2-second bucket collapse to one id — an honest tradeoff given IRC
        # offers no real message identity, not a guarantee against it.
        bucket = tags.get("time") or str(int(time.time() // 2))
        return f"{channel}\x1f{nick}\x1f{text}\x1f{bucket}"

    def _parse_command(self, text: str) -> tuple[str, str] | None:
        if not text.startswith("!"):
            return None
        parts = text.split(None, 1)
        command = parts[0].lstrip("!")
        args = parts[1].strip() if len(parts) > 1 else ""
        return command, args

    async def _handle_line(self, our_nick: str, line: ParsedLine) -> None:
        if line.command == "JOIN":
            await self._handle_join(our_nick, line)
            return
        if line.command != "PRIVMSG":
            return
        nick = line.nick
        if nick is None or nick == our_nick:
            # Our own echo (echo-message), or a server-sourced PRIVMSG with
            # no nick prefix — neither is a person to relay.
            return
        if len(line.params) < 2:
            return
        channel, raw_text = line.params[0], line.params[1]
        if not channel.startswith(("#", "&", "!", "+")):
            # Not a channel — a direct message to the bot's own nick, which
            # this bridge does not have a room to put it in.
            return
        text = strip_formatting(raw_text)
        command = self._parse_command(text)
        if command is not None and self._on_command is not None:
            name, args = command
            await self._on_command(
                InboundCommand(
                    channel_id=channel,
                    channel_type="channel_public",
                    sender_id=nick,
                    sender_name=nick,
                    command=name,
                    args=args,
                    message_ref=self._event_id(line.tags, channel, nick, raw_text),
                    channel_name=channel,
                )
            )
            return
        if self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    channel_id=channel,
                    channel_type="channel_public",
                    sender_id=nick,
                    sender_name=nick,
                    content=text,
                    message_ref=self._event_id(line.tags, channel, nick, raw_text),
                    channel_name=channel,
                )
            )

    async def _handle_join(self, our_nick: str, line: ParsedLine) -> None:
        if not line.params:
            return
        channel = line.params[0]
        nick = line.nick
        if nick is None:
            return
        if nick == our_nick:
            if self._on_app_joined is not None:
                await self._on_app_joined(
                    InboundAppJoin(
                        channel_id=channel,
                        channel_type="channel_public",
                        channel_name=channel,
                    )
                )
            return
        if self._on_user_joined is not None:
            await self._on_user_joined(
                InboundUserJoin(
                    channel_id=channel,
                    channel_type="channel_public",
                    external_user_id=nick,
                    external_username=nick,
                    channel_name=channel,
                )
            )
