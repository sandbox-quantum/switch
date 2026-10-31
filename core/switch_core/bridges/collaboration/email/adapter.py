"""Email collaboration bridge adapter.

Connects Switch to any standard email mailbox via IMAP (inbound) and SMTP (outbound).
Maps email conversations to Switch rooms and threads cleanly, handles attachments,
strips quoted reply noise and signatures, and dispatches !commands.
"""

from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import html
import imaplib
import logging
import re
import smtplib
import socket
import uuid
from collections.abc import Awaitable, Callable
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.parser import BytesParser
from email.policy import default as default_policy
from email.utils import getaddresses, parseaddr
from typing import Any, ClassVar, Literal

from pydantic import Field, model_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
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

# Max unseen messages fetched in a single poll batch to avoid starving event loop
_MAX_BATCH_FETCH = 50
# Capacity of seen message IDs LRU set
_SEEN_CACHE_SIZE = 10000


def clean_message_id(msg_id: str | None) -> str | None:
    """Normalize a Message-ID header, removing angle brackets and whitespace."""
    if not msg_id:
        return None
    cleaned = msg_id.strip("<> \t\r\n")
    return cleaned if cleaned else None


def clean_email_body(text: str) -> str:
    """Strip quoted replies, forward headers, and signatures from an email body."""
    lines = text.splitlines()
    cleaned: list[str] = []

    reply_patterns = [
        re.compile(r"^On\s+.+?wrote:\s*$", re.IGNORECASE),
        re.compile(r"^From:\s+.+?Sent:\s+.+?", re.IGNORECASE),
        re.compile(r"^-+\s*Original Message\s*-+", re.IGNORECASE),
        re.compile(r"^-+\s*Forwarded message\s*-+", re.IGNORECASE),
    ]

    for line in lines:
        stripped = line.strip()
        # Signature marker (RFC 3676 convention: "-- " or "--")
        if stripped in ("--", "-- "):
            break
        # Quoted text in email replies
        if stripped.startswith(">"):
            continue
        # Standard reply header block
        if any(p.match(stripped) for p in reply_patterns):
            break
        cleaned.append(line)

    return "\n".join(cleaned).strip()


def is_sender_allowed(sender_email: str, allowed_patterns: list[str]) -> bool:
    """Check if the sender email matches the configured allowlist rules."""
    if not allowed_patterns:
        return True
    sender_lower = sender_email.lower().strip()
    for pattern in allowed_patterns:
        pat = pattern.lower().strip()
        if pat == sender_lower or fnmatch.fnmatch(sender_lower, pat):
            return True
    return False


def decode_mime_header(header_value: str | None) -> str:
    """Safely decode RFC 2047 MIME encoded words in email headers."""
    if not header_value:
        return ""
    try:
        return str(make_header(decode_header(header_value)))
    except Exception:
        return header_value


class EmailConnectionConfig(BridgeConnectionConfig):
    """Connection settings for connecting an email mailbox via IMAP and SMTP."""

    email_address: str = Field(
        ...,
        description="The email address this bridge uses (e.g. agents@example.com).",
    )
    sender_name: str = Field(
        default="Switch Agent",
        description="Default display name when sending emails.",
    )

    # Inbound (IMAP)
    imap_host: str = Field(
        ...,
        description="IMAP server hostname (e.g. imap.gmail.com).",
    )
    imap_port: int = Field(
        default=993,
        description="IMAP server port (usually 993 for SSL/TLS, 143 for STARTTLS/plain).",
    )
    imap_username: str = Field(
        ...,
        description="Username for IMAP authentication.",
    )
    imap_password: str = Field(
        ...,
        description="Password or App Password for IMAP authentication.",
        json_schema_extra={"format": "password"},
    )
    imap_use_ssl: bool = Field(
        default=True,
        description="Use SSL/TLS for IMAP connection (port 993).",
    )
    imap_folder: str = Field(
        default="INBOX",
        description="IMAP folder to check for incoming messages (default: INBOX).",
    )
    poll_interval_seconds: int = Field(
        default=15,
        description="How often (in seconds) to check for new emails.",
        ge=1,
        le=300,
    )

    # Outbound (SMTP)
    smtp_host: str = Field(
        ...,
        description="SMTP server hostname (e.g. smtp.gmail.com).",
    )
    smtp_port: int = Field(
        default=587,
        description="SMTP server port (usually 587 for STARTTLS, 465 for SSL).",
    )
    smtp_username: str = Field(
        ...,
        description="Username for SMTP authentication (often the same as IMAP).",
    )
    smtp_password: str = Field(
        ...,
        description="Password or App Password for SMTP authentication.",
        json_schema_extra={"format": "password"},
    )
    smtp_use_tls: bool = Field(
        default=True,
        description="Use STARTTLS for SMTP connection (typically port 587).",
    )
    smtp_use_ssl: bool = Field(
        default=False,
        description="Use direct SSL for SMTP connection (typically port 465).",
    )

    # Security & Limits
    allowed_senders: list[str] = Field(
        default_factory=list,
        description="Optional list of allowed sender email addresses or domain patterns (e.g. ['*@company.com']). If empty, all senders are accepted.",
    )
    max_attachment_size_bytes: int = Field(
        default=20 * 1024 * 1024,
        description="Maximum attachment size in bytes (default: 20MB).",
    )

    @model_validator(mode="after")
    def _validate_smtp_ssl(self) -> EmailConnectionConfig:
        if self.smtp_use_ssl and self.smtp_use_tls:
            raise ValueError("Cannot enable both direct SSL and STARTTLS for SMTP.")
        if "@" not in self.email_address:
            raise ValueError(f"Invalid email address: {self.email_address!r}")
        return self


