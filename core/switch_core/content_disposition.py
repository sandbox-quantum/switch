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
