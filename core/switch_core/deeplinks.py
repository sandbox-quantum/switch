from __future__ import annotations

from ipaddress import ip_address
from urllib.parse import urlsplit

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
