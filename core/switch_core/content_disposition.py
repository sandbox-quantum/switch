"""`Content-Disposition` headers for files whose names are free text."""

import os.path
import re
from urllib.parse import quote

_UNSAFE_IN_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")


def content_disposition(disposition: str, filename: str, fallback_stem: str) -> str:
    """A download header a filename cannot break out of (RFC 6266).

    The name is free text, so it may hold a quote, a newline, or a character
    outside latin-1 — a macOS screenshot's name has a narrow no-break space
    before its AM/PM. Interpolated raw, the first corrupts the header, the
    second appends one of the caller's choosing, and the third fails the whole
    response — headers are latin-1 on the wire. So the plain `filename` is
    reduced to an ASCII skeleton (`fallback_stem` standing in for a name with
    nothing left of it) and the real name travels percent-encoded in
    `filename*`, which is what a modern client prefers anyway.
    """
    stem, extension = os.path.splitext(filename)
    stem = _UNSAFE_IN_FILENAME.sub("-", stem).strip("-") or fallback_stem
    extension = _UNSAFE_IN_FILENAME.sub("-", extension)
    encoded = quote(filename, safe="")
    return f"{disposition}; filename=\"{stem}{extension}\"; filename*=UTF-8''{encoded}"


# Image types a browser shows without running anything. SVG is left out on
# purpose: it can carry script.
SAFE_INLINE_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})

# Nothing loads, and the page gets no origin and no script, if a browser
# renders the bytes after all.
UNTRUSTED_FILE_CSP = "default-src 'none'; sandbox"


def untrusted_file_headers(
    filename: str | None, content_type: str | None, fallback_stem: str
) -> dict[str, str]:
    """Headers for serving bytes someone uploaded, on Switch's own origin.

    An attachment can be HTML or SVG. Served inline with its own content type,
    a browser that opens it would run its script as Switch web, with the
    viewer's session. So only a short list of image types may be shown inline;
    everything else is a download (`attachment`). The browser may not guess a
    riskier type than the one declared (`nosniff`), and anything it renders
    anyway gets no script, no origin and no loads (the CSP). The content type
    itself is kept: Switch Console reads it to show the file.
    """
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    disposition = "inline" if mime in SAFE_INLINE_TYPES else "attachment"
    return {
        "Content-Disposition": (
            content_disposition(disposition, filename, fallback_stem)
            if filename
            else disposition
        ),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": UNTRUSTED_FILE_CSP,
    }
