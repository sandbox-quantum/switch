from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from ipaddress import ip_address
from urllib.parse import parse_qs, urlsplit

logger = logging.getLogger(__name__)

# Scheme + host of the Switch Console session deeplink Switch Console reports with its
# runtime state, e.g. `switchdash://session?server=…&agent=…&room=…&session=…`.
# urlsplit maps the part after `://` and before `?` to `netloc`, so a session
# deeplink is `scheme == "switchdash"` and `netloc == "session"`.
_DEEPLINK_SCHEME = "switchdash"
_DEEPLINK_HOST = "session"

# Gateway path that hands the browser off to the reconstructed `switchdash://`
# deeplink.
# Kept here so the route and the rewrite agree on a single source of truth.
DEEPLINK_REDIRECT_PATH = "/deeplink/session"


def switchdash_to_gateway(deeplink_url: str, gateway_public_url: str) -> str | None:
    """Rewrite a `switchdash://session?…` deeplink into a gateway HTTP redirect.

    Platforms like Discord only linkify http(s), so the raw custom-scheme
    deeplink renders as plain text. The gateway serves an HTTP endpoint
    (`DEEPLINK_REDIRECT_PATH`) that hands off to the deeplink; posting that
    https URL makes the "Open in Switch Console" link clickable everywhere.

    The query string is carried across verbatim (server/agent/room/session and
    any future params). Returns None when `deeplink_url` is not a switchdash
    session deeplink, so callers leave unrecognised links untouched.
    """
    parts = urlsplit(deeplink_url)
    if parts.scheme != _DEEPLINK_SCHEME or parts.netloc != _DEEPLINK_HOST:
        return None
    # Only the query is carried across — Switch Console session deeplinks never carry
    # a fragment, so there is nothing to preserve there.
    base = gateway_public_url.rstrip("/")
    query = f"?{parts.query}" if parts.query else ""
    return f"{base}{DEEPLINK_REDIRECT_PATH}{query}"


def deeplink_for_platform(
    deeplink_url: str | None,
    gateway_public_url: str | None,
    platform_renders_custom_schemes: bool,
) -> str | None:
    """Which form of the deeplink to post on a given platform.

    The redirect lands where the deeplink already points, so it buys nothing
    except a trip through the browser. It is worth that only where the raw
    scheme would not be a link at all. Three things have to be true to rewrite:
    there is a deeplink, the gateway has a public URL to redirect from, and the
    platform will not render the scheme itself.

    Returns the link to post — unchanged when any of those does not hold, and
    unchanged too if it is not a session deeplink this can rewrite.
    """
    if deeplink_url is None or not gateway_public_url:
        return deeplink_url
    if platform_renders_custom_schemes:
        return deeplink_url
    return switchdash_to_gateway(deeplink_url, gateway_public_url) or deeplink_url


def gateway_url_is_loopback(gateway_public_url: str) -> bool:
    """Whether a gateway origin only resolves on the machine that serves it.

    Names are judged as well as literals: RFC 6761 reserves `localhost`, and
    every name under it, for the loopback interface.
    """
    host = urlsplit(gateway_public_url).hostname
    if host is None:
        return False
    host = host.rstrip(".")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def gateway_url_warning(
    gateway_public_url: str | None, platform_renders_custom_schemes: bool
) -> str | None:
    """What is wrong with the gateway origin a bridge is about to post links from.

    Two ways a reader ends up unable to open a session from a message, both
    silent at click time and neither worth refusing to start a bridge over.
    Returns the sentence to log, or None when the origin will serve.
    """
    if not gateway_public_url:
        if platform_renders_custom_schemes:
            return None
        return (
            "GATEWAY_PUBLIC_URL is not set and this platform only renders http(s) "
            "links, so the 'Open in Switch Console' deeplink cannot be clickable — "
            "it is posted as copyable text instead. Set GATEWAY_PUBLIC_URL to the "
            "Switch API's public origin (scheme + host, no path) to turn it into a "
            "real link"
        )
    if gateway_url_is_loopback(gateway_public_url):
        return (
            f"GATEWAY_PUBLIC_URL is {gateway_public_url!r}, a loopback address, so "
            "every link built from it — the deeplink redirect, and the server the "
            "'Open in Switch Console' deeplink tells Switch Console to reach — "
            "resolves only on the machine running Switch. A reader on any other "
            "device gets a link that goes nowhere, with nothing to say so. Set "
            "GATEWAY_PUBLIC_URL to an origin reachable from where people read"
        )
    return None


