"""Making an agent's avatar sit on Slack's background rather than on white.

Slack composites a transparent avatar onto **white**, so a PNG with an alpha
channel wears a bright square in an otherwise dark message list. The other
platforms do not need this — Discord keeps the transparency and the bot sits
directly on Discord's own surface — which is why the fix lives here and not in
the URL the console generates or in the shared adapter base. One background
colour cannot be right everywhere, and Slack's is not Discord's.

It applies only to a DiceBear avatar, because that is the only URL whose
background this can ask for. A link an operator supplied themselves is an opaque
image to us: there is no parameter to add, and rewriting someone else's URL on a
guess would be worse than leaving it alone. Such an icon keeps whatever
background it was authored with, transparent included.
"""

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Slack's resting dark surface, sampled from a real client. A hovered row
# lightens and the edge becomes faintly visible; matching the hover state
# instead would make it visible in the far commoner resting one.
SLACK_SURFACE = "1a1d21"

_DICEBEAR_HOST = "api.dicebear.com"
_BACKGROUND_PARAM = "backgroundColor"


def on_slack_background(icon_url: str) -> str:
    """Return `icon_url` drawn on Slack's background, when that is possible.

    A DiceBear URL with no background of its own gains one. Anything else —
    another host, or a DiceBear URL whose background was chosen deliberately —
    is returned untouched.
    """
    parts = urlsplit(icon_url)
    if (parts.hostname or "").lower() != _DICEBEAR_HOST:
        return icon_url

    query = parse_qsl(parts.query, keep_blank_values=True)
    if any(key == _BACKGROUND_PARAM for key, _ in query):
        return icon_url

    query.append((_BACKGROUND_PARAM, SLACK_SURFACE))
    return urlunsplit(parts._replace(query=urlencode(query)))
