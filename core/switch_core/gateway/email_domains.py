"""The domain of an e-mail address, and the domains no workspace may claim.

A workspace can let anyone at a domain join it without an invitation. That is
only meaningful for a domain one organisation controls: opening a workspace to
a public e-mail provider's domain would open it to anyone who signs up there.

The refused domains are two published lists, vendored under
`email_domain_lists/` with their sources in each file's header, plus the
providers below that neither list carries. No list of free-mail services is
complete, so this narrows what can be claimed rather than proving a domain is
an organisation's.
"""

from __future__ import annotations

from importlib.resources import files

_LISTS = files("switch_core.gateway").joinpath("email_domain_lists")

_NOT_IN_LISTS = frozenset(
    {
        "hey.com",
        "pm.me",
        "proton.me",
        "tutanota.com",
    }
)


def _read_domains(name: str) -> frozenset[str]:
    lines = _LISTS.joinpath(name).read_text(encoding="utf-8").splitlines()
    domains = frozenset(
        line.strip() for line in lines if line.strip() and not line.startswith("#")
    )
    if not domains:
        raise RuntimeError(f"email_domain_lists/{name} lists no domains")
    return domains


PUBLIC_EMAIL_DOMAINS = (
    _read_domains("free.txt") | _read_domains("disposable.txt") | _NOT_IN_LISTS
)


def email_domain(email: str) -> str:
    """The lower-cased part of `email` after its last `@`.

    Raises `ValueError` for a string with no domain, which an account address
    should never be — so a caller reaching it has a malformed account, and
    guessing a domain for it would be worse than saying so.
    """
    _, at, domain = email.rpartition("@")
    domain = domain.strip().lower()
    if not at or not domain:
        raise ValueError(f"{email!r} has no domain")
    return domain


def join_domain_refusal(domain: str) -> str | None:
    """Why a workspace may not be opened to `domain`, or None if it may."""
    if domain in PUBLIC_EMAIL_DOMAINS:
        return (
            f"{domain} is a public e-mail provider, so opening the workspace "
            "to it would let anyone with an address there join"
        )
    return None
