"""Installing the distributed Telegram app into a customer's chats.

The counterpart to `TELEGRAM_SETUP.md`'s self-registered bot, and a different
bot from it. See `docs/old/bridges/TELEGRAM_DISTRIBUTED_APP.md` for the design.

Telegram has no OAuth, so the install half of `MessagingAppInstaller` is mostly
absent here. What stands in for it is a **claim**: the link Switch hands out is
`t.me/<bot>?startgroup=<state>`, and adding the bot through it makes Telegram
post `/start@<bot> <state>` into the chat. A channel sends no `/start`, so a
channel admin posts `/connect <state>` instead. Either arrives as an ordinary
webhook event, and `claim_of_event` is what reads it.

The webhook half is Telegram's own and simpler than Slack's: no body signature,
only a secret Telegram echoes back in a header, which `setWebhook` gave it.
"""

from __future__ import annotations

import hmac
import json
from collections.abc import Mapping
from typing import Any, ClassVar

from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    InstallClaim,
    InstallGrant,
    MessagingAppInstaller,
    MessagingInstallError,
    WebhookAuthenticityError,
    WebhookEndpoint,
    WebhookPayloadError,
)
from switch_core.bridges.collaboration.telegram.app_client import TelegramAppClient

#: The header Telegram carries `setWebhook`'s `secret_token` back in.
SECRET_TOKEN_HEADER = "X-Telegram-Bot-Api-Secret-Token"

#: The commands that carry a claim: Telegram's own handshake for a group added
#: through the link, and the one a channel admin types.
_CLAIM_COMMANDS = frozenset({"start", "connect"})

#: The name the tenant's one Telegram bridge is registered under.
_BRIDGE_NAME = "Telegram"

_REMOVED_STATUSES = frozenset({"left", "kicked"})


def _as_dict(value: object) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _message_of(payload: Mapping[str, object]) -> dict[str, Any] | None:
    """The message an update carries, if it carries one.

    A group's message and a channel's post are the same object under two keys;
    a button press carries the message the button was on.
    """
    for key in ("message", "channel_post"):
        message = _as_dict(payload.get(key))
        if message is not None:
            return message
    callback = _as_dict(payload.get("callback_query"))
    if callback is not None:
        return _as_dict(callback.get("message"))
    return None


def _chat_of(payload: Mapping[str, object]) -> dict[str, Any] | None:
    member = _as_dict(payload.get("my_chat_member"))
    if member is not None:
        return _as_dict(member.get("chat"))
    message = _message_of(payload)
    return _as_dict(message.get("chat")) if message is not None else None


