"""Zulip as a messaging platform: a bot on the operator's own organisation,
reached entirely over REST — there is no socket and no webhook. Receiving
events means long-polling Zulip's event queue (`/register` + `/events`),
which only the pod holding this bridge's lease does; every pod can still
send, since that is a plain REST call.

**Mapping.** A channel (Zulip calls it a "stream") is a room; its topics are
threads. `channel_id` is `stream:<id>` — the id survives a rename, the name
does not. A thread's `root_id` is `topic:<name>` — not a message id, the way
Telegram's forum-topic threads are not one either (see
`telegram/adapter.py:_root_id_of`): a topic is already a stable, named thing
on Zulip, so there is nothing to resolve. A message posted outside any topic
goes to the connection's **new_topic**. Renaming a topic on Zulip starts a
new Switch thread, because the two topic names are different `root_id`
strings; this is declared in the docs page rather than hidden.

A direct message conversation has no topic, so it has no thread:
`channel_id` is `dm:<sorted user ids>` and every reply in it is top-level.

**Restarts lose and duplicate nothing, with no state kept in Switch.** The
bot's messages are marked read only once the room has them. Every time a
queue is opened — on `start`, after Zulip expires one (`BAD_EVENT_QUEUE_ID`),
or because this pod just took the lease — it first catches up on whatever is
still unread, oldest first, then opens the live queue. Zulip keeps the read
flag on its own server, so whichever pod holds the lease next resumes
exactly where the last one left off. `message_ref` is Zulip's own message
id, so the queue returning a message the catch-up already delivered — and the
reverse — writes nothing twice.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

from pydantic import field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    AgentIdentity,
    PlatformAdapter,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelRetirement,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.session.renderers import Markup
from switch_core.bridges.collaboration.zulip.chunking import (
    defuse_wildcard_mentions,
    split_to_chunks,
    translate_mentions_inbound,
)
from switch_core.bridges.collaboration.zulip.client import (
    BadEventQueueId,
    ZulipApiError,
    ZulipClient,
    ZulipRateLimited,
    ZulipSiteInvalid,
    classify_zulip_exception,
    normalize_site_url,
)

logger = logging.getLogger(__name__)

INITIAL_BACKOFF = 2.0
MAX_BACKOFF = 30.0
CATCH_UP_BATCH = 100
_WORKING_EMOJI = "eyes"
_QUEUED_EMOJI = "hourglass_flowing_sand"


class ZulipConnectionConfig(BridgeConnectionConfig):
    #: The organisation's base URL, e.g. `https://your-org.zulipchat.com`.
    site: str
    bot_email: str
    api_key: str
    #: Where a message posted outside any topic goes — Zulip requires every
    #: stream message to have one, and a reply to a room-level event (an
    #: approval card with no triggering topic, say) is such a message.
    new_topic: str = "Switch"

    @field_validator("site")
    @classmethod
    def _site_is_a_usable_https_url(cls, value: str) -> str:
        try:
            return normalize_site_url(value)
        except ZulipSiteInvalid as exc:
            raise ValueError(str(exc)) from exc


def _channel_id_for_stream(stream_id: int) -> str:
    return f"stream:{stream_id}"


def _channel_id_for_dm(user_ids: list[int]) -> str:
    return f"dm:{','.join(str(u) for u in sorted(set(user_ids)))}"


def _root_id_for_topic(topic: str) -> str:
    return f"topic:{topic}"


def _topic_from_root_id(root_id: str | None, default: str) -> str:
    if root_id is not None and root_id.startswith("topic:"):
        return root_id.removeprefix("topic:")
    return default


class _ZulipMarkup(Markup):
    def bold(self, text: str) -> str:
        return f"**{text}**"


_ZULIP_MARKUP = _ZulipMarkup()


class ZulipAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Zulip"
    docs_slug: ClassVar[str | None] = None

    keeps_quiet_unless_listening: ClassVar[bool] = True
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    draws_session_activity: ClassVar[bool] = True
    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = True
    activity_reactions_per_agent: ClassVar[bool] = False
    channel_on_delete: ClassVar[ChannelRetirement] = "left"
    channel_mention: ClassVar[str | None] = "@**all**"

    def __init__(self, *, config: ZulipConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._client: ZulipClient | None = None
        self._bot_user_id: int | None = None
        self._bot_email: str = config.bot_email
        self._max_message_length = 10000
        self._max_file_upload_bytes = 25 * 1024 * 1024
        self._poll_task: asyncio.Task[None] | None = None
        self._stopped = False
        # channel_id -> whether it is a stream Switch may bind rooms to at
        # all (private streams are bindable; this just distinguishes public
        # from private for get_channel_type, both of which are).
        self._stream_private: dict[int, bool] = {}

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = ZulipConnectionConfig.model_validate(connection_config)
        client = ZulipClient(
            site=config.site,
            bot_email=config.bot_email,
            api_key=config.api_key,
            outbound_policy=None,
        )
        try:
            me = await client.get_own_user()
        except ZulipApiError as exc:
            raise BridgeCredentialError(
                f"Zulip refused these credentials: {exc}"
            ) from exc
        except Exception as exc:
            raise BridgeCredentialError(
                f"Could not reach {config.site} to check these credentials: {exc}. Try again."
            ) from exc
        finally:
            await client.aclose()
        if not me.get("is_bot", False):
            raise BridgeCredentialError(
                "This is a person's account, not a bot. Create a bot under "
                "Personal settings → Bots and use its email and API key."
            )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        reason = classify_zulip_exception(exc)
        return reason  # type: ignore[return-value]

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        config = ZulipConnectionConfig.model_validate(connection_config)
        return [config.site]

    # ── Lifecycle ────────────────────────────────────────────────────────

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

        self._client = ZulipClient(
            site=self._config.site,
            bot_email=self._config.bot_email,
            api_key=self._config.api_key,
            outbound_policy=self.outbound_policy,
        )
        me = await self._client.get_own_user()
        self._bot_user_id = me["user_id"]

        if not self._listening:
            logger.info(
                "Zulip adapter running quietly: another process holds this "
                "bridge's event queue. REST calls (sending, reacting, …) "
                "still go through this process."
            )
            return

        self._poll_task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stopped = True
        if self._poll_task is not None:
            self._poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._poll_task
            self._poll_task = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _require_client(self) -> ZulipClient:
        if self._client is None:
            raise RuntimeError("Zulip adapter is not started")
        return self._client

    async def _run(self) -> None:
        backoff = INITIAL_BACKOFF
        while not self._stopped:
            try:
                client = self._require_client()
                await self._catch_up(client)
                queue = await client.register_queue()
                self._max_message_length = queue.max_message_length
                self._max_file_upload_bytes = int(
                    queue.max_file_upload_size_mib * 1024 * 1024
                )
                backoff = INITIAL_BACKOFF
                await self._poll(client, queue.queue_id, queue.last_event_id)
            except asyncio.CancelledError:
                raise
            except BadEventQueueId:
                logger.info("Zulip event queue expired; re-registering and catching up")
                continue
            except Exception as exc:
                if self._stopped:
                    return
                jitter = random.uniform(0, backoff * 0.25)
                logger.warning(
                    "Zulip polling failed (%s); retrying in %.1fs",
                    exc,
                    backoff + jitter,
                )
                await asyncio.sleep(backoff + jitter)
                backoff = min(backoff * 2, MAX_BACKOFF)

    async def _poll(
        self, client: ZulipClient, queue_id: str, last_event_id: int
    ) -> None:
        while not self._stopped:
            try:
                events = await client.get_events(
                    queue_id=queue_id, last_event_id=last_event_id
                )
            except ZulipRateLimited as exc:
                await asyncio.sleep(exc.retry_after)
                continue
            for event in events:
                last_event_id = max(last_event_id, event["id"])
                await self._handle_event(client, event)

    async def _catch_up(self, client: ZulipClient) -> None:
        """Deliver whatever is still unread, oldest first, marking each
        read only after it was handed to the room — so a crash mid-catch-up
        is caught up again, never skipped, on the next attempt."""
        anchor: int | str = "oldest"
        while True:
            messages, found_newest = await client.get_unread_messages(
                anchor=anchor, num_after=CATCH_UP_BATCH
            )
            if not messages:
                return
            for message in messages:
                await self._deliver_message(message)
            await client.mark_read([m["id"] for m in messages])
            if found_newest:
                return
            anchor = messages[-1]["id"]

    async def _handle_event(self, client: ZulipClient, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        if event_type == "message":
            message = event["message"]
            await self._deliver_message(message)
            await client.mark_read([message["id"]])
        elif event_type in (
            "reaction",
            "update_message",
            "delete_message",
            "heartbeat",
        ):
            # Switch's adapter interface has no inbound edit/delete/reaction
            # contract yet, for any platform — there is no callback to call
            # with one even though Zulip delivers it. heartbeat needs only
            # last_event_id, already updated by the caller.
            return

    async def _deliver_message(self, message: dict[str, Any]) -> None:
        sender_id: int = message["sender_id"]
        if sender_id == self._bot_user_id:
            return  # our own post, echoed back by the catch-up or the queue
        content = translate_mentions_inbound(str(message.get("content", "")))
        sender_name = str(message.get("sender_full_name", ""))
        message_ref = str(message["id"])
        message_type = message.get("type")

        if message_type == "stream":
            channel_id = _channel_id_for_stream(int(message["stream_id"]))
            topic = str(message.get("subject", ""))
            root_id = _root_id_for_topic(topic)
            channel_name = topic
        else:
            recipients = message.get("display_recipient")
            participants = (
                [int(r["id"]) for r in recipients]
                if isinstance(recipients, list)
                else [sender_id]
            )
            # The channel id names the *other* side of the conversation —
            # excluding the bot's own id keeps a 1:1 DM's id stable
            # regardless of which bot account is reading it, and is what
            # `get_channel_type` counts to tell "direct" from "group".
            user_ids = [uid for uid in participants if uid != self._bot_user_id]
            channel_id = _channel_id_for_dm(user_ids)
            root_id = None
            channel_name = None

        command = _parse_command(content)
        if command is not None and self._on_command is not None:
            name, args = command
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type="direct"
                    if message_type != "stream"
                    else "channel_public",
                    sender_id=str(sender_id),
                    sender_name=sender_name,
                    command=name,
                    args=args,
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return
        if self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    channel_id=channel_id,
                    channel_type="direct"
                    if message_type != "stream"
                    else "channel_public",
                    sender_id=str(sender_id),
                    sender_name=sender_name,
                    content=content,
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )

    # ── Outbound ─────────────────────────────────────────────────────────

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
        body = f"**{sender_name}**\n{content}"
        chunks = split_to_chunks(body, max_length=self._max_message_length)
        last_id: int | None = None
        kind, target = _parse_channel_id(channel_id)
        for chunk in chunks:
            if kind == "stream":
                topic = _topic_from_root_id(thread_root_id, self._config.new_topic)
                last_id = await client.send_stream_message(
                    stream_id=target[0], topic=topic, content=chunk
                )
            else:
                last_id = await client.send_direct_message(
                    user_ids=target, content=chunk
                )
        return str(last_id) if last_id is not None else None

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        client = self._require_client()
        await client.update_message(int(message_ref), content=new_content)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        client = self._require_client()
        await client.delete_message(int(message_ref))

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        client = self._require_client()
        kind, target = _parse_channel_id(channel_id)
        if kind != "stream":
            return
        try:
            await client.set_typing(
                stream_id=target[0], topic=self._config.new_topic, started=is_typing
            )
        except ZulipApiError:
            pass  # cosmetic; never fail a turn over a typing indicator

    async def mark_activity(
        self,
        channel_id: str,
        message_ref: str,
        *,
        agent_name: str,
        mark: ActivityMark,
        on: bool,
        force: bool = False,
    ) -> None:
        client = self._require_client()
        emoji = _WORKING_EMOJI if mark == "working" else _QUEUED_EMOJI
        message_id = int(message_ref)
        if on:
            await client.add_reaction(message_id, emoji_name=emoji)
        else:
            await client.remove_reaction(message_id, emoji_name=emoji)

    async def send_attachment(
        self,
        channel_id: str,
        sender_name: str,
        filename: str,
        mimetype: str,
        data: bytes,
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        client = self._require_client()
        if len(data) > self._max_file_upload_bytes:
            note = (
                f"_tried to send **{filename}** ({len(data)} bytes), over this "
                f"organisation's {self._max_file_upload_bytes} byte limit — not sent_"
            )
            return await self.send_message(
                channel_id, sender_name, note, thread_root_id
            )
        url = await client.upload_file(filename=filename, mimetype=mimetype, data=data)
        body = f"[{filename}]({url})" + (f"\n{caption}" if caption else "")
        return await self.send_message(channel_id, sender_name, body, thread_root_id)

    # ── Channels ─────────────────────────────────────────────────────────

    async def create_channel(
        self, name: str, topic: str, *, channel_type: ChannelType = "channel_public"
    ) -> str:
        client = self._require_client()
        await client.create_stream(
            name,
            description=topic,
            invite_only=channel_type == "channel_private",
            principals=[],
        )
        stream_id = await client.stream_id_by_name(name)
        if stream_id is None:
            raise BridgeOperationError(
                f"Zulip did not report a stream named {name!r} after creating it"
            )
        return _channel_id_for_stream(stream_id)

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        kind, target = _parse_channel_id(channel_id)
        if kind != "stream":
            return "direct" if len(target) == 1 else "group"
        return (
            "channel_private"
            if self._stream_private.get(target[0], False)
            else "channel_public"
        )

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        client = self._require_client()
        kind, target = _parse_channel_id(channel_id)
        if kind != "stream":
            return list(user_external_ids)
        name = await client.stream_name_by_id(target[0])
        if name is None:
            return list(user_external_ids)
        user_ids = [int(uid) for uid in user_external_ids]
        failed = await client.add_users_to_stream(name, user_ids)
        return [str(uid) for uid in failed]

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        kind, target = _parse_channel_id(external_channel_id)
        if kind != "stream":
            return RetireOutcome(outcome="left")
        client = self._require_client()
        try:
            name = await client.stream_name_by_id(target[0])
            if name is None:
                return RetireOutcome(outcome="left")  # already gone
            await client.unsubscribe(name)
        except Exception as exc:
            return RetireOutcome.failed(str(exc))
        return RetireOutcome(outcome="left")

    # ── Translation ──────────────────────────────────────────────────────

    def rich_markup(self) -> Markup:
        return _ZULIP_MARKUP

    def _render_outbound(self, content: str) -> str:
        return defuse_wildcard_mentions(content)

    def translate_inbound(self, raw_message: str) -> str:
        return translate_mentions_inbound(raw_message)


def _parse_channel_id(channel_id: str) -> tuple[str, list[int]]:
    kind, _, rest = channel_id.partition(":")
    if kind == "stream":
        return "stream", [int(rest)]
    if kind == "dm":
        return "dm", [int(x) for x in rest.split(",") if x]
    raise ValueError(f"Not a Zulip channel id: {channel_id!r}")


def _parse_command(text: str) -> tuple[str, str] | None:
    stripped = text.strip()
    if not stripped.startswith("!"):
        return None
    parts = stripped.split(None, 1)
    command = parts[0].lstrip("!")
    args = parts[1].strip() if len(parts) > 1 else ""
    return command, args
