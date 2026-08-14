"""Incremental Server-Sent Events decoding for the AG-UI stream.

AG-UI frames every event as a bare ``data:`` line terminated by a blank line
and discriminates on the JSON ``type`` inside it, so the ``event:``, ``id:``
and ``retry:`` fields carry nothing and are ignored — as they are by AG-UI's
own client. One consequence worth knowing: because no ``id:`` is ever sent
there is no ``Last-Event-ID`` to resume from, so a dropped stream cannot be
continued, only re-run.

The decoder is incremental because chunk boundaries have nothing to do with
frame boundaries: a single JSON event routinely arrives split across several
reads, and two events routinely arrive in one.
"""

from __future__ import annotations

import json
from typing import Any

from switch_core.bridges.agent.server_connectors.agui.events import MalformedEventError


class SseDecoder:
    """Feed arbitrary text chunks, get back complete frame payloads.

    Holds whatever trailing partial frame it has seen, so callers can pass
    network reads straight in without aligning them to anything.
    """

    def __init__(self) -> None:
        self._buffer = ""
        self._data_lines: list[str] = []

    def feed(self, chunk: str) -> list[str]:
        """Consume a chunk and return the payloads of any frames it completed."""
        self._buffer += chunk
        payloads: list[str] = []

        while True:
            index = self._buffer.find("\n")
            if index == -1:
                break
            line = self._buffer[:index]
            self._buffer = self._buffer[index + 1 :]
            payload = self._consume_line(line.rstrip("\r"))
            if payload is not None:
                payloads.append(payload)

        return payloads

    def close(self) -> list[str]:
        """Flush a final frame that the stream ended without a blank line after.

        A well-behaved producer terminates the last frame, but a stream that is
        cut mid-flight may not. Returning what was buffered lets the caller see
        the partial run rather than losing it silently; whether a run that ends
        this way is acceptable is decided above, not here.
        """
        payloads: list[str] = []
        if self._buffer:
            payload = self._consume_line(self._buffer.rstrip("\r"))
            if payload is not None:
                payloads.append(payload)
            self._buffer = ""

        final = self._flush()
        if final is not None:
            payloads.append(final)
        return payloads

    def _consume_line(self, line: str) -> str | None:
        if not line:
            return self._flush()

        if line.startswith(":"):
            return None

        field, _, value = line.partition(":")
        if field != "data":
            return None

        self._data_lines.append(value[1:] if value.startswith(" ") else value)
        return None

    def _flush(self) -> str | None:
        if not self._data_lines:
            return None
        payload = "\n".join(self._data_lines)
        self._data_lines = []
        return payload


def decode_json_frame(payload: str) -> Any:
    """Parse one frame payload, raising rather than skipping on bad JSON."""
    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        raise MalformedEventError(f"AG-UI frame is not valid JSON: {exc}") from exc
