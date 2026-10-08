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

Slack also refuses a post outright when its `icon_url` is too long, so an
avatar URL that runs over loses the message, not just the picture. A DiceBear
URL is written as compactly as DiceBear reads it; one that still does not fit
is not sent, and Slack shows the app's own icon for that post.
"""

import logging
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

logger = logging.getLogger(__name__)

# Slack's resting dark surface, sampled from a real client. A hovered row
# lightens and the edge becomes faintly visible; matching the hover state
# instead would make it visible in the far commoner resting one.
SLACK_SURFACE = "1a1d21"

#: The longest `icon_url` Slack accepts. One character more and
#: `chat.postMessage` refuses the whole post with `invalid_arguments`; measured
#: against the live API, as Slack does not document it.
SLACK_ICON_URL_MAX = 255

_DICEBEAR_HOST = "api.dicebear.com"
_BACKGROUND_PARAM = "backgroundColor"


def on_slack_background(icon_url: str) -> str:
    """Return `icon_url` drawn on Slack's background, when that is possible.

    A DiceBear URL with no background of its own gains one, and an option it
    repeats is written once as a comma list, which DiceBear reads as the same
    image at a fraction of the length. A background chosen deliberately is
    kept. Any other host is returned untouched.
    """
    parts = urlsplit(icon_url)
    if (parts.hostname or "").lower() != _DICEBEAR_HOST:
        return icon_url

    options: dict[str, list[str]] = {}
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        options.setdefault(key, []).append(value)
    options.setdefault(_BACKGROUND_PARAM, [SLACK_SURFACE])
    query = urlencode(
        [(key, ",".join(values)) for key, values in options.items()],
        safe=",",
        quote_via=quote,
    )
    return urlunsplit(parts._replace(query=query))


# Oversized icon URLs already reported, so an agent posting every turn does
# not repeat one unchanged condition on every post.
_reported_oversized: set[str] = set()


def slack_icon_argument(icon_url: str, agent_name: str) -> str | None:
    """The `icon_url` to hand Slack for a post, or None to send none.

    None when Slack would refuse the URL: the post then goes out under the
    app's own icon rather than not at all. Reported once per URL.
    """
    if len(icon_url) <= SLACK_ICON_URL_MAX:
        return icon_url
    if icon_url in _reported_oversized:
        return None
    _reported_oversized.add(icon_url)
    logger.warning(
        "The icon URL for %s is %d characters, over Slack's limit of %d; "
        "posting under the Slack app's own icon instead.",
        agent_name,
        len(icon_url),
        SLACK_ICON_URL_MAX,
    )
    return None
