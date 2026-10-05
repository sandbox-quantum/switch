"""The install callback's confirmation page, through the public routes.

The service tests cover what Connect and Cancel do; these cover what the
approver's browser sees and sends: a page that names the organisation, carries
the ticket, cannot be framed, and a form post that finishes the install.
"""

from __future__ import annotations

import html
import re

import httpx
import pytest
from fastapi import FastAPI

from switch_core.bridges.collaboration.install import MessagingInstallError
from switch_core.bridges.collaboration.install_routes import (
    create_messaging_install_router,
)
from tests.conftest import RLSHarness

from .test_install_service import _ORIGIN, _begin, _fixture

pytestmark = pytest.mark.no_ambient_tenant


def _client(service: object) -> httpx.AsyncClient:
    app = FastAPI()
    app.include_router(create_messaging_install_router(service))  # type: ignore[arg-type]
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=_ORIGIN)


def _ticket(page: str) -> str:
    match = re.search(r'name="ticket" value="([^"]+)"', page)
    assert match is not None, page
    return html.unescape(match.group(1))


async def test_the_callback_renders_a_confirmation_and_connects_nothing(
    rls_harness: RLSHarness,
) -> None:
    fixture = await _fixture(rls_harness)
    state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

    async with _client(fixture.service) as client:
        response = await client.get(
            "/messaging/slack/oauth/callback",
            params={"code": "the-code", "state": state},
        )

    assert response.status_code == 200
    assert fixture.tenant_a in response.text
    assert "Acme" in response.text
    assert 'action="/messaging/slack/oauth/confirm"' in response.text
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"
    assert fixture.lifecycle.registered == []


async def test_connect_on_the_page_finishes_the_install(
    rls_harness: RLSHarness,
) -> None:
    fixture = await _fixture(rls_harness)
    state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

    async with _client(fixture.service) as client:
        page = await client.get(
            "/messaging/slack/oauth/callback",
            params={"code": "the-code", "state": state},
        )
        ticket = _ticket(page.text)
        connected = await client.post(
            "/messaging/slack/oauth/confirm",
            data={"ticket": ticket, "decision": "connect"},
        )
        again = await client.post(
            "/messaging/slack/oauth/confirm",
            data={"ticket": ticket, "decision": "connect"},
        )

    assert connected.status_code == 200
    assert "Switch is connected" in connected.text
    assert again.status_code == 400
    assert len(fixture.lifecycle.registered) == 1


async def test_cancel_on_the_page_connects_nothing(rls_harness: RLSHarness) -> None:
    fixture = await _fixture(rls_harness)
    state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

    async with _client(fixture.service) as client:
        page = await client.get(
            "/messaging/slack/oauth/callback",
            params={"code": "the-code", "state": state},
        )
        cancelled = await client.post(
            "/messaging/slack/oauth/confirm",
            data={"ticket": _ticket(page.text), "decision": "cancel"},
        )

    assert cancelled.status_code == 200
    assert "Install cancelled" in cancelled.text
    assert fixture.lifecycle.registered == []
    assert fixture.installer.revoked_tokens == ["xoxb-granted"]


async def test_a_cancel_that_could_not_revoke_says_so_and_can_be_retried(
    rls_harness: RLSHarness,
) -> None:
    fixture = await _fixture(rls_harness)
    state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
    fixture.installer.revoke_error = MessagingInstallError("Slack is down")

    async with _client(fixture.service) as client:
        page = await client.get(
            "/messaging/slack/oauth/callback",
            params={"code": "the-code", "state": state},
        )
        ticket = _ticket(page.text)
        failed = await client.post(
            "/messaging/slack/oauth/confirm",
            data={"ticket": ticket, "decision": "cancel"},
        )
        fixture.installer.revoke_error = None
        retried = await client.post(
            "/messaging/slack/oauth/confirm",
            data={"ticket": ticket, "decision": "cancel"},
        )

    assert failed.status_code == 502
    assert "Cancel did not finish" in failed.text
    assert retried.status_code == 200
    assert "Install cancelled" in retried.text
    assert fixture.installer.revoked_tokens == ["xoxb-granted"]


async def test_a_forged_ticket_is_refused(rls_harness: RLSHarness) -> None:
    fixture = await _fixture(rls_harness)

    async with _client(fixture.service) as client:
        response = await client.post(
            "/messaging/slack/oauth/confirm",
            data={"ticket": "not-a-ticket", "decision": "connect"},
        )

    assert response.status_code == 400
    assert fixture.lifecycle.registered == []