def gateway_query_to_switchdash(query: str) -> str:
    """Reconstruct the `switchdash://session?…` deeplink the redirect targets.

    The inverse of `switchdash_to_gateway`: the handoff endpoint hands the
    incoming query string here to build the link it sends the browser to. Scheme
    and host are fixed constants, so the endpoint can never be coerced into
    pointing at an arbitrary target.
    """
    suffix = f"?{query}" if query else ""
    return f"{_DEEPLINK_SCHEME}://{_DEEPLINK_HOST}{suffix}"


# Gateway path that hands the browser off to a `switchdash://open/<page>` link,
# the https form a chat platform can make clickable.
CONSOLE_LINK_REDIRECT_PATH = "/deeplink/open"

# Where someone without Switch Console is sent to get it.
GET_SWITCH_CONSOLE_URL = (
    "https://docs.switchagents.ai/flintai/switch/getting-started/install-switch-console"
)

_CONSOLE_LINK_HOST = "open"

# The same rule Switch Console applies to the id a page names.
_CONSOLE_LINK_ID = re.compile(r"[A-Za-z0-9_.:-]{1,200}")


@dataclass(frozen=True)
class ConsolePage:
    """A page a `switchdash://open/…` link can name, as a person reads it.

    `name` is how the page is named in words, for a reader who cannot click
    through; `tabs` maps each tab the page has to its own name.
    """

    name: str
    has_id: bool = False
    tabs: Mapping[str, str] = field(default_factory=dict)


# Switch Console's link catalogue (`CONSOLE_PAGES` in
# console/apps/switch-console-desktop/src/shared/core/deeplinks/console-links.ts),
# with the names a person reads. A test holds the two together.
CONSOLE_PAGES: Mapping[str, ConsolePage] = {
    "home": ConsolePage("the server's home"),
    "agents": ConsolePage("the list of agents"),
    "agents/new": ConsolePage("the page to add a new agent"),
    "agent": ConsolePage(
        "your agent's page",
        has_id=True,
        tabs={
            "chats": "your agent's chats",
            "connections": "your agent's connections",
            "settings": "your agent's settings",
        },
    ),
    "rooms": ConsolePage("the list of rooms"),
    "room": ConsolePage("the room's page", has_id=True),
    "chat": ConsolePage("the direct chat", has_id=True),
    "buddy": ConsolePage(
        "switch-buddy's page",
        tabs={
            "chats": "switch-buddy's chats",
            "connections": "switch-buddy's connections",
            "settings": "switch-buddy's settings",
        },
    ),
    "templates": ConsolePage(
        "the templates",
        tabs={
            "agent": "the agent templates",
            "room": "the room templates",
            "group": "the group templates",
        },
    ),
    "template": ConsolePage("the template's page", has_id=True),
    "messaging-apps/connect": ConsolePage("the page to connect a messaging app"),
    "connections": ConsolePage("your connectors"),
    "invite": ConsolePage("the page to invite people to the workspace"),
    "settings": ConsolePage(
        "Switch Console's settings",
        tabs={
            "general": "Switch Console's general settings",
            "clis-models": "Switch Console's CLIs and models settings",
            "remote-hosts": "Switch Console's remote hosts settings",
            "managed-agents": "Switch Console's managed agents settings",
            "interface": "Switch Console's interface settings",
        },
    ),
}


