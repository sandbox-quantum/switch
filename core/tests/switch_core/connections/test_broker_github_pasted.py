"""A GitHub personal access token pasted in place of the App's sign-in,
through the broker, against Postgres and the real GitHub adapter.

GitHub's side is faked: `token_owner` (GET /user with the token) answers for
the tokens it knows, and the App's sign-in and signer are mocks that must
not be asked anything for a pasted token.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import ConnectionSecret
from switch_core.connections.adapters import github as github_adapter
from switch_core.connections.adapters.github import GitHubAdapter
from switch_core.connections.broker import (
    KEY_CONSENT,
    CheckedKey,
    ServiceBroker,
    ServiceError,
)
from switch_core.connections.loader import CATALOG
from switch_core.db.models import Agent, User
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.providers.github import (
    GitHubAuthorizationError,
    GitHubUnavailableError,
    TokenOwner,
)
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.standing import connection_status, reconnect_reason
from tests.switch_core.connections.test_broker import _issue, _refused, _user
from tests.switch_core.gateway.agent_route_harness import add_agent

STORE = ServiceConnectionStore()
PAT = "github_pat_SYNTHETIC0000000000000000_PLACEHOLDERVALUE"
CLASSIC = "ghp_SYNTHETICNOEXPIRYPLACEHOLDER000000"


class FakeGitHub:
    """`token_owner` for the tokens GitHub knows: whose each is, and whether
    GitHub names an expiration date for it."""

    def __init__(self) -> None:
        self.tokens: dict[str, TokenOwner] = {
            PAT: TokenOwner(1001, "ada-gh", expires=True),
            CLASSIC: TokenOwner(1001, "ada-gh", expires=False),
        }
        self.down = False
        self.calls: list[dict[str, str]] = []

    async def token_owner(self, headers: dict[str, str]) -> TokenOwner:
        self.calls.append(headers)
        if self.down:
            raise GitHubUnavailableError("GitHub is down.")
        token = headers["Authorization"].removeprefix("Bearer ")
        owner = self.tokens.get(token)
        if owner is None:
            raise GitHubAuthorizationError("refused")
        return owner


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeGitHub:
    fake = FakeGitHub()
    monkeypatch.setattr(github_adapter, "token_owner", fake.token_owner)
    return fake


@pytest.fixture
def app() -> tuple[AsyncMock, AsyncMock]:
    return AsyncMock(), AsyncMock()


def _broker(
    session_factory: async_sessionmaker[AsyncSession],
    app: tuple[AsyncMock, AsyncMock] | None,
    *,
    allow_non_expiring_keys: bool,
    read_only: bool = False,
) -> ServiceBroker:
    """`app` is the App's connections and signer; None for a server with no
    App set up."""
    connections, signer = (None, None) if app is None else app
    return ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=CATALOG,
        adapters={
            "github": GitHubAdapter(
                CATALOG["github"].definition, connections, signer, read_only=read_only
            )
        },
        organization_apps=None,
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=None,
        allow_non_expiring_keys=allow_non_expiring_keys,
    )


@pytest.fixture
def broker(session_factory, app) -> ServiceBroker:
    return _broker(session_factory, app, allow_non_expiring_keys=False)


async def _check(broker: ServiceBroker, token: str) -> CheckedKey:
    async with broker._session_factory() as session:
        return await broker.check_paste(session, "github", "token", {"pat": token}, {})


async def _connected(
    broker: ServiceBroker,
    session_factory: async_sessionmaker[AsyncSession],
    token: str = PAT,
) -> tuple[User, Agent]:
    """An owner who pasted `token` for GitHub, and an agent of theirs."""
    checked = await _check(broker, token)
    async with session_factory() as session:
        owner = await _user(session, "ada")
        agent = await add_agent(session, name="planner", owner_id=owner.id)
        await session.commit()
    async with session_factory() as session:
        warning = await broker.connect(
            session,
            user_id=owner.id,
            service="github",
            consent=KEY_CONSENT,
            granted_scopes=[],
            account_id=checked.account_id,
            external_identity=checked.label,
            secret=checked.secret,
            oauth_client_id=None,
            method="token",
            choices=checked.choices,
        )
    assert warning is None
    return owner, agent


async def _grant(
    broker: ServiceBroker,
    session_factory: async_sessionmaker[AsyncSession],
    owner: User,
    agent: Agent,
    **terms,
):
    async with session_factory() as session:
        fresh = await session.get(Agent, agent.id)
        assert fresh is not None
        grant, warning = await broker.set_grant(
            session,
            agent=fresh,
            actor_id=owner.id,
            service="github",
            access=terms.get("access"),
            tool_mode=None,
            tools=None,
            resources=terms.get("resources", {}),
        )
    assert warning is None
    return grant


class TestCheck:
    async def test_a_token_is_named_by_its_github_account(self, broker, fake) -> None:
        checked = await _check(broker, f"  {PAT} ")

        assert (checked.account_id, checked.label, checked.choices) == (
            "1001",
            "ada-gh",
            {},
        )
        # The token itself, which is what git and gh are handed.
        assert checked.secret.values == {"access_token": PAT, "method": "token"}
        assert fake.calls[0] == {"Authorization": f"Bearer {PAT}"}

    async def test_a_token_github_refuses_is_not_taken(self, broker, fake) -> None:
        with pytest.raises(ServiceError) as caught:
            await _check(broker, "github_pat_SYNTHETICUNKNOWN")

        assert (caught.value.status_code, caught.value.code) == (
            422,
            "validation_error",
        )
        assert caught.value.message == (
            "GitHub refused the pasted token, which may be wrong, revoked or expired."
        )

    async def test_a_token_without_an_expiration_date_is_refused(
        self, broker, fake
    ) -> None:
        with pytest.raises(ServiceError) as caught:
            await _check(broker, CLASSIC)

        assert (caught.value.status_code, caught.value.code) == (
            422,
            "validation_error",
        )
        assert caught.value.message == (
            "This GitHub token has no expiration date and only GitHub can revoke "
            "it, so Switch does not hand it to agents. Make one in GitHub with an "
            "expiration date and paste that."
        )

    async def test_a_server_that_allows_non_expiring_keys_takes_one(
        self, session_factory, app, fake
    ) -> None:
        broker = _broker(session_factory, app, allow_non_expiring_keys=True)

        checked = await _check(broker, CLASSIC)

        assert checked.account_id == "1001"

    async def test_github_unreachable_can_be_tried_again(self, broker, fake) -> None:
        fake.down = True

        with pytest.raises(ServiceError) as caught:
            await _check(broker, PAT)

        assert (caught.value.status_code, caught.value.retryable) == (503, True)

    async def test_choices_are_refused(self, broker, fake) -> None:
        async with broker._session_factory() as session:
            with pytest.raises(ServiceError) as caught:
                await broker.check_paste(
                    session, "github", "token", {"pat": PAT}, {"site": "x"}
                )

        assert caught.value.status_code == 422
        assert fake.calls == []


class TestGrant:
    async def test_a_grant_is_on_or_off_and_names_no_repositories(
        self, broker, session_factory, fake, app
    ) -> None:
        owner, agent = await _connected(broker, session_factory)

        grant = await _grant(broker, session_factory, owner, agent)

        assert (grant.access, dict(grant.resources)) == ("write", {})
        connections, _ = app
        connections.installation_repositories.assert_not_called()

    async def test_a_grant_naming_a_level_is_refused(
        self, broker, session_factory, fake
    ) -> None:
        owner, agent = await _connected(broker, session_factory)

        with pytest.raises(ServiceError) as caught:
            await _grant(broker, session_factory, owner, agent, access="read")

        assert caught.value.status_code == 422
        assert "on or off" in caught.value.message

    async def test_a_grant_naming_repositories_is_refused(
        self, broker, session_factory, fake
    ) -> None:
        owner, agent = await _connected(broker, session_factory)

        with pytest.raises(ServiceError) as caught:
            await _grant(
                broker,
                session_factory,
                owner,
                agent,
                resources={"installation_id": 1, "repository_ids": [2]},
            )

        assert caught.value.status_code == 422
        assert "names no repositories" in caught.value.message

    async def test_checking_terms_with_repositories_is_refused(
        self, broker, session_factory, fake
    ) -> None:
        owner, _ = await _connected(broker, session_factory)

        async with session_factory() as session:
            with pytest.raises(ServiceError) as caught:
                await broker.check_grant_terms(
                    session,
                    owner_id=owner.id,
                    service="github",
                    access=None,
                    repositories=["example-org/app"],
                )
            checked = await broker.check_grant_terms(
                session,
                owner_id=owner.id,
                service="github",
                access=None,
                repositories=[],
            )

        assert caught.value.status_code == 422
        assert "leave out repos" in caught.value.message
        assert (checked.access, checked.resources) == (None, {})


class TestIssue:
    async def test_the_token_is_handed_out_as_it_is_for_the_hour(
        self, broker, session_factory, fake, app
    ) -> None:
        owner, agent = await _connected(broker, session_factory)
        await _grant(broker, session_factory, owner, agent)
        fake.calls.clear()

        token = await _issue(broker, session_factory, agent.id)

        assert token.token == PAT
        assert token.expires_at is None
        assert token.resources == {}
        now = datetime.now(UTC)
        assert now + timedelta(minutes=59) < token.use_until <= now + timedelta(hours=1)
        # Checked with GitHub at issue; nothing minted.
        assert len(fake.calls) == 1
        _, signer = app
        signer.mint.assert_not_called()

    async def test_a_token_github_now_refuses_must_be_pasted_again(
        self, broker, session_factory, fake
    ) -> None:
        owner, agent = await _connected(broker, session_factory)
        await _grant(broker, session_factory, owner, agent)
        del fake.tokens[PAT]

        refused = await _refused(broker, session_factory, agent.id)

        assert refused.code == "connector_revoked"
        async with session_factory() as session:
            connection = await STORE.get_connection(session, owner.id, "github")
        assert connection is not None
        assert connection.error_code == "token_refused"
        assert await connection_status(broker, connection) == "needs_reauthorization"

    async def test_a_non_expiring_token_is_not_handed_out_once_disallowed(
        self, session_factory, app, fake
    ) -> None:
        allowing = _broker(session_factory, app, allow_non_expiring_keys=True)
        owner, agent = await _connected(allowing, session_factory, CLASSIC)
        await _grant(allowing, session_factory, owner, agent)
        strict = _broker(session_factory, app, allow_non_expiring_keys=False)

        refused = await _refused(strict, session_factory, agent.id)

        assert (refused.status_code, refused.code) == (409, "connector_revoked")
        assert "no expiration date" in refused.message
        # Its owner is asked for a token that ends, not left with one that
        # shows as working.
        async with session_factory() as session:
            connection = await STORE.get_connection(session, owner.id, "github")
        assert connection is not None
        assert connection.error_code == "token_never_expires"
        assert await connection_status(strict, connection) == "needs_reauthorization"
        code, reason = await reconnect_reason(strict, connection) or ("", "")
        assert code == "token_never_expires"
        assert "Make one in GitHub with an expiration date" in reason

    async def test_a_grant_made_through_the_app_is_refused_on_a_token(
        self, broker, session_factory, fake
    ) -> None:
        owner, agent = await _connected(broker, session_factory)
        async with session_factory() as session:
            await STORE.save_grant(
                session,
                agent_id=agent.id,
                owner_id=owner.id,
                service="github",
                access="write",
                tool_mode="deny",
                tools=[],
                resources={"installation_id": 1, "repository_ids": [2]},
                account_id="1001",
                created_by=owner.id,
            )
            await session.commit()

        refused = await _refused(broker, session_factory, agent.id)

        assert refused.status_code == 403
        assert "Grant GitHub to the agent again" in refused.message


class TestDisconnect:
    async def test_disconnecting_says_only_github_can_revoke_the_token(
        self, broker, session_factory, fake
    ) -> None:
        owner, _ = await _connected(broker, session_factory)

        async with session_factory() as session:
            warning = await broker.disconnect(session, owner.id, "github")

        assert warning is not None
        assert "cannot revoke" in warning
        assert PAT not in warning


class TestWithoutTheApp:
    """A server with no GitHub App set up: a pasted token still connects
    GitHub, and is granted and handed out as it is; signing in is not
    offered."""

    @pytest.fixture
    def broker(self, session_factory) -> ServiceBroker:
        return _broker(session_factory, None, allow_non_expiring_keys=False)

    async def test_github_connects_but_signing_in_waits_on_the_app(
        self, broker
    ) -> None:
        async with broker._session_factory() as session:
            standing = await broker.standing(session, "github")

        assert standing.unavailable is None
        assert standing.connectable is True
        assert standing.sign_in_unavailable is not None
        assert standing.sign_in_unavailable.code == "app_not_set_up"
        assert standing.server_setup_needed is True
        # Organizations fall back on the server's App only where there is one.
        assert broker.server_serves("github") is False

    async def test_a_pasted_token_is_granted_and_handed_out(
        self, broker, session_factory, fake
    ) -> None:
        owner, agent = await _connected(broker, session_factory)
        await _grant(broker, session_factory, owner, agent)

        token = await _issue(broker, session_factory, agent.id)

        assert token.token == PAT
        assert token.resources == {}

    async def test_disconnecting_says_only_github_can_revoke_the_token(
        self, broker, session_factory, fake
    ) -> None:
        owner, _ = await _connected(broker, session_factory)

        async with session_factory() as session:
            warning = await broker.disconnect(session, owner.id, "github")

        assert warning is not None
        assert "cannot revoke" in warning


async def _signed_in(
    broker: ServiceBroker,
    session_factory: async_sessionmaker[AsyncSession],
    owner: User,
) -> str | None:
    """`owner` signs in through the App, as GitHub account 1001."""
    async with session_factory() as session:
        return await broker.connect(
            session,
            user_id=owner.id,
            service="github",
            consent="write",
            granted_scopes=[],
            account_id="1001",
            external_identity="ada-gh",
            secret=ConnectionSecret(
                {
                    "access_token": "test-access-token",
                    "expires_at": (datetime.now(UTC) + timedelta(hours=8)).timestamp(),
                    "refresh_token": "test-refresh-token",
                    "refresh_expires_at": (
                        datetime.now(UTC) + timedelta(days=180)
                    ).timestamp(),
                }
            ),
            oauth_client_id="test-client",
            method="oauth",
            choices={},
        )


async def _pasted(
    broker: ServiceBroker,
    session_factory: async_sessionmaker[AsyncSession],
    owner: User,
) -> str | None:
    """`owner` pastes `PAT` for GitHub, in place of what they had."""
    checked = await _check(broker, PAT)
    async with session_factory() as session:
        return await broker.connect(
            session,
            user_id=owner.id,
            service="github",
            consent=KEY_CONSENT,
            granted_scopes=[],
            account_id=checked.account_id,
            external_identity=checked.label,
            secret=checked.secret,
            oauth_client_id=None,
            method="token",
            choices=checked.choices,
        )


async def _grants(
    session_factory: async_sessionmaker[AsyncSession], agent: Agent
) -> list[str]:
    async with session_factory() as session:
        return [grant.service for grant in await STORE.list_grants(session, agent.id)]


class TestReadOnlyApp:
    """A server whose App lets agents only read: a pasted token does not go
    through the App, so the App's permissions do not bound it."""

    @pytest.fixture
    def broker(self, session_factory, app) -> ServiceBroker:
        return _broker(
            session_factory, app, allow_non_expiring_keys=False, read_only=True
        )

    async def test_a_token_that_writes_is_granted_and_handed_out(
        self, broker, session_factory, fake
    ) -> None:
        owner, agent = await _connected(broker, session_factory)

        grant = await _grant(broker, session_factory, owner, agent)
        token = await _issue(broker, session_factory, agent.id)

        assert grant.access == "write"
        assert token.token == PAT


