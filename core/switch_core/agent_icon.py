"""Validation for an agent's icon URL (CHOO-2171).

Switch stores a link to an agent's icon, never the image bytes. The picture may
come from a generated-avatar service, an operator's own host, or anywhere else
the client chooses — core does not care, and deliberately knows nothing about
any provider.

That makes the URL attacker-controlled input with two distinct consumers, and
the rules below exist for the second one:

  - **Rendered** in the gateway and relayed to collaboration bridges, which
    hand the link to Slack / Discord / Teams for *them* to fetch. Harmless.
  - **Fetched by Switch itself.** The Mattermost adapter downloads an agent's
    avatar and re-uploads it as the bot's icon. A URL naming an internal
    address would make that a probe into the network Switch runs in, so the
    scheme and host are constrained here, at the point of storage.

Host checks here cover literal IP addresses only. A DNS name resolving to a
private address (or re-resolving after this check) can only be caught when the
fetch happens, so a caller that actually retrieves the URL must guard there too
rather than treating storage validation as sufficient.
"""

import ipaddress
from typing import NoReturn
from urllib.parse import quote, urlsplit

# Long enough for a generated-avatar link carrying a full set of style options,
# short enough that the column cannot be used to smuggle a payload.
MAX_ICON_URL_LENGTH = 2048

_BLOCKED_HOSTNAMES = frozenset(
    {
        "localhost",
        "localhost.localdomain",
        "ip6-localhost",
        "ip6-loopback",
    }
)


class InvalidIconUrl(ValueError):
    """Raised when an icon URL is missing, malformed, or points somewhere unsafe."""


def _reject(reason: str) -> NoReturn:
    raise InvalidIconUrl(f"Invalid agent icon URL: {reason}")


def _check_host(hostname: str) -> None:
    if hostname.lower() in _BLOCKED_HOSTNAMES:
        _reject("must not point at the local machine")

    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return

    if (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_multicast
        or address.is_unspecified
    ):
        _reject("must not point at a private, loopback, or link-local address")


def validate_icon_url(url: str) -> str:
    """Return `url` stripped, or raise `InvalidIconUrl`.

    Accepts only an absolute `https://` URL with a plain hostname. Rejects
    other schemes (`data:`, `javascript:`, `file:`, plaintext `http:`),
    embedded credentials, and hosts that name the local machine or a private
    network.
    """
    if not isinstance(url, str):
        _reject("must be a string")

    candidate = url.strip()
    if not candidate:
        _reject("must not be empty")

    if len(candidate) > MAX_ICON_URL_LENGTH:
        _reject(f"must be at most {MAX_ICON_URL_LENGTH} characters")

    if any(character.isspace() or ord(character) < 0x20 for character in candidate):
        _reject("must not contain whitespace or control characters")

    try:
        parts = urlsplit(candidate)
    except ValueError as exc:
        _reject(f"could not be parsed ({exc})")

    if parts.scheme != "https":
        _reject(f"must use https, got {parts.scheme or 'no scheme'!r}")

    if parts.username or parts.password:
        _reject("must not embed credentials")

    hostname = parts.hostname
    if not hostname:
        _reject("must include a hostname")

    _check_host(hostname)

    return candidate


def default_icon_url(agent_name: str, *, image_format: str | None = None) -> str:
    """The initials avatar shown for an agent that has set no icon of its own.

    Unchanged from what the collaboration bridges have always generated — this
    is the picture agents already have on Slack, Mattermost, Discord and Teams,
    and it stays the default so nothing regresses for an agent nobody has given
    an icon to. It is gathered here only so the four bridges stop each keeping
    their own copy of the URL.

    `image_format` forces a response format for a caller that needs real bytes
    rather than a link to hand onward (Mattermost uploads the image itself).
    """
    # Escape first, substitute second. The `+` stands in for a space so the
    # avatar draws two initials for `switch_worker`; percent-encoding it after
    # the fact turns it back into a literal plus and the agent renders with one
    # initial instead. Agent names are already restricted to characters that
    # need no escaping, so `quote` is only a guard against a name that somehow
    # got past that.
    name = quote(agent_name).replace("_", "+")
    url = f"https://ui-avatars.com/api/?name={name}&background=random&size=128"
    return f"{url}&format={image_format}" if image_format else url


def normalise_icon_url(url: str | None) -> str | None:
    """Validate an optional icon URL, treating blank as "no icon".

    Callers accept `None` to mean "leave unset" and an empty string to mean
    "clear it"; both collapse to `None` so a cleared icon is stored as NULL
    rather than as an empty string the display layer would have to special-case.
    """
    if url is None:
        return None

    if not url.strip():
        return None

    return validate_icon_url(url)
