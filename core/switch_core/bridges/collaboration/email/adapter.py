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
from pathlib import Path
from typing import Any, ClassVar

from aiohttp import web
from pydantic.json_schema import SkipJsonSchema

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
#: How much of a forwarded message is carried into the room body.
#:
#: Serialising a nested `message/rfc822` includes its own attachments in
#: base64, so an unbounded flatten sails past what a Matrix event will hold.
_FORWARDED_BODY_MAX_CHARS = 32_000

#: What one message may contribute to a Matrix event, in bytes.
#:
#: Matrix refuses a PDU over 65535 bytes outright — `M_TOO_LARGE` — and the
#: bridge cannot tell the sender, because it does not send mail. So an
#: over-long forward simply never arrives.
#:
#: The budget is a quarter of the limit rather than a half because the body
#: travels **twice**: the relay sends it as markdown, so the event carries the
#: plain `body` and an HTML `formatted_body` rendered from it, and the HTML is
#: the larger of the two. The rest is JSON overhead and the room's own fields.
#:
#: `_FORWARDED_BODY_MAX_CHARS` above does not cover this and cannot: it caps
#: each nested part inside a loop while the body accumulates across them, so
#: four compliant parts still produced a PDU Matrix refused.
EMAIL_BODY_MAX_BYTES = 16_000

#: Shorter than this and the endpoint is guessable; empty and it is open.
MIN_WEBHOOK_SECRET_LENGTH = 32

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
    #: Minted at registration, never typed. `SkipJsonSchema` keeps it out of the
    #: operator form — the same thing the Teams adapter does with `client_state`,
    #: and it survives being nested or wrapped in a `TypeAdapter`, which
    #: overriding `model_json_schema` does not.
    webhook_secret: SkipJsonSchema[str] = ""


def _fit_to_event(body: str) -> str:
    """Cut `body` to what a Matrix event will carry, and say so in the text.

    Truncating on bytes rather than characters because the limit is on the
    encoded event, and cutting on a character boundary is what keeps the
    result valid UTF-8.
    """
    encoded = body.encode("utf-8")
    if len(encoded) <= EMAIL_BODY_MAX_BYTES:
        return body

    notice = (
        f"\n\n[Message truncated: it exceeds the {EMAIL_BODY_MAX_BYTES} bytes a "
        "room message can carry. Ask the sender for the rest, or for the part "
        "you need.]"
    )
    budget = EMAIL_BODY_MAX_BYTES - len(notice.encode("utf-8"))
    return encoded[:budget].decode("utf-8", errors="ignore") + notice


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

        secret = self._config.webhook_secret
        if len(secret) < MIN_WEBHOOK_SECRET_LENGTH:
            # Without one the route is `/inbound/`, reachable by anyone who can
            # reach the port, accepting mail as any allowed sender. `start` is
            # the last place to catch it: `prepare_config` mints the secret at
            # registration, but nothing re-runs it when a config is updated.
            raise BridgeOperationError(
                "this email bridge has no usable webhook secret, so its inbound "
                "endpoint would accept mail from anyone; re-register the bridge "
                "so one is minted"
            )

        # Body size is bounded here because attachments are inside it. The
        # multiplier covers base64's 4/3 inflation plus headers; a message
        # carrying several max-size attachments is refused by aiohttp before it
        # reaches us, which is the intended outcome.
        app = web.Application(client_max_size=self._max_attachment_bytes * 2)
        app.router.add_post(f"/inbound/{secret}", self._handle_inbound)
        # access_log=None because the secret is a path segment and aiohttp's
        # default format logs the request line. A long-lived credential in a log
        # aggregator is a credential to rotate. A header would avoid the problem
        # entirely, but the providers this bridge is built for cannot all set one.
        self._runner = web.AppRunner(app, access_log=None)
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
        try:
            await self._ingest(raw)
        except Exception:
            # A policy drop returns normally from `_ingest`; reaching here means
            # something broke — Matrix unreachable, the room not creatable. That
            # is transient, and answering 202 would lose the mail for good with
            # no trace anywhere the sender can see. 500 asks the provider to
            # deliver it again.
            logger.exception("[EMAIL] failed to deliver an inbound message")
            return web.Response(status=500)
        # Accepted. Every reason `_ingest` declines a message — not allowlisted,
        # a loop marker, no usable sender — is permanent, so a retry would only
        # repeat it.
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

        # Exactly one. RFC 7489 requires a message with several to be rejected
        # precisely because implementations disagree about which is
        # authoritative: a receiving MTA that evaluated the last one could
        # DMARC-pass a domain we then attribute to the first.
        from_headers = message.get_all("From") or []
        if len(from_headers) != 1:
            logger.warning(
                "[EMAIL] dropped a message carrying %d From headers",
                len(from_headers),
            )
            return

        # `policy.default` has already decoded this. Running the decoder again
        # over the result is how a display name whose decoded text is itself an
        # encoded word gets parsed as structure — the classic header-injection
        # shape, even where it happens to fail closed.
        display_name, address = parseaddr(str(from_headers[0]))
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

        # After the allowlist, not before: a stranger who adds a `List-Id` header
        # should not be able to swap the "refused mail from X" warning for a
        # quieter one and hide that the endpoint is being probed.
        loop_marker = _loop_marker(message)
        if loop_marker is not None:
            logger.warning(
                "[EMAIL] dropped machine-generated mail (%s) from %s",
                loop_marker,
                address,
            )
            return

        body, attachments, failures = self._read_content(message)
        subject = _decoded(message.get("Subject"))
        content = f"**{subject}**\n\n{body}".strip() if subject else body
        # After the subject is prepended, because that is the string that
        # becomes the event. Capping the body alone left the subject line to
        # push it back over.
        content = _fit_to_event(content)

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
            filename = _safe_filename(item.get_filename())

            # "Forward as attachment" — Apple Mail's default, Outlook's, and
            # every "report this message" flow — arrives as `message/rfc822`,
            # which has no transfer encoding and so decodes to None. Read as a
            # failed attachment, the forwarded mail is discarded and the body is
            # just the covering note: the bridge silently loses the thing it
            # exists to carry. Flattened into the body instead, whole and
            # unparsed, which is what happens to an inline forward anyway.
            if item.get_content_type() == "message/rfc822":
                # `get_payload(0)` raises TypeError when the payload is a string
                # rather than a list, which a malformed part produces — and that
                # escapes as a 500 the provider redelivers forever.
                payload_parts = item.get_payload()
                nested = (
                    payload_parts[0]
                    if isinstance(payload_parts, list) and payload_parts
                    else None
                )
                if nested is None:
                    failures.append(
                        AttachmentFailure(
                            filename=filename,
                            reason="the forwarded message could not be read",
                        )
                    )
                    continue
                flattened = str(nested)
                if len(flattened) > _FORWARDED_BODY_MAX_CHARS:
                    # Serialising a nested message includes its own attachments,
                    # base64 and all, so this grows far past what a Matrix event
                    # will hold — and that rejection is another permanent 500.
                    flattened = (
                        flattened[:_FORWARDED_BODY_MAX_CHARS]
                        + f"\n\n[forwarded message truncated at "
                        f"{_FORWARDED_BODY_MAX_CHARS} characters]"
                    )
                body = f"{body}\n\n{flattened}".strip() if body else flattened
                continue

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


