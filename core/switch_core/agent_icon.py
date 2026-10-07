"""Validation for an agent's icon URL (CHOO-2171).

Switch stores a link to an agent's icon, never the image bytes. The picture may
come from an operator's own host or anywhere else the client chooses; an agent
created without one gets a generated icon (`generated_icon_url`), the same set
every client offers, so it looks alike in the gateway, Console and every
platform. An agent with no icon stored at all is drawn with the one its name
generates, so it looks the same as one that was given it. A sender that is not
an agent at all keeps a lettered badge (`initials_icon_url`), so a person never
wears an agent's face.

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
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

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


# Generated icons. The URL is all Switch stores; the picture is DiceBear's
# "gaze", raster because Slack, Discord and Mattermost render no SVG, and pinned
# to a major version because the drawing changes between majors.
_GENERATED_ICON_BASE = "https://api.dicebear.com/10.x/gaze/png"
_GENERATED_ICON_PIXELS = 256
# A tenth larger than DiceBear draws it, which leaves the body small in its
# frame at chat-avatar size. At that scale the arch is the one silhouette a round
# crop (Discord, Mattermost, Teams) cuts into, so it is left out of the draw.
_GENERATED_ICON_SCALE = "1.1"
_GENERATED_ICON_SHAPES = (
    "circle",
    "column",
    "diamond",
    "egg",
    "hexagon",
    "octagon",
    "pentagon",
    "pill",
    "square",
    "triangle",
)
GENERATED_ICON_CHOICES = 10


def generated_icon_url(seed: str) -> str:
    """The generated icon for `seed`: the same seed always draws the same face.

    Each shape is its own `shapeVariant` parameter rather than one comma list.
    DiceBear refuses a list whose commas arrive percent-encoded, and anything
    that re-encodes the query, as the Slack bridge does to add a background,
    encodes them.
    """
    query = [
        ("seed", seed),
        ("size", str(_GENERATED_ICON_PIXELS)),
        ("scale", _GENERATED_ICON_SCALE),
        *(("shapeVariant", shape) for shape in _GENERATED_ICON_SHAPES),
    ]
    return f"{_GENERATED_ICON_BASE}?{urlencode(query, quote_via=quote)}"


# The robot every client generated before gaze, in exactly the shape they built
# it: a seed and this size, nothing else. A robot URL with anything more on it
# was put together by hand and is someone's choice, so it is left alone.
_LEGACY_ICON_HOST = "api.dicebear.com"
_LEGACY_ICON_PATH = "/9.x/bottts/png"
_LEGACY_ICON_PIXELS = "256"


def upgrade_legacy_icon_url(url: str) -> str:
    """`url`, or the gaze icon for its seed when it is a generated robot.

    Switch Console builds from before gaze still generate the robot for a new
    agent and for one with no icon, and send it here to be stored. Converting it
    on the way in means those clients cannot reintroduce robots after the
    migration that replaced every stored one.
    """
    parts = urlsplit(url)
    if (
        parts.scheme != "https"
        or (parts.hostname or "").lower() != _LEGACY_ICON_HOST
        or parts.path != _LEGACY_ICON_PATH
        or parts.fragment
    ):
        return url

    query = parse_qsl(parts.query, keep_blank_values=True)
    fields = dict(query)
    if len(query) != 2 or set(fields) != {"seed", "size"}:
        return url
    if fields["size"] != _LEGACY_ICON_PIXELS or not fields["seed"]:
        return url

    return generated_icon_url(fields["seed"])


def initials_icon_url(name: str) -> str:
    """The lettered badge for a sender that is not an agent.

    A person relayed from another platform, or a platform's own bot, is drawn
    with initials rather than a generated face: the generated faces are what
    agents wear, and a human drawn as one would read as an agent.
    """
    # Escape first, substitute second. The `+` stands in for a space so the
    # badge draws two initials for `switch_worker`; percent-encoding it after
    # the fact turns it back into a literal plus and the name renders with one
    # initial instead.
    escaped = quote(name).replace("_", "+")
    return f"https://ui-avatars.com/api/?name={escaped}&background=random&size=128"


def generated_icon_choices(agent_name: str, page: int) -> list[str]:
    """One page of icons to choose from for an agent called `agent_name`.

    Page 0 leads with the icon its name generates, which is what a new agent
    gets when nobody picks one; every page is the same each time it is asked
    for, so a picker does not reshuffle under the person choosing.
    """
    seeds = [f"{agent_name}-{page}-{index}" for index in range(GENERATED_ICON_CHOICES)]
    if page == 0:
        seeds = [agent_name, *seeds[: GENERATED_ICON_CHOICES - 1]]
    return [generated_icon_url(seed) for seed in seeds]


def normalise_icon_url(url: str | None) -> str | None:
    """Validate an optional icon URL, treating blank as "no icon".

    Callers accept `None` to mean "leave unset" and an empty string to mean
    "clear it"; both collapse to `None` so a cleared icon is stored as NULL
    rather than as an empty string the display layer would have to special-case.
    A generated robot from an older client is stored as its gaze equivalent
    (`upgrade_legacy_icon_url`).
    """
    if url is None:
        return None

    if not url.strip():
        return None

    return upgrade_legacy_icon_url(validate_icon_url(url))
