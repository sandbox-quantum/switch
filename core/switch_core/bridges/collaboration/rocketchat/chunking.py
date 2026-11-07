"""Splitting a long reply into messages Rocket.Chat accepts.

Rocket.Chat refuses a message over `Message_MaxAllowedSize`, 5000 characters
unless the server says otherwise, so the limit here leaves room for an agent's
name at the head of the first part. A reply is cut at a paragraph or a line
where it can be, and a code block cut in two is closed and reopened, so both
halves still render as code.
"""

from __future__ import annotations

MAX_MESSAGE_CHARS = 4500

_FENCE = "```"


def chunk_markdown(text: str) -> list[str]:
    """`text` as messages of at most `MAX_MESSAGE_CHARS`, in order."""
    chunks: list[str] = []
    rest = text
    reopen = ""
    while len(reopen) + len(rest) > MAX_MESSAGE_CHARS:
        room = MAX_MESSAGE_CHARS - len(reopen) - len(_FENCE) - 1
        cut = _cut_point(rest, room)
        piece = reopen + rest[:cut].rstrip("\n")
        rest = rest[cut:].lstrip("\n")
        fence = _open_fence(piece)
        if fence is None:
            chunks.append(piece)
            reopen = ""
        else:
            chunks.append(f"{piece}\n{_FENCE}")
            reopen = f"{fence}\n"
    chunks.append(reopen + rest)
    return chunks


def clamp_markdown(text: str) -> str:
    """`text` cut to one message, for what cannot be split, such as an edit."""
    if len(text) <= MAX_MESSAGE_CHARS:
        return text
    marker = "\n…"
    piece = text[: MAX_MESSAGE_CHARS - len(marker) - len(_FENCE) - 1]
    if _open_fence(piece) is not None:
        piece = f"{piece}\n{_FENCE}"
    return f"{piece}{marker}"


def _cut_point(text: str, room: int) -> int:
    """Where to cut: the last paragraph, line or word break that fits, and
    the very edge only where a single word fills the whole message."""
    for separator in ("\n\n", "\n", " "):
        at = text.rfind(separator, room // 2, room)
        if at > 0:
            return at + len(separator)
    return room


def _open_fence(text: str) -> str | None:
    """The opening line of a code block left open at the end of `text`."""
    fence: str | None = None
    for line in text.split("\n"):
        if line.lstrip().startswith(_FENCE):
            fence = None if fence is not None else line.strip()
    return fence