def _safe_filename(raw: str | None) -> str:
    """A filename safe to hand on, from one a sender chose.

    This is the first bridge where a filename is typed by an attacker rather
    than normalised by a platform. It reaches the Matrix media repository rather
    than a filesystem today, so nothing here is exploitable — but any later
    consumer that writes by name inherits whatever this lets through, and
    `Path(...).name` alone lets through a great deal: `..` survives it, so do
    Windows separators and drive letters on POSIX, and so do control characters
    and newlines.

    An allow-list rather than a deny-list, for the usual reason.
    """
    candidate = Path((raw or "").replace("\\", "/")).name
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", candidate).strip("._")
    if not cleaned or set(cleaned) <= {"."}:
        return "attachment"
    return cleaned[:120]


def _loop_marker(message: EmailMessage) -> str | None:
    """The header saying this mail was generated by a machine, if any.

    Returns the header that matched so the drop can name it. `Auto-Submitted`
    is read by value rather than presence: `no` is exactly what a well-behaved
    client puts on ordinary mail, and treating that as a loop would drop the
    real messages while admitting the vacation responders.
    """
    # `auto-forwarded` is not a machine writing to us — it is RFC 3834's value
    # for a human's mail being relayed, which is exactly how mail reaches this
    # bridge. Treating it as a loop drops every message on any deployment whose
    # forwarder follows the RFC, at one log line, with nothing else to go on.
    auto_submitted = (message.get("Auto-Submitted") or "").strip().lower()
    if auto_submitted and auto_submitted not in ("no", "auto-forwarded"):
        return f"Auto-Submitted: {auto_submitted}"

    precedence = (message.get("Precedence") or "").strip().lower()
    bulk = precedence in _BULK_PRECEDENCE

    for header in _AUTOREPLY_HEADERS:
        if message.get(header):
            return header

    if (message.get("Return-Path") or "").strip() == "<>":
        return "Return-Path: <>"

    if not bulk:
        return None

    # Bulk on its own is a loop marker. `List-*` on its own is not: a newsletter
    # someone deliberately forwarded through a server-side rule keeps its list
    # headers, since a sieve `redirect` does not strip them the way a
    # client-side forward does. Reported together where both are present so the
    # log line says which combination fired.
    for header in message.keys():
        if _LIST_HEADER.match(header):
            return f"Precedence: {precedence} with {header}"
    return f"Precedence: {precedence}"
