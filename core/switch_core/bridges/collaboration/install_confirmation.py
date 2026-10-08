"""The ticket that carries a redeemed grant from the callback to the decision.

An install is not claimed when the platform redirects back. The person who
approved it on the platform may not be the person who started it — a link to a
platform's consent screen can be sent to anyone — so the callback shows them
which Switch organisation the workspace would join, and only an explicit
Connect on that page claims it.

Between the two requests the grant has to live somewhere. It travels in the
page itself, as this ticket, rather than in the database: an approver who
closes the tab leaves nothing behind here, and no bot token is stored for an
install nobody agreed to.

The ticket is encrypted, not just signed, because it carries the bot token. It
is also the proof that whoever submits the decision saw the page: the state
token alone is not, since whoever started the install holds it. The key is
the keyring's key for this purpose (`keys.Purpose`), so a ticket is never
mistakable for any other ciphertext made from the same master key, and one
sealed just before a rotation still opens afterwards while the old key is kept.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import timedelta

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from switch_core.bridges.collaboration.install import InstallGrant
from switch_core.bridges.collaboration.install_state import RETURN_TO_VALUES, ReturnTo
from switch_core.keys import Keyring, Purpose

#: How long the approver has to choose on the confirmation page.
CONFIRM_TTL = timedelta(minutes=15)


class InstallTicketError(RuntimeError):
    """A ticket was malformed, not ours, or older than `CONFIRM_TTL`."""


@dataclass(frozen=True)
class InstallTicket:
    tenant_id: str
    state_id: str
    platform: str
    return_to: ReturnTo
    grant: InstallGrant


def _fernet(key: bytes) -> Fernet:
    return Fernet(base64.urlsafe_b64encode(key))


def seal(ticket: InstallTicket, *, keyring: Keyring) -> str:
    payload = json.dumps(
        {
            "tid": ticket.tenant_id,
            "sid": ticket.state_id,
            "plat": ticket.platform,
            "rt": ticket.return_to,
            "ws": ticket.grant.external_workspace_id,
            "name": ticket.grant.workspace_name,
            "tok": ticket.grant.bot_token,
            "scopes": ticket.grant.scopes,
        },
        separators=(",", ":"),
    )
    return (
        _fernet(keyring.derive(Purpose.INSTALL_CONFIRM))
        .encrypt(payload.encode())
        .decode()
    )


def open_ticket(token: str, *, keyring: Keyring) -> InstallTicket:
    opener = MultiFernet(
        [_fernet(key) for key in keyring.verification_keys(Purpose.INSTALL_CONFIRM)]
    )
    try:
        raw = opener.decrypt(token.encode(), ttl=int(CONFIRM_TTL.total_seconds()))
    except InvalidToken:
        raise InstallTicketError(
            "install confirmation is not one this deployment issued, or has expired"
        ) from None
    decoded = json.loads(raw)
    # A ticket sealed before `rt` existed came from the dashboard.
    return_to = decoded.get("rt", "dashboard")
    if return_to not in RETURN_TO_VALUES:
        raise InstallTicketError("install confirmation is malformed")
    return InstallTicket(
        tenant_id=decoded["tid"],
        state_id=decoded["sid"],
        platform=decoded["plat"],
        return_to=return_to,
        grant=InstallGrant(
            external_workspace_id=decoded["ws"],
            workspace_name=decoded["name"],
            bot_token=decoded["tok"],
            scopes=decoded["scopes"],
        ),
    )
