"""IRC: Switch rooms as IRC channels, agents speaking through one bot nick.

IRC has no bot accounts, no per-message sender names and no message ids of
its own, so the shape is the one an IRC relay bot has always had. The bridge
connects as a single nickname, joins the channels its rooms are bound to, and
prefixes every line it posts with the speaking agent's name. People address an
agent the IRC way, `agent: hello`, or with Switch's `@agent`; `!command` runs a
Switch command.

What IRC cannot do is documented rather than faked: a sent message cannot be
edited or deleted, so `update_message` and `delete_message` do nothing, and
there are no buttons, so a request card arrives as text and is answered by
typing. See docs/messaging-platforms/irc.md.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import ssl
import uuid
from collections.abc import Awaitable, Callable, Mapping
from typing import ClassVar

from pydantic import Field, ValidationError, field_validator, model_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.irc.client import (
    IrcClient,
    IrcError,
    IrcRegistrationError,
    IrcSettings,
    Opener,
    TokenBucket,
)
from switch_core.bridges.collaboration.irc.protocol import (
    BOLD,
    IrcMessage,
    irc_to_markdown,
    is_channel,
    is_valid_nick,
    markdown_to_irc,
    normalize_target,
    payload_budget,
    split_message,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

logger = logging.getLogger(__name__)

#: How long a JOIN made to create a channel waits for the server's answer.
JOIN_TIMEOUT = 15.0

#: Reconnection backoff, doubling from the first to the last.
RECONNECT_FIRST = 2.0
RECONNECT_MAX = 120.0

#: Numerics a server answers a JOIN with when it will not let us in.
_JOIN_REFUSALS = {
    "403": "no such channel",
    "405": "this nickname has joined too many channels",
    "471": "the channel is full",
    "473": "the channel is invite-only",
    "474": "this nickname is banned from the channel",
    "475": "the channel needs a key",
    "477": "the channel needs a registered nickname",
}

_CHANNEL_NAME_RE = re.compile(r"[^a-z0-9_\-]+")
_ADDRESSED_RE = re.compile(r"^([^\s:,]+)[:,]\s+(.*)$", re.DOTALL)


class IrcConnectionConfig(BridgeConnectionConfig):
    #: The IRC server's hostname, e.g. `irc.libera.chat`.
    server: str
    #: 6697 is the standard TLS port; 6667 the plain-text one.
    port: int = Field(default=6697, ge=1, le=65535)
    tls: bool = True
    #: Check the server's certificate. Off only for a server with a
    #: self-signed certificate you trust.
    verify_tls: bool = True
    #: The bridge's nickname: every agent speaks through it.
    nickname: str
    #: Channels to join and bridge as rooms as soon as the bridge connects,
    #: separated by commas or spaces, e.g. `#ops, #deploys`.
    channels: str | None = None
    #: A services account (NickServ) to log in to with SASL, so the nickname
    #: is protected and the bridge can join channels that need one.
    sasl_username: str | None = None
    sasl_password: str | None = Field(
        default=None, json_schema_extra={"format": "password"}
    )
    #: The server's connection password, on a private server that has one.
    server_password: str | None = Field(
        default=None, json_schema_extra={"format": "password"}
    )

    @field_validator("server")
    @classmethod
    def _plain_hostname(cls, value: str) -> str:
        value = value.strip()
        if not value or "/" in value or ":" in value.strip("[]") or " " in value:
            raise ValueError(
                "Give the server's hostname alone, e.g. irc.libera.chat — the "
                "port and TLS are separate settings"
            )
        return value

    @field_validator("nickname")
    @classmethod
    def _valid_nickname(cls, value: str) -> str:
        value = value.strip()
        if not is_valid_nick(value):
            raise ValueError(
                f"{value!r} is not a valid IRC nickname: start with a letter, use "
                "letters, digits and -[]\\`^{}|_ only, at most 30 characters"
            )
        return value

    @field_validator("channels")
    @classmethod
    def _valid_channels(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        names = [name for name in re.split(r"[,\s]+", value) if name]
        bad = [name for name in names if not is_channel(name)]
        if bad:
            raise ValueError(
                f"Not channel names: {', '.join(bad)}. IRC channels start with #"
            )
        return ", ".join(names)

    @model_validator(mode="after")
    def _secrets_need_tls(self) -> IrcConnectionConfig:
        if bool(self.sasl_username) != bool(self.sasl_password):
            raise ValueError("Give both the SASL username and its password, or neither")
        if (self.sasl_password or self.server_password) and not self.tls:
            raise ValueError(
                "A password would be sent in the clear without TLS. Turn TLS on "
                "(port 6697 on most networks)"
            )
        return self

    def channel_list(self) -> list[str]:
        if not self.channels:
            return []
        return [name for name in re.split(r"[,\s]+", self.channels) if name]

    def settings(self) -> IrcSettings:
        return IrcSettings(
            host=self.server,
            port=self.port,
            tls=self.tls,
            verify_tls=self.verify_tls,
            nickname=self.nickname,
            username=self.nickname.lower()[:10],
            server_password=self.server_password,
            sasl_username=self.sasl_username,
            sasl_password=self.sasl_password,
        )


class IrcAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "IRC"
    # Set once docs/messaging-platforms/irc.md is published on the docs site.
    docs_slug: ClassVar[str | None] = None
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    # One connection per nickname: only the process holding the bridge
    # connects, and a quiet copy hands its sends to it.
    keeps_quiet_unless_listening: ClassVar[bool] = True

    def __init__(
        self,
        *,
        config: IrcConnectionConfig,
        opener: Opener | None = None,
        bucket: TokenBucket | None = None,
    ) -> None:
        super().__init__()
        self.config = config
        self._opener = opener
        self._bucket = bucket
        self._client: IrcClient | None = None
        self._run_task: asyncio.Task[None] | None = None
        self._stopping = False
        #: Channels we are in, by normalized name, with the name as written.
        self._joined: dict[str, str] = {}
        #: Channels to be in: the configured ones, bound rooms, invites taken.
        self._wanted: dict[str, str] = {}
        #: Channels joined to create a room, whose join is not an app join.
        self._creating: set[str] = set()
        #: JOINs waiting for the server's answer: the people in the channel,
        #: or a refusal.
        self._join_waiters: dict[str, tuple[asyncio.Future[list[str]], list[str]]] = {}
        #: Agent names by their IRC-normalized form, for `agent: hello`.
        self._agents: dict[str, str] = {}

    # ── Lifecycle ──────────────────────────────────────────────────────────

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        # The policy checks URLs; this one names the server's host and port so
        # a config cannot point the bridge at an internal address. The scheme
        # is only there to satisfy the check — the bridge speaks IRC to it.
        server, port = connection_config.get("server"), connection_config.get("port")
        if not isinstance(server, str) or not server.strip():
            return []
        return [f"https://{server.strip()}:{port if isinstance(port, int) else 6697}"]

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        # Two bridges on one nickname would knock each other off the server.
        server, nick = (
            connection_config.get("server"),
            connection_config.get("nickname"),
        )
        if not isinstance(server, str) or not isinstance(nick, str):
            return None
        return f"the IRC nickname {nick.strip()} on {server.strip().lower()}"

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, IrcRegistrationError):
            return "auth_failed"
        if isinstance(exc, ssl.SSLCertVerificationError):
            return "config_invalid"
        if isinstance(exc, IrcError):
            return "network"
        return None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        try:
            config = IrcConnectionConfig.model_validate(connection_config)
        except ValidationError as exc:
            raise BridgeCredentialError(str(exc)) from exc
        client = IrcClient(config.settings(), _ignore)
        try:
            await client.connect()
        except IrcRegistrationError as exc:
            raise BridgeCredentialError(str(exc)) from exc
        except ssl.SSLCertVerificationError as exc:
            raise BridgeCredentialError(
                f"{config.server}'s TLS certificate could not be verified: "
                f"{exc.verify_message}"
            ) from exc
        except (OSError, TimeoutError, IrcError) as exc:
            raise BridgeCredentialError(
                f"Could not connect to {config.server}:{config.port}"
                f"{' with TLS' if config.tls else ''}: {exc or type(exc).__name__}"
            ) from exc
        finally:
            await client.close(quit_message="Checking the connection")

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
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined
        for name in self.config.channel_list():
            self._wanted.setdefault(normalize_target(name), name)
        if not self._listening:
            return
        self._stopping = False
        # The first connection is made here so that a refusal fails the start
        # with the server's reason; later ones are the reconnect loop's.
        await self._connect()
        self._run_task = asyncio.create_task(self._stay_connected())

    async def stop(self) -> None:
        self._stopping = True
        task, self._run_task = self._run_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        client, self._client = self._client, None
        if client is not None:
            await client.close(quit_message="Agent Switch is stopping")
        self._joined.clear()

    async def _connect(self) -> None:
        client = IrcClient(
            self.config.settings(),
            self._handle,
            opener=self._opener or self._guarded_open,
            bucket=self._bucket,
        )
        await client.connect()
        self._client = client
        self._joined.clear()
        for name in list(self._wanted.values()):
            await client.send("JOIN", name)

    async def _stay_connected(self) -> None:
        delay = RECONNECT_FIRST
        while not self._stopping:
            client = self._client
            if client is not None:
                await client.wait_closed()
                if self._stopping:
                    return
                logger.warning("IRC connection to %s closed", self.config.server)
                self._client = None
            await asyncio.sleep(delay)
            try:
                await self._connect()
                delay = RECONNECT_FIRST
            except IrcRegistrationError:
                # A refusal does not get better by asking faster.
                logger.exception("IRC server %s refused us", self.config.server)
                delay = RECONNECT_MAX
            except (OSError, TimeoutError, IrcError) as exc:
                logger.warning("Reconnecting to %s failed: %s", self.config.server, exc)
                delay = min(delay * 2, RECONNECT_MAX)

    async def _guarded_open(
        self, host: str, port: int, *, ssl: ssl.SSLContext | None = None
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        """Connect only to an address the outbound policy allows, resolved now,
        so a name that resolves elsewhere after registration is caught."""
        policy = getattr(self, "_outbound_policy", None)
        addresses = [host] if policy is None else await policy.resolve(host, port)
        failure: OSError | None = None
        for address in addresses:
            try:
                return await asyncio.open_connection(
                    address, port, ssl=ssl, server_hostname=host if ssl else None
                )
            except OSError as exc:
                failure = exc
        assert failure is not None
        raise failure

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        # The channels of bound rooms: be in them, now and after reconnecting.
        for channel_id, _channel_type in channels:
            if is_channel(channel_id):
                self._wanted.setdefault(normalize_target(channel_id), channel_id)
                if self._client is not None and channel_id not in self._joined:
                    await self._client.send("JOIN", channel_id)

    # ── Inbound ───────────────────────────────────────────────────────────

    async def _handle(self, message: IrcMessage) -> None:
        handler = {
            "PRIVMSG": self._handle_privmsg,
            "JOIN": self._handle_join,
            "PART": self._handle_part,
            "KICK": self._handle_kick,
            "INVITE": self._handle_invite,
            "353": self._handle_names,
            "366": self._handle_end_of_names,
        }.get(message.command)
        if handler is not None:
            await handler(message)
        elif message.command in _JOIN_REFUSALS and len(message.params) >= 2:
            self._refuse_join(message)
        elif message.command in ("401", "404") and len(message.params) >= 2:
            logger.warning(
                "IRC could not deliver to %s: %s",
                message.params[1],
                message.params[-1],
            )

    @property
    def _nick(self) -> str:
        return self._client.nick if self._client else self.config.nickname

    def _is_me(self, nick: str | None) -> bool:
        return nick is not None and normalize_target(nick) == normalize_target(
            self._nick
        )

    async def _handle_privmsg(self, message: IrcMessage) -> None:
        if len(message.params) < 2 or message.nick is None:
            return
        sender = message.nick
        if self._is_me(sender):
            return  # our own line, echoed back by `echo-message`
        target, text = message.params[0], message.params[1]
        if text.startswith("\x01"):
            # CTCP: only `/me` carries something said.
            if not text.startswith("\x01ACTION "):
                return
            text = f"_{sender} {text[8:].rstrip(chr(1))}_"
        channel_type: ChannelType
        if is_channel(target):
            channel_id, channel_type, channel_name = (
                normalize_target(target),
                "channel_public",
                target,
            )
        else:
            channel_id, channel_type, channel_name = (
                normalize_target(sender),
                "direct",
                sender,
            )
        # A nickname can be taken by anyone while its owner is away; a services
        # account cannot. Where the server tags the account, it is the sender.
        sender_id = message.tags.get("account") or sender
        message_ref = message.tags.get("msgid") or f"irc:{uuid.uuid4()}"
        stripped = text.strip()
        if stripped.startswith("!") and len(stripped) > 1 and stripped[1] != " ":
            parts = stripped.split(None, 1)
            if self._on_command is not None:
                await self._on_command(
                    InboundCommand(
                        channel_id=channel_id,
                        channel_type=channel_type,
                        sender_id=sender_id,
                        sender_name=sender,
                        command=parts[0][1:],
                        args=parts[1].strip() if len(parts) > 1 else "",
                        message_ref=message_ref,
                        channel_name=channel_name,
                    )
                )
            return
        if self._on_message is None or not stripped:
            return
        await self._on_message(
            InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=sender_id,
                sender_name=sender,
                content=self.translate_inbound(text),
                message_ref=message_ref,
                channel_name=channel_name,
            )
        )

    async def _handle_join(self, message: IrcMessage) -> None:
        if not message.params or message.nick is None:
            return
        name = message.params[0]
        channel_id = normalize_target(name)
        if self._is_me(message.nick):
            self._joined[channel_id] = name
            created = channel_id in self._creating
            if not created and self._on_app_joined is not None:
                await self._on_app_joined(
                    InboundAppJoin(
                        channel_id=channel_id,
                        channel_type="channel_public",
                        channel_name=name,
                    )
                )
            return
        if self._on_user_joined is not None:
            await self._on_user_joined(
                InboundUserJoin(
                    channel_id=channel_id,
                    channel_type="channel_public",
                    external_user_id=message.tags.get("account") or message.nick,
                    external_username=message.nick,
                    channel_name=name,
                )
            )

    async def _handle_part(self, message: IrcMessage) -> None:
        if message.params and self._is_me(message.nick):
            self._joined.pop(normalize_target(message.params[0]), None)

    async def _handle_kick(self, message: IrcMessage) -> None:
        if len(message.params) >= 2 and self._is_me(message.params[1]):
            channel_id = normalize_target(message.params[0])
            self._joined.pop(channel_id, None)
            # Kicked is a person's decision; rejoining would argue with it.
            self._wanted.pop(channel_id, None)
            logger.warning(
                "Kicked from %s by %s: %s",
                message.params[0],
                message.nick,
                message.params[-1],
            )

    async def _handle_invite(self, message: IrcMessage) -> None:
        # Inviting the bridge is how a channel is brought into Switch, as
        # adding the app is on other platforms: join, and the join makes the
        # room.
        if len(message.params) < 2 or self._client is None:
            return
        name = message.params[1]
        if not is_channel(name):
            return
        self._wanted[normalize_target(name)] = name
        await self._client.send("JOIN", name)

    async def _handle_names(self, message: IrcMessage) -> None:
        # RPL_NAMREPLY: me, symbol, channel, :names
        if len(message.params) < 4:
            return
        waiter = self._join_waiters.get(normalize_target(message.params[2]))
        if waiter is not None:
            waiter[1].extend(name.lstrip("~&@%+") for name in message.params[3].split())

    async def _handle_end_of_names(self, message: IrcMessage) -> None:
        if len(message.params) < 2:
            return
        waiter = self._join_waiters.pop(normalize_target(message.params[1]), None)
        if waiter is not None and not waiter[0].done():
            waiter[0].set_result(waiter[1])

    def _refuse_join(self, message: IrcMessage) -> None:
        channel_id = normalize_target(message.params[1])
        reason = _JOIN_REFUSALS[message.command]
        waiter = self._join_waiters.pop(channel_id, None)
        if waiter is not None and not waiter[0].done():
            waiter[0].set_exception(
                BridgeOperationError(
                    f"The IRC server would not let the bridge join "
                    f"{message.params[1]}: {reason}"
                )
            )
        else:
            logger.warning("Could not join %s: %s", message.params[1], reason)

    def translate_inbound(self, raw_message: str) -> str:
        text = irc_to_markdown(raw_message)
        # `agent: hello` is how IRC addresses someone; Switch reads `@agent`.
        match = _ADDRESSED_RE.match(text)
        if match is not None:
            agent = self._agents.get(normalize_target(match.group(1)))
            if agent is not None:
                text = f"@{agent} {match.group(2)}"
        return text

    # ── Outbound ──────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return markdown_to_irc(content)

    def _require_client(self) -> IrcClient:
        if self._client is None or not self._client.connected:
            raise BridgeOperationError(
                f"The bridge is not connected to {self.config.server} right now"
            )
        return self._client

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        if not self._listening:
            # Only the holder has a connection: hand it the line.
            self._hand_to_holder(
                {
                    "kind": "send",
                    "channel": channel_id,
                    "sender": sender_name,
                    "content": content,
                }
            )
            return f"irc:{uuid.uuid4()}"
        label = (await self.agent_rendering(sender_name)).field_label
        await self._post(channel_id, label, content)
        return f"irc:{uuid.uuid4()}"

    async def receive_relayed(self, request: Mapping[str, str]) -> None:
        if request.get("kind") != "send":
            await super().receive_relayed(request)
            return
        label = (await self.agent_rendering(request["sender"])).field_label
        await self._post(request["channel"], label, request["content"])

    async def _post(self, channel_id: str, label: str, content: str) -> None:
        client = self._require_client()
        target = self._joined.get(channel_id, channel_id)
        if is_channel(channel_id) and channel_id not in self._joined:
            # Most channels refuse messages from outside (+n): be in it first.
            self._wanted.setdefault(channel_id, channel_id)
            await client.send("JOIN", channel_id)
        prefix = f"{BOLD}{label}{BOLD}: " if label else ""
        budget = payload_budget(client.nick, target) - len(prefix.encode())
        for line in split_message(content, max(budget, 64)):
            await client.send("PRIVMSG", target, prefix + line)

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        # A line sent on IRC is final.
        logger.debug("IRC cannot edit %s; keeping the original", message_ref)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        logger.debug("IRC cannot delete %s; leaving it", message_ref)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # The IRCv3 typing indicator, where the server carries client tags.
        client = self._client
        if client is None or "message-tags" not in client.caps or not self._listening:
            return
        target = self._joined.get(channel_id)
        if target is None:
            return
        state = "active" if is_typing else "done"
        with contextlib.suppress(IrcError):
            await client.send("TAGMSG", target, tags=f"+typing={state}")

    # ── Channels and people ───────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        client = self._require_client()
        slug = _CHANNEL_NAME_RE.sub("-", name.lower()).strip("-")[:48] or "switch"
        channel = f"#{slug}"
        channel_id = normalize_target(channel)
        future: asyncio.Future[list[str]] = asyncio.get_running_loop().create_future()
        self._join_waiters[channel_id] = (future, [])
        self._creating.add(channel_id)
        try:
            await client.send("JOIN", channel)
            members = await asyncio.wait_for(future, JOIN_TIMEOUT)
        except TimeoutError as exc:
            raise BridgeOperationError(
                f"The IRC server did not answer the bridge joining {channel}"
            ) from exc
        finally:
            self._join_waiters.pop(channel_id, None)
            self._creating.discard(channel_id)
        others = [m for m in members if not self._is_me(m)]
        if others:
            # Someone's channel already: taking it over is not ours to do.
            await client.send("PART", channel, "Already in use")
            raise BridgeOperationError(
                f"{channel} already exists on {self.config.server} with people in "
                "it. Invite the bridge there to bring it into Switch instead."
            )
        self._wanted[channel_id] = channel
        if channel_type in ("channel_private", "group"):
            await client.send("MODE", channel, "+is")
        if topic.strip():
            await client.send("TOPIC", channel, topic.strip()[:300])
        return channel_id

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_public" if is_channel(channel_id) else "direct"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Agents speak through the bridge's own nickname, which is in the room.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        client = self._client
        if client is None or not is_channel(channel_id):
            return list(user_external_ids)
        target = self._joined.get(channel_id, channel_id)
        failed: list[str] = []
        for name, external_id in zip(user_names, user_external_ids, strict=False):
            nick = name if is_valid_nick(name) else external_id
            if not is_valid_nick(nick):
                failed.append(external_id)
                continue
            await client.send("INVITE", nick, target)
        return failed

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        self._agents[normalize_target(agent.name)] = agent.name

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        self._agents.pop(normalize_target(agent.name), None)

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        # IRC shows one nickname for all of them; Switch's room knows who.
        return []


async def _ignore(_message: IrcMessage) -> None:
    return None
