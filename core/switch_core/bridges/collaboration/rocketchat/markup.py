"""Between Switch Markdown and Rocket.Chat's.

Rocket.Chat's parser reads nearly all of Markdown as Switch writes it —
headings, lists, links, quotes, `**bold**`, `~~strike~~`, code — with one
difference that matters: a single `*` is bold there, not italic. So `*word*`
from an agent would shout, and `*word*` from a person means `**word**`.
Underscores are italic on both sides, so that is the spelling crossed to.

Code, link targets and bare URLs are left exactly as written, since an
asterisk in any of them is not markup.
"""

from __future__ import annotations

import re
from collections.abc import Callable

_VERBATIM = re.compile(
    r"(```[\s\S]*?(?:```|$)"  # a code block, closed or not
    r"|`[^`\n]*`"  # inline code
    r"|\]\([^)\s]*\)"  # a link's target
    r"|https?://\S+)"  # a bare URL
)

# One asterisk around a run that neither starts nor ends with a space, and is
# not half of a `**`. The space rule keeps a `* item` bullet and `2 * 3` out.
_SINGLE_STAR = re.compile(r"(?<![*\w])\*(?![\s*])([^*\n]*?[^\s*])\*(?![*\w])")


def to_rocketchat(markdown: str) -> str:
    return _outside_verbatim(markdown, lambda text: _SINGLE_STAR.sub(r"_\1_", text))


def from_rocketchat(text: str) -> str:
    return _outside_verbatim(text, lambda part: _SINGLE_STAR.sub(r"**\1**", part))


def _outside_verbatim(text: str, convert: Callable[[str], str]) -> str:
    parts = _VERBATIM.split(text)
    # `split` with one group alternates prose and verbatim, starting with prose.
    return "".join(
        part if index % 2 else convert(part) for index, part in enumerate(parts)
    )
