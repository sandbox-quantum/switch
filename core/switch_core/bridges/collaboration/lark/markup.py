"""Switch Markdown to Lark and back.

Outbound, a message is a Lark rich-text post whose body is one `md` element:
Lark renders bold, italics, strikethrough, links, lists, quotes and code
blocks there itself, so Switch Markdown goes through nearly as written.
Headings are not part of it and become bold lines, and a table becomes a code
block so its columns stay lined up.

Inbound, a text message names whoever it mentions by a key (`@_user_1`) that
the event's `mentions` list resolves, and a rich-text post is a list of
paragraphs of tagged elements; both come back as Markdown.
"""

from __future__ import annotations

import re
from typing import Any

# A post's body Lark takes is 30 KB; a message is cut well inside it, at a
# length a reader can still take in at once.
MAX_MESSAGE = 4000

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")
_TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")


def to_lark(markdown: str) -> str:
    """`markdown` as the text of a post's `md` element."""
    lines = markdown.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    in_code = False
    index = 0
    while index < len(lines):
        line = lines[index]
        if _FENCE.match(line):
            in_code = not in_code
            out.append(line)
            index += 1
            continue
        if in_code:
            out.append(line)
            index += 1
            continue
        if (
            line.strip().startswith("|")
            and index + 1 < len(lines)
            and _TABLE_RULE.match(lines[index + 1])
        ):
            table = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                table.append(lines[index])
                index += 1
            out.extend(["```", *table, "```"])
            continue
        heading = _HEADING.match(line)
        out.append(f"**{heading.group(2)}**" if heading else line)
        index += 1
    return "\n".join(out)


def chunk(text: str, limit: int = MAX_MESSAGE) -> list[str]:
    """`text` cut into messages of at most `limit` characters, at a blank
    line where one is near, then at a line, then at a space. A code block cut
    in two is closed at the end of one part and opened again in the next."""
    parts: list[str] = []
    rest = text.strip("\n")
    fence: str | None = None
    while len(rest) > limit:
        budget = limit - (len(fence) + 1 if fence else 0) - 4
        window = rest[:budget]
        cut = window.rfind("\n\n")
        if cut < budget // 2:
            cut = window.rfind("\n")
        if cut < budget // 2:
            cut = window.rfind(" ")
        if cut <= 0:
            cut = budget
        piece, rest = rest[:cut].rstrip(), rest[cut:].lstrip("\n ")
        if fence:
            piece = f"{fence}\n{piece}"
        opened = _open_fence(piece)
        if opened:
            piece += "\n```"
        parts.append(piece)
        fence = opened
    if rest:
        parts.append(f"{fence}\n{rest}" if fence else rest)
    return parts or [""]


def _open_fence(text: str) -> str | None:
    """The fence line left open at the end of `text`, if any."""
    open_line: str | None = None
    for line in text.split("\n"):
        if _FENCE.match(line):
            open_line = None if open_line else line.strip()
    return open_line


def from_text(text: str, mentions: list[dict[str, Any]]) -> str:
    """A text message with each mention key put back as `@name`."""
    for mention in sorted(mentions, key=lambda m: -len(str(m.get("key", "")))):
        key = str(mention.get("key") or "")
        if key:
            text = text.replace(key, f"@{mention.get('name') or 'someone'}")
    return text.strip()


def from_post(
    post: dict[str, Any], mentions: list[dict[str, Any]]
) -> tuple[str, list[str]]:
    """A rich-text post as Markdown, and the image keys it carries."""
    names = {str(m.get("key")): str(m.get("name") or "") for m in mentions}
    by_id = {
        str((m.get("id") or {}).get("open_id")): str(m.get("name") or "")
        for m in mentions
    }
    images: list[str] = []
    paragraphs: list[str] = []
    title = str(post.get("title") or "").strip()
    if title:
        paragraphs.append(f"**{title}**")
    for paragraph in post.get("content") or []:
        if not isinstance(paragraph, list):
            continue
        pieces: list[str] = []
        for element in paragraph:
            if not isinstance(element, dict):
                continue
            tag = element.get("tag")
            text = str(element.get("text") or "")
            if tag == "text":
                pieces.append(_styled(text, element.get("style") or []))
            elif tag == "a":
                pieces.append(f"[{text or element.get('href')}]({element.get('href')})")
            elif tag == "at":
                key = str(element.get("user_id") or "")
                name = (
                    element.get("user_name")
                    or names.get(key)
                    or by_id.get(key)
                    or ("everyone" if key == "all" else "someone")
                )
                pieces.append(f"@{name}")
            elif tag == "code_block":
                language = str(element.get("language") or "").lower()
                pieces.append(f"\n```{language}\n{text.rstrip()}\n```\n")
            elif tag == "md":
                pieces.append(text)
            elif tag == "emotion":
                pieces.append(f":{element.get('emoji_type', '')}:")
            elif tag in ("img", "media") and element.get("image_key"):
                images.append(str(element["image_key"]))
            elif tag == "hr":
                pieces.append("\n---\n")
        paragraphs.append("".join(pieces))
    return "\n".join(paragraphs).strip(), images


def _styled(text: str, style: list[str]) -> str:
    if not text.strip():
        return text
    if "bold" in style:
        text = f"**{text}**"
    if "italic" in style:
        text = f"*{text}*"
    if "lineThrough" in style:
        text = f"~~{text}~~"
    return text
