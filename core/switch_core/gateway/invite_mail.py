"""Sending an invitation to the address it is for.

Plain SMTP through the standard library, run off the event loop: any relay
an operator already has (SES SMTP, Postmark, a company relay) works, and
there is no provider SDK to depend on.
"""

from __future__ import annotations

import asyncio
import html
import smtplib
import ssl
from dataclasses import dataclass
from datetime import datetime
from email.message import EmailMessage
from email.utils import make_msgid
from typing import Protocol

from switch_core.config import SwitchConfig

_SMTP_TIMEOUT_SECONDS = 15


class InviteEmailFailed(Exception):
    """The relay could not be reached or refused the message."""


@dataclass(frozen=True)
class InviteEmail:
    to: str
    link: str
    workspace_name: str
    inviter_name: str
    role: str
    expires_at: datetime


class InviteMailer(Protocol):
    async def send_invitation(self, invite: InviteEmail) -> None: ...


def invite_link(frontend_base_url: str, token: str) -> str:
    # In the fragment, which a browser never sends: the token is a bearer
    # credential and stays out of every server and proxy log on the way.
    # Mirrors `inviteUrl` in gateway/src/data/sessionState.ts.
    return f"{frontend_base_url.rstrip('/')}/invite#token={token}"


def _one_line(value: str) -> str:
    # A header may not carry a line break, and names are user-supplied.
    return " ".join(value.split())


def build_invite_message(invite: InviteEmail, sender: str) -> EmailMessage:
    expires = invite.expires_at.strftime("%Y-%m-%d %H:%M UTC")
    message = EmailMessage()
    message["Subject"] = (
        f"{_one_line(invite.inviter_name)} invited you to "
        f"{_one_line(invite.workspace_name)} on Switch"
    )
    message["From"] = sender
    message["To"] = invite.to
    message["Message-ID"] = make_msgid(domain=sender.rpartition("@")[2] or None)
    message.set_content(
        f"{invite.inviter_name} invited you to join the {invite.workspace_name} "
        f"workspace on Switch as {invite.role}.\n"
        "\n"
        f"Accept the invitation:\n{invite.link}\n"
        "\n"
        f"Sign in with {invite.to} — the invitation is for that address and "
        "cannot be accepted from another account.\n"
        f"It expires {expires}.\n"
        "\n"
        "If you weren't expecting this, you can ignore it.\n"
    )
    e = html.escape
    message.add_alternative(
        "<!doctype html><html><body>"
        f"<p>{e(invite.inviter_name)} invited you to join the "
        f"<strong>{e(invite.workspace_name)}</strong> workspace on Switch as "
        f"{e(invite.role)}.</p>"
        f'<p><a href="{e(invite.link)}">Accept the invitation</a></p>'
        f"<p>Sign in with {e(invite.to)} — the invitation is for that address "
        "and cannot be accepted from another account. "
        f"It expires {e(expires)}.</p>"
        "<p>If you weren't expecting this, you can ignore it.</p>"
        "</body></html>",
        subtype="html",
    )
    return message


class SmtpInviteMailer:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        tls: str,
        username: str | None,
        password: str | None,
        sender: str,
    ) -> None:
        self._host = host
        self._port = port
        self._tls = tls
        self._username = username
        self._password = password
        self._sender = sender

    @classmethod
    def from_config(cls, config: SwitchConfig) -> SmtpInviteMailer:
        if not config.gateway_smtp_host or not config.gateway_smtp_from:
            raise ValueError("SMTP is not configured")
        return cls(
            host=config.gateway_smtp_host,
            port=config.gateway_smtp_port,
            tls=config.gateway_smtp_tls,
            username=config.gateway_smtp_username,
            password=config.gateway_smtp_password,
            sender=config.gateway_smtp_from,
        )

    async def send_invitation(self, invite: InviteEmail) -> None:
        message = build_invite_message(invite, self._sender)
        try:
            await asyncio.to_thread(self._send, message)
        except (smtplib.SMTPException, OSError) as err:
            raise InviteEmailFailed(
                f"sending via {self._host}:{self._port} failed: {err}"
            ) from err

    def _send(self, message: EmailMessage) -> None:
        context = ssl.create_default_context()
        smtp: smtplib.SMTP
        if self._tls == "tls":
            smtp = smtplib.SMTP_SSL(
                self._host,
                self._port,
                timeout=_SMTP_TIMEOUT_SECONDS,
                context=context,
            )
        else:
            smtp = smtplib.SMTP(self._host, self._port, timeout=_SMTP_TIMEOUT_SECONDS)
        with smtp:
            if self._tls == "starttls":
                smtp.starttls(context=context)
            if self._username and self._password:
                smtp.login(self._username, self._password)
            smtp.send_message(message)
