from __future__ import annotations

import asyncio
import secrets
import threading
from collections import OrderedDict

import httpx
import pytest
from fastapi import HTTPException

from switch_core.gateway import password_work
from tests.switch_core.gateway.test_change_password import _app, _seed_user


@pytest.fixture(autouse=True)
def fresh_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(password_work, "_ATTEMPTS", OrderedDict())


async def test_login_returns_429_before_another_password_check(session_factory) -> None:
    password = secrets.token_urlsafe(18)
    await _seed_user(session_factory, email="login@example.test", password=password)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)), base_url="http://test"
    ) as client:
        for _ in range(10):
            response = await client.post(
                "/auth/login",
                json={"email": "login@example.test", "password": password + "wrong"},
            )
            assert response.status_code == 401
        response = await client.post(
            "/auth/login", json={"email": "LOGIN@example.test", "password": password}
        )
        assert response.status_code == 429
        assert int(response.headers["Retry-After"]) > 0


def test_login_window_expires_and_does_not_grow_without_bound(monkeypatch) -> None:
    now = [100.0]
    monkeypatch.setattr(password_work.time, "monotonic", lambda: now[0])
    for _ in range(10):
        password_work.check_login_rate("account@example.test")
    with pytest.raises(HTTPException) as refused:
        password_work.check_login_rate("ACCOUNT@example.test")
    assert refused.value.status_code == 429
    now[0] += 60
    password_work.check_login_rate("account@example.test")
    assert len(password_work._ATTEMPTS) == 1
    for n in range(4095):
        password_work.check_login_rate(f"account-{n}@example.test")
    with pytest.raises(HTTPException):
        password_work.check_login_rate("another@example.test")
    assert len(password_work._ATTEMPTS) == 4096
    with pytest.raises(HTTPException) as full:
        password_work.check_login_rate("new@example.test")
    assert full.value.status_code == 429
    assert len(password_work._ATTEMPTS) == 4096
    password_work.check_login_rate("account@example.test")


async def test_password_workers_stay_bounded_after_request_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    slots = threading.BoundedSemaphore(1)
    monkeypatch.setattr(password_work, "_SLOTS", slots)
    entered = threading.Event()
    release = threading.Event()

    def work() -> bool:
        entered.set()
        assert release.wait(5)
        return True

    task = asyncio.create_task(password_work.password_work(work))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        with pytest.raises(HTTPException) as busy:
            await password_work.password_work(lambda: True)
        assert busy.value.status_code == 429
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        with pytest.raises(HTTPException):
            await password_work.password_work(lambda: True)
    finally:
        release.set()
    for _ in range(100):
        if slots.acquire(blocking=False):
            slots.release()
            break
        await asyncio.sleep(0.01)
    assert await password_work.password_work(lambda: True)
