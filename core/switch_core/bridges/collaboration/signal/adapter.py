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

import re
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import urlsplit

import httpx
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
)

# The Signal number a connection acts as: E.164, 7 to 15 digits.
_ACCOUNT_RE = re.compile(r"^\+[1-9]\d{6,14}$")

# The JSON-RPC error codes the daemon reports, as probed on 0.14.9: -32602 is
# "the account is not on this daemon", a credential problem; -32600 is a request
# this client built wrong; any other code is the platform refusing an operation.
RPC_ACCOUNT_NOT_ON_DAEMON = -32602
RPC_INVALID_REQUEST = -32600


class SignalRpcError(BridgeOperationError):
    """A JSON-RPC `error` result, classified by its code, never its message.

    The code is what the classification keys on: the daemon's wording is free
    text, and this has to be answerable without reading it.
    """

    def __init__(self, code: int, message: str) -> None:
        super().__init__(f"signal-cli refused the request ({code}): {message}")
        self.code = code


def _json_rpc_body(response: httpx.Response) -> dict[str, Any]:
    """Parse a JSON-RPC response body, refusing anything that is not one."""
    try:
        body = response.json()
    except ValueError as exc:
        raise BridgeOperationError(
            f"The daemon answered without a JSON-RPC body (HTTP {response.status_code})"
        ) from exc
    if not isinstance(body, dict):
        raise BridgeOperationError(
            "The daemon answered with a JSON-RPC body that is not an object"
        )
    return body


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

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        url = connection_config.get("daemon_url")
        return [str(url)] if url else []

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Check the configured account is actually on that daemon.

        The cheap authenticated call is `listAccounts`: the daemon's own JSON-RPC
        answers for every other method, so a wrong address shows up here as a
        connection error, and a number that is not registered on that daemon is
        the one error case worth naming to the operator.
        """
        config = SignalConnectionConfig.model_validate(connection_config)
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                response = await client.post(
                    config.daemon_url.rstrip("/") + "/api/v1/rpc",
                    json={"jsonrpc": "2.0", "id": 1, "method": "listAccounts"},
                )
            except httpx.HTTPError as exc:
                raise BridgeCredentialError(
                    f"Could not reach the signal-cli daemon at {config.daemon_url}: "
                    f"{exc or type(exc).__name__}. Check the address and that the "
                    "daemon is running."
                ) from exc
        body = _json_rpc_body(response)
        error = body.get("error")
        if error is not None:
            code = error.get("code")
            message = error.get("message", "no reason given")
            if code == RPC_ACCOUNT_NOT_ON_DAEMON:
                raise BridgeCredentialError(
                    f"No account {config.account!r} on that daemon: {message}. "
                    "Register the number on this daemon, or point the bridge at "
                    "the one that holds it."
                )
            # `listAccounts` takes no params, so -32600 is a client bug (ours),
            # and anything else is the daemon refusing the call.
            raise BridgeOperationError(
                f"The daemon refused the request ({code}): {message}."
            )
        accounts = body.get("result") or []
        numbers = {
            str(account.get("number")) for account in accounts if account.get("number")
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

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        raise NotImplementedError

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        raise NotImplementedError

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        raise NotImplementedError

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        raise NotImplementedError

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
        raise NotImplementedError

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        raise NotImplementedError

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        raise NotImplementedError

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        raise NotImplementedError

    # One Signal account cannot have per-agent names or avatars, so an agent's
    # identity is carried by its name in the message text instead.
    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message
