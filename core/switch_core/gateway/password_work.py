from __future__ import annotations

import asyncio
import hashlib
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

from fastapi import HTTPException

_WORKERS = ThreadPoolExecutor(max_workers=2, thread_name_prefix="password")
_SLOTS = threading.BoundedSemaphore(2)
_ATTEMPTS: OrderedDict[str, tuple[float, int]] = OrderedDict()
_LOCK = threading.Lock()
_WINDOW_SECONDS = 60
_MAX_ATTEMPTS = 10
_MAX_ACCOUNTS = 4096


def check_login_rate(email: str) -> None:
    # shortcut: limits are per process; use a shared ingress limit for a deployment-wide cap.
    now = time.monotonic()
    key = hashlib.sha256(email.strip().casefold().encode()).hexdigest()
    with _LOCK:
        while _ATTEMPTS and next(iter(_ATTEMPTS.values()))[0] <= now:
            _ATTEMPTS.popitem(last=False)
        expires, count = _ATTEMPTS.get(key, (now + _WINDOW_SECONDS, 0))
        if count >= _MAX_ATTEMPTS or (
            key not in _ATTEMPTS and len(_ATTEMPTS) >= _MAX_ACCOUNTS
        ):
            raise HTTPException(
                status_code=429,
                detail="Too many sign-in attempts. Try again later.",
                headers={"Retry-After": str(max(1, math.ceil(expires - now)))},
            )
        _ATTEMPTS[key] = (expires, count + 1)


async def password_work[T](work: Callable[..., T], *args: object) -> T:
    if not _SLOTS.acquire(blocking=False):
        raise HTTPException(
            status_code=429,
            detail="Password service is busy. Try again shortly.",
            headers={"Retry-After": "1"},
        )
    try:
        future = _WORKERS.submit(work, *args)
    except BaseException:
        _SLOTS.release()
        raise
    # A cancelled HTTP request must not free a slot while bcrypt is still running.
    future.add_done_callback(lambda _: _SLOTS.release())
    return await asyncio.wrap_future(future)
