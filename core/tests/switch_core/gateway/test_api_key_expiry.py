"""A registration key made in the dashboard expires: after 90 days unless its
owner chooses up to a year, or explicitly never."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ApiKey, AuditEvent
from tests.switch_core.gateway.test_api_keys_hash_only import _app
from tests.switch_core.management.harness import add_member, cookies_for


async def _create(
    session_factory: async_sessionmaker[AsyncSession], body: dict
) -> httpx.Response:
    owner = await add_member(session_factory, "keymaker")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)),
        base_url="http://test",
        cookies=cookies_for(owner),
    ) as client:
        return await client.post("/api-keys", json=body)


async def _stored_expiry(
    session_factory: async_sessionmaker[AsyncSession], key_id: str
) -> datetime | None:
    async with session_factory() as session:
        return await session.scalar(
            select(ApiKey.expires_at).where(ApiKey.id == key_id)
        )


@pytest.mark.parametrize(
    ("body", "days"),
    [
        ({"label": "default"}, 90),
        ({"label": "a year", "expires_in_days": 365}, 365),
        ({"label": "a day", "expires_in_days": 1}, 1),
    ],
)
async def test_a_new_key_expires_after_its_lifetime(
    session_factory: async_sessionmaker[AsyncSession], body: dict, days: int
) -> None:
    before = datetime.now(UTC)
    created = await _create(session_factory, body)

    assert created.status_code == 200, created.text
    stored = await _stored_expiry(session_factory, created.json()["id"])
    assert stored is not None
    assert (
        before + timedelta(days=days)
        <= stored
        <= datetime.now(UTC) + timedelta(days=days)
    )
    assert datetime.fromisoformat(created.json()["expires_at"]) == stored


async def test_a_key_can_be_made_to_never_expire(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    created = await _create(
        session_factory, {"label": "forever", "expires_in_days": "never"}
    )

    assert created.status_code == 200, created.text
    assert created.json()["expires_at"] is None
    assert await _stored_expiry(session_factory, created.json()["id"]) is None
    async with session_factory() as session:
        details = await session.scalar(
            select(AuditEvent.details).where(
                AuditEvent.target_id == created.json()["id"]
            )
        )
    assert details == {"label": "forever", "type": "registration", "expires_at": None}


@pytest.mark.parametrize("lifetime", [0, -1, 366, "forever", None])
async def test_a_lifetime_outside_a_year_is_refused(
    session_factory: async_sessionmaker[AsyncSession], lifetime: object
) -> None:
    created = await _create(
        session_factory, {"label": "too long", "expires_in_days": lifetime}
    )

    assert created.status_code == 422, created.text
    async with session_factory() as session:
        assert await session.scalar(select(ApiKey.id)) is None


async def test_the_list_shows_each_keys_expiry(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    owner = await add_member(session_factory, "lister")
    expiry = datetime(2027, 2, 4, 12, tzinfo=UTC)
    async with session_factory() as session:
        session.add_all(
            [
                ApiKey(
                    user_id=owner.id,
                    key_hash="expiring",
                    encrypted_key="enc",
                    label="expiring",
                    type="registration",
                    expires_at=expiry,
                ),
                ApiKey(
                    user_id=owner.id,
                    key_hash="lasting",
                    encrypted_key="enc",
                    label="lasting",
                    type="agent",
                ),
            ]
        )
        await session.commit()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)),
        base_url="http://test",
        cookies=cookies_for(owner),
    ) as client:
        listed = await client.get("/api-keys")

    assert listed.status_code == 200, listed.text
    expiries = {key["label"]: key["expires_at"] for key in listed.json()}
    assert expiries["lasting"] is None
    assert datetime.fromisoformat(expiries["expiring"]) == expiry
