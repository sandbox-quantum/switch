"""Email collaboration bridge adapter — inbound only.

An agent gets an address people can send mail to. Mail arrives as a room
message; the agent answers wherever it is being talked to, which for now is
somewhere else. Replying *by* email is a separate story with its own
authorization question and is not built here.

Three things set this adapter apart from every other one, and each is load
bearing rather than an omission:

**The sender is not authenticated.** Every other bridge sits behind a platform
that verified the account before accepting the message. An email `From` header
is typed by whoever sent the mail. Since a Switch Console agent starts
owner-only, admitting an unverified address hands a stranger the owner's
authority — so the bridge admits only addresses an operator has listed, and
declares `authenticates_senders = False` so the rest of the system knows what
kind of identity this is. Real SPF/DKIM/DMARC evaluation replaces the list when
a non-owner correspondent becomes legitimate.

**It cannot send.** `send_message` raises. An agent posting into an email room
is doing something this bridge cannot do, and the alternative to raising is an
answer that goes nowhere while the room shows it as sent.

**Nothing is unwrapped.** A forwarded message keeps its banner, its quoted
headers and its chain. The consumer is a language model, which reads all of that
as well as a person would; recovering the original sender as structured metadata
means parsing a format every mail client writes differently, for information
nothing here consumes.

Inbound arrives as raw RFC 5322 over an HTTP endpoint this adapter serves, the
way Teams serves its Bot Connector endpoint. Raw MIME rather than a provider's
JSON so the bridge is not tied to one vendor — Postmark, Mailgun and SendGrid
can all post the original message — and so parsing is the standard library's job
rather than a schema per provider.
"""

from __future__ import annotations

import logging
import re
import secrets
from collections.abc import Awaitable, Callable
from email import message_from_bytes, policy
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import parseaddr
from html.parser import HTMLParser
from typing import Any, ClassVar

from aiohttp import web

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

logger = logging.getLogger(__name__)

WEBHOOK_SECRET_BYTES = 32

# Headers that mark mail as machine-generated. An agent that answers an
# autoresponder, whose autoresponder answers the agent, is a loop that costs
# money on every turn and does not stop on its own.
_LIST_HEADER = re.compile(r"^list-", re.IGNORECASE)
_BULK_PRECEDENCE = {"bulk", "junk", "list"}
_AUTOREPLY_HEADERS = ("x-autoreply", "x-autorespond", "x-autoresponder")


class EmailConnectionConfig(BridgeConnectionConfig):
    listen_host: str = "0.0.0.0"
    listen_port: int
    #: The address mail reaches this agent at. Not used to route inbound — the
    #: provider does that — but it is what an operator configures their provider
    #: to forward, and what outbound will send as.
    agent_address: str
    #: Addresses permitted to reach the agent. Compared case-insensitively.
    #: Empty admits nobody: an unset list on a publicly reachable inbox is a
    #: misconfiguration, and reading it as "open" is the expensive direction.
    allowed_senders: list[str] = []
    #: Minted at registration, never typed. Excluded from the JSON schema so the
    #: operator dashboard does not offer it as a field to fill in badly.
    webhook_secret: str = ""

    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
        schema = super().model_json_schema(*args, **kwargs)
        schema.get("properties", {}).pop("webhook_secret", None)
        return schema


class _TextFromHtml(HTMLParser):
    """Enough HTML to read, and no dependency to add.

    Mail arriving as HTML alone is common enough that dropping it would lose
    real messages, and a model does not need the markup — it needs the words in
    roughly the right order.
    """

    _BREAKS = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, _attrs: list[Any]) -> None:
        if tag in ("script", "style"):
            self._skip += 1
        elif tag in self._BREAKS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self._skip:
            self._skip -= 1
        elif tag in self._BREAKS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self._parts.append(data)

    def text(self) -> str:
        joined = "".join(self._parts)
        return re.sub(r"\n{3,}", "\n\n", joined).strip()


def _html_to_text(html: str) -> str:
    parser = _TextFromHtml()
    parser.feed(html)
    parser.close()
    return parser.text()


