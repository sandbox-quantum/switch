"""The team survey and the license acceptance, kept on the person, end to end.

Real HTTP against real Postgres, read back through a session that shares
nothing with the request's, as `test_change_password.py` does: a write that
was never committed cannot pass.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.license_acceptance import router as license_router
from switch_core.gateway.team_survey import router as team_survey_router
from switch_core.keys import Keyring

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
_USER_STORE = UserStore()
_REPO = Path(__file__).resolve().parents[4]

_ANSWERS = {
    "company_size": "11-50",
    "role": "Platform / DevOps",
    "agent_count": "6-20",
    "use_cases": ["Coding agents for my team", "Internal tools"],
}


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(team_survey_router)
    app.include_router(license_router)
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: _USER_STORE
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING, gateway_tenant_choice_enabled=False
    )
    return app


async def _seed_user(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        user = User(
            name="Ada", email=f"{secrets.token_hex(4)}@example.invalid", role="user"
        )
        await _USER_STORE.create(session, user)
        await session.commit()
        return user.id


async def _stored(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> User:
    async with session_factory() as session:
        user = await _USER_STORE.get(session, user_id)
        assert user is not None
        return user


def _client(app: FastAPI, user_id: str | None) -> httpx.AsyncClient:
    cookies = {}
    if user_id is not None:
        cookies["switch_auth"] = create_jwt(
            user_id,
            "ada@example.invalid",
            "user",
            _KEYRING,
            None,
            session_version=0,
            auth_time=datetime.now(UTC),
            session_id=secrets.token_urlsafe(16),
        )
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", cookies=cookies
    )


class TestTeamSurvey:
    async def test_offers_the_choices_and_no_answers_before_any(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory)
        async with _client(_app(session_factory), user_id) as client:
            response = await client.get("/auth/me/team-survey")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["answers"] is None
        assert body["answered_at"] is None
        assert body["choices"]["company_size"] == [
            "1-10",
            "11-50",
            "51-200",
            "201-1,000",
            "1,000+",
        ]
        assert "Security / Compliance" in body["choices"]["role"]
        assert body["choices"]["agent_count"][-1] == "100+"
        assert "Agents in Slack or Teams" in body["choices"]["use_cases"]

    async def test_keeps_the_answers_on_the_person(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory)
        app = _app(session_factory)
        async with _client(app, user_id) as client:
            saved = await client.put("/auth/me/team-survey", json=_ANSWERS)
        assert saved.status_code == 200, saved.text

        stored = await _stored(session_factory, user_id)
        assert stored.team_survey == _ANSWERS
        assert stored.team_survey_answered_at is not None

        async with _client(app, user_id) as client:
            read = (await client.get("/auth/me/team-survey")).json()
        assert read["answers"] == _ANSWERS
        assert read["answered_at"] is not None

    async def test_refuses_an_answer_that_is_not_a_choice_and_keeps_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory)
        refused = [
            {**_ANSWERS, "company_size": "5000"},
            {**_ANSWERS, "role": "Astronaut"},
            {**_ANSWERS, "agent_count": "0"},
            {**_ANSWERS, "use_cases": []},
            {**_ANSWERS, "use_cases": ["Mining"]},
            {**_ANSWERS, "use_cases": ["Internal tools", "Internal tools"]},
            {key: value for key, value in _ANSWERS.items() if key != "role"},
        ]
        async with _client(_app(session_factory), user_id) as client:
            for body in refused:
                response = await client.put("/auth/me/team-survey", json=body)
                assert response.status_code == 422, body
        assert (await _stored(session_factory, user_id)).team_survey is None

    async def test_refuses_a_caller_who_is_not_signed_in(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with _client(_app(session_factory), None) as client:
            assert (await client.get("/auth/me/team-survey")).status_code == 401
            put = await client.put("/auth/me/team-survey", json=_ANSWERS)
            assert put.status_code == 401


class TestLicense:
    async def test_serves_the_repository_license_and_a_digest_of_it_without_a_session(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        text = (_REPO / "LICENSE").read_text()
        async with _client(_app(session_factory), None) as client:
            response = await client.get("/license")
        assert response.status_code == 200, response.text
        assert response.json() == {
            "version": hashlib.sha256(text.encode()).hexdigest()[:16],
            "text": text,
        }
        assert text.startswith("Software: Agent Switch")

    async def test_records_who_accepted_which_version_and_when(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory)
        app = _app(session_factory)
        async with _client(app, user_id) as client:
            version = (await client.get("/license")).json()["version"]
            before = (await client.get("/auth/me/license")).json()
            accepted = await client.put("/auth/me/license", json={"version": version})
        assert before == {
            "version": version,
            "accepted_version": None,
            "accepted_at": None,
        }
        assert accepted.status_code == 200, accepted.text

        stored = await _stored(session_factory, user_id)
        assert stored.license_accepted_version == version
        assert stored.license_accepted_at is not None

        async with _client(app, user_id) as client:
            after = (await client.get("/auth/me/license")).json()
        assert after["accepted_version"] == version
        assert after["accepted_at"] is not None

    async def test_refuses_a_version_that_is_not_the_current_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory)
        async with _client(_app(session_factory), user_id) as client:
            response = await client.put("/auth/me/license", json={"version": "older"})
        assert response.status_code == 409
        assert "has changed" in response.json()["detail"]
        assert (
            await _stored(session_factory, user_id)
        ).license_accepted_version is None

    def test_the_server_image_ships_the_license(self) -> None:
        dockerfile = _REPO / "deploy/shared_resources/images/Dockerfile.switch"
        assert "\nCOPY LICENSE ./\n" in dockerfile.read_text()
