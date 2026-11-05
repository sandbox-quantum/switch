from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping
from typing import ClassVar, cast
from uuid import uuid4

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    ChannelNotBindable,
    PlatformAdapter,
    RequestCard,
    RichContent,
    TurnActivity,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.session.renderers import Markup, turn_state
from switch_core.outbound import OutboundPolicy
from switch_core.sessions.contract import TURN_ENDED

from .client import ChannelTypeChanged, Event, IrcClient
from .config import IrcConnectionConfig
from .markup import IRC_MARKUP, plain, render, split_lines
from .protocol import Line, fold, is_channel, is_nick

logger = logging.getLogger(__name__)
RELAY_RETRY_SECONDS = 1.0


async def _resolve_for_verification(host: str, port: int) -> list[str]:
    policy = OutboundPolicy.parse(os.environ.get("OUTBOUND_ALLOWED_PRIVATE_HOSTS", ""))
    return await policy.resolve(host, port)


async def _ignore_event(event: Event) -> None:
    return None


class IrcAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "IRC"
    keeps_quiet_unless_listening = True
    supports_directory_search = False
    renders_custom_url_schemes = False
    supports_activity_reactions = False
    draws_session_activity = True
    separate_attention_slot = True
    channel_on_delete = "left"

    def __init__(self, *, config: IrcConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self.client: IrcClient | None = None
        self._relay_queue: asyncio.Queue[Mapping[str, str]] = asyncio.Queue(
            maxsize=1000
        )
        self._relay_worker: asyncio.Task[None] | None = None
        self._creating: set[str] = set()
        self._unusable_channels: set[str] = set()
        self._channel_types: dict[str, ChannelType] = {}
        self._rendered_states: OrderedDict[str, str] = OrderedDict()

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        config = IrcConnectionConfig.model_validate(connection_config)
        host = f"[{config.server}]" if ":" in config.server else config.server
        return [f"https://{host}:{config.port}"]

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str:
        config = IrcConnectionConfig.model_validate(connection_config)
        identity = (
            "account/" + (config.account or config.nick).lower()
            if config.account_password
            else "nick/" + fold(config.nick, "ascii")
        )
        return f"IRC {config.server}:{config.port}/{identity}"

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = IrcConnectionConfig.model_validate(connection_config)
        # The credential-check interface has no injected policy. Read the same
        # deployment allowlist here and pin the connection to its checked IP.
        client = IrcClient(
            config.model_copy(update={"network_case_mapping": None, "channels": ""}),
            _resolve_for_verification,
            _ignore_event,
        )
        try:
            await client.start()
            connection_config["network_case_mapping"] = client.case_mapping
        except (OSError, TimeoutError) as error:
            raise BridgeCredentialError(
                "Could not establish the IRC connection. Check the hostname, port, TLS certificate and network access."
            ) from error
        finally:
            await client.stop()

    @classmethod
    def unlinkable_account_reason(cls, external_user_id: str) -> str | None:
        if not external_user_id.startswith(
            "account:"
        ) or not external_user_id.removeprefix("account:"):
            return "Sign in to an IRC services account before linking it to Switch. An unverified nickname can be used by someone else."
        return None

    def canonical(self, name: str) -> str:
        return fold(name, self.config.network_case_mapping or "rfc1459")

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
        if not self._listening:
            return
        self.client = IrcClient(self.config, self.outbound_policy.resolve, self._event)
        try:
            await self.client.start()
            self.config.network_case_mapping = self.client.case_mapping
            self._relay_worker = asyncio.create_task(
                self._run_relay(), name="irc-relay"
            )
            for channel in self.config.channels.split(","):
                if channel:
                    await self.client.join(channel)
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        if self._relay_worker:
            self._relay_worker.cancel()
            await asyncio.gather(self._relay_worker, return_exceptions=True)
            self._relay_worker = None
        if self.client:
            await self.client.stop()
            self.client = None

    async def _event(self, event: Event) -> None:
        client = self.client
        assert client is not None
        if isinstance(event, ChannelTypeChanged):
            self._channel_types[event.channel] = (
                "channel_private" if event.private else "channel_public"
            )
            if self._on_channel_type_learned:
                await self._on_channel_type_learned(
                    event.channel,
                    "channel_private" if event.private else "channel_public",
                )
            return
        if not isinstance(event, Line) or not event.params:
            return
        if event.command == "JOIN":
            channel = self.canonical(event.params[0])
            if channel in self._creating:
                return
            if (
                event.nick
                and client.canonical(event.nick) == client.canonical(client.nick)
                and self._on_app_joined
            ):
                await self._on_app_joined(
                    InboundAppJoin(
                        channel_id=channel,
                        channel_type=await self.get_channel_type(channel),
                        channel_name=channel,
                    )
                )
            return
        if event.command != "PRIVMSG" or len(event.params) != 2 or event.nick is None:
            return
        target, content = event.params
        account = event.tags.get("account")
        if client.canonical(event.nick) == client.canonical(client.nick) or (
            account and account.lower() == client.bot_account
        ):
            return
        in_channel = is_channel(target)
        if not in_channel and client.canonical(target) != client.canonical(client.nick):
            return
        if not in_channel and event.nick.lower() in {
            "nickserv",
            "chanserv",
            "operserv",
            "memoserv",
            "hostserv",
        }:
            return
        if content.startswith("\x01"):
            if not content.startswith("\x01ACTION ") or not content.endswith("\x01"):
                return
            content = f"*{content[8:-1]}*"
        content = plain(content)
        if not content.strip():
            return
        if not in_channel and account in (None, "*"):
            await client.command(
                "NOTICE",
                event.nick,
                "Sign in to an IRC services account, then message the bot again to start a private Switch conversation.",
            )
            return
        sender = (
            "account:" + account.lower()
            if account and account != "*"
            else "nick:" + client.canonical(event.nick)
        )
        channel = self.canonical(target) if in_channel else "dm:" + sender
        channel_type = await self.get_channel_type(target) if in_channel else "direct"
        message_ref = event.tags.get("msgid")
        if not message_ref:
            stamp = event.tags.get("time")
            message_ref = (
                hashlib.sha256(
                    json.dumps(
                        [stamp, event.source, event.params], ensure_ascii=False
                    ).encode()
                ).hexdigest()
                if stamp
                else uuid4().hex
            )
        if content.startswith("!") and self._on_command:
            command, _, args = content[1:].partition(" ")
            await self._on_command(
                InboundCommand(
                    channel_id=channel,
                    channel_type=channel_type,
                    sender_id=sender,
                    sender_name=event.nick,
                    command=command,
                    args=args,
                    message_ref=message_ref,
                    channel_name=target,
                )
            )
        elif self._on_message:
            mentioned = re.search(
                rf"(?:^|\s)@?{re.escape(client.nick)}(?:[:,]|\s|$)",
                content,
                re.IGNORECASE,
            )
            await self._on_message(
                InboundMessage(
                    channel_id=channel,
                    channel_type=channel_type,
                    sender_id=sender,
                    sender_name=event.nick,
                    content=content,
                    message_ref=message_ref,
                    channel_name=target,
                    self_mention_token=client.nick if mentioned else None,
                )
            )

    async def _target(self, channel_id: str) -> str:
        if is_channel(channel_id):
            return channel_id
        if not channel_id.startswith("dm:account:"):
            raise BridgeOperationError(
                "IRC cannot safely send a private reply to an unverified nickname. Sign in to an IRC account and send the bot a new message."
            )
        account = channel_id.removeprefix("dm:account:")
        client = self.client
        if client:
            for nick in list(client.account_nicks.get(account, set())):
                if await client.whois_account(nick) == account:
                    return nick
        raise BridgeOperationError(
            "The IRC account is offline or its current nickname could not be verified. Send the bot a new message from that account."
        )

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str:
        label = plain(await self.agent_label_for_body(sender_name)).replace("\n", " ")[
            :32
        ]
        prefix = f"<{label}> "
        if self.client is None:
            if self._listening:
                raise BridgeOperationError("IRC is disconnected")
            # JSON-escaped text must also fit the shared NOTIFY relay envelope.
            for chunk in split_lines(content, 512):
                self._hand_to_holder(
                    {
                        "id": uuid4().hex,
                        "action": "send",
                        "channel": channel_id,
                        "text": chunk,
                        "prefix": prefix,
                    }
                )
            return uuid4().hex
        return await self._send_text(channel_id, content, prefix)

    async def _send_text(self, channel_id: str, content: str, prefix: str) -> str:
        client = self.client
        assert client is not None
        if self.canonical(channel_id) in self._unusable_channels:
            raise BridgeOperationError(
                "IRC channel privacy has not been confirmed. The message was not sent."
            )
        target = await self._target(channel_id)
        if is_channel(target):
            await client.join(target)
        chunks = split_lines(
            content,
            client.message_budget(
                target,
                labeled={"echo-message", "labeled-response"} <= client.caps,
            )
            - len(prefix.encode()),
        )
        reference = uuid4().hex
        for chunk in chunks:
            reference = await client.send(target, prefix + chunk)
        return reference

    def _hand_to_holder(self, request: dict[str, str]) -> None:
        if self._relay_to_holder is None:
            raise BridgeOperationError("IRC has no route to its connection holder")
        super()._hand_to_holder(request)

    async def receive_relayed(self, request: Mapping[str, str]) -> None:
        if self.client is None:
            raise BridgeOperationError("IRC holder is disconnected")
        # Preserve create/mode/invite/send ordering without occupying the
        # relay worker shared by all bridges while IRC applies flood control.
        await self._relay_queue.put(dict(request))

    async def _run_relay(self) -> None:
        while True:
            request = await self._relay_queue.get()
            try:
                await self._relayed(request)
            except BridgeOperationError as error:
                client = self.client
                uncertain = "delivery is uncertain" in str(error).lower()
                if client is None or not client.connected or uncertain:
                    # Keep transient transport failures in the holder's queue.
                    # The next reconnect can finish the same request in order.
                    if client is not None and client.connected:
                        client.force_reconnect()
                    await self._relay_queue.put(dict(request))
                    await asyncio.sleep(RELAY_RETRY_SECONDS)
                else:
                    logger.exception("Relayed IRC operation failed")
            except Exception:
                logger.exception("Relayed IRC operation failed")
            finally:
                self._relay_queue.task_done()

    async def _relayed(self, request: Mapping[str, str]) -> None:
        client = self.client
        assert client is not None
        action = request.get("action")
        channel = request.get("channel", "")
        if action == "send":
            await self._send_text(channel, request["text"], request["prefix"])
        elif action == "create" and is_channel(channel):
            await self._create_exact(
                channel, request.get("topic", ""), request.get("private") == "yes"
            )
        elif action == "join" and is_channel(channel):
            await client.join(channel)
            if request.get("private") == "yes":
                await self._confirm_private(channel)
        elif action == "part" and is_channel(channel):
            await self.retire_channel(channel)
        elif action == "invite" and is_channel(channel):
            await self.add_users_to_channel(
                channel, [request["nick"]], [request["account"]]
            )
        else:
            raise BridgeOperationError("Invalid relayed IRC operation")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        if channel_id.startswith("dm:"):
            return "direct"
        if not is_channel(channel_id):
            raise ChannelNotBindable("Enter an IRC channel name beginning with # or &")
        if self.client is None:
            return self._channel_types.get(
                self.canonical(channel_id), "channel_private"
            )
        return (
            "channel_private" if self.client.private(channel_id) else "channel_public"
        )

    async def require_bindable_channel(self, channel_id: str) -> None:
        if not is_channel(channel_id) or channel_id != self.canonical(channel_id):
            raise ChannelNotBindable(
                "Use the channel's canonical IRC name for this network"
            )

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        for channel, channel_type in channels:
            if is_channel(channel):
                self._channel_types[self.canonical(channel)] = cast(ChannelType, channel_type)
                if self.client:
                    await self.client.join(channel)
                    if channel_type == "channel_private":
                        await self._confirm_private(channel)
                else:
                    self._hand_to_holder(
                        {
                            "id": uuid4().hex,
                            "action": "join",
                            "channel": channel,
                            "private": "yes"
                            if channel_type == "channel_private"
                            else "no",
                        }
                    )

    async def refresh_channel_types(self, channel_ids: list[str]) -> None:
        if self.client:
            for channel in channel_ids:
                await self.client.command("MODE", channel)

    async def create_channel(
        self, name: str, topic: str, *, channel_type: ChannelType = "channel_public"
    ) -> str:
        slug = re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")[:25] or "room"
        channel = f"#{slug}-{uuid4().hex[:16]}"
        if self.client is None:
            self._hand_to_holder(
                {
                    "id": uuid4().hex,
                    "action": "create",
                    "channel": channel,
                    "topic": plain(topic).replace("\n", " ")[:200],
                    "private": "yes" if channel_type != "channel_public" else "no",
                }
            )
        else:
            await self._create_exact(channel, topic, channel_type != "channel_public")
        return channel

    async def _confirm_private(self, channel: str) -> None:
        client = self.client
        assert client is not None
        key = self.canonical(channel)
        self._unusable_channels.add(key)
        created = key in client.created_channels
        if created:
            await client.command("MODE", channel, "+si")
        await client.query_modes(channel)
        confirmed = (
            {"s", "i"} <= client.modes.get(key, set())
            if created
            else client.private(channel)
        )
        if not confirmed:
            raise BridgeOperationError(
                "IRC did not confirm the channel's private modes. Messages to this channel are blocked."
            )
        self._unusable_channels.discard(key)

    async def _create_exact(self, channel: str, topic: str, private: bool) -> None:
        assert self.client is not None
        key = self.canonical(channel)
        self._creating.add(key)
        try:
            if private:
                self._unusable_channels.add(key)
            await self.client.join(channel)
            if key not in self.client.created_channels:
                raise BridgeOperationError(
                    "The IRC channel already exists. Bind it explicitly instead of creating a room over it."
                )
            if private:
                await self._confirm_private(channel)
            if topic:
                await self.client.command(
                    "TOPIC",
                    channel,
                    plain(topic)
                    .replace("\n", " ")
                    .encode()[:200]
                    .decode("utf-8", errors="ignore"),
                )
        finally:
            self._creating.discard(key)

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        refused = []
        for nick, external_id in zip(user_names, user_external_ids, strict=True):
            if not external_id.startswith("account:") or not is_nick(nick):
                refused.append(external_id)
                continue
            if self.client is None:
                self._hand_to_holder(
                    {
                        "id": uuid4().hex,
                        "action": "invite",
                        "channel": channel_id,
                        "nick": nick,
                        "account": external_id,
                    }
                )
                continue
            account = external_id.removeprefix("account:")
            candidates = self.client.account_nicks.get(account, set()) | {nick}
            for candidate in candidates:
                if await self.client.whois_account(candidate) == account:
                    try:
                        await self.client.invite(candidate, channel_id)
                    except (BridgeOperationError, TimeoutError):
                        refused.append(external_id)
                    break
            else:
                refused.append(external_id)
        return refused

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        if is_channel(external_channel_id):
            if self.client:
                await self.client.part(external_channel_id)
            else:
                self._hand_to_holder(
                    {
                        "id": uuid4().hex,
                        "action": "part",
                        "channel": external_channel_id,
                    }
                )
            return RetireOutcome(outcome="left")
        return RetireOutcome(outcome="kept")

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        return None

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        logger.warning(
            "IRC cannot edit messages. Read the current content in Switch Console."
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        logger.warning("IRC cannot delete messages from channel history.")

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        ref = await super().post_rich(channel_id, agent_name, content, thread_root_id)
        self._remember_state(ref, self._rich_state(content))
        return ref

    def _rich_state(self, content: RichContent) -> str:
        return (
            content.request.state
            if isinstance(content, RequestCard)
            else content.turn.status
        )

    def _remember_state(self, ref: str, state: str) -> None:
        self._rendered_states[ref] = state
        self._rendered_states.move_to_end(ref)
        if len(self._rendered_states) > 1000:
            self._rendered_states.popitem(last=False)

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        state = self._rich_state(content)
        terminal = (
            state in ("resolved", "closed")
            if isinstance(content, RequestCard)
            else state in TURN_ENDED
        )
        if terminal and self._rendered_states.get(message_ref) != state:
            await super().post_rich(channel_id, agent_name, content, thread_root_id)
            self._remember_state(message_ref, state)

    def rich_fallback_text(self, content: RichContent) -> str:
        if isinstance(content, TurnActivity):
            return turn_state(content.items, content.turn, tool_detail=False)
        return super().rich_fallback_text(content)

    def rich_markup(self) -> Markup:
        return IRC_MARKUP

    def _render_outbound(self, content: str) -> str:
        return render(content)

    def translate_inbound(self, raw_message: str) -> str:
        return plain(raw_message)
