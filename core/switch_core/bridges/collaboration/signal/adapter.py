"""The Signal adapter: a user-run signal-cli daemon's HTTP JSON-RPC and SSE.

The operator runs `signal-cli daemon --http <host>:8080 --receive-mode on-start`
for their registered Signal number, and Switch connects to it. Inbound events
arrive over the daemon's SSE stream (`GET /api/v1/events`); every outbound call
goes through the JSON-RPC endpoint (`POST /api/v1/rpc`).

The adapter keeps no state another pod or a restart needs: the SSE connection
runs only on the pod holding the bridge lease, and every identifier it hands
to Switch encodes what signal-cli needs to act on it — `g:<base64 groupId>`
for a group, `d:<source uuid>` for a DM, and `<author>:<timestamp>` for a
message (Signal identifies one by the author that sent it and when).
"""

from __future__ import annotations

import base64
import re
from collections.abc import Awaitable, Callable
from typing import ClassVar
from urllib.parse import urlsplit

from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.signal.render import (
    render_markdown,
    strip_markers,
)
from switch_core.bridges.collaboration.signal.rpc import SignalRpcClient

# The Signal number a connection acts as: E.164, 7 to 15 digits.
_ACCOUNT_RE = re.compile(r"^\+[1-9]\d{6,14}$")

# Signal's own attachment ceiling. The daemon accepts `data:` URIs up to the
# protocol limit (100 MB); refusing above it early keeps the reason with the
# operator rather than as a 100 MB upload that dies at the Signal server.
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024


class SignalConnectionConfig(BridgeConnectionConfig):
    """A connection to one account on a signal-cli daemon."""

    daemon_url: str = Field(
        description=(
            "The signal-cli daemon's HTTP address, as the server reaches it, "
            "for example http://127.0.0.1:8080. The daemon has no "
            "authentication, so it must only be reachable on a private "
            "network."
        ),
    )
    account: str = Field(
        description=(
            "The Signal number this bridge acts as, in E.164 form, for "
            "example +15555550100."
        ),
    )

    @field_validator("daemon_url")
    @classmethod
    def _daemon_url_has_a_scheme_and_no_path(cls, url: str) -> str:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https"):
            raise ValueError(
                "must start with http:// or https:// — "
                f"the daemon has no other transport ({url!r})"
            )
        if not parts.netloc:
            raise ValueError(f"must name a host to reach the daemon ({url!r})")
        if parts.path not in ("", "/"):
            raise ValueError(
                "is the daemon's base address; the JSON-RPC and event paths "
                f"are appended by Switch, so no path ({url!r})"
            )
        return url

    @field_validator("account")
    @classmethod
    def _account_is_e164(cls, account: str) -> str:
        if not _ACCOUNT_RE.fullmatch(account):
            raise ValueError(
                "must be a Signal number in E.164 form: a leading +, then 7 "
                "to 15 digits starting non-zero"
            )
        return account


class SignalAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Signal"
    # The daemon's SSE stream is the one long-lived connection, so quiet pods
    # open nothing the platform delivers over; only the lease holder listens.
    keeps_quiet_unless_listening: ClassVar[bool] = True
    # The bot can only name people who have messaged it.
    supports_directory_search: ClassVar[bool] = False
    # Signal linkifies only http(s), so a switchdash:// deeplink cannot work.
    renders_custom_url_schemes: ClassVar[bool] = False
    # v1 cannot create a chat from Switch; one is opened on the phone and the
    # bot is added there.
    supports_channel_creation: ClassVar[bool] = False

    def __init__(self, *, config: SignalConnectionConfig) -> None:
        super().__init__()
        self.config = config
        # Lazily built on first send, closed by `stop`. A test pre-seeds this
        # with a `SignalRpcClient` on an `httpx.MockTransport` to drive the
        # outbound calls without a live daemon.
        self._rpc_client: SignalRpcClient | None = None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        url = connection_config.get("daemon_url")
        return [str(url)] if url else []

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Check the configured account is actually on that daemon.

        The cheap authenticated call is `listAccounts`. The call's transport
        errors are left to surface as themselves: an unreachable daemon is a
        `network` failure, not a credential one, and wrapping it here would
        read as `auth_failed` in telemetry and tell the operator the wrong
        thing. The credential errors are the daemon's own answer: it reports
        that the account is not one it holds, or holds a different set.
        """
        config = SignalConnectionConfig.model_validate(connection_config)
        client = SignalRpcClient(daemon_url=config.daemon_url, account=config.account)
        try:
            accounts = await client.call("listAccounts")
        finally:
            await client.aclose()
        numbers = {
            str(account.get("number"))
            for account in (accounts or [])
            if isinstance(account, dict) and account.get("number")
        }
        if config.account not in numbers:
            raise BridgeCredentialError(
                f"The daemon does not hold the account {config.account!r}. It "
                "registers these instead: "
                f"{', '.join(sorted(numbers)) if numbers else 'none'}."
            )

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        raise NotImplementedError

    async def stop(self) -> None:
        raise NotImplementedError

    # ── Channel and message identifiers ─────────────────────────────────────

    def _message_ref(self, result: dict[str, object]) -> str:
        """The switch-side ref of an accepted `send`: the account that sent it
        and Signal's own timestamp. The same ref comes back on a redelivery,
        so it dedupes, and it is exactly what edit, delete and react take."""
        return f"{self.config.account}:{result['timestamp']}"

    @staticmethod
    def _parse_message_ref(message_ref: str) -> tuple[str, int]:
        author, _, timestamp = message_ref.partition(":")
        return author, int(timestamp)

    @staticmethod
    def _chat_target(channel_id: str) -> dict[str, object]:
        """The `send` param that addresses a chat, from the channel id.

        `g:<groupId>` is the group's base64 id; `d:<uuid>` is the peer's
        account id. Anything else is a channel this connection can address
        no chat by, so it is raised rather than guessed.
        """
        if channel_id.startswith("g:"):
            return {"groupId": channel_id[2:]}
        if channel_id.startswith("d:"):
            return {"recipient": [channel_id[2:]]}
        raise BridgeOperationError(
            f"Signal channel {channel_id!r} is not a group (`g:…`) or a "
            "direct chat (`d:…`)"
        )

    @staticmethod
    def _attribute(sender_name: str, body: str) -> str:
        """One Signal number posts for every agent, so the name is the only
        thing that tells them apart: it rides at the head of the text, in the
        bold marker `strip_markers` will turn into a BOLD range. No name, or
        an empty body, changes nothing."""
        if not sender_name:
            return body
        marker = f"**{sender_name}**"
        if not body:
            return marker
        return f"{marker}\n{body}" if "\n" in body else f"{marker}: {body}"

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post `content` as `sender_name`, carrying its styles out.

        The content arrives rendered — mass mentions defused, links rewritten
        — so the emphasis markers it still carries are the last thing to
        translate into Signal's `textStyle` ranges, on the final string. The
        sender's name is not part of the platform's address (one number posts
        for every agent), so it is written into the text in bold. A
        `thread_root_id` becomes the quote's author and timestamp; the ref is
        the reply's own, so a later edit of it targets the reply, not the root.
        """
        text, styles = strip_markers(self._attribute(sender_name, content))
        params: dict[str, object] = {"message": text}
        if styles:
            params["textStyle"] = styles
        params.update(self._chat_target(channel_id))
        if thread_root_id is not None:
            author, timestamp = self._parse_message_ref(thread_root_id)
            params["quoteAuthor"] = author
            params["quoteTimestamp"] = timestamp
        result = await self._rpc().call("send", **params)
        return self._message_ref(result)

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        """Edit one of this connection's posts: the same `send`, the ref's
        timestamp as `editTimestamp`. Signal allows the edit within about a
        day; past that the daemon refuses it, and the refusal is the platform
        saying so, not a bug, so it goes up as an operation error."""
        _, target = self._parse_message_ref(message_ref)
        text, styles = strip_markers(new_content)
        params: dict[str, object] = {
            "message": text,
            "editTimestamp": target,
        }
        if styles:
            params["textStyle"] = styles
        params.update(self._chat_target(channel_id))
        await self._rpc().call("send", **params)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        """Withdraw one of this connection's posts for everyone it reached."""
        _, target = self._parse_message_ref(message_ref)
        await self._rpc().call(
            "remoteDelete", targetTimestamp=target, **self._chat_target(channel_id)
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        """Signal's typing indicator is fire-and-forget — it dies after a few
        seconds, so a start is a plain `sendTyping` and a stop is the same
        call with `stop` set, the only control the daemon offers."""
        params: dict[str, object] = {}
        if not is_typing:
            params["stop"] = True
        params.update(self._chat_target(channel_id))
        await self._rpc().call("sendTyping", **params)

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
        """The file out as a `data:` URI on one `send`, the caption as its
        text. The cap is the Signal protocol's, not a daemon convenience: a
        file above it would upload and then die at the server, so it is
        refused here, in the room's words, instead."""
        if len(data) > MAX_ATTACHMENT_BYTES:
            raise BridgeOperationError(
                f"{filename} is {len(data):,} bytes; Signal attachments cap "
                f"at {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB"
            )
        params: dict[str, object] = {
            "attachments": [
                f"data:{mimetype};filename={filename};"
                f"base64,{base64.b64encode(data).decode('ascii')}"
            ]
        }
        if caption is not None:
            text, styles = strip_markers(caption)
            params["message"] = text
            if styles:
                params["textStyle"] = styles
        if thread_root_id is not None:
            author, timestamp = self._parse_message_ref(thread_root_id)
            params["quoteAuthor"] = author
            params["quoteTimestamp"] = timestamp
        params.update(self._chat_target(channel_id))
        result = await self._rpc().call("send", **params)
        return self._message_ref(result)

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Several files as one `send`: Signal carries them together and the
        ref is the one post's. The cap is per file, as it is on Signal
        itself, so one over it refuses the batch with a visible failure."""
        attachments = [
            f"data:{file.mimetype};filename={file.filename};"
            f"base64,{base64.b64encode(file.data).decode('ascii')}"
            for file in files
        ]
        for file in files:
            if len(file.data) > MAX_ATTACHMENT_BYTES:
                raise BridgeOperationError(
                    f"{file.filename} is {len(file.data):,} bytes; Signal "
                    f"attachments cap at "
                    f"{MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB"
                )
        params: dict[str, object] = {"attachments": attachments}
        if caption is not None:
            text, styles = strip_markers(caption)
            params["message"] = text
            if styles:
                params["textStyle"] = styles
        if thread_root_id is not None:
            author, timestamp = self._parse_message_ref(thread_root_id)
            params["quoteAuthor"] = author
            params["quoteTimestamp"] = timestamp
        params.update(self._chat_target(channel_id))
        result = await self._rpc().call("send", **params)
        return self._message_ref(result)

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "Signal cannot create a chat from Switch; open it on the phone "
            "and add the bot there."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct" if channel_id.startswith("d:") else "group"

    # One Signal number posts for every agent, so an agent has no handle to
    # add to a chat and nothing to add: the room is already addressed by the
    # chat id.
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
        """No way through the daemon to add people to a Signal group, so
        every one named is left out and named here: the caller discloses it,
        and the room is still created rather than abandoned over the gap."""
        return list(user_external_ids)

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    def _rpc(self) -> SignalRpcClient:
        client = getattr(self, "_rpc_client", None)
        if client is None:
            client = SignalRpcClient(
                daemon_url=self.config.daemon_url, account=self.config.account
            )
            self._rpc_client = client
        return client

    # One Signal account cannot have per-agent names or avatars, so an agent's
    # identity is carried by its name in the message text instead.
    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    def _render_outbound(self, content: str) -> str:
        # The markers this returns are stripped into `textStyle` ranges on the
        # final, defused string — in `send_message` and friends, never here.
        return render_markdown(content)

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message