class TelegramAppInstaller(MessagingAppInstaller):
    platform: ClassVar[str] = "telegram"
    # Every update goes to the one URL `setWebhook` names.
    webhook_endpoints: ClassVar[frozenset[WebhookEndpoint]] = frozenset({"events"})
    state_format = "compact"

    def __init__(self, *, client: TelegramAppClient, webhook_secret: str) -> None:
        self._client = client
        self._webhook_secret = webhook_secret.encode()

    def authorize_url(self, *, state: str, redirect_uri: str) -> str:
        """The link that adds the bot to a group and claims it.

        `redirect_uri` is unused: nothing redirects. Telegram opens the chat
        picker, adds the bot, and posts the state into the chat it was added to.
        """
        return f"https://t.me/{self._client.bot_username}?startgroup={state}"

    async def redeem(self, *, code: str, redirect_uri: str) -> InstallGrant:
        raise MessagingInstallError(
            "Telegram has no OAuth leg; a Telegram install is claimed from a chat"
        )

    async def revoke(self, *, bot_token: str) -> None:
        raise MessagingInstallError(
            "a Telegram install holds no token of its own to revoke"
        )

    async def verify_webhook(
        self,
        *,
        endpoint: WebhookEndpoint,
        headers: Mapping[str, str],
        query: Mapping[str, str],
        body: bytes,
    ) -> None:
        """Compare the echoed secret, in constant time.

        The whole of Telegram's authenticity story: it signs nothing, so a post
        without the secret is indistinguishable from anyone who found the URL.
        """
        presented = next(
            (
                value
                for name, value in headers.items()
                if name.lower() == SECRET_TOKEN_HEADER.lower()
            ),
            None,
        )
        if presented is None:
            raise WebhookAuthenticityError("the Telegram secret-token header is absent")
        if not hmac.compare_digest(presented.encode(), self._webhook_secret):
            raise WebhookAuthenticityError("the Telegram secret token does not match")

    def parse_webhook(
        self,
        *,
        endpoint: WebhookEndpoint,
        headers: Mapping[str, str],
        query: Mapping[str, str],
        body: bytes,
    ) -> list[InboundWebhook]:
        """One update. `update_id` is what receipts deduplicate retries by.

        Telegram says nothing about how often it has retried, so the attempt
        count is always zero; a retry is still caught by its `update_id`.
        """
        if endpoint != "events":
            raise WebhookPayloadError(
                f"Telegram delivers every update to /events, not /{endpoint}"
            )
        try:
            payload = json.loads(body)
        except ValueError as exc:
            raise WebhookPayloadError("a Telegram update is not JSON") from exc
        if not isinstance(payload, dict) or not isinstance(
            payload.get("update_id"), int
        ):
            raise WebhookPayloadError("a Telegram update carries no update_id")
        return [
            InboundWebhook(
                envelope_type=endpoint,
                payload=payload,
                handshake=None,
                external_event_id=str(payload["update_id"]),
                delivery_attempt=0,
                answers_inline=False,
            )
        ]

    def workspace_of_event(self, payload: Mapping[str, object]) -> str:
        """The chat an update belongs to.

        For the first message of a chat that has just become a supergroup,
        that is the chat it *was*. Its new id is owned by nobody until the
        install row follows it, and the old id is how the event finds the
        tenant that has to do the following.
        """
        message = _message_of(payload)
        if message is not None and message.get("migrate_from_chat_id") is not None:
            return str(message["migrate_from_chat_id"])
        chat = _chat_of(payload)
        if chat is None or chat.get("id") is None:
            raise WebhookPayloadError("a Telegram update names no chat")
        return str(chat["id"])

    def revocation_of_event(self, payload: Mapping[str, object]) -> str | None:
        """The bot leaving or being removed from a chat ends that chat's install.

        `my_chat_member` is only ever about the bot itself, so its new status is
        the whole answer.
        """
        member = _as_dict(payload.get("my_chat_member"))
        if member is None:
            return None
        status = (_as_dict(member.get("new_chat_member")) or {}).get("status")
        if status not in _REMOVED_STATUSES:
            return None
        return f"the bot was removed from the chat ({status})"

    def claim_of_event(self, payload: Mapping[str, object]) -> InstallClaim | None:
        """`/start <state>` or `/connect <state>` in a group or channel.

        A private chat never claims anything: it has no tenant to belong to,
        and account linking by DM is a separate, deferred feature. A command
        addressed to a different bot — `/start@otherbot …`, which a bot with
        privacy off also sees — is not ours to read.
        """
        message = _message_of(payload)
        if message is None:
            return None
        chat = _as_dict(message.get("chat"))
        if chat is None or chat.get("type") == "private" or chat.get("id") is None:
            return None
        text = message.get("text")
        if not isinstance(text, str) or not text.startswith("/"):
            return None

        parts = text.split()
        if len(parts) != 2:
            return None
        command, _, addressee = parts[0][1:].partition("@")
        if command not in _CLAIM_COMMANDS:
            return None
        if addressee and addressee.lower() != self._client.bot_username.lower():
            return None

        return InstallClaim(
            token=parts[1],
            grant=InstallGrant(
                external_workspace_id=str(chat["id"]),
                workspace_name=_BRIDGE_NAME,
                bot_token=None,
                scopes="",
                platform_data={},
            ),
        )

    def shared_connection(self) -> TelegramAppClient:
        """The shared bot, once it has said who it is.

        Handed to a bridge before its first update is dispatched, so a bridge
        created by a claim at runtime has a bot to answer with.
        """
        self._client.require_ready()
        return self._client

    def connection_config(self, grant: InstallGrant) -> dict[str, object]:
        """No token and no username: both come from the shared bot."""
        return {"event_delivery": "shared"}
