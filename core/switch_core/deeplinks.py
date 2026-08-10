from __future__ import annotations

from urllib.parse import urlsplit

# Scheme + host of the switchdash session deeplink switchdash reports with its
# runtime state, e.g. `switchdash://session?server=…&agent=…&room=…&session=…`.
# urlsplit maps the part after `://` and before `?` to `netloc`, so a session
# deeplink is `scheme == "switchdash"` and `netloc == "session"`.
_DEEPLINK_SCHEME = "switchdash"
_DEEPLINK_HOST = "session"

# Gateway path that 302-redirects to the reconstructed `switchdash://` deeplink.
# Kept here so the route and the rewrite agree on a single source of truth.
DEEPLINK_REDIRECT_PATH = "/deeplink/session"


def switchdash_to_gateway(deeplink_url: str, gateway_public_url: str) -> str | None:
    """Rewrite a `switchdash://session?…` deeplink into a gateway HTTP redirect.

    Platforms like Discord only linkify http(s), so the raw custom-scheme
    deeplink renders as plain text. The gateway serves an HTTP endpoint
    (`DEEPLINK_REDIRECT_PATH`) that 302-redirects to the deeplink; posting that
    https URL makes the "Open in Switch Console" link clickable everywhere.

    The query string is carried across verbatim (server/agent/room/session and
    any future params). Returns None when `deeplink_url` is not a switchdash
    session deeplink, so callers leave unrecognised links untouched.
    """
    parts = urlsplit(deeplink_url)
    if parts.scheme != _DEEPLINK_SCHEME or parts.netloc != _DEEPLINK_HOST:
        return None
    # Only the query is carried across — switchdash session deeplinks never carry
    # a fragment, so there is nothing to preserve there.
    base = gateway_public_url.rstrip("/")
    query = f"?{parts.query}" if parts.query else ""
    return f"{base}{DEEPLINK_REDIRECT_PATH}{query}"


def gateway_query_to_switchdash(query: str) -> str:
    """Reconstruct the `switchdash://session?…` deeplink the redirect targets.

    The inverse of `switchdash_to_gateway`: the redirect endpoint hands the
    incoming query string here to build the Location it 302s to. Scheme and host
    are fixed constants, so the endpoint can never be coerced into redirecting to
    an arbitrary target.
    """
    suffix = f"?{query}" if query else ""
    return f"{_DEEPLINK_SCHEME}://{_DEEPLINK_HOST}{suffix}"
