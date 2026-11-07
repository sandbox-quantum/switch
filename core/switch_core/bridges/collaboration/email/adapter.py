from __future__ import annotations

import asyncio
import hashlib
import html
import json
import logging
import re
import smtplib
import ssl
import threading
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from email.header import decode_header, make_header
from email.message import EmailMessage, Message
from email.parser import BytesParser
from email.policy import default
from email.utils import formataddr, make_msgid, parseaddr
from html.parser import HTMLParser
from typing import Any, ClassVar, Literal
from urllib.parse import quote, unquote, urlsplit

import markdown
from imapclient import IMAPClient
from imapclient.exceptions import IMAPClientError, LoginError
from pydantic import Field, field_validator
from pydantic.json_schema import SkipJsonSchema

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    OutboundAttachment,
    PlatformAdapter,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    OutboundDeliveryUncertain,
)

logger = logging.getLogger(__name__)

_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
_MAX_BODY_CHARS = 40_000
_MAX_OUTBOUND_CHARS = 18_000
_COMMAND_PREFIX = "!"
_THREAD_PREFIX = "email-ref:"
_HANDLED_KEYWORD = b"$SwitchSeen"
_IDLE_SECONDS = 25 * 60
_IDLE_CHECK_SECONDS = 15
_RECONNECT_FIRST = 5.0
_RECONNECT_MAX = 300.0
_IMAP_TIMEOUT_SECONDS = 30


class EmailConnectionConfig(BridgeConnectionConfig):
    imap_host: str = Field(min_length=1, description="IMAP server hostname")
    imap_port: int = Field(default=993, ge=1, le=65535)
    imap_username: str = Field(min_length=1, description="IMAP login")
    imap_password: str = Field(
        min_length=1, description="IMAP password or app password"
    )
    imap_folder: str = Field(default="INBOX", min_length=1)
    imap_security: Literal["ssl", "starttls"] = "ssl"
    smtp_host: str = Field(min_length=1, description="SMTP server hostname")
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_username: str = Field(min_length=1, description="SMTP login")
    smtp_password: str = Field(
        min_length=1, description="SMTP password or app password"
    )
    smtp_security: Literal["ssl", "starttls"] = "starttls"
    from_address: str = Field(
        min_length=3, description="Email address replies are sent from"
    )
    allowed_senders: str = Field(
        description="Required comma-separated sender address allowlist",
    )
    require_authenticated_senders: bool = Field(
        default=True,
        description="Reject mail unless the receiving server verifies the sender",
    )
    authentication_server: str | None = Field(
        default="mx.google.com",
        description="Trusted Authentication-Results server identifier; empty trusts the topmost header",
    )
    poll_interval_seconds: int = Field(default=30, ge=10, le=300)
    connected_at: SkipJsonSchema[str | None] = None

    @field_validator("from_address")
    @classmethod
    def _valid_from_address(cls, value: str) -> str:
        address = parseaddr(value)[1]
        if not address or "@" not in address:
            raise ValueError("from_address must be a valid email address")
        return address

    @field_validator("allowed_senders")
    @classmethod
    def _valid_allowed_senders(cls, value: str) -> str:
        senders = _allowed_senders(value)
        if not senders or any(
            parseaddr(sender)[1].lower() != sender or sender.count("@") != 1
            for sender in senders
        ):
            raise ValueError("allowed_senders must contain valid email addresses")
        return ", ".join(sorted(senders))

    @field_validator("authentication_server")
    @classmethod
    def _valid_authentication_server(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        server = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9.-]+", server):
            raise ValueError("authentication_server must be a valid server identifier")
        return server

    @property
    def since(self) -> datetime | None:
        return datetime.fromisoformat(self.connected_at) if self.connected_at else None