@dataclass(frozen=True)
class ConsoleLink:
    """A `switchdash://open/…` link that names a page Switch Console opens."""

    page: str
    id: str | None
    tab: str | None
    # The query as written, carried across verbatim (`tab`, `server`, …).
    query: str

    @property
    def path(self) -> str:
        return f"{self.page}/{self.id}" if self.id else self.page

    @property
    def page_name(self) -> str:
        spec = CONSOLE_PAGES[self.page]
        if self.tab is not None:
            return spec.tabs[self.tab]
        return spec.name

    @property
    def switchdash_url(self) -> str:
        suffix = f"?{self.query}" if self.query else ""
        return f"{_DEEPLINK_SCHEME}://{_CONSOLE_LINK_HOST}/{self.path}{suffix}"

    def gateway_url(self, gateway_public_url: str) -> str:
        suffix = f"?{self.query}" if self.query else ""
        base = gateway_public_url.rstrip("/")
        return f"{base}{CONSOLE_LINK_REDIRECT_PATH}/{self.path}{suffix}"


def parse_console_link_path(path: str, query: str) -> ConsoleLink | None:
    """The Console page `path` and `query` name, or None when Switch Console
    has no such page, the page's id is missing or malformed, or it has no
    such tab — the same rules Switch Console reads a link by."""
    segments = [segment for segment in path.split("/") if segment]
    joined = "/".join(segments)
    page: str | None = None
    page_id: str | None = None
    if joined in CONSOLE_PAGES and not CONSOLE_PAGES[joined].has_id:
        page = joined
    elif len(segments) >= 2:
        parent = "/".join(segments[:-1])
        if parent in CONSOLE_PAGES and CONSOLE_PAGES[parent].has_id:
            page, page_id = parent, segments[-1]
    if page is None:
        return None
    if page_id is not None and not _CONSOLE_LINK_ID.fullmatch(page_id):
        return None
    tabs = parse_qs(query, keep_blank_values=True).get("tab")
    tab = tabs[0] if tabs else None
    if tab is not None and tab not in CONSOLE_PAGES[page].tabs:
        return None
    return ConsoleLink(page=page, id=page_id, tab=tab, query=query)


def parse_console_link(url: str) -> ConsoleLink | None:
    """Read a `switchdash://open/…` URL; None when it is not one that names a
    page Switch Console opens."""
    parts = urlsplit(url)
    if parts.scheme != _DEEPLINK_SCHEME or parts.netloc != _CONSOLE_LINK_HOST:
        return None
    return parse_console_link_path(parts.path, parts.query)


# A Markdown link to a Console page, and the code spans no link is read inside.
_CONSOLE_MARKDOWN_LINK = re.compile(
    r"```.*?```|~~~.*?~~~|`[^`\n]*`"
    r"|\[(?P<label>[^\[\]\n]*)\]\((?P<url>switchdash://open/[^)\s]*)\)",
    re.DOTALL,
)


_CONSOLE_LINK_MARKER = f"{_DEEPLINK_SCHEME}://{_CONSOLE_LINK_HOST}/"


def rewrite_console_links(text: str, gateway_public_url: str | None) -> str:
    """Rewrite Markdown links to Console pages for a platform that cannot open
    the `switchdash://` scheme.

    With a public address each becomes the https handoff route for the same
    page, keeping its label. Without one there is nothing to link to, so the
    link becomes its label followed by the page's name in words: a reader can
    still find it, and no link that goes nowhere is posted. A link to a page
    Switch Console does not have is left as written, and logged.
    """

    def _replace(match: re.Match[str]) -> str:
        url = match.group("url")
        if url is None:
            return match.group(0)
        label = match.group("label")
        link = parse_console_link(url)
        if link is None:
            logger.warning("Not rewriting a link to an unknown Console page: %s", url)
            return match.group(0)
        if gateway_public_url:
            return f"[{label}]({link.gateway_url(gateway_public_url)})"
        where = f"in Switch Console: {link.page_name}"
        return f"{label} ({where})" if label else f"({where})"

    if _CONSOLE_LINK_MARKER not in text:
        return text
    return _CONSOLE_MARKDOWN_LINK.sub(_replace, text)
