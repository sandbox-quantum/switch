from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import html
import imaplib
import logging
import re
import smtplib
import ssl
import uuid
from email.header import decode_header
from email.message import EmailMessage
from email.parser import BytesParser
from email.policy import default as default_policy
from email.utils import formataddr, parseaddr
from typing import Any, ClassVar

from pydantic import Field, model_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelRetirement,
    ChannelType,
    FailureReason,
    InboundCommand,
    InboundMessage,
    RetireOutcome,
)

logger = logging.getLogger(__name__)

_COMMAND_PREFIXES = ("!",)
_MAX_BATCH_FETCH = 50
_SEEN_CACHE_SIZE = 10000


def clean_message_id(msg_id: str | None) -> str | None:
    """Normalize Message-ID removing surrounding angle brackets and extra whitespace."""
    if not msg_id:
        return None
    cleaned = msg_id.strip().strip("<>").strip()
    return cleaned if cleaned else None


def decode_mime_header(header_value: str | None) -> str:
    """Safely decode MIME encoded header into unicode string."""
    if not header_value:
        return ""
    parts = decode_header(header_value)
    decoded_fragments: list[str] = []
    for content, encoding in parts:
        if isinstance(content, bytes):
            charset = encoding or "utf-8"
            try:
                decoded_fragments.append(content.decode(charset, errors="replace"))
            except LookupError:
                decoded_fragments.append(content.decode("latin-1", errors="replace"))
        else:
            decoded_fragments.append(str(content))
    return " ".join(decoded_fragments).strip()


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
        if fnmatch.fnmatch(sender_lower, pat):
            return True
        if pat.startswith("@") and (
            sender_lower.endswith(pat) or sender_lower.endswith("." + pat.lstrip("@"))
        ):
            return True
    return False


def is_auto_submitted_or_bounce(msg: EmailMessage) -> bool:
    """Check whether the email is an automated response, bounce, or list delivery to prevent loops."""
    auto_submitted = (msg.get("Auto-Submitted") or "").lower().strip()
    if auto_submitted and auto_submitted != "no":
        return True

    precedence = (msg.get("Precedence") or "").lower().strip()
    if precedence in ("bulk", "list", "junk", "auto_reply"):
        return True

    if msg.get("List-Id") or msg.get("List-Unsubscribe"):
        return True

    return_path = (msg.get("Return-Path") or "").strip()
    if return_path == "<>":
        return True

    return False


class EmailConnectionConfig(BridgeConnectionConfig):
    email_address: str = Field(
        ...,
        title="Email address",
        description="The mailbox address Switch monitors and sends from.",
    )
    imap_host: str = Field(
        ...,
        title="IMAP host",
        description="Hostname of the IMAP server (e.g. imap.gmail.com).",
    )
    imap_port: int = Field(
        993,
        title="IMAP port",
        description="Port for the IMAP server (typically 993 for SSL).",
    )
    imap_username: str = Field(
        ...,
        title="IMAP username",
        description="Username for IMAP authentication.",
    )
    imap_password: str = Field(
        ...,
        title="IMAP password",
        description="Password or App Password for IMAP authentication.",
    )
    imap_use_ssl: bool = Field(
        True,
        title="Use SSL for IMAP",
        description="Connect to IMAP using direct SSL/TLS encryption.",
    )
    imap_folder: str = Field(
        "INBOX",
        title="IMAP folder",
        description="Folder to monitor for incoming emails.",
    )
    smtp_host: str = Field(
        ...,
        title="SMTP host",
        description="Hostname of the SMTP server (e.g. smtp.gmail.com).",
    )
    smtp_port: int = Field(
        587,
        title="SMTP port",
        description="Port for the SMTP server (typically 587 for STARTTLS or 465 for SSL).",
    )
    smtp_username: str = Field(
        ...,
        title="SMTP username",
        description="Username for SMTP authentication.",
    )
    smtp_password: str = Field(
        ...,
        title="SMTP password",
        description="Password or App Password for SMTP authentication.",
    )
    smtp_use_ssl: bool = Field(
        False,
        title="Use SSL for SMTP",
        description="Connect to SMTP over direct SSL/TLS (typically port 465).",
    )
    smtp_use_starttls: bool = Field(
        True,
        title="Use STARTTLS for SMTP",
        description="Upgrade SMTP connection to TLS using STARTTLS (typically port 587).",
    )
    allowed_senders: list[str] = Field(
        default_factory=list,
        title="Allowed senders",
        description="List of email addresses or glob patterns allowed to trigger rooms (empty allows all).",
    )
    poll_interval_seconds: float = Field(
        15.0,
        title="Polling interval (seconds)",
        description="Interval between checking the inbox when not using IDLE.",
        ge=2.0,
    )
    max_attachment_size_bytes: int = Field(
        10 * 1024 * 1024,
        title="Max attachment size",
        description="Maximum attachment size accepted (in bytes, default 10MB).",
    )

    @model_validator(mode="after")
    def _validate_smtp_ssl(self) -> EmailConnectionConfig:
        if self.smtp_use_ssl and self.smtp_use_starttls:
            raise ValueError(
                "Cannot enable both direct SSL and STARTTLS for SMTP; pick one."
            )
        return self


class EmailAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Email"
    docs_slug: ClassVar[str | None] = "email"
    channel_on_delete: ClassVar[ChannelRetirement] = "kept"

    # Multi-pod ownership: Only the lease-holding pod connects to IMAP / polls
    keeps_quiet_unless_listening: ClassVar[bool] = True

    # Declared capability flags
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = True
    draws_session_activity: ClassVar[bool] = False
    separate_attention_slot: ClassVar[bool] = False
    notifies_only_by_mention: ClassVar[bool] = False
    every_message_notifies_members: ClassVar[bool] = True

    def __init__(self, *, config: EmailConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._listening = False
        self._running = False
        self._poll_task: asyncio.Task[None] | None = None
        self._seen_message_ids: set[str] = set()

        self._on_message: Any = None
        self._on_command: Any = None
        self._on_agent_joined: Any = None
        self._on_user_joined: Any = None
        self._on_app_joined: Any = None

        # Derive host domain for generated Message-IDs
        parts = self.config.email_address.split("@")
        self._domain = parts[1].strip() if len(parts) > 1 else "switch.local"

    # ── Credential Verification ────────────────────────────────────────────────

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(
            exc,
            imaplib.IMAP4.error
            | smtplib.SMTPAuthenticationError
            | smtplib.SMTPConnectError,
        ):
            return "auth_failed"
        if isinstance(exc, smtplib.SMTPException | ssl.SSLError):
            return "platform_error"
        if isinstance(exc, TimeoutError | ConnectionError | OSError):
            return "network"
        return None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Verify IMAP and SMTP login credentials eagerly upon saving."""
        config = EmailConnectionConfig.model_validate(connection_config)

        # Test IMAP
        def _test_imap() -> None:
            imap_client: imaplib.IMAP4
            try:
                if config.imap_use_ssl:
                    imap_client = imaplib.IMAP4_SSL(
                        config.imap_host, config.imap_port, timeout=15
                    )
                else:
                    imap_client = imaplib.IMAP4(
                        config.imap_host, config.imap_port, timeout=15
                    )
                imap_client.login(config.imap_username, config.imap_password)
                imap_client.logout()
            except imaplib.IMAP4.error as exc:
                raise BridgeCredentialError(
                    f"IMAP authentication failed: {exc}"
                ) from exc
            except Exception as exc:
                raise BridgeCredentialError(f"IMAP connection failed: {exc}") from exc

        # Test SMTP
        def _test_smtp() -> None:
            smtp_client: smtplib.SMTP
            try:
                if config.smtp_use_ssl:
                    smtp_client = smtplib.SMTP_SSL(
                        config.smtp_host, config.smtp_port, timeout=15
                    )
                else:
                    smtp_client = smtplib.SMTP(
                        config.smtp_host, config.smtp_port, timeout=15
                    )
                smtp_client.ehlo()
                if config.smtp_use_starttls:
                    smtp_client.starttls()
                    smtp_client.ehlo()
                smtp_client.login(config.smtp_username, config.smtp_password)
                smtp_client.quit()
            except smtplib.SMTPAuthenticationError as exc:
                raise BridgeCredentialError(
                    f"SMTP authentication failed: {exc}"
                ) from exc
            except Exception as exc:
                raise BridgeCredentialError(f"SMTP connection failed: {exc}") from exc

        def _test() -> None:
            _test_imap()
            _test_smtp()

        await asyncio.to_thread(_test)

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        """Ensure only one bridge instance binds to a specific mailbox address."""
        cfg = EmailConnectionConfig.model_validate(connection_config)
        return f"email:{cfg.email_address.lower().strip()}"

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(
        self,
        on_message: Any,
        on_command: Any,
        on_agent_joined: Any,
        on_user_joined: Any,
        on_app_joined: Any,
    ) -> None:
        self._on_message = on_message
        self._on_command = on_command
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined
        self._running = True

        if self._listening:
            self._start_poller()

    async def stop(self) -> None:
        self._running = False
        self._stop_poller()

    def set_listening(self, listening: bool) -> None:
        """Called by lifecycle manager when this pod acquires or loses the bridge lease."""
        self._listening = listening
        if self._running:
            if listening:
                self._start_poller()
            else:
                self._stop_poller()

    def _start_poller(self) -> None:
        if self._poll_task is None or self._poll_task.done():
            self._poll_task = asyncio.create_task(self._poll_loop())

    def _stop_poller(self) -> None:
        if self._poll_task is not None:
            self._poll_task.cancel()
            self._poll_task = None

    async def _poll_loop(self) -> None:
        """Periodically check inbox using threadpool execution to keep event loop free."""
        logger.info(
            "Starting email listener loop for %s on %s:%s",
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

    # ── Inbound Parsing & Ingestion ───────────────────────────────────────────

    def _create_imap_client(self) -> imaplib.IMAP4:
        client: imaplib.IMAP4
        if self.config.imap_use_ssl:
            client = imaplib.IMAP4_SSL(
                self.config.imap_host, self.config.imap_port, timeout=30
            )
        else:
            client = imaplib.IMAP4(
                self.config.imap_host, self.config.imap_port, timeout=30
            )
        client.login(self.config.imap_username, self.config.imap_password)
        return client

    def _create_smtp_client(self) -> smtplib.SMTP:
        smtp: smtplib.SMTP
        if self.config.smtp_use_ssl:
            smtp = smtplib.SMTP_SSL(
                self.config.smtp_host, self.config.smtp_port, timeout=30
            )
        else:
            smtp = smtplib.SMTP(
                self.config.smtp_host, self.config.smtp_port, timeout=30
            )
        smtp.ehlo()
        if self.config.smtp_use_starttls:
            smtp.starttls()
            smtp.ehlo()
        smtp.login(self.config.smtp_username, self.config.smtp_password)
        return smtp

    def _poll_inbox(self) -> None:
        """Poll folder for unseen messages, parse, dispatch, and mark seen."""
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
        """Parse incoming RFC 5322 EmailMessage and dispatch to Switch room."""
        # Loop and bounce prevention
        if is_auto_submitted_or_bounce(msg):
            logger.debug("Skipping automated / bounce email to prevent loop")
            return

        msg_id_header = msg.get("Message-ID")
        msg_id = clean_message_id(msg_id_header)
        if not msg_id:
            msg_id = f"email-{hashlib.sha256(msg.as_bytes()).hexdigest()[:16]}"

        if msg_id in self._seen_message_ids:
            return

        self._record_seen_id(msg_id)

        # Parse sender
        from_hdr = decode_mime_header(msg.get("From"))
        sender_name, sender_email = parseaddr(from_hdr)
        sender_email = sender_email.lower().strip()
        sender_name = sender_name.strip() or sender_email

        # Ignore self-sent emails
        if sender_email == self.config.email_address.lower().strip():
            logger.debug("Skipping message from own mailbox address %s", sender_email)
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
            clean_message_id(tok)
            for tok in references_header.split()
            if clean_message_id(tok)
        ]

        # Determine thread root id
        root_id: str | None = None
        if ref_tokens:
            root_id = ref_tokens[0]
        elif in_reply_to:
            root_id = in_reply_to

        # One connection is one mailbox and one room
        channel_id = self.config.email_address.lower().strip()
        channel_type: ChannelType = "channel_public"

        # Extract text & attachments
        body, attachments, attachment_failures = self._extract_parts(msg)

        loop = asyncio.get_event_loop()

        # Command detection
        stripped_body = body.strip()
        if stripped_body and stripped_body[0] in _COMMAND_PREFIXES:
            parts = stripped_body.split(None, 1)
            cmd_name = parts[0][1:]
            cmd_args = parts[1] if len(parts) > 1 else ""

            if self._on_command:
                inbound_cmd = InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=sender_email,
                    sender_name=sender_name,
                    command=cmd_name,
                    args=cmd_args,
                    message_ref=msg_id,
                    root_id=root_id,
                    channel_name=subject or channel_id,
                )
                cmd_handler = self._on_command

                async def _dispatch_cmd() -> None:
                    await cmd_handler(inbound_cmd)

                asyncio.run_coroutine_threadsafe(_dispatch_cmd(), loop)
                return

        # Regular inbound message
        if self._on_message:
            inbound_msg = InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=sender_email,
                sender_name=sender_name,
                content=body,
                message_ref=msg_id,
                root_id=root_id,
                channel_name=subject or channel_id,
                attachments=attachments,
                attachment_failures=attachment_failures,
            )
            msg_handler = self._on_message

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
                if isinstance(payload, bytes):
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
            self._seen_message_ids.clear()
        self._seen_message_ids.add(msg_id)

    # ── Outbound Dispatch ─────────────────────────────────────────────────────

    def _resolve_recipient(
        self, channel_id: str, thread_root_id: str | None
    ) -> str | None:
        """Resolve recipient email address statelessly from channel_id or thread context."""
        if "@" in channel_id:
            return channel_id
        if thread_root_id and "@" in thread_root_id:
            # If thread_root_id has user context embedded
            return thread_root_id
        return None

    def _resolve_subject(
        self, channel_id: str, thread_root_id: str | None, sender_name: str
    ) -> str:
        """Format an RFC 5322 subject line preserving thread context."""
        if thread_root_id:
            return f"Re: Conversation on Switch ({thread_root_id})"
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
        msg["From"] = formataddr((sender_name, self.config.email_address))
        msg["To"] = recipient
        msg["Subject"] = subject
        msg["Message-ID"] = f"<{new_id}>"

        # Loop protection
        msg["Auto-Submitted"] = "auto-replied"

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
        return new_id

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
        recipient = self._resolve_recipient(channel_id, thread_root_id)
        if not recipient:
            return None

        subject = self._resolve_subject(channel_id, thread_root_id, sender_name)
        new_id = f"switch-{uuid.uuid4().hex}@{self._domain}"

        msg = EmailMessage()
        msg["From"] = formataddr((sender_name, self.config.email_address))
        msg["To"] = recipient
        msg["Subject"] = subject
        msg["Message-ID"] = f"<{new_id}>"
        msg["Auto-Submitted"] = "auto-replied"

        if thread_root_id:
            msg["In-Reply-To"] = f"<{thread_root_id}>"
            msg["References"] = f"<{thread_root_id}>"

        msg.set_content(caption or "")

        maintype, _, subtype = mimetype.partition("/")
        msg.add_attachment(
            data,
            maintype=maintype or "application",
            subtype=subtype or "octet-stream",
            filename=filename,
        )

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
        return new_id

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        """Email messages cannot be edited after transmission."""
        return None

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        """Sent emails cannot be deleted from recipient mailboxes."""
        return None

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        """Email protocol has no typing presence indicator."""
        return None

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise BridgeOperationError(
            "Email mailboxes cannot provision new rooms dynamically."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_public"

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

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        return RetireOutcome(outcome="kept")

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message
