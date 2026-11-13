"""Split outbound Markdown to fit a platform's per-message character limit.

Every platform caps a message, and rejects one over the cap rather than
truncating it, so a long agent reply that is not split never reaches the
channel. The split lands on a line boundary where it can and on a word where a
single line is itself too long, so it falls somewhere the reader would have
paused anyway.

A split inside a fenced code block closes the fence at the end of one part and
reopens it, with the same info string, at the start of the next. Agents post
code constantly, and a fence torn in half renders the whole remainder as
unformatted text with a stray fence in it.

Fences follow CommonMark. A fence is indented by at most three spaces; a line
indented further is code or paragraph text, whatever it starts with. An
opening fence is a run of at least three backticks or tildes; a backtick
opener's info string contains no backtick (so a one-line span such as
```npm test``` opens nothing), while a tilde opener's may contain anything. A
closing fence is a run of the opener's own character at least as long as the
opener, followed only by whitespace.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

_TICK = "`"
_TILDE = "~"
_MAX_FENCE_INDENT = 3


@dataclass(frozen=True)
class _Fence:
    marker: str
    info: str
    line: str


def _marker_run(text: str) -> int:
    """How many fence characters `text` starts with: a run of one character,
    backtick or tilde, and 0 when it starts with neither."""
    if not text or text[0] not in (_TICK, _TILDE):
        return 0
    return len(text) - len(text.lstrip(text[0]))


def _fence_text(line: str) -> str | None:
    """`line` without its indentation, or None when it is indented too far
    to be a fence."""
    text = line.lstrip(" ")
    if len(line) - len(text) > _MAX_FENCE_INDENT:
        return None
    return text


def _opening_fence(line: str) -> _Fence | None:
    text = _fence_text(line)
    if text is None:
        return None
    run = _marker_run(text)
    if run < 3:
        return None
    info = text[run:].strip()
    if text[0] == _TICK and _TICK in info:
        return None
    return _Fence(text[:run], info, line)


def _closes(line: str, fence: _Fence) -> bool:
    text = _fence_text(line)
    if text is None or not text.startswith(fence.marker[0]):
        return False
    run = _marker_run(text)
    return run >= len(fence.marker) and not text[run:].strip()


def _first_cut_floor(line: str) -> int:
    """How long the first piece of a wrapped `line` must be to keep its role.

    A line that starts with a fence run but is neither an opener nor a closer
    has a backtick or other text after the run, and the first piece has to
    carry it. Cut sooner and the piece reads as a fence."""
    text = _fence_text(line)
    if text is None:
        return 0
    run = _marker_run(text)
    if run < 3:
        return 0
    after = text[run:]
    tail = after.find(_TICK) if text[0] == _TICK else -1
    if tail == -1:
        tail = len(after) - len(after.lstrip())
    return len(line) - len(text) + run + tail + 1


def _hard_wrap(line: str, budget: int) -> list[str]:
    """Break one over-long line, preferring a space over cutting a word.

    No piece reads as a fence the line was not: the first keeps what makes
    the line plain text, and no later piece starts with a fence run."""
    budget = max(1, budget)
    if len(line) <= budget:
        return [line]

    pieces: list[str] = []
    rest = line
    floor = _first_cut_floor(line)
    while len(rest) > budget:
        cut = rest.rfind(" ", floor, budget + 1)
        while cut > 0 and _marker_run(rest[cut:].lstrip(" ")) >= 3:
            cut = rest.rfind(" ", floor, cut)
        if cut <= 0:
            cut = budget
            lowest = floor if floor <= budget else 1
            while cut > lowest and _marker_run(rest[cut:].lstrip(" ")) >= 3:
                cut -= 1
        pieces.append(rest[:cut])
        rest = rest[cut:].lstrip(" ")
        floor = 0
    if rest:
        pieces.append(rest)
    return pieces


class _Splitter:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.chunks: list[str] = []
        self.buf: list[str] = []
        self.used = 0
        self.fence: _Fence | None = None
        # Index in `buf` of the line that opened `fence`: the source's own
        # opener, or the reopener a split put at the top of this part.
        self.opened_at: int | None = None

    def _reopener(self, fence: _Fence) -> str:
        # An info string so long it would crowd the code out of every part is
        # dropped from the reopened fences; the first part still carries it.
        opener = fence.marker + fence.info
        return opener if len(opener) <= self.limit // 4 else fence.marker

    def _carried(self, fence: _Fence) -> str:
        """The opener a part starts with when the source's own opener moves to
        it: kept verbatim unless it is long enough to crowd the code out."""
        return (
            fence.line if len(fence.line) <= self.limit // 4 else self._reopener(fence)
        )

    def _append(self, line: str) -> None:
        self.used += len(line) + (1 if self.buf else 0)
        self.buf.append(line)

    def _start(self, lines: list[str]) -> None:
        self.buf = []
        self.used = 0
        for line in lines:
            self._append(line)

    def _fits(self, piece: str, reserve: int) -> bool:
        return self.used + (1 if self.buf else 0) + len(piece) + reserve <= self.limit

    def _has_content(self) -> bool:
        if self.fence is None:
            return bool(self.buf)
        return self.opened_at != len(self.buf) - 1 or bool(self.opened_at)

    def _flush(self) -> None:
        fence = self.fence
        if fence is None:
            self.chunks.append("\n".join(self.buf))
            self._start([])
            return
        if self.opened_at == len(self.buf) - 1:
            # The block opened on this part's last line: carry the opener over
            # rather than end the part with an empty block.
            self.buf.pop()
            self.chunks.append("\n".join(self.buf))
            self._start([self._carried(fence)])
        else:
            self.chunks.append("\n".join(self.buf) + f"\n{fence.marker}")
            self._start([self._reopener(fence)])
        self.opened_at = 0

    def feed(self, raw: str) -> None:
        before = self.fence
        if before is not None and _closes(raw, before):
            if self._fits(raw, 0):
                self._append(raw)
            else:
                # The block ends right at the cut, so this part's closing fence
                # is the block's own and the next part starts outside it.
                self.chunks.append("\n".join(self.buf) + f"\n{before.marker}")
                self._start([])
            self.fence = None
            self.opened_at = None
            return

        after = before if before is not None else _opening_fence(raw)
        open_fence = before or after
        overhead = 0
        if open_fence is not None:
            # A wrapped opener is carried as its first piece, which can be up
            # to a quarter of the limit before the reopener replaces it.
            carried = (
                len(self._carried(open_fence))
                if before is not None
                else min(len(raw), self.limit // 4)
            )
            opener = max(len(self._reopener(open_fence)), carried)
            overhead = opener + len(open_fence.marker) + 2
        pieces = _hard_wrap(raw, self.limit - overhead)
        reserve = len(after.marker) + 1 if after is not None else 0
        for piece in pieces:
            if not self._fits(piece, reserve):
                if self._has_content():
                    self._flush()
                elif self.fence is not None:
                    # Only an opener too long to share a part with the code is
                    # here; the shorter form keeps the part within the limit.
                    self._start([self._reopener(self.fence)])
            self._append(piece)
            if self.fence is None and after is not None:
                self.fence = replace(after, line=piece)
                self.opened_at = len(self.buf) - 1

    def finish(self) -> list[str]:
        if self.buf:
            # An unclosed fence here was unclosed in the original too, and
            # inventing a terminator would change the content.
            self.chunks.append("\n".join(self.buf))
        return self.chunks


def split_markdown(content: str, limit: int) -> list[str]:
    """Split `content` into parts that each fit `limit` characters.

    Joining the parts with newlines gives back the original wherever no fence
    had to be closed and reopened and no line had to be wrapped.
    """
    if len(content) <= limit:
        return [content]
    splitter = _Splitter(limit)
    for raw_line in content.split("\n"):
        splitter.feed(raw_line)
    return splitter.finish()
