from __future__ import annotations

import asyncio
import html
import imaplib
import json
import logging
import re
import smtplib
import ssl
from collections.abc import Awaitable, Callable
from email.header import decode_header, make_header
from email.message import EmailMessage, Message
from email.parser import BytesParser
from email.policy import default
from email.utils import formataddr, make_msgid, parseaddr
from html.parser import HTMLParser
from typing import ClassVar, Literal
from urllib.parse import quote, unquote, urlsplit

import markdown
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
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
)

logger = logging.getLogger(__name__)

_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
_MAX_BODY_CHARS = 40_000
_COMMAND_PREFIX = "!"
_THREAD_PREFIX = "email-ref:"


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
        default="",
        description="Optional comma-separated sender allowlist. Empty accepts any sender reaching this mailbox.",
    )
    poll_interval_seconds: int = Field(default=30, ge=10, le=300)

    @field_validator("from_address")
    @classmethod
    def _valid_from_address(cls, value: str) -> str:
        address = parseaddr(value)[1]
        if not address or "@" not in address:
            raise ValueError("from_address must be a valid email address")
        return address


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
            return ids[0]
    reply = message.get("In-Reply-To")
    if reply:
        ids = re.findall(r"<[^>]+>", str(reply))
        return ids[0] if ids else str(reply).strip()
    return None


def _channel_id(sender: str, subject: str) -> str:
    return f"email:{quote(sender.lower(), safe='')}:{quote(_normal_subject(subject), safe='')}"


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


def _decode_channel_id(value: str) -> tuple[str, str]:
    if not value.startswith("email:"):
        raise BridgeOperationError("The email room reference is malformed.")
    recipient, separator, subject = value[6:].partition(":")
    if not separator:
        raise BridgeOperationError("The email room has no recipient address.")
    return unquote(recipient), unquote(subject)


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
        payload = part.get_payload(decode=True)
        payload = payload or b""
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