def _decoded(raw: str | None) -> str:
    """A header as a person wrote it, with any encoded words expanded."""
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(raw))).strip()
    except Exception:
        return raw.strip()


class EmailAdapter(CollaborationAdapter):
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    authenticates_senders: ClassVar[bool] = False

    def __init__(self, config: EmailConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._allowed = {a.strip().lower() for a in config.allowed_senders if a.strip()}
        self._runner: web.AppRunner | None = None

    # ── Registration ─────────────────────────────────────────────────────────

    @classmethod
    async def prepare_config(
        cls, connection_config: dict[str, object]
    ) -> dict[str, object]:
        """Mint the webhook secret, once, at registration.

        The endpoint accepts mail, so anything that can reach the port can speak
        as any allowed sender without it. Minted here rather than defaulted on
        the model because a model default is re-evaluated every time a stored
        config is validated — every restart would mint a fresh secret and
        silently invalidate the URL the provider is posting to.
        """
        prepared = dict(connection_config)
        if not prepared.get("webhook_secret"):
            prepared["webhook_secret"] = secrets.token_urlsafe(WEBHOOK_SECRET_BYTES)
        return prepared

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        config = EmailConnectionConfig.model_validate(connection_config)
        return f"tcp/{config.listen_port}"

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def bind_message_handler(
        self, on_message: Callable[[InboundMessage], Awaitable[None]]
    ) -> None:
        """Install the inbound handler without binding a port.

        `start` does this and then listens. Kept separate so the parsing path —
        which is where every interesting decision in this adapter lives — can be
        exercised without a socket.
        """
        self._on_message = on_message

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        self.bind_message_handler(on_message)
        self._on_command = on_command
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

        app = web.Application(client_max_size=self._max_attachment_bytes * 2)
        app.router.add_post(
            f"/inbound/{self._config.webhook_secret}", self._handle_inbound
        )
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(
            self._runner, self._config.listen_host, self._config.listen_port
        )
        await site.start()
        logger.info(
            "[EMAIL] listening on %s:%s for %s",
            self._config.listen_host,
            self._config.listen_port,
            self._config.agent_address,
        )

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    async def _handle_inbound(self, request: web.Request) -> web.Response:
        raw = await request.read()
        await self.ingest(raw)
        # Accepted whatever we decided to do with it. A provider retries on a
        # non-2xx, and every reason we drop a message — not allowlisted, a loop
        # marker, unparseable — is permanent, so retrying only repeats it.
        return web.Response(status=202)

    # ── Inbound ──────────────────────────────────────────────────────────────

    async def ingest(self, raw: bytes) -> None:
        """Turn one raw RFC 5322 message into a room message, or drop it saying why.

        Never raises: this is the top of a delivery path, and one malformed
        message must not stop the next one arriving.
        """
        try:
            await self._ingest(raw)
        except Exception:
            logger.exception("[EMAIL] could not process an inbound message")

    async def _ingest(self, raw: bytes) -> None:
        message = message_from_bytes(raw, policy=policy.default)
        if not isinstance(message, EmailMessage):  # pragma: no cover - defensive
            logger.warning("[EMAIL] dropped a message that did not parse as mail")
            return

        loop_marker = _loop_marker(message)
        if loop_marker is not None:
            logger.info(
                "[EMAIL] dropped machine-generated mail (%s) from %s",
                loop_marker,
                message.get("From", "unknown"),
            )
            return

        display_name, address = parseaddr(_decoded(message.get("From")))
        address = address.strip().lower()
        if not address:
            logger.warning("[EMAIL] dropped a message with no usable From address")
            return

        if address not in self._allowed:
            # Not an error to be surfaced to the sender: replying would confirm
            # the address is live, and this bridge cannot reply anyway.
            logger.warning(
                "[EMAIL] refused mail from %s — not an allowed sender for %s",
                address,
                self._config.agent_address,
            )
            return

        body, attachments, failures = self._read_content(message)
        subject = _decoded(message.get("Subject"))
        content = f"**{subject}**\n\n{body}".strip() if subject else body

        if self._on_message is None:  # pragma: no cover - defensive
            logger.error("[EMAIL] received mail before a handler was installed")
            return

        await self._on_message(
            InboundMessage(
                channel_id=address,
                channel_type="direct",
                sender_id=address,
                sender_name=display_name or address,
                content=content,
                message_ref=_decoded(message.get("Message-ID")) or address,
                channel_name=address,
                attachments=attachments,
                attachment_failures=failures,
            )
        )

    def _read_content(
        self, message: EmailMessage
    ) -> tuple[str, list[Attachment], list[AttachmentFailure]]:
        body = ""
        part = message.get_body(preferencelist=("plain", "html"))
        if part is not None:
            text = part.get_content()
            body = (
                _html_to_text(text)
                if part.get_content_subtype() == "html"
                else str(text).strip()
            )

        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for item in message.iter_attachments():
            filename = item.get_filename() or "attachment"
            payload = item.get_payload(decode=True)
            if payload is None:
                failures.append(
                    AttachmentFailure(filename=filename, reason="could not be decoded")
                )
                continue
            if len(payload) > self._max_attachment_bytes:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=(
                            f"{len(payload)} bytes exceeds the "
                            f"{self._max_attachment_bytes} byte limit"
                        ),
                    )
                )
                continue
            attachments.append(
                Attachment(
                    filename=filename,
                    mimetype=item.get_content_type(),
                    data=payload,
                )
            )
        return body, attachments, failures

    # ── Outbound: not in this bridge ─────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        raise BridgeOperationError(
            "this email bridge is inbound-only, so there is nowhere to send "
            f"{sender_name}'s message; it receives mail and does not answer it"
        )

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
    ) -> str | None:
        """Log the notice; there is no external channel to post it to.

        The disclosed degradation for a bridge that cannot send. Left to the
        default this reaches `send_message` and raises — out of the path that
        auto-creates a room, since a new correspondent's room resolves no agents
        and the core posts a notice saying so. That is a bridge working as
        intended, and it must not look like a fault.
        """
        logger.warning(
            "[EMAIL] notice for %s could not be delivered (inbound-only): %s",
            channel_id,
            content,
        )
        return None

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        raise BridgeOperationError(
            "email is append-only; a sent message cannot be edited"
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        raise BridgeOperationError(
            "email is append-only; a sent message cannot be recalled"
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        """Nothing. The base runtime-state handling drives this, and mailing
        somebody "working on it…" on every turn is not a status indicator."""
        return None

    # ── Structure: email has none of it ──────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "email has no channels to create — a conversation exists once "
            "somebody sends mail to the agent's address"
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct"

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
        """Nobody can be added: an email conversation has two ends and no roster.

        Reported as "these could not be added" rather than silently accepted, so
        a caller that asked for people learns they are not there.
        """
        return list(user_external_ids)

    async def create_agent_identity(
        self, agent_name: str, agent_description: str
    ) -> None:
        return None

    async def remove_agent_identity(self, agent_name: str) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    def translate_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message


def _loop_marker(message: EmailMessage) -> str | None:
    """The header saying this mail was generated by a machine, if any.

    Returns the header that matched so the drop can name it. `Auto-Submitted`
    is read by value rather than presence: `no` is exactly what a well-behaved
    client puts on ordinary mail, and treating that as a loop would drop the
    real messages while admitting the vacation responders.
    """
    auto_submitted = (message.get("Auto-Submitted") or "").strip().lower()
    if auto_submitted and auto_submitted != "no":
        return f"Auto-Submitted: {auto_submitted}"

    precedence = (message.get("Precedence") or "").strip().lower()
    if precedence in _BULK_PRECEDENCE:
        return f"Precedence: {precedence}"

    for header in message.keys():
        if _LIST_HEADER.match(header):
            return header

    for header in _AUTOREPLY_HEADERS:
        if message.get(header):
            return header

    if (message.get("Return-Path") or "").strip() == "<>":
        return "Return-Path: <>"

    return None
