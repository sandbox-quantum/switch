"""Email as a messaging platform: one mailbox, one room, over IMAP and SMTP.

People write to the mailbox; each new message starts a thread in the room and
each reply lands in its thread. Agents answer by email from the same address,
under their own names, threaded with `In-Reply-To` and `References`.

Inbound runs only on the process that holds the bridge
(`keeps_quiet_unless_listening`): it waits on IMAP IDLE, or polls where the
server offers no IDLE, and marks each message it has handed to the room with
an IMAP keyword. That mark lives on the mail server, so a restart, or the
bridge moving to another process, picks up exactly where the last one stopped,
and a message seen twice has the same `Message-ID` and writes nothing twice.
Sending works from every process: SMTP, plus an IMAP lookup of who is in the
thread.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import smtplib
import ssl
import threading
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from email.message import EmailMessage
from email.parser import BytesParser
from email.policy import default as default_policy
from email.utils import getaddresses
from typing import Any, ClassVar, Literal

from imapclient import IMAPClient
from imapclient.exceptions import IMAPClientError, LoginError
from pydantic import Field, field_validator
from pydantic.json_schema import SkipJsonSchema

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
    TurnActivity,
)
from switch_core.bridges.collaboration.email.mime import (
    MailboxConfigError,
    authentication_verdict,
    build_message,
    clean_subject,
    new_message_id,
    normalise_address,
    parse_allowed_senders,
    read_message,
    reply_subject,
    sender_allowed,
    stable_message_id,
    strip_reply,
)
from switch_core.bridges.collaboration.models import (
    AttachmentFailure,
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
from switch_core.sessions.contract import TURN_ENDED

logger = logging.getLogger(__name__)

Security = Literal["ssl", "starttls", "none"]

#: The keyword a message gets once the room has it. Kept on the mail server,
#: so every process and every restart agrees on what is done.
HANDLED_KEYWORD = b"$SwitchSeen"
_SEEN = b"\\Seen"

# RFC 2177 asks a client to leave IDLE at least every 29 minutes.
_IDLE_SECONDS = 25 * 60
# How long one wait inside IDLE lasts, which bounds how long stopping takes.
_IDLE_CHECK_SECONDS = 15
_POLL_SECONDS = 30
_RECONNECT_FIRST = 5.0
_RECONNECT_MAX = 300.0
_TIMEOUT_SECONDS = 30
_SUBJECT_LENGTH = 78


class EmailConnectionConfig(BridgeConnectionConfig):
    """The mailbox a room is connected to, and who may write to it."""

    email_address: str = Field(
        title="Email address",
        description="The mailbox people write to. Agents reply from this address.",
    )
    password: str = Field(
        title="Password",
        description=(
            "The mailbox password, or an app password where the provider asks for "
            "one (Gmail, Fastmail, iCloud)."
        ),
    )
    imap_host: str = Field(
        title="IMAP server", description="Where mail is read, e.g. imap.gmail.com."
    )
    smtp_host: str = Field(
        title="SMTP server", description="Where mail is sent, e.g. smtp.gmail.com."
    )
    allowed_senders: str = Field(
        title="Who may write in",
        description=(
            "Addresses, or @domain for a whole domain, separated by commas. Mail "
            "from anyone else is not posted. Agents' new messages go to the "
            "addresses listed here."
        ),
    )
    username: str | None = Field(
        default=None,
        title="Login name",
        description="Leave empty when it is the email address itself.",
    )
    imap_port: int = Field(default=993, ge=1, le=65535, title="IMAP port")
    imap_security: Security = Field(
        default="ssl",
        title="IMAP security",
        description="ssl (port 993), starttls (port 143), or none for a test server.",
    )
    smtp_port: int = Field(default=465, ge=1, le=65535, title="SMTP port")
    smtp_security: Security = Field(
        default="ssl",
        title="SMTP security",
        description="ssl (port 465), starttls (port 587), or none for a test server.",
    )
    folder: str = Field(
        default="INBOX", title="Folder", description="The folder new mail arrives in."
    )
    require_authenticated_senders: bool = Field(
        default=True,
        title="Only believe senders the mail server verified",
        description=(
            "Post mail only when the receiving server's Authentication-Results "
            "header says DMARC, or DKIM or SPF aligned with the From address, "
            "passed. Turn off only for a server that adds no such header."
        ),
    )
    authentication_server: str | None = Field(
        default=None,
        title="Receiving server's name",
        description=(
            "How your mail server names itself in Authentication-Results, e.g. "
            "mx.google.com. Leave empty to trust the topmost such header."
        ),
    )
    # When the bridge was connected. Mail older than this was in the mailbox
    # before anyone asked for a room, and is not posted. Set once, at
    # registration (`prepare_config`).
    connected_at: SkipJsonSchema[str | None] = None

    @field_validator("email_address")
    @classmethod
    def _address(cls, value: str) -> str:
        try:
            return normalise_address(value)
        except MailboxConfigError as error:
            raise ValueError(str(error)) from error

    @field_validator("allowed_senders")
    @classmethod
    def _allowed(cls, value: str) -> str:
        try:
            return ", ".join(parse_allowed_senders(value))
        except MailboxConfigError as error:
            raise ValueError(str(error)) from error

    @field_validator("imap_host", "smtp_host", "folder")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be empty")
        return value.strip()

    @field_validator("username", "authentication_server")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return (value.strip() or None) if value is not None else None

    @property
    def login(self) -> str:
        return self.username or self.email_address

    @property
    def allowed(self) -> tuple[str, ...]:
        return parse_allowed_senders(self.allowed_senders)

    @property
    def since(self) -> datetime | None:
        return datetime.fromisoformat(self.connected_at) if self.connected_at else None


def _ssl_context() -> ssl.SSLContext:
    return ssl.create_default_context()


def _open_imap(config: EmailConnectionConfig) -> IMAPClient:
    """Log in to the mailbox, raising `BridgeCredentialError` if refused."""
    client = IMAPClient(
        config.imap_host,
        port=config.imap_port,
        ssl=config.imap_security == "ssl",
        ssl_context=_ssl_context(),
        timeout=_TIMEOUT_SECONDS,
    )
    try:
        if config.imap_security == "starttls":
            client.starttls(_ssl_context())
        client.login(config.login, config.password)
    except LoginError as error:
        _close_quietly(client)
        raise BridgeCredentialError(
            f"The IMAP server refused the login for {config.login}: {_said(error)}"
        ) from error
    except Exception:
        _close_quietly(client)
        raise
    client.normalise_times = False
    return client


def _close_quietly(client: IMAPClient) -> None:
    try:
        client.logout()
    except Exception:
        try:
            client.shutdown()
        except Exception:
            logger.debug("Could not close an IMAP connection", exc_info=True)


def _shutdown_quietly(client: IMAPClient) -> None:
    try:
        client.shutdown()
    except Exception:
        logger.debug("Could not close an IMAP connection", exc_info=True)


def _open_smtp(config: EmailConnectionConfig) -> smtplib.SMTP:
    """Log in to the SMTP server, raising `BridgeCredentialError` if refused."""
    smtp: smtplib.SMTP
    if config.smtp_security == "ssl":
        smtp = smtplib.SMTP_SSL(
            config.smtp_host,
            config.smtp_port,
            timeout=_TIMEOUT_SECONDS,
            context=_ssl_context(),
        )
    else:
        smtp = smtplib.SMTP(
            config.smtp_host, config.smtp_port, timeout=_TIMEOUT_SECONDS
        )
        if config.smtp_security == "starttls":
            smtp.starttls(context=_ssl_context())
    try:
        smtp.login(config.login, config.password)
    except smtplib.SMTPAuthenticationError as error:
        smtp.close()
        raise BridgeCredentialError(
            f"The SMTP server refused the login for {config.login}: {_said(error)}"
        ) from error
    except smtplib.SMTPNotSupportedError:
        # A test server with no authentication at all: nothing to log in to.
        pass
    except Exception:
        smtp.close()
        raise
    return smtp


def _said(error: BaseException) -> str:
    """What a mail server answered, as text."""
    if isinstance(error, smtplib.SMTPResponseException):
        message = error.smtp_error
        text = (
            message.decode(errors="replace")
            if isinstance(message, bytes)
            else str(message)
        )
        return f"{error.smtp_code} {text}"
    text = str(error)
    # IMAPClient passes the server's bytes through `str`.
    if text[:2] in ("b'", 'b"') and text[-1] == text[1]:
        return text[2:-1]
    return text


class EmailAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Email"
    # A bridge reads one mailbox for one room: there is nothing to create.
    supports_channel_creation: ClassVar[bool] = False
    # A mailbox has no directory of people; only those who wrote in are known.
    supports_directory_search: ClassVar[bool] = False
    # Mail clients open only web links.
    renders_custom_url_schemes: ClassVar[bool] = False
    # Approval and question cards go out as emails of their own, answered by
    # replying with the card's handle. A turn's running status does not: a sent
    # email cannot be edited, so each redraw would be another message.
    draws_session_activity: ClassVar[bool] = True
    # Every message is delivered to everyone it is addressed to.
    every_message_notifies_members: ClassVar[bool] = True
    keeps_quiet_unless_listening: ClassVar[bool] = True

    def __init__(self, *, config: EmailConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._mailbox = config.email_address
        self._bridge_id = "unregistered"
        self._listener: asyncio.Task[None] | None = None
        # Read by the listener's worker thread, so a threading primitive.
        self._stopping = threading.Event()

    # ── Registration ─────────────────────────────────────────────────────────

    @classmethod
    async def prepare_config(
        cls, connection_config: dict[str, object]
    ) -> dict[str, object]:
        if connection_config.get("connected_at"):
            return connection_config
        return {**connection_config, "connected_at": datetime.now(UTC).isoformat()}

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """The mailbox, which only one bridge may read: two would each mark
        and post a share of its mail."""
        address = connection_config.get("email_address")
        return f"mailbox {str(address).strip().lower()}" if address else None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        """The two mail servers, so the outbound policy checks their hosts.

        They are not web addresses, and are written as https URLs on their own
        ports only because a URL is what the policy reads: what it checks is
        the host, its port and every address the host resolves to, which is
        exactly what has to be checked before Switch connects to a server
        someone typed in.
        """
        urls: list[str] = []
        for host, port in (
            (
                connection_config.get("imap_host"),
                connection_config.get("imap_port", 993),
            ),
            (
                connection_config.get("smtp_host"),
                connection_config.get("smtp_port", 465),
            ),
        ):
            if host:
                urls.append(f"https://{str(host).strip()}:{port}")
        return urls

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Log in to both servers and open the folder, before anything is saved."""
        config = EmailConnectionConfig.model_validate(connection_config)
        try:
            await asyncio.to_thread(cls._check_mailbox, config)
        except BridgeCredentialError:
            raise
        except (OSError, IMAPClientError, smtplib.SMTPException) as error:
            raise BridgeCredentialError(
                f"Could not connect to the mailbox {config.email_address}: {_said(error)}"
            ) from error

    @staticmethod
    def _check_mailbox(config: EmailConnectionConfig) -> None:
        client = _open_imap(config)
        try:
            client.select_folder(config.folder, readonly=True)
        except IMAPClientError as error:
            raise BridgeCredentialError(
                f"The mailbox has no folder {config.folder!r}: {_said(error)}"
            ) from error
        finally:
            _close_quietly(client)
        _open_smtp(config).quit()

    def set_bridge_id(self, bridge_id: str) -> None:
        self._bridge_id = bridge_id

    # ── Lifecycle ────────────────────────────────────────────────────────────

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
        self._on_app_joined = on_app_joined
        self._stopping.clear()
        if not self._listening:
            logger.info(
                "Email bridge for %s running quietly: another process reads the mailbox",
                self._mailbox,
            )
            return
        # The mailbox is the room's one channel. Announcing it creates the room
        # the first time and is a no-op after that.
        await on_app_joined(
            InboundAppJoin(
                channel_id=self._mailbox,
                channel_type="channel_private",
                channel_name=self._mailbox,
            )
        )
        self._listener = asyncio.create_task(
            self._listen(), name=f"email-listener-{self._mailbox}"
        )
        logger.info("Email bridge reading %s/%s", self._mailbox, self.config.folder)

    async def stop(self) -> None:
        self._stopping.set()
        listener, self._listener = self._listener, None
        if listener is not None:
            listener.cancel()
            try:
                await listener
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception(
                    "The email listener for %s failed while stopping", self._mailbox
                )
        logger.info("Email bridge for %s stopped", self._mailbox)

    async def _check_hosts(self) -> None:
        """Resolve both servers against the outbound policy before connecting,
        because what a name resolves to can change after it was registered."""
        await self.outbound_policy.resolve(self.config.imap_host, self.config.imap_port)
        await self.outbound_policy.resolve(self.config.smtp_host, self.config.smtp_port)

    # ── Inbound ──────────────────────────────────────────────────────────────

    async def _listen(self) -> None:
        """Read the mailbox until stopped, reconnecting after any failure."""
        delay = _RECONNECT_FIRST
        while not self._stopping.is_set():
            client: IMAPClient | None = None
            try:
                await self._check_hosts()
                client = await asyncio.to_thread(_open_imap, self.config)
                delay = _RECONNECT_FIRST
                await self._watch(client)
            except asyncio.CancelledError:
                raise
            except BridgeCredentialError as error:
                logger.error(
                    "Email bridge for %s cannot read mail: %s. Retrying in %.0fs",
                    self._mailbox,
                    error,
                    delay,
                )
            except Exception:
                logger.warning(
                    "Email bridge for %s lost the mailbox; reconnecting in %.0fs",
                    self._mailbox,
                    delay,
                    exc_info=True,
                )
            finally:
                if client is not None:
                    # A socket close, not a LOGOUT: on stop the worker thread
                    # may still be inside IDLE on this connection, and this
                    # must not wait on a server to answer.
                    _shutdown_quietly(client)
            if self._stopping.is_set():
                return
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RECONNECT_MAX)

    async def _watch(self, client: IMAPClient) -> None:
        selected = await asyncio.to_thread(client.select_folder, self.config.folder)
        keyword = self._handled_flag(selected)
        idles = b"IDLE" in await asyncio.to_thread(client.capabilities)
        if not idles:
            logger.info(
                "The IMAP server for %s offers no IDLE; checking every %ds",
                self._mailbox,
                _POLL_SECONDS,
            )
        while not self._stopping.is_set():
            await self._handle_waiting(client, keyword)
            if idles:
                await asyncio.to_thread(self._idle, client)
            else:
                await asyncio.sleep(_POLL_SECONDS)

    def _handled_flag(self, selected: dict[bytes, Any]) -> bytes:
        """The keyword handled mail is marked with, or `\\Seen` where the
        server keeps no keywords of a client's choosing."""
        permanent = selected.get(b"PERMANENTFLAGS") or ()
        if b"\\*" in permanent or HANDLED_KEYWORD in permanent:
            return HANDLED_KEYWORD
        logger.warning(
            "The IMAP server for %s keeps no custom keywords, so handled mail is "
            "marked read (\\Seen) instead. Mail someone reads in a mail client "
            "before Switch does is then not posted: give the room a mailbox of its own.",
            self._mailbox,
        )
        return _SEEN

    def _idle(self, client: IMAPClient) -> None:
        """Wait inside IDLE until new mail arrives, the server's window closes,
        or the bridge stops. Runs in a worker thread."""
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

    async def _handle_waiting(self, client: IMAPClient, keyword: bytes) -> None:
        criteria: list[Any] = (
            [b"UNKEYWORD", keyword] if keyword != _SEEN else [b"UNSEEN"]
        )
        since = self.config.since
        if since is not None:
            criteria += [b"SINCE", since.date()]
        uids = sorted(await asyncio.to_thread(client.search, criteria))
        for uid in uids:
            if self._stopping.is_set():
                return
            fetched = await asyncio.to_thread(
                client.fetch, [uid], [b"BODY.PEEK[]", b"INTERNALDATE"]
            )
            data = fetched.get(uid)
            if data is None:
                continue
            arrived = data.get(b"INTERNALDATE")
            if (
                since is not None
                and isinstance(arrived, datetime)
                and _aware(arrived) < since
            ):
                # SINCE matches by day; this one came in earlier that day.
                await asyncio.to_thread(client.add_flags, [uid], [keyword])
                continue
            try:
                await self._deliver(data[b"BODY[]"])
            except Exception:
                # Left unmarked, so it is tried again on the next pass.
                logger.exception(
                    "Could not hand mail %s in %s to the room; it will be retried",
                    uid,
                    self._mailbox,
                )
                continue
            await asyncio.to_thread(client.add_flags, [uid], [keyword])

    async def _deliver(self, raw: bytes) -> None:
        """Post one message to the room, or say in the log why not."""
        read = read_message(raw, self._max_attachment_bytes)
        if read.from_switch or read.sender_address == self._mailbox:
            logger.debug("Skipping mail Switch sent from %s", self._mailbox)
            return
        if read.automated is not None:
            logger.info(
                "Not posting mail from %s to %s: it is %s",
                read.sender_address,
                self._mailbox,
                read.automated,
            )
            return
        if not sender_allowed(read.sender_address, self.config.allowed):
            logger.warning(
                "Not posting mail from %s to %s: the sender is not on the "
                "connection's list of who may write in",
                read.sender_address,
                self._mailbox,
            )
            return
        if self.config.require_authenticated_senders:
            assert read.message is not None
            verdict = authentication_verdict(
                read.message, read.sender_address, self.config.authentication_server
            )
            if not verdict.passed:
                logger.warning(
                    "Not posting mail claiming to be from %s to %s: the mail server "
                    "did not verify the sender (%s)",
                    read.sender_address,
                    self._mailbox,
                    verdict.detail,
                )
                return

        message_ref = read.message_id or _derived_id(raw)
        text = read.text.strip()
        if text.startswith("!") and self._on_command is not None:
            parts = text.split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=self._mailbox,
                    channel_type="channel_private",
                    sender_id=read.sender_address,
                    sender_name=read.sender_name,
                    command=parts[0].lstrip("!"),
                    args=parts[1].strip() if len(parts) > 1 else "",
                    message_ref=message_ref,
                    root_id=read.root_id,
                    channel_name=self._mailbox,
                )
            )
            return
        if self._on_message is None:
            raise RuntimeError("The email bridge was not started")
        subject = clean_subject(read.subject)
        if read.root_id is None and subject:
            text = f"**{subject}**\n\n{text}" if text else f"**{subject}**"
        await self._on_message(
            InboundMessage(
                channel_id=self._mailbox,
                channel_type="channel_private",
                sender_id=read.sender_address,
                sender_name=read.sender_name,
                content=text,
                message_ref=message_ref,
                root_id=read.root_id,
                channel_name=self._mailbox,
                attachments=read.attachments,
                attachment_failures=read.attachment_failures,
            )
        )

    # ── Outbound ─────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        return await self._send(sender_name, content, thread_root_id, [], None)

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
        return await self.send_attachments(
            channel_id,
            sender_name,
            [OutboundAttachment(filename=filename, mimetype=mimetype, data=data)],
            caption=caption,
            thread_root_id=thread_root_id,
        )

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Every file in one email; any too large to attach is named in it."""
        attached: list[OutboundAttachment] = []
        refused: list[AttachmentFailure] = []
        budget = self._max_attachment_bytes
        for file in files:
            if len(file.data) > budget:
                refused.append(
                    AttachmentFailure(
                        filename=file.filename,
                        reason=f"{len(file.data) / (1024 * 1024):.1f} MB is over the "
                        f"{self._max_attachment_bytes / (1024 * 1024):.1f} MB limit",
                    )
                )
                continue
            budget -= len(file.data)
            attached.append(file)
        lines = [caption] if caption else []
        lines += [f"_Not attached: {f.filename} ({f.reason})_" for f in refused]
        text = self.translate_outbound("\n\n".join(lines)) if lines else ""
        return await self._send(sender_name, text, thread_root_id, attached, None)

    async def _send(
        self,
        sender_name: str,
        text: str,
        thread_root_id: str | None,
        attachments: list[OutboundAttachment],
        message_id: str | None,
    ) -> str:
        recipients, subject = await self._audience(thread_root_id, text, sender_name)
        message_id = message_id or new_message_id(self._mailbox)
        message = build_message(
            mailbox=self._mailbox,
            sender_name=sender_name,
            recipients=recipients,
            subject=subject,
            text=text,
            message_id=message_id,
            root_id=thread_root_id,
            bridge_id=self._bridge_id,
            attachments=attachments,
            date=None,
        )
        await self._check_hosts()
        await asyncio.to_thread(self._deliver_smtp, message)
        return message_id

    def _deliver_smtp(self, message: EmailMessage) -> None:
        smtp = _open_smtp(self.config)
        try:
            limit = int(smtp.esmtp_features.get("size", "0") or 0)
            size = len(message.as_bytes())
            if limit and size > limit:
                raise BridgeOperationError(
                    f"The message is {size / (1024 * 1024):.1f} MB and the mail "
                    f"server takes at most {limit / (1024 * 1024):.1f} MB"
                )
            smtp.send_message(message)
        except smtplib.SMTPRecipientsRefused as error:
            raise BridgeOperationError(
                "The mail server refused every recipient: "
                + "; ".join(
                    f"{who}: {_said_pair(answer)}"
                    for who, answer in error.recipients.items()
                )
            ) from error
        except smtplib.SMTPResponseException as error:
            raise BridgeOperationError(
                f"The mail server refused the message: {_said(error)}"
            ) from error
        finally:
            try:
                smtp.quit()
            except smtplib.SMTPException:
                smtp.close()

    async def _audience(
        self, thread_root_id: str | None, text: str, sender_name: str
    ) -> tuple[list[str], str]:
        """Who a message goes to, and under what subject.

        A reply goes to the people in its thread, read back from the mailbox,
        so the answer reaches whoever wrote in and whoever they copied. Only
        those on the allow list: an agent's reply never reaches an address
        that could not have written in. A new message, or a thread nobody has
        answered yet, goes to the addresses on the allow list.
        """
        allowed = self.config.allowed
        participants: list[str] = []
        subject = ""
        if thread_root_id is not None:
            participants, subject = await self._thread_people(thread_root_id)
        recipients = [
            a for a in participants if a != self._mailbox and sender_allowed(a, allowed)
        ]
        if not recipients:
            recipients = [entry for entry in allowed if not entry.startswith("@")]
        if not recipients:
            raise BridgeOperationError(
                f"Nobody to send this to from {self._mailbox}: no one in the thread "
                "is on the list of who may write in, and the list names no single "
                "address to write to"
            )
        if thread_root_id is not None and subject:
            return recipients, reply_subject(subject)
        return recipients, _subject_from(text, sender_name)

    async def _thread_people(self, root_id: str) -> tuple[list[str], str]:
        await self._check_hosts()
        return await asyncio.to_thread(self._read_thread, root_id)

    def _read_thread(self, root_id: str) -> tuple[list[str], str]:
        """Everyone on the thread's mail in the mailbox, and its subject.
        Runs in a worker thread, on a connection of its own."""
        client = _open_imap(self.config)
        try:
            client.select_folder(self.config.folder, readonly=True)
            uids = client.search(
                [
                    b"OR",
                    b"HEADER",
                    b"Message-ID",
                    root_id,
                    b"HEADER",
                    b"References",
                    root_id,
                ]
            )
            if not uids:
                return [], ""
            fetched = client.fetch(sorted(uids), [b"BODY.PEEK[HEADER]"])
        finally:
            _close_quietly(client)
        people: list[str] = []
        subject = ""
        for uid in sorted(fetched):
            header = BytesParser(policy=default_policy).parsebytes(
                fetched[uid][b"BODY[HEADER]"], headersonly=True
            )
            if not subject:
                subject = str(header.get("Subject", ""))
            fields = [
                str(v)
                for name in ("Reply-To", "From", "To", "Cc")
                for v in header.get_all(name) or []
            ]
            for _, address in getaddresses(fields):
                address = address.lower()
                if address and address not in people:
                    people.append(address)
        return people, subject

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """A request card as an email of its own; a turn only when it failed.

        A card's Message-ID is the same for every attempt to post it, so a
        retried post is the same message rather than a second card. A turn's
        status is recorded without being sent: a sent email cannot be redrawn,
        and mailing every step of a turn would bury the answer it leads to.
        """
        if isinstance(content, RequestCard):
            message_id = stable_message_id(
                self._mailbox, f"request-{content.request.request_id}"
            )
            text = self.rich_fallback_text(content)
            return await self._send_rich(agent_name, text, thread_root_id, message_id)
        if content.error_summary and content.turn.status in TURN_ENDED:
            return await self._send_turn_failure(agent_name, content, thread_root_id)
        return stable_message_id(self._mailbox, f"turn-{content.turn.turn_id}")

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Nothing is redrawn by email, with one exception: a turn that ends in
        failure is said once, because otherwise nobody reading the mail would
        know the agent stopped."""
        if (
            isinstance(content, TurnActivity)
            and content.error_summary
            and content.turn.status in TURN_ENDED
        ):
            await self._send_turn_failure(agent_name, content, thread_root_id)

    async def _send_turn_failure(
        self, agent_name: str, content: TurnActivity, thread_root_id: str | None
    ) -> str:
        message_id = stable_message_id(
            self._mailbox, f"turn-{content.turn.turn_id}-failed"
        )
        text = self.translate_outbound(content.error_summary or "")
        return await self._send_rich(agent_name, text, thread_root_id, message_id)

    async def _send_rich(
        self, agent_name: str, text: str, thread_root_id: str | None, message_id: str
    ) -> str:
        try:
            return await self._send(agent_name, text, thread_root_id, [], message_id)
        except Exception as error:
            raise RichContentFailed(
                f"Email could not send the message from {self._mailbox}: {error}",
                text=text,
            ) from error

    def rich_fallback_limit(self) -> int:
        # Mail has no length limit worth the name; this keeps a card readable.
        return 20000

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        raise BridgeOperationError("Email cannot change a message that has been sent")

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        raise BridgeOperationError(
            "Email cannot take back a message that has been sent"
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # Email has no typing indicator.
        return None

    # ── Channels and identities ──────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "An email connection is one mailbox and one room, which is created "
            "when the mailbox is connected. Connect another mailbox for another room."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_private"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Agents write from the mailbox under their own names; nothing to join.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        """A mailbox has no members: whoever is on the connection's allow list
        can write in already, and nobody else can be let in from here."""
        allowed = self.config.allowed
        return [
            person
            for person in user_external_ids
            if not sender_allowed(person, allowed)
        ]

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        # An agent's name is the display name on the mail it sends.
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    # ── Markup ───────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        # The text part is the Markdown as written, which reads as plain text;
        # the HTML part is rendered from it when the message is built.
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return strip_reply(raw_message)


def _announces_mail(response: Any) -> bool:
    """Whether an untagged IDLE response says something arrived."""
    return (
        isinstance(response, tuple)
        and len(response) >= 2
        and response[1] in (b"EXISTS", b"RECENT")
    )


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)


def _derived_id(raw: bytes) -> str:
    """A stable id for mail that arrived without a Message-ID, so a second
    delivery of the same bytes is recognised."""
    return f"<{hashlib.sha256(raw).hexdigest()[:40]}@no-message-id.switch>"


def _said_pair(answer: tuple[int, bytes]) -> str:
    code, text = answer
    return f"{code} {text.decode(errors='replace')}"


def _subject_from(text: str, sender_name: str) -> str:
    """A subject for a new message: its first line, or who it is from."""
    for line in text.splitlines():
        line = line.strip().strip("#*_`> ").strip()
        if line:
            return (
                line
                if len(line) <= _SUBJECT_LENGTH
                else line[: _SUBJECT_LENGTH - 3] + "..."
            )
    return f"Message from {sender_name}"
