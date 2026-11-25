"""Onboarding's two records: the license accepted before an organization is
created, and what its creator says about it.

Against Postgres, through the real routes.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import LicenseAcceptance, Organization
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.licenses import LICENSE_FIRST
from tests.switch_core.gateway.test_organization_routes import (
    _KEYRING,
    _app,
    _client,
    _user,
    _workspaces_created,
)
from tests.switch_core.gateway.test_tenant_resolution import _session_app

VERSION = "2026-11"


def _config(license_version: str | None) -> SimpleNamespace:
    return SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_tenant_choice_enabled=False,
        gateway_signup_mode="open",
        gateway_max_workspaces_per_user=3,
        invite_email_enabled=False,
        gateway_license_version=license_version,
        organizations_created_in_directory=False,
    )


def _apps(
    session_factory: async_sessionmaker[AsyncSession], license_version: str | None
) -> tuple[FastAPI, FastAPI]:
    """The session and license routes, and the organization routes, as one
    server configured with `license_version` has them."""
    session_app = _session_app(session_factory, signup_mode="open")
    organizations_app = _app(session_factory)
    for app in (session_app, organizations_app):
        app.dependency_overrides[gw_deps.get_config] = lambda: _config(license_version)
    return session_app, organizations_app


async def _accepted(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> list[str]:
    async with session_factory() as session:
        return list(
            await session.scalars(
                select(LicenseAcceptance.version).where(
                    LicenseAcceptance.user_id == user_id
                )
            )
        )


class TestTheLicense:
    async def test_none_is_asked_for_where_no_version_is_set(
        self, session_factory
    ) -> None:
        ada = await _user(session_factory, "user")
        session_app, organizations_app = _apps(session_factory, None)

        async with _client(session_app, ada, None) as client:
            state = await client.get("/auth/session")
            accepted = await client.post("/auth/license", json={"version": VERSION})
        async with _client(organizations_app, ada, None) as client:
            created = await client.post("/organizations", json={"name": "Acme"})

        assert state.json()["license_to_accept"] is None
        assert accepted.status_code == 404
        assert created.status_code == 201, created.text

    async def test_an_organization_waits_for_it_and_is_created_once_accepted(
        self, session_factory
    ) -> None:
        ada = await _user(session_factory, "user")
        session_app, organizations_app = _apps(session_factory, VERSION)

        async with _client(organizations_app, ada, None) as client:
            refused = await client.post("/organizations", json={"name": "Acme"})
        async with _client(session_app, ada, None) as client:
            asked = (await client.get("/auth/session")).json()["license_to_accept"]
            accepted = await client.post("/auth/license", json={"version": VERSION})
            again = await client.post("/auth/license", json={"version": VERSION})
            after = (await client.get("/auth/session")).json()["license_to_accept"]
        async with _client(organizations_app, ada, None) as client:
            created = await client.post("/organizations", json={"name": "Acme"})

        assert refused.status_code == 409
        assert refused.json()["detail"] == LICENSE_FIRST
        assert asked == VERSION
        assert (accepted.status_code, again.status_code) == (204, 204)
        assert after is None
        assert await _accepted(session_factory, ada) == [VERSION]
        assert created.status_code == 201, created.text
        assert await _workspaces_created(session_factory, ada) == 1

    async def test_a_version_the_server_has_moved_on_from_is_refused(
        self, session_factory
    ) -> None:
        ada = await _user(session_factory, "user")
        session_app, _ = _apps(session_factory, VERSION)

        async with _client(session_app, ada, None) as client:
            refused = await client.post("/auth/license", json={"version": "2026-01"})

        assert refused.status_code == 409
        assert await _accepted(session_factory, ada) == []

    async def test_a_new_version_is_asked_for_again(self, session_factory) -> None:
        ada = await _user(session_factory, "user")
        session_app, _ = _apps(session_factory, VERSION)
        async with _client(session_app, ada, None) as client:
            await client.post("/auth/license", json={"version": VERSION})

        newer, _ = _apps(session_factory, "2027-01")
        async with _client(newer, ada, None) as client:
            asked = (await client.get("/auth/session")).json()["license_to_accept"]

        assert asked == "2027-01"


class TestSetupAnswers:
    async def test_what_the_creator_says_is_kept_on_the_organization(
        self, session_factory
    ) -> None:
        ada = await _user(session_factory, "user")
        _, organizations_app = _apps(session_factory, None)

        async with _client(organizations_app, ada, None) as client:
            created = await client.post(
                "/organizations",
                json={
                    "name": "Acme",
                    "setup_answers": {
                        "team_size": "11_50",
                        "use_case": "  Agents for our support team  ",
                    },
                },
            )
            unanswered = await client.post(
                "/organizations", json={"name": "Beta", "setup_answers": {}}
            )

        assert created.status_code == 201, created.text
        assert unanswered.status_code == 201, unanswered.text
        async with session_factory() as session:
            acme = await session.get(Organization, created.json()["organization"]["id"])
            beta = await session.get(
                Organization, unanswered.json()["organization"]["id"]
            )
        assert acme is not None and beta is not None
        assert acme.setup_answers == {
            "team_size": "11_50",
            "use_case": "Agents for our support team",
        }
        assert beta.setup_answers is None

    @pytest.mark.parametrize(
        "answers",
        [{"team_size": "a few"}, {"use_case": "x" * 501}],
    )
    async def test_an_answer_out_of_bounds_is_refused(
        self, session_factory, answers: dict[str, str]
    ) -> None:
        ada = await _user(session_factory, "user")
        _, organizations_app = _apps(session_factory, None)

        async with _client(organizations_app, ada, None) as client:
            response = await client.post(
                "/organizations", json={"name": "Acme", "setup_answers": answers}
            )

        assert response.status_code == 422
        assert await _workspaces_created(session_factory, ada) == 0
