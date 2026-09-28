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

import asyncio
import hmac
import json
import logging
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, ClassVar

from telegram.error import BadRequest, Forbidden, TelegramError

from switch_core.bridges.collaboration.install import (
    ClaimRefusal,
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

logger = logging.getLogger(__name__)

#: The header Telegram carries `setWebhook`'s `secret_token` back in.
SECRET_TOKEN_HEADER = "X-Telegram-Bot-Api-Secret-Token"

#: The commands that carry a claim: Telegram's own handshake for a group added
#: through the link, and the one a channel admin types.
_CLAIM_COMMANDS = frozenset({"start", "connect"})

#: The name the tenant's one Telegram bridge is registered under.
_BRIDGE_NAME = "Telegram"

_REMOVED_STATUSES = frozenset({"left", "kicked"})
_PRESENT_STATUSES = frozenset({"member", "administrator"})
#: Chats the bot being added to is never answered in.
_UNANSWERED_ADDS = frozenset({"private", "channel"})

#: How long an unclaimed add waits before saying so. Adding the bot through a
#: Switch link sends the add and the claim a moment apart, possibly delivered
#: out of order; the notice is only for an add no claim follows.
UNCLAIMED_NOTICE_GRACE = 10.0

UNCLAIMED_NOTICE = (
    "This chat isn't connected to Switch, so nothing said here reaches an "
    "agent. To connect it, add the bot with the link from Switch, or post "
    "/connect followed by a code from Switch."
)

#: What a refused claim is told, per reason. Nothing here names the tenant that
#: holds an already-connected chat, or says one exists beyond "connected".
CLAIM_REFUSED: dict[ClaimRefusal, str] = {
    "expired": (
        "That Switch link has expired or was already used. Get a new one from "
        "Switch and try again."
    ),
    "unrecognised": (
        "That isn't a code from this Switch. Get a new link or code from "
        "Switch and try again."
    ),
    "already_connected": (
        "This chat is already connected to Switch. To connect it somewhere "
        "else, disconnect it in Switch first."
    ),
    "not_permitted": (
        "Only an admin can connect the first chat to Switch. Ask an admin to "
        "connect one, then try again."
    ),
}

DIRECT_MESSAGE_REPLY = (
    "👋 Direct messages to this bot aren't routed to anyone. Connect a group "
    "or channel from Switch, then mention an agent there."
)


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
    state_format = "compact"
    installs_by_claim = True
    # With Group Privacy off the bot hears everything in every chat it is in,
    # claimed or not.
    expects_unowned_events = True

    def __init__(self, *, client: TelegramAppClient, webhook_secret: str) -> None:
        self._client = client
        self._webhook_secret = webhook_secret.encode()

    def authorize_url(self, *, state: str, redirect_uri: str) -> str:
        """The link that adds the bot to a group and claims it.

        `redirect_uri` is unused: nothing redirects. Telegram opens the chat
        picker, adds the bot, and posts the state into the chat it was added to.
        """
        return f"https://t.me/{self._client.bot_username}?startgroup={state}"

    def bot_handle(self) -> str:
        """`@username`, typed in full: Telegram's search does not find a bot
        by part of its username."""
        return f"@{self._client.bot_username}"

    async def redeem(self, *, code: str, redirect_uri: str) -> InstallGrant:
        raise MessagingInstallError(
            "Telegram has no OAuth leg; a Telegram install is claimed from a chat"
        )

    async def revoke(self, *, bot_token: str) -> None:
        raise MessagingInstallError(
            "a Telegram install holds no token of its own to revoke"
        )

    def verify_webhook(self, *, headers: Mapping[str, str], body: bytes) -> None:
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
        self, *, endpoint: WebhookEndpoint, headers: Mapping[str, str], body: bytes
    ) -> InboundWebhook:
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
        return InboundWebhook(
            envelope_type=endpoint,
            payload=payload,
            handshake=None,
            external_event_id=str(payload["update_id"]),
            delivery_attempt=0,
        )

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
            ),
        )

    async def release(self, *, external_workspace_id: str) -> None:
        """Leave the chat. There is no per-install token to revoke instead.

        A chat the bot is already out of answers with a refusal, which is the
        outcome wanted; anything else leaves the bot in the chat and is raised
        so the disconnect fails and can be tried again.
        """
        try:
            await self._client.bot.leave_chat(chat_id=int(external_workspace_id))
        except (BadRequest, Forbidden) as gone:
            logger.info(
                "The Telegram app was already out of chat %s: %s",
                external_workspace_id,
                gone,
            )
        except TelegramError as failure:
            raise MessagingInstallError(
                f"Telegram did not let the bot leave chat {external_workspace_id}: "
                f"{failure}. It is still in the chat; disconnect again to retry."
            ) from failure

    def migration_of_event(
        self, payload: Mapping[str, object]
    ) -> tuple[str, str] | None:
        """Read either of the two notices Telegram sends for a supergroup."""
        message = _message_of(payload)
        if message is None:
            return None
        chat = _as_dict(message.get("chat")) or {}
        if message.get("migrate_to_chat_id") is not None:
            return str(chat.get("id")), str(message["migrate_to_chat_id"])
        if message.get("migrate_from_chat_id") is not None:
            return str(message["migrate_from_chat_id"]), str(chat.get("id"))
        return None

    async def on_claim_refused(
        self, *, claim: InstallClaim, reason: ClaimRefusal
    ) -> None:
        await self._client.bot.send_message(
            chat_id=int(claim.grant.external_workspace_id),
            text=CLAIM_REFUSED[reason],
        )

    async def on_unowned_event(
        self,
        *,
        workspace_id: str,
        payload: Mapping[str, object],
        still_unowned: Callable[[], Awaitable[bool]],
    ) -> None:
        """Say how to connect an unclaimed chat, or that DMs reach no one.

        The bot being added to a group is answered once, after the grace
        period, and only if no claim has landed by then. A channel is not
        answered: every channel is added unclaimed, because its code can only
        be posted once the bot is in, and a notice there would reach every
        subscriber. A direct message is answered each time, as the
        self-registered bridge answers one. Everything else from an unowned
        chat gets no answer: the bot stays, and stays quiet.
        """
        member = _as_dict(payload.get("my_chat_member"))
        if member is not None:
            chat = _as_dict(member.get("chat")) or {}
            status = (_as_dict(member.get("new_chat_member")) or {}).get("status")
            if status not in _PRESENT_STATUSES or chat.get("type") in _UNANSWERED_ADDS:
                return
            await asyncio.sleep(UNCLAIMED_NOTICE_GRACE)
            if await still_unowned():
                await self._client.bot.send_message(
                    chat_id=int(workspace_id), text=UNCLAIMED_NOTICE
                )
            return

        message = _as_dict(payload.get("message"))
        sent_in = _as_dict(message.get("chat")) if message is not None else None
        if sent_in is not None and sent_in.get("type") == "private":
            await self._client.bot.send_message(
                chat_id=int(workspace_id), text=DIRECT_MESSAGE_REPLY
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