def _imap_connect(config: EmailConnectionConfig) -> imaplib.IMAP4:
    try:
        if config.imap_security == "ssl":
            client: imaplib.IMAP4 = imaplib.IMAP4_SSL(
                config.imap_host, config.imap_port, timeout=20
            )
        else:
            client = imaplib.IMAP4(config.imap_host, config.imap_port, timeout=20)
            client.starttls(ssl_context=ssl.create_default_context())
        client.login(config.imap_username, config.imap_password)
        return client
    except (imaplib.IMAP4.error, OSError, ssl.SSLError) as exc:
        raise BridgeCredentialError(
            f"IMAP sign-in failed for {config.imap_username}: {exc}"
        ) from exc


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
        status, _ = imap.select(config.imap_folder, readonly=True)
        if status != "OK":
            raise BridgeCredentialError(
                f"IMAP mailbox folder {config.imap_folder!r} was not found."
            )
    finally:
        try:
            imap.logout()
        except (imaplib.IMAP4.error, OSError):
            pass
    smtp = _smtp_connect(config)
    try:
        smtp.noop()
    finally:
        try:
            smtp.quit()
        except (smtplib.SMTPException, OSError):
            pass


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
        self._poll_task: asyncio.Task[None] | None = None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = EmailConnectionConfig.model_validate(connection_config)
        await asyncio.to_thread(_verify_mailbox, config)

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(
            exc, (imaplib.IMAP4.error, smtplib.SMTPException, BridgeCredentialError)
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
        if self._listening:
            self._poll_task = asyncio.create_task(
                self._poll_loop(), name="email-imap-poller"
            )

    async def stop(self) -> None:
        task = self._poll_task
        self._poll_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def _poll_loop(self) -> None:
        while True:
            try:
                records = await asyncio.to_thread(self._fetch_unseen)
                for uidvalidity, uid, raw in records:
                    await self._dispatch_email(uidvalidity, uid, raw)
                    # The mailbox flag is the durable cursor shared by Switch
                    # pods. Set it after transport dispatch so a failed write
                    # remains available for the next poll.
                    await asyncio.to_thread(self._mark_seen, uid)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "Email mailbox poll failed for %s", self._config.imap_username
                )
            await asyncio.sleep(self._config.poll_interval_seconds)

    def _fetch_unseen(self) -> list[tuple[str, str, bytes]]:
        client = _imap_connect(self._config)
        try:
            status, _ = client.select(self._config.imap_folder)
            if status != "OK":
                raise BridgeOperationError(
                    f"IMAP folder {self._config.imap_folder!r} could not be selected."
                )
            _, validity_data = client.response("UIDVALIDITY")
            uidvalidity = (validity_data or [b"unknown"])[0].decode(errors="replace")
            status, data = client.uid("SEARCH", None, "UNSEEN")
            if status != "OK":
                raise BridgeOperationError("IMAP could not search for unread messages.")
            uids = data[0].split() if data and data[0] else []
            records: list[tuple[str, str, bytes]] = []
            for uid_bytes in uids:
                uid = uid_bytes.decode("ascii", errors="ignore")
                # BODY.PEEK leaves the shared mailbox cursor untouched until
                # dispatch succeeds and _mark_seen commits the message.
                status, fetched = client.uid("FETCH", uid, "(BODY.PEEK[])")
                if status != "OK":
                    continue
                raw = next(
                    (
                        item[1]
                        for item in fetched
                        if isinstance(item, tuple) and isinstance(item[1], bytes)
                    ),
                    None,
                )
                if raw is not None:
                    records.append((uidvalidity, uid, raw))
            return records
        finally:
            try:
                client.logout()
            except (imaplib.IMAP4.error, OSError):
                pass

    def _mark_seen(self, uid: str) -> None:
        client = _imap_connect(self._config)
        try:
            status, _ = client.select(self._config.imap_folder)
            if status != "OK":
                raise BridgeOperationError(
                    f"IMAP folder {self._config.imap_folder!r} could not be selected."
                )
            status, _ = client.uid("STORE", uid, "+FLAGS", "(\\Seen)")
            if status != "OK":
                raise BridgeOperationError(
                    f"IMAP could not mark message UID {uid} as seen."
                )
        finally:
            try:
                client.logout()
            except (imaplib.IMAP4.error, OSError):
                pass

    async def _dispatch_email(self, uidvalidity: str, uid: str, raw: bytes) -> None:
        message = BytesParser(policy=default).parsebytes(raw)
        from_header = _decode_header(message.get("From"))
        sender_name, sender_address = parseaddr(from_header)
        sender_address = sender_address.strip().lower()
        if not sender_address:
            logger.warning("Ignoring email UID %s without a usable From address", uid)
            return
        allowed = _allowed_senders(self._config.allowed_senders)
        if allowed and sender_address not in allowed:
            logger.info("Ignoring email from sender outside the configured allowlist")
            return
        subject = _normal_subject(_decode_header(message.get("Subject")))
        message_id = str(
            message.get("Message-ID") or f"<imap-{uidvalidity}-{uid}@switch.local>"
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
        channel_id = _channel_id(sender_address, subject)
        channel_name = subject
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
        message_id = await asyncio.to_thread(
            self._send_email, channel_id, sender_name, content, thread_root_id, []
        )
        return message_id

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

    def _send_email(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None,
        files: list[tuple[str, str, bytes]],
    ) -> str:
        recipient, subject = _decode_channel_id(channel_id)
        thread = _decode_thread_ref(thread_root_id)
        message = EmailMessage()
        message["From"] = formataddr((sender_name, self._config.from_address))
        message["To"] = recipient
        message["Subject"] = f"Re: {subject}" if thread else subject
        message_id = make_msgid(domain=self._config.from_address.rsplit("@", 1)[-1])
        message["Message-ID"] = message_id
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
        client = _smtp_connect(self._config)
        try:
            refused = client.send_message(message)
            if refused:
                raise BridgeOperationError(f"SMTP refused delivery to {recipient}.")
        except (smtplib.SMTPException, OSError) as exc:
            raise BridgeOperationError(
                f"SMTP could not send email to {recipient}: {exc}"
            ) from exc
        finally:
            try:
                client.quit()
            except (smtplib.SMTPException, OSError):
                pass
        return message_id

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
        if len(data) > min(self._max_attachment_bytes, _MAX_ATTACHMENT_BYTES):
            note = (
                f"{sender_name} could not attach {filename}: email attachments are limited to "
                f"{min(self._max_attachment_bytes, _MAX_ATTACHMENT_BYTES)} bytes."
            )
            return await self.send_message(channel_id, "Switch", note, thread_root_id)
        content = caption or f"{sender_name} shared {filename}"
        return await asyncio.to_thread(
            self._send_email,
            channel_id,
            sender_name,
            content,
            thread_root_id,
            [(filename, mimetype, data)],
        )

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
