"""Switch Markdown as a Matrix message: a plain `body` and an HTML `formatted_body`.

Matrix carries both. `body` is what every client can show and what a client
without HTML support shows alone, so it is the Markdown itself, as Element
writes it. `formatted_body` is that Markdown rendered with the `Markdown`
library Switch already uses for its own message bodies
(`switch_core/transport/content.py`), made safe as `markdown_html.py` makes
it: an agent's text is never allowed to put markup of its own into a reader's
client. An `mxc://` image is kept, because Matrix allows those alone.

A mention of a Matrix account is a Markdown link to `https://matrix.to/#/<id>`,
which clients draw as a pill. The same links name who the message mentions in
`m.mentions`, which is how a current homeserver decides who to notify.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from switch_core.markdown_html import safe_markdown

PERMALINK = "https://matrix.to/#/"

# A Matrix user id as an agent or a person would write it: `@local:server`,
# optionally with a port. Localparts are lower case by the spec; historical
# ones may not be, so the class is wide.
USER_ID_RE = re.compile(
    r"(?<![\w@/#\[])@[A-Za-z0-9._=/+\-]+:[A-Za-z0-9.\-]*[A-Za-z0-9]"
    r"(?::[0-9]{1,5})?(?![\w\-])"
)

# A pill as `_render_outbound` writes it. `[` and `(` are excluded from the
# label and target so a run of unmatched brackets cannot make this quadratic.
_PILL_RE = re.compile(r"\[([^\[\]\n]*)\]\(" + re.escape(PERMALINK) + r"(@[^()\s]+)\)")

_SINGLE_PARAGRAPH = re.compile(r"\A<p>(.*)</p>\Z", re.DOTALL)

_LIST_ITEM = re.compile(r"^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s")


def _lists_set_apart(text: str) -> str:
    """A blank line before a list that follows a line of prose.

    Chat Markdown, CommonMark included, starts a list right under a sentence;
    the `Markdown` library needs a blank line first, and without one prints
    the items as one paragraph of dashes. Code blocks are left alone.
    """
    lines = text.split("\n")
    out: list[str] = []
    fenced = False
    for line in lines:
        if line.lstrip().startswith("```"):
            fenced = not fenced
        elif (
            not fenced
            and _LIST_ITEM.match(line)
            and out
            and out[-1].strip()
            and not _LIST_ITEM.match(out[-1])
            and not out[-1].startswith((" ", "\t"))
        ):
            out.append("")
        out.append(line)
    return "\n".join(out)


@dataclass(frozen=True)
class Rendered:
    body: str
    formatted_body: str
    mentioned: tuple[str, ...]


def pill(user_id: str, label: str) -> str:
    """A Markdown link that Matrix clients draw as a mention of `user_id`."""
    return f"[{label}]({PERMALINK}{user_id})"


def render(text: str) -> Rendered:
    """`text`, Switch Markdown, as the three things a Matrix message needs."""
    mentioned: list[str] = []
    for match in _PILL_RE.finditer(text):
        if match.group(2) not in mentioned:
            mentioned.append(match.group(2))
    return Rendered(
        body=_PILL_RE.sub(r"\1", text),
        formatted_body=to_html(text),
        mentioned=tuple(mentioned),
    )


def to_html(text: str) -> str:
    """Markdown to the HTML subset Matrix clients render, raw HTML escaped.

    Line breaks are kept (`nl2br`): a chat message is written line by line, and
    joining its lines into one paragraph, as Markdown does for documents, puts
    a list an agent typed without blank lines on a single line. A message that
    is one paragraph loses its `<p>`, which clients otherwise pad.
    """
    renderer = safe_markdown(
        ["fenced_code", "tables", "nl2br", "sane_lists"], keep_mxc_images=True
    )
    html: str = renderer.convert(_lists_set_apart(text))
    single = _SINGLE_PARAGRAPH.match(html)
    if single is not None and "<p>" not in single.group(1):
        return single.group(1)
    return html
