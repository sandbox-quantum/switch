"""The structured detail a session host may attach to a tool step and to an
approval: the tool call (its name and input) and, once the tool finished, what
came back.

Stored as the host sent it, once it fits this shape and the size cap: a
client app draws a card from it, so a malformed blob is refused at the door
rather than handed to every reader. Over the cap the report is refused too,
not cut here: only the host knows which part is worth keeping, so it trims
long strings itself and says so with `truncated`.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from switch_core.sessions.errors import SessionError

# Of the compact JSON, in UTF-8 bytes.
MAX_DETAIL_BYTES = 64 * 1024
MAX_TOOL_NAME_CHARS = 200
MAX_PLAN_CHARS = 64_000


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=False)


class ToolCall(_Strict):
    name: str = Field(min_length=1, max_length=MAX_TOOL_NAME_CHARS)
    input: dict[str, Any]


class ToolResult(_Strict):
    is_error: bool = Field(alias="isError", strict=True)
    text: str | None = None
    stdout: str | None = None
    stderr: str | None = None
    diff: str | None = None
    files: list[str] | None = None


class ToolDetail(_Strict):
    tool: ToolCall
    # Absent while the tool runs.
    result: ToolResult | None = None
    truncated: bool = Field(default=False, strict=True)


def _fitted(model: type[BaseModel], raw: object, what: str) -> dict[str, Any]:
    try:
        parsed = model.model_validate(raw)
    except ValidationError as exc:
        raise SessionError("INVALID_EVENT", f"Malformed {what}: {exc}") from None
    stored = parsed.model_dump(mode="json", by_alias=True, exclude_none=True)
    size = len(json.dumps(stored, separators=(",", ":")).encode())
    if size > MAX_DETAIL_BYTES:
        raise SessionError(
            "INVALID_EVENT",
            f"A {what} is at most {MAX_DETAIL_BYTES} bytes of JSON; this one is "
            f"{size}. Trim it and set truncated.",
        )
    return stored


def stored_tool_detail(raw: object) -> dict[str, Any]:
    """`raw` as stored on a tool step: `{"tool": {"name", "input"}, "result"?:
    {"isError", "text"?, "stdout"?, "stderr"?, "diff"?, "files"?},
    "truncated"}`. Raises `INVALID_EVENT` when it does not fit."""
    return _fitted(ToolDetail, raw, "tool detail")


def stored_tool_call(raw: object) -> dict[str, Any]:
    """`raw` as stored on an approval: `{"name", "input"}`."""
    return _fitted(ToolCall, raw, "tool call")
