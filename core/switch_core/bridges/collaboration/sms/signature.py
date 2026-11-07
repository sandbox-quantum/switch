"""Twilio's request signature, the proof that a webhook came from Twilio.

Twilio signs the address it called followed by the form fields, so proving a
request means parsing its body. The address is the one this connection gave
Twilio, never one read from the request: a proxy or a caller can change what a
request says about where it was sent.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from collections.abc import Sequence
from urllib.parse import parse_qsl, urlsplit

from switch_core.bridges.collaboration.install import WebhookAuthenticityError

SIGNATURE_HEADER = "x-twilio-signature"

# Well above the fields Twilio sends for a message with its ten media items.
_MAX_FORM_FIELDS = 200


def parse_form(body: bytes) -> list[tuple[str, str]]:
    """A webhook's form fields. Raises ValueError for a body that isn't a form."""
    return parse_qsl(
        body.decode("utf-8"),
        keep_blank_values=True,
        errors="strict",
        max_num_fields=_MAX_FORM_FIELDS,
    )


def compute_signature(
    auth_token: str, url: str, fields: Sequence[tuple[str, str]]
) -> str:
    """What Twilio puts in `SIGNATURE_HEADER` for these fields at this address.

    Fields are sorted by name, and a name that repeats contributes each of its
    distinct values in sorted order, as Twilio's own validator does.
    """
    values_by_name: dict[str, set[str]] = {}
    for name, value in fields:
        values_by_name.setdefault(name, set()).add(value)
    signed = url + "".join(
        name + value
        for name in sorted(values_by_name)
        for value in sorted(values_by_name[name])
    )
    digest = hmac.new(auth_token.encode(), signed.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def verify_signature(auth_token: str, url: str, body: bytes, given: str) -> None:
    """Raise `WebhookAuthenticityError` unless `given` signs `body` at `url`."""
    if not given:
        raise WebhookAuthenticityError("The request carries no Twilio signature")
    try:
        fields = parse_form(body)
    except ValueError as exc:
        raise WebhookAuthenticityError(
            "The request body is not a form Twilio could have signed"
        ) from exc
    matches = [
        hmac.compare_digest(
            given.encode(), compute_signature(auth_token, signed, fields).encode()
        )
        for signed in (url, _with_port_toggled(url))
    ]
    if not any(matches):
        raise WebhookAuthenticityError(
            "The signature does not match this connection's Auth Token and address"
        )


def _with_port_toggled(url: str) -> str:
    """The same address with its default port written out, or without it if it
    was: Twilio signs whichever form it called, as its own validator allows."""
    parts = urlsplit(url)
    default = {"https": 443, "http": 80}.get(parts.scheme)
    if default is None or parts.hostname is None:
        return url
    host = parts.netloc.rsplit("@", 1)[-1]
    userinfo = parts.netloc[: len(parts.netloc) - len(host)]
    if parts.port is None:
        host = f"{host}:{default}"
    elif parts.port == default:
        host = host.rsplit(":", 1)[0]
    else:
        return url
    return parts._replace(netloc=userinfo + host).geturl()
