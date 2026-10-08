"""The messaging platforms this process can bridge to, as a person names them.

One directory, filled in by `CollaborationBridgeLifecycleService.register_adapter`
from what each adapter declares about itself. Everything outside the adapters
that needs to say something about a platform — telemetry deciding which values
it may report, a card saying where an answer came from, the gateway telling
Console what to draw — reads it from here rather than keeping a list of its own,
so adding a platform is one adapter and one registration line.

Process-wide rather than injected because what it holds is code, not state:
the set of adapter classes this build ships, fixed once the process has
registered them. Nothing here comes from a request or the database.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: What a platform key may look like. Lowercase, starting with a letter, short.
#:
#: Enforced because the key goes places free text may not: it is a telemetry
#: value, part of a telemetry property name (`connector_<key>_count`), a path
#: segment and a surface in the session contract. A key that fits this cannot
#: carry an identifier, a URL or markup into any of them.
PLATFORM_KEY_PATTERN = r"[a-z][a-z0-9_]{1,31}"
_PLATFORM_KEY = re.compile(rf"^{PLATFORM_KEY_PATTERN}$")


class PlatformKeyInvalid(ValueError):
    """A platform key that does not fit `PLATFORM_KEY_PATTERN`."""


@dataclass(frozen=True)
class MessagingPlatform:
    """What Switch knows about a platform before any connection to it exists."""

    key: str
    #: The name a person uses for it: "Microsoft Teams", not "teams".
    display_name: str
    #: The page under the messaging-apps docs that explains how to connect it,
    #: or None where there is none yet.
    docs_slug: str | None
    #: The platform's logo as SVG markup, or None where the adapter ships none.
    #: Drawn by Console as an image, never inlined into a page.
    icon_svg: str | None


_REGISTERED: dict[str, MessagingPlatform] = {}


def check_key(key: str) -> None:
    """Raise `PlatformKeyInvalid` unless `key` is usable as a platform key."""
    if not _PLATFORM_KEY.fullmatch(key):
        raise PlatformKeyInvalid(
            f"{key!r} is not a valid messaging platform key: use 2-32 lowercase "
            "letters, digits or underscores, starting with a letter "
            "(e.g. 'google_chat')."
        )


def register(platform: MessagingPlatform) -> None:
    """Add a platform, replacing whatever was registered under its key."""
    check_key(platform.key)
    if not platform.display_name.strip():
        raise ValueError(f"Messaging platform {platform.key!r} has no display name.")
    _REGISTERED[platform.key] = platform


def lookup(key: str | None) -> MessagingPlatform | None:
    """The registered platform with this key, or None."""
    if key is None:
        return None
    return _REGISTERED.get(key)


def keys() -> tuple[str, ...]:
    """Every registered platform key, in registration order."""
    return tuple(_REGISTERED)


def display_name(key: str) -> str:
    """The platform's name for a reader, for any key.

    A key nobody registered — a connection whose adapter was removed, a frame
    from a newer peer — still gets a readable name rather than an error: the
    key itself, with underscores as spaces and an initial capital.
    """
    platform = _REGISTERED.get(key)
    if platform is not None:
        return platform.display_name
    words = key.replace("_", " ").strip()
    return words[:1].upper() + words[1:] if words else key