class EmailAdapter(PlatformAdapter):
    """Collaboration bridge driving email over IMAP and SMTP."""

    display_name: ClassVar[str] = "Email"
    docs_slug: ClassVar[str | None] = "email"
    channel_on_delete: ClassVar[Literal["archived", "deleted", "left", "kept"]] = "kept"
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    supports_activity_reactions: ClassVar[bool] = False
    keeps_quiet_unless_listening: ClassVar[bool] = True
    every_message_notifies_members: ClassVar[bool] = True

    def __init__(self, *, config: EmailConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._domain = config.email_address.split("@")[-1]

        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None

        self._poll_task: asyncio.Task[None] | None = None
        self._running = False

        # Deduplication cache
        self._seen_message_ids: set[str] = set()

        # In-memory mapping of threads to sender recipient & original subject
        self._thread_recipients: dict[str, str] = {}
        self._thread_subjects: dict[str, str] = {}

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, smtplib.SMTPAuthenticationError):
            return "auth_failed"
        if isinstance(exc, smtplib.SMTPConnectError):
            return "network"
        if isinstance(exc, imaplib.IMAP4.error):
            msg = str(exc).upper()
            if "AUTHENTICATION" in msg or "LOGIN" in msg or "CREDENTIAL" in msg:
                return "auth_failed"
            return "platform_error"
        if isinstance(exc, smtplib.SMTPException):
            return "platform_error"
        if isinstance(
            exc,
            (
                ConnectionRefusedError,
                TimeoutError,
                socket.gaierror,
                OSError,
            ),
        ):
            return "network"
        return None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Verify IMAP and SMTP credentials during connection creation/edit."""
        config = EmailConnectionConfig.model_validate(connection_config)

        def _verify_imap() -> None:
            imap: imaplib.IMAP4 | None = None
            try:
                if config.imap_use_ssl:
                    imap = imaplib.IMAP4_SSL(config.imap_host, config.imap_port)
                else:
                    imap = imaplib.IMAP4(config.imap_host, config.imap_port)
                imap.login(config.imap_username, config.imap_password)
                imap.select(config.imap_folder)
            except Exception as exc:
                raise BridgeCredentialError(
                    f"IMAP login failed for {config.imap_username}@{config.imap_host}: {exc}"
                ) from exc
            finally:
                if imap is not None:
                    try:
                        imap.logout()
                    except Exception:
                        pass

        def _verify_smtp() -> None:
            smtp: smtplib.SMTP | smtplib.SMTP_SSL | None = None
            try:
                if config.smtp_use_ssl:
                    smtp = smtplib.SMTP_SSL(config.smtp_host, config.smtp_port)
                else:
                    smtp = smtplib.SMTP(config.smtp_host, config.smtp_port)
                    if config.smtp_use_tls:
                        smtp.starttls()
                if config.smtp_username and config.smtp_password:
                    smtp.login(config.smtp_username, config.smtp_password)
            except Exception as exc:
                raise BridgeCredentialError(
                    f"SMTP login failed for {config.smtp_username}@{config.smtp_host}: {exc}"
                ) from exc
            finally:
                if smtp is not None:
                    try:
                        smtp.quit()
                    except Exception:
                        pass

        await asyncio.to_thread(_verify_imap)
        await asyncio.to_thread(_verify_smtp)

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        addr = str(connection_config.get("email_address") or "").lower().strip()
        return f"email:{addr}" if addr else None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

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
        self._running = True

        if self._listening:
            self._start_poller()

    async def stop(self) -> None:
        self._running = False
        self._stop_poller()

    def set_listening(self, listening: bool) -> None:
        super().set_listening(listening)
        if listening and self._running:
            self._start_poller()
        elif not listening:
            self._stop_poller()

    def _start_poller(self) -> None:
        if self._poll_task is None or self._poll_task.done():
            self._poll_task = asyncio.create_task(
                self._poll_loop(), name="email-poller"
            )

    def _stop_poller(self) -> None:
        if self._poll_task is not None:
            self._poll_task.cancel()
            self._poll_task = None

    async def _poll_loop(self) -> None:
        """Poll the mailbox on interval while running and listening."""
        logger.info(
            "Starting email polling for %s on %s:%s",
            self.config.email_address,
            self.config.imap_host,
            self.config.imap_port,
        )
        while self._running and self._listening:
            try:
                await asyncio.to_thread(self._poll_inbox)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning(
                    "Error during email poll for %s: %s", self.config.email_address, exc
                )

            try:
                await asyncio.sleep(self.config.poll_interval_seconds)
            except asyncio.CancelledError:
                break

    # ── Inbound Parsing ───────────────────────────────────────────────────────

    def _create_imap_client(self) -> imaplib.IMAP4 | imaplib.IMAP4_SSL:
        """Create and sign in an IMAP client. Hookable for tests."""
        imap: imaplib.IMAP4 | imaplib.IMAP4_SSL
        if self.config.imap_use_ssl:
            imap = imaplib.IMAP4_SSL(self.config.imap_host, self.config.imap_port)
        else:
            imap = imaplib.IMAP4(self.config.imap_host, self.config.imap_port)
        imap.login(self.config.imap_username, self.config.imap_password)
        return imap

    def _create_smtp_client(self) -> smtplib.SMTP | smtplib.SMTP_SSL:
        """Create and sign in an SMTP client. Hookable for tests."""
        smtp: smtplib.SMTP | smtplib.SMTP_SSL
        if self.config.smtp_use_ssl:
            smtp = smtplib.SMTP_SSL(self.config.smtp_host, self.config.smtp_port)
        else:
            smtp = smtplib.SMTP(self.config.smtp_host, self.config.smtp_port)
            if self.config.smtp_use_tls:
                smtp.starttls()
        if self.config.smtp_username and self.config.smtp_password:
            smtp.login(self.config.smtp_username, self.config.smtp_password)
        return smtp

    def _poll_inbox(self) -> None:
        """Check for unread messages, parse them, and dispatch events."""
        imap = self._create_imap_client()
        try:
            status, _ = imap.select(self.config.imap_folder)
            if status != "OK":
                logger.warning("Failed to select folder %s", self.config.imap_folder)
                return

            status, data = imap.search(None, "UNSEEN")
            if status != "OK" or not data or not data[0]:
                return

            msg_nums = data[0].split()
            # Bound batch size
            for msg_num in msg_nums[:_MAX_BATCH_FETCH]:
                try:
                    fetch_status, fetch_data = imap.fetch(msg_num, "(RFC822)")
                    if fetch_status != "OK" or not fetch_data:
                        continue

                    raw_bytes: bytes | None = None
                    for part in fetch_data:
                        if (
                            isinstance(part, tuple)
                            and len(part) > 1
                            and isinstance(part[1], bytes)
                        ):
                            raw_bytes = part[1]
                            break

                    if raw_bytes is None:
                        continue

                    email_msg = BytesParser(policy=default_policy).parsebytes(raw_bytes)
                    self._process_email(email_msg)

                    # Mark message as seen
                    imap.store(msg_num, "+FLAGS", "\\Seen")
                except Exception as exc:
                    logger.warning("Failed processing email #%s: %s", msg_num, exc)
        finally:
            try:
                imap.logout()
            except Exception:
                pass

    def _process_email(self, msg: EmailMessage) -> None:
        """Parse an EmailMessage and hand it to the inbound callbacks."""
        msg_id_header = msg.get("Message-ID")
        msg_id = clean_message_id(msg_id_header)
        if not msg_id:
            msg_id = f"email-{hashlib.sha256(msg.as_bytes()).hexdigest()[:16]}"

        if msg_id in self._seen_message_ids:
            return

        self._record_seen_id(msg_id)

        # Parse Sender
        from_hdr = decode_mime_header(msg.get("From"))
        sender_name, sender_email = parseaddr(from_hdr)
        sender_email = sender_email.lower().strip()
        sender_name = sender_name.strip() or sender_email

        # Ignore self-sent emails
        if sender_email == self.config.email_address.lower().strip():
            logger.debug("Skipping message from own address %s", sender_email)
            return

        # Check sender allowlist
        if not is_sender_allowed(sender_email, self.config.allowed_senders):
            logger.info("Dropping email from disallowed sender: %s", sender_email)
            return

        # Subject & Threading
        raw_subject = decode_mime_header(msg.get("Subject"))
        subject = raw_subject.strip()

        in_reply_to = clean_message_id(msg.get("In-Reply-To"))
        references_header = msg.get("References") or ""
        ref_tokens = [
            clean_message_id(t)
            for t in references_header.split()
            if clean_message_id(t)
        ]

        root_id: str | None = None
        if ref_tokens:
            root_id = ref_tokens[0]
        elif in_reply_to:
            root_id = in_reply_to

        # Room mapping: plus-addressing (e.g. mailbox+room_123@domain.com) or direct conversation
        channel_id = sender_email
        channel_type: ChannelType = "direct"

        to_headers = msg.get_all("To", []) + msg.get_all("Delivered-To", [])
        for to_hdr in to_headers:
            for _, addr in getaddresses([to_hdr]):
                addr_lower = addr.lower().strip()
                if "+" in addr_lower and addr_lower.endswith(f"@{self._domain}"):
                    local_part = addr_lower.split("@", 1)[0]
                    room_candidate = local_part.split("+", 1)[1]
                    if room_candidate:
                        channel_id = room_candidate
                        channel_type = "channel_public"
                        break

        # Extract Body and Attachments
        body, attachments, attachment_failures = self._extract_parts(msg)

        # Record thread info for outgoing replies
        self._thread_recipients[msg_id] = sender_email
        self._thread_subjects[msg_id] = subject
        if root_id:
            self._thread_recipients[root_id] = sender_email
            self._thread_subjects[root_id] = subject

        # Command handling: !command or /command
        stripped_body = body.strip()
        loop = asyncio.get_running_loop()
        if stripped_body and stripped_body[0] in ("!", "/"):
            parts = stripped_body.split(None, 1)
            command_name = parts[0][1:]
            command_args = parts[1].strip() if len(parts) > 1 else ""

            if self._on_command is not None:
                cmd_handler = self._on_command
                cmd = InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=sender_email,
                    sender_name=sender_name,
                    command=command_name,
                    args=command_args,
                    message_ref=msg_id,
                    root_id=root_id,
                )

                async def _dispatch_cmd() -> None:
                    await cmd_handler(cmd)

                asyncio.run_coroutine_threadsafe(_dispatch_cmd(), loop)
            return

        # Normal message
        if self._on_message is not None:
            msg_handler = self._on_message
            inbound_msg = InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=sender_email,
                sender_name=sender_name,
                content=body,
                message_ref=msg_id,
                root_id=root_id,
                attachments=attachments,
                attachment_failures=attachment_failures,
            )

            async def _dispatch_msg() -> None:
                await msg_handler(inbound_msg)

            asyncio.run_coroutine_threadsafe(_dispatch_msg(), loop)

    def _extract_parts(
        self, msg: EmailMessage
    ) -> tuple[str, list[Attachment], list[AttachmentFailure]]:
        plain_parts: list[str] = []
        html_parts: list[str] = []
        attachments: list[Attachment] = []
        attachment_failures: list[AttachmentFailure] = []

        for part in msg.walk():
            disposition = str(part.get("Content-Disposition") or "").lower()
            filename = part.get_filename()
            content_type = part.get_content_type()

            is_attachment = "attachment" in disposition or (
                filename is not None and not content_type.startswith("text/")
            )

            if is_attachment:
                fname = filename or "attachment.dat"
                payload = part.get_payload(decode=True)
                if payload is not None:
                    if len(payload) > self.config.max_attachment_size_bytes:
                        attachment_failures.append(
                            AttachmentFailure(
                                filename=fname,
                                reason=(
                                    f"Oversize attachment ({len(payload)} bytes exceeds "
                                    f"{self.config.max_attachment_size_bytes} byte limit)"
                                ),
                            )
                        )
                    else:
                        attachments.append(
                            Attachment(
                                filename=fname,
                                data=payload,
                                mimetype=content_type,
                            )
                        )
                continue

            if content_type == "text/plain":
                payload = part.get_payload(decode=True)
                if isinstance(payload, bytes):
                    charset = part.get_content_charset() or "utf-8"
                    plain_parts.append(payload.decode(charset, errors="replace"))
            elif content_type == "text/html":
                payload = part.get_payload(decode=True)
                if isinstance(payload, bytes):
                    charset = part.get_content_charset() or "utf-8"
                    html_parts.append(payload.decode(charset, errors="replace"))

        if plain_parts:
            raw_text = "\n".join(plain_parts)
        elif html_parts:
            raw_html = "\n".join(html_parts)
            text = re.sub(r"(?i)<br\s*/?>", "\n", raw_html)
            text = re.sub(r"(?i)</p>", "\n\n", text)
            text = re.sub(r"<[^>]+>", "", text)
            raw_text = html.unescape(text)
        else:
            raw_text = ""

        cleaned_text = clean_email_body(raw_text)
        return cleaned_text, attachments, attachment_failures

    def _record_seen_id(self, msg_id: str) -> None:
        if len(self._seen_message_ids) >= _SEEN_CACHE_SIZE:
            # Drop older entries
            self._seen_message_ids.clear()
        self._seen_message_ids.add(msg_id)

    # ── Outbound ──────────────────────────────────────────────────────────────

    def _resolve_recipient(
        self, channel_id: str, thread_root_id: str | None
    ) -> str | None:
        if thread_root_id and thread_root_id in self._thread_recipients:
            return self._thread_recipients[thread_root_id]
        if "@" in channel_id:
            return channel_id
        return self._thread_recipients.get(channel_id)

    def _resolve_subject(
        self, channel_id: str, thread_root_id: str | None, sender_name: str
    ) -> str:
        if thread_root_id and thread_root_id in self._thread_subjects:
            orig = self._thread_subjects[thread_root_id]
            if orig:
                return orig if orig.lower().startswith("re:") else f"Re: {orig}"
        if channel_id in self._thread_subjects:
            orig = self._thread_subjects[channel_id]
            if orig:
                return orig if orig.lower().startswith("re:") else f"Re: {orig}"
        return f"Message from {sender_name} via Switch"

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        recipient = self._resolve_recipient(channel_id, thread_root_id)
        if not recipient:
            logger.warning(
                "Cannot dispatch email: no known recipient for channel_id %s",
                channel_id,
            )
            return None

        subject = self._resolve_subject(channel_id, thread_root_id, sender_name)
        new_id = f"switch-{uuid.uuid4().hex}@{self._domain}"

        msg = EmailMessage()
        msg["From"] = f"{sender_name} <{self.config.email_address}>"
        msg["To"] = recipient
        msg["Subject"] = subject
        msg["Message-ID"] = f"<{new_id}>"

        if thread_root_id:
            msg["In-Reply-To"] = f"<{thread_root_id}>"
            msg["References"] = f"<{thread_root_id}>"

        msg.set_content(content)

        def _send() -> None:
            smtp = self._create_smtp_client()
            try:
                smtp.send_message(msg)
            finally:
                try:
                    smtp.quit()
                except Exception:
                    pass

        await asyncio.to_thread(_send)

        self._record_seen_id(new_id)
        self._thread_recipients[new_id] = recipient
        self._thread_subjects[new_id] = subject
        if thread_root_id:
            self._thread_recipients[thread_root_id] = recipient
            self._thread_subjects[thread_root_id] = subject

        return new_id

    async def update_message(
        self,
        channel_id: str,
        message_id: str,
        content: str,
        *,
        room_wide_mention: bool = False,
    ) -> None:
        # Sent emails cannot be modified once delivered
        return None

    async def delete_message(self, channel_id: str, message_id: str) -> None:
        # Sent emails cannot be recalled or deleted
        return None

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # Email has no typing indicator
        return None

    # ── Channel & Membership ──────────────────────────────────────────────────

    async def create_channel(
        self, name: str, topic: str, *, channel_type: ChannelType = "channel_public"
    ) -> str:
        raise ChannelCreationUnsupported(
            "Email platform does not support creating channels."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct" if "@" in channel_id else "channel_public"

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
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    # ── Rendering ─────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw: Any) -> str:
        return str(raw)