class TestSwitchingWays:
    """Moving between the App's sign-in and a pasted token for the same
    GitHub account drops the grants, whose shape no longer fits, and names
    the agents to grant GitHub again."""

    async def test_pasting_a_token_drops_the_app_grants(
        self, broker, session_factory, fake
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session, "ada")
            agent = await add_agent(session, name="planner", owner_id=owner.id)
            await session.commit()
        assert await _signed_in(broker, session_factory, owner) is None
        async with session_factory() as session:
            await STORE.save_grant(
                session,
                agent_id=agent.id,
                owner_id=owner.id,
                service="github",
                access="write",
                tool_mode="deny",
                tools=[],
                resources={"installation_id": 1, "repository_ids": [2]},
                account_id="1001",
                created_by=owner.id,
            )
            await session.commit()

        warning = await _pasted(broker, session_factory, owner)

        assert warning is not None
        assert "Grant GitHub again to these agents: planner." in warning
        assert await _grants(session_factory, agent) == []

    async def test_signing_in_drops_the_token_grants(
        self, broker, session_factory, fake
    ) -> None:
        owner, agent = await _connected(broker, session_factory)
        await _grant(broker, session_factory, owner, agent)

        warning = await _signed_in(broker, session_factory, owner)

        assert warning is not None
        assert "Grant GitHub again to these agents: planner." in warning
        assert await _grants(session_factory, agent) == []

    async def test_a_new_token_keeps_the_grants(
        self, broker, session_factory, fake
    ) -> None:
        owner, agent = await _connected(broker, session_factory)
        await _grant(broker, session_factory, owner, agent)

        warning = await _pasted(broker, session_factory, owner)

        assert warning is None or "Grant GitHub again" not in warning
        assert await _grants(session_factory, agent) == ["github"]


