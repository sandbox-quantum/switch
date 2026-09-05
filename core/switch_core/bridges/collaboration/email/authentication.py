"""Whether the mail infrastructure vouched for who sent a message.

Every other bridge sits behind a platform that authenticated the account before
accepting the message. Email does not: a `From` header is typed by whoever sent
the mail. While the only legitimate sender was the owner, an allowlist covered
that. Once an outsider can legitimately write to an agent, it does not — the
whole point is admitting someone nobody listed in advance.

What replaces it is the receiving infrastructure's own verdict, reported in an
`Authentication-Results` header (RFC 8601).

**The header is only worth what its author is worth.** It is ordinary text in an
ordinary message, so a sender who wants to be believed can simply include one
saying `dmarc=pass` — and it arrives *ahead* of ours, because a receiver
prepends its own. So this reads exactly one header: the one stamped with the
`authserv-id` an operator configured. Everything else is discarded unread. A
deployment that has not configured that id gets no verdict, which is correct:
mail that reached us through a path we cannot identify has been checked by
nothing we can name.

**DMARC is the verdict that means something.** SPF passing says the envelope
sender matched, which a forwarder satisfies while carrying mail claiming to be
from anyone. DKIM passing says *a* domain signed it, not that it is the domain a
person reads in the `From` line. Only DMARC asserts the alignment between them,
which is the question actually being asked.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

Result = Literal["pass", "fail", "none"]

_METHOD = re.compile(r"\b(dmarc|spf|dkim)\s*=\s*([a-z]+)", re.IGNORECASE)


@dataclass(frozen=True)
class AuthVerdict:
    """What our own mail host concluded about a message's origin.

    `none` means "not asserted" rather than "failed" — no header, an untrusted
    one, or one that did not mention the method. It is kept distinct from `fail`
    because they call for different explanations to an operator: one is a
    deployment that is not checking, the other is a message that did not pass.
    """

    dmarc: Result
    spf: Result
    dkim: Result


def parse_authentication_results(
    headers: Iterable[str], *, trusted_authserv_id: str
) -> AuthVerdict:
    """Read the verdict from the one header our own infrastructure stamped.

    Headers whose `authserv-id` is anything else are discarded without being
    parsed — see the module docstring; this is the security of the mechanism
    rather than a tidiness measure.
    """
    found: dict[str, Result] = {}
    wanted = trusted_authserv_id.strip().lower()

    for header in headers:
        authserv, separator, rest = header.partition(";")
        if not separator:
            continue
        # RFC 8601 allows an optional version after the id: "mx.example 1".
        if authserv.strip().lower().split()[0:1] != [wanted]:
            continue
        for method, result in _METHOD.findall(rest):
            method = method.lower()
            value = result.lower()
            if method not in found and value in ("pass", "fail"):
                found[method] = value  # type: ignore[assignment]

    return AuthVerdict(
        dmarc=found.get("dmarc", "none"),
        spf=found.get("spf", "none"),
        dkim=found.get("dkim", "none"),
    )


def authenticated_sender(verdict: AuthVerdict) -> bool:
    """Whether the `From` address may be treated as who it says it is.

    Only a DMARC pass. The temptation is to accept `spf=pass and dkim=pass` as
    equivalent, and it is not: neither asserts that the signing or envelope
    domain is the domain in the header a human reads, which is the only claim
    that matters when the answer decides whether someone may address an agent.
    """
    return verdict.dmarc == "pass"
