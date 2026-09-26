from __future__ import annotations

import smtplib
from datetime import UTC, datetime
from email.message import EmailMessage
from typing import Any

import pytest

from switch_core.gateway import invite_mail
from switch_core.gateway.invite_mail import (
    InviteEmail,
    InviteEmailFailed,
    SmtpInviteMailer,
    build_invite_message,
    invite_link,
)

_INVITE = InviteEmail(
    to="new.person@example.com",
    link="https://switch.example.com/invite#token=abc",
    workspace_name="<b>Acme & co</b>",
    inviter_name="Ada",
    role="member",
    expires_at=datetime(2030, 1, 2, 3, 4, tzinfo=UTC),
)


def _parts(message: EmailMessage) -> tuple[str, str]:
    plain = message.get_body(preferencelist=("plain",))
    rich = message.get_body(preferencelist=("html",))
    assert plain is not None and rich is not None
    return plain.get_content(), rich.get_content()


def test_the_link_carries_the_token_in_the_fragment() -> None:
    assert (
        invite_link("https://switch.example.com/", "tok")
        == "https://switch.example.com/invite#token=tok"
    )


def test_the_message_names_the_workspace_the_inviter_and_the_link() -> None:
    message = build_invite_message(_INVITE, "invites@example.com")

    assert message["To"] == "new.person@example.com"
    assert message["From"] == "invites@example.com"
    assert message["Subject"] == "Ada invited you to <b>Acme & co</b> on Switch"
    plain, rich = _parts(message)
    assert _INVITE.link in plain
    assert "new.person@example.com" in plain
    assert "2030-01-02 03:04 UTC" in plain
    assert f'href="{_INVITE.link}"' in rich


def test_names_are_escaped_in_the_html_part() -> None:
    _plain, rich = _parts(build_invite_message(_INVITE, "invites@example.com"))

    assert "<b>Acme" not in rich
    assert "&lt;b&gt;Acme &amp; co&lt;/b&gt;" in rich


def test_a_line_break_in_a_name_cannot_reach_the_headers() -> None:
    invite = InviteEmail(**{**_INVITE.__dict__, "workspace_name": "Acme\r\nBcc: x@y"})

    message = build_invite_message(invite, "invites@example.com")

    assert message["Bcc"] is None
    assert message["Subject"] == "Ada invited you to Acme Bcc: x@y on Switch"


class _RecordingSmtp:
    instances: list[_RecordingSmtp] = []

    def __init__(self, host: str, port: int, **kwargs: Any) -> None:
        self.host, self.port, self.kwargs = host, port, kwargs
        self.calls: list[str] = []
        self.sent: list[EmailMessage] = []
        _RecordingSmtp.instances.append(self)

    def __enter__(self) -> _RecordingSmtp:
        return self

    def __exit__(self, *exc: object) -> None:
        self.calls.append("quit")

    def starttls(self, **kwargs: Any) -> None:
        self.calls.append("starttls")

    def login(self, username: str, password: str) -> None:
        self.calls.append(f"login:{username}")

    def send_message(self, message: EmailMessage) -> None:
        self.calls.append("send")
        self.sent.append(message)


class _RecordingSmtpSsl(_RecordingSmtp):
    pass


@pytest.fixture
def smtp(monkeypatch: pytest.MonkeyPatch) -> type[_RecordingSmtp]:
    _RecordingSmtp.instances = []
    monkeypatch.setattr(invite_mail.smtplib, "SMTP", _RecordingSmtp)
    monkeypatch.setattr(invite_mail.smtplib, "SMTP_SSL", _RecordingSmtpSsl)
    return _RecordingSmtp


def _mailer(tls: str, *, username: str | None = None) -> SmtpInviteMailer:
    return SmtpInviteMailer(
        host="smtp.example.com",
        port=587,
        tls=tls,
        username=username,
        password="placeholder" if username else None,
        sender="invites@example.com",
    )


async def test_starttls_upgrades_then_logs_in_then_sends(
    smtp: type[_RecordingSmtp],
) -> None:
    await _mailer("starttls", username="relay-user").send_invitation(_INVITE)

    [conn] = smtp.instances
    assert type(conn) is _RecordingSmtp
    assert conn.calls == ["starttls", "login:relay-user", "send", "quit"]
    assert conn.sent[0]["To"] == "new.person@example.com"


async def test_implicit_tls_connects_over_tls_and_skips_login_without_credentials(
    smtp: type[_RecordingSmtp],
) -> None:
    await _mailer("tls").send_invitation(_INVITE)

    [conn] = smtp.instances
    assert type(conn) is _RecordingSmtpSsl
    assert conn.calls == ["send", "quit"]


async def test_no_tls_is_plain(smtp: type[_RecordingSmtp]) -> None:
    await _mailer("none").send_invitation(_INVITE)

    [conn] = smtp.instances
    assert conn.calls == ["send", "quit"]


async def test_a_relay_refusal_is_reported_as_a_failed_send(
    monkeypatch: pytest.MonkeyPatch, smtp: type[_RecordingSmtp]
) -> None:
    def refuse(self: _RecordingSmtp, message: EmailMessage) -> None:
        raise smtplib.SMTPRecipientsRefused({message["To"]: (550, b"no")})

    monkeypatch.setattr(_RecordingSmtp, "send_message", refuse)

    with pytest.raises(InviteEmailFailed, match="smtp.example.com:587"):
        await _mailer("none").send_invitation(_INVITE)


async def test_an_unreachable_relay_is_reported_as_a_failed_send(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unreachable(*args: object, **kwargs: object) -> None:
        raise ConnectionRefusedError("connection refused")

    monkeypatch.setattr(invite_mail.smtplib, "SMTP", unreachable)

    with pytest.raises(InviteEmailFailed):
        await _mailer("starttls").send_invitation(_INVITE)