class TestAppTakenAway:
    """A server whose App was taken away after someone signed in through it:
    that connection needs connecting again, with a token."""

    async def test_a_sign_in_must_be_connected_again_with_a_token(
        self, session_factory, app, fake
    ) -> None:
        with_app = _broker(session_factory, app, allow_non_expiring_keys=False)
        async with session_factory() as session:
            owner = await _user(session, "ada")
            agent = await add_agent(session, name="planner", owner_id=owner.id)
            await session.commit()
        await _signed_in(with_app, session_factory, owner)
        without = _broker(session_factory, None, allow_non_expiring_keys=False)

        async with session_factory() as session:
            connection = await STORE.get_connection(session, owner.id, "github")
        assert connection is not None
        assert await connection_status(without, connection) == "needs_reauthorization"
        code, reason = await reconnect_reason(without, connection) or ("", "")
        assert code == "sign_in_unavailable"
        assert "personal access token" in reason
        async with session_factory() as session:
            fresh = await session.get(Agent, agent.id)
            assert fresh is not None
            with pytest.raises(ServiceError) as caught:
                await without.set_grant(
                    session,
                    agent=fresh,
                    actor_id=owner.id,
                    service="github",
                    access=None,
                    tool_mode=None,
                    tools=None,
                    resources={},
                )
        assert (caught.value.status_code, caught.value.code) == (
            409,
            "connector_revoked",
        )

    async def test_a_grant_made_through_it_is_refused_with_why(
        self, session_factory, app, fake
    ) -> None:
        with_app = _broker(session_factory, app, allow_non_expiring_keys=False)
        async with session_factory() as session:
            owner = await _user(session, "ada")
            agent = await add_agent(session, name="planner", owner_id=owner.id)
            await session.commit()
        await _signed_in(with_app, session_factory, owner)
        async with session_factory() as session:
            await STORE.save_grant(
                session,
                agent_id=agent.id,
                owner_id=owner.id,
                service="github",
                access="write",
                tool_mode="deny",
                tools=[],
                resources={"installation_id": 1, "repository_ids": [2]},
                account_id="1001",
                created_by=owner.id,
            )
            await session.commit()
        without = _broker(session_factory, None, allow_non_expiring_keys=False)

        refused = await _refused(without, session_factory, agent.id)

        assert refused.code == "connector_revoked"
        assert "no longer set up on this server" in refused.message
