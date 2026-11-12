"""The Switch operator list.

A short list of named people, by user id, in a file Core reads. Nothing else
makes someone an operator: not workspace ownership, and not the deployment bit
`users.role == "admin"`, which carries full workspace access, content included.
Nobody should hold both; Core warns at start if anyone does
(`warn_if_operators_hold_admin`).

The file follows the key's rule: a regular file (not a link), owned by Core's
user, with no group or other permission bits. It is read again whenever it
changes (by inode, size, and modified and change times), so a removal takes effect on the very next
request, with no restart. Anything wrong with the file means **no operators**,
and one error line: the list fails closed.

File shape: `{"operators": ["<user id>", ...]}`. At most 100 entries.
"""

from __future__ import annotations

import json
import logging
import os
import stat
import threading
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.tenant_context import no_tenant

logger = logging.getLogger(__name__)

MAX_OPERATORS = 100
MAX_FILE_BYTES = 64 * 1024
_MAX_ID = 128


@dataclass(frozen=True)
class OperatorSnapshot:
    """The list as last read, and the file state it was read at."""

    ids: frozenset[str]
    # (inode, size, mtime_ns, ctime_ns); None when unreadable. The inode and
    # ctime catch a same-size rewrite or a file swapped in by rename.
    stamp: tuple[int, int, int, int] | None


class OperatorList:
    def __init__(self, path: str | Path | None) -> None:
        self._path = Path(path) if path is not None else None
        self._lock = threading.Lock()
        self._snapshot = OperatorSnapshot(frozenset(), None)
        self._last_error: str | None = None

    def snapshot(self) -> OperatorSnapshot:
        """The current list, re-reading the file only if it changed."""
        if self._path is None:
            return self._snapshot
        try:
            info = self._path.lstat()
            stamp: tuple[int, int, int, int] | None = (
                info.st_ino,
                info.st_size,
                info.st_mtime_ns,
                info.st_ctime_ns,
            )
        except OSError:
            stamp = None
        with self._lock:
            if stamp is not None and stamp == self._snapshot.stamp:
                return self._snapshot
            self._snapshot = self._read(stamp)
            return self._snapshot

    def is_operator(self, user_id: str | None) -> bool:
        return user_id is not None and user_id in self.snapshot().ids

    def _read(self, stamp: tuple[int, int, int, int] | None) -> OperatorSnapshot:
        assert self._path is not None
        try:
            ids = _parse(self._path)
        except (OSError, ValueError) as exc:
            reason = str(exc)
            if reason != self._last_error:
                logger.error(
                    "The Switch operator list can't be used, so nobody is an "
                    "operator until it is fixed",
                    extra={"reason": reason},
                )
                self._last_error = reason
            return OperatorSnapshot(frozenset(), stamp)
        self._last_error = None
        return OperatorSnapshot(ids, stamp)


def _parse(path: Path) -> frozenset[str]:
    # O_NOFOLLOW and fstat on the open file, as the key does, so the file
    # checked is the file read. A link fails to open (ELOOP).
    fd = os.open(
        path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
    )
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("the operator list is not a regular file")
        if info.st_uid != os.getuid():
            raise ValueError("the operator list is not owned by Core's user")
        if info.st_mode & 0o077:
            raise ValueError("the operator list can be read or changed by others")
        if info.st_size > MAX_FILE_BYTES:
            raise ValueError("the operator list is too large")
        raw = handle.read(MAX_FILE_BYTES + 1)
    if len(raw) > MAX_FILE_BYTES:
        raise ValueError("the operator list is too large")
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict) or set(data) != {"operators"}:
        raise ValueError('the operator list must be {"operators": [...]}')
    entries = data["operators"]
    if not isinstance(entries, list) or len(entries) > MAX_OPERATORS:
        raise ValueError(f"operators must be a list of at most {MAX_OPERATORS}")
    ids: set[str] = set()
    for entry in entries:
        if (
            not isinstance(entry, str)
            or not entry
            or len(entry) > _MAX_ID
            or entry != entry.strip()
        ):
            raise ValueError("each operator must be a user id")
        ids.add(entry)
    return frozenset(ids)


async def operators_holding_admin(
    session_factory: async_sessionmaker[AsyncSession], operators: OperatorList
) -> frozenset[str]:
    """The listed operators who also hold `users.role == "admin"`."""
    ids = operators.snapshot().ids
    if not ids:
        return frozenset()
    with no_tenant():
        async with session_factory() as session:
            rows = await session.execute(
                select(User.id).where(User.id.in_(ids), User.role == "admin")
            )
            return frozenset(rows.scalars().all())


async def warn_if_operators_hold_admin(
    session_factory: async_sessionmaker[AsyncSession], operators: OperatorList
) -> None:
    """One WARN at start if anyone is both an operator and a deployment admin:
    the admin bit's workspace-wide access would undo the operators' ids-only
    rule. Counts only, never the ids."""
    both = await operators_holding_admin(session_factory, operators)
    if both:
        logger.warning(
            "Some Switch operators also hold the deployment admin role, which "
            "gives full workspace access; keep the two apart",
            extra={"count": len(both)},
        )
