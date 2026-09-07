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

# The `method = result` at the head of one resinfo chunk, and nothing else.
#
# Anchored deliberately. Scanning the whole chunk finds `dmarc=pass` anywhere in
# it — and the `ptype.property=value` pairs that follow the verdict are
# attacker-controlled. `smtp.mailfrom=dmarc=pass@evil.example` is a legal
# envelope sender (`=` is valid in a local part), so an unanchored scan reads a
# genuine `dmarc=fail` header stamped by our own infrastructure as a pass.
_METHOD = re.compile(r"^\s*(dmarc|spf|dkim)\s*=\s*([a-z]+)", re.IGNORECASE)


def _strip_leading_comments(text: str) -> str:
    """Drop any CFWS comments before the authserv-id.

    Balanced rather than regex: RFC 5322 comments nest, and `\\([^)]*\\)` stops at
    the first `)`, so `((a) b) mx.ours` would leave `b) mx.ours` and lose the
    verdict. Failing to match is safe — no verdict — but it leaves an operator
    authenticating nobody with no clue why.
    """
    rest = text.lstrip()
    while rest.startswith("("):
        depth = 0
        for index, char in enumerate(rest):
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    rest = rest[index + 1 :].lstrip()
                    break
        else:
            # Unbalanced: nothing sensible left to read.
            return ""
    return rest


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
    if not wanted:
        # No configured id means nothing can be trusted, and every header is
        # somebody's claim about themselves.
        return AuthVerdict(dmarc="none", spf="none", dkim="none")

    for header in headers:
        parts = _split_unquoted(header)
        if len(parts) < 2:
            continue
        if _authserv_id(parts[0]) != wanted:
            continue
        for chunk in parts[1:]:
            match = _METHOD.match(chunk)
            if match is None:
                continue
            method = match.group(1).lower()
            raw_value = match.group(2).lower()
            # Anything that is not a verdict is recorded as `none`, not skipped.
            # Skipping leaves the method unset, and a later chunk — one the
            # sender may have placed — then fills the gap. A genuine
            # `dmarc=none` must beat a smuggled `dmarc=pass` after it.
            value: Result = (
                "pass"
                if raw_value == "pass"
                else "fail"
                if raw_value == "fail"
                else "none"
            )
            # First verdict wins, except that `fail` beats anything: ordering
            # inside a header is not something the sender is prevented from
            # influencing, so it must not decide the outcome in the permissive
            # direction.
            if method not in found or value == "fail":
                found[method] = value

    return AuthVerdict(
        dmarc=found.get("dmarc", "none"),
        spf=found.get("spf", "none"),
        dkim=found.get("dkim", "none"),
    )


def _split_unquoted(header: str) -> list[str]:
    """Split on the semicolons that are actually separators.

    A `pvalue` may be a quoted string, and the values following a verdict —
    `smtp.mailfrom`, `header.i`, `header.d` — are chosen by the sender. A
    quoted local part may legally contain a semicolon, so
    ``smtp.mailfrom="x;dmarc=pass"@evil.example`` invents a chunk boundary and
    puts a forged verdict at the head of the chunk after it. Anchoring the
    verdict pattern to the head of a chunk is worth nothing if the sender picks
    where chunks begin.

    An unbalanced quote leaves the remainder as one chunk, which fails closed:
    whatever the sender hid in it is no longer at a chunk head.
    """
    parts: list[str] = []
    current: list[str] = []
    in_quotes = False
    escaped = False
    for ch in header:
        if escaped:
            current.append(ch)
            escaped = False
        elif ch == "\\" and in_quotes:
            current.append(ch)
            escaped = True
        elif ch == '"':
            in_quotes = not in_quotes
            current.append(ch)
        elif ch == ";" and not in_quotes:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return parts


def _authserv_id(raw: str) -> str:
    """The id at the head of an `Authentication-Results` header, normalised.

    A quoted id is **one token including its spaces**. Taking the first
    whitespace-delimited word and stripping quotes afterwards lets
    ``"mx.ours evil"`` read as ``mx.ours`` — and a border MTA strips a
    pre-existing header only on an *exact* match of its own id, so that one
    survives to be read as ours. An attacker prepends it to their own message
    and needs no MTA involvement at all.

    Also tolerates a leading comment and a trailing version number, both of
    which RFC 8601 permits; losing them fails closed, which is safe but leaves
    an operator authenticating nobody with no clue why.
    """
    text = _strip_leading_comments(raw)
    if text.startswith('"'):
        end = text.find('"', 1)
        return "" if end == -1 else text[1:end].strip().lower()
    head = text.split()[0:1]
    return head[0].lower() if head else ""


def authenticated_sender(verdict: AuthVerdict) -> bool:
    """Whether the `From` address may be treated as who it says it is.

    Only a DMARC pass. The temptation is to accept `spf=pass and dkim=pass` as
    equivalent, and it is not: neither asserts that the signing or envelope
    domain is the domain in the header a human reads, which is the only claim
    that matters when the answer decides whether someone may address an agent.
    """
    return verdict.dmarc == "pass"
