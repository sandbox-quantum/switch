"""Your cloud files: the owner lists, previews and downloads the files on their
own hosted box. Read-only.

Three routes, all the signed-in user's own box only:

- `GET /cloud-files/list?path=&cursor=`: one page of a folder (at most 1,000
  entries; top-level folders carry the agent's name, or "Shared");
- `GET /cloud-files/content?path=&offset=`: one 128 KiB chunk of a file from
  `offset`, as `206` with `Content-Range: bytes a-b/total` (the client asks
  for the next range itself); an offset at or past the end is `416` with
  `Content-Range: bytes */total`, an empty file `200` with no body, and a file
  over 25 MB `413 too_large` before any bytes;
- `GET /cloud-files/zip?path=&caches=0|1`: a folder as a zip, streamed one
  chunk at a time, each asked for only once the last has been sent on.

The box is the user's own live machine bound to this workspace, and the
controller is that machine's *current* one, read here: no machine or
controller id comes from the client, and there are no admin or operator
routes. The path is checked here only for its shape; the box's launcher is the
authority on what it may read (`agent-controller-box`, the file reader).

Nothing is stored or cached: each chunk goes from the controller's socket to
the response (`file_requests.py`). File responses carry the same
headers as chat attachments (`untrusted_file_headers`). Every request and every
refusal writes one audit line, never any content.

Behind `hosted_cloud_files`, off by default, and only with hosted agents v2 on.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.content_disposition import (
    content_disposition,
    untrusted_file_headers,
)
from switch_core.db.models import AgentController, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_machine_store import (
    CloudMachineStore,
    idle_sleeping,
    workspace_on,
)
from switch_core.file_requests import (
    BadReply,
    FileReply,
    FileRequest,
    file_requests,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
)
from switch_core.hosted_v2 import hosted_v2_on
from switch_core.tenant_context import current_tenant_id

router = APIRouter(prefix="/cloud-files")

audit = logging.getLogger("switch_core.cloud_files.audit")

# The path's shape, as security bounded it; the launcher checks the rest.
MAX_PATH_BYTES = 4096
MAX_PATH_PARTS = 64
# How long one chunk or page may take, and a whole zip (the controller's own
# deadlines are the same: 30 s and 10 minutes).
CHUNK_TIMEOUT = 30.0
ZIP_TIMEOUT = 600.0
# The largest file the content route serves; bigger ones download as a zip.
MAX_FILE_BYTES = 25 * 1024 * 1024
# How often browsing may move a box's `active_at` on.
ACTIVE_EVERY = timedelta(seconds=60)
# Requests a user may make across the three routes, per minute.
RATE_PER_MINUTE = 240

_STATUS = {
    "outside_root": 403,
    "denied": 403,
    "not_found": 404,
    "too_large": 413,
    "not_regular": 415,
    "failed": 500,
    "bad_request": 400,
    "busy": 429,
    "timeout": 504,
}


class _Refused(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def _refusal(error: _Refused, retry: bool = False) -> JSONResponse:
    return JSONResponse(
        {"detail": {"code": error.code}},
        status_code=error.status,
        headers={"Retry-After": "1"} if retry else None,
    )


# ── Checks ───────────────────────────────────────────────────────────────


def checked_path(path: str) -> str:
    """The box-relative path, if its shape is acceptable; `bad_path` if not.

    "" is the root. No absolute path, no NUL, no empty, `.` or `..` part, and
    within the size and depth bounds. A backslash is refused too, so no part
    can smuggle a separator the launcher might read differently.
    """
    if path == "":
        return path
    raw = path.encode("utf-8", "surrogatepass")
    parts = path.split("/")
    if (
        len(raw) > MAX_PATH_BYTES
        or len(parts) > MAX_PATH_PARTS
        or "\x00" in path
        or "\\" in path
        or path.startswith("/")
        or any(part in ("", ".", "..") for part in parts)
    ):
        raise _Refused(400, "bad_path")
    return path


class _Rate:
    """Requests per user in the last minute, in this process (one replica)."""

    def __init__(self, per_minute: int) -> None:
        self._per_minute = per_minute
        self._seen: defaultdict[str, deque[float]] = defaultdict(deque)

    def take(self, user_id: str) -> None:
        now = time.monotonic()
        seen = self._seen[user_id]
        while seen and now - seen[0] > 60.0:
            seen.popleft()
        if len(seen) >= self._per_minute:
            raise _Refused(429, "busy")
        seen.append(now)


rate = _Rate(RATE_PER_MINUTE)


async def _box(
    session: AsyncSession, user: User, config: SwitchConfig
) -> tuple[str, str]:
    """The user's own box and its current controller: `(machine_id, controller_id)`.

    `no_files` when the feature is off or the user has no box here;
    `box_resting` when the box isn't running or its controller is gone;
    `files_elsewhere` when another process holds the controller's socket.
    """
    if not (config.hosted_cloud_files_enabled and hosted_v2_on(config)):
        raise _Refused(404, "no_files")
    machine = await CloudMachineStore().live_for_owner(session, user.id)
    workspace = None if machine is None else await workspace_on(session, machine.id)
    if (
        machine is None
        or workspace is None
        or machine.backend != "box"
        or workspace.controller_id is None
    ):
        raise _Refused(404, "no_files")
    controller_id = workspace.controller_id
    if file_requests.holds(controller_id):
        await _mark_active(session, machine.id)
        return machine.id, controller_id
    if (
        machine.state != "ready"
        or machine.desired_state != "running"
        or idle_sleeping(machine)
    ):
        raise _Refused(409, "box_resting")
    controller = await session.get(AgentController, controller_id)
    if (
        controller is None
        or controller.revoked_at is not None
        or controller.connected_at is None
        or controller.disconnected_at is not None
    ):
        raise _Refused(409, "box_resting")
    raise _Refused(503, "files_elsewhere")


async def _mark_active(session: AsyncSession, machine_id: str) -> None:
    """Browsing counts as the box being in use, so it doesn't fall asleep
    mid-browse: `active_at` moves on, as an addressed message moves it, and the
    awake budget counts it the same. It never wakes a box (only Console's
    explicit "Wake it" does), and it's written at most once a minute per box,
    not once per chunk."""
    now = datetime.now(UTC)
    store = CloudMachineStore()
    machine = await store.get(session, machine_id)
    if (
        machine is None
        or machine.desired_state != "running"
        or now - machine.active_at < ACTIVE_EVERY
    ):
        return
    machine = await store.locked(session, machine_id)
    if machine is not None and machine.desired_state == "running":
        machine.active_at = now
    await session.commit()


def _failed(reply: FileReply) -> _Refused | None:
    if reply.error is None:
        return None
    return _Refused(_STATUS.get(reply.error, 502), reply.error)


def _audit(
    user: User,
    machine_id: str | None,
    op: str,
    path: str,
    status: int,
    sent: int,
    began: float,
) -> None:
    audit.info(
        "cloud_files user=%s machine=%s op=%s path=%r status=%s bytes=%s ms=%d",
        user.id,
        machine_id or "-",
        op,
        path[:MAX_PATH_BYTES],
        status,
        sent,
        (time.monotonic() - began) * 1000,
    )


async def _first(request: FileRequest, timeout: float) -> FileReply:
    try:
        reply = await request.reply(timeout)
    except TimeoutError:
        raise _Refused(504, "timeout") from None
    except BadReply as bad:
        raise _Refused(
            502, "bad_reply" if str(bad) != "socket_closed" else "box_resting"
        ) from None
    failure = _failed(reply)
    if failure is not None:
        raise failure
    return reply


# ── Routes ───────────────────────────────────────────────────────────────


# A listing or a file's bytes may be read by Switch's own pages only: another site can't
# embed them (an <img>, a <script>, a fetch with no-cors), even with the
# person's cookie. Their Lax session cookie already keeps a cross-site page
# from reading them; this keeps it from embedding them too (Switch web).
SAME_ORIGIN_ONLY = {"Cross-Origin-Resource-Policy": "same-origin"}


@router.get("/list")
async def list_files(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    path: Annotated[str, Query(max_length=MAX_PATH_BYTES)] = "",
    cursor: Annotated[str | None, Query(max_length=1024)] = None,
) -> Response:
    began, machine_id = time.monotonic(), None
    try:
        rate.take(user.id)
        path = checked_path(path)
        machine_id, controller_id = await _box(session, user, config)
        request = _open(controller_id, "list", path, cursor=cursor)
        try:
            reply = await _first(request, CHUNK_TIMEOUT)
        finally:
            file_requests.close(request, cancel=False)
    except _Refused as refused:
        _audit(user, machine_id, "list", path, refused.status, 0, began)
        return _refusal(refused, retry=refused.code == "files_elsewhere")
    body: dict[str, Any] = {
        "entries": [
            entry.model_dump(exclude_none=True) for entry in reply.entries or []
        ],
        "cursor": reply.cursor,
    }
    _audit(user, machine_id, "list", path, 200, 0, began)
    return JSONResponse(
        body, headers={"Cache-Control": "private, no-store", **SAME_ORIGIN_ONLY}
    )


@router.get("/content")
async def file_content(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    path: Annotated[str, Query(max_length=MAX_PATH_BYTES)],
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Response:
    began, machine_id = time.monotonic(), None
    try:
        rate.take(user.id)
        path = checked_path(path)
        if path == "":
            raise _Refused(400, "bad_path")
        machine_id, controller_id = await _box(session, user, config)
        request = _open(controller_id, "read", path, offset=offset)
        try:
            reply = await _first(request, CHUNK_TIMEOUT)
        finally:
            file_requests.close(request, cancel=False)
        chunk = reply.chunk()
        total = reply.size
        if total is None:
            raise _Refused(502, "bad_reply")
        if total > MAX_FILE_BYTES:
            raise _Refused(413, "too_large")
    except _Refused as refused:
        _audit(user, machine_id, "read", path, refused.status, 0, began)
        return _refusal(refused, retry=refused.code == "files_elsewhere")
    name = path.rsplit("/", 1)[-1]
    headers = {
        "Cache-Control": "private, no-store",
        **untrusted_file_headers(name, None, "file"),
        **SAME_ORIGIN_ONLY,
    }
    if total == 0 and offset == 0:
        # An empty file: no range to name.
        _audit(user, machine_id, "read", path, 200, 0, began)
        return Response(
            content=b"", media_type="application/octet-stream", headers=headers
        )
    if offset >= total or not chunk or offset + len(chunk) > total:
        _audit(user, machine_id, "read", path, 416, 0, began)
        return Response(
            status_code=416,
            media_type="application/octet-stream",
            headers={**headers, "Content-Range": f"bytes */{total}"},
        )
    _audit(user, machine_id, "read", path, 206, len(chunk), began)
    return Response(
        content=chunk,
        status_code=206,
        media_type="application/octet-stream",
        headers={
            **headers,
            "Content-Range": f"bytes {offset}-{offset + len(chunk) - 1}/{total}",
        },
    )


@router.get("/zip")
async def folder_zip(
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    factory: Annotated[Any, Depends(get_session_factory)],
    path: Annotated[str, Query(max_length=MAX_PATH_BYTES)] = "",
    caches: Annotated[int, Query(ge=0, le=1)] = 0,
) -> Response:
    began, machine_id = time.monotonic(), None
    files: FileRequest | None = None
    try:
        rate.take(user.id)
        path = checked_path(path)
        machine_id, controller_id = await _box(session, user, config)
        files = _open(controller_id, "zip", path, caches=bool(caches))
        first = await _first(files, CHUNK_TIMEOUT)
    except _Refused as refused:
        if files is not None:
            file_requests.close(files, cancel=True)
        _audit(user, machine_id, "zip", path, refused.status, 0, began)
        return _refusal(refused, retry=refused.code == "files_elsewhere")

    zipping = files
    zip_machine = cast(str, machine_id)
    # The caller's workspace, bound by sign-in, taken now: the zip streams
    # after this function returns, so each mark opens its own session bound to
    # it (`tenant_session`), not a bare one from the factory.
    zip_tenant = current_tenant_id()

    async def chunks() -> AsyncIterator[bytes]:
        sent, status, reply = 0, 200, first
        deadline = began + ZIP_TIMEOUT
        marked = time.monotonic()
        try:
            while True:
                data = reply.chunk()
                sent += len(data)
                yield data
                if reply.last:
                    return
                if await request.is_disconnected():
                    status = 499
                    return
                if (
                    zip_tenant is not None
                    and time.monotonic() - marked >= ACTIVE_EVERY.total_seconds()
                ):
                    # A long zip keeps the box awake too, pull by pull.
                    async with tenant_session(factory, zip_tenant) as marking:
                        await _mark_active(marking, zip_machine)
                    marked = time.monotonic()
                zipping.more()
                try:
                    reply = await _first(
                        zipping, min(CHUNK_TIMEOUT, deadline - time.monotonic())
                    )
                except _Refused as refused:
                    # Headers are gone: the client sees a cut-short download.
                    status = refused.status
                    return
        finally:
            file_requests.close(zipping, cancel=status != 200 or not reply.last)
            _audit(user, machine_id, "zip", path, status, sent, began)

    name = (path.rsplit("/", 1)[-1] or "cloud-files") + ".zip"
    return StreamingResponse(
        chunks(),
        media_type="application/zip",
        headers={
            "Cache-Control": "private, no-store",
            **untrusted_file_headers(name, None, "cloud-files"),
            **SAME_ORIGIN_ONLY,
            "Content-Disposition": content_disposition(
                "attachment", name, "cloud-files"
            ),
        },
    )


def _open(controller_id: str, op: str, path: str, **args: Any) -> FileRequest:
    try:
        return file_requests.open(controller_id, op, path, **args)  # type: ignore[arg-type]
    except LookupError:
        # The socket went between the check and now.
        raise _Refused(409, "box_resting") from None
    except OverflowError:
        raise _Refused(429, "busy") from None


__all__ = ["checked_path", "router"]
