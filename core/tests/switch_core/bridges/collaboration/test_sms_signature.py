from __future__ import annotations

from urllib.parse import urlencode

import pytest

from switch_core.bridges.collaboration.install import WebhookAuthenticityError
from switch_core.bridges.collaboration.sms.signature import (
    compute_signature,
    parse_form,
    verify_signature,
)

TOKEN = "test-auth-token"
URL = "https://messaging.example.com/messaging/bridges/b1/events"
FIELDS = [("MessageSid", "SM1"), ("From", "+14155550100"), ("Body", "hello there")]
BODY = urlencode(FIELDS).encode()


def test_matches_twilios_published_example() -> None:
    """The worked example in Twilio's security docs, not our own arithmetic."""
    fields = [
        ("CallSid", "CA1234567890ABCDE"),
        ("Caller", "+14158675310"),
        ("Digits", "1234"),
        ("From", "+14158675310"),
        ("To", "+18005551212"),
    ]
    signature = compute_signature(
        "12345", "https://example.com/myapp.php?foo=1&bar=2", fields
    )
    assert signature == "L/OH5YylLD5NRKLltdqwSvS0BnU="


def test_field_order_does_not_change_the_signature() -> None:
    assert compute_signature(TOKEN, URL, FIELDS) == compute_signature(
        TOKEN, URL, list(reversed(FIELDS))
    )


def test_repeated_field_signs_each_distinct_value_in_sorted_order() -> None:
    repeated = [("Tag", "b"), ("Tag", "a"), ("Tag", "b")]
    assert compute_signature(TOKEN, URL, repeated) == compute_signature(
        TOKEN, URL, [("Tag", "a"), ("Tag", "b")]
    )


def test_uppercase_field_names_sort_before_lowercase() -> None:
    assert compute_signature(TOKEN, URL, [("a", "2"), ("B", "1")]) == compute_signature(
        TOKEN, URL + "B1", [("a", "2")]
    )


def test_blank_values_stay_in_the_signature() -> None:
    body = b"Body=&From=%2B14155550100"
    assert parse_form(body) == [("Body", ""), ("From", "+14155550100")]


def test_correct_signature_is_accepted() -> None:
    verify_signature(TOKEN, URL, BODY, compute_signature(TOKEN, URL, FIELDS))


@pytest.mark.parametrize(
    ("token", "url", "body"),
    [
        ("another-token", URL, BODY),
        (TOKEN, URL + "/other", BODY),
        (TOKEN, URL, BODY + b"&Body=tampered"),
    ],
    ids=["wrong-token", "wrong-url", "tampered-body"],
)
def test_mismatched_request_is_refused(token: str, url: str, body: bytes) -> None:
    signature = compute_signature(TOKEN, URL, FIELDS)
    with pytest.raises(WebhookAuthenticityError):
        verify_signature(token, url, body, signature)


def test_missing_signature_is_refused() -> None:
    with pytest.raises(WebhookAuthenticityError, match="no Twilio signature"):
        verify_signature(TOKEN, URL, BODY, "")


def test_non_ascii_signature_is_refused_rather_than_crashing() -> None:
    with pytest.raises(WebhookAuthenticityError):
        verify_signature(TOKEN, URL, BODY, "sïgnature")


@pytest.mark.parametrize(
    "body",
    [b"\xff\xfe", b"Body=%ff", b"&".join(b"f%d=1" % i for i in range(201))],
    ids=["not-utf8", "bad-percent-escape", "too-many-fields"],
)
def test_unreadable_body_is_refused(body: bytes) -> None:
    with pytest.raises(WebhookAuthenticityError, match="not a form"):
        verify_signature(TOKEN, URL, body, "c2lnbmF0dXJl")