def _decode_header(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except (LookupError, UnicodeError, ValueError):
        return value


def _normal_subject(subject: str) -> str:
    value = " ".join(subject.split())
    while True:
        cleaned = re.sub(r"^(?:(?:re|fw|fwd)\s*:\s*)+", "", value, flags=re.I)
        if cleaned == value:
            break
        value = cleaned
    return value or "Email conversation"


def _thread_headers(message: Message) -> str | None:
    """The first RFC 5322 reference, or In-Reply-To when there is no chain."""
    references = message.get_all("References", [])
    if references:
        ids = re.findall(r"<[^>]+>", " ".join(str(item) for item in references))
        if ids:
            return str(ids[0])
    reply = message.get("In-Reply-To")
    if reply:
        ids = re.findall(r"<[^>]+>", str(reply))
        return str(ids[0]) if ids else str(reply).strip()
    return None


def _channel_id(mailbox: str) -> str:
    return f"email:{quote(mailbox.lower(), safe='')}"


def _thread_ref(message_id: str, sender: str, subject: str) -> str:
    return _THREAD_PREFIX + quote(
        json.dumps(
            {
                "message_id": message_id,
                "sender": sender.lower(),
                "subject": _normal_subject(subject),
            },
            separators=(",", ":"),
        ),
        safe="",
    )


def _decode_channel_id(value: str) -> str:
    if not value.startswith("email:"):
        raise BridgeOperationError("The email room reference is malformed.")
    mailbox = unquote(value[6:]).lower()
    if "@" not in mailbox:
        raise BridgeOperationError("The email room has no mailbox address.")
    return mailbox


def _decode_thread_ref(value: str | None) -> dict[str, str] | None:
    if not value or not value.startswith(_THREAD_PREFIX):
        return None
    try:
        result = json.loads(unquote(value[len(_THREAD_PREFIX) :]))
    except (json.JSONDecodeError, TypeError):
        return None
    return result if isinstance(result, dict) else None


def _strip_quoted_history(text: str) -> str:
    """Keep the new reply and remove common quoted-history/signature tails."""
    kept: list[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        trimmed = line.strip()
        if (
            trimmed == "--"
            or trimmed.startswith("-----Original Message-----")
            or trimmed.startswith("________________________________")
            or re.match(r"^On .{1,200} wrote:\s*$", trimmed, re.I)
            or (trimmed.startswith(">") and kept and not kept[-1].strip())
        ):
            break
        if trimmed.startswith(">"):
            continue
        kept.append(line)
    return "\n".join(kept).strip()[:_MAX_BODY_CHARS]


def _split_outbound_body(text: str, limit: int = _MAX_OUTBOUND_CHARS) -> list[str]:
    """Split long mail at readable boundaries while keeping every character."""
    remaining = text.strip()
    if not remaining:
        return [""]
    chunks: list[str] = []
    while len(remaining) > limit:
        paragraph_break = remaining.rfind("\n\n", 0, limit)
        line_break = remaining.rfind("\n", 0, limit)
        if paragraph_break >= limit // 2:
            cut = paragraph_break + 2
        elif line_break >= limit // 2:
            cut = line_break + 1
        else:
            word_break = remaining.rfind(" ", 0, limit)
            cut = word_break + 1 if word_break >= limit // 2 else limit
        chunks.append(remaining[:cut])
        remaining = remaining[cut:]
    if remaining:
        chunks.append(remaining)
    return chunks


class _PlainTextFromHtml(HTMLParser):
    _BLOCKS = {"br", "p", "div", "li", "tr", "h1", "h2", "h3", "blockquote"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in self._BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self._BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def _html_to_text(value: str) -> str:
    parser = _PlainTextFromHtml()
    parser.feed(value)
    return re.sub(r"\n{3,}", "\n\n", "".join(parser.parts)).strip()


class _SafeEmailHtml(HTMLParser):
    _ALLOWED = {
        "p",
        "br",
        "strong",
        "b",
        "em",
        "i",
        "ul",
        "ol",
        "li",
        "blockquote",
        "pre",
        "code",
        "h1",
        "h2",
        "h3",
        "hr",
        "a",
    }
    _VOID = {"br", "hr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._invalid_links = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag not in self._ALLOWED:
            return
        if tag == "a":
            href = dict(attrs).get("href") or ""
            if urlsplit(href).scheme in {"https", "http", "mailto"}:
                self.parts.append(f'<a href="{html.escape(href, quote=True)}">')
                return
            self._invalid_links += 1
            return
        self.parts.append(f"<{tag}>")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "a" and self._invalid_links:
            self._invalid_links -= 1
            return
        if tag in self._ALLOWED and tag not in self._VOID:
            self.parts.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        self.parts.append(html.escape(data))


def _render_html(text: str) -> str:
    rendered = markdown.markdown(text, extensions=["fenced_code"])
    parser = _SafeEmailHtml()
    parser.feed(rendered)
    return "<!doctype html><html><body>" + "".join(parser.parts) + "</body></html>"


def _body_parts(
    message: Message, max_attachment_bytes: int
) -> tuple[str, list[Attachment], list[AttachmentFailure]]:
    plain: list[str] = []
    rich: list[str] = []
    attachments: list[Attachment] = []
    failures: list[AttachmentFailure] = []
    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        if part.is_multipart():
            continue
        filename = _decode_header(part.get_filename())
        disposition = part.get_content_disposition()
        content_type = part.get_content_type().lower()
        decoded_payload = part.get_payload(decode=True)
        payload = decoded_payload if isinstance(decoded_payload, bytes) else b""
        if filename or disposition == "attachment":
            name = filename or "attachment"
            if len(payload) > max_attachment_bytes:
                failures.append(
                    AttachmentFailure(
                        filename=name,
                        reason="file exceeds Switch's attachment size limit",
                    )
                )
            else:
                attachments.append(
                    Attachment(filename=name, mimetype=content_type, data=payload)
                )
            continue
        if content_type == "text/plain":
            charset = part.get_content_charset() or "utf-8"
            plain.append(payload.decode(charset, errors="replace"))
        elif content_type == "text/html":
            charset = part.get_content_charset() or "utf-8"
            rich.append(payload.decode(charset, errors="replace"))
    body = "\n".join(plain).strip()
    if not body and rich:
        body = _html_to_text("\n".join(rich))
    return _strip_quoted_history(body), attachments, failures


def _allowed_senders(raw: str) -> frozenset[str]:
    values = (part.strip().lower() for part in raw.split(","))
    return frozenset(value for value in values if value)


def _is_automated_email(message: Message) -> bool:
    auto_submitted = message.get("Auto-Submitted")
    if (
        auto_submitted is not None
        and str(auto_submitted).split(";", 1)[0].strip().lower() != "no"
    ):
        return True
    if message.get("X-Switch-Email-Bridge") is not None:
        return True
    if str(message.get("Return-Path", "")).strip() == "<>":
        return True
    if message.get("List-Id") is not None:
        return True
    precedence = str(message.get("Precedence", "")).strip().lower()
    if precedence in {"bulk", "list", "junk"}:
        return True
    return any(
        message.get(header) is not None for header in ("X-Autoreply", "X-Autorespond")
    )


def _authentication_domain(value: str) -> str:
    domain = value.strip().strip("\"'<>(),").lower()
    return domain.rsplit("@", 1)[-1].rstrip(".")


def _sender_authenticated(
    message: Message, sender_address: str, authentication_server: str | None
) -> bool:
    sender_domain = _authentication_domain(sender_address.rsplit("@", 1)[-1])
    if not sender_domain:
        return False
    headers = message.get_all("Authentication-Results", [])
    if not headers:
        return False
    authserv_id, separator, results = str(headers[0]).partition(";")
    authserv_parts = authserv_id.strip().split()
    if (
        not separator
        or not authserv_parts
        or (
            authentication_server is not None
            and authserv_parts[0].lower() != authentication_server
        )
    ):
        return False
    if re.search(r"(?:^|;)\s*dmarc\s*=\s*pass\b", results, re.IGNORECASE):
        return True
    for method, domain_field in (
        ("dkim", r"(?:header\.d|header\.i)"),
        ("spf", r"smtp\.mailfrom"),
    ):
        match = re.search(
            rf"(?:^|;)\s*{method}\s*=\s*pass\b([^;]*)",
            results,
            re.IGNORECASE,
        )
        if match is None:
            continue
        domain = re.search(
            rf"\b{domain_field}\s*=\s*([^\s;]+)",
            match.group(1),
            re.IGNORECASE,
        )
        if (
            domain is not None
            and _authentication_domain(domain.group(1)) == sender_domain
        ):
            return True
    return False


def _imap_connect(config: EmailConnectionConfig) -> IMAPClient:
    client: IMAPClient | None = None
    try:
        client = IMAPClient(
            config.imap_host,
            port=config.imap_port,
            ssl=config.imap_security == "ssl",
            ssl_context=ssl.create_default_context(),
            timeout=_IMAP_TIMEOUT_SECONDS,
        )
        if config.imap_security == "starttls":
            client.starttls(ssl.create_default_context())
        client.login(config.imap_username, config.imap_password)
        return client
    except LoginError as exc:
        if client is not None:
            _close_imap_quietly(client)
        raise BridgeCredentialError(
            f"IMAP sign-in failed for {config.imap_username}: {exc}"
        ) from exc
    except Exception:
        if client is not None:
            _close_imap_quietly(client)
        raise


def _close_imap_quietly(client: IMAPClient) -> None:
    try:
        client.logout()
    except Exception:
        try:
            client.shutdown()
        except Exception:
            logger.debug("Could not close the IMAP connection", exc_info=True)


def _shutdown_imap_quietly(client: IMAPClient) -> None:
    try:
        client.shutdown()
    except Exception:
        logger.debug("Could not shut down the IMAP connection", exc_info=True)


def _smtp_connect(config: EmailConnectionConfig) -> smtplib.SMTP:
    try:
        if config.smtp_security == "ssl":
            client: smtplib.SMTP = smtplib.SMTP_SSL(
                config.smtp_host,
                config.smtp_port,
                timeout=20,
                context=ssl.create_default_context(),
            )
        else:
            client = smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=20)
            client.ehlo()
            client.starttls(context=ssl.create_default_context())
            client.ehlo()
        client.login(config.smtp_username, config.smtp_password)
        return client
    except (smtplib.SMTPException, OSError, ssl.SSLError) as exc:
        raise BridgeCredentialError(
            f"SMTP sign-in failed for {config.smtp_username}: {exc}"
        ) from exc


def _verify_mailbox(config: EmailConnectionConfig) -> None:
    imap = _imap_connect(config)
    try:
        imap.select_folder(config.imap_folder, readonly=True)
    except IMAPClientError as error:
        raise BridgeCredentialError(
            f"IMAP mailbox folder {config.imap_folder!r} could not be opened: {error}"
        ) from error
    finally:
        _close_imap_quietly(imap)
    smtp = _smtp_connect(config)
    try:
        smtp.noop()
    finally:
        try:
            smtp.quit()
        except (smtplib.SMTPException, OSError):
            pass


def _announces_mail(response: Any) -> bool:
    return (
        isinstance(response, tuple)
        and len(response) >= 2
        and response[1] in (b"EXISTS", b"RECENT")
    )


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)


class EmailAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Email"
    docs_slug: ClassVar[str | None] = "email"
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    draws_session_activity: ClassVar[bool] = True
    keeps_quiet_unless_listening: ClassVar[bool] = True

    def __init__(self, *, config: EmailConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._listener: asyncio.Task[None] | None = None
        self._client: IMAPClient | None = None
        self._stopping = threading.Event()
        self._stop_signal = asyncio.Event()
        self._outbound_lock = asyncio.Lock()

    async def _send_email_with_idempotency_key(
        self,
        transport_event_id: str,
        part_key: str,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None,
        files: list[tuple[str, str, bytes]],
        subject_override: str | None = None,
    ) -> str:
        async with self._outbound_lock:
            attempts = await self.load_outbound_attempts(transport_event_id)
            previous = attempts.get(part_key)
            if previous is not None:
                if previous["status"] == "sent":
                    return previous["message_id"]
                raise OutboundDeliveryUncertain(
                    "This email's SMTP outcome is uncertain. Switch will not "
                    "resend it automatically; check the recipient's mailbox "
                    "before manually retrying."
                )

            message, _ = self._build_email(
                channel_id,
                sender_name,
                content,
                thread_root_id,
                files,
                subject_override,
            )
            message_id = str(message["Message-ID"])
            client = await asyncio.to_thread(_smtp_connect, self._config)
            attempts[part_key] = {
                "status": "attempting",
                "message_id": message_id,
            }
            try:
                await self.persist_outbound_attempts(
                    transport_event_id, attempts, uncertain=True
                )
            except Exception:
                try:
                    await asyncio.to_thread(client.quit)
                except (smtplib.SMTPException, OSError):
                    pass
                raise

            try:
                refused = await asyncio.to_thread(client.send_message, message)
                if refused:
                    refused_recipients = ", ".join(sorted(refused))
                    raise OutboundDeliveryUncertain(
                        "SMTP accepted an uncertain subset of recipients and "
                        f"refused: {refused_recipients}. Switch will not retry "
                        "automatically; check delivery before manually retrying."
                    )
            except OutboundDeliveryUncertain:
                raise
            except Exception as exc:
                raise OutboundDeliveryUncertain(
                    "SMTP did not confirm whether it accepted this email. "
                    "Switch will not resend it automatically; check the "
                    "recipient's mailbox before manually retrying."
                ) from exc
            else:
                attempts[part_key]["status"] = "sent"
                try:
                    await self.persist_outbound_attempts(
                        transport_event_id, attempts, uncertain=False
                    )
                except Exception as exc:
                    raise OutboundDeliveryUncertain(
                        "SMTP accepted the email, but Switch could not persist "
                        "that confirmation. It will not resend automatically."
                    ) from exc
                return message_id
            finally:
                try:
                    await asyncio.to_thread(client.quit)
                except (smtplib.SMTPException, OSError):
                    pass

    @classmethod
    async def prepare_config(
        cls, connection_config: dict[str, object]
    ) -> dict[str, object]:
        if connection_config.get("connected_at"):
            return connection_config
        return {**connection_config, "connected_at": datetime.now(UTC).isoformat()}

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = EmailConnectionConfig.model_validate(connection_config)
        await asyncio.to_thread(_verify_mailbox, config)

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(
            exc, (IMAPClientError, smtplib.SMTPException, BridgeCredentialError)
        ):
            return "auth_failed"
        if isinstance(exc, (TimeoutError, OSError, ssl.SSLError)):
            return "network"
        if isinstance(exc, BridgeOperationError):
            return "platform_error"
        return None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [
            f"https://{connection_config['imap_host']}:{connection_config.get('imap_port', 993)}",
            f"https://{connection_config['smtp_host']}:{connection_config.get('smtp_port', 587)}",
        ]

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
        self._stopping.clear()
        self._stop_signal.clear()
        if self._listening:
            await on_app_joined(
                InboundAppJoin(
                    channel_id=_channel_id(self._config.from_address),
                    channel_type="channel_private",
                    channel_name=self._config.from_address,
                )
            )
            self._listener = asyncio.create_task(
                self._listen(), name=f"email-listener-{self._config.imap_username}"
            )

    async def stop(self) -> None:
        self._stopping.set()
        self._stop_signal.set()
        client = self._client
        if client is not None:
            await asyncio.to_thread(_shutdown_imap_quietly, client)
        task = self._listener
        self._listener = None
        if task is not None:
            try:
                await task
            except Exception:
                logger.exception(
                    "The email listener for %s failed while stopping",
                    self._config.imap_username,
                )

    async def _listen(self) -> None:
        delay = _RECONNECT_FIRST
        while not self._stopping.is_set():
            client: IMAPClient | None = None
            try:
                client = await asyncio.to_thread(_imap_connect, self._config)
                self._client = client
                if self._stopping.is_set():
                    return
                delay = _RECONNECT_FIRST
                await self._watch(client)
            except asyncio.CancelledError:
                raise
            except BridgeCredentialError as error:
                logger.error(
                    "Email bridge for %s cannot read mail: %s. Retrying in %.0fs",
                    self._config.imap_username,
                    error,
                    delay,
                )
            except Exception:
                if self._stopping.is_set():
                    return
                logger.exception(
                    "Email bridge for %s lost the mailbox; reconnecting in %.0fs",
                    self._config.imap_username,
                    delay,
                )
            finally:
                if self._client is client:
                    self._client = None
                if client is not None:
                    _shutdown_imap_quietly(client)
            if self._stopping.is_set():
                return
            await self._wait_or_stop(delay)
            delay = min(delay * 2, _RECONNECT_MAX)

    async def _watch(self, client: IMAPClient) -> None:
        selected = await asyncio.to_thread(
            client.select_folder, self._config.imap_folder
        )
        keyword = self._handled_flag(selected)
        idles = b"IDLE" in await asyncio.to_thread(client.capabilities)
        if not idles:
            logger.info(
                "The IMAP server for %s offers no IDLE; checking every %ds",
                self._config.imap_username,
                self._config.poll_interval_seconds,
            )
        while not self._stopping.is_set():
            retry = await self._handle_waiting(client, keyword, selected)
            if retry:
                await self._wait_or_stop(5)
                continue
            if idles:
                await asyncio.to_thread(self._idle, client)
            else:
                await self._wait_or_stop(self._config.poll_interval_seconds)

    async def _wait_or_stop(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stop_signal.wait(), timeout=seconds)
        except TimeoutError:
            pass

    def _handled_flag(self, selected: dict[bytes, Any]) -> bytes | None:
        permanent = selected.get(b"PERMANENTFLAGS") or ()
        if b"\\*" in permanent or _HANDLED_KEYWORD in permanent:
            return _HANDLED_KEYWORD
        logger.warning(
            "The IMAP server for %s keeps no custom keywords; Switch will rescan "
            "mail received since connection setup and rely on transport "
            "deduplication instead of changing mailbox flags.",
            self._config.imap_username,
        )
        return None

    def _idle(self, client: IMAPClient) -> None:
        client.idle()
        try:
            waited = 0
            while not self._stopping.is_set() and waited < _IDLE_SECONDS:
                responses = client.idle_check(timeout=_IDLE_CHECK_SECONDS)
                waited += _IDLE_CHECK_SECONDS
                if any(_announces_mail(response) for response in responses):
                    return
        finally:
            client.idle_done()

    async def _handle_waiting(
        self, client: IMAPClient, keyword: bytes | None, selected: dict[bytes, Any]
    ) -> bool:
        since = self._config.since
        if keyword is not None:
            criteria: list[Any] = ["UNKEYWORD", keyword]
        elif since is not None:
            criteria = ["SINCE", since.date()]
        else:
            criteria = ["UNSEEN"]
        uids = sorted(await asyncio.to_thread(client.search, criteria))
        uidvalidity = str(selected.get(b"UIDVALIDITY", "unknown"))
        retry = False
        for uid in uids:
            if self._stopping.is_set():
                return retry
            fetched = await asyncio.to_thread(
                client.fetch, [uid], [b"BODY.PEEK[]", b"INTERNALDATE"]
            )
            data = fetched.get(uid)
            if data is None or not isinstance(data.get(b"BODY[]"), bytes):
                continue
            arrived = data.get(b"INTERNALDATE")
            if (
                since is not None
                and isinstance(arrived, datetime)
                and _aware(arrived) < since
            ):
                if keyword is not None:
                    await asyncio.to_thread(client.add_flags, [uid], [keyword])
                continue
            try:
                await self._dispatch_email(uidvalidity, str(uid), data[b"BODY[]"])
            except Exception:
                logger.exception(
                    "Could not hand mail %s in %s to the room; it will be retried",
                    uid,
                    self._config.imap_username,
                )
                retry = True
                continue
            if keyword is not None:
                await asyncio.to_thread(client.add_flags, [uid], [keyword])
        return retry

    async def _dispatch_email(self, uidvalidity: str, uid: str, raw: bytes) -> None:
        message = BytesParser(policy=default).parsebytes(raw)
        from_header = _decode_header(message.get("From"))
        sender_name, sender_address = parseaddr(from_header)
        sender_address = sender_address.strip().lower()
        if not sender_address:
            logger.warning("Ignoring email UID %s without a usable From address", uid)
            return
        if _is_automated_email(message):
            logger.info("Ignoring automated email UID %s", uid)
            return
        allowed = _allowed_senders(self._config.allowed_senders)
        if sender_address not in allowed:
            logger.info("Ignoring email from sender outside the configured allowlist")
            return
        if self._config.require_authenticated_senders and not _sender_authenticated(
            message, sender_address, self._config.authentication_server
        ):
            logger.warning(
                "Ignoring email UID %s: sender authentication did not pass",
                uid,
            )
            return
        subject = _normal_subject(_decode_header(message.get("Subject")))
        message_id = str(
            message.get("Message-ID")
            or f"<{hashlib.sha256(raw).hexdigest()}@switch.local>"
        ).strip()
        ref = _thread_ref(message_id, sender_address, subject)
        parent_id = _thread_headers(message)
        root_ref = (
            _thread_ref(parent_id, sender_address, subject) if parent_id else None
        )
        content, attachments, failures = _body_parts(
            message, self._max_attachment_bytes
        )
        if attachments or failures:
            content = f"{content}\n\nEmail attachments: {len(attachments) + len(failures)}".strip()
        channel_id = _channel_id(self._config.from_address)
        channel_name = self._config.from_address
        display_sender = _decode_header(sender_name) or sender_address
        if content.startswith(_COMMAND_PREFIX):
            match = re.match(r"^!([\w-]+)(?:\s+(.*))?$", content, re.DOTALL)
            if match and self._on_command is not None:
                await self._on_command(
                    InboundCommand(
                        channel_id=channel_id,
                        channel_type="channel_private",
                        sender_id=sender_address,
                        sender_name=display_sender,
                        command=match.group(1),
                        args=match.group(2) or "",
                        message_ref=ref,
                        root_id=root_ref,
                        channel_name=channel_name,
                    )
                )
                return
        if self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    channel_id=channel_id,
                    channel_type="channel_private",
                    sender_id=sender_address,
                    sender_name=display_sender,
                    content=content or "(Email contained no new text.)",
                    message_ref=ref,
                    root_id=root_ref,
                    channel_name=channel_name,
                    attachments=attachments,
                    attachment_failures=failures,
                )
            )

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        return await self.send_message_with_idempotency_key(
            uuid.uuid4().hex,
            channel_id,
            sender_name,
            content,
            thread_root_id,
            room_wide_mention=room_wide_mention,
        )

    async def send_message_with_idempotency_key(
        self,
        idempotency_key: str,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        chunks = _split_outbound_body(content)
        recipients, subject = self._outbound_audience(
            channel_id, thread_root_id, content, sender_name
        )
        root_ref = thread_root_id
        first_message_id: str | None = None
        for index, chunk in enumerate(chunks, start=1):
            if len(chunks) > 1:
                chunk = f"Part {index} of {len(chunks)}\n\n{chunk}"
            part_key = f"message:{index}" if len(chunks) > 1 else "message"
            message_id = await self._send_email_with_idempotency_key(
                idempotency_key,
                part_key,
                channel_id,
                sender_name,
                chunk,
                root_ref,
                [],
                subject,
            )
            if first_message_id is None:
                first_message_id = message_id
                if root_ref is None and len(chunks) > 1:
                    root_ref = _thread_ref(first_message_id, recipients[0], subject)
        return first_message_id

    def _outbound_audience(
        self,
        channel_id: str,
        thread_root_id: str | None,
        content: str,
        sender_name: str,
    ) -> tuple[list[str], str]:
        if _decode_channel_id(channel_id) != self._config.from_address.lower():
            raise BridgeOperationError(
                "The email room does not match the connected mailbox."
            )
        allowed = _allowed_senders(self._config.allowed_senders)
        thread = _decode_thread_ref(thread_root_id)
        if thread is not None:
            recipient = str(thread.get("sender", "")).lower()
            if recipient not in allowed:
                raise BridgeOperationError(
                    "The email thread's sender is not on the configured allowlist."
                )
            recipients = [recipient]
            subject = _normal_subject(str(thread.get("subject", "")))
        else:
            recipients = sorted(allowed)
            if not recipients:
                raise BridgeOperationError(
                    "No allowed sender is configured to receive email replies."
                )
            first_line = next(
                (line.strip() for line in content.splitlines() if line.strip()), ""
            )
            subject = _normal_subject(
                first_line[:120] if first_line else f"Message from {sender_name}"
            )
        return recipients, subject

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        return await self.send_message(channel_id, "Switch", content, thread_root_id)

    async def admin_message_with_idempotency_key(
        self,
        idempotency_key: str,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        del message_type
        rendered = self._admin_body(self.translate_outbound(content), drawn)
        return await self.send_message_with_idempotency_key(
            idempotency_key,
            channel_id,
            "Switch",
            rendered,
            thread_root_id,
        )

    def _send_email(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None,
        files: list[tuple[str, str, bytes]],
        subject_override: str | None = None,
    ) -> str:
        message, recipients = self._build_email(
            channel_id,
            sender_name,
            content,
            thread_root_id,
            files,
            subject_override,
        )
        client = _smtp_connect(self._config)
        try:
            refused = client.send_message(message)
            if refused:
                refused_recipients = ", ".join(sorted(refused))
                raise BridgeOperationError(
                    f"SMTP refused delivery to: {refused_recipients}."
                )
        except (smtplib.SMTPException, OSError) as exc:
            raise BridgeOperationError(
                f"SMTP could not send email to {', '.join(recipients)}: {exc}"
            ) from exc
        finally:
            try:
                client.quit()
            except (smtplib.SMTPException, OSError):
                pass
        return str(message["Message-ID"])

    def _build_email(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None,
        files: list[tuple[str, str, bytes]],
        subject_override: str | None = None,
    ) -> tuple[EmailMessage, list[str]]:
        recipients, subject = self._outbound_audience(
            channel_id, thread_root_id, content, sender_name
        )
        subject = subject_override or subject
        thread = _decode_thread_ref(thread_root_id)
        message = EmailMessage()
        message["From"] = formataddr((sender_name, self._config.from_address))
        message["To"] = ", ".join(recipients)
        message["Subject"] = f"Re: {subject}" if thread else subject
        message_id = make_msgid(domain=self._config.from_address.rsplit("@", 1)[-1])
        message["Message-ID"] = message_id
        message["Auto-Submitted"] = "auto-generated"
        message["X-Switch-Email-Bridge"] = "1"
        if thread and thread.get("message_id", "").startswith("<"):
            message["In-Reply-To"] = thread["message_id"]
            message["References"] = thread["message_id"]
        message.set_content(content)
        message.add_alternative(_render_html(content), subtype="html")
        for filename, mimetype, data in files:
            maintype, _, subtype = mimetype.partition("/")
            message.add_attachment(
                data,
                maintype=maintype or "application",
                subtype=subtype or "octet-stream",
                filename=filename,
            )
        return message, recipients

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
        return await self.send_attachment_with_idempotency_key(
            uuid.uuid4().hex,
            channel_id,
            sender_name,
            filename,
            mimetype,
            data,
            caption=caption,
            thread_root_id=thread_root_id,
        )

    async def send_attachment_with_idempotency_key(
        self,
        idempotency_key: str,
        channel_id: str,
        sender_name: str,
        filename: str,
        mimetype: str,
        data: bytes,
        caption: str | None = None,
        thread_root_id: str | None = None,
        *,
        part_key: str = "attachment",
    ) -> str | None:
        if len(data) > min(self._max_attachment_bytes, _MAX_ATTACHMENT_BYTES):
            note = (
                f"{sender_name} could not attach {filename}: email attachments are limited to "
                f"{min(self._max_attachment_bytes, _MAX_ATTACHMENT_BYTES)} bytes."
            )
            return await self._send_email_with_idempotency_key(
                idempotency_key,
                part_key,
                channel_id,
                "Switch",
                note,
                thread_root_id,
                [],
            )
        content = caption or f"{sender_name} shared {filename}"
        return await self._send_email_with_idempotency_key(
            idempotency_key,
            part_key,
            channel_id,
            sender_name,
            content,
            thread_root_id,
            [(filename, mimetype, data)],
        )

    async def send_attachments_with_idempotency_key(
        self,
        idempotency_key: str,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        first_message_id: str | None = None
        for index, file in enumerate(files):
            message_id = await self.send_attachment_with_idempotency_key(
                idempotency_key,
                channel_id,
                sender_name,
                file.filename,
                file.mimetype,
                file.data,
                caption=caption if index == 0 else None,
                thread_root_id=thread_root_id,
                part_key=f"attachment:{index + 1}",
            )
            if first_message_id is None:
                first_message_id = message_id
        return first_message_id

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        # SMTP has no message recall or edit operation.
        return None

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        # SMTP has no message recall or delete operation.
        return None

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        return None

    async def create_channel(
        self, name: str, topic: str, *, channel_type: ChannelType = "channel_private"
    ) -> str:
        raise ChannelCreationUnsupported(
            "Email rooms are created when someone emails the connected mailbox."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_private"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        return list(user_external_ids)

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    def _render_outbound(self, content: str) -> str:
        return content
